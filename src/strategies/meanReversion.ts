import { TradingStrategy, TradingDecision, StrategyContext } from "./base";

/**
 * Mean Reversion Strategy: Buys when price deviates significantly from 0.5
 * Assumes prices will revert to the mean
 */
export class MeanReversionStrategy extends TradingStrategy {
  name = "meanReversion";
  description = "Buys when price deviates from 0.5, expecting reversion to mean";

  private priceHistory: number[] = [];
  private readonly historySize = 20;

  execute(context: StrategyContext): TradingDecision | null {
    const { tokenPrice, yesTokenPrice, noTokenPrice, positions, config } = context;

    // Need both YES and NO prices for mean reversion strategy
    if (!yesTokenPrice || !noTokenPrice) {
      return null;
    }

    // Use YES price for mean calculation (NO price is inverse: 1 - YES)
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

    // Calculate mean
    const mean =
      this.priceHistory.reduce((a, b) => a + b, 0) / this.priceHistory.length;

    // Calculate standard deviation
    const variance =
      this.priceHistory.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) /
      this.priceHistory.length;
    const stdDev = Math.sqrt(variance);

    // Buy when price deviates significantly from mean (expecting reversion)
    const deviation = currentPrice - mean;
    const zScore = stdDev > 0 ? deviation / stdDev : 0;

    // Buy YES if price is significantly below mean (expecting reversion up)
    if (zScore < -1.5 && yesTokenPrice.askPrice < config.maxPrice && yesTokenPrice.askPrice >= config.minPrice) {
      const currentPosition = positions.find((p) => p.asset === yesTokenPrice.tokenId);
      const currentSize = currentPosition ? currentPosition.size : 0;

      if (currentSize < config.maxPositionSize) {
        return {
          action: "BUY_YES",
          tokenId: yesTokenPrice.tokenId,
          price: yesTokenPrice.askPrice,
          size: config.orderSize,
          reason: `Mean reversion: YES price ${currentPrice.toFixed(4)} is ${zScore.toFixed(2)} std dev below mean ${mean.toFixed(4)}`,
        };
      }
    }

    // Buy NO if YES price is significantly above mean (NO is cheap when YES is expensive)
    if (zScore > 1.5 && noTokenPrice.askPrice < config.maxPrice && noTokenPrice.askPrice >= config.minPrice) {
      const currentPosition = positions.find((p) => p.asset === noTokenPrice.tokenId);
      const currentSize = currentPosition ? currentPosition.size : 0;

      if (currentSize < config.maxPositionSize) {
        return {
          action: "BUY_NO",
          tokenId: noTokenPrice.tokenId,
          price: noTokenPrice.askPrice,
          size: config.orderSize,
          reason: `Mean reversion: YES price ${currentPrice.toFixed(4)} is ${zScore.toFixed(2)} std dev above mean ${mean.toFixed(4)}, buying NO`,
        };
      }
    }

    return null;
  }
}

