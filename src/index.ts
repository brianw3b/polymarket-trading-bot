import { loadConfig } from "./config";
import { createLogger } from "./utils/logger";
import { initializeWallet, initializeClobClient } from "./utils/wallet";
import {
  getMarketByToken,
  getMarketBySlug,
  getTokenPrice,
  getUserPositions,
  findTokenIdsForMarket,
} from "./utils/marketData";
import {
  generateMarketSlug,
  MarketSlugPattern,
} from "./utils/marketSlugGenerator";
import { getStrategy } from "./strategies";
import { OrderExecutor } from "./execution/orderExecutor";
import { StrategyContext } from "./strategies/base";

class PolymarketTradingBot {
  private config = loadConfig();
  private logger = createLogger(this.config.logLevel, this.config.logFile);
  private clobClient: any = null;
  private orderExecutor: OrderExecutor | null = null;
  private strategy: any = null;
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;

  async initialize() {
    try {
      this.logger.info("Initializing Polymarket Trading Bot...");
      this.logger.info(`Strategy: ${this.config.tradingStrategy}`);

      if (
        !this.config.targetTokenId &&
        !this.config.targetMarketSlug &&
        !this.config.marketSlugPattern
      ) {
        throw new Error(
          "Either TARGET_TOKEN_ID, TARGET_MARKET_SLUG, or MARKET_SLUG_PATTERN must be provided in .env file"
        );
      }

      if (
        this.config.marketSlugPattern &&
        (!this.config.marketSlugPattern.baseSlug ||
          !this.config.marketSlugPattern.timePattern)
      ) {
        throw new Error(
          "MARKET_SLUG_PATTERN requires both MARKET_SLUG_PATTERN_BASE and MARKET_SLUG_PATTERN_TIME"
        );
      }

      if (this.config.marketSlugPattern) {
        const timePattern =
          this.config.marketSlugPattern.timePattern === "static"
            ? "hourly"
            : this.config.marketSlugPattern.timePattern === "15min"
            ? "15min"
            : this.config.marketSlugPattern.timePattern === "daily"
            ? "daily"
            : "hourly";
        const pattern: MarketSlugPattern = {
          baseSlug: this.config.marketSlugPattern.baseSlug,
          timePattern: timePattern as "hourly" | "daily" | "15min" | "custom",
        };
        const currentSlug = generateMarketSlug(
          pattern,
          new Date(),
          this.logger
        );
        this.config.targetMarketSlug = currentSlug;
        this.logger.info(
          `Market Slug Pattern: ${this.config.marketSlugPattern.baseSlug}`
        );
        this.logger.info(
          `Time Pattern: ${this.config.marketSlugPattern.timePattern}`
        );
        this.logger.info(`Generated Current Slug: ${currentSlug}`);
      } else if (this.config.targetMarketSlug) {
        this.logger.info(`Target Market Slug: ${this.config.targetMarketSlug}`);
      } else if (this.config.targetTokenId) {
        this.logger.info(`Target Token ID: ${this.config.targetTokenId}`);
      }

      const { wallet, address, safeAddress, relayClient } =
        await initializeWallet(this.config, this.logger);

      this.clobClient = await initializeClobClient(
        this.config,
        wallet,
        address,
        safeAddress,
        this.logger
      );

      this.orderExecutor = new OrderExecutor(this.clobClient, this.logger);

      this.strategy = getStrategy(this.config.tradingStrategy);
      if (!this.strategy) {
        throw new Error(
          `Unknown strategy: ${this.config.tradingStrategy}. Available: ${[
            "balanced",
            "meanReversion",
            "momentum",
            "arbitrage",
          ].join(", ")}`
        );
      }

      this.logger.info(
        `Strategy loaded: ${this.strategy.name} - ${this.strategy.description}`
      );

      let market;
      if (this.config.targetMarketSlug) {
        this.logger.info("Fetching market by slug...");
        market = await getMarketBySlug(
          this.config.targetMarketSlug,
          this.logger
        );
        if (!market) {
          throw new Error(
            `Market not found for slug: ${this.config.targetMarketSlug}`
          );
        }
        if (market.tokenIds && market.tokenIds.length > 0) {
          this.config.targetTokenId = market.tokenIds[0];
        }
      } else if (this.config.targetTokenId) {
        this.logger.info("Fetching market by token ID...");
        market = await getMarketByToken(this.config.targetTokenId, this.logger);
        if (!market) {
          this.logger.error(
            "Market not found by token ID. This is common for markets beyond the first ~7500 results."
          );
          this.logger.info(
            "💡 Solution: Use market slug instead (more reliable)"
          );
          this.logger.info(
            "   Option 1: Use MARKET_SLUG_PATTERN (for time-based markets like hourly Bitcoin)"
          );
          this.logger.info(
            "     MARKET_SLUG_PATTERN_BASE=bitcoin-up-or-down-december-11-2am-et"
          );
          this.logger.info("     MARKET_SLUG_PATTERN_TIME=hourly");
          this.logger.info(
            "   Option 2: Use TARGET_MARKET_SLUG (for static markets)"
          );
          this.logger.info("     TARGET_MARKET_SLUG=your-market-slug-here");
          this.logger.info(
            "   Get the slug from Polymarket URL: polymarket.com/event/MARKET-SLUG"
          );
          throw new Error(
            `Market not found for token ID: ${this.config.targetTokenId}. ` +
              `Please use MARKET_SLUG_PATTERN or TARGET_MARKET_SLUG instead (see logs above for instructions).`
          );
        }
      }

      if (!market) {
        throw new Error("Failed to fetch market information");
      }

      this.logger.info(`Market found: ${market.question}`);
      this.logger.info(`Outcomes: ${market.outcomes.join(", ")}`);
      this.logger.info(`Token IDs: ${market.tokenIds.join(", ")}`);

      this.logger.info("Bot initialized successfully");
    } catch (error) {
      this.logger.error("Failed to initialize bot", { error });
      throw error;
    }
  }

  async executeTradingCycle() {
    if (!this.clobClient || !this.orderExecutor || !this.strategy) {
      this.logger.error("Bot not properly initialized");
      return;
    }

    try {
      this.logger.info("Starting trading cycle...");

      let currentSlug = this.config.targetMarketSlug;
      if (this.config.marketSlugPattern) {
        const timePattern =
          this.config.marketSlugPattern.timePattern === "static"
            ? "hourly"
            : this.config.marketSlugPattern.timePattern === "15min"
            ? "15min"
            : this.config.marketSlugPattern.timePattern === "daily"
            ? "daily"
            : "hourly";
        const pattern: MarketSlugPattern = {
          baseSlug: this.config.marketSlugPattern.baseSlug,
          timePattern: timePattern as "hourly" | "daily" | "15min" | "custom",
        };
        currentSlug = generateMarketSlug(pattern, new Date(), this.logger);
        this.logger.debug(
          `Generated market slug for current time: ${currentSlug}`
        );
      }

      let market;
      if (currentSlug) {
        market = await getMarketBySlug(currentSlug, this.logger);
        if (!market && this.config.marketSlugPattern) {
          const timePattern =
            this.config.marketSlugPattern.timePattern === "static"
              ? "hourly"
              : this.config.marketSlugPattern.timePattern === "15min"
              ? "15min"
              : this.config.marketSlugPattern.timePattern === "daily"
              ? "daily"
              : "hourly";
          const pattern: MarketSlugPattern = {
            baseSlug: this.config.marketSlugPattern.baseSlug,
            timePattern: timePattern as "hourly" | "daily" | "15min" | "custom",
          };
          let nextSlug: string;
          let nextTime: Date;

          if (this.config.marketSlugPattern.timePattern === "15min") {
            nextTime = new Date(Date.now() + 15 * 60 * 1000);
            nextSlug = generateMarketSlug(pattern, nextTime, this.logger);
            this.logger.info(
              `Market not found for ${currentSlug}, trying next 15min: ${nextSlug}`
            );
          } else if (this.config.marketSlugPattern.timePattern === "hourly") {
            nextTime = new Date(Date.now() + 60 * 60 * 1000);
            nextSlug = generateMarketSlug(pattern, nextTime, this.logger);
            this.logger.info(
              `Market not found for ${currentSlug}, trying next hour: ${nextSlug}`
            );
          } else {
            nextSlug = currentSlug;
          }

          if (nextSlug !== currentSlug) {
            market = await getMarketBySlug(nextSlug, this.logger);
            if (market) {
              currentSlug = nextSlug;
            }
          }
        }
      } else if (this.config.targetTokenId) {
        market = await getMarketByToken(this.config.targetTokenId, this.logger);
      } else {
        this.logger.error("No market identifier configured");
        return;
      }

      if (!market) {
        this.logger.warn(
          `Market not found for slug: ${currentSlug}, skipping cycle`
        );
        return;
      }

      const { yesTokenId, noTokenId } = findTokenIdsForMarket(market, "YES");

      if (!yesTokenId || !noTokenId) {
        this.logger.warn("Could not find YES/NO token IDs", {
          outcomes: market.outcomes,
          tokenIds: market.tokenIds,
        });
        return;
      }

      this.logger.info("Token IDs found", {
        yesTokenId,
        noTokenId,
        outcomes: market.outcomes,
        marketQuestion: market.question,
      });

      this.logger.info("Fetching prices...", {
        yesTokenId,
        noTokenId,
      });

      const yesPrice = await getTokenPrice(
        this.clobClient,
        yesTokenId,
        this.logger
      );
      const noPrice = await getTokenPrice(
        this.clobClient,
        noTokenId,
        this.logger
      );

      if (!yesPrice || !noPrice) {
        this.logger.warn("Could not fetch token prices");
        return;
      }

      this.logger.info("Current prices", {
        yes: {
          tokenId: yesPrice.tokenId,
          bid: yesPrice.bidPrice.toFixed(4),
          ask: yesPrice.askPrice.toFixed(4),
          mid: yesPrice.midPrice.toFixed(4),
          spread: yesPrice.spread.toFixed(4),
        },
        no: {
          tokenId: noPrice.tokenId,
          bid: noPrice.bidPrice.toFixed(4),
          ask: noPrice.askPrice.toFixed(4),
          mid: noPrice.midPrice.toFixed(4),
          spread: noPrice.spread.toFixed(4),
        },
        totalCost: (yesPrice.askPrice + noPrice.askPrice).toFixed(4),
        outcomeMapping: {
          yes: market.outcomes[market.tokenIds.indexOf(yesTokenId)],
          no: market.outcomes[market.tokenIds.indexOf(noTokenId)],
        },
      });

      const walletAddress = await this.clobClient.signer.getAddress();
      const positions = await getUserPositions(walletAddress, this.logger);

      this.logger.info(`Current positions: ${positions.length}`);

      let timeUntilEnd: number | undefined;
      if (this.config.marketSlugPattern?.timePattern === "15min") {
        const now = Date.now();
        const intervalMs = 15 * 60 * 1000;
        const currentIntervalStart = Math.floor(now / intervalMs) * intervalMs;
        const intervalEnd = currentIntervalStart + intervalMs;
        timeUntilEnd = intervalEnd - now;
        this.logger.debug(
          `Time until market end: ${Math.floor(timeUntilEnd / 1000)}s`
        );
      } else if (this.config.marketSlugPattern?.timePattern === "hourly") {
        const now = Date.now();
        const intervalMs = 60 * 60 * 1000;
        const currentIntervalStart = Math.floor(now / intervalMs) * intervalMs;
        const intervalEnd = currentIntervalStart + intervalMs;
        timeUntilEnd = intervalEnd - now;
        this.logger.debug(
          `Time until market end: ${Math.floor(timeUntilEnd / 1000)}s`
        );
      }

      const context: StrategyContext = {
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
          stopLossPercentage: this.config.stopLossPercentage,
          takeProfitPercentage: this.config.takeProfitPercentage,
        },
      };

      const decision = this.strategy.execute(context);

      if (decision && decision.action !== "HOLD") {
        this.logger.info("Strategy decision", {
          action: decision.action,
          tokenId: decision.tokenId,
          price: decision.price,
          size: decision.size,
          reason: decision.reason,
        });

        const activeOrders = await this.orderExecutor.getActiveOrders();
        if (activeOrders.length >= this.config.maxOrdersPerCycle) {
          this.logger.info("Max orders per cycle reached, skipping order", {
            activeOrders: activeOrders.length,
            maxOrders: this.config.maxOrdersPerCycle,
          });
          return;
        }

        const orderId = await this.orderExecutor.executeOrder(decision);
        if (orderId) {
          this.logger.info("Trading decision executed", {
            decision: decision.action,
            orderId,
            reason: decision.reason,
          });
        }
      } else {
        this.logger.info("Strategy returned no action", {
          decision: decision ? decision.action : "null",
          reason: decision ? decision.reason : "Strategy conditions not met",
          yesPrice: yesPrice.midPrice.toFixed(4),
          noPrice: noPrice.midPrice.toFixed(4),
          totalCost: (yesPrice.askPrice + noPrice.askPrice).toFixed(4),
        });
      }

      this.logger.info("Trading cycle completed");
    } catch (error) {
      this.logger.error("Error in trading cycle", { error });
    }
  }

  start() {
    if (this.isRunning) {
      this.logger.warn("Bot is already running");
      return;
    }

    this.isRunning = true;
    this.logger.info(
      `Starting bot with ${this.config.pollIntervalMs}ms polling interval`
    );

    this.executeTradingCycle();

    this.intervalId = setInterval(() => {
      this.executeTradingCycle();
    }, this.config.pollIntervalMs);
  }

  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.logger.info("Bot stopped");
  }

  async shutdown() {
    this.logger.info("Shutting down bot...");
    this.stop();
    this.logger.info("Bot shutdown complete");
  }
}

async function main() {
  const bot = new PolymarketTradingBot();

  process.on("SIGINT", async () => {
    await bot.shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await bot.shutdown();
    process.exit(0);
  });

  try {
    await bot.initialize();
    bot.start();
  } catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { PolymarketTradingBot };
