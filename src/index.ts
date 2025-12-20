import { loadConfig } from "./config";
import { createLogger } from "./utils/logger";
import { initializeWallet, initializeClobClient, WalletSetup } from "./utils/wallet";
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
import { redeemPositions } from "./utils/redeem";

class PolymarketTradingBot {
  private config = loadConfig();
  private logger = createLogger(this.config.logLevel, this.config.logFile);
  private clobClient: any = null;
  private orderExecutor: OrderExecutor | null = null;
  private strategy: any = null;
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private relayClient: any = null;
  private lastRedeemCheck: Map<string, number> = new Map(); // Track last redeem attempt per conditionId

  async initialize() {
    try {
      this.logger.info("Initializing Polymarket Trading Bot...");
      this.logger.info(`Strategy: ${this.config.tradingStrategy}`);

      if (!this.config.targetMarketSlug && !this.config.marketSlugPattern) {
        throw new Error(
          "Either TARGET_MARKET_SLUG, or MARKET_SLUG_PATTERN must be provided in .env file"
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

      this.relayClient = relayClient;

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
            "ladderScale",
            "nuoiem",
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
        
        // If market not found and using pattern, try next interval (like in executeTradingCycle)
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
              `Market not found for ${this.config.targetMarketSlug}, trying next 15min: ${nextSlug}`
            );
          } else if (this.config.marketSlugPattern.timePattern === "hourly") {
            nextTime = new Date(Date.now() + 60 * 60 * 1000);
            nextSlug = generateMarketSlug(pattern, nextTime, this.logger);
            this.logger.info(
              `Market not found for ${this.config.targetMarketSlug}, trying next hour: ${nextSlug}`
            );
          } else {
            nextSlug = this.config.targetMarketSlug;
          }

          if (nextSlug !== this.config.targetMarketSlug) {
            market = await getMarketBySlug(nextSlug, this.logger);
            if (market) {
              this.config.targetMarketSlug = nextSlug;
              this.logger.info(`Found market at next interval: ${nextSlug}`);
            }
          }
        }
        
        if (!market) {
          // For pattern-based markets, allow initialization to continue
          // The execution cycle will handle finding the market
          if (this.config.marketSlugPattern) {
            this.logger.warn(
              `Market not found for slug: ${this.config.targetMarketSlug}, but continuing initialization. Execution cycle will retry.`
            );
          } else {
            throw new Error(
              `Market not found for slug: ${this.config.targetMarketSlug}`
            );
          }
        } else {
          if (market.tokenIds && market.tokenIds.length > 0) {
            this.config.targetTokenId = market.tokenIds[0];
          }
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

      if (market) {
        this.logger.info(`Market found: ${market.question}`);
        this.logger.info(`Outcomes: ${market.outcomes.join(", ")}`);
        this.logger.info(`Token IDs: ${market.tokenIds.join(", ")}`);
      } else if (!this.config.marketSlugPattern) {
        // Only throw error if not using pattern (pattern markets will be found in execution cycle)
        throw new Error("Failed to fetch market information");
      }

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

      const walletAddress = this.clobClient.orderBuilder.funderAddress;
      const positions = await getUserPositions(walletAddress, this.logger);

      this.logger.info(`Current positions: ${positions.length}`);

      // Check if market is closed and redeem winning positions
      if (market.closed) {
        await this.handleMarketRedemption(market, positions, yesTokenId, noTokenId, yesPrice, noPrice);
      }

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
        
        // Check if we already have an active order for this token (prevents duplicate orders)
        const hasActiveOrderForToken = activeOrders.some(
          (order: any) => order.tokenID === decision.tokenId
        );
        
        if (hasActiveOrderForToken) {
          this.logger.info("Active order already exists for this token, skipping", {
            tokenId: decision.tokenId,
            activeOrders: activeOrders.length,
            reason: decision.reason,
          });
          return;
        }
        
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

  /**
   * Handle redemption of winning positions when market is closed
   */
  private async handleMarketRedemption(
    market: any,
    positions: any[],
    yesTokenId: string,
    noTokenId: string,
    yesPrice: any,
    noPrice: any
  ): Promise<void> {
    if (!this.relayClient) {
      this.logger.warn("Relay client not available, cannot redeem positions");
      return;
    }

    try {
      // Determine winning outcome: YES wins if YES price = 1.0, NO wins if NO price = 1.0
      // In practice, when market closes, winning side price approaches 1.0
      const yesWins = yesPrice.midPrice >= 0.99;
      const noWins = noPrice.midPrice >= 0.99;

      if (!yesWins && !noWins) {
        this.logger.info("Market closed but outcome not yet determined", {
          yesPrice: yesPrice.midPrice,
          noPrice: noPrice.midPrice,
        });
        return;
      }

      const winningOutcome = yesWins ? "YES" : "NO";
      const winningTokenId = yesWins ? yesTokenId : noTokenId;
      const outcomeIndex = yesWins ? 0 : 1; // YES = 0, NO = 1

      this.logger.info("Market closed, determining winning outcome", {
        winningOutcome,
        yesPrice: yesPrice.midPrice,
        noPrice: noPrice.midPrice,
        outcomeIndex,
      });

      // Find positions for winning outcome
      const winningPositions = positions.filter(
        (pos) => pos.asset === winningTokenId && pos.size > 0
      );

      if (winningPositions.length === 0) {
        this.logger.info("No winning positions to redeem");
        return;
      }

      // Group positions by conditionId
      const positionsByCondition = new Map<string, any[]>();
      for (const pos of winningPositions) {
        if (pos.conditionId) {
          if (!positionsByCondition.has(pos.conditionId)) {
            positionsByCondition.set(pos.conditionId, []);
          }
          positionsByCondition.get(pos.conditionId)!.push(pos);
        }
      }

      // Redeem positions for each conditionId
      for (const [conditionId, conditionPositions] of positionsByCondition) {
        const totalSize = conditionPositions.reduce((sum, p) => sum + p.size, 0);
        
        // Check if we already tried to redeem this condition recently (within 5 minutes)
        const lastRedeemAttempt = this.lastRedeemCheck.get(conditionId) || 0;
        const now = Date.now();
        if (now - lastRedeemAttempt < 5 * 60 * 1000) {
          this.logger.debug("Skipping redeem - attempted recently", {
            conditionId,
            lastAttempt: new Date(lastRedeemAttempt).toISOString(),
          });
          continue;
        }

        this.logger.info("Redeeming winning positions", {
          conditionId,
          outcomeIndex,
          winningOutcome,
          totalSize,
          positionsCount: conditionPositions.length,
        });

        try {
          // Use outcomeIndex from position if available, otherwise use determined index
          const posOutcomeIndex = conditionPositions[0]?.outcomeIndex ?? outcomeIndex;
          
          await redeemPositions(
            this.relayClient,
            {
              conditionId,
              outcomeIndex: posOutcomeIndex,
            },
            this.logger
          );

          this.lastRedeemCheck.set(conditionId, now);
          this.logger.info("Successfully redeemed positions", {
            conditionId,
            outcomeIndex: posOutcomeIndex,
            totalSize,
          });
        } catch (error) {
          this.logger.error("Failed to redeem positions", {
            conditionId,
            outcomeIndex,
            error: error instanceof Error ? error.message : String(error),
          });
          // Still update last attempt to avoid spamming
          this.lastRedeemCheck.set(conditionId, now);
        }
      }
    } catch (error) {
      this.logger.error("Error handling market redemption", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
