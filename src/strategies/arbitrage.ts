import { TradingStrategy, TradingDecision, StrategyContext } from "./base";

/**
 * Arbitrage Strategy: Buys YES and NO when combined cost is less than 1.0
 * This is a common strategy mentioned in trading communities
 * The idea is that YES + NO should equal 1.0, so if you can buy both for less,
 * you can profit regardless of outcome
 */
export class ArbitrageStrategy extends TradingStrategy {
  name = "arbitrage";
  description = "Buys YES and NO when combined cost < 1.0 (arbitrage opportunity)";

  execute(context: StrategyContext): TradingDecision | null {
    const { yesTokenPrice, noTokenPrice, positions, config } = context;

    if (!yesTokenPrice || !noTokenPrice) {
      return null;
    }

    // Calculate total cost to buy both YES and NO
    const yesCost = yesTokenPrice.askPrice * config.orderSize;
    const noCost = noTokenPrice.askPrice * config.orderSize;
    const totalCost = yesCost + noCost;

    // Arbitrage opportunity: if total cost < 1.0, we can profit
    // The profit margin is (1.0 - totalCost) * orderSize
    const profitMargin = 1.0 - totalCost;
    const minProfitMargin = 0.01; // At least 1% profit margin

    if (profitMargin > minProfitMargin) {
      // Check current positions
      const yesPosition = positions.find((p) => p.asset === yesTokenPrice.tokenId);
      const noPosition = positions.find((p) => p.asset === noTokenPrice.tokenId);

      const yesSize = yesPosition ? yesPosition.size : 0;
      const noSize = noPosition ? noPosition.size : 0;

      // Determine which side to buy
      // Strategy: Buy the side with less position, or if equal, buy the cheaper one
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
          reason: `Arbitrage: Buying YES at ${yesTokenPrice.askPrice.toFixed(4)}, total cost: ${totalCost.toFixed(4)}, profit margin: ${(profitMargin * 100).toFixed(2)}%`,
        };
      } else if (!shouldBuyYes && noSize < config.maxPositionSize &&
                 noTokenPrice.askPrice >= config.minPrice && noTokenPrice.askPrice <= config.maxPrice) {
        return {
          action: "BUY_NO",
          tokenId: noTokenPrice.tokenId,
          price: noTokenPrice.askPrice,
          size: config.orderSize,
          reason: `Arbitrage: Buying NO at ${noTokenPrice.askPrice.toFixed(4)}, total cost: ${totalCost.toFixed(4)}, profit margin: ${(profitMargin * 100).toFixed(2)}%`,
        };
      }
    }

    return null;
  }
}

