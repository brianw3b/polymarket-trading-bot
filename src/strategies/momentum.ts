import { TradingStrategy, TradingDecision, StrategyContext } from "./base";

/**
 * Momentum Strategy: Buys when price is trending in a direction
 * Follows the trend expecting it to continue
 */
export class MomentumStrategy extends TradingStrategy {
  name = "momentum";
  description = "Buys when price shows strong momentum in a direction";

  private priceHistory: number[] = [];
  private readonly historySize = 10;

  execute(context: StrategyContext): TradingDecision | null {
    const { tokenPrice, yesTokenPrice, noTokenPrice, positions, config } = context;

    // Need both YES and NO prices for momentum strategy
    if (!yesTokenPrice || !noTokenPrice) {
      return null;
    }

    // Use YES price for momentum calculation
    const currentPrice = yesTokenPrice.midPrice;
    
    // Add current price to history
    this.priceHistory.push(currentPrice);
    if (this.priceHistory.length > this.historySize) {
      this.priceHistory.shift();
    }

    // Need at least 5 data points
    if (this.priceHistory.length < 5) {
      return null;
    }

    // Calculate momentum (rate of change)
    const recentPrices = this.priceHistory.slice(-5);
    const olderPrices = this.priceHistory.slice(0, 5);

    const recentAvg =
      recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const olderAvg = olderPrices.reduce((a, b) => a + b, 0) / olderPrices.length;

    const momentum = recentAvg - olderAvg;
    const momentumStrength = Math.abs(momentum);
    const minMomentum = 0.02; // Minimum momentum threshold

    // Strong upward momentum - buy YES
    if (momentum > minMomentum && momentumStrength > minMomentum) {
      if (yesTokenPrice.askPrice < config.maxPrice && yesTokenPrice.askPrice >= config.minPrice) {
        const currentPosition = positions.find((p) => p.asset === yesTokenPrice.tokenId);
        const currentSize = currentPosition ? currentPosition.size : 0;

        if (currentSize < config.maxPositionSize) {
          return {
            action: "BUY_YES",
            tokenId: yesTokenPrice.tokenId,
            price: yesTokenPrice.askPrice,
            size: config.orderSize,
            reason: `Momentum: Strong upward trend (momentum: ${momentum.toFixed(4)})`,
          };
        }
      }
    }

    // Strong downward momentum - buy NO (when YES price is falling, NO is rising)
    if (momentum < -minMomentum && momentumStrength > minMomentum) {
      if (noTokenPrice.askPrice < config.maxPrice && noTokenPrice.askPrice >= config.minPrice) {
        const currentPosition = positions.find((p) => p.asset === noTokenPrice.tokenId);
        const currentSize = currentPosition ? currentPosition.size : 0;

        if (currentSize < config.maxPositionSize) {
          return {
            action: "BUY_NO",
            tokenId: noTokenPrice.tokenId,
            price: noTokenPrice.askPrice,
            size: config.orderSize,
            reason: `Momentum: Strong downward trend in YES (momentum: ${momentum.toFixed(4)}), buying NO`,
          };
        }
      }
    }

    return null;
  }
}

