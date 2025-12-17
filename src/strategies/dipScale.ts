import { TradingStrategy, TradingDecision, StrategyContext } from "./base";
import { TokenPrice, Position } from "../utils/marketData";

/**
 * Dip-Scale Strategy: Three-phase entry/build/lock for 15-minute markets
 * 
 * Phase 1 (0-3min): Entry/Probe - Small probe on higher leg
 * Phase 2 (3-9min): Build/Hedge - Avg-down higher, add lower on dips
 * Phase 3 (9-15min): Lock/Exit - Hold if conditions met
 */
export class DipScaleStrategy extends TradingStrategy {
  name = "dipscale";
  description = "Three-phase dip-scaling strategy: probe → build/hedge → lock";

  // Track entry prices with sizes for weighted averages
  private higherEntries: Array<{ price: number; size: number }> = [];
  private lowerEntries: Array<{ price: number; size: number }> = [];
  private higherLeg: "YES" | "NO" | null = null;

  reset(): void {
    this.higherEntries = [];
    this.lowerEntries = [];
    this.higherLeg = null;
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

    // Calculate current position stats
    const higherPosition = positions.find((p) => p.asset === higherTokenId);
    const lowerPosition = positions.find((p) => p.asset === lowerTokenId);
    const higherSize = higherPosition?.size || 0;
    const lowerSize = lowerPosition?.size || 0;

    // Calculate weighted averages from entries
    const avgHigher = this.calculateWeightedAverage(this.higherEntries);
    const avgLower = this.calculateWeightedAverage(this.lowerEntries);
    
    // Use current prices if no entries yet
    const effectiveAvgHigher = avgHigher > 0 ? avgHigher : higherPrice;
    const effectiveAvgLower = avgLower > 0 ? avgLower : lowerPrice;

    // Calculate metrics
    // pair_cost = avgHigher + avgLower (cost to buy one share of each)
    const pairCost = effectiveAvgHigher + effectiveAvgLower;
    const totalSize = higherSize + lowerSize;
    const asymRatio = totalSize > 0 ? Math.max(higherSize, lowerSize) / totalSize : 0;
    const balanceRatio = totalSize > 0 ? Math.min(higherSize, lowerSize) / Math.max(higherSize, lowerSize) : 0;

    // Determine phase based on time (for 15min markets)
    const timeUntilEndMs = timeUntilEnd || 0;
    const minutesRemaining = timeUntilEndMs / (60 * 1000);

    // When only one side is open, there is no completed hedge yet.
    // Treat current pair cost as 0 so that the first opposite-side hedge
    // order is allowed when its own price condition is met.
    const currentPairCost =
      higherSize > 0 && lowerSize > 0 ? pairCost : 0;
    
    if (minutesRemaining > 12) {
      // Phase 1: Entry/Probe (0-3min: first 3 minutes of 15min market)
      return this.phase1EntryProbe(
        yesTokenPrice,
        noTokenPrice,
        higherTokenId,
        lowerTokenId,
        higherPrice,
        lowerPrice,
        yesIsHigher,
        config
      );
    } else if (minutesRemaining > 6) {
      // Phase 2: Build/Hedge (3-9min: minutes 3-9 of 15min market)
      return this.phase2BuildHedge(
        yesTokenPrice,
        noTokenPrice,
        higherTokenId,
        lowerTokenId,
        higherPrice,
        lowerPrice,
        higherSize,
        lowerSize,
        avgHigher,
        avgLower,
        effectiveAvgHigher,
        effectiveAvgLower,
        yesIsHigher,
        currentPairCost,
        config
      );
    } else {
      // Phase 3: Lock/Exit (9-15min: last 6 minutes of 15min market)
      return this.phase3LockExit(
        pairCost,
        balanceRatio,
        asymRatio,
        config
      );
    }
  }

  /**
   * Phase 1: Entry/Probe (0-3min)
   * - Identify higher leg (price ≥0.52)
   * - Limit buy 10-30 shares higher at ≤0.59 (small probe)
   * - Projected avg_higher <0.60 or skip
   */
  private phase1EntryProbe(
    yesTokenPrice: TokenPrice,
    noTokenPrice: TokenPrice,
    higherTokenId: string,
    lowerTokenId: string,
    higherPrice: number,
    lowerPrice: number,
    yesIsHigher: boolean,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    // Only probe if higher leg is ≥0.52 and ≤0.59
    if (higherPrice < 0.52 || higherPrice > 0.59) {
      return null;
    }

    // Check if we already have a position
    if (this.higherEntries.length > 0) {
      return null; // Already entered
    }

    // Projected average must be <0.60
    const probeSize = 20; // Middle of 10-30 range
    const projectedAvg = higherPrice; // First entry, so avg = price
    if (projectedAvg >= 0.60) {
      return null;
    }

    // Record entry
    this.higherEntries.push({ price: higherPrice, size: probeSize });

    return {
      action: yesIsHigher ? "BUY_YES" : "BUY_NO",
      tokenId: higherTokenId,
      price: higherPrice,
      size: probeSize,
      reason: `Phase1 Probe: Buying higher leg @ ${higherPrice.toFixed(4)} (probe ${probeSize} shares)`,
    };
  }

  /**
   * Phase 2: Build/Hedge (3-9min)
   * - Avg-down higher if dips ≥2.5¢ from entry avg, ladder add 40-120 shares
   * - Add lower on ≤0.48 dip, buy 80-150 shares (match ~70% higher qty)
   * - Prioritize higher wobbles first, alternate with lower panic dips
   * - Target pair_cost ≤0.965; asym_ratio 0.60-0.75; balance_ratio ≥0.75
   * - Before adds: Sim new_pair_cost < current
   */
  private phase2BuildHedge(
    yesTokenPrice: TokenPrice,
    noTokenPrice: TokenPrice,
    higherTokenId: string,
    lowerTokenId: string,
    higherPrice: number,
    lowerPrice: number,
    higherSize: number,
    lowerSize: number,
    avgHigher: number,
    avgLower: number,
    effectiveAvgHigher: number,
    effectiveAvgLower: number,
    yesIsHigher: boolean,
    currentPairCost: number,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const dipThreshold = 0.025; // 2.5 cents
    const lowerDipPrice = 0.48;

    // Check for higher leg avg-down opportunity
    if (avgHigher > 0 && higherPrice <= avgHigher - dipThreshold) {
      const dipAmount = avgHigher - higherPrice;
      // Bigger size on bigger reversion
      const sizeMultiplier = Math.min(4, Math.floor(dipAmount / 0.01)); // Up to 4x base
      const addSize = Math.min(120, 40 + (sizeMultiplier * 20)); // 40-120 range

      // Simulate new weighted average
      const totalHigherSize = higherSize + addSize;
      const totalHigherCost = avgHigher * higherSize + higherPrice * addSize;
      const newHigherAvg = totalHigherSize > 0 ? totalHigherCost / totalHigherSize : avgHigher;
      
      // New pair cost = newHigherAvg + effectiveAvgLower
      const newPairCost = newHigherAvg + effectiveAvgLower;

      if (newPairCost < currentPairCost) {
        this.higherEntries.push({ price: higherPrice, size: addSize });

        return {
          action: yesIsHigher ? "BUY_YES" : "BUY_NO",
          tokenId: higherTokenId,
          price: higherPrice,
          size: addSize,
          reason: `Phase2 Avg-Down Higher: Dip ${(dipAmount * 100).toFixed(2)}¢ from avg ${avgHigher.toFixed(4)}, adding ${addSize} shares`,
        };
      }
    }

    // Check for lower leg dip opportunity
    if (lowerPrice <= lowerDipPrice && lowerSize < higherSize * 0.7) {
      // Buy 80-150 shares to match ~70% of higher qty
      const targetLowerSize = Math.floor(higherSize * 0.7);
      const addSize = Math.min(150, Math.max(80, targetLowerSize - lowerSize));

      // Simulate new weighted average
      const totalLowerSize = lowerSize + addSize;
      const totalLowerCost = (avgLower > 0 ? avgLower * lowerSize : 0) + lowerPrice * addSize;
      const newLowerAvg = totalLowerSize > 0 ? totalLowerCost / totalLowerSize : lowerPrice;
      
      // New pair cost = effectiveAvgHigher + newLowerAvg
      const newPairCost = effectiveAvgHigher + newLowerAvg;

      if (newPairCost < currentPairCost || currentPairCost === 0) {
        this.lowerEntries.push({ price: lowerPrice, size: addSize });

        return {
          action: yesIsHigher ? "BUY_NO" : "BUY_YES",
          tokenId: lowerTokenId,
          price: lowerPrice,
          size: addSize,
          reason: `Phase2 Lower Dip: Buying lower @ ${lowerPrice.toFixed(4)} (target ${targetLowerSize}, adding ${addSize})`,
        };
      }
    }

    return null;
  }

  /**
   * Phase 3: Lock/Exit (9-15min, actually 0-3min remaining)
   * - Hold to Settlement if pair_cost ≤0.965 and balance_ratio ≥0.75
   */
  private phase3LockExit(
    pairCost: number,
    balanceRatio: number,
    asymRatio: number,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const targetPairCost = 0.965;
    const minBalanceRatio = 0.75;
    const maxAsymRatio = 0.75;

    if (pairCost <= targetPairCost && balanceRatio >= minBalanceRatio && asymRatio <= maxAsymRatio) {
      return {
        action: "HOLD",
        tokenId: "", // Not used for HOLD
        price: 0,
        size: 0,
        reason: `Phase3 Lock: pair_cost=${pairCost.toFixed(4)} ≤ ${targetPairCost}, balance=${balanceRatio.toFixed(2)} ≥ ${minBalanceRatio}, asym=${asymRatio.toFixed(2)} ≤ ${maxAsymRatio}`,
      };
    }

    return null; // Conditions not met, no action
  }

  private calculateWeightedAverage(entries: Array<{ price: number; size: number }>): number {
    if (entries.length === 0) return 0;
    const totalCost = entries.reduce((sum, e) => sum + e.price * e.size, 0);
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    return totalSize > 0 ? totalCost / totalSize : 0;
  }
}

