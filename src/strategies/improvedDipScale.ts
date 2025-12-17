import { TradingStrategy, TradingDecision, StrategyContext } from "./base";
import { TokenPrice, Position } from "../utils/marketData";

/**
 * Improved Dip-Scale Strategy: Enhanced three-phase entry/build/lock with reversal trigger
 * 
 * Phase 1 (0-3min): Entry/Probe - Configurable probe on higher leg
 * Phase 2 (3-9min): Build/Hedge - Avg-down higher, add lower on dips
 * Phase 3 (9-15min): Lock/Exit - Hold if conditions met
 * Reversal Trigger (after 2min, ≥6min left): Buy lower leg when it flips higher
 */
export class ImprovedDipScaleStrategy extends TradingStrategy {
  name = "improvedipscale";
  description = "Enhanced dip-scaling strategy with configurable parameters and reversal trigger";

  // Track entry prices with sizes for weighted averages
  private higherEntries: Array<{ price: number; size: number }> = [];
  private lowerEntries: Array<{ price: number; size: number }> = [];
  private higherLeg: "YES" | "NO" | null = null;
  private lastReversalCheck: number = 0; // Timestamp of last reversal check
  private reversalOrdersPlaced: number = 0; // Track ladder orders

  reset(): void {
    this.higherEntries = [];
    this.lowerEntries = [];
    this.higherLeg = null;
    this.lastReversalCheck = 0;
    this.reversalOrdersPlaced = 0;
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
    if (this.higherLeg === null && higherPrice >= this.getConfigValue(config, "phase1MinHigherPrice", 0.52)) {
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
    const pairCost = effectiveAvgHigher + effectiveAvgLower;
    const totalSize = higherSize + lowerSize;
    const asymRatio = totalSize > 0 ? Math.max(higherSize, lowerSize) / totalSize : 0;
    const balanceRatio = totalSize > 0 ? Math.min(higherSize, lowerSize) / Math.max(higherSize, lowerSize) : 0;

    // Determine phase based on time (for 15min markets)
    const timeUntilEndMs = timeUntilEnd || 0;
    const minutesRemaining = timeUntilEndMs / (60 * 1000);
    const secondsRemaining = timeUntilEndMs / 1000;

    // When only one side is open, there is no completed hedge yet.
    const currentPairCost = higherSize > 0 && lowerSize > 0 ? pairCost : 0;

    // Reversal Buy Trigger (after 2min, check every 1s, ≥6min left)
    // After 2 minutes means: 15min - 2min = 13min remaining, check until 6min remaining
    if (minutesRemaining >= 6 && minutesRemaining <= 13) {
      const now = Date.now();
      // Check every 1 second
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

    if (minutesRemaining > 12) {
      // Phase 1: Entry/Probe (0-3min)
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
      // Phase 2: Build/Hedge (3-9min)
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
      // Phase 3: Lock/Exit (9-15min)
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
   * Configurable parameters:
   * - phase1MinHigherPrice: Minimum higher leg price (default 0.52)
   * - phase1MaxHigherPrice: Maximum higher leg price (default 0.59)
   * - phase1ProbeSizeMin: Minimum probe size (default 10)
   * - phase1ProbeSizeMax: Maximum probe size (default 30)
   * - phase1MaxProjectedAvg: Maximum projected average (default 0.60)
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
    const probeSizeMin = this.getConfigValue(config, "phase1ProbeSizeMin", 10);
    const probeSizeMax = this.getConfigValue(config, "phase1ProbeSizeMax", 30);
    const maxProjectedAvg = this.getConfigValue(config, "phase1MaxProjectedAvg", 0.60);

    // Only probe if higher leg is within range
    if (higherPrice < minHigherPrice || higherPrice > maxHigherPrice) {
      return null;
    }

    // Check if we already have a position
    if (this.higherEntries.length > 0) {
      return null; // Already entered
    }

    // Projected average must be below threshold
    const probeSize = Math.floor((probeSizeMin + probeSizeMax) / 2); // Middle of range
    const projectedAvg = higherPrice; // First entry, so avg = price
    if (projectedAvg >= maxProjectedAvg) {
      return null;
    }

    // Record entry
    this.higherEntries.push({ price: higherPrice, size: probeSize });

    return {
      action: yesIsHigher ? "BUY_YES" : "BUY_NO",
      tokenId: higherTokenId,
      price: higherPrice,
      size: probeSize,
      reason: `Phase1 Probe: Buying higher leg @ ${higherPrice.toFixed(4)} (probe ${probeSize} shares, config: min=${minHigherPrice}, max=${maxHigherPrice})`,
    };
  }

  /**
   * Phase 2: Build/Hedge (3-9min)
   * Configurable parameters:
   * - phase2DipThreshold: Dip threshold in cents (default 0.025 = 2.5¢)
   * - phase2LowerDipPrice: Maximum lower leg price for dip buy (default 0.48)
   * - phase2AddSizeMin: Minimum add size for higher leg (default 40)
   * - phase2AddSizeMax: Maximum add size for higher leg (default 120)
   * - phase2LowerSizeMin: Minimum lower leg size (default 80)
   * - phase2LowerSizeMax: Maximum lower leg size (default 150)
   * - phase2LowerSizeRatio: Ratio of lower to higher (default 0.7)
   * - phase2TargetPairCost: Target pair cost (default 0.965)
   * - phase2MinBalanceRatio: Minimum balance ratio (default 0.75)
   * - phase2MaxAsymRatio: Maximum asymmetry ratio (default 0.75)
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
    const dipThreshold = this.getConfigValue(config, "phase2DipThreshold", 0.025);
    const lowerDipPrice = this.getConfigValue(config, "phase2LowerDipPrice", 0.48);
    const addSizeMin = this.getConfigValue(config, "phase2AddSizeMin", 40);
    const addSizeMax = this.getConfigValue(config, "phase2AddSizeMax", 120);
    const lowerSizeMin = this.getConfigValue(config, "phase2LowerSizeMin", 80);
    const lowerSizeMax = this.getConfigValue(config, "phase2LowerSizeMax", 150);
    const lowerSizeRatio = this.getConfigValue(config, "phase2LowerSizeRatio", 0.7);

    // Check for higher leg avg-down opportunity
    if (avgHigher > 0 && higherPrice <= avgHigher - dipThreshold) {
      const dipAmount = avgHigher - higherPrice;
      // Bigger size on bigger reversion
      const sizeMultiplier = Math.min(4, Math.floor(dipAmount / 0.01)); // Up to 4x base
      const addSize = Math.min(addSizeMax, addSizeMin + (sizeMultiplier * 20));

      // Simulate new weighted average
      const totalHigherSize = higherSize + addSize;
      const totalHigherCost = avgHigher * higherSize + higherPrice * addSize;
      const newHigherAvg = totalHigherSize > 0 ? totalHigherCost / totalHigherSize : avgHigher;
      
      // New pair cost = newHigherAvg + effectiveAvgLower
      const newPairCost = newHigherAvg + effectiveAvgLower;

      if (newPairCost < currentPairCost || currentPairCost === 0) {
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
    if (lowerPrice <= lowerDipPrice && lowerSize < higherSize * lowerSizeRatio) {
      // Buy to match target ratio
      const targetLowerSize = Math.floor(higherSize * lowerSizeRatio);
      const addSize = Math.min(lowerSizeMax, Math.max(lowerSizeMin, targetLowerSize - lowerSize));

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
   * Phase 3: Lock/Exit (9-15min)
   * Configurable parameters:
   * - phase3TargetPairCost: Target pair cost (default 0.965)
   * - phase3MinBalanceRatio: Minimum balance ratio (default 0.75)
   * - phase3MaxAsymRatio: Maximum asymmetry ratio (default 0.75)
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
        reason: `Phase3 Lock: pair_cost=${pairCost.toFixed(4)} ≤ ${targetPairCost}, balance=${balanceRatio.toFixed(2)} ≥ ${minBalanceRatio}, asym=${asymRatio.toFixed(2)} ≤ ${maxAsymRatio}`,
      };
    }

    return null;
  }

  /**
   * Reversal Buy Trigger (after 2min, check every 1s, ≥6min left)
   * Detection: IF current lower leg price ≥ 0.08 higher than current higher leg price
   *            AND balance_ratio <0.80
   * Action: Ladder buy 25–40% of current lower-leg quantity using 2–3 limit orders
   *         spaced at current_ask –0.02, –0.03, –0.05
   * Execute only if:
   * - New pair_cost ≤0.965
   * - New min(qty) > projected total_cost × 1.02
   * - New asym_ratio ≤0.75
   * 
   * Configurable parameters:
   * - reversalPriceDiff: Price difference threshold (default 0.08)
   * - reversalBalanceRatioThreshold: Balance ratio threshold (default 0.80)
   * - reversalBuyRatioMin: Minimum buy ratio (default 0.25)
   * - reversalBuyRatioMax: Maximum buy ratio (default 0.40)
   * - reversalTargetPairCost: Target pair cost (default 0.965)
   * - reversalMinQtyMultiplier: Min qty multiplier (default 1.02)
   * - reversalMaxAsymRatio: Max asymmetry ratio (default 0.75)
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
    const priceDiffThreshold = this.getConfigValue(config, "reversalPriceDiff", 0.08);
    const balanceRatioThreshold = this.getConfigValue(config, "reversalBalanceRatioThreshold", 0.80);
    const buyRatioMin = this.getConfigValue(config, "reversalBuyRatioMin", 0.25);
    const buyRatioMax = this.getConfigValue(config, "reversalBuyRatioMax", 0.40);
    const targetPairCost = this.getConfigValue(config, "reversalTargetPairCost", 0.965);
    const minQtyMultiplier = this.getConfigValue(config, "reversalMinQtyMultiplier", 1.02);
    const maxAsymRatio = this.getConfigValue(config, "reversalMaxAsymRatio", 0.75);

    // Detection: lower leg price ≥ 0.08 higher than higher leg price
    const priceDiff = lowerPrice - higherPrice;
    if (priceDiff < priceDiffThreshold) {
      return null; // Price difference not met
    }

    // AND balance_ratio <0.80
    if (balanceRatio >= balanceRatioThreshold) {
      return null; // Balance ratio too high
    }

    // Need to have a lower leg position to buy more
    if (lowerSize === 0) {
      return null;
    }

    // Stop if we've already placed all 3 ladder orders
    if (this.reversalOrdersPlaced >= 3) {
      return null; // Already placed all ladder orders
    }

    // Calculate buy size: 25–40% of current lower-leg quantity
    const buyRatio = buyRatioMin + (this.reversalOrdersPlaced * 0.05); // Increase with each order
    const targetBuySize = Math.floor(lowerSize * Math.min(buyRatioMax, buyRatio));
    
    // Round to nearest 10-50 shares
    const roundedSize = Math.max(10, Math.min(50, Math.round(targetBuySize / 10) * 10));
    
    // Ladder prices: current_ask –0.02, –0.03, –0.05
    const priceOffsets = [-0.02, -0.03, -0.05];
    const limitPrice = Math.max(0.01, lowerPrice + priceOffsets[this.reversalOrdersPlaced]);

    // Simulate new position
    const newLowerSize = lowerSize + roundedSize;
    const newLowerCost = (effectiveAvgLower * lowerSize) + (limitPrice * roundedSize);
    const newLowerAvg = newLowerSize > 0 ? newLowerCost / newLowerSize : effectiveAvgLower;
    const newPairCost = effectiveAvgHigher + newLowerAvg;

    // Calculate new metrics
    const newTotalSize = higherSize + newLowerSize;
    const newAsymRatio = newTotalSize > 0 ? Math.max(higherSize, newLowerSize) / newTotalSize : 0;
    const newMinQty = Math.min(higherSize, newLowerSize);
    const projectedTotalCost = newPairCost * newTotalSize;

    // Execute only if conditions met:
    // 1. New pair_cost ≤0.965
    if (newPairCost > targetPairCost) {
      return null;
    }

    // 2. New min(qty) > projected total_cost × 1.02
    if (newMinQty <= projectedTotalCost * minQtyMultiplier) {
      return null;
    }

    // 3. New asym_ratio ≤0.75
    if (newAsymRatio > maxAsymRatio) {
      return null;
    }

    // Record the order
    this.reversalOrdersPlaced++;
    this.lowerEntries.push({ price: limitPrice, size: roundedSize });

    return {
      action: yesIsHigher ? "BUY_NO" : "BUY_YES",
      tokenId: lowerTokenId,
      price: limitPrice,
      size: roundedSize,
      reason: `Reversal Trigger: Lower leg ${lowerPrice.toFixed(4)} ≥ ${(higherPrice + priceDiffThreshold).toFixed(4)} (diff ${(priceDiff * 100).toFixed(2)}¢), buying ${roundedSize} @ ${limitPrice.toFixed(4)} (order ${this.reversalOrdersPlaced}/3)`,
    };
  }

  private calculateWeightedAverage(entries: Array<{ price: number; size: number }>): number {
    if (entries.length === 0) return 0;
    const totalCost = entries.reduce((sum, e) => sum + e.price * e.size, 0);
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    return totalSize > 0 ? totalCost / totalSize : 0;
  }

  /**
   * Helper to get config value with fallback to default
   * Supports both numeric config values and string-based lookups
   */
  private getConfigValue(config: StrategyContext["config"], key: string, defaultValue: number): number {
    const extendedConfig = config as any;
    if (extendedConfig[key] !== undefined) {
      return Number(extendedConfig[key]);
    }
    return defaultValue;
  }
}

