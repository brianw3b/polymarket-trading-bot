import { TradingStrategy, TradingDecision, StrategyContext } from "./base";

/**
 * Balanced Strategy: Buys both YES and NO shares when prices are favorable
 * This creates a balanced position that profits from volatility
 */
export class BalancedStrategy extends TradingStrategy {
  name = "balanced";
  description = "Buys both YES and NO shares to create balanced positions";

  execute(context: StrategyContext): TradingDecision | null {
    const { yesTokenPrice, noTokenPrice, positions, config } = context;

    if (!yesTokenPrice || !noTokenPrice) {
      return null;
    }

    const yesCost = yesTokenPrice.askPrice * config.orderSize;
    const noCost = noTokenPrice.askPrice * config.orderSize;
    const totalCost = yesCost + noCost;

    const profitThreshold = 0.98;

    const logData = {
      yesAsk: yesTokenPrice.askPrice.toFixed(4),
      noAsk: noTokenPrice.askPrice.toFixed(4),
      totalCost: totalCost.toFixed(4),
      threshold: profitThreshold,
      willBuy: totalCost < profitThreshold,
    };

    if (totalCost < profitThreshold) {
      const yesPosition = positions.find((p) => p.asset === yesTokenPrice.tokenId);
      const noPosition = positions.find((p) => p.asset === noTokenPrice.tokenId);

      const yesSize = yesPosition ? yesPosition.size : 0;
      const noSize = noPosition ? noPosition.size : 0;

      const sizeDifference = yesSize - noSize;
      const priceDifference = yesTokenPrice.askPrice - noTokenPrice.askPrice;
      
      const shouldBuyYes = sizeDifference < 0 || (sizeDifference === 0 && priceDifference < 0);

      if (shouldBuyYes && yesSize < config.maxPositionSize && 
          yesTokenPrice.askPrice >= config.minPrice && yesTokenPrice.askPrice <= config.maxPrice) {
        return {
          action: "BUY_YES",
          tokenId: yesTokenPrice.tokenId,
          price: yesTokenPrice.askPrice,
          size: config.orderSize,
          reason: `Balanced strategy: Buying YES at ${yesTokenPrice.askPrice.toFixed(4)} (total cost: ${totalCost.toFixed(4)})`,
        };
      }

      if (!shouldBuyYes && noSize < config.maxPositionSize && 
          noTokenPrice.askPrice >= config.minPrice && noTokenPrice.askPrice <= config.maxPrice) {
        return {
          action: "BUY_NO",
          tokenId: noTokenPrice.tokenId,
          price: noTokenPrice.askPrice,
          size: config.orderSize,
          reason: `Balanced strategy: Buying NO at ${noTokenPrice.askPrice.toFixed(4)} (total cost: ${totalCost.toFixed(4)})`,
        };
      }
    } else {
      const reason = `Total cost ${totalCost.toFixed(4)} >= threshold ${profitThreshold}`;
    }

    return null;
  }
}

