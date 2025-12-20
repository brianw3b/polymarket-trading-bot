import { loadConfig } from "./config";
import { createLogger } from "./utils/logger";
import { initializeWallet, initializeClobClient, WalletSetup } from "./utils/wallet";
import {
  getMarketByToken,
  getMarketBySlug,
  getTokenPrice,
  getUserPositions,
  findTokenIdsForMarket,
  MarketInfo,
} from "./utils/marketData";
import {
  generateMarketSlug,
  MarketSlugPattern,
} from "./utils/marketSlugGenerator";
import { getStrategy } from "./strategies";
import { OrderExecutor } from "./execution/orderExecutor";
import { StrategyContext } from "./strategies/base";
import { redeemPositions } from "./utils/redeem";
import * as fs from "fs";
import * as path from "path";

interface TradeRecord {
  timestamp: Date;
  cycle: number;
  action: string;
  tokenId: string;
  price: number;
  size: number;
  cost: number;
  orderId: string | null;
  status: "SUBMITTED" | "FILLED" | "FAILED" | "CANCELLED";
  filledPrice?: number;
  filledSize?: number;
  failureReason?: string;
  reason: string;
}

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
  
  // CSV logging tracking
  private trades: TradeRecord[] = [];
  private cycleCount = 0;
  private botStartTime: Date | null = null;
  private currentMarket: MarketInfo | null = null;
  private yesTokenId: string | null = null;
  private noTokenId: string | null = null;

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

      // Store market and token info for CSV logging
      this.currentMarket = market;
      const { yesTokenId, noTokenId } = findTokenIdsForMarket(market, "YES");
      this.yesTokenId = yesTokenId || null;
      this.noTokenId = noTokenId || null;

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

      let yesPrice, noPrice;
      try {
        [yesPrice, noPrice] = await Promise.all([
          getTokenPrice(this.clobClient, yesTokenId, this.logger),
          getTokenPrice(this.clobClient, noTokenId, this.logger),
        ]);
      } catch (error) {
        this.logger.error("Exception while fetching prices", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (!yesPrice || !noPrice) {
        this.logger.warn("Could not fetch token prices", {
          hasYesPrice: !!yesPrice,
          hasNoPrice: !!noPrice,
        });
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
      let positions: any[] = [];
      try {
        positions = await getUserPositions(walletAddress, this.logger);
      } catch (error) {
        this.logger.error("Exception while fetching positions", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with empty positions array - strategy can still work
        positions = [];
      }

      this.logger.info(`Current positions: ${positions.length}`);

      // Update trade statuses based on current positions
      await this.updateTradeStatuses(positions, yesPrice, noPrice);

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
          maxBudgetPerPool: this.config.maxBudgetPerPool,
        },
      };

      const decision = this.strategy.execute(context);

      // Handle both single decision and array of decisions
      const decisions = Array.isArray(decision) ? decision : decision ? [decision] : [];

      if (decisions.length === 0) {
        this.logger.info("Strategy returned no action", {
          reason: "Strategy conditions not met",
          yesPrice: yesPrice.midPrice.toFixed(4),
          noPrice: noPrice.midPrice.toFixed(4),
          totalCost: (yesPrice.askPrice + noPrice.askPrice).toFixed(4),
        });
      } else {
        // Increment cycle count for CSV logging
        this.cycleCount++;

        // Get active orders once for all decisions (prevents race conditions)
        let activeOrders: any[] = [];
        try {
          activeOrders = await this.orderExecutor.getActiveOrders();
        } catch (error) {
          this.logger.error("Failed to fetch active orders, skipping order submission", {
            error: error instanceof Error ? error.message : String(error),
          });
          return; // Skip this cycle if we can't check active orders
        }

        // Track submitted orders in this cycle to prevent duplicates within same cycle
        const submittedInThisCycle = new Set<string>();
        // Track orders submitted in this cycle with their costs for budget calculation
        const ordersSubmittedInCycle: Array<{ tokenId: string; price: number; size: number }> = [];

        for (const d of decisions) {
          if (!d || d.action === "HOLD") {
            continue;
          }

          // Validate decision before processing
          if (!this.validateDecision(d, yesTokenId, noTokenId, yesPrice, noPrice)) {
            continue;
          }

          this.logger.info("Strategy decision", {
            action: d.action,
            tokenId: d.tokenId,
            price: d.price,
            size: d.size,
            reason: d.reason,
          });

          // Check if we already have an active order for this token (prevents duplicate orders)
          const hasActiveOrderForToken = activeOrders.some(
            (order: any) => order.tokenID === d.tokenId
          );

          // Check if we already submitted an order for this token in this cycle
          if (submittedInThisCycle.has(d.tokenId)) {
            this.logger.warn("Duplicate decision in same cycle, skipping", {
              tokenId: d.tokenId,
              action: d.action,
              reason: d.reason,
            });
            continue;
          }

          if (hasActiveOrderForToken) {
            this.logger.info("Active order already exists for this token, skipping", {
              tokenId: d.tokenId,
              activeOrders: activeOrders.length,
              reason: d.reason,
            });
            continue;
          }

          // Validate budget before submitting order (includes active orders and in-cycle orders)
          if (!this.validateBudget(d, positions, yesPrice, noPrice, activeOrders, ordersSubmittedInCycle)) {
            this.logger.warn("Order would exceed budget, skipping", {
              tokenId: d.tokenId,
              price: d.price,
              size: d.size,
              cost: d.price * d.size,
              reason: d.reason,
            });
            continue;
          }

          // Submit order
          try {
            const orderId = await this.orderExecutor.executeOrder(d);
            if (orderId) {
              this.logger.info("Trading decision executed", {
                decision: d.action,
                orderId,
                reason: d.reason,
              });
              
              // Track trade for CSV logging
              this.recordTrade({
                timestamp: new Date(),
                cycle: this.cycleCount,
                action: d.action,
                tokenId: d.tokenId,
                price: d.price,
                size: d.size,
                cost: d.price * d.size,
                orderId: orderId,
                status: "SUBMITTED",
                reason: d.reason || "",
              });
              
              // Mark as submitted to prevent duplicates in same cycle
              submittedInThisCycle.add(d.tokenId);
              // Track order cost for budget calculation
              ordersSubmittedInCycle.push({
                tokenId: d.tokenId,
                price: d.price,
                size: d.size,
              });
              // Add to active orders list to prevent duplicates in subsequent decisions
              // Include price and size for accurate budget tracking
              activeOrders.push({
                tokenID: d.tokenId,
                orderID: orderId,
                price: d.price,
                size: d.size,
              });
            } else {
              // Track failed order
              this.recordTrade({
                timestamp: new Date(),
                cycle: this.cycleCount,
                action: d.action,
                tokenId: d.tokenId,
                price: d.price,
                size: d.size,
                cost: d.price * d.size,
                orderId: null,
                status: "FAILED",
                failureReason: "Order submission returned null",
                reason: d.reason || "",
              });
              
              this.logger.warn("Order submission failed (returned null)", {
                action: d.action,
                tokenId: d.tokenId,
                price: d.price,
                size: d.size,
                reason: d.reason,
              });
            }
          } catch (orderError) {
            // Track failed order
            this.recordTrade({
              timestamp: new Date(),
              cycle: this.cycleCount,
              action: d.action,
              tokenId: d.tokenId,
              price: d.price,
              size: d.size,
              cost: d.price * d.size,
              orderId: null,
              status: "FAILED",
              failureReason: orderError instanceof Error ? orderError.message : String(orderError),
              reason: d.reason || "",
            });
            
            this.logger.error("Exception during order execution", {
              action: d.action,
              tokenId: d.tokenId,
              error: orderError instanceof Error ? orderError.message : String(orderError),
              reason: d.reason,
            });
            // Continue with next decision instead of failing entire cycle
          }
        }
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
    this.botStartTime = new Date();
    this.cycleCount = 0;
    this.trades = [];
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

  /**
   * Validate strategy decision before execution
   */
  private validateDecision(
    decision: any,
    yesTokenId: string,
    noTokenId: string,
    yesPrice: any,
    noPrice: any
  ): boolean {
    // Check required fields
    if (!decision || !decision.action || !decision.tokenId || decision.price === undefined || decision.size === undefined) {
      this.logger.warn("Invalid decision: missing required fields", { decision });
      return false;
    }

    // Validate action
    const validActions = ["BUY_YES", "BUY_NO", "SELL_YES", "SELL_NO", "HOLD"];
    if (!validActions.includes(decision.action)) {
      this.logger.warn("Invalid decision: invalid action", {
        action: decision.action,
        validActions,
      });
      return false;
    }

    // Validate tokenId
    if (decision.tokenId !== yesTokenId && decision.tokenId !== noTokenId) {
      this.logger.warn("Invalid decision: tokenId not in market", {
        tokenId: decision.tokenId,
        yesTokenId,
        noTokenId,
      });
      return false;
    }

    // Validate price
    if (
      typeof decision.price !== "number" ||
      isNaN(decision.price) ||
      !isFinite(decision.price) ||
      decision.price <= 0 ||
      decision.price >= 1
    ) {
      this.logger.warn("Invalid decision: invalid price", {
        price: decision.price,
        tokenId: decision.tokenId,
      });
      return false;
    }

    // Validate size
    if (
      typeof decision.size !== "number" ||
      isNaN(decision.size) ||
      !isFinite(decision.size) ||
      decision.size <= 0
    ) {
      this.logger.warn("Invalid decision: invalid size", {
        size: decision.size,
        tokenId: decision.tokenId,
      });
      return false;
    }

    // Check if price is reasonable (within 10% of current market price)
    const tokenPrice = decision.tokenId === yesTokenId ? yesPrice : noPrice;
    const priceDiff = Math.abs(decision.price - tokenPrice.askPrice);
    const priceDiffPercent = (priceDiff / tokenPrice.askPrice) * 100;

    if (priceDiffPercent > 10) {
      this.logger.warn("Invalid decision: price too far from market", {
        decisionPrice: decision.price,
        marketPrice: tokenPrice.askPrice,
        diffPercent: priceDiffPercent.toFixed(2),
        tokenId: decision.tokenId,
      });
      return false;
    }

    return true;
  }

  /**
   * Validate budget before submitting order
   * Includes filled positions, active pending orders, and orders submitted in current cycle
   */
  private validateBudget(
    decision: any,
    positions: any[],
    yesPrice: any,
    noPrice: any,
    activeOrders: any[] = [],
    ordersSubmittedInCycle: Array<{ tokenId: string; price: number; size: number }> = []
  ): boolean {
    if (!this.config.maxBudgetPerPool) {
      return true; // No budget limit configured
    }

    // Calculate current spent amount from filled positions
    let totalSpent = 0;
    for (const pos of positions) {
      const tokenPrice = pos.asset === yesPrice.tokenId ? yesPrice : noPrice;
      // Estimate cost: use current ask price as approximation
      // (in reality, we'd need to track actual entry prices)
      totalSpent += pos.size * tokenPrice.askPrice;
    }

    // Add cost of active pending orders (orders that haven't filled yet)
    for (const order of activeOrders) {
      // Handle different field name variations (tokenID, tokenId, etc.)
      const orderTokenId = order.tokenID || order.tokenId || order.asset;
      if (!orderTokenId) continue; // Skip if we can't identify the token
      
      const tokenPrice = orderTokenId === yesPrice.tokenId ? yesPrice : noPrice;
      // Use order price if available (check multiple possible field names)
      const orderPrice = order.price || order.limitPrice || order.orderPrice;
      const orderSize = order.size || order.amount || order.quantity;
      
      // If order has price and size, use them; otherwise estimate from current market
      if (orderPrice && orderSize) {
        totalSpent += orderPrice * orderSize;
      } else if (orderSize) {
        // If we have size but not price, use current ask price (conservative)
        totalSpent += tokenPrice.askPrice * orderSize;
      } else {
        // Conservative estimate: assume order is at current ask price with minimum size
        // This is a fallback if order details aren't available
        totalSpent += tokenPrice.askPrice * 10; // Default to 10 shares if size unknown
      }
    }

    // Add cost of orders submitted in this cycle (before they become active)
    for (const cycleOrder of ordersSubmittedInCycle) {
      const tokenPrice = cycleOrder.tokenId === yesPrice.tokenId ? yesPrice : noPrice;
      totalSpent += cycleOrder.price * cycleOrder.size;
    }

    // Calculate new order cost
    const orderCost = decision.price * decision.size;
    const newTotal = totalSpent + orderCost;

    if (newTotal > this.config.maxBudgetPerPool) {
      this.logger.warn("Budget validation failed", {
        filledPositionsCost: positions.reduce((sum, pos) => {
          const tokenPrice = pos.asset === yesPrice.tokenId ? yesPrice : noPrice;
          return sum + pos.size * tokenPrice.askPrice;
        }, 0).toFixed(2),
        activeOrdersCost: activeOrders.reduce((sum, order) => {
          const orderTokenId = order.tokenID || order.tokenId || order.asset;
          if (!orderTokenId) return sum;
          const tokenPrice = orderTokenId === yesPrice.tokenId ? yesPrice : noPrice;
          const orderPrice = order.price || order.limitPrice || order.orderPrice;
          const orderSize = order.size || order.amount || order.quantity;
          if (orderPrice && orderSize) {
            return sum + orderPrice * orderSize;
          } else if (orderSize) {
            return sum + tokenPrice.askPrice * orderSize;
          }
          return sum + tokenPrice.askPrice * 10;
        }, 0).toFixed(2),
        cycleOrdersCost: ordersSubmittedInCycle.reduce((sum, o) => sum + o.price * o.size, 0).toFixed(2),
        currentSpent: totalSpent.toFixed(2),
        orderCost: orderCost.toFixed(2),
        newTotal: newTotal.toFixed(2),
        budgetLimit: this.config.maxBudgetPerPool,
        tokenId: decision.tokenId,
      });
      return false;
    }

    return true;
  }

  /**
   * Record a trade for CSV logging
   */
  private recordTrade(trade: TradeRecord): void {
    this.trades.push(trade);
    // Write trade immediately to CSV (append mode)
    this.writeTradeToCSV(trade);
  }

  /**
   * Write a single trade to CSV file (append mode)
   */
  private writeTradeToCSV(trade: TradeRecord): void {
    if (!this.yesTokenId || !this.noTokenId) {
      return;
    }

    const defaultFile = `logs/bot-orders-history-${this.config.tradingStrategy}.csv`;
    const ordersFile = process.env.BOT_ORDERS_FILE || defaultFile;
    const dir = path.dirname(ordersFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const side = trade.tokenId === this.yesTokenId ? "YES" : "NO";
    
    // Calculate cumulative stats
    let yesQty = 0;
    let yesCost = 0;
    let noQty = 0;
    let noCost = 0;
    let totalSpent = 0;

    // Calculate cumulative values up to this trade
    for (const t of this.trades) {
      const tSide = t.tokenId === this.yesTokenId ? "YES" : "NO";
      const isBuy = t.action === "BUY_YES" || t.action === "BUY_NO";
      
      if (tSide === "YES" && isBuy && t.status === "FILLED") {
        yesQty += t.filledSize || t.size;
        yesCost += (t.filledPrice || t.price) * (t.filledSize || t.size);
        totalSpent += (t.filledPrice || t.price) * (t.filledSize || t.size);
      } else if (tSide === "NO" && isBuy && t.status === "FILLED") {
        noQty += t.filledSize || t.size;
        noCost += (t.filledPrice || t.price) * (t.filledSize || t.size);
        totalSpent += (t.filledPrice || t.price) * (t.filledSize || t.size);
      }
    }

    // If this trade is filled, include it in calculations
    if (trade.status === "FILLED") {
      const isBuy = trade.action === "BUY_YES" || trade.action === "BUY_NO";
      if (isBuy) {
        if (side === "YES") {
          yesQty += trade.filledSize || trade.size;
          yesCost += (trade.filledPrice || trade.price) * (trade.filledSize || trade.size);
          totalSpent += (trade.filledPrice || trade.price) * (trade.filledSize || trade.size);
        } else {
          noQty += trade.filledSize || trade.size;
          noCost += (trade.filledPrice || trade.price) * (trade.filledSize || trade.size);
          totalSpent += (trade.filledPrice || trade.price) * (trade.filledSize || trade.size);
        }
      }
    }

    const sideQty = side === "YES" ? yesQty : noQty;
    const sideCost = side === "YES" ? yesCost : noCost;
    const avgSidePrice = sideQty > 0 ? sideCost / sideQty : 0;

    const header =
      "timestamp,cycle,action,side,price,size,cost,cum_side_qty,avg_side_price,total_spent,orderId,status,filledPrice,filledSize,failureReason,reason\n";

    const line = [
      trade.timestamp.toISOString(),
      trade.cycle,
      trade.action,
      side,
      trade.price.toFixed(4),
      trade.size.toFixed(4),
      trade.cost.toFixed(4),
      sideQty.toFixed(4),
      avgSidePrice.toFixed(4),
      totalSpent.toFixed(4),
      trade.orderId || "",
      trade.status,
      trade.filledPrice?.toFixed(4) || "",
      trade.filledSize?.toFixed(4) || "",
      trade.failureReason || "",
      `"${trade.reason.replace(/"/g, '""')}"`, // Escape quotes in CSV
    ].join(",");

    if (!fs.existsSync(ordersFile)) {
      fs.writeFileSync(ordersFile, header + line + "\n", "utf8");
    } else {
      fs.appendFileSync(ordersFile, line + "\n", "utf8");
    }
  }

  /**
   * Write summary CSV when bot shuts down or periodically
   * @param positions Optional current positions for accurate PnL calculation
   * @param yesPrice Optional current YES price for accurate PnL calculation
   * @param noPrice Optional current NO price for accurate PnL calculation
   */
  private writeSummaryCSV(positions?: any[], yesPrice?: any, noPrice?: any): void {
    if (!this.botStartTime || !this.currentMarket) {
      return;
    }

    const defaultFile = `logs/bot-summary-history-${this.config.tradingStrategy}.csv`;
    const summaryFile = process.env.BOT_SUMMARY_FILE || defaultFile;
    const dir = path.dirname(summaryFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const endTime = new Date();
    const market = this.currentMarket.question?.replace(/,/g, " ") || "N/A";

    // Calculate statistics from trades
    const filledTrades = this.trades.filter((t) => t.status === "FILLED");
    const failedTrades = this.trades.filter((t) => t.status === "FAILED");
    const totalOrdersSubmitted = this.trades.length;
    const totalOrdersFilled = filledTrades.length;
    const totalOrdersFailed = failedTrades.length;
    const totalTrades = filledTrades.length;

    // Calculate total spent from filled trades
    let totalSpent = 0;
    let yesSize = 0;
    let noSize = 0;
    let yesCost = 0;
    let noCost = 0;

    for (const trade of filledTrades) {
      const isBuy = trade.action === "BUY_YES" || trade.action === "BUY_NO";
      if (isBuy) {
        const filledPrice = trade.filledPrice || trade.price;
        const filledSize = trade.filledSize || trade.size;
        const cost = filledPrice * filledSize;
        totalSpent += cost;

        if (trade.tokenId === this.yesTokenId) {
          yesSize += filledSize;
          yesCost += cost;
        } else if (trade.tokenId === this.noTokenId) {
          noSize += filledSize;
          noCost += cost;
        }
      }
    }

    // Calculate current value using actual positions and market prices if available
    let currentValue = yesCost + noCost; // Fallback to cost basis
    if (positions && yesPrice && noPrice) {
      currentValue = 0;
      for (const pos of positions) {
        const tokenPrice = pos.asset === this.yesTokenId ? yesPrice : noPrice;
        // Use mid price as estimate of current value
        currentValue += pos.size * tokenPrice.midPrice;
      }
    }

    // Calculate PnL
    const pnl = currentValue - totalSpent;
    const pnlPercent = totalSpent > 0 ? (pnl / totalSpent) * 100 : 0;

    // Calculate ratios
    const totalSize = yesSize + noSize;
    let balanceRatio = 0;
    let asymRatio = 0;
    if (totalSize > 0 && Math.max(yesSize, noSize) > 0) {
      balanceRatio = Math.min(yesSize, noSize) / Math.max(yesSize, noSize);
      asymRatio = Math.max(yesSize, noSize) / totalSize;
    }

    // Calculate pair cost from average prices
    const yesAvgPrice = yesSize > 0 ? yesCost / yesSize : 0;
    const noAvgPrice = noSize > 0 ? noCost / noSize : 0;
    const pairCost = yesAvgPrice > 0 && noAvgPrice > 0 ? yesAvgPrice + noAvgPrice : 0;

    const budgetLimit = this.config.maxBudgetPerPool || 0;
    const budgetUsed = totalSpent;
    const budgetRemaining = Math.max(0, budgetLimit - budgetUsed);

    const header =
      "run_start,run_end,strategy,market,total_cycles,total_orders_submitted,total_orders_filled,total_orders_failed,total_trades,total_spent,budget_limit,budget_used,budget_remaining,current_value,pnl,pnl_percent,yes_size,no_size,yes_usd,no_usd,pair_cost,balance_ratio,asym_ratio\n";

    const line = [
      this.botStartTime.toISOString(),
      endTime.toISOString(),
      this.config.tradingStrategy,
      `"${market}"`,
      this.cycleCount,
      totalOrdersSubmitted,
      totalOrdersFilled,
      totalOrdersFailed,
      totalTrades,
      totalSpent.toFixed(4),
      budgetLimit.toFixed(2),
      budgetUsed.toFixed(2),
      budgetRemaining.toFixed(2),
      currentValue.toFixed(4),
      pnl.toFixed(4),
      pnlPercent.toFixed(4),
      yesSize.toFixed(4),
      noSize.toFixed(4),
      yesCost.toFixed(4),
      noCost.toFixed(4),
      pairCost.toFixed(4),
      balanceRatio.toFixed(4),
      asymRatio.toFixed(4),
    ].join(",");

    if (!fs.existsSync(summaryFile)) {
      fs.writeFileSync(summaryFile, header + line + "\n", "utf8");
    } else {
      fs.appendFileSync(summaryFile, line + "\n", "utf8");
    }

    this.logger.info("Bot summary written to CSV", {
      file: summaryFile,
      pnl: pnl.toFixed(4),
      pnlPercent: pnlPercent.toFixed(4),
      totalTrades,
    });
  }

  /**
   * Update trade status based on positions (check if orders were filled)
   * This should be called periodically to update trade records
   */
  private async updateTradeStatuses(positions: any[], yesPrice: any, noPrice: any): Promise<void> {
    // This is a simplified version - in production, you'd want to track order fills more accurately
    // For now, we'll update trades that are SUBMITTED but have corresponding positions
    for (const trade of this.trades) {
      if (trade.status === "SUBMITTED" && trade.orderId) {
        const position = positions.find((p) => p.asset === trade.tokenId);
        const isBuy = trade.action === "BUY_YES" || trade.action === "BUY_NO";
        
        if (isBuy && position && position.size > 0) {
          // Order likely filled - update status
          // Note: This is a heuristic - ideally you'd check order status from exchange
          const tokenPrice = trade.tokenId === yesPrice.tokenId ? yesPrice : noPrice;
          trade.status = "FILLED";
          trade.filledPrice = trade.price; // Use order price as estimate
          trade.filledSize = trade.size; // Use order size as estimate
        }
      }
    }
  }

  async shutdown() {
    this.logger.info("Shutting down bot...");
    this.stop();
    
    // Write summary CSV on shutdown (try to get current positions and prices for accurate PnL)
    try {
      if (this.clobClient && this.yesTokenId && this.noTokenId) {
        const walletAddress = this.clobClient.orderBuilder.funderAddress;
        const positions = await getUserPositions(walletAddress, this.logger);
        const [yesPrice, noPrice] = await Promise.all([
          getTokenPrice(this.clobClient, this.yesTokenId, this.logger),
          getTokenPrice(this.clobClient, this.noTokenId, this.logger),
        ]);
        this.writeSummaryCSV(positions, yesPrice, noPrice);
      } else {
        this.writeSummaryCSV();
      }
    } catch (error) {
      this.logger.error("Error writing summary CSV on shutdown", { error });
      // Still write summary without current prices
      this.writeSummaryCSV();
    }
    
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
