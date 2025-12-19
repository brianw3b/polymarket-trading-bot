import { TradingStrategy, TradingDecision, StrategyContext } from "./base";
import { TokenPrice, Position } from "../utils/marketData";

/**
 * Nuoiem Strategy
 *
 * Entry:
 * - Identify higher leg (price ≥0.52): limit buy 10-30 shares higher at ≤0.57 (small probe).
 *   (ladder @current -0.01/-0.03). projected avg_higher <0.60 or skip.
 * - Hedge lower: anytime lower <0.51 and sim new_pair ≤0.95 and new_min(qty) > total_cost*1.02
 *   (ladder 70-140 shares @current-0.02/-0.05; match ~70% higher qty).
 * - Avg-down higher leg: If dips ≥2.5¢ from avg, add 50-150 shares ladder.
 * - Repeat check every 5s if pair >0.95, add more to both legs (dip ≥2.5¢ below leg avg) to lower the pair_cost.
 *
 * Flow:
 * - Prioritize higher wobbles, then lower opportunities. target pair ≤0.95; asym 0.60-0.75; balance ≥0.75.
 * - Before any add: sim new_pair_cost < current and new_balance ≥0.70 and new_asym ≤0.75.
 * - Unsafe pause: If pair_cost >0.95 after any add (checked post-fill), pause all further adds
 *
 * Reversal Trigger (after the first 2 minutes, check every 1s, ≥6min Left):
 * - If lower_price ≥ higher_price +0.08 and balance_ratio <0.80: Add 25-40% lower qty ladder.
 * - Execute only if new_pair ≤0.95 and new_min(qty) > total_cost*1.02 and new_asym ≤0.75.
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
    // For 15-minute markets: if 13 minutes remaining, 2 minutes have passed
    // Reversal trigger: after 2 minutes (13 min remaining) until 6 minutes remaining

    // When only one side is open, there is no completed hedge yet.
    const currentPairCost = higherSize > 0 && lowerSize > 0 ? pairCost : 0;

    // Check unsafe pause condition: if pair_cost >0.95 after any add, pause
    // Use slightly higher threshold (0.96) to avoid premature pausing
    const pauseThreshold = 0.96;
    if (currentPairCost > pauseThreshold) {
      this.isPaused = true;
    }

    // If paused and pair cost is still above threshold, don't add more
    if (this.isPaused && currentPairCost > pauseThreshold) {
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

    // If pair cost improved to acceptable level, resume
    if (this.isPaused && currentPairCost <= 0.95) {
      this.isPaused = false;
    }

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
    const now = Date.now();
    if (currentPairCost > 0.95 && now - this.lastPairCheck >= 5000) {
      this.lastPairCheck = now;
      const dipThresholdRepeat = 0.025; // 2.5¢ - as per strategy specification

      // Check if we can add to higher leg (dip ≥2.5¢)
      if (avgHigher > 0 && higherSize > 0 && higherPrice <= avgHigher - dipThresholdRepeat) {
        const addSize = this.computeHigherAddSize(higherPrice, avgHigher);
        if (addSize > 0) {
          // Ladder offsets: -0.01, -0.02 for repeat adds
          const priceOffsets = [-0.01, -0.02];
          const offset =
            priceOffsets[this.repeatAddsHigherCount] ??
            priceOffsets[priceOffsets.length - 1];
          const limitPrice = Math.max(0.01, higherPrice + offset);
          const actualPrice =
            this.repeatAddsHigherCount === 0 ? higherPrice : limitPrice;

          const decision = this.simulateAdd(
            "HIGHER",
            addSize,
            actualPrice,
            higherSize,
            lowerSize,
            effectiveAvgHigher,
            effectiveAvgLower,
            currentPairCost,
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
              ).toFixed(2)}¢, add ${addSize} @ ${actualPrice.toFixed(
                4
              )} (ladder ${this.repeatAddsHigherCount})`,
            };
          }
        }
      }

      // Check if we can add to lower leg (dip ≥2.5¢)
      if (avgLower > 0 && lowerSize > 0 && lowerPrice <= avgLower - dipThresholdRepeat) {
        const addSize = this.computeLowerAddSizeForPair(higherSize, lowerSize);
        if (addSize > 0) {
          // Ladder offsets: -0.02, -0.03 for repeat adds to lower
          const priceOffsets = [-0.02, -0.03];
          const offset =
            priceOffsets[this.repeatAddsLowerCount] ??
            priceOffsets[priceOffsets.length - 1];
          const limitPrice = Math.max(0.01, lowerPrice + offset);
          const actualPrice =
            this.repeatAddsLowerCount === 0 ? lowerPrice : limitPrice;

          const decision = this.simulateAdd(
            "LOWER",
            addSize,
            actualPrice,
            higherSize,
            lowerSize,
            effectiveAvgHigher,
            effectiveAvgLower,
            currentPairCost,
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
              ).toFixed(2)}¢, add ${addSize} @ ${actualPrice.toFixed(
                4
              )} (ladder ${this.repeatAddsLowerCount})`,
            };
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

    // 2. Avg-down higher: If dips ≥2.5¢ from avg (prioritized)
    if (avgHigher > 0 && higherSize > 0) {
      const avgDownDecision = this.avgDownHigher(
        higherTokenId,
        higherPrice,
        higherSize,
        lowerSize,
        avgHigher,
        effectiveAvgHigher,
        effectiveAvgLower,
        currentPairCost,
        yesIsHigher,
        config
      );
      if (avgDownDecision) {
        return avgDownDecision;
      }
    }

    // 3. Hedge lower: Anytime lower <0.51, or if balance is off and lower is attractive
    // Also allow hedging if lower is <0.52 and we need to balance
    const needsHedge = lowerSize < higherSize * 0.65; // If lower is less than 65% of higher
    if (
      (lowerPrice < 0.51 || (lowerPrice < 0.52 && needsHedge)) &&
      higherSize > 0
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
   * Entry / Probe (anytime)
   * - Identify higher leg (price ≥0.52)
   * - Buy 10–30 shares higher at ≤0.57
   * - Ladder @current -0.01/-0.03
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
    const maxHigherPrice = 0.57;
    const probeSizeMin = 10;
    const probeSizeMax = 30;
    const maxProjectedAvg = 0.6;

    if (higherPrice < minHigherPrice || higherPrice > maxHigherPrice) {
      return null;
    }

    // Vary entry size between 10-30 shares (random or based on price)
    // Use price proximity to max (0.57) to determine size: closer to max = smaller size
    const priceRange = maxHigherPrice - minHigherPrice;
    const pricePosition = (higherPrice - minHigherPrice) / priceRange; // 0 to 1
    const sizeRange = probeSizeMax - probeSizeMin;
    // Closer to max price (0.57) = smaller size, closer to min (0.52) = larger size
    const probeSize = Math.floor(
      probeSizeMin + sizeRange * (1 - pricePosition)
    );

    // Ladder offsets: -0.01, -0.03
    const priceOffsets = [-0.01, -0.03];
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
      reason: `Nuoiem Entry: higher @ ${actualPrice.toFixed(4)} (ladder ${
        currentEntryCount + 1
      }/2), probe ${probeSize} shares`,
    };
  }

  /**
   * Avg-down higher (anytime)
   * - If dips ≥dipThreshold from avg, add 50–150 shares
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
    yesIsHigher: boolean,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const dipThreshold = 0.025; // 2.5¢ (as per strategy specification)
    const targetPairCost = 0.95;
    const minBalanceRatio = 0.7;
    const maxAsymRatio = 0.75;

    // Allow avg-down if dip is >= dipThreshold from average
    if (avgHigher > 0 && higherPrice <= avgHigher - dipThreshold) {
      const addSize = this.computeHigherAddSize(higherPrice, avgHigher);
      if (addSize > 0) {
        // Ladder offsets: -0.01, -0.02 for avg-down
        const priceOffsets = [-0.01, -0.02];
        const offset =
          priceOffsets[this.avgDownOrdersPlaced] ??
          priceOffsets[priceOffsets.length - 1];
        const limitPrice = Math.max(0.01, higherPrice + offset);

        // First order at current price, subsequent at ladder prices
        const actualPrice =
          this.avgDownOrdersPlaced === 0 ? higherPrice : limitPrice;

        const decision = this.simulateAdd(
          "HIGHER",
          addSize,
          actualPrice,
          higherSize,
          lowerSize,
          effectiveAvgHigher,
          effectiveAvgLower,
          currentPairCost,
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
            ).toFixed(2)}¢, add ${addSize} @ ${actualPrice.toFixed(
              4
            )} (ladder ${this.avgDownOrdersPlaced})`,
          };
        }
      }
    }

    return null;
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

      const decision = this.simulateAdd(
        "LOWER",
        addSize,
        actualPrice,
        higherSize,
        lowerSize,
        effectiveAvgHigher,
        effectiveAvgLower,
        currentPairCost,
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
          reason: `Nuoiem Hedge: lower @ ${actualPrice.toFixed(
            4
          )}, add ${addSize}`,
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
   * Reversal Trigger:
   * - If lower_price ≥ higher_price + 0.08 and balance_ratio < 0.80:
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

    const buyRatio = Math.min(
      buyRatioMax,
      buyRatioMin + this.reversalOrdersPlaced * 0.05
    );
    const targetBuySize = Math.floor(lowerSize * buyRatio);

    const roundedSize = Math.max(
      10,
      Math.min(50, Math.round(targetBuySize / 10) * 10)
    );
    if (roundedSize <= 0) {
      return null;
    }

    // Ladder offsets: -0.02, -0.03, -0.05
    const priceOffsets = [-0.02, -0.03, -0.05];
    const offset =
      priceOffsets[this.reversalOrdersPlaced] ??
      priceOffsets[priceOffsets.length - 1];
    const limitPrice = Math.max(0.01, lowerPrice + offset);

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

    // Calculate total USD cost
    const totalCost =
      effectiveAvgHigher * higherSize +
      effectiveAvgLower * lowerSize +
      limitPrice * roundedSize;
    // Convert total cost to equivalent pair shares: total_cost / pair_cost
    const equivalentPairShares = newPairCost > 0 ? totalCost / newPairCost : 0;

    if (newPairCost > targetPairCost) {
      return null;
    }

    // Ensure minimum side has at least 1.02x the equivalent pair shares
    if (newMinQty <= equivalentPairShares * minQtyMultiplier) {
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
      ).toFixed(4)}, buy ${roundedSize} @ ${limitPrice.toFixed(4)} (order ${
        this.reversalOrdersPlaced
      }/3)`,
    };
  }

  private computeHigherAddSize(
    currentPrice: number,
    avgHigher: number
  ): number {
    // 50–150 shares, larger when dip is larger
    const baseMin = 50;
    const baseMax = 150;
    const dipAmount = avgHigher - currentPrice;
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

  private computeLowerAddSizeForPair(
    higherSize: number,
    lowerSize: number
  ): number {
    // For pair >0.95 repeat check, use similar logic but can be more flexible
    const baseMin = 50;
    const baseMax = 150;
    const targetLowerSize = Math.floor(higherSize * 0.7);
    const needed = targetLowerSize - lowerSize;
    if (needed <= 0) return Math.min(baseMax, baseMin);
    return Math.min(baseMax, Math.max(baseMin, needed));
  }

  /**
   * Simulate adding to either higher or lower leg and enforce global guards:
   * - new_pair_cost < current_pair_cost (if current_pair_cost > 0)
   * - new_balance_ratio ≥ minBalanceRatio
   * - new_asym_ratio ≤ maxAsymRatio
   * - If enforceHedgeConstraints:
   *   - new_pair_cost ≤ targetPairCost
   *   - new_min(qty) > total_cost_in_shares × 1.02
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

      const newMinQty = Math.min(newHigherSize, newLowerSize);
      // Calculate total USD cost
      const totalCost =
        effectiveAvgHigher * higherSize +
        effectiveAvgLower * lowerSize +
        addPrice * addSize;
      // Convert total cost to equivalent pair shares: total_cost / pair_cost
      const equivalentPairShares =
        newPairCost > 0 ? totalCost / newPairCost : 0;

      // Ensure minimum side has at least 1.02x the equivalent pair shares
      if (newMinQty <= equivalentPairShares * 1.02) {
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
