/**
 * Nuoiem Strategy Tester
 *
 * Tests the nuoiem strategy with:
 * - Real market data from Polymarket
 * - Mock orders (no real trades)
 * - Realistic order failures (invalid price, rejections, etc.)
 * - Detailed logging of orders and PnL
 * - Budget tracking and ratio monitoring
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

interface PendingOrder {
  orderId: string;
  tokenId: string;
  price: number;
  size: number;
  submittedAt: number;
  action: TradingDecision["action"];
  reason: string;
  fillProbability: number;
  slippageRange: number;
  failureReason?: string; // Why order might fail
  retryCount?: number; // Number of retries for this order
}

interface FilledOrder {
  orderId: string;
  tokenId: string;
  filledPrice: number;
  filledSize: number;
  filledAt: number;
  originalPrice: number;
  originalSize: number;
}

interface FailedOrder {
  orderId: string;
  tokenId: string;
  price: number;
  size: number;
  failedAt: number;
  reason: string;
  action: TradingDecision["action"];
  retryCount?: number;
  originalReason?: string; // Original decision reason
}

interface MockTrade {
  cycle: number;
  timestamp: Date;
  action: TradingDecision["action"];
  tokenId: string;
  price: number;
  size: number;
  cost: number;
  reason: string;
  orderId: string;
  filledPrice?: number;
  filledSize?: number;
  status: "FILLED" | "FAILED" | "PENDING";
  failureReason?: string;
}

interface TestResult {
  startTime: Date;
  endTime: Date;
  totalCycles: number;
  totalOrdersSubmitted: number;
  totalOrdersFilled: number;
  totalOrdersFailed: number;
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
  failedOrders: FailedOrder[];
  marketInfo: MarketInfo | null;
  summary: string;
  budgetUsed: number;
  budgetLimit: number;
  budgetRemaining: number;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const raw = process.env[key];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : defaultValue;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  return raw.toLowerCase() === "true" || raw === "1";
}

export class NuoiemStrategyTester {
  private config = loadConfig();
  private logger = createLogger(
    this.config.logLevel,
    process.env.TEST_LOG_FILE || "logs/test-nuoiem-strategy.log"
  );

  private strategy: TradingStrategy;
  private clobClient: ClobClient | null = null;

  private marketInfo: MarketInfo | null = null;
  private yesTokenId: string | null = null;
  private noTokenId: string | null = null;
  private strategyName = "nuoiem";

  getMarketInfo(): MarketInfo | null {
    return this.marketInfo;
  }

  // Simulation state
  private positions: Position[] = [];
  private pendingOrders: Map<string, PendingOrder> = new Map();
  private filledOrders: FilledOrder[] = [];
  private failedOrders: FailedOrder[] = [];
  private retryableFailedOrders: FailedOrder[] = []; // Failed orders that can be retried
  private trades: MockTrade[] = [];
  private cycle = 0;
  private orderIdCounter = 0;

  // Configuration
  private readonly ORDER_FILL_DELAY_MS = getEnvNumber("TEST_ORDER_FILL_DELAY_MS", 1000);
  private readonly ORDER_FILL_PROBABILITY = getEnvNumber("TEST_ORDER_FILL_PROBABILITY", 0.80); // 80% fill rate
  private readonly ORDER_FAILURE_PROBABILITY = getEnvNumber("TEST_ORDER_FAILURE_PROBABILITY", 0.15); // 15% failure rate
  private readonly MAX_SLIPPAGE = getEnvNumber("TEST_MAX_SLIPPAGE", 0.01);
  private readonly POSITION_API_DELAY_MS = getEnvNumber("TEST_POSITION_API_DELAY_MS", 3000);
  private readonly ENABLE_SLIPPAGE = getEnvBoolean("TEST_ENABLE_SLIPPAGE", true);
  private readonly INVALID_PRICE_PROBABILITY = getEnvNumber("TEST_INVALID_PRICE_PROBABILITY", 0.05); // 5% invalid price
  private readonly REJECTION_PROBABILITY = getEnvNumber("TEST_REJECTION_PROBABILITY", 0.10); // 10% rejection
  private readonly MAX_RETRIES = getEnvNumber("TEST_MAX_RETRIES", 3); // Max retries for failed orders
  private readonly RETRY_DELAY_MS = getEnvNumber("TEST_RETRY_DELAY_MS", 2000); // Delay before retry

  constructor() {
    const strat = getStrategy("nuoiem");
    if (!strat) {
      throw new Error("Nuoiem strategy not found");
    }
    this.strategy = strat;
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing Nuoiem Strategy Tester", {
      orderFillDelay: this.ORDER_FILL_DELAY_MS,
      orderFillProbability: this.ORDER_FILL_PROBABILITY,
      orderFailureProbability: this.ORDER_FAILURE_PROBABILITY,
      maxSlippage: this.MAX_SLIPPAGE,
      positionApiDelay: this.POSITION_API_DELAY_MS,
      invalidPriceProbability: this.INVALID_PRICE_PROBABILITY,
      rejectionProbability: this.REJECTION_PROBABILITY,
      budgetPerPool: this.config.maxBudgetPerPool || 100,
    });

    this.strategy.reset();

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
      budgetLimit: this.config.maxBudgetPerPool || 100,
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

      const now = new Date();
      for (let offset = 0; offset < 3; offset++) {
        const testTime = new Date(now.getTime() + offset * 15 * 60 * 1000);
        const slug = generateMarketSlug(pattern, testTime, this.logger);
        market = await getMarketBySlug(slug, this.logger);
        if (market) break;
      }
    } else if (this.config.targetMarketSlug) {
      market = await getMarketBySlug(this.config.targetMarketSlug, this.logger);
    } else if (this.config.targetTokenId) {
      market = await getMarketByToken(this.config.targetTokenId, this.logger);
    }

    if (!market) {
      throw new Error("Could not find market");
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

  private getPositionsWithApiDelay(): Position[] {
    const now = Date.now();
    const positions: Position[] = [];

    for (const filled of this.filledOrders) {
      if (now - filled.filledAt >= this.POSITION_API_DELAY_MS) {
        let position = positions.find((p) => p.asset === filled.tokenId);
        if (!position) {
          const side: "YES" | "NO" =
            filled.tokenId === this.yesTokenId ? "YES" : "NO";
          position = { asset: filled.tokenId, size: 0, side };
          positions.push(position);
        }
        position.size += filled.filledSize;
      }
    }

    return positions;
  }

  /**
   * Check if order should fail (invalid price, rejection, etc.)
   */
  private checkOrderFailure(
    order: PendingOrder,
    yesPrice: TokenPrice,
    noPrice: TokenPrice
  ): string | null {
    const tokenPrice = order.tokenId === this.yesTokenId ? yesPrice : noPrice;

    // Check for invalid price (price too far from market)
    if (Math.random() < this.INVALID_PRICE_PROBABILITY) {
      const priceDiff = Math.abs(order.price - tokenPrice.askPrice);
      if (priceDiff > 0.05) {
        return `INVALID_PRICE: Order price ${order.price.toFixed(4)} too far from market ${tokenPrice.askPrice.toFixed(4)} (diff: ${(priceDiff * 100).toFixed(2)}¢)`;
      }
    }

    // Check for rejection (random rejection)
    if (Math.random() < this.REJECTION_PROBABILITY) {
      return `ORDER_REJECTED: Market rejected order (simulated)`;
    }

    // Check for insufficient liquidity (simulated based on order size)
    // Large orders relative to typical market depth may fail
    if (order.size > 200) {
      if (Math.random() < 0.2) {
        return `INSUFFICIENT_LIQUIDITY: Order size ${order.size} too large for market depth (simulated)`;
      }
    }

    return null;
  }

  private processPendingOrders(
    yesPrice: TokenPrice,
    noPrice: TokenPrice
  ): void {
    const now = Date.now();
    const ordersToRemove: string[] = [];

    for (const [orderId, order] of this.pendingOrders.entries()) {
      const timeSinceSubmission = now - order.submittedAt;

      if (timeSinceSubmission >= this.ORDER_FILL_DELAY_MS) {
        // First check if order should fail
        const failureReason = this.checkOrderFailure(order, yesPrice, noPrice);
        if (failureReason) {
          // Order failed
          const retryCount = order.retryCount || 0;
          const failed: FailedOrder = {
            orderId,
            tokenId: order.tokenId,
            price: order.price,
            size: order.size,
            failedAt: now,
            reason: failureReason,
            action: order.action,
            retryCount,
            originalReason: order.reason,
          };
          this.failedOrders.push(failed);

          // Check if order can be retried
          // Don't retry INVALID_PRICE (price needs to be updated by strategy)
          // Don't retry if max retries reached
          const canRetry = 
            !failureReason.includes("INVALID_PRICE") &&
            retryCount < this.MAX_RETRIES &&
            (now - order.submittedAt) >= this.RETRY_DELAY_MS;

          if (canRetry) {
            this.retryableFailedOrders.push(failed);
          }

          this.trades.push({
            cycle: this.cycle,
            timestamp: new Date(now),
            action: order.action,
            tokenId: order.tokenId,
            price: order.price,
            size: order.size,
            cost: order.price * order.size,
            reason: order.reason,
            orderId,
            status: "FAILED",
            failureReason: failureReason,
          });

          this.logger.warn(
            `[Cycle ${this.cycle}] ❌ Order FAILED: ${order.action} @ $${order.price.toFixed(4)} | Size: ${order.size} | Reason: ${failureReason}`,
            {
              orderId,
              action: order.action,
              tokenId: order.tokenId,
              price: order.price,
              size: order.size,
              reason: failureReason,
            }
          );

          ordersToRemove.push(orderId);
          continue;
        }

        // Check if order should fill (based on probability)
        const shouldFill = Math.random() < order.fillProbability;

        if (shouldFill) {
          // Calculate fill price (with possible slippage)
          let fillPrice = order.price;
          if (this.ENABLE_SLIPPAGE) {
            const slippage = (Math.random() - 0.5) * 2 * this.MAX_SLIPPAGE;
            fillPrice = Math.max(0.01, Math.min(0.99, order.price + slippage));
          }

          const fillSize = order.size; // Full fills for simplicity

          // Record filled order
          const filled: FilledOrder = {
            orderId,
            tokenId: order.tokenId,
            filledPrice: fillPrice,
            filledSize: fillSize,
            filledAt: now,
            originalPrice: order.price,
            originalSize: order.size,
          };
          this.filledOrders.push(filled);

          // Add to trades
          this.trades.push({
            cycle: this.cycle,
            timestamp: new Date(now),
            action: order.action,
            tokenId: order.tokenId,
            price: order.price,
            size: order.size,
            cost: order.price * order.size,
            reason: order.reason,
            orderId,
            filledPrice: fillPrice,
            filledSize: fillSize,
            status: "FILLED",
          });

          const slippageAmount = fillPrice - order.price;
          const slippagePercent = ((slippageAmount / order.price) * 100).toFixed(2);

          this.logger.info(
            `[Cycle ${this.cycle}] ✅ Order FILLED: ${order.action} | Ordered: ${order.size} @ $${order.price.toFixed(4)} | Filled: ${fillSize} @ $${fillPrice.toFixed(4)} ${slippageAmount >= 0 ? "+" : ""}${slippageAmount.toFixed(4)} (${slippagePercent}% slippage)`,
            {
              orderId,
              action: order.action,
              tokenId: order.tokenId,
              originalPrice: order.price,
              filledPrice: fillPrice,
              size: fillSize,
              slippage: slippageAmount,
              slippagePercent: parseFloat(slippagePercent),
            }
          );

          ordersToRemove.push(orderId);
        } else {
          // Order didn't fill (expired/cancelled)
          const retryCount = order.retryCount || 0;
          const failed: FailedOrder = {
            orderId,
            tokenId: order.tokenId,
            price: order.price,
            size: order.size,
            failedAt: now,
            reason: "ORDER_EXPIRED: Order did not fill within time window",
            action: order.action,
            retryCount,
            originalReason: order.reason,
          };
          this.failedOrders.push(failed);

          // Expired orders can be retried
          if (retryCount < this.MAX_RETRIES && (now - order.submittedAt) >= this.RETRY_DELAY_MS) {
            this.retryableFailedOrders.push(failed);
          }

          this.trades.push({
            cycle: this.cycle,
            timestamp: new Date(now),
            action: order.action,
            tokenId: order.tokenId,
            price: order.price,
            size: order.size,
            cost: order.price * order.size,
            reason: order.reason,
            orderId,
            status: "FAILED",
            failureReason: "ORDER_EXPIRED",
          });

          this.logger.warn(
            `[Cycle ${this.cycle}] ⏱️  Order EXPIRED: ${order.action} @ $${order.price.toFixed(4)} | Size: ${order.size}`,
            {
              orderId,
              action: order.action,
              tokenId: order.tokenId,
              price: order.price,
              size: order.size,
            }
          );

          ordersToRemove.push(orderId);
        }
      }
    }

    for (const orderId of ordersToRemove) {
      this.pendingOrders.delete(orderId);
    }
  }

  private retryFailedOrders(
    yesPrice: TokenPrice,
    noPrice: TokenPrice
  ): void {
    const now = Date.now();
    const ordersToRetry: FailedOrder[] = [];
    const ordersToRemove: FailedOrder[] = [];

    for (const failed of this.retryableFailedOrders) {
      // Check if enough time has passed since failure
      if (now - failed.failedAt >= this.RETRY_DELAY_MS) {
        // Check if we haven't exceeded max retries
        const retryCount = (failed.retryCount || 0) + 1;
        if (retryCount <= this.MAX_RETRIES) {
          ordersToRetry.push(failed);
        } else {
          ordersToRemove.push(failed);
        }
      }
    }

    // Remove orders that exceeded max retries
    for (const failed of ordersToRemove) {
      const index = this.retryableFailedOrders.indexOf(failed);
      if (index > -1) {
        this.retryableFailedOrders.splice(index, 1);
      }
    }

    // Retry orders
    for (const failed of ordersToRetry) {
      const retryCount = (failed.retryCount || 0) + 1;
      
      // Create retry decision
      const retryDecision: TradingDecision = {
        action: failed.action,
        tokenId: failed.tokenId,
        price: failed.price, // Keep same price (or could update to current market price)
        size: failed.size,
        reason: failed.originalReason || `Retry ${retryCount}/${this.MAX_RETRIES}: ${failed.reason}`,
      };

      // Check if there's already an active order for this token
      const activeOrders = this.getActiveOrders();
      const hasActiveOrder = activeOrders.some(
        (order) => order.tokenID === failed.tokenId
      );

      if (!hasActiveOrder) {
        // Remove from retryable list (will be added back if it fails again)
        const index = this.retryableFailedOrders.indexOf(failed);
        if (index > -1) {
          this.retryableFailedOrders.splice(index, 1);
        }

        // Submit retry order
        const newOrderId = this.submitOrder(retryDecision, yesPrice, noPrice);
        
        // Update pending order with retry count
        const pendingOrder = this.pendingOrders.get(newOrderId);
        if (pendingOrder) {
          pendingOrder.retryCount = retryCount;
        }

        this.logger.info(
          `[Cycle ${this.cycle}] 🔄 Retrying order: ${failed.action} @ $${failed.price.toFixed(4)} | Size: ${failed.size} | Retry ${retryCount}/${this.MAX_RETRIES}`,
          {
            originalOrderId: failed.orderId,
            newOrderId,
            retryCount,
            reason: failed.reason,
          }
        );
      }
    }
  }

  private getActiveOrders(): Array<{ tokenID: string }> {
    return Array.from(this.pendingOrders.values()).map((o) => ({
      tokenID: o.tokenId,
    }));
  }

  private buildContext(
    yesPrice: TokenPrice,
    noPrice: TokenPrice,
    timeUntilEnd?: number
  ): StrategyContext {
    const positions = this.getPositionsWithApiDelay();
    return {
      tokenPrice: yesPrice,
      yesTokenPrice: yesPrice,
      noTokenPrice: noPrice,
      positions,
      timeUntilEnd,
      config: {
        orderSize: this.config.orderSize,
        minPrice: this.config.minPrice,
        maxPrice: this.config.maxPrice,
        maxPositionSize: this.config.maxPositionSize,
        maxBudgetPerPool: this.config.maxBudgetPerPool,
      },
    };
  }

  private submitOrder(
    decision: TradingDecision,
    yesPrice: TokenPrice,
    noPrice: TokenPrice
  ): string {
    if (decision.action === "HOLD") {
      return "";
    }

    this.orderIdCounter++;
    const orderId = `mock_order_${this.orderIdCounter}`;

    // Calculate fill probability based on price vs market
    const tokenPrice = decision.tokenId === this.yesTokenId ? yesPrice : noPrice;
    const priceDiff = Math.abs(decision.price - tokenPrice.askPrice);
    let fillProbability = this.ORDER_FILL_PROBABILITY;

    // Adjust probability based on price difference
    if (priceDiff > 0.02) {
      fillProbability *= 0.5; // Lower probability if price is far from market
    } else if (priceDiff < 0.005) {
      fillProbability *= 1.2; // Higher probability if price is close to market
    }
    fillProbability = Math.min(0.95, Math.max(0.3, fillProbability));

    const pendingOrder: PendingOrder = {
      orderId,
      tokenId: decision.tokenId,
      price: decision.price,
      size: decision.size,
      submittedAt: Date.now(),
      action: decision.action,
      reason: decision.reason,
      fillProbability,
      slippageRange: this.MAX_SLIPPAGE,
    };

    this.pendingOrders.set(orderId, pendingOrder);

    this.logger.info(
      `[Cycle ${this.cycle}] 📤 Order SUBMITTED: ${decision.action} @ $${decision.price.toFixed(4)} | Size: ${decision.size} | Order ID: ${orderId} | Fill prob: ${(fillProbability * 100).toFixed(1)}%`,
      {
        orderId,
        action: decision.action,
        tokenId: decision.tokenId,
        price: decision.price,
        size: decision.size,
        reason: decision.reason,
        fillProbability: fillProbability * 100,
        marketPrice: tokenPrice.askPrice,
        priceDiff: priceDiff,
      }
    );

    return orderId;
  }

  private calculatePnl(
    yesPrice: TokenPrice,
    noPrice: TokenPrice
  ): {
    yesSize: number;
    noSize: number;
    yesUsd: number;
    noUsd: number;
    totalUsdSpent: number;
    currentValue: number;
    pnl: number;
    pnlPercent: number;
    pairCost: number;
    balanceRatio: number;
    asymRatio: number;
  } {
    const positions = this.getPositionsWithApiDelay();
    const yesPos = positions.find((p) => p.asset === this.yesTokenId);
    const noPos = positions.find((p) => p.asset === this.noTokenId);

    const yesSize = yesPos?.size || 0;
    const noSize = noPos?.size || 0;

    // Calculate total USD spent from filled orders
    let totalUsdSpent = 0;
    for (const filled of this.filledOrders) {
      if (Date.now() - filled.filledAt >= this.POSITION_API_DELAY_MS) {
        totalUsdSpent += filled.filledPrice * filled.filledSize;
      }
    }

    // Current market value (using bid prices for conservative estimate)
    const yesCurrentValue = yesSize * yesPrice.bidPrice;
    const noCurrentValue = noSize * noPrice.bidPrice;
    const currentValue = yesCurrentValue + noCurrentValue;

    // PnL calculation
    const pnl = currentValue - totalUsdSpent;
    const pnlPercent = totalUsdSpent > 0 ? (pnl / totalUsdSpent) * 100 : 0;

    // USD exposure (using ask prices)
    const yesUsd = yesSize * yesPrice.askPrice;
    const noUsd = noSize * noPrice.askPrice;

    // Calculate ratios (nuoiem-specific)
    const pairCost = yesPrice.askPrice + noPrice.askPrice;
    const totalSize = yesSize + noSize;
    const balanceRatio =
      totalSize > 0 && Math.max(yesSize, noSize) > 0
        ? Math.min(yesSize, noSize) / Math.max(yesSize, noSize)
        : 0;
    const asymRatio =
      totalSize > 0 ? Math.max(yesSize, noSize) / totalSize : 0;

    return {
      yesSize,
      noSize,
      yesUsd,
      noUsd,
      totalUsdSpent,
      currentValue,
      pnl,
      pnlPercent,
      pairCost,
      balanceRatio,
      asymRatio,
    };
  }

  async executeCycle(): Promise<void> {
    this.cycle += 1;

    const { yesPrice, noPrice } = await this.fetchPrices();
    if (!yesPrice || !noPrice) {
      this.logger.warn(`[Cycle ${this.cycle}] Missing prices, skipping`);
      return;
    }

    this.processPendingOrders(yesPrice, noPrice);

    // Retry failed orders
    this.retryFailedOrders(yesPrice, noPrice);

    const positions = this.getPositionsWithApiDelay();
    const activeOrders = this.getActiveOrders();
    const timeUntilEnd = this.computeTimeUntilEnd();
    const ctx = this.buildContext(yesPrice, noPrice, timeUntilEnd);
    const decision = this.strategy.execute(ctx);

    const decisions = Array.isArray(decision) ? decision : decision ? [decision] : [];

    // Calculate current metrics
    const pnl = this.calculatePnl(yesPrice, noPrice);
    const budgetLimit = this.config.maxBudgetPerPool || 100;
    const budgetUsed = pnl.totalUsdSpent;
    const budgetRemaining = Math.max(0, budgetLimit - budgetUsed);

    // Log market snapshot
    this.logger.info(`[Cycle ${this.cycle}] 📊 Market Snapshot`, {
      yesAsk: yesPrice.askPrice.toFixed(4),
      noAsk: noPrice.askPrice.toFixed(4),
      pairCost: pnl.pairCost.toFixed(4),
      timeUntilEndMs: timeUntilEnd,
      decisions: decisions.length,
      pendingOrders: this.pendingOrders.size,
      activeOrders: activeOrders.length,
      positionsCount: positions.length,
      yesSize: pnl.yesSize.toFixed(2),
      noSize: pnl.noSize.toFixed(2),
      balanceRatio: pnl.balanceRatio.toFixed(3),
      asymRatio: pnl.asymRatio.toFixed(3),
      budgetUsed: budgetUsed.toFixed(2),
      budgetRemaining: budgetRemaining.toFixed(2),
      budgetLimit: budgetLimit.toFixed(2),
    });

    for (const d of decisions) {
      if (!d) continue;

      if (d.action === "HOLD") {
        this.logger.info(
          `[Cycle ${this.cycle}] 🔒 HOLD: ${d.reason}`,
          {
            reason: d.reason,
            pairCost: pnl.pairCost.toFixed(4),
            balanceRatio: pnl.balanceRatio.toFixed(3),
            asymRatio: pnl.asymRatio.toFixed(3),
          }
        );
        continue;
      }

      // Check for duplicate active orders
      const hasActiveOrderForToken = activeOrders.some(
        (order) => order.tokenID === d.tokenId
      );

      if (hasActiveOrderForToken) {
        this.logger.info(
          `[Cycle ${this.cycle}] ⏸️  Skipping: Active order already exists for token`,
          {
            tokenId: d.tokenId,
            activeOrders: activeOrders.length,
            reason: d.reason,
          }
        );
        continue;
      }

      // Check budget
      const orderCost = d.price * d.size;
      if (budgetUsed + orderCost > budgetLimit) {
        this.logger.warn(
          `[Cycle ${this.cycle}] 💰 Budget exceeded: Order cost $${orderCost.toFixed(2)} would exceed budget limit $${budgetLimit.toFixed(2)}`,
          {
            orderCost: orderCost.toFixed(2),
            budgetUsed: budgetUsed.toFixed(2),
            budgetRemaining: budgetRemaining.toFixed(2),
            budgetLimit: budgetLimit.toFixed(2),
            reason: d.reason,
          }
        );
        continue;
      }

      this.submitOrder(d, yesPrice, noPrice);
    }

    // Log summary
    this.logger.info(
      `[Cycle ${this.cycle}] 💰 Summary | ` +
      `Pending: ${this.pendingOrders.size} | ` +
      `Filled: ${this.filledOrders.length} | ` +
      `Failed: ${this.failedOrders.length} | ` +
      `Spent: $${pnl.totalUsdSpent.toFixed(2)}/${budgetLimit.toFixed(2)} | ` +
      `Value: $${pnl.currentValue.toFixed(2)} | ` +
      `PnL: ${pnl.pnl >= 0 ? "+" : ""}$${pnl.pnl.toFixed(2)} (${pnl.pnlPercent >= 0 ? "+" : ""}${pnl.pnlPercent.toFixed(2)}%) | ` +
      `Pair: ${pnl.pairCost.toFixed(4)} | ` +
      `Balance: ${pnl.balanceRatio.toFixed(3)} | ` +
      `Asym: ${pnl.asymRatio.toFixed(3)}`,
      {
        pendingOrders: this.pendingOrders.size,
        filledOrders: this.filledOrders.length,
        failedOrders: this.failedOrders.length,
        totalUsdSpent: pnl.totalUsdSpent.toFixed(2),
        budgetLimit: budgetLimit.toFixed(2),
        budgetRemaining: budgetRemaining.toFixed(2),
        currentValue: pnl.currentValue.toFixed(2),
        pnl: pnl.pnl.toFixed(2),
        pnlPercent: pnl.pnlPercent.toFixed(2),
        yesSize: pnl.yesSize.toFixed(2),
        noSize: pnl.noSize.toFixed(2),
        pairCost: pnl.pairCost.toFixed(4),
        balanceRatio: pnl.balanceRatio.toFixed(3),
        asymRatio: pnl.asymRatio.toFixed(3),
      }
    );
  }

  async runUntilEnd(
    intervalMs: number = 1000,
    maxDurationMs: number = Number.MAX_SAFE_INTEGER
  ): Promise<TestResult> {
    const startTime = new Date();
    const start = Date.now();

    this.logger.info("Starting continuous Nuoiem Strategy Test (run until stopped)", {
      intervalMs,
      maxDurationMs,
      budgetPerPool: this.config.maxBudgetPerPool || 100,
      orderFillDelay: this.ORDER_FILL_DELAY_MS,
      orderFillProbability: this.ORDER_FILL_PROBABILITY,
    });

    this.positions = [];
    this.pendingOrders.clear();
    this.filledOrders = [];
    this.failedOrders = [];
    this.retryableFailedOrders = [];
    this.trades = [];
    this.cycle = 0;
    this.orderIdCounter = 0;

    let lastTimeUntilEnd: number | undefined;
    let shouldStop = false;

    // Handle graceful shutdown
    const shutdown = () => {
      this.logger.info("Received shutdown signal, stopping test gracefully...");
      shouldStop = true;
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      while (!shouldStop) {
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
          this.logger.info(
            "Detected new pool interval, ending current pool run",
            {
              lastTimeUntilEndMs: lastTimeUntilEnd,
              newTimeUntilEndMs: timeUntilEnd,
            }
          );
          break;
        }

        lastTimeUntilEnd = timeUntilEnd;

        if (
          elapsed >= maxDurationMs ||
          (timeUntilEnd !== undefined && timeUntilEnd <= 0)
        ) {
          break;
        }

        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } finally {
      // Remove signal handlers
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    }

    // Process any remaining pending orders
    const { yesPrice, noPrice } = await this.fetchPrices();
    if (yesPrice && noPrice) {
      for (let i = 0; i < 5; i++) {
        this.processPendingOrders(yesPrice, noPrice);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const endTime = new Date();

    // Final PnL calculation
    let yesSize = 0;
    let noSize = 0;
    let yesUsd = 0;
    let noUsd = 0;
    let totalUsdSpent = 0;
    let currentValue = 0;
    let pnl = 0;
    let pnlPercent = 0;
    let pairCost = 0;
    let balanceRatio = 0;
    let asymRatio = 0;

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
      pairCost = pnlData.pairCost;
      balanceRatio = pnlData.balanceRatio;
      asymRatio = pnlData.asymRatio;
    }

    const totalOrdersSubmitted = this.orderIdCounter;
    const totalOrdersFilled = this.filledOrders.length;
    const totalOrdersFailed = this.failedOrders.length;
    const budgetLimit = this.config.maxBudgetPerPool || 100;
    const budgetUsed = totalUsdSpent;
    const budgetRemaining = Math.max(0, budgetLimit - budgetUsed);

    const durationMinutes = ((endTime.getTime() - startTime.getTime()) / 1000 / 60).toFixed(2);

    const summary = `
================================================================================
=== Nuoiem Strategy Test Results (Continuous Run) ===
Strategy: nuoiem
Start Time: ${startTime.toISOString()}
End Time: ${endTime.toISOString()}
Duration: ${durationMinutes} minutes

Cycles: ${this.cycle}
Orders Submitted: ${totalOrdersSubmitted}
Orders Filled: ${totalOrdersFilled} (${totalOrdersSubmitted > 0 ? ((totalOrdersFilled / totalOrdersSubmitted) * 100).toFixed(1) : 0}%)
Orders Failed: ${totalOrdersFailed} (${totalOrdersSubmitted > 0 ? ((totalOrdersFailed / totalOrdersSubmitted) * 100).toFixed(1) : 0}%)

Budget:
  Limit: $${budgetLimit.toFixed(2)}
  Used: $${budgetUsed.toFixed(2)}
  Remaining: $${budgetRemaining.toFixed(2)}
  Usage: ${((budgetUsed / budgetLimit) * 100).toFixed(1)}%

Trading:
  Total Trades: ${this.trades.length}
  Total USD Spent: $${totalUsdSpent.toFixed(2)}
  Current Value: $${currentValue.toFixed(2)}
  PnL: $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%)

Positions:
  YES: ${yesSize.toFixed(2)} shares ($${yesUsd.toFixed(2)})
  NO: ${noSize.toFixed(2)} shares ($${noUsd.toFixed(2)})

Strategy Metrics:
  Pair Cost: ${pairCost.toFixed(4)}
  Balance Ratio: ${balanceRatio.toFixed(3)} (target: ≥0.75)
  Asymmetry Ratio: ${asymRatio.toFixed(3)} (target: 0.60-0.75)

Pending Orders: ${this.pendingOrders.size}
================================================================================
`;

    this.logger.info(summary);

    const result: TestResult = {
      startTime,
      endTime,
      totalCycles: this.cycle,
      totalOrdersSubmitted,
      totalOrdersFilled,
      totalOrdersFailed,
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
      failedOrders: this.failedOrders,
      marketInfo: this.marketInfo,
      summary,
      budgetUsed,
      budgetLimit,
      budgetRemaining,
    };

    // Write detailed logs (similar to strategy-real-market-tester)
    this.writeTradeHistory(result);
    this.writeSummaryHistory(result);

    return result;
  }

  async runTest(
    numCycles: number = 20,
    intervalMs: number = 1000
  ): Promise<TestResult> {
    const startTime = new Date();

    this.logger.info("Starting Nuoiem Strategy Test", {
      cycles: numCycles,
      intervalMs,
      budgetPerPool: this.config.maxBudgetPerPool || 100,
      orderFillDelay: this.ORDER_FILL_DELAY_MS,
      orderFillProbability: this.ORDER_FILL_PROBABILITY,
      orderFailureProbability: this.ORDER_FAILURE_PROBABILITY,
      maxSlippage: this.MAX_SLIPPAGE,
    });

    this.positions = [];
    this.pendingOrders.clear();
    this.filledOrders = [];
    this.failedOrders = [];
    this.retryableFailedOrders = [];
    this.trades = [];
    this.cycle = 0;
    this.orderIdCounter = 0;

    for (let i = 0; i < numCycles; i++) {
      await this.executeCycle();
      if (i < numCycles - 1) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }

    // Process any remaining pending orders
    const { yesPrice, noPrice } = await this.fetchPrices();
    if (yesPrice && noPrice) {
      for (let i = 0; i < 5; i++) {
        this.processPendingOrders(yesPrice, noPrice);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const endTime = new Date();

    // Final PnL calculation
    let yesSize = 0;
    let noSize = 0;
    let yesUsd = 0;
    let noUsd = 0;
    let totalUsdSpent = 0;
    let currentValue = 0;
    let pnl = 0;
    let pnlPercent = 0;
    let pairCost = 0;
    let balanceRatio = 0;
    let asymRatio = 0;

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
      pairCost = pnlData.pairCost;
      balanceRatio = pnlData.balanceRatio;
      asymRatio = pnlData.asymRatio;
    }

    const totalOrdersSubmitted = this.orderIdCounter;
    const totalOrdersFilled = this.filledOrders.length;
    const totalOrdersFailed = this.failedOrders.length;
    const budgetLimit = this.config.maxBudgetPerPool || 100;
    const budgetUsed = totalUsdSpent;
    const budgetRemaining = Math.max(0, budgetLimit - budgetUsed);

    const summary = `
================================================================================
=== Nuoiem Strategy Test Results ===
Strategy: nuoiem
Start Time: ${startTime.toISOString()}
End Time: ${endTime.toISOString()}
Duration: ${((endTime.getTime() - startTime.getTime()) / 1000 / 60).toFixed(2)} minutes

Cycles: ${numCycles}
Orders Submitted: ${totalOrdersSubmitted}
Orders Filled: ${totalOrdersFilled} (${totalOrdersSubmitted > 0 ? ((totalOrdersFilled / totalOrdersSubmitted) * 100).toFixed(1) : 0}%)
Orders Failed: ${totalOrdersFailed} (${totalOrdersSubmitted > 0 ? ((totalOrdersFailed / totalOrdersSubmitted) * 100).toFixed(1) : 0}%)

Budget:
  Limit: $${budgetLimit.toFixed(2)}
  Used: $${budgetUsed.toFixed(2)}
  Remaining: $${budgetRemaining.toFixed(2)}
  Usage: ${((budgetUsed / budgetLimit) * 100).toFixed(1)}%

Trading:
  Total Trades: ${this.trades.length}
  Total USD Spent: $${totalUsdSpent.toFixed(2)}
  Current Value: $${currentValue.toFixed(2)}
  PnL: $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%)

Positions:
  YES: ${yesSize.toFixed(2)} shares ($${yesUsd.toFixed(2)})
  NO: ${noSize.toFixed(2)} shares ($${noUsd.toFixed(2)})

Strategy Metrics:
  Pair Cost: ${pairCost.toFixed(4)}
  Balance Ratio: ${balanceRatio.toFixed(3)} (target: ≥0.75)
  Asymmetry Ratio: ${asymRatio.toFixed(3)} (target: 0.60-0.75)

Pending Orders: ${this.pendingOrders.size}
================================================================================
`;

    this.logger.info(summary);

    const result: TestResult = {
      startTime,
      endTime,
      totalCycles: numCycles,
      totalOrdersSubmitted,
      totalOrdersFilled,
      totalOrdersFailed,
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
      failedOrders: this.failedOrders,
      marketInfo: this.marketInfo,
      summary,
      budgetUsed,
      budgetLimit,
      budgetRemaining,
    };

    // Write detailed logs (similar to strategy-real-market-tester)
    this.writeTradeHistory(result);
    this.writeSummaryHistory(result);

    return result;
  }

  /**
   * Persist a simple CSV trade history for easier inspection.
   * Columns: timestamp, cycle, action, side, price, size, cost, cum_side_qty, avg_side_price, total_spent, orderId, status, filledPrice, filledSize, failureReason, reason
   */
  private writeTradeHistory(result: TestResult): void {
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
      "timestamp,cycle,action,side,price,size,cost,cum_side_qty,avg_side_price,total_spent,orderId,status,filledPrice,filledSize,failureReason,reason\n";

    const lines = result.trades.map((t) => {
      const side = t.tokenId === this.yesTokenId ? "YES" : "NO";
      const isBuy = t.action === "BUY_YES" || t.action === "BUY_NO";

      if (side === "YES") {
        if (isBuy && t.status === "FILLED") {
          yesQty += t.filledSize || t.size;
          yesCost += (t.filledPrice || t.price) * (t.filledSize || t.size);
          totalSpent += (t.filledPrice || t.price) * (t.filledSize || t.size);
        }
      } else {
        if (isBuy && t.status === "FILLED") {
          noQty += t.filledSize || t.size;
          noCost += (t.filledPrice || t.price) * (t.filledSize || t.size);
          totalSpent += (t.filledPrice || t.price) * (t.filledSize || t.size);
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
        t.orderId,
        t.status,
        t.filledPrice?.toFixed(4) || "",
        t.filledSize?.toFixed(4) || "",
        t.failureReason || "",
        `"${t.reason.replace(/"/g, '""')}"`, // Escape quotes in CSV
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
   * run_start,run_end,strategy,market,total_cycles,total_orders_submitted,total_orders_filled,total_orders_failed,
   * total_trades,total_spent,budget_limit,budget_used,budget_remaining,current_value,pnl,pnl_percent,
   * yes_size,no_size,yes_usd,no_usd
   */
  private writeSummaryHistory(result: TestResult): void {
    const defaultFile = `logs/test-summary-history-${this.strategyName}.csv`;
    const summaryFile = process.env.TEST_SUMMARY_FILE || defaultFile;
    const dir = path.dirname(summaryFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const market = result.marketInfo?.question?.replace(/,/g, " ") || "N/A";

    // Calculate ratios from positions
    const totalSize = result.positions.yesSize + result.positions.noSize;
    let balanceRatio = 0;
    let asymRatio = 0;
    if (totalSize > 0 && Math.max(result.positions.yesSize, result.positions.noSize) > 0) {
      balanceRatio =
        Math.min(result.positions.yesSize, result.positions.noSize) /
        Math.max(result.positions.yesSize, result.positions.noSize);
      asymRatio = Math.max(result.positions.yesSize, result.positions.noSize) / totalSize;
    }

    // Estimate pair cost from USD values (conservative estimate)
    const pairCost = result.positions.yesUsd > 0 && result.positions.noUsd > 0
      ? (result.positions.yesUsd / result.positions.yesSize) + (result.positions.noUsd / result.positions.noSize)
      : 0;

    const header =
      "run_start,run_end,strategy,market,total_cycles,total_orders_submitted,total_orders_filled,total_orders_failed,total_trades,total_spent,budget_limit,budget_used,budget_remaining,current_value,pnl,pnl_percent,yes_size,no_size,yes_usd,no_usd,pair_cost,balance_ratio,asym_ratio\n";

    const line = [
      result.startTime.toISOString(),
      result.endTime.toISOString(),
      this.strategyName,
      `"${market}"`,
      result.totalCycles,
      result.totalOrdersSubmitted,
      result.totalOrdersFilled,
      result.totalOrdersFailed,
      result.totalTrades,
      result.totalUsdSpent.toFixed(4),
      result.budgetLimit.toFixed(2),
      result.budgetUsed.toFixed(2),
      result.budgetRemaining.toFixed(2),
      result.currentValue.toFixed(4),
      result.pnl.toFixed(4),
      result.pnlPercent.toFixed(4),
      result.positions.yesSize.toFixed(4),
      result.positions.noSize.toFixed(4),
      result.positions.yesUsd.toFixed(4),
      result.positions.noUsd.toFixed(4),
      pairCost.toFixed(4),
      balanceRatio.toFixed(4),
      asymRatio.toFixed(4),
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

  /**
   * Print a formatted report similar to strategy-real-market-tester
   */
  printReport(result: TestResult): void {
    console.log(result.summary);

    if (result.trades.length > 0) {
      console.log("\n📋 Recent Trades (last 10):");
      const recent = result.trades.slice(-10);
      recent.forEach((t, idx) => {
        const side = t.tokenId === this.yesTokenId ? "YES" : "NO";
        const statusIcon = t.status === "FILLED" ? "✅" : t.status === "FAILED" ? "❌" : "⏳";
        console.log(
          `  ${idx + 1}. [Cycle ${t.cycle}] ${statusIcon} ${
            t.action
          } ${side} @ $${t.price.toFixed(4)} | Size: ${t.size.toFixed(
            2
          )} | Cost: $${t.cost.toFixed(2)}${t.filledPrice ? ` | Filled: $${t.filledPrice.toFixed(4)}` : ""}${t.failureReason ? ` | ${t.failureReason}` : ""}`
        );
      });

      if (result.trades.length > 10) {
        console.log(`\n  ... and ${result.trades.length - 10} more trades`);
      }
    }

    if (result.failedOrders.length > 0) {
      console.log(`\n⚠️  Failed Orders: ${result.failedOrders.length}`);
      const recentFailures = result.failedOrders.slice(-5);
      recentFailures.forEach((f, idx) => {
        const side = f.tokenId === this.yesTokenId ? "YES" : "NO";
        console.log(
          `  ${idx + 1}. ${f.action} ${side} @ $${f.price.toFixed(4)} | Size: ${f.size} | ${f.reason}`
        );
      });
    }
  }
}

// Main execution
if (require.main === module) {
  (async () => {
    try {
      const numCycles = getEnvNumber("TEST_CYCLES", 20);
      const intervalMs = getEnvNumber("TEST_CYCLE_INTERVAL_MS", 5000);
      const realtime = process.env.TEST_REALTIME === "true" || process.env.TEST_REALTIME === "1";
      const continuous = process.env.TEST_CONTINUOUS_POOLS === "true" || process.env.TEST_CONTINUOUS_POOLS === "1";
      const maxPools = getEnvNumber("TEST_MAX_POOLS", Number.MAX_SAFE_INTEGER);
      let virtualBankroll = Number(process.env.TEST_START_BANKROLL || "0");

      if (continuous && realtime) {
        // Continuous pools mode: automatically start new pool when current one ends
        let pool = 1;
        console.log(`Starting continuous pools mode. Will run up to ${maxPools} pools. Press Ctrl+C to stop.\n`);

        while (pool <= maxPools) {
          const tester = new NuoiemStrategyTester();
          await tester.initialize();

          console.log(`\n=== Starting Pool ${pool} ===`);
          console.log(`Market: ${tester.getMarketInfo()?.question || "N/A"}\n`);

          const result = await tester.runUntilEnd(
            intervalMs,
            getEnvNumber("TEST_MAX_DURATION_MS", Number.MAX_SAFE_INTEGER)
          );

          virtualBankroll += result.pnl;

          console.log(`\n=== Pool ${pool} Complete ===`);
          tester.printReport(result);
          console.log(`\nVirtual Bankroll: $${virtualBankroll.toFixed(2)}`);

          // Wait a bit before starting next pool
          if (pool < maxPools) {
            console.log("Waiting 5 seconds before starting next pool...\n");
            await new Promise((r) => setTimeout(r, 5000));
          }

          pool += 1;
        }

        console.log(`\n=== All ${maxPools} pools complete ===\n`);
        console.log(`Final Virtual Bankroll: $${virtualBankroll.toFixed(2)}\n`);
      } else {
        // Single pool mode
        const tester = new NuoiemStrategyTester();
        await tester.initialize();

        let result: TestResult;

        if (realtime) {
          // Run continuously until stopped (Ctrl+C) or market ends
          console.log("Running in continuous mode. Press Ctrl+C to stop.\n");
          result = await tester.runUntilEnd(
            intervalMs,
            getEnvNumber("TEST_MAX_DURATION_MS", Number.MAX_SAFE_INTEGER)
          );
        } else {
          // Run for specified number of cycles
          result = await tester.runTest(numCycles, intervalMs);
        }

        tester.printReport(result);
      }

      process.exit(0);
    } catch (error) {
      console.error("Test failed:", error);
      process.exit(1);
    }
  })();
}

