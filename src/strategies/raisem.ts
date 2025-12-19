import { TradingStrategy, TradingDecision, StrategyContext } from "./base";
import { TokenPrice, Position } from "../utils/marketData";

/**
 * Raisem Strategy v0
 *
 * Entry:
 * - Identify higher leg (price ≥0.52): limit buy 10-30 shares higher at ≤0.56 (small probe and ladder @current -0.02/-0.05).
 *   projected avg_higher <0.60 or skip.
 * - Hedge lower: anytime lower <0.51 and sim new_pair ≤0.95 and new_min(qty) > total_cost*1.02
 *   (ladder 70-140 shares @current-0.02/-0.05; match ~70% higher qty).
 * - avg-Down Loop, recursive on both legs: If dips ≥2.5¢ from leg avg (wobble), add 50-150 shares ladder.
 *   Repeat check every 5s if historical_pair >0.95 to lower the pair_cost.
 *
 * Flow:
 * - Prioritize higher wobbles, then lower opportunities. target pair ≤0.95; asym 0.60-0.75; balance ≥0.75.
 * - Before any add: sim new_historical_pair < current_historical_pair and projected_pair with add <0.95
 *   and new_balance ≥0.70 and new_asym ≤0.75 and pair improvement >0.01 (forces clusters).
 *
 * Reversal Trigger (after the first 2 minutes, check every 1s, <6min Left):
 * - If lower_price ≥ higher_price +0.09 and balance_ratio <0.80: Add 25-40% lower qty ladder.
 * - Execute only if new_pair ≤0.95 and new_min(qty) > total_cost*1.02 and new_asym ≤0.75.
 *
 * Lock/Exit (9-15min):
 * - Hold to settlement If pair_cost ≤0.95 and balance_ratio ≥0.75 (min(qty) covers ≥75% exposure, asym ≤0.75), full hold.
 */
export class RaisemStrategy extends TradingStrategy {
  name = "raisem";
  description =
    "Raisem strategy v0 with entry, hedge, recursive avg-down, reversal trigger, and lock/exit conditions";

  // Track entry prices with sizes for weighted averages (only successful orders)
  private higherEntries: Array<{ price: number; size: number }> = [];
  private lowerEntries: Array<{ price: number; size: number }> = [];
  private higherLeg: "YES" | "NO" | null = null;
  private lastReversalCheck: number = 0;
  private reversalOrdersPlaced: number = 0;
  private lastPairCheck: number = 0; // For 5s repeat check
  private avgDownOrdersPlacedHigher: number = 0; // Track avg-down ladder orders for higher
  private avgDownOrdersPlacedLower: number = 0; // Track avg-down ladder orders for lower
  private historicalPairCosts: number[] = []; // Track historical pair costs for improvement checks
  private lastAvgDownCheck: number = 0; // For recursive avg-down checks

  reset(): void {
    this.higherEntries = [];
    this.lowerEntries = [];
    this.higherLeg = null;
    this.lastReversalCheck = 0;
    this.reversalOrdersPlaced = 0;
    this.lastPairCheck = 0;
    this.avgDownOrdersPlacedHigher = 0;
    this.avgDownOrdersPlacedLower = 0;
    this.historicalPairCosts = [];
    this.lastAvgDownCheck = 0;
  }

  execute(context: StrategyContext): TradingDecision | null {
    const { yesTokenPrice, noTokenPrice, positions, config, timeUntilEnd } =
      context;

    if (!yesTokenPrice || !noTokenPrice) {
      return null;
    }

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

    // When only one side is open, there is no completed hedge yet.
    const currentPairCost = higherSize > 0 && lowerSize > 0 ? pairCost : 0;

    // Track historical pair cost (only when both legs are open)
    if (currentPairCost > 0) {
      this.historicalPairCosts.push(currentPairCost);
      // Keep only last 100 entries to avoid memory issues
      if (this.historicalPairCosts.length > 100) {
        this.historicalPairCosts.shift();
      }
    }

    // Calculate current historical pair cost (average of recent history)
    const currentHistoricalPair =
      this.historicalPairCosts.length > 0
        ? this.historicalPairCosts.reduce((a, b) => a + b, 0) /
          this.historicalPairCosts.length
        : currentPairCost;

    // Lock/Exit (9-15min remaining) - check first
    // Note: Assuming this means remaining time 9-15min (early-to-mid market)
    // If description meant time passed, this would be remaining 0-6min
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

    // Reversal Trigger (after first 2 minutes, check every 1s, <6min left)
    // For 15-min market: after 2 min = 13 min remaining, check when remaining <6min
    // So check when: 13 >= minutesRemaining && minutesRemaining < 6
    if (minutesRemaining <= 13 && minutesRemaining < 6) {
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
          currentHistoricalPair,
          config
        );
        if (reversalDecision) {
          return reversalDecision;
        }
      }
    }

    // Avg-Down Loop: Repeat check every 5s if historical_pair >0.95
    const now = Date.now();
    const allowAvgDownCheck =
      currentHistoricalPair > 0.95 && now - this.lastAvgDownCheck >= 5000;
    if (allowAvgDownCheck) {
      this.lastAvgDownCheck = now;

      // Check higher leg wobble (prioritize higher wobbles)
      if (avgHigher > 0 && higherSize > 0) {
        const dipThreshold = 0.025; // 2.5¢
        if (higherPrice <= avgHigher - dipThreshold) {
          const addSize = this.computeAvgDownSize(higherPrice, avgHigher);
          if (addSize > 0) {
            const priceOffsets = [-0.02, -0.05];
            const offset =
              priceOffsets[this.avgDownOrdersPlacedHigher] ??
              priceOffsets[priceOffsets.length - 1];
            const limitPrice = Math.max(0.01, higherPrice + offset);
            const actualPrice =
              this.avgDownOrdersPlacedHigher === 0 ? higherPrice : limitPrice;

            const decision = this.simulateAddWithHistorical(
              "HIGHER",
              addSize,
              actualPrice,
              higherSize,
              lowerSize,
              effectiveAvgHigher,
              effectiveAvgLower,
              currentPairCost,
              currentHistoricalPair,
              0.95,
              0.7,
              0.75
            );

            if (decision) {
              this.avgDownOrdersPlacedHigher++;
              return {
                action: yesIsHigher ? "BUY_YES" : "BUY_NO",
                tokenId: higherTokenId,
                price: actualPrice,
                size: addSize,
                reason: `Raisem Avg-Down Higher: dip ${(
                  (avgHigher - higherPrice) *
                  100
                ).toFixed(2)}¢, add ${addSize} @ ${actualPrice.toFixed(4)}`,
              };
            }
          }
        }
      }

      // Check lower leg wobble (then lower opportunities)
      if (avgLower > 0 && lowerSize > 0) {
        const dipThreshold = 0.025; // 2.5¢
        if (lowerPrice <= avgLower - dipThreshold) {
          const addSize = this.computeAvgDownSize(lowerPrice, avgLower);
          if (addSize > 0) {
            const priceOffsets = [-0.02, -0.05];
            const offset =
              priceOffsets[this.avgDownOrdersPlacedLower] ??
              priceOffsets[priceOffsets.length - 1];
            const limitPrice = Math.max(0.01, lowerPrice + offset);
            const actualPrice =
              this.avgDownOrdersPlacedLower === 0 ? lowerPrice : limitPrice;

            const decision = this.simulateAddWithHistorical(
              "LOWER",
              addSize,
              actualPrice,
              higherSize,
              lowerSize,
              effectiveAvgHigher,
              effectiveAvgLower,
              currentPairCost,
              currentHistoricalPair,
              0.95,
              0.7,
              0.75
            );

            if (decision) {
              this.avgDownOrdersPlacedLower++;
              return {
                action: yesIsHigher ? "BUY_NO" : "BUY_YES",
                tokenId: lowerTokenId,
                price: actualPrice,
                size: addSize,
                reason: `Raisem Avg-Down Lower: dip ${(
                  (avgLower - lowerPrice) *
                  100
                ).toFixed(2)}¢, add ${addSize} @ ${actualPrice.toFixed(4)}`,
              };
            }
          }
        }
      }
    }

    // All other actions available anytime (no phase restrictions)

    // 1. Entry: Identify higher leg and probe (if no higher position yet)
    const entryOrdersCount = this.higherEntries.length;
    if (higherSize === 0 && entryOrdersCount < 2) {
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

    // 2. Avg-down higher: If dips ≥2.5¢ from avg (prioritized, recursive)
    if (avgHigher > 0 && higherSize > 0) {
      const dipThreshold = 0.025; // 2.5¢
      if (higherPrice <= avgHigher - dipThreshold) {
        const addSize = this.computeAvgDownSize(higherPrice, avgHigher);
        if (addSize > 0) {
          const priceOffsets = [-0.02, -0.05];
          const offset =
            priceOffsets[this.avgDownOrdersPlacedHigher] ??
            priceOffsets[priceOffsets.length - 1];
          const limitPrice = Math.max(0.01, higherPrice + offset);
          const actualPrice =
            this.avgDownOrdersPlacedHigher === 0 ? higherPrice : limitPrice;

          const decision = this.simulateAddWithHistorical(
            "HIGHER",
            addSize,
            actualPrice,
            higherSize,
            lowerSize,
            effectiveAvgHigher,
            effectiveAvgLower,
            currentPairCost,
            currentHistoricalPair,
            0.95,
            0.7,
            0.75
          );

          if (decision) {
            this.avgDownOrdersPlacedHigher++;
            return {
              action: yesIsHigher ? "BUY_YES" : "BUY_NO",
              tokenId: higherTokenId,
              price: actualPrice,
              size: addSize,
              reason: `Raisem Avg-Down Higher: dip ${(
                (avgHigher - higherPrice) *
                100
              ).toFixed(2)}¢, add ${addSize} @ ${actualPrice.toFixed(4)}`,
            };
          }
        }
      }
    }

    // 3. Avg-down lower: If dips ≥2.5¢ from avg (recursive)
    if (avgLower > 0 && lowerSize > 0) {
      const dipThreshold = 0.025; // 2.5¢
      if (lowerPrice <= avgLower - dipThreshold) {
        const addSize = this.computeAvgDownSize(lowerPrice, avgLower);
        if (addSize > 0) {
          const priceOffsets = [-0.02, -0.05];
          const offset =
            priceOffsets[this.avgDownOrdersPlacedLower] ??
            priceOffsets[priceOffsets.length - 1];
          const limitPrice = Math.max(0.01, lowerPrice + offset);
          const actualPrice =
            this.avgDownOrdersPlacedLower === 0 ? lowerPrice : limitPrice;

          const decision = this.simulateAddWithHistorical(
            "LOWER",
            addSize,
            actualPrice,
            higherSize,
            lowerSize,
            effectiveAvgHigher,
            effectiveAvgLower,
            currentPairCost,
            currentHistoricalPair,
            0.95,
            0.7,
            0.75
          );

          if (decision) {
            this.avgDownOrdersPlacedLower++;
            return {
              action: yesIsHigher ? "BUY_NO" : "BUY_YES",
              tokenId: lowerTokenId,
              price: actualPrice,
              size: addSize,
              reason: `Raisem Avg-Down Lower: dip ${(
                (avgLower - lowerPrice) *
                100
              ).toFixed(2)}¢, add ${addSize} @ ${actualPrice.toFixed(4)}`,
            };
          }
        }
      }
    }

    // 4. Hedge lower: Anytime lower <0.51
    if (lowerPrice < 0.51 && higherSize > 0) {
      const hedgeDecision = this.hedgeLower(
        lowerTokenId,
        lowerPrice,
        higherSize,
        lowerSize,
        effectiveAvgHigher,
        effectiveAvgLower,
        currentPairCost,
        currentHistoricalPair,
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
   * Entry / Probe (anytime)
   * - Identify higher leg (price ≥0.52)
   * - Buy 10–30 shares higher at ≤0.56
   * - Ladder @current -0.02/-0.05
   * - Projected avg_higher < 0.60 or skip
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
    const maxHigherPrice = 0.56;
    const probeSizeMin = 10;
    const probeSizeMax = 30;
    const maxProjectedAvg = 0.6;

    if (higherPrice < minHigherPrice || higherPrice > maxHigherPrice) {
      return null;
    }

    // Vary entry size between 10-30 shares
    // Use price proximity to max (0.56) to determine size: closer to max = smaller size
    const priceRange = maxHigherPrice - minHigherPrice;
    const pricePosition = (higherPrice - minHigherPrice) / priceRange; // 0 to 1
    const sizeRange = probeSizeMax - probeSizeMin;
    // Closer to max price (0.56) = smaller size, closer to min (0.52) = larger size
    const probeSize = Math.floor(
      probeSizeMin + sizeRange * (1 - pricePosition)
    );

    // Ladder offsets: -0.02, -0.05
    const priceOffsets = [-0.02, -0.05];
    const offset =
      priceOffsets[currentEntryCount] ?? priceOffsets[priceOffsets.length - 1];
    const limitPrice = Math.max(0.01, higherPrice + offset);

    // Only place first order at current price, subsequent at ladder prices
    const actualPrice = currentEntryCount === 0 ? higherPrice : limitPrice;

    // Calculate projected average after all ladder orders (2 orders total)
    let projectedAvg: number;
    if (currentEntryCount === 0) {
      // First order: simulate both orders
      const totalPlannedSize = probeSize * 2;
      const firstOrderPrice = higherPrice;
      const secondOrderPrice = Math.max(0.01, higherPrice + priceOffsets[1]);
      const projectedTotalCost =
        firstOrderPrice * probeSize + secondOrderPrice * probeSize;
      projectedAvg =
        totalPlannedSize > 0
          ? projectedTotalCost / totalPlannedSize
          : higherPrice;
    } else {
      // Second order: use actual first order from entries
      const firstEntry = this.higherEntries[0];
      const firstOrderPrice = firstEntry.price;
      const secondOrderPrice = limitPrice;
      const totalPlannedSize = firstEntry.size + probeSize;
      const projectedTotalCost =
        firstOrderPrice * firstEntry.size + secondOrderPrice * probeSize;
      projectedAvg =
        totalPlannedSize > 0
          ? projectedTotalCost / totalPlannedSize
          : higherPrice;
    }

    if (projectedAvg >= maxProjectedAvg) {
      return null;
    }

    return {
      action: yesIsHigher ? "BUY_YES" : "BUY_NO",
      tokenId: higherTokenId,
      price: actualPrice,
      size: probeSize,
      reason: `Raisem Entry: higher @ ${actualPrice.toFixed(4)} (ladder ${
        currentEntryCount + 1
      }/2), probe ${probeSize} shares`,
    };
  }

  /**
   * Hedge lower (anytime)
   * - Anytime lower <0.51
   * - Ladder 70–140 shares @current-0.02/-0.05, match ~70% higher qty
   */
  private hedgeLower(
    lowerTokenId: string,
    lowerPrice: number,
    higherSize: number,
    lowerSize: number,
    effectiveAvgHigher: number,
    effectiveAvgLower: number,
    currentPairCost: number,
    currentHistoricalPair: number,
    yesIsHigher: boolean,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const targetPairCost = 0.95;
    const minBalanceRatio = 0.7;
    const maxAsymRatio = 0.75;

    const addSize = this.computeLowerAddSize(higherSize, lowerSize);
    if (addSize > 0) {
      // Ladder offsets: -0.02, -0.05
      const priceOffsets = [-0.02, -0.05];
      const hedgeOrdersCount = this.lowerEntries.length;
      const offset =
        priceOffsets[hedgeOrdersCount] ?? priceOffsets[priceOffsets.length - 1];
      const limitPrice = Math.max(0.01, lowerPrice + offset);

      // Only place first order at current price, subsequent at ladder prices
      const actualPrice = hedgeOrdersCount === 0 ? lowerPrice : limitPrice;

      const decision = this.simulateAddWithHistorical(
        "LOWER",
        addSize,
        actualPrice,
        higherSize,
        lowerSize,
        effectiveAvgHigher,
        effectiveAvgLower,
        currentPairCost,
        currentHistoricalPair,
        targetPairCost,
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
          reason: `Raisem Hedge: lower @ ${actualPrice.toFixed(4)}, add ${addSize}`,
        };
      }
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
    const maxAsymRatio = 0.75; // No lower bound specified in description

    // If fully hedged and cost profile is good, just hold to settlement
    if (
      pairCost <= targetPairCost &&
      balanceRatio >= minBalanceRatio &&
      asymRatio <= maxAsymRatio
    ) {
      return {
        action: "HOLD",
        tokenId: "",
        price: 0,
        size: 0,
        reason: `Raisem Lock: pair_cost=${pairCost.toFixed(
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
   * Reversal Trigger:
   * - If lower_price ≥ higher_price + 0.09 and balance_ratio < 0.80:
   *   - Add 25–40% of current lower qty (rounded 10–50 shares).
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
    currentHistoricalPair: number,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const priceDiffThreshold = 0.09; // +0.09
    const balanceRatioThreshold = 0.8;
    const buyRatioMin = 0.25;
    const buyRatioMax = 0.4;
    const targetPairCost = 0.95;
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

    // Single add (25-40%), not multiple orders
    const buyRatio = (buyRatioMin + buyRatioMax) / 2; // Use middle value (32.5%)
    const targetBuySize = Math.floor(lowerSize * buyRatio);

    const roundedSize = Math.max(
      10,
      Math.min(50, Math.round(targetBuySize / 10) * 10)
    );
    if (roundedSize <= 0) {
      return null;
    }

    // Ladder offsets: -0.02, -0.05 (not -0.03)
    const priceOffsets = [-0.02, -0.05];
    const offset = priceOffsets[0]; // Use first offset for single order
    const limitPrice = Math.max(0.01, lowerPrice + offset);

    // Use simulateAddWithHistorical to check all constraints
    const decision = this.simulateAddWithHistorical(
      "LOWER",
      roundedSize,
      limitPrice,
      higherSize,
      lowerSize,
      effectiveAvgHigher,
      effectiveAvgLower,
      currentPairCost,
      currentHistoricalPair,
      targetPairCost,
      0.7, // minBalanceRatio
      maxAsymRatio,
      true // enforceHedgeConstraints (includes min(qty) > total_cost*1.02)
    );

    if (!decision) {
      return null;
    }

    return {
      action: yesIsHigher ? "BUY_NO" : "BUY_YES",
      tokenId: lowerTokenId,
      price: limitPrice,
      size: roundedSize,
      reason: `Raisem Reversal: lower ${lowerPrice.toFixed(4)} ≥ ${(
        higherPrice + priceDiffThreshold
      ).toFixed(4)}, buy ${roundedSize} @ ${limitPrice.toFixed(4)}`,
    };
  }

  private computeAvgDownSize(
    currentPrice: number,
    avgPrice: number
  ): number {
    // 50–150 shares, larger when dip is larger
    const baseMin = 50;
    const baseMax = 150;
    const dipAmount = avgPrice - currentPrice;
    if (dipAmount <= 0) return 0;

    const sizeMultiplier = Math.min(4, Math.floor(dipAmount / 0.01)); // up to 4x
    const addSize = Math.min(baseMax, baseMin + sizeMultiplier * 20);
    return addSize;
  }

  private computeLowerAddSize(higherSize: number, lowerSize: number): number {
    // 70–140 shares, targeting ~70% of higher qty
    const baseMin = 70;
    const baseMax = 140;
    const targetLowerSize = Math.floor(higherSize * 0.7);
    const needed = targetLowerSize - lowerSize;
    // Allow adding even if close to target (within 10 shares) to maintain balance
    if (needed <= -10) return 0; // Already well above target
    if (needed <= 0) return Math.min(baseMax, baseMin); // Close to target, add minimum
    return Math.min(baseMax, Math.max(baseMin, needed));
  }

  /**
   * Simulate adding to either higher or lower leg and enforce global guards:
   * - new_historical_pair < current_historical_pair
   * - projected_pair with add <0.95
   * - new_balance ≥0.70
   * - new_asym ≤0.75
   * - pair improvement >0.01 (forces clusters)
   * - If enforceHedgeConstraints:
   *   - new_pair_cost ≤ targetPairCost
   *   - new_min(USD_value) > total_cost_USD × 1.02
   */
  private simulateAddWithHistorical(
    side: "HIGHER" | "LOWER",
    addSize: number,
    addPrice: number,
    higherSize: number,
    lowerSize: number,
    effectiveAvgHigher: number,
    effectiveAvgLower: number,
    currentPairCost: number,
    currentHistoricalPair: number,
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

    // Projected pair cost must be <0.95
    if (newPairCost >= targetPairCost) {
      return false;
    }

    // Historical pair improvement: new_historical_pair < current_historical_pair
    // Estimate new historical pair by adding new pair cost to history
    const estimatedNewHistoricalPair =
      currentHistoricalPair > 0
        ? (currentHistoricalPair * this.historicalPairCosts.length +
            newPairCost) /
          (this.historicalPairCosts.length + 1)
        : newPairCost;

    if (
      currentHistoricalPair > 0 &&
      estimatedNewHistoricalPair >= currentHistoricalPair
    ) {
      return false;
    }

    // Pair improvement >0.01 (forces clusters)
    // Skip this check for first hedge (when currentPairCost is 0)
    if (currentPairCost > 0) {
      const pairImprovement = currentPairCost - newPairCost;
      if (pairImprovement <= 0.01) {
        return false;
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

      // Calculate total USD cost (what we've spent)
      const totalCostUSD =
        effectiveAvgHigher * higherSize +
        effectiveAvgLower * lowerSize +
        addPrice * addSize;

      // min(qty) means min(higherSize, lowerSize) - the payout potential
      // Each share pays $1 at settlement, so min(qty) * $1 is the minimum payout
      const minQty = Math.min(newHigherSize, newLowerSize);
      const minPayoutUSD = minQty * 1.0; // $1 per share at settlement

      // Ensure minimum payout is at least 1.02x the total USD cost
      if (minPayoutUSD <= totalCostUSD * 1.02) {
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
      const estimatedPrice =
        this.higherEntries.length > 0
          ? this.calculateWeightedAverage(this.higherEntries)
          : higherPosition && higherPosition.size > 0
          ? Math.min(0.56, Math.max(0.52, higherPrice)) // Use current price bounded by entry range
          : 0.54; // Fallback estimate
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

