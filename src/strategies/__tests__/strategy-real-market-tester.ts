/**
 * Generic Real-Market Strategy Tester (mock execution)
 *
 * - Fetches live Polymarket prices for a YES/NO market
 * - Runs any configured strategy (balanced, altlab, dipscale, time-based, ...)
 * - Records mock trades instead of sending real orders
 * - Logs per-cycle decisions and PnL to console and log file
 */

import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

import { loadConfig } from "../../config";
import { createLogger } from "../../utils/logger";
import {
  getMarketBySlug,
  getMarketByToken,
  getTokenPrice,
  findTokenIdsForMarket,
  MarketInfo,
  TokenPrice,
  Position,
} from "../../utils/marketData";
import {
  generateMarketSlug,
  MarketSlugPattern,
} from "../../utils/marketSlugGenerator";
import {
  getStrategy,
  TradingStrategy,
  StrategyContext,
  TradingDecision,
} from "..";

interface MockTrade {
  cycle: number;
  timestamp: Date;
  action: TradingDecision["action"];
  tokenId: string;
  price: number;
  size: number;
  cost: number;
  reason: string;
}

interface TestResult {
  startTime: Date;
  endTime: Date;
  totalCycles: number;
  totalTrades: number;
  totalUsdSpent: number;
  currentValue: number;
  pnl: number;
  pnlPercent: number;
  positions: {
    yesSize: number;
    noSize: number;
    yesUsd: number;
    noUsd: number;
  };
  trades: MockTrade[];
  marketInfo: MarketInfo | null;
  summary: string;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const raw = process.env[key];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : defaultValue;
}

export class RealMarketStrategyTester {
  private config = loadConfig();
  private logger = createLogger(
    this.config.logLevel,
    process.env.TEST_LOG_FILE || "logs/test-strategy.log"
  );

  private strategyName: string;
  private strategy: TradingStrategy;
  private clobClient: ClobClient | null = null;

  private marketInfo: MarketInfo | null = null;
  private yesTokenId: string | null = null;
  private noTokenId: string | null = null;

  private positions: Position[] = [];
  private trades: MockTrade[] = [];
  private realizedPnl = 0;
  private cycle = 0;

  constructor() {
    const envStrategy =
      process.env.TEST_STRATEGY || this.config.tradingStrategy || "altlab";
    const strat = getStrategy(envStrategy);
    if (!strat) {
      throw new Error(
        `Unknown strategy "${envStrategy}". Available: ${[
          "balanced",
          "altlab",
          "dipscale",
          "timebased",
        ].join(", ")}`
      );
    }
    this.strategyName = envStrategy;
    this.strategy = strat;
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing real-market tester", {
      strategy: this.strategyName,
    });

    // Reset strategy state for new pool/market (strategies are singletons)
    this.strategy.reset();

    // Dummy wallet for read-only ClobClient
    const dummyWallet = new ethers.Wallet(
      ethers.Wallet.createRandom().privateKey
    );
    this.clobClient = new ClobClient(
      this.config.clobApiUrl,
      this.config.polygonChainId,
      dummyWallet
    );

    await this.loadMarket();

    this.logger.info("Tester initialized", {
      marketQuestion: this.marketInfo?.question,
      yesTokenId: this.yesTokenId,
      noTokenId: this.noTokenId,
    });
  }

  private async loadMarket(): Promise<void> {
    let market: MarketInfo | null = null;

    if (this.config.marketSlugPattern) {
      const timePattern =
        this.config.marketSlugPattern.timePattern === "static"
          ? "hourly"
          : this.config.marketSlugPattern.timePattern;
      const pattern: MarketSlugPattern = {
        baseSlug: this.config.marketSlugPattern.baseSlug,
        timePattern: timePattern as "hourly" | "daily" | "15min" | "custom",
      };
      
      // Try current interval, then next intervals if market doesn't exist yet
      // For 15min markets: try current, +15min, +30min
      // For hourly: try current, +1hr, +2hr
      const maxRetries = 3;
      const intervalMinutes = timePattern === "15min" ? 15 : timePattern === "hourly" ? 60 : 1440;
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const offsetMinutes = attempt * intervalMinutes;
        const targetDate = new Date(Date.now() + offsetMinutes * 60 * 1000);
        const slug = generateMarketSlug(pattern, targetDate, this.logger);
        
        this.logger.info("Fetching market by slug", { 
          slug, 
          attempt: attempt + 1, 
          maxRetries,
          offsetMinutes 
        });
        market = await getMarketBySlug(slug, this.logger);
        
        if (market) {
          this.logger.info("Market found", { slug, attempt: attempt + 1 });
          break;
        }
        
        this.logger.warn("Market not found by slug", { slug, attempt: attempt + 1 });
        
        if (attempt < maxRetries - 1) {
          // Wait a bit before trying next interval
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } else if (this.config.targetMarketSlug) {
      this.logger.info("Fetching market by slug", {
        slug: this.config.targetMarketSlug,
      });
      market = await getMarketBySlug(this.config.targetMarketSlug, this.logger);
    } else if (this.config.targetTokenId) {
      this.logger.info("Fetching market by token ID", {
        tokenId: this.config.targetTokenId,
      });
      market = await getMarketByToken(this.config.targetTokenId, this.logger);
    }

    if (!market) {
      throw new Error("Failed to load market information - market not found after retries");
    }

    const { yesTokenId, noTokenId } = findTokenIdsForMarket(market, "YES");
    if (!yesTokenId || !noTokenId) {
      throw new Error("Could not resolve YES/NO token IDs for market");
    }

    this.marketInfo = market;
    this.yesTokenId = yesTokenId;
    this.noTokenId = noTokenId;
  }

  private computeTimeUntilEnd(): number | undefined {
    if (!this.config.marketSlugPattern) return undefined;

    const now = Date.now();
    const pattern = this.config.marketSlugPattern.timePattern;

    if (pattern === "15min") {
      const intervalMs = 15 * 60 * 1000;
      const start = Math.floor(now / intervalMs) * intervalMs;
      return start + intervalMs - now;
    }
    if (pattern === "hourly") {
      const intervalMs = 60 * 60 * 1000;
      const start = Math.floor(now / intervalMs) * intervalMs;
      return start + intervalMs - now;
    }
    return undefined;
  }

  private async fetchPrices(): Promise<{
    yesPrice: TokenPrice | null;
    noPrice: TokenPrice | null;
  }> {
    if (!this.clobClient || !this.yesTokenId || !this.noTokenId) {
      throw new Error("Tester not initialized");
    }

    const [yesPrice, noPrice] = await Promise.all([
      getTokenPrice(this.clobClient, this.yesTokenId, this.logger),
      getTokenPrice(this.clobClient, this.noTokenId, this.logger),
    ]);
    return { yesPrice, noPrice };
  }

  private buildContext(
    yesPrice: TokenPrice,
    noPrice: TokenPrice,
    timeUntilEnd?: number
  ): StrategyContext {
    return {
      tokenPrice: yesPrice,
      yesTokenPrice: yesPrice,
      noTokenPrice: noPrice,
      positions: this.positions,
      timeUntilEnd,
      config: {
        orderSize: this.config.orderSize,
        minPrice: this.config.minPrice,
        maxPrice: this.config.maxPrice,
        maxPositionSize: this.config.maxPositionSize,
        stopLossPercentage: this.config.stopLossPercentage,
        takeProfitPercentage: this.config.takeProfitPercentage,
      },
    };
  }

  private applyDecision(
    decision: TradingDecision,
    yesPrice: TokenPrice,
    noPrice: TokenPrice
  ): void {
    if (!this.yesTokenId || !this.noTokenId) return;

    if (decision.action === "HOLD") {
      this.logger.info(`[Cycle ${this.cycle}] HOLD`, {
        reason: decision.reason,
      });
      return;
    }

    const isBuy =
      decision.action === "BUY_YES" || decision.action === "BUY_NO";
    const isSell = decision.action === "SELL";

    const tokenId = decision.tokenId;
    const price = decision.price;
    const size = decision.size;
    const cost = price * size;

    // Find or create position
    let position = this.positions.find((p) => p.asset === tokenId);
    if (!position) {
      const side: "YES" | "NO" =
        tokenId === this.yesTokenId ? "YES" : "NO";
      position = { asset: tokenId, size: 0, side };
      this.positions.push(position);
    }

    if (isBuy) {
      position.size += size;
    } else if (isSell) {
      const sellSize = Math.min(position.size, size);
      // Simple realized PnL assuming average entry is price (approx for mock)
      // For richer PnL tracking we'd store per-trade history; here we keep it simple.
      this.realizedPnl += 0; // keep 0 realized for now to focus on exposure
      position.size -= sellSize;
    }

    this.trades.push({
      cycle: this.cycle,
      timestamp: new Date(),
      action: decision.action,
      tokenId,
      price,
      size,
      cost,
      reason: decision.reason,
    });

    const pnl = this.calculatePnl(yesPrice, noPrice);
    const side = tokenId === this.yesTokenId ? "YES" : "NO";

    this.logger.info(
      `[Cycle ${this.cycle}] 📈 ${decision.action} ${side} @ $${price.toFixed(4)} | Size: ${size.toFixed(2)} | Cost: $${cost.toFixed(2)} | Total Spent: $${pnl.totalUsdSpent.toFixed(2)}`,
      {
        action: decision.action,
        side,
        price: price.toFixed(4),
        size: size.toFixed(2),
        cost: cost.toFixed(2),
        totalUsdSpent: pnl.totalUsdSpent.toFixed(2),
        reason: decision.reason,
      }
    );
  }

  private calculatePnl(yesPrice: TokenPrice, noPrice: TokenPrice): {
    yesSize: number;
    noSize: number;
    yesUsd: number;
    noUsd: number;
    totalUsdSpent: number;
    currentValue: number;
    pnl: number;
    pnlPercent: number;
  } {
    const yesPos = this.positions.find((p) => p.asset === this.yesTokenId);
    const noPos = this.positions.find((p) => p.asset === this.noTokenId);

    const yesSize = yesPos?.size || 0;
    const noSize = noPos?.size || 0;

    // Calculate total USD spent (cost basis) from all trades
    let totalUsdSpent = 0;
    for (const trade of this.trades) {
      if (trade.action === "BUY_YES" || trade.action === "BUY_NO") {
        totalUsdSpent += trade.cost;
      }
    }

    // Current market value (using bid prices for conservative estimate)
    const yesCurrentValue = yesSize * yesPrice.bidPrice;
    const noCurrentValue = noSize * noPrice.bidPrice;
    const currentValue = yesCurrentValue + noCurrentValue;

    // PnL calculation
    const pnl = currentValue - totalUsdSpent;
    const pnlPercent = totalUsdSpent > 0 ? (pnl / totalUsdSpent) * 100 : 0;

    // USD exposure (using ask prices for what it would cost to buy)
    const yesUsd = yesSize * yesPrice.askPrice;
    const noUsd = noSize * noPrice.askPrice;

    return {
      yesSize,
      noSize,
      yesUsd,
      noUsd,
      totalUsdSpent,
      currentValue,
      pnl,
      pnlPercent,
    };
  }

  async executeCycle(): Promise<void> {
    this.cycle += 1;

    const { yesPrice, noPrice } = await this.fetchPrices();
    if (!yesPrice || !noPrice) {
      this.logger.warn(`[Cycle ${this.cycle}] Missing prices, skipping`);
      return;
    }

    const timeUntilEnd = this.computeTimeUntilEnd();
    const ctx = this.buildContext(yesPrice, noPrice, timeUntilEnd);
    const decision = this.strategy.execute(ctx);
    const decisions = Array.isArray(decision)
      ? decision
      : decision
      ? [decision]
      : [];

    this.logger.info(`[Cycle ${this.cycle}] Market snapshot`, {
      yesAsk: yesPrice.askPrice,
      noAsk: noPrice.askPrice,
      totalCost: yesPrice.askPrice + noPrice.askPrice,
      timeUntilEndMs: timeUntilEnd,
      decisions: decisions.length,
    });

    for (const d of decisions) {
      if (!d) continue;
      this.applyDecision(d, yesPrice, noPrice);
    }

    const pnl = this.calculatePnl(yesPrice, noPrice);
    
    // Clear, simple PnL display
    this.logger.info(
      `[Cycle ${this.cycle}] 💰 PnL: ${pnl.pnl >= 0 ? "+" : ""}$${pnl.pnl.toFixed(2)} (${pnl.pnlPercent >= 0 ? "+" : ""}${pnl.pnlPercent.toFixed(2)}%) | Spent: $${pnl.totalUsdSpent.toFixed(2)} | Value: $${pnl.currentValue.toFixed(2)}`,
      {
        totalUsdSpent: pnl.totalUsdSpent.toFixed(2),
        currentValue: pnl.currentValue.toFixed(2),
        pnl: pnl.pnl.toFixed(2),
        pnlPercent: pnl.pnlPercent.toFixed(2),
        yesSize: pnl.yesSize.toFixed(2),
        noSize: pnl.noSize.toFixed(2),
        yesUsd: pnl.yesUsd.toFixed(2),
        noUsd: pnl.noUsd.toFixed(2),
      }
    );
  }

  async runTest(
    numCycles: number = 20,
    intervalMs: number = 5000
  ): Promise<TestResult> {
    const startTime = new Date();

    this.logger.info("Starting strategy test run", {
      cycles: numCycles,
      intervalMs,
      strategy: this.strategyName,
    });

    this.positions = [];
    this.trades = [];
    this.realizedPnl = 0;
    this.cycle = 0;

    for (let i = 0; i < numCycles; i++) {
      await this.executeCycle();
      if (i < numCycles - 1) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }

    const endTime = new Date();

    // Compute final PnL on last known prices (best effort)
    let yesPrice: TokenPrice | null = null;
    let noPrice: TokenPrice | null = null;
    try {
      const prices = await this.fetchPrices();
      yesPrice = prices.yesPrice;
      noPrice = prices.noPrice;
    } catch {
      // ignore
    }

    let yesSize = 0;
    let noSize = 0;
    let yesUsd = 0;
    let noUsd = 0;
    let totalUsdSpent = 0;
    let currentValue = 0;
    let pnl = 0;
    let pnlPercent = 0;

    if (yesPrice && noPrice) {
      const pnlData = this.calculatePnl(yesPrice, noPrice);
      yesSize = pnlData.yesSize;
      noSize = pnlData.noSize;
      yesUsd = pnlData.yesUsd;
      noUsd = pnlData.noUsd;
      totalUsdSpent = pnlData.totalUsdSpent;
      currentValue = pnlData.currentValue;
      pnl = pnlData.pnl;
      pnlPercent = pnlData.pnlPercent;
    }

    const result: TestResult = {
      startTime,
      endTime,
      totalCycles: numCycles,
      totalTrades: this.trades.length,
      totalUsdSpent,
      currentValue,
      pnl,
      pnlPercent,
      positions: {
        yesSize,
        noSize,
        yesUsd,
        noUsd,
      },
      trades: this.trades,
      marketInfo: this.marketInfo,
      summary: this.buildSummary(
        startTime,
        endTime,
        totalUsdSpent,
        currentValue,
        pnl,
        pnlPercent
      ),
    };

    this.writeTradeHistory(result);
    this.writeSummaryHistory(result);
    return result;
  }

  async runUntilEnd(
    intervalMs: number = 1000,
    maxDurationMs: number = Number.MAX_SAFE_INTEGER
  ): Promise<TestResult> {
    const startTime = new Date();
    const start = Date.now();

    this.positions = [];
    this.trades = [];
    this.realizedPnl = 0;
    this.cycle = 0;

    this.logger.info("Starting real-time run until end", {
      intervalMs,
      maxDurationMs,
      strategy: this.strategyName,
    });

    let lastTimeUntilEnd: number | undefined;

    while (true) {
      await this.executeCycle();

      const elapsed = Date.now() - start;
      const timeUntilEnd = this.computeTimeUntilEnd();

      // Detect pool rollover: timeUntilEnd jumps from near-zero back to a large value
      if (
        lastTimeUntilEnd !== undefined &&
        timeUntilEnd !== undefined &&
        lastTimeUntilEnd < 5 * 60 * 1000 && // we were in the last 5 minutes
        timeUntilEnd > lastTimeUntilEnd + 60 * 1000 // and suddenly jumped by > 1 minute
      ) {
        this.logger.info("Detected new pool interval, ending current pool run", {
          lastTimeUntilEndMs: lastTimeUntilEnd,
          newTimeUntilEndMs: timeUntilEnd,
        });
        break;
      }

      lastTimeUntilEnd = timeUntilEnd;

      if (elapsed >= maxDurationMs || (timeUntilEnd !== undefined && timeUntilEnd <= 0)) {
        break;
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    const endTime = new Date();

    // Final prices
    let yesPrice: TokenPrice | null = null;
    let noPrice: TokenPrice | null = null;
    try {
      const prices = await this.fetchPrices();
      yesPrice = prices.yesPrice;
      noPrice = prices.noPrice;
    } catch {
      // ignore
    }

    let yesSize = 0;
    let noSize = 0;
    let yesUsd = 0;
    let noUsd = 0;
    let totalUsdSpent = 0;
    let currentValue = 0;
    let pnl = 0;
    let pnlPercent = 0;

    if (yesPrice && noPrice) {
      const pnlData = this.calculatePnl(yesPrice, noPrice);
      yesSize = pnlData.yesSize;
      noSize = pnlData.noSize;
      yesUsd = pnlData.yesUsd;
      noUsd = pnlData.noUsd;
      totalUsdSpent = pnlData.totalUsdSpent;
      currentValue = pnlData.currentValue;
      pnl = pnlData.pnl;
      pnlPercent = pnlData.pnlPercent;
    }

    const result: TestResult = {
      startTime,
      endTime,
      totalCycles: this.cycle,
      totalTrades: this.trades.length,
      totalUsdSpent,
      currentValue,
      pnl,
      pnlPercent,
      positions: {
        yesSize,
        noSize,
        yesUsd,
        noUsd,
      },
      trades: this.trades,
      marketInfo: this.marketInfo,
      summary: this.buildSummary(
        startTime,
        endTime,
        totalUsdSpent,
        currentValue,
        pnl,
        pnlPercent
      ),
    };

    this.writeTradeHistory(result);
    this.writeSummaryHistory(result);
    return result;
  }

  private buildSummary(
    start: Date,
    end: Date,
    totalUsdSpent: number,
    currentValue: number,
    pnl: number,
    pnlPercent: number
  ): string {
    const durationSec = ((end.getTime() - start.getTime()) / 1000).toFixed(1);
    const pnlSign = pnl >= 0 ? "+" : "";
    const pnlPercentSign = pnlPercent >= 0 ? "+" : "";
    
    return `
╔═══════════════════════════════════════════════════════════╗
║  Real-Market Strategy Test Results (${this.strategyName})        ║
╠═══════════════════════════════════════════════════════════╣
║  Market: ${this.marketInfo?.question || "N/A"}
║  Duration: ${durationSec}s
║  Total Cycles: ${this.cycle}
║  Total Trades: ${this.trades.length}
╠═══════════════════════════════════════════════════════════╣
║  💵 TOTAL USD SPENT:     $${totalUsdSpent.toFixed(2)}
║  💰 CURRENT VALUE:       $${currentValue.toFixed(2)}
║  📊 PnL:                 ${pnlSign}$${pnl.toFixed(2)} (${pnlPercentSign}${pnlPercent.toFixed(2)}%)
╠═══════════════════════════════════════════════════════════╣
║  Log file: ${process.env.TEST_LOG_FILE || "logs/test-strategy.log"}
╚═══════════════════════════════════════════════════════════╝
`;
  }

  printReport(result: TestResult): void {
    console.log(result.summary);
    
    if (result.trades.length > 0) {
      console.log("\n📋 Recent Trades (last 10):");
      const recent = result.trades.slice(-10);
      recent.forEach((t, idx) => {
        const side = t.tokenId === this.yesTokenId ? "YES" : "NO";
        console.log(
          `  ${idx + 1}. [Cycle ${t.cycle}] ${t.action} ${side} @ $${t.price.toFixed(4)} | Size: ${t.size.toFixed(2)} | Cost: $${t.cost.toFixed(2)}`
        );
      });
      
      if (result.trades.length > 10) {
        console.log(`\n  ... and ${result.trades.length - 10} more trades`);
      }
    }
  }

  /**
   * Persist a simple CSV trade history for easier inspection.
   * Columns: time, cycle, action, side, price, size, cost, cum_side_qty, avg_side_price, total_spent
   */
  private writeTradeHistory(result: TestResult): void {
    // Use strategy-specific file name so different strategies don't mix histories
    const defaultFile = `logs/test-orders-history-${this.strategyName}.csv`;
    const ordersFile = process.env.TEST_ORDERS_FILE || defaultFile;
    const dir = path.dirname(ordersFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!this.yesTokenId || !this.noTokenId) {
      return;
    }

    let yesQty = 0;
    let yesCost = 0;
    let noQty = 0;
    let noCost = 0;
    let totalSpent = 0;

    const header =
      "timestamp,cycle,action,side,price,size,cost,cum_side_qty,avg_side_price,total_spent\n";

    const lines = result.trades.map((t) => {
      const side = t.tokenId === this.yesTokenId ? "YES" : "NO";
      const isBuy = t.action === "BUY_YES" || t.action === "BUY_NO";

      if (side === "YES") {
        if (isBuy) {
          yesQty += t.size;
          yesCost += t.cost;
          totalSpent += t.cost;
        } else {
          yesQty = Math.max(0, yesQty - t.size);
        }
      } else {
        if (isBuy) {
          noQty += t.size;
          noCost += t.cost;
          totalSpent += t.cost;
        } else {
          noQty = Math.max(0, noQty - t.size);
        }
      }

      const sideQty = side === "YES" ? yesQty : noQty;
      const sideCost = side === "YES" ? yesCost : noCost;
      const avgSidePrice = sideQty > 0 ? sideCost / sideQty : 0;

      return [
        t.timestamp.toISOString(),
        t.cycle,
        t.action,
        side,
        t.price.toFixed(4),
        t.size.toFixed(4),
        t.cost.toFixed(4),
        sideQty.toFixed(4),
        avgSidePrice.toFixed(4),
        totalSpent.toFixed(4),
      ].join(",");
    });

    const body = lines.join("\n");

    if (!fs.existsSync(ordersFile)) {
      fs.writeFileSync(ordersFile, header + body + "\n", "utf8");
    } else {
      fs.appendFileSync(ordersFile, body + "\n", "utf8");
    }

    this.logger.info("Test order history written", {
      file: ordersFile,
      trades: result.trades.length,
    });
  }

  /**
   * Persist a compact per-run (or per-pool) summary row, so you can
   * quickly compare overall PnL across runs.
   *
   * Columns:
   * run_start,run_end,strategy,market,total_cycles,total_trades,
   * total_spent,current_value,pnl,pnl_percent
   * 
   * Writes to strategy-specific file: logs/test-summary-history-{strategy}.csv
   */
  private writeSummaryHistory(result: TestResult): void {
    // Use strategy-specific file name
    const defaultFile = `logs/test-summary-history-${this.strategyName}.csv`;
    const summaryFile =
      process.env.TEST_SUMMARY_FILE || defaultFile;
    const dir = path.dirname(summaryFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const header =
      "run_start,run_end,strategy,market,total_cycles,total_trades,total_spent,current_value,pnl,pnl_percent\n";

    const market =
      result.marketInfo?.question?.replace(/,/g, " ") || "N/A";

    const line = [
      result.startTime.toISOString(),
      result.endTime.toISOString(),
      this.strategyName,
      `"${market}"`,
      result.totalCycles,
      result.totalTrades,
      result.totalUsdSpent.toFixed(4),
      result.currentValue.toFixed(4),
      result.pnl.toFixed(4),
      result.pnlPercent.toFixed(4),
    ].join(",");

    if (!fs.existsSync(summaryFile)) {
      fs.writeFileSync(summaryFile, header + line + "\n", "utf8");
    } else {
      fs.appendFileSync(summaryFile, line + "\n", "utf8");
    }

    this.logger.info("Test summary appended", {
      file: summaryFile,
      pnl: result.pnl.toFixed(4),
      pnlPercent: result.pnlPercent.toFixed(4),
    });
  }
}

if (require.main === module) {
  (async () => {
    try {
      const cycles = getEnvNumber("TEST_CYCLES", 20);
      const interval = getEnvNumber("TEST_CYCLE_INTERVAL_MS", 5000);
      const realtime = process.env.TEST_REALTIME === "true";
      const continuous = process.env.TEST_CONTINUOUS_POOLS === "true";
      const maxPools = getEnvNumber(
        "TEST_MAX_POOLS",
        Number.MAX_SAFE_INTEGER
      );
      let virtualBankroll = Number(process.env.TEST_START_BANKROLL || "100");

      if (continuous && realtime) {
        let pool = 1;
        // Run over successive pools until maxPools reached or process killed
        while (pool <= maxPools) {
          const tester = new RealMarketStrategyTester();
          await tester.initialize();

          const result = await tester.runUntilEnd(
            interval,
            getEnvNumber("TEST_MAX_DURATION_MS", Number.MAX_SAFE_INTEGER)
          );

          virtualBankroll += result.pnl;

          console.log(
            `\n=== Pool ${pool} complete | PnL: ${result.pnl.toFixed(
              2
            )} (${result.pnlPercent.toFixed(
              2
            )}%) | Virtual bankroll: $${virtualBankroll.toFixed(2)} ===\n`
          );

          pool += 1;
        }
      } else {
        const tester = new RealMarketStrategyTester();
        await tester.initialize();

        const result = realtime
          ? await tester.runUntilEnd(
              interval,
              getEnvNumber("TEST_MAX_DURATION_MS", Number.MAX_SAFE_INTEGER)
            )
          : await tester.runTest(cycles, interval);

        tester.printReport(result);
      }
    } catch (err) {
      console.error("Strategy test failed", err);
      process.exit(1);
    }
  })();
}


