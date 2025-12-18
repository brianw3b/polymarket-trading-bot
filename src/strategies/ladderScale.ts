import { TradingStrategy, TradingDecision, StrategyContext } from "./base";
import { TokenPrice, Position } from "../utils/marketData";

/**
 * Liam Strategy
 *
 * Share-based dip-scaling / hedge strategy for 15-minute markets.
 *
 * Entry / Build Logic
 * -------------------
 * - Identify higher leg (price ≥0.52):
 *   - Limit buy 10–30 shares higher at ≤0.57 (small probe).
 *   - Ladder @current -0.01/-0.03
 *   - Projected avg_higher < 0.60 or skip.
 * - Avg-down higher:
 *   - If higher dips ≥2.5¢ from avg, add 50–150 shares (ladder-style).
 * - Hedge lower:
 *   - Any time lower < 0.53 and simulated new_pair_cost ≤ 0.965
 *   - And new_min(qty) > total_cost_in_shares × 1.02
 *   - Ladder 80–150 shares @current-0.02/-0.05, targeting ~70% of higher quantity.
 *
 * Flow:
 * - Prioritize higher-leg avg-down first, then lower-leg opportunities.
 * - Global guard before any add:
 *   - new_pair_cost < current_pair_cost (if current_pair_cost > 0)
 *   - new_balance_ratio ≥ 0.70
 *   - new_asym_ratio ≤ 0.75
 *
 * Reversal Trigger (after first 2 minutes, ≥6min left)
 * ---------------------------------------------------
 * - If lower_price ≥ higher_price + 0.07 and balance_ratio < 0.80:
 *   - Add 25–40% of current lower qty (rounded 10–50 shares) as ladder.
 *   - Execute only if:
 *     - new_pair_cost ≤ 0.965
 *     - new_min(qty) > total_cost_in_shares × 1.02
 *     - new_asym_ratio ≤ 0.75
 *
 * Lock / Exit (9–15min)
 * ---------------------
 * - If pair_cost ≤ 0.965 and balance_ratio ≥ 0.75 (and asym ≤ 0.75) → HOLD to settlement.
 */
export class LadderScaleStrategy extends TradingStrategy {
  name = "ladderScale";
  description = "Share-based dip-scale / hedge strategy with reversal trigger and ladder orders";

  // Track entry prices with sizes for weighted averages
  private higherEntries: Array<{ price: number; size: number }> = [];
  private lowerEntries: Array<{ price: number; size: number }> = [];
  private higherLeg: "YES" | "NO" | null = null;
  private lastReversalCheck: number = 0;
  private reversalOrdersPlaced: number = 0;
  private entryOrdersPlaced: number = 0; // Track entry ladder orders
  private hedgeOrdersPlaced: number = 0; // Track hedge ladder orders

  reset(): void {
    this.higherEntries = [];
    this.lowerEntries = [];
    this.higherLeg = null;
    this.lastReversalCheck = 0;
    this.reversalOrdersPlaced = 0;
    this.entryOrdersPlaced = 0;
    this.hedgeOrdersPlaced = 0;
  }

  execute(context: StrategyContext): TradingDecision | null {
    const { yesTokenPrice, noTokenPrice, positions, config, timeUntilEnd } = context;

    if (!yesTokenPrice || !noTokenPrice) {
      return null;
    }

    // Determine which leg is higher
    const yesIsHigher = yesTokenPrice.askPrice >= noTokenPrice.askPrice;
    const higherPrice = yesIsHigher ? yesTokenPrice.askPrice : noTokenPrice.askPrice;
    const lowerPrice = yesIsHigher ? noTokenPrice.askPrice : yesTokenPrice.askPrice;
    const higherTokenId = yesIsHigher ? yesTokenPrice.tokenId : noTokenPrice.tokenId;
    const lowerTokenId = yesIsHigher ? noTokenPrice.tokenId : yesTokenPrice.tokenId;

    // Initialize higher leg tracking
    if (this.higherLeg === null && higherPrice >= 0.52) {
      this.higherLeg = yesIsHigher ? "YES" : "NO";
    }

    // Current position stats
    const higherPosition = positions.find((p) => p.asset === higherTokenId);
    const lowerPosition = positions.find((p) => p.asset === lowerTokenId);
    const higherSize = higherPosition?.size || 0;
    const lowerSize = lowerPosition?.size || 0;

    // Weighted averages from entries
    const avgHigher = this.calculateWeightedAverage(this.higherEntries);
    const avgLower = this.calculateWeightedAverage(this.lowerEntries);

    // Use current prices if no entries yet
    const effectiveAvgHigher = avgHigher > 0 ? avgHigher : higherPrice;
    const effectiveAvgLower = avgLower > 0 ? avgLower : lowerPrice;

    // Metrics
    const pairCost = effectiveAvgHigher + effectiveAvgLower;
    const totalSize = higherSize + lowerSize;
    const asymRatio = totalSize > 0 ? Math.max(higherSize, lowerSize) / totalSize : 0;
    const balanceRatio =
      totalSize > 0 && Math.max(higherSize, lowerSize) > 0
        ? Math.min(higherSize, lowerSize) / Math.max(higherSize, lowerSize)
        : 0;

    // Time metrics (for 15min markets)
    const timeUntilEndMs = timeUntilEnd || 0;
    const minutesRemaining = timeUntilEndMs / (60 * 1000);

    // When only one side is open, there is no completed hedge yet.
    const currentPairCost = higherSize > 0 && lowerSize > 0 ? pairCost : 0;

    // Reversal Trigger (after first 2 minutes, ≥6min left)
    // After 2 minutes means 15 - 2 = 13 minutes remaining, check until 6 minutes remaining
    if (minutesRemaining >= 6 && minutesRemaining <= 13) {
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

    // Lock / Exit (last 6 minutes) - check first, if conditions met, hold
    if (minutesRemaining <= 6) {
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

    // All other actions available anytime (no phase restrictions)

    // 1. Entry: Identify higher leg and probe (if no higher position yet)
    if (higherSize === 0) {
      const entryDecision = this.entryPhase(
        higherTokenId,
        lowerTokenId,
        higherPrice,
        lowerPrice,
        yesIsHigher,
        config
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

    // 3. Hedge lower: Anytime lower <0.53
    if (lowerPrice < 0.53 && higherSize > 0) {
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
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const minHigherPrice = 0.52;
    const maxHigherPrice = 0.57;
    const probeSizeMin = 10;
    const probeSizeMax = 30;
    const maxProjectedAvg = 0.6;

    if (higherPrice < minHigherPrice || higherPrice > maxHigherPrice) {
      return null;
    }

    // Only allow up to 2 ladder orders for entry
    if (this.entryOrdersPlaced >= 2) {
      return null;
    }

    // Check if we already have a position
    if (this.higherEntries.length > 0 && this.entryOrdersPlaced >= 2) {
      return null;
    }

    const probeSize = Math.floor((probeSizeMin + probeSizeMax) / 2); // ~20 shares
    
    // Ladder offsets: -0.01, -0.03
    const priceOffsets = [-0.01, -0.03];
    const offset = priceOffsets[this.entryOrdersPlaced] ?? priceOffsets[priceOffsets.length - 1];
    const limitPrice = Math.max(0.01, higherPrice + offset);

    // Only place first order at current price, subsequent at ladder prices
    const actualPrice = this.entryOrdersPlaced === 0 ? higherPrice : limitPrice;
    
    // Calculate projected average after all ladder orders (2 orders total)
    // Simulate both orders to get projected weighted average
    const totalPlannedSize = probeSize * 2; // 2 ladder orders
    const firstOrderPrice = higherPrice;
    const secondOrderPrice = Math.max(0.01, higherPrice + priceOffsets[1]);
    const projectedTotalCost = firstOrderPrice * probeSize + secondOrderPrice * probeSize;
    const projectedAvg = totalPlannedSize > 0 ? projectedTotalCost / totalPlannedSize : higherPrice;
    
    if (projectedAvg >= maxProjectedAvg) {
      return null;
    }

    this.entryOrdersPlaced++;
    this.higherEntries.push({ price: actualPrice, size: probeSize });

    return {
      action: yesIsHigher ? "BUY_YES" : "BUY_NO",
      tokenId: higherTokenId,
      price: actualPrice,
      size: probeSize,
      reason: `Liam Entry: higher @ ${actualPrice.toFixed(4)} (ladder ${this.entryOrdersPlaced}/2), probe ${probeSize} shares`,
    };
  }

  /**
   * Avg-down higher (anytime)
   * - If dips ≥2.5¢ from avg, add 50–150 shares
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
    const dipThreshold = 0.025; // 2.5¢
    const targetPairCost = 0.965;
    const minBalanceRatio = 0.7;
    const maxAsymRatio = 0.75;

    if (avgHigher > 0 && higherPrice <= avgHigher - dipThreshold) {
      const addSize = this.computeHigherAddSize(higherPrice, avgHigher);
      if (addSize > 0) {
        const decision = this.simulateAdd(
          "HIGHER",
          addSize,
          higherPrice,
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
          this.higherEntries.push({ price: higherPrice, size: addSize });
          return {
            action: yesIsHigher ? "BUY_YES" : "BUY_NO",
            tokenId: higherTokenId,
            price: higherPrice,
            size: addSize,
            reason: `Liam Avg-Down: higher dip ${((avgHigher - higherPrice) * 100).toFixed(2)}¢, add ${addSize} @ ${higherPrice.toFixed(4)}`,
          };
        }
      }
    }

    return null;
  }

  /**
   * Hedge lower (anytime)
   * - Anytime lower <0.53
   * - Ladder 80–150 shares @current-0.02/-0.05, match ~70% higher qty
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
    const targetPairCost = 0.965;
    const minBalanceRatio = 0.7;
    const maxAsymRatio = 0.75;

    const addSize = this.computeLowerAddSize(higherSize, lowerSize);
    if (addSize > 0) {
      // Ladder offsets: -0.02, -0.05
      const priceOffsets = [-0.02, -0.05];
      const offset = priceOffsets[this.hedgeOrdersPlaced] ?? priceOffsets[priceOffsets.length - 1];
      const limitPrice = Math.max(0.01, lowerPrice + offset);

      // Only place first order at current price, subsequent at ladder prices
      const actualPrice = this.hedgeOrdersPlaced === 0 ? lowerPrice : limitPrice;

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
        this.hedgeOrdersPlaced++;
        this.lowerEntries.push({ price: actualPrice, size: addSize });
        return {
          action: yesIsHigher ? "BUY_NO" : "BUY_YES",
          tokenId: lowerTokenId,
          price: actualPrice,
          size: addSize,
          reason: `Liam Hedge: lower @ ${actualPrice.toFixed(4)} (ladder ${this.hedgeOrdersPlaced}), add ${addSize}`,
        };
      }
    }

    return null;
  }

  /**
   * Lock / Exit (last 6 minutes)
   * - If pair_cost ≤ 0.965 and balance ≥ 0.75 and asym ≤ 0.75 → HOLD to settlement
   */
  private lockExitPhase(
    pairCost: number,
    balanceRatio: number,
    asymRatio: number,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const targetPairCost = 0.965;
    const minBalanceRatio = 0.75;
    const maxAsymRatio = 0.75;

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
        reason: `Liam Lock: pair_cost=${pairCost.toFixed(4)} ≤ ${targetPairCost}, balance=${balanceRatio.toFixed(
          2
        )}, asym=${asymRatio.toFixed(2)}`,
      };
    }

    // If conditions not met, return null to allow other actions
    return null;
  }

  /**
   * Reversal Trigger:
   * - If lower_price ≥ higher_price + 0.07 and balance_ratio < 0.80:
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
    const priceDiffThreshold = 0.07;
    const balanceRatioThreshold = 0.8;
    const buyRatioMin = 0.25;
    const buyRatioMax = 0.4;
    const targetPairCost = 0.965;
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

    const buyRatio = Math.min(buyRatioMax, buyRatioMin + this.reversalOrdersPlaced * 0.05);
    const targetBuySize = Math.floor(lowerSize * buyRatio);

    const roundedSize = Math.max(10, Math.min(50, Math.round(targetBuySize / 10) * 10));
    if (roundedSize <= 0) {
      return null;
    }

    // Ladder offsets: -0.02, -0.03, -0.05
    const priceOffsets = [-0.02, -0.03, -0.05];
    const offset = priceOffsets[this.reversalOrdersPlaced] ?? priceOffsets[priceOffsets.length - 1];
    const limitPrice = Math.max(0.01, lowerPrice + offset);

    // Simulate new lower average
    const newLowerSize = lowerSize + roundedSize;
    const newLowerCost = effectiveAvgLower * lowerSize + limitPrice * roundedSize;
    const newLowerAvg = newLowerSize > 0 ? newLowerCost / newLowerSize : effectiveAvgLower;
    const newPairCost = effectiveAvgHigher + newLowerAvg;

    const newTotalSize = higherSize + newLowerSize;
    const newAsymRatio = newTotalSize > 0 ? Math.max(higherSize, newLowerSize) / newTotalSize : 0;
    const newMinQty = Math.min(higherSize, newLowerSize);

    // Calculate total USD cost
    const totalCost = effectiveAvgHigher * higherSize + effectiveAvgLower * lowerSize + limitPrice * roundedSize;
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
    this.lowerEntries.push({ price: limitPrice, size: roundedSize });

    return {
      action: yesIsHigher ? "BUY_NO" : "BUY_YES",
      tokenId: lowerTokenId,
      price: limitPrice,
      size: roundedSize,
      reason: `Liam Reversal: lower ${lowerPrice.toFixed(4)} ≥ ${(higherPrice + priceDiffThreshold).toFixed(
        4
      )}, buy ${roundedSize} @ ${limitPrice.toFixed(4)} (order ${this.reversalOrdersPlaced}/3)`,
    };
  }

  private computeHigherAddSize(currentPrice: number, avgHigher: number): number {
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
    // 80–150 shares, targeting ~70% of higher qty
    const baseMin = 80;
    const baseMax = 150;
    const targetLowerSize = Math.floor(higherSize * 0.7);
    const needed = targetLowerSize - lowerSize;
    if (needed <= 0) return 0;
    return Math.min(baseMax, Math.max(baseMin, needed));
  }

  /**
   * Simulate adding to either higher or lower leg and enforce global guards:
   * - new_pair_cost < current_pair_cost (if current_pair_cost > 0)
   * - new_balance_ratio ≥ minBalanceRatio
   * - new_asym_ratio ≤ maxAsymRatio
   * - If enforceHedgeConstraints:
   *   - new_pair_cost ≤ targetPairCost
   *   - new_min(qty) > total_cost_in_shares × 1.02 (FIXED: compares shares to shares)
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
      const newHigherCost = effectiveAvgHigher * higherSize + addPrice * addSize;
      newHigherAvg = newHigherSize > 0 ? newHigherCost / newHigherSize : effectiveAvgHigher;
    } else {
      newLowerSize = lowerSize + addSize;
      const newLowerCost = effectiveAvgLower * lowerSize + addPrice * addSize;
      newLowerAvg = newLowerSize > 0 ? newLowerCost / newLowerSize : effectiveAvgLower;
    }

    const newPairCost = newHigherAvg + newLowerAvg;
    const newTotalSize = newHigherSize + newLowerSize;
    const newAsymRatio =
      newTotalSize > 0 ? Math.max(newHigherSize, newLowerSize) / newTotalSize : 0;
    const newBalanceRatio =
      newTotalSize > 0 && Math.max(newHigherSize, newLowerSize) > 0
        ? Math.min(newHigherSize, newLowerSize) / Math.max(newHigherSize, newLowerSize)
        : 0;

    // Require improving or first-time pair cost, OR if new pair cost is already good (≤targetPairCost)
    // This allows hedges when pair cost is already acceptable even if it doesn't improve
    if (currentPairCost > 0 && newPairCost >= currentPairCost && newPairCost > targetPairCost) {
      return false;
    }

    // Balance ratio check: allow first hedge (when lowerSize === 0) with relaxed threshold
    // For first hedge, balance will be 0, so we need to allow it
    const isFirstHedge = (side === "LOWER" && lowerSize === 0) || (side === "HIGHER" && higherSize === 0);
    if (!isFirstHedge && newBalanceRatio < minBalanceRatio) {
      return false;
    }

    if (newAsymRatio > maxAsymRatio) {
      return false;
    }

    if (enforceHedgeConstraints) {
      if (newPairCost > targetPairCost) {
        return false;
      }

      const newMinQty = Math.min(newHigherSize, newLowerSize);
      // Calculate total USD cost
      const totalCost = effectiveAvgHigher * higherSize + effectiveAvgLower * lowerSize + addPrice * addSize;
      // Convert total cost to equivalent pair shares: total_cost / pair_cost
      // This represents how many pairs we could theoretically buy with that money
      const equivalentPairShares = newPairCost > 0 ? totalCost / newPairCost : 0;
      
      // Ensure minimum side has at least 1.02x the equivalent pair shares
      if (newMinQty <= equivalentPairShares * 1.02) {
        return false;
      }
    }

    return true;
  }

  private calculateWeightedAverage(entries: Array<{ price: number; size: number }>): number {
    if (entries.length === 0) return 0;
    const totalCost = entries.reduce((sum, e) => sum + e.price * e.size, 0);
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    return totalSize > 0 ? totalCost / totalSize : 0;
  }
}

