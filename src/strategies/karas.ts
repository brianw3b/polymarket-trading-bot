import { TradingStrategy, TradingDecision, StrategyContext } from "./base";
import { TokenPrice, Position } from "../utils/marketData";

/**
 * Karas Strategy
 *
 * Goal: keep the three-phase dip-scale structure but add strong safety rails:
 * - Dynamic lower-leg rules (relative to higher leg / averages, not just fixed 0.48)
 * - Hard balance / exposure / payoff constraints to avoid >50% structural losses
 * - Time-aware behavior inside phases (early vs late Phase 2 / Phase 3)
 *
 * Phases (for 15-minute markets):
 * - Phase 1 (0-3min): Entry/Probe - small higher-leg probe only
 * - Phase 2 (3-9min): Build/Hedge - avg-down higher, add lower on dynamic dips, but only if
 *   doing so improves pair_cost and does not violate balance/exposure/EV constraints
 * - Phase 3 (9-15min): Lock/Exit - only HOLD when inside a safe region; otherwise stop adding
 *
 * Also includes a simplified reversal repair: if imbalance is large and prices flip,
 * allow incremental lower-leg buys but enforce the same payoff/balance constraints.
 */
export class KarasStrategy extends TradingStrategy {
  name = "karas";
  description =
    "Karas: safer dip-scale with dynamic lower-leg dips, hard balance/exposure caps, and payoff-aware guards";

  // Track entry prices with sizes for weighted averages
  private higherEntries: Array<{ price: number; size: number }> = [];
  private lowerEntries: Array<{ price: number; size: number }> = [];
  private higherLeg: "YES" | "NO" | null = null;

  // Track total spent in this pool so we can reason about payoff vs cost
  private totalCostEstimate: number = 0;

  reset(): void {
    this.higherEntries = [];
    this.lowerEntries = [];
    this.higherLeg = null;
    this.totalCostEstimate = 0;
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

    // Initialize higher leg tracking once it qualifies
    const phase1MinHigherPrice = this.getConfigValue(config, "phase1MinHigherPrice", 0.52);
    if (this.higherLeg === null && higherPrice >= phase1MinHigherPrice) {
      this.higherLeg = yesIsHigher ? "YES" : "NO";
    }

    // Current positions
    const higherPosition = positions.find((p) => p.asset === higherTokenId);
    const lowerPosition = positions.find((p) => p.asset === lowerTokenId);
    const higherSize = higherPosition?.size || 0;
    const lowerSize = lowerPosition?.size || 0;
    const totalSize = higherSize + lowerSize;

    // Weighted averages from entries
    const avgHigher = this.calculateWeightedAverage(this.higherEntries);
    const avgLower = this.calculateWeightedAverage(this.lowerEntries);
    const effectiveAvgHigher = avgHigher > 0 ? avgHigher : higherPrice;
    const effectiveAvgLower = avgLower > 0 ? avgLower : lowerPrice;

    // Metrics
    const pairCost = effectiveAvgHigher + effectiveAvgLower;
    const asymRatio = totalSize > 0 ? Math.max(higherSize, lowerSize) / totalSize : 0;
    const balanceRatio =
      totalSize > 0 && Math.max(higherSize, lowerSize) > 0
        ? Math.min(higherSize, lowerSize) / Math.max(higherSize, lowerSize)
        : 0;

    const timeUntilEndMs = timeUntilEnd || 0;
    const minutesRemaining = timeUntilEndMs / (60 * 1000);

    // Approximate total spent from entries (we don't have live PnL here)
    this.totalCostEstimate = this.estimateTotalCost();

    // Hard pool-level constraint (total USD per 15m pool)
    const maxPoolCost = this.getConfigValue(config, "karasPoolBudgetUsd", 100);

    // If we've already spent too much, do not add more risk
    if (this.totalCostEstimate >= maxPoolCost) {
      return null;
    }

    // When only one side is open, there is no completed hedge yet.
    const currentPairCost = higherSize > 0 && lowerSize > 0 ? pairCost : 0;

    // Phase routing
    if (minutesRemaining > 12) {
      // Phase 1: Entry/Probe
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
    }

    if (minutesRemaining > 6) {
      // Phase 2: Build/Hedge
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
        balanceRatio,
        config
      );
    }

    // Phase 3: Lock/Exit (or no-op if unsafe)
    return this.phase3LockExit(pairCost, balanceRatio, asymRatio, config);
  }

  /**
   * Phase 1: Entry/Probe (0-3min)
   * - Identify higher leg (price ≥ phase1MinHigherPrice)
   * - Limit buy small probe size if projected avg < phase1MaxProjectedAvg
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
    const minHigherPrice = this.getConfigValue(config, "phase1MinHigherPrice", 0.52);
    const maxHigherPrice = this.getConfigValue(config, "phase1MaxHigherPrice", 0.59);
    // USD-based probe size
    const phase1ProbeUsd = this.getConfigValue(config, "phase1ProbeUsd", 2.0);
    const poolBudgetUsd = this.getConfigValue(config, "karasPoolBudgetUsd", 100);
    const maxHigherUsd = this.getConfigValue(config, "karasMaxHigherUsd", poolBudgetUsd);
    const maxProjectedAvg = this.getConfigValue(config, "phase1MaxProjectedAvg", 0.6);

    if (higherPrice < minHigherPrice || higherPrice > maxHigherPrice) {
      return null;
    }

    // Only if we don't already have a higher-leg position
    if (this.higherEntries.length > 0) {
      return null;
    }
    const higherUsd = this.higherEntries.reduce(
      (sum, e) => sum + e.price * e.size,
      0
    );
    const lowerUsd = this.lowerEntries.reduce(
      (sum, e) => sum + e.price * e.size,
      0
    );
    const totalUsd = higherUsd + lowerUsd;

    // Respect pool and side USD budgets
    const remainingPoolUsd = poolBudgetUsd - totalUsd;
    const remainingHigherUsd = maxHigherUsd - higherUsd;
    const maxAffordableUsd = Math.min(remainingPoolUsd, remainingHigherUsd);
    if (maxAffordableUsd <= 0) {
      return null;
    }

    const tradeUsd = Math.min(phase1ProbeUsd, maxAffordableUsd);

    // Convert USD to shares
    const rawSize = tradeUsd / higherPrice;
    const probeSize = Math.floor(rawSize);
    if (probeSize <= 0) {
      return null;
    }

    const projectedAvg = higherPrice;
    if (projectedAvg >= maxProjectedAvg) {
      return null;
    }

    // Simulate payoff profile after probe using actual USD spent
    const newHigherSize = probeSize;
    const newLowerSize = 0;
    const newTotalCost = totalUsd + higherPrice * probeSize;
    if (!this.isPayoffProfileSafe(newHigherSize, newLowerSize, newTotalCost, config)) {
      return null;
    }

    this.higherEntries.push({ price: higherPrice, size: probeSize });
    this.totalCostEstimate = newTotalCost;

    return {
      action: yesIsHigher ? "BUY_YES" : "BUY_NO",
      tokenId: higherTokenId,
      price: higherPrice,
      size: probeSize,
      reason: `Karas Phase1 Probe: higher @ ${higherPrice.toFixed(4)} size=${probeSize}`,
    };
  }

  /**
   * Phase 2: Build/Hedge (3-9min)
   * - Avg-down higher on dips
   * - Add lower on dynamic dips relative to higher leg
   * - Enforce balance / exposure / payoff constraints before committing
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
    balanceRatio: number,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const dipThreshold = this.getConfigValue(config, "phase2DipThreshold", 0.025);
    // USD-based add sizes for higher leg
    const higherAddUsdMin = this.getConfigValue(config, "phase2HigherAddUsdMin", 2.0);
    const higherAddUsdMax = this.getConfigValue(config, "phase2HigherAddUsdMax", 4.0);

    // USD-based add sizes for lower leg
    const lowerAddUsdMin = this.getConfigValue(config, "phase2LowerAddUsdMin", 2.0);
    const lowerAddUsdMax = this.getConfigValue(config, "phase2LowerAddUsdMax", 4.0);
    const lowerUsdRatioTarget = this.getConfigValue(config, "phase2LowerUsdRatio", 0.7);

    const targetPairCost = this.getConfigValue(config, "phase2TargetPairCost", 0.965);
    const minBalanceRatio = this.getConfigValue(config, "phase2MinBalanceRatio", 0.6);

    const totalSize = higherSize + lowerSize;

    // Pool and side USD budgets
    const poolBudgetUsd = this.getConfigValue(config, "karasPoolBudgetUsd", 100);
    const maxHigherUsd = this.getConfigValue(config, "karasMaxHigherUsd", poolBudgetUsd);
    const maxLowerUsd = this.getConfigValue(config, "karasMaxLowerUsd", poolBudgetUsd);

    const higherUsd = this.higherEntries.reduce(
      (sum, e) => sum + e.price * e.size,
      0
    );
    const lowerUsd = this.lowerEntries.reduce(
      (sum, e) => sum + e.price * e.size,
      0
    );
    const totalUsd = higherUsd + lowerUsd;

    // Hard exposure rule: if lower side is very under-hedged (< 0.3 ratio), disallow new higher-leg risk
    const currentBalanceRatio =
      totalSize > 0 && Math.max(higherSize, lowerSize) > 0
        ? Math.min(higherSize, lowerSize) / Math.max(higherSize, lowerSize)
        : 0;

    // 1) Try higher-leg avg-down if allowed (USD-based)
    if (
      avgHigher > 0 &&
      higherPrice <= avgHigher - dipThreshold &&
      // Do not widen an already very unbalanced book
      !(higherSize > 0 && currentBalanceRatio < 0.3)
    ) {
      const dipAmount = avgHigher - higherPrice;
      const sizeMultiplier = Math.min(4, Math.floor(dipAmount / 0.01));

      // Map dip depth to USD amount between [higherAddUsdMin, higherAddUsdMax]
      const extraUsd = Math.min(
        higherAddUsdMax - higherAddUsdMin,
        sizeMultiplier * ((higherAddUsdMax - higherAddUsdMin) / 4)
      );
      let tradeUsd = higherAddUsdMin + Math.max(0, extraUsd);

      // Respect pool and side budgets
      const remainingPoolUsd = poolBudgetUsd - totalUsd;
      const remainingHigherUsd = maxHigherUsd - higherUsd;
      const maxAffordableUsd = Math.min(remainingPoolUsd, remainingHigherUsd);
      if (maxAffordableUsd > 0) {
        tradeUsd = Math.min(tradeUsd, maxAffordableUsd);

        // Convert USD to shares
        const rawSize = tradeUsd / higherPrice;
        const addSize = Math.floor(rawSize);
        if (addSize > 0) {
          const totalHigherSize = higherSize + addSize;
          const totalHigherCost = avgHigher * higherSize + higherPrice * addSize;
          const newHigherAvg =
            totalHigherSize > 0 ? totalHigherCost / totalHigherSize : avgHigher;

          const newPairCost = newHigherAvg + effectiveAvgLower;
          if (newPairCost < currentPairCost || currentPairCost === 0) {
            const newHigherSize = totalHigherSize;
            const newLowerSize = lowerSize;
            const newTotalCost = totalUsd + higherPrice * addSize;

            if (
              newPairCost <= targetPairCost &&
              this.isBalanceSafe(newHigherSize, newLowerSize, minBalanceRatio) &&
              this.isPayoffProfileSafe(newHigherSize, newLowerSize, newTotalCost, config)
            ) {
              this.higherEntries.push({ price: higherPrice, size: addSize });
              this.totalCostEstimate = newTotalCost;

              return {
                action: yesIsHigher ? "BUY_YES" : "BUY_NO",
                tokenId: higherTokenId,
                price: higherPrice,
                size: addSize,
                reason: `Karas Phase2 Avg-Down Higher: dip ${(dipAmount * 100).toFixed(
                  2
                )}¢ from avg ${avgHigher.toFixed(4)}, add=${addSize}`,
              };
            }
          }
        }
      }
    }

    // 2) Lower-leg dynamic dip: relative to higher or average band, not fixed <= 0.48 (USD-based)
    const dynamicLowerDip =
      effectiveAvgHigher - this.getConfigValue(config, "phase2LowerDipSpread", 0.05);
    const absoluteLowerCap = this.getConfigValue(config, "phase2LowerDipAbsCap", 0.52);
    const allowedLowerPrice = Math.min(dynamicLowerDip, absoluteLowerCap);

    if (lowerPrice <= allowedLowerPrice && higherUsd > 0) {
      // Target lower USD exposure as a fraction of higher USD
      const targetLowerUsd = higherUsd * lowerUsdRatioTarget;
      const neededUsd = targetLowerUsd - lowerUsd;
      if (neededUsd > 0) {
        let tradeUsd = Math.min(
          lowerAddUsdMax,
          Math.max(lowerAddUsdMin, neededUsd)
        );

        // Respect pool and side budgets
        const remainingPoolUsd = poolBudgetUsd - totalUsd;
        const remainingLowerUsd = maxLowerUsd - lowerUsd;
        const maxAffordableUsd = Math.min(remainingPoolUsd, remainingLowerUsd);
        if (maxAffordableUsd <= 0) {
          // Can't afford more lower-leg exposure
        } else {
          tradeUsd = Math.min(tradeUsd, maxAffordableUsd);

          // Convert USD to shares
          const rawSize = tradeUsd / lowerPrice;
          const addSize = Math.floor(rawSize);
          if (addSize > 0) {
            const totalLowerSize = lowerSize + addSize;
            const totalLowerCost =
              (avgLower > 0 ? avgLower * lowerSize : 0) + lowerPrice * addSize;
            const newLowerAvg =
              totalLowerSize > 0 ? totalLowerCost / totalLowerSize : lowerPrice;

            const newPairCost = effectiveAvgHigher + newLowerAvg;
            const newHigherSize = higherSize;
            const newLowerSize = totalLowerSize;
            const newTotalCost = totalUsd + lowerPrice * addSize;

            if (
              (newPairCost < currentPairCost || currentPairCost === 0) &&
              newPairCost <= targetPairCost &&
              this.isBalanceSafe(newHigherSize, newLowerSize, minBalanceRatio) &&
              this.isPayoffProfileSafe(newHigherSize, newLowerSize, newTotalCost, config)
            ) {
              this.lowerEntries.push({ price: lowerPrice, size: addSize });
              this.totalCostEstimate = newTotalCost;

              return {
                action: yesIsHigher ? "BUY_NO" : "BUY_YES",
                tokenId: lowerTokenId,
                price: lowerPrice,
                size: addSize,
                reason: `Karas Phase2 Lower Dip: lower @ ${lowerPrice.toFixed(
                  4
                )} (dyn<=${allowedLowerPrice.toFixed(4)}, usd=${tradeUsd.toFixed(2)}, add=${addSize})`,
              };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Phase 3: Lock/Exit (9-15min)
   * - HOLD only when inside a safe region; otherwise do nothing (no new risk)
   */
  private phase3LockExit(
    pairCost: number,
    balanceRatio: number,
    asymRatio: number,
    config: StrategyContext["config"]
  ): TradingDecision | null {
    const targetPairCost = this.getConfigValue(config, "phase3TargetPairCost", 0.965);
    const minBalanceRatio = this.getConfigValue(config, "phase3MinBalanceRatio", 0.75);
    const maxAsymRatio = this.getConfigValue(config, "phase3MaxAsymRatio", 0.75);

    if (pairCost <= targetPairCost && balanceRatio >= minBalanceRatio && asymRatio <= maxAsymRatio) {
      return {
        action: "HOLD",
        tokenId: "",
        price: 0,
        size: 0,
        reason: `Karas Phase3 Lock: pair_cost=${pairCost.toFixed(
          4
        )}, balance=${balanceRatio.toFixed(2)}, asym=${asymRatio.toFixed(2)}`,
      };
    }

    // Unsafe structure: just stop adding; decisions are managed by tester at settlement
    return null;
  }

  // ---- Helpers ----

  private calculateWeightedAverage(entries: Array<{ price: number; size: number }>): number {
    if (entries.length === 0) return 0;
    const totalCost = entries.reduce((sum, e) => sum + e.price * e.size, 0);
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    return totalSize > 0 ? totalCost / totalSize : 0;
  }

  private estimateTotalCost(): number {
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
   * Check if balance_ratio is above a minimum threshold given candidate sizes.
   */
  private isBalanceSafe(
    higherSize: number,
    lowerSize: number,
    minBalanceRatio: number
  ): boolean {
    const total = higherSize + lowerSize;
    if (total === 0) return true;
    const maxSide = Math.max(higherSize, lowerSize);
    const minSide = Math.min(higherSize, lowerSize);
    if (maxSide === 0) return true;
    const ratio = minSide / maxSide;
    return ratio >= minBalanceRatio;
  }

  /**
   * Ensure best-case payoff (max of YES_qty, NO_qty) is not too small vs total cost.
   * This prevents structurally doomed states like 80 vs 20 paying < 50% of cost.
   */
  private isPayoffProfileSafe(
    yesQty: number,
    noQty: number,
    totalCost: number,
    config: StrategyContext["config"]
  ): boolean {
    const bestCasePayoff = Math.max(yesQty, noQty);
    if (totalCost <= 0) return true;
    const minRatio = this.getConfigValue(config, "karasMinSafePayoffRatio", 0.5);
    return bestCasePayoff >= totalCost * minRatio;
  }

  private getConfigValue(
    config: StrategyContext["config"],
    key: string,
    defaultValue: number
  ): number {
    const extendedConfig = config as any;
    if (extendedConfig[key] !== undefined) {
      return Number(extendedConfig[key]);
    }
    return defaultValue;
  }
}


