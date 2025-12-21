import { TradingStrategy, TradingDecision, StrategyContext } from "./base";
import { TokenPrice, Position } from "../utils/marketData";

/**
 * Nuoiem Strategy (USD-Based)
 *
 * This strategy uses USD-based allocations instead of fixed share counts for better flexibility.
 * Budget is configurable via maxBudgetPerPool (default $100).
 *
 * Entry:
 * - Identify higher leg (price ≥0.52): limit buy $3-9 USD higher at ≤0.57 (small probe, ~5-10% of budget).
 *   (ladder @current -0.01/-0.03). projected avg_higher <0.60 or skip.
 * - Hedge lower: anytime lower <0.51 and sim new_pair ≤0.95 and new_min(USD_value) > total_cost*1.02
 *   (ladder $20-40 USD @current-0.02/-0.05; match ~70% higher USD value).
 * - Avg-down higher leg: If dips ≥2.5¢ from avg, add $15-40 USD ladder (~15-40% of budget).
 * - Repeat check every 5s if pair >0.95, add more to both legs (dip ≥2.5¢ below leg avg) to lower the pair_cost.
 *
 * Flow:
 * - Prioritize higher wobbles, then lower opportunities. target pair ≤0.95; asym 0.60-0.75; balance ≥0.75.
 * - Before any add: sim new_pair_cost < current and new_balance ≥0.70 and new_asym ≤0.75.
 * - Unsafe pause: If pair_cost >0.95 after any add (checked post-fill), pause all further adds
 *
 * Reversal Trigger (after the first 2 minutes, check every 1s, ≥6min Left):
 * - If lower_price ≥ higher_price +0.08 and balance_ratio <0.80: Add 25-40% of lower USD value.
 * - Execute only if new_pair ≤0.95 and new_min(USD_value) > total_cost*1.02 and new_asym ≤0.75.
 *
 * Lock/Exit (9-15min):
 * - Hold to settlement If pair_cost ≤0.95 and balance_ratio ≥0.75 (min(qty) covers ≥75% exposure, asym ≤0.75), full hold.
 */
export class NuoiemStrategy extends TradingStrategy {
  name = "nuoiem";
  description =
    "Nuoiem strategy with entry, hedge, avg-down, reversal trigger, and lock/exit conditions";

  // Track entry prices with sizes for weighted averages (only successful orders)
  private higherEntries: Array<{ price: number; size: number }> = [];
  private lowerEntries: Array<{ price: number; size: number }> = [];
  private higherLeg: "YES" | "NO" | null = null;
  private lastReversalCheck: number = 0;
  private reversalOrdersPlaced: number = 0;
  private lastPairCheck: number = 0; // For 5s repeat check
  private isPaused: boolean = false; // Unsafe pause flag
  private avgDownOrdersPlaced: number = 0; // Track avg-down ladder orders
  private repeatAddsHigherCount: number = 0; // Track repeat adds to higher leg
  private repeatAddsLowerCount: number = 0; // Track repeat adds to lower leg
  private currentActiveOrders: Array<{ tokenID?: string; tokenId?: string; asset?: string; price?: number; size?: number; limitPrice?: number; orderPrice?: number; amount?: number; quantity?: number }> = []; // Track active orders for budget calculation

  reset(): void {
    this.higherEntries = [];
    this.lowerEntries = [];
    this.higherLeg = null;
    this.lastReversalCheck = 0;
    this.reversalOrdersPlaced = 0;
    this.lastPairCheck = 0;
    this.isPaused = false;
    this.avgDownOrdersPlaced = 0;
    this.repeatAddsHigherCount = 0;
    this.repeatAddsLowerCount = 0;
  }

  execute(context: StrategyContext): TradingDecision | null {
    const { yesTokenPrice, noTokenPrice, positions, config, timeUntilEnd, activeOrders } =
      context;

    if (!yesTokenPrice || !noTokenPrice) {
      return null;
    }

    // Store active orders for budget calculations in helper functions
    this.currentActiveOrders = activeOrders || [];

    // Determine which leg is higher
    const yesIsHigher = yesTokenPrice.askPrice >= noTokenPrice.askPrice;
    const higherPrice = yesIsHigher
      ? yesTokenPrice.askPrice
      : noTokenPrice.askPrice;
    const lowerPrice = yesIsHigher
      ? noTokenPrice.askPrice
      : yesTokenPrice.askPrice;
    const higherTokenId = yesIsHigher
      ? yesTokenPrice.tokenId
      : noTokenPrice.tokenId;
    const lowerTokenId = yesIsHigher
      ? noTokenPrice.tokenId
      : yesTokenPrice.tokenId;

    // Check for active orders to avoid duplicate decisions
    const hasActiveOrderForHigher = activeOrders?.some((order: any) => {
      const orderTokenId = order.tokenID || order.tokenId || order.asset;
      return orderTokenId === higherTokenId;
    }) || false;
    
    const hasActiveOrderForLower = activeOrders?.some((order: any) => {
      const orderTokenId = order.tokenID || order.tokenId || order.asset;
      return orderTokenId === lowerTokenId;
    }) || false;

    // Initialize higher leg tracking
    if (this.higherLeg === null && higherPrice >= 0.52) {
      this.higherLeg = yesIsHigher ? "YES" : "NO";
    }

    // Current position stats
    const higherPosition = positions.find((p) => p.asset === higherTokenId);
    const lowerPosition = positions.find((p) => p.asset === lowerTokenId);
    const higherSize = higherPosition?.size || 0;
    const lowerSize = lowerPosition?.size || 0;

    // Sync entries with actual positions (only track successful orders)
    this.syncEntriesWithPositions(
      higherSize,
      lowerSize,
      higherPosition,
      lowerPosition,
      higherPrice,
      lowerPrice
    );

    // Weighted averages from entries
    const avgHigher = this.calculateWeightedAverage(this.higherEntries);
    const avgLower = this.calculateWeightedAverage(this.lowerEntries);

    // Use current prices if no entries yet
    const effectiveAvgHigher = avgHigher > 0 ? avgHigher : higherPrice;
    const effectiveAvgLower = avgLower > 0 ? avgLower : lowerPrice;

    // Metrics
    const pairCost = effectiveAvgHigher + effectiveAvgLower;
    const totalSize = higherSize + lowerSize;
    const asymRatio =
      totalSize > 0 ? Math.max(higherSize, lowerSize) / totalSize : 0;
    const balanceRatio =
      totalSize > 0 && Math.max(higherSize, lowerSize) > 0
        ? Math.min(higherSize, lowerSize) / Math.max(higherSize, lowerSize)
        : 0;

    // Time metrics
    const timeUntilEndMs = timeUntilEnd || 0;
    const minutesRemaining = timeUntilEndMs / (60 * 1000);
    // For 15-minute markets: if 13 minutes remaining, 2 minutes have passed
    // Reversal trigger: after 2 minutes (13 min remaining) until 6 minutes remaining

    // When only one side is open, there is no completed hedge yet.
    const currentPairCost = higherSize > 0 && lowerSize > 0 ? pairCost : 0;
    
    // Calculate current market pair cost (based on current prices, not entry prices)
    // This allows recovery when market conditions improve even if entry was poor
    const currentMarketPairCost = higherPrice + lowerPrice;

    // Check unsafe pause condition: if pair_cost >0.95 after any add, pause
    // Use slightly higher threshold (0.96) to avoid premature pausing
    const pauseThreshold = 0.96;
    if (currentPairCost > pauseThreshold) {
      this.isPaused = true;
    }

    // Market-based recovery: Allow recovery trades when current market pair cost < 0.95
    // even if entry-based pair cost > 0.96. This enables recovery when market conditions improve.
    const marketRecoveryThreshold = 0.95;
    const allowMarketRecovery = this.isPaused && currentMarketPairCost < marketRecoveryThreshold;

    // If paused and pair cost is still above threshold, check for market recovery
    if (this.isPaused && currentPairCost > pauseThreshold) {
      // Allow recovery if market conditions improved
      if (!allowMarketRecovery) {
        // Still allow lock/exit check
        if (minutesRemaining >= 9 && minutesRemaining <= 15) {
          const lockDecision = this.lockExitPhase(
            pairCost,
            balanceRatio,
            asymRatio,
            config
          );
          if (lockDecision) {
            return lockDecision;
          }
        }
        return null;
      }
      // Market recovery allowed - continue with trading logic below
    }

    // If pair cost improved to acceptable level, resume
    if (this.isPaused && currentPairCost <= 0.95) {
      this.isPaused = false;
    }
    
    // If market recovery is active, temporarily allow trading
    // (will be checked again in individual decision functions)

    // Lock/Exit (9-15min) - check first
    if (minutesRemaining >= 9 && minutesRemaining <= 15) {
      const lockDecision = this.lockExitPhase(
        pairCost,
        balanceRatio,
        asymRatio,
        config
      );
      if (lockDecision) {
        return lockDecision;
      }
    }

    // Reversal Trigger (after first 2 minutes, check every 1s, ≥6min left)
    // For 15-min market: after 2 min = 13 min remaining, check until 6 min remaining
    // So check when: 13 >= minutesRemaining >= 6
    if (minutesRemaining <= 13 && minutesRemaining >= 6) {
      const now = Date.now();
      if (now - this.lastReversalCheck >= 1000) {
        this.lastReversalCheck = now;
        const reversalDecision = this.checkReversalTrigger(
          yesTokenPrice,
          noTokenPrice,
          higherTokenId,
          lowerTokenId,
          higherPrice,
          lowerPrice,
          higherSize,
          lowerSize,
          effectiveAvgHigher,
          effectiveAvgLower,
          pairCost,
          balanceRatio,
          asymRatio,
          yesIsHigher,
          currentPairCost,
          config
        );
        if (reversalDecision) {
          return reversalDecision;
        }
      }
    }

    // Repeat check every 5s if pair >0.95, add more to both legs (dip ≥2.5¢ below leg avg)
    // Also allow if market recovery is active (currentMarketPairCost < 0.95)
    const now = Date.now();
    const allowRepeatCheck = (currentPairCost > 0.95 || allowMarketRecovery) && now - this.lastPairCheck >= 5000;
    if (allowRepeatCheck) {
      this.lastPairCheck = now;
      const dipThresholdRepeat = 0.025; // 2.5¢ - as per strategy specification
      const emergencyDipThresholdRepeat = 0.015; // 1.5¢ for emergency recovery
      // Use relaxed threshold for market recovery
      const effectiveDipThresholdRepeat = allowMarketRecovery ? emergencyDipThresholdRepeat : dipThresholdRepeat;
      // Use market pair cost for validation in recovery mode
      const effectiveCurrentPairCostForRepeat = allowMarketRecovery ? currentMarketPairCost : currentPairCost;

      // Check if we can add to higher leg (dip ≥effectiveDipThresholdRepeat)
      // Skip if there's already an active order for higher token
      if (avgHigher > 0 && higherSize > 0 && !hasActiveOrderForHigher && higherPrice <= avgHigher - effectiveDipThresholdRepeat) {
        const addUSD = this.computeHigherAddUSD(higherPrice, avgHigher, config);
        if (addUSD > 0) {
          // Ladder offsets: -0.01, -0.02 for repeat adds
          const priceOffsets = [-0.01, -0.02];
          const offset =
            priceOffsets[this.repeatAddsHigherCount] ??
            priceOffsets[priceOffsets.length - 1];
          const limitPrice = Math.max(0.01, higherPrice + offset);
          const actualPrice =
            this.repeatAddsHigherCount === 0 ? higherPrice : limitPrice;

          // Convert USD to shares
          const addSize = this.usdToShares(addUSD, actualPrice);
          if (addSize > 0) {
            const decision = this.simulateAdd(
              "HIGHER",
              addSize,
              actualPrice,
              higherSize,
              lowerSize,
              effectiveAvgHigher,
              effectiveAvgLower,
              effectiveCurrentPairCostForRepeat,
              0.95,
              0.7,
              0.75
            );

            if (decision) {
              this.repeatAddsHigherCount++;
              return {
                action: yesIsHigher ? "BUY_YES" : "BUY_NO",
                tokenId: higherTokenId,
                price: actualPrice,
                size: addSize,
                reason: `Nuoiem Pair>0.95: higher dip ${(
                  (avgHigher - higherPrice) *
                  100
                ).toFixed(2)}¢, add $${addUSD.toFixed(2)} (${addSize} shares) @ ${actualPrice.toFixed(
                  4
                )} (ladder ${this.repeatAddsHigherCount})`,
              };
            }
          }
        }
      }

      // Check if we can add to lower leg (dip ≥effectiveDipThresholdRepeat)
      // Skip if there's already an active order for lower token
      if (avgLower > 0 && lowerSize > 0 && !hasActiveOrderForLower && lowerPrice <= avgLower - effectiveDipThresholdRepeat) {
        const addUSD = this.computeLowerAddUSDForPair(
          higherSize,
          lowerSize,
          effectiveAvgHigher,
          lowerPrice,
          config
        );
        if (addUSD > 0) {
          // Ladder offsets: -0.02, -0.03 for repeat adds to lower
          const priceOffsets = [-0.02, -0.03];
          const offset =
            priceOffsets[this.repeatAddsLowerCount] ??
            priceOffsets[priceOffsets.length - 1];
          const limitPrice = Math.max(0.01, lowerPrice + offset);
          const actualPrice =
            this.repeatAddsLowerCount === 0 ? lowerPrice : limitPrice;

          // Convert USD to shares
          const addSize = this.usdToShares(addUSD, actualPrice);
          if (addSize > 0) {
            const decision = this.simulateAdd(
              "LOWER",
              addSize,
              actualPrice,
              higherSize,
              lowerSize,
              effectiveAvgHigher,
              effectiveAvgLower,
              effectiveCurrentPairCostForRepeat,
              0.95,
              0.7,
              0.75
            );

            if (decision) {
              this.repeatAddsLowerCount++;
              return {
                action: yesIsHigher ? "BUY_NO" : "BUY_YES",
                tokenId: lowerTokenId,
                price: actualPrice,
                size: addSize,
                reason: `Nuoiem Pair>0.95: lower dip ${(
                  (avgLower - lowerPrice) *
                  100
                ).toFixed(2)}¢, add $${addUSD.toFixed(2)} (${addSize} shares) @ ${actualPrice.toFixed(
                  4
                )} (ladder ${this.repeatAddsLowerCount})`,
              };
            }
          }
        }
      }
    }

    // All other actions available anytime (no phase restrictions)

    // 1. Entry: Identify higher leg and probe (if no higher position yet)
    // Skip if there's already an active order for higher token
    // Count both filled entries AND active orders to prevent making too many entry orders
    const filledEntryCount = this.higherEntries.length;
    const activeEntryOrders = this.currentActiveOrders.filter((order: any) => {
      const orderTokenId = order.tokenID || order.tokenId || order.asset;
      return orderTokenId === higherTokenId;
    }).length;
    const entryOrdersCount = filledEntryCount + activeEntryOrders;
    
    if (higherSize === 0 && !hasActiveOrderForHigher && entryOrdersCount < 2) {
      const entryDecision = this.entryPhase(
        higherTokenId,
        lowerTokenId,
        higherPrice,
        lowerPrice,
        yesIsHigher,
        config,
        entryOrdersCount
      );
      if (entryDecision) {
        return entryDecision;
      }
    }

    // 2. Avg-down higher: If dips ≥2.5¢ from avg (prioritized)
    // Skip if there's already an active order for higher token
    if (avgHigher > 0 && higherSize > 0 && !hasActiveOrderForHigher) {
      const avgDownDecision = this.avgDownHigher(
        higherTokenId,
        higherPrice,
        higherSize,
        lowerSize,
        avgHigher,
        effectiveAvgHigher,
        effectiveAvgLower,
        currentPairCost,
        currentMarketPairCost,
        yesIsHigher,
        config
      );
      if (avgDownDecision) {
        return avgDownDecision;
      }
    }

    // 3. Hedge lower: Anytime lower <0.51 (as per algorithm specification)
    // Also allow hedging if balance is off
    // For first hedge, allow even if higherSize is 0 (orders might be pending)
    // Check if we have higher entries (even if positions not updated yet)
    // Skip if there's already an active order for lower token
    const hasHigherEntries = this.higherEntries.length > 0;
    const needsHedge = lowerSize < higherSize * 0.65; // If lower is less than 65% of higher
    if (
      !hasActiveOrderForLower && // Don't hedge if there's already an active order
      lowerPrice < 0.51 &&
      (higherSize > 0 || hasHigherEntries) // Allow hedge if we have higher positions OR higher entries
    ) {
      const hedgeDecision = this.hedgeLower(
        lowerTokenId,
        lowerPrice,
        higherSize,
        lowerSize,
        effectiveAvgHigher,
        effectiveAvgLower,
        currentPairCost,
        yesIsHigher,
        config
      );
      if (hedgeDecision) {
        return hedgeDecision;
      }
    }

    return null;
  }

  /**
   * Entry / Probe (anytime) - USD-Based
   * - Identify higher leg (price ≥0.52)
   * - Allocate $3-9 USD for entry probe (~5-10% of budget)
   * - Ladder @current -0.01/-0.03
   * - Projected avg_higher < 0.60 or skip
   * - Skip if projected pair cost > 1.00
   */
  private entryPhase(
    higherTokenId: string,
    lowerTokenId: string,
    higherPrice: number,
    lowerPrice: number,
    yesIsHigher: boolean,
    config: StrategyContext["config"],
    currentEntryCount: number
  ): TradingDecision | null {
    const minHigherPrice = 0.52;
    const maxHigherPrice = 0.57;
    const maxProjectedAvg = 0.6;
    const maxProjectedPairCost = 1.00; // Skip entry if projected pair cost exceeds this

    if (higherPrice < minHigherPrice || higherPrice > maxHigherPrice) {
      return null;
    }

    // Get remaining budget
    const remainingBudget = this.getRemainingBudget(config);
    const maxBudget = this.getMaxBudgetPerPool(config);
    
    // Entry probe: 5-10% of total budget (fully percentage-based, scales with any budget)
    const entryUsdMin = maxBudget * 0.05; // 5% of budget
    const entryUsdMax = maxBudget * 0.10; // 10% of budget
    
    // Minimum viable entry: at least 2% of budget (ensures we can make meaningful trades)
    const minViableEntry = maxBudget * 0.02;
    if (remainingBudget < minViableEntry) {
      return null; // Not enough budget for entry
    }

    // Use price proximity to max (0.57) to determine allocation: closer to max = smaller allocation
    const priceRange = maxHigherPrice - minHigherPrice;
    const pricePosition = (higherPrice - minHigherPrice) / priceRange; // 0 to 1
    const entryUsdRange = entryUsdMax - entryUsdMin;
    // Closer to max price (0.57) = smaller allocation, closer to min (0.52) = larger allocation
    const entryUsd = entryUsdMin + entryUsdRange * (1 - pricePosition);
    const actualEntryUsd = Math.min(entryUsd, remainingBudget);

    // Convert USD to shares
    const probeSize = this.usdToShares(actualEntryUsd, higherPrice);
    if (probeSize <= 0) {
      return null;
    }

    // Ladder offsets: -0.01, -0.03
    const priceOffsets = [-0.01, -0.03];
    const offset =
      priceOffsets[currentEntryCount] ?? priceOffsets[priceOffsets.length - 1];
    const limitPrice = Math.max(0.01, higherPrice + offset);

    // Only place first order at current price, subsequent at ladder prices
    const actualPrice = currentEntryCount === 0 ? higherPrice : limitPrice;

    // Calculate projected average after all ladder orders (2 orders total)
    // Use USD amounts for calculation, then convert to shares
    let projectedAvg: number;
    if (currentEntryCount === 0) {
      // First order: simulate both orders using same USD allocation
      const firstOrderPrice = higherPrice;
      const secondOrderPrice = Math.max(0.01, higherPrice + priceOffsets[1]);
      const firstOrderShares = this.usdToShares(actualEntryUsd, firstOrderPrice);
      const secondOrderShares = this.usdToShares(actualEntryUsd, secondOrderPrice);
      const totalPlannedSize = firstOrderShares + secondOrderShares;
      const projectedTotalCost =
        firstOrderPrice * firstOrderShares + secondOrderPrice * secondOrderShares;
      projectedAvg =
        totalPlannedSize > 0
          ? projectedTotalCost / totalPlannedSize
          : higherPrice;
    } else {
      // Second order: use actual first order from entries
      const firstEntry = this.higherEntries[0];
      const firstOrderPrice = firstEntry.price;
      const secondOrderPrice = limitPrice;
      const secondOrderShares = probeSize; // Already calculated above
      const totalPlannedSize = firstEntry.size + secondOrderShares;
      const projectedTotalCost =
        firstOrderPrice * firstEntry.size + secondOrderPrice * secondOrderShares;
      projectedAvg =
        totalPlannedSize > 0
          ? projectedTotalCost / totalPlannedSize
          : higherPrice;
    }

    if (projectedAvg >= maxProjectedAvg) {
      return null;
    }
    
    // Entry validation: Check projected pair cost
    // Estimate projected pair cost assuming we'll hedge at current lower price
    // This is a conservative estimate to avoid entering with bad pair cost
    const projectedPairCost = projectedAvg + lowerPrice;
    if (projectedPairCost > maxProjectedPairCost) {
      return null; // Skip entry if projected pair cost would be too high
    }

    // Check budget limit (already checked above, but double-check)
    const newOrderCostUSD = actualPrice * probeSize;
    if (newOrderCostUSD > remainingBudget) {
      return null; // Skip entry if it would exceed remaining budget
    }

    return {
      action: yesIsHigher ? "BUY_YES" : "BUY_NO",
      tokenId: higherTokenId,
      price: actualPrice,
      size: probeSize,
      reason: `Nuoiem Entry: higher @ ${actualPrice.toFixed(4)} (ladder ${
        currentEntryCount + 1
      }/2), ${actualEntryUsd.toFixed(2)} USD (${probeSize} shares)`,
    };
  }

  /**
   * Avg-down higher (anytime)
   * - If dips ≥2.5¢ from avg, add 50–150 shares (as per algorithm specification)
   * - Emergency recovery: If paused and market pair cost < 0.95, allow recovery even with relaxed dip threshold
   */
  private avgDownHigher(
    higherTokenId: string,
    higherPrice: number,
    higherSize: number,
    lowerSize: number,
    avgHigher: number,
    effectiveAvgHigher: number,
    effectiveAvgLower: number,
    currentPairCost: number,
    currentMarketPairCost: number,
    yesIsHigher: boolean,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const dipThreshold = 0.025; // 2.5¢ (as per strategy specification)
    const emergencyDipThreshold = 0.015; // 1.5¢ for emergency recovery
    const targetPairCost = 0.95;
    const minBalanceRatio = 0.7;
    const maxAsymRatio = 0.75;
    
    // Emergency recovery: If paused and market conditions improved, use relaxed threshold
    const isEmergencyRecovery = this.isPaused && currentMarketPairCost < targetPairCost;
    const effectiveDipThreshold = isEmergencyRecovery ? emergencyDipThreshold : dipThreshold;

    // Allow avg-down if dip is >= effectiveDipThreshold from average
    if (avgHigher > 0 && higherPrice <= avgHigher - effectiveDipThreshold) {
      // Calculate USD allocation for avg-down
      const addUSD = this.computeHigherAddUSD(higherPrice, avgHigher, config);
      if (addUSD <= 0) {
        return null;
      }

      // Ladder offsets: -0.01, -0.02 for avg-down
      const priceOffsets = [-0.01, -0.02];
      const offset =
        priceOffsets[this.avgDownOrdersPlaced] ??
        priceOffsets[priceOffsets.length - 1];
      const limitPrice = Math.max(0.01, higherPrice + offset);

      // First order at current price, subsequent at ladder prices
      const actualPrice =
        this.avgDownOrdersPlaced === 0 ? higherPrice : limitPrice;

      // Convert USD to shares
      const addSize = this.usdToShares(addUSD, actualPrice);
      if (addSize <= 0) {
        return null;
      }

      // For emergency recovery, use market pair cost for validation
      const effectiveCurrentPairCost = isEmergencyRecovery ? currentMarketPairCost : currentPairCost;
      
      const decision = this.simulateAdd(
        "HIGHER",
        addSize,
        actualPrice,
        higherSize,
        lowerSize,
        effectiveAvgHigher,
        effectiveAvgLower,
        effectiveCurrentPairCost,
        targetPairCost,
        minBalanceRatio,
        maxAsymRatio
      );

      if (decision) {
        this.avgDownOrdersPlaced++;
        return {
          action: yesIsHigher ? "BUY_YES" : "BUY_NO",
          tokenId: higherTokenId,
          price: actualPrice,
          size: addSize,
          reason: `Nuoiem Avg-Down: higher dip ${(
            (avgHigher - higherPrice) *
            100
          ).toFixed(2)}¢, add $${addUSD.toFixed(2)} (${addSize} shares) @ ${actualPrice.toFixed(
            4
          )} (ladder ${this.avgDownOrdersPlaced})`,
        };
      }
    }

    return null;
  }

  /**
   * Hedge lower (anytime) - USD-Based
   * - Anytime lower <0.51 (as per algorithm specification)
   * - Allocate $20-40 USD @current-0.02/-0.05, match ~70% higher USD value
   */
  private hedgeLower(
    lowerTokenId: string,
    lowerPrice: number,
    higherSize: number,
    lowerSize: number,
    effectiveAvgHigher: number,
    effectiveAvgLower: number,
    currentPairCost: number,
    yesIsHigher: boolean,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const targetPairCost = 0.95;
    const minBalanceRatio = 0.7;
    const maxAsymRatio = 0.75;

    // Calculate USD allocation for hedge
    // For first hedge, use current market price for higherAvgPrice if we don't have entries yet
    const higherAvgPriceForHedge = effectiveAvgHigher > 0 ? effectiveAvgHigher : (higherSize > 0 ? this.calculateWeightedAverage(this.higherEntries) : 0);
    // If still 0, use a conservative estimate based on entry price range (0.52-0.57)
    const fallbackHigherAvg = higherAvgPriceForHedge > 0 ? higherAvgPriceForHedge : 0.55;
    
    const addUSD = this.computeLowerAddUSD(
      higherSize,
      lowerSize,
      higherAvgPriceForHedge > 0 ? higherAvgPriceForHedge : fallbackHigherAvg,
      lowerPrice,
      config
    );
    if (addUSD <= 0) {
      return null;
    }

    // Ladder offsets: -0.02, -0.05
    const priceOffsets = [-0.02, -0.05];
    // Count both filled entries AND active orders to prevent making too many hedge orders
    const filledHedgeCount = this.lowerEntries.length;
    const activeHedgeOrders = this.currentActiveOrders.filter((order: any) => {
      const orderTokenId = order.tokenID || order.tokenId || order.asset;
      return orderTokenId === lowerTokenId;
    }).length;
    const hedgeOrdersCount = filledHedgeCount + activeHedgeOrders;
    
    // Limit to 2 hedge orders max (as per algorithm: ladder with 2 price offsets)
    if (hedgeOrdersCount >= 2) {
      return null; // Already have 2 hedge orders (filled or pending)
    }
    
    const offset =
      priceOffsets[hedgeOrdersCount] ?? priceOffsets[priceOffsets.length - 1];
    const limitPrice = Math.max(0.01, lowerPrice + offset);

    // Only place first order at current price, subsequent at ladder prices
    const actualPrice = hedgeOrdersCount === 0 ? lowerPrice : limitPrice;

    // Convert USD to shares
    const addSize = this.usdToShares(addUSD, actualPrice);
    if (addSize <= 0) {
      return null;
    }

    // For first hedge (when lowerSize === 0), relax pair cost constraint
    // The algorithm says "anytime lower <0.51", so we should allow first hedge
    // even if projected pair cost is slightly above 0.95
    const isFirstHedge = lowerSize === 0;
    let effectiveCurrentPairCost = currentPairCost;
    let relaxedTargetPairCost = targetPairCost;
    let effectiveAvgLowerForSim = effectiveAvgLower;
    
    if (isFirstHedge) {
      // For first hedge, allow pair cost up to 0.98 (relaxed from 0.95)
      // This allows hedging when lower < 0.51 even if entry average + market price > 0.95
      // The algorithm prioritizes "anytime lower <0.51" over strict pair cost
      effectiveCurrentPairCost = 0; // Reset to allow hedge
      relaxedTargetPairCost = 0.98; // Relaxed target for first hedge
      // Use current market price for lower in simulation (not entry average)
      effectiveAvgLowerForSim = lowerPrice;
    }

    const decision = this.simulateAdd(
      "LOWER",
      addSize,
      actualPrice,
      higherSize,
      lowerSize,
      effectiveAvgHigher,
      effectiveAvgLowerForSim,
      effectiveCurrentPairCost,
      relaxedTargetPairCost,
      minBalanceRatio,
      maxAsymRatio,
      true // apply extra hedge constraints
    );

    if (decision) {
      return {
        action: yesIsHigher ? "BUY_NO" : "BUY_YES",
        tokenId: lowerTokenId,
        price: actualPrice,
        size: addSize,
        reason: `Nuoiem Hedge: lower @ ${actualPrice.toFixed(
          4
        )}, add $${addUSD.toFixed(2)} (${addSize} shares)`,
      };
    }

    return null;
  }

  /**
   * Lock / Exit (9-15min)
   * - If pair_cost ≤ 0.95 and balance ≥ 0.75 and asym ≤ 0.75 → HOLD to settlement
   */
  private lockExitPhase(
    pairCost: number,
    balanceRatio: number,
    asymRatio: number,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const targetPairCost = 0.95;
    const minBalanceRatio = 0.75;
    const minAsymRatio = 0.6;
    const maxAsymRatio = 0.75;

    // If fully hedged and cost profile is good, just hold to settlement
    if (
      pairCost <= targetPairCost &&
      balanceRatio >= minBalanceRatio &&
      asymRatio >= minAsymRatio &&
      asymRatio <= maxAsymRatio
    ) {
      return {
        action: "HOLD",
        tokenId: "",
        price: 0,
        size: 0,
        reason: `Nuoiem Lock: pair_cost=${pairCost.toFixed(
          4
        )} ≤ ${targetPairCost}, balance=${balanceRatio.toFixed(
          2
        )}, asym=${asymRatio.toFixed(2)}`,
      };
    }

    // If conditions not met, return null to allow other actions
    return null;
  }

  /**
   * Reversal Trigger (USD-Based):
   * - If lower_price ≥ higher_price + 0.08 and balance_ratio < 0.80:
   *   - Add 25–40% of current lower USD value
   */
  private checkReversalTrigger(
    yesTokenPrice: TokenPrice,
    noTokenPrice: TokenPrice,
    higherTokenId: string,
    lowerTokenId: string,
    higherPrice: number,
    lowerPrice: number,
    higherSize: number,
    lowerSize: number,
    effectiveAvgHigher: number,
    effectiveAvgLower: number,
    pairCost: number,
    balanceRatio: number,
    asymRatio: number,
    yesIsHigher: boolean,
    currentPairCost: number,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const priceDiffThreshold = 0.08;
    const balanceRatioThreshold = 0.8;
    const buyRatioMin = 0.25;
    const buyRatioMax = 0.4;
    const targetPairCost = 0.95;
    const minQtyMultiplier = 1.02;
    const maxAsymRatio = 0.75;

    const priceDiff = lowerPrice - higherPrice;
    if (priceDiff < priceDiffThreshold) {
      return null;
    }

    if (balanceRatio >= balanceRatioThreshold) {
      return null;
    }

    if (lowerSize === 0) {
      return null;
    }

    if (this.reversalOrdersPlaced >= 3) {
      return null;
    }

    // Calculate current lower leg USD value
    const currentLowerUSDValue = this.sharesToUSD(lowerSize, effectiveAvgLower);
    
    // Calculate buy ratio (25-40% of lower USD value)
    const buyRatio = Math.min(
      buyRatioMax,
      buyRatioMin + this.reversalOrdersPlaced * 0.05
    );
    const targetBuyUSD = currentLowerUSDValue * buyRatio;
    
    // Ensure minimum 5% of budget allocation (scales with budget size)
    const remainingBudget = this.getRemainingBudget(config);
    const maxBudget = this.getMaxBudgetPerPool(config);
    const minAllocation = maxBudget * 0.05; // 5% of budget minimum
    const addUSD = Math.max(minAllocation, Math.min(targetBuyUSD, remainingBudget));
    
    if (addUSD <= 0 || addUSD > remainingBudget) {
      return null;
    }

    // Ladder offsets: -0.02, -0.03, -0.05
    const priceOffsets = [-0.02, -0.03, -0.05];
    const offset =
      priceOffsets[this.reversalOrdersPlaced] ??
      priceOffsets[priceOffsets.length - 1];
    const limitPrice = Math.max(0.01, lowerPrice + offset);

    // Convert USD to shares
    const roundedSize = this.usdToShares(addUSD, limitPrice);
    if (roundedSize <= 0) {
      return null;
    }

    // Simulate new lower average
    const newLowerSize = lowerSize + roundedSize;
    const newLowerCost =
      effectiveAvgLower * lowerSize + limitPrice * roundedSize;
    const newLowerAvg =
      newLowerSize > 0 ? newLowerCost / newLowerSize : effectiveAvgLower;
    const newPairCost = effectiveAvgHigher + newLowerAvg;

    const newTotalSize = higherSize + newLowerSize;
    const newAsymRatio =
      newTotalSize > 0 ? Math.max(higherSize, newLowerSize) / newTotalSize : 0;
    const newMinQty = Math.min(higherSize, newLowerSize);

    // Calculate total USD cost (what we've spent) - AFTER the add
    const totalCostUSD =
      effectiveAvgHigher * higherSize +
      effectiveAvgLower * lowerSize +
      limitPrice * roundedSize;
    
    // Calculate minimum USD value of the hedged position AFTER the add
    // Use the NEW weighted averages to calculate the value of each leg
    const newHigherValueUSD = higherSize * effectiveAvgHigher; // Higher leg unchanged
    const newLowerValueUSD = newLowerSize * newLowerAvg; // Use new average after add
    const minValueUSD = Math.min(newHigherValueUSD, newLowerValueUSD);

    if (newPairCost > targetPairCost) {
      return null;
    }

    // Ensure minimum side USD value is at least 1.02x the total USD cost
    // This ensures proper hedge coverage in USD terms, not just share counts
    if (minValueUSD <= totalCostUSD * minQtyMultiplier) {
      return null;
    }

    if (newAsymRatio > maxAsymRatio) {
      return null;
    }

    this.reversalOrdersPlaced++;

    return {
      action: yesIsHigher ? "BUY_NO" : "BUY_YES",
      tokenId: lowerTokenId,
      price: limitPrice,
      size: roundedSize,
      reason: `Nuoiem Reversal: lower ${lowerPrice.toFixed(4)} ≥ ${(
        higherPrice + priceDiffThreshold
      ).toFixed(4)}, buy $${addUSD.toFixed(2)} (${roundedSize} shares) @ ${limitPrice.toFixed(4)} (order ${
        this.reversalOrdersPlaced
      }/3)`,
    };
  }

  /**
   * Compute USD allocation for higher leg avg-down/add
   * Returns USD amount to allocate (15-40% of budget, larger when dip is larger)
   */
  private computeHigherAddUSD(
    currentPrice: number,
    avgHigher: number,
    config: StrategyContext["config"]
  ): number {
    const maxBudget = this.getMaxBudgetPerPool(config);
    const remainingBudget = this.getRemainingBudget(config);
    
    // Base allocation: 15-40% of total budget, larger when dip is larger
    const baseMinUSD = maxBudget * 0.20; // 15% of budget
    const baseMaxUSD = maxBudget * 0.40; // 40% of budget
    const dipAmount = avgHigher - currentPrice;
    if (dipAmount <= 0) return 0;

    // Scale allocation based on dip size (up to 4x multiplier)
    const dipMultiplier = Math.min(4, Math.floor(dipAmount / 0.01)); // up to 4x
    const usdRange = baseMaxUSD - baseMinUSD;
    const addUSD = Math.min(baseMaxUSD, baseMinUSD + (usdRange * dipMultiplier / 4));
    
    // Don't exceed remaining budget
    return Math.min(addUSD, remainingBudget);
  }

  /**
   * Compute USD allocation for lower leg hedge
   * Targets ~70% of higher leg USD value, with 20-40% of budget base allocation
   */
  private computeLowerAddUSD(
    higherSize: number,
    lowerSize: number,
    higherAvgPrice: number,
    lowerPrice: number,
    config: StrategyContext["config"]
  ): number {
    const remainingBudget = this.getRemainingBudget(config);
    const maxBudget = this.getMaxBudgetPerPool(config);
    
    // Base allocation: 20-40% of budget (fully percentage-based, scales with any budget)
    const baseMinUSD = maxBudget * 0.20; // 20% of budget
    const baseMaxUSD = maxBudget * 0.40; // 40% of budget
    
    // For first hedge (when higherSize might be 0 or very small due to pending orders),
    // use base allocation to ensure we can hedge
    if (higherSize === 0 || higherAvgPrice <= 0) {
      // Use base minimum allocation for first hedge
      return Math.min(baseMinUSD, remainingBudget);
    }
    
    // Calculate target: ~70% of higher leg USD value
    const higherUSDValue = this.sharesToUSD(higherSize, higherAvgPrice);
    const targetLowerUSDValue = higherUSDValue * 0.7;
    const currentLowerUSDValue = this.sharesToUSD(lowerSize, lowerPrice);
    const neededUSD = targetLowerUSDValue - currentLowerUSDValue;
    
    // CRITICAL: Cap hedge allocation at baseMaxUSD (40% of budget) to prevent overspending
    // Even if we need more to reach 70% of higher leg, we should not exceed the budget cap
    // The algorithm specifies "$20-40 USD" for hedge, which is 20-40% of a $100 budget
    // For smaller budgets, we scale proportionally but still cap at 40%
    const maxAllowedUSD = Math.min(baseMaxUSD, remainingBudget);
    
    // If we need more than the cap, use the cap (don't exceed budget limits)
    if (neededUSD > maxAllowedUSD) {
      return maxAllowedUSD;
    }
    
    // If close to target (within 5% of budget), add minimum
    const closeThreshold = maxBudget * 0.05; // 5% of budget threshold
    if (neededUSD <= closeThreshold) {
      return Math.min(baseMinUSD, remainingBudget);
    }
    
    // Otherwise, use needed amount (within base range, capped at maxAllowedUSD)
    return Math.min(Math.max(baseMinUSD, neededUSD), maxAllowedUSD);
  }

  /**
   * Compute USD allocation for lower leg in repeat check (pair >0.95)
   * Similar to avg-down: 15-40% of budget
   */
  private computeLowerAddUSDForPair(
    higherSize: number,
    lowerSize: number,
    higherAvgPrice: number,
    lowerPrice: number,
    config: StrategyContext["config"]
  ): number {
    const remainingBudget = this.getRemainingBudget(config);
    const maxBudget = this.getMaxBudgetPerPool(config);
    
    // Base allocation: 15-40% of budget (similar to avg-down)
    const baseMinUSD = maxBudget * 0.20;
    const baseMaxUSD = maxBudget * 0.40;
    
    // Calculate target: ~70% of higher leg USD value
    const higherUSDValue = this.sharesToUSD(higherSize, higherAvgPrice);
    const targetLowerUSDValue = higherUSDValue * 0.7;
    const currentLowerUSDValue = this.sharesToUSD(lowerSize, lowerPrice);
    const neededUSD = targetLowerUSDValue - currentLowerUSDValue;
    
    if (neededUSD <= 0) {
      return Math.min(baseMinUSD, remainingBudget);
    }
    
    // CRITICAL: Cap at baseMaxUSD (40% of budget) to prevent overspending in repeat checks
    const maxAllowedUSD = Math.min(baseMaxUSD, remainingBudget);
    return Math.min(Math.max(baseMinUSD, neededUSD), maxAllowedUSD);
  }

  /**
   * Simulate adding to either higher or lower leg and enforce global guards:
   * - new_pair_cost < current_pair_cost (if current_pair_cost > 0)
   * - new_balance_ratio ≥ minBalanceRatio
   * - new_asym_ratio ≤ maxAsymRatio
   * - Total cost per pool must not exceed $100
   * - If enforceHedgeConstraints:
   *   - new_pair_cost ≤ targetPairCost
   *   - new_min(USD_value) > total_cost_USD × 1.02
   */
  private simulateAdd(
    side: "HIGHER" | "LOWER",
    addSize: number,
    addPrice: number,
    higherSize: number,
    lowerSize: number,
    effectiveAvgHigher: number,
    effectiveAvgLower: number,
    currentPairCost: number,
    targetPairCost: number,
    minBalanceRatio: number,
    maxAsymRatio: number,
    enforceHedgeConstraints: boolean = false
  ): boolean {
    let newHigherSize = higherSize;
    let newLowerSize = lowerSize;
    let newHigherAvg = effectiveAvgHigher;
    let newLowerAvg = effectiveAvgLower;

    if (side === "HIGHER") {
      newHigherSize = higherSize + addSize;
      const newHigherCost =
        effectiveAvgHigher * higherSize + addPrice * addSize;
      newHigherAvg =
        newHigherSize > 0 ? newHigherCost / newHigherSize : effectiveAvgHigher;
    } else {
      newLowerSize = lowerSize + addSize;
      const newLowerCost = effectiveAvgLower * lowerSize + addPrice * addSize;
      newLowerAvg =
        newLowerSize > 0 ? newLowerCost / newLowerSize : effectiveAvgLower;
    }

    const newPairCost = newHigherAvg + newLowerAvg;
    const newTotalSize = newHigherSize + newLowerSize;
    const newAsymRatio =
      newTotalSize > 0
        ? Math.max(newHigherSize, newLowerSize) / newTotalSize
        : 0;
    const newBalanceRatio =
      newTotalSize > 0 && Math.max(newHigherSize, newLowerSize) > 0
        ? Math.min(newHigherSize, newLowerSize) /
          Math.max(newHigherSize, newLowerSize)
        : 0;

    // Enforce budget limit: Check if adding this order would exceed budget
    // Note: This check is done at the decision level, but we keep it here as a safety check
    // The actual budget check should be done before calling simulateAdd

    // Require improving pair cost: new_pair_cost < current_pair_cost
    // Exception: if current is already > target, allow new <= target even if >= current
    // Also allow small tolerance (0.01) if new is still within target (≤0.95)
    if (currentPairCost > 0) {
      if (currentPairCost <= targetPairCost) {
        // Current is good (≤0.95)
        // Allow if: (1) new improves, OR (2) new is still ≤ target and within 0.01 of current
        const tolerance = 0.01;
        const wouldExceedTarget = newPairCost > targetPairCost;
        const isWorseBeyondTolerance =
          newPairCost > currentPairCost + tolerance;

        if (wouldExceedTarget || isWorseBeyondTolerance) {
          return false;
        }
        // Allow if new ≤ target and within tolerance
      } else {
        // Current is bad (> target), allow new <= target even if >= current
        if (newPairCost >= currentPairCost && newPairCost > targetPairCost) {
          return false;
        }
      }
    }

    // Balance ratio check: allow first hedge (when lowerSize === 0) with relaxed threshold
    const isFirstHedge =
      (side === "LOWER" && lowerSize === 0) ||
      (side === "HIGHER" && higherSize === 0);
    if (!isFirstHedge && newBalanceRatio < minBalanceRatio) {
      return false;
    }

    // Enforce asym ratio range: 0.60-0.75
    const minAsymRatio = 0.6;
    if (
      newAsymRatio > maxAsymRatio ||
      (newTotalSize > 0 && newAsymRatio < minAsymRatio)
    ) {
      return false;
    }

    if (enforceHedgeConstraints) {
      if (newPairCost > targetPairCost) {
        return false;
      }

      // Calculate total USD cost (what we've spent) - AFTER the add
      const totalCostUSD =
        effectiveAvgHigher * higherSize +
        effectiveAvgLower * lowerSize +
        addPrice * addSize;
      
      // Calculate minimum USD value of the hedged position AFTER the add
      // Use the NEW weighted averages to calculate the value of each leg
      // This represents the USD value of the smaller leg, which is our hedge protection
      const newHigherValueUSD = newHigherSize * newHigherAvg; // Use new average after add
      const newLowerValueUSD = newLowerSize * newLowerAvg; // Use new average after add
      const minValueUSD = Math.min(newHigherValueUSD, newLowerValueUSD);

      // For first hedge (when one side is 0), relax the minValueUSD constraint
      // The algorithm says "anytime lower <0.51", so we should allow first hedge
      const isFirstHedge = (side === "LOWER" && lowerSize === 0) || (side === "HIGHER" && higherSize === 0);
      const minValueMultiplier = isFirstHedge ? 0.95 : 1.02; // Relaxed for first hedge

      // Ensure minimum side USD value is at least minValueMultiplier x the total USD cost
      // This ensures we have proper hedge coverage in USD terms, not just share counts
      if (minValueUSD <= totalCostUSD * minValueMultiplier) {
        return false;
      }
    }

    return true;
  }

  private calculateWeightedAverage(
    entries: Array<{ price: number; size: number }>
  ): number {
    if (entries.length === 0) return 0;
    const totalCost = entries.reduce((sum, e) => sum + e.price * e.size, 0);
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    return totalSize > 0 ? totalCost / totalSize : 0;
  }

  /**
   * Calculate total USD cost spent so far (from all successful orders)
   * This is used to enforce the budget per pool limit
   */
  private calculateTotalCostUSD(): number {
    const higherCost = this.higherEntries.reduce(
      (sum, e) => sum + e.price * e.size,
      0
    );
    const lowerCost = this.lowerEntries.reduce(
      (sum, e) => sum + e.price * e.size,
      0
    );
    return higherCost + lowerCost;
  }

  /**
   * Get the maximum budget per pool from config (defaults to $100)
   */
  private getMaxBudgetPerPool(config: StrategyContext["config"]): number {
    return config.maxBudgetPerPool ?? 100;
  }

  /**
   * Get remaining budget available for trading
   * Accounts for both filled positions (via entries) and active pending orders
   */
  private getRemainingBudget(config: StrategyContext["config"]): number {
    const maxBudget = this.getMaxBudgetPerPool(config);
    let spent = this.calculateTotalCostUSD();
    
    // Add cost of active pending orders that aren't yet reflected in entries
    // This prevents the strategy from thinking it has more budget than it actually does
    if (this.currentActiveOrders && this.currentActiveOrders.length > 0) {
      for (const order of this.currentActiveOrders) {
        const orderTokenId = order.tokenID || order.tokenId || order.asset;
        if (!orderTokenId) continue;
        
        const orderPrice = order.price || order.limitPrice || order.orderPrice || 0;
        const orderSize = order.size || order.amount || order.quantity || 0;
        
        if (orderPrice > 0 && orderSize > 0) {
          // Add cost of pending order to spent amount
          // This ensures we don't overspend by making multiple orders before positions update
          spent += orderPrice * orderSize;
        }
      }
    }
    
    return Math.max(0, maxBudget - spent);
  }

  /**
   * Convert USD amount to share count at given price
   */
  private usdToShares(usdAmount: number, price: number): number {
    if (price <= 0) return 0;
    return Math.floor(usdAmount / price);
  }

  /**
   * Convert share count to USD value at given price
   */
  private sharesToUSD(shares: number, price: number): number {
    return shares * price;
  }

  /**
   * Sync entries arrays with actual positions
   * Only track successful orders (orders that resulted in positions)
   */
  private syncEntriesWithPositions(
    higherSize: number,
    lowerSize: number,
    higherPosition: Position | undefined,
    lowerPosition: Position | undefined,
    higherPrice: number,
    lowerPrice: number
  ): void {
    // Calculate total size from entries
    const higherEntriesSize = this.higherEntries.reduce(
      (sum, e) => sum + e.size,
      0
    );
    const lowerEntriesSize = this.lowerEntries.reduce(
      (sum, e) => sum + e.size,
      0
    );

    // If position grew, add new entry (successful order)
    if (higherSize > higherEntriesSize) {
      const newSize = higherSize - higherEntriesSize;
      // Estimate price: use average of existing entries, or use current market price if available
      // Better estimate: if we have entries, use their avg; otherwise use a conservative estimate
      // Note: Ideally we'd have actual fill prices, but we estimate based on entry pattern
      const estimatedPrice =
        this.higherEntries.length > 0
          ? this.calculateWeightedAverage(this.higherEntries)
          : higherPosition && higherPosition.size > 0
          ? Math.min(0.57, Math.max(0.52, higherPrice)) // Use current price bounded by entry range
          : 0.55; // Fallback estimate
      this.higherEntries.push({ price: estimatedPrice, size: newSize });
    } else if (higherSize < higherEntriesSize) {
      // Position decreased (sold/redeemed) - rebuild entries to match
      if (higherSize > 0) {
        const estimatedPrice = this.calculateWeightedAverage(
          this.higherEntries
        );
        this.higherEntries = [{ price: estimatedPrice, size: higherSize }];
      } else {
        this.higherEntries = [];
      }
    }

    // Same for lower leg
    if (lowerSize > lowerEntriesSize) {
      const newSize = lowerSize - lowerEntriesSize;
      const estimatedPrice =
        this.lowerEntries.length > 0
          ? this.calculateWeightedAverage(this.lowerEntries)
          : lowerPosition && lowerPosition.size > 0
          ? Math.min(0.51, Math.max(0.4, lowerPrice)) // Use current price bounded by hedge range
          : 0.5; // Fallback estimate
      this.lowerEntries.push({ price: estimatedPrice, size: newSize });
    } else if (lowerSize < lowerEntriesSize) {
      if (lowerSize > 0) {
        const estimatedPrice = this.calculateWeightedAverage(this.lowerEntries);
        this.lowerEntries = [{ price: estimatedPrice, size: lowerSize }];
      } else {
        this.lowerEntries = [];
      }
    }
  }
}
