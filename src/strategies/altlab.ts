import { TradingStrategy, TradingDecision, StrategyContext } from "./base";

export class AltLabStrategy extends TradingStrategy {
  name = "altlab";
  description =
    "Low price arbitrage with stop loss, profit taking, and market-end exit";

  private entryPrices: Map<string, number> = new Map();
  private positionSizes: Map<string, number> = new Map();
  private highestProfit: Map<string, number> = new Map();

  execute(context: StrategyContext): TradingDecision | null {
    const { yesTokenPrice, noTokenPrice, positions, config, timeUntilEnd } =
      context;

    if (!yesTokenPrice || !noTokenPrice) {
      return null;
    }

    this.updateEntryPrices(positions, yesTokenPrice, noTokenPrice);

    const sellDecision = this.checkSellConditions(
      positions,
      yesTokenPrice,
      noTokenPrice,
      config,
      timeUntilEnd
    );
    if (sellDecision) {
      return sellDecision;
    }

    return this.checkBuyConditions(
      yesTokenPrice,
      noTokenPrice,
      positions,
      config,
      timeUntilEnd
    );
  }

  private checkSellConditions(
    positions: any[],
    yesTokenPrice: any,
    noTokenPrice: any,
    config: any,
    timeUntilEnd?: number
  ): TradingDecision | null {
    if (timeUntilEnd && timeUntilEnd < 7 * 60 * 1000) {
      const yesPosition = positions.find(
        (p) => p.asset === yesTokenPrice.tokenId
      );
      const noPosition = positions.find(
        (p) => p.asset === noTokenPrice.tokenId
      );
    }
    const stopLossThreshold = config.stopLossPercentage || 0.25;

    const yesPosition = positions.find(
      (p) => p.asset === yesTokenPrice.tokenId
    );
    const noPosition = positions.find((p) => p.asset === noTokenPrice.tokenId);

    if (
      yesPosition &&
      yesPosition.size > 0 &&
      (!noPosition || noPosition.size === 0)
    ) {
      const entryPrice =
        this.entryPrices.get(yesTokenPrice.tokenId) || yesTokenPrice.midPrice;
      const currentPrice = yesTokenPrice.bidPrice;
      const profitPercent = (currentPrice - entryPrice) / entryPrice;

      const currentHighest =
        this.highestProfit.get(yesTokenPrice.tokenId) || profitPercent;
      if (profitPercent > currentHighest) {
        this.highestProfit.set(yesTokenPrice.tokenId, profitPercent);
      }

      if (profitPercent <= -stopLossThreshold) {
        return {
          action: "SELL",
          tokenId: yesTokenPrice.tokenId,
          price: currentPrice,
          size: yesPosition.size,
          reason: `Stop loss triggered: ${(profitPercent * 100).toFixed(
            2
          )}% loss (entry: ${entryPrice.toFixed(
            4
          )}, current: ${currentPrice.toFixed(4)})`,
        };
      }
    }

    if (
      noPosition &&
      noPosition.size > 0 &&
      (!yesPosition || yesPosition.size === 0)
    ) {
      const entryPrice =
        this.entryPrices.get(noTokenPrice.tokenId) || noTokenPrice.midPrice;
      const currentPrice = noTokenPrice.bidPrice;
      const profitPercent = (currentPrice - entryPrice) / entryPrice;

      const currentHighest =
        this.highestProfit.get(noTokenPrice.tokenId) || profitPercent;
      if (profitPercent > currentHighest) {
        this.highestProfit.set(noTokenPrice.tokenId, profitPercent);
      }

      if (profitPercent <= -stopLossThreshold) {
        return {
          action: "SELL",
          tokenId: noTokenPrice.tokenId,
          price: currentPrice,
          size: noPosition.size,
          reason: `Stop loss triggered: ${(profitPercent * 100).toFixed(
            2
          )}% loss (entry: ${entryPrice.toFixed(
            4
          )}, current: ${currentPrice.toFixed(4)})`,
        };
      }
    }

    return null;
  }

  private checkBuyConditions(
    yesTokenPrice: any,
    noTokenPrice: any,
    positions: any[],
    config: any,
    timeUntilEnd: number | undefined
  ): TradingDecision | null {
    if (timeUntilEnd && timeUntilEnd < 4 * 60 * 1000) {
      return null;
    }
    const maxBuyPrice = 0.475;
    const yesPrice = yesTokenPrice.askPrice;
    const noPrice = noTokenPrice.askPrice;
    const totalCost = yesPrice + noPrice;

    const yesPosition = positions.find(
      (p) => p.asset === yesTokenPrice.tokenId
    );
    const noPosition = positions.find((p) => p.asset === noTokenPrice.tokenId);

    const yesSize = yesPosition ? yesPosition.size : 0;
    const noSize = noPosition ? noPosition.size : 0;

    const priceDifference = yesPrice - noPrice;
    const sizeDifference = yesSize - noSize;

    const shouldBuyYes =
      (yesSize === 0 && noSize === 0 && priceDifference < 0) ||
      sizeDifference < 0 ||
      (sizeDifference === 0 && priceDifference < 0);

    if (
      shouldBuyYes &&
      yesSize < config.maxPositionSize &&
      yesPrice >= config.minPrice &&
      yesPrice <= config.maxPrice
    ) {
      if (yesSize === 0) {
        this.entryPrices.set(yesTokenPrice.tokenId, yesPrice);
        this.positionSizes.set(yesTokenPrice.tokenId, config.orderSize);
        this.highestProfit.set(yesTokenPrice.tokenId, 0);
      } else {
        const currentEntry =
          this.entryPrices.get(yesTokenPrice.tokenId) || yesPrice;
        const currentSize = this.positionSizes.get(yesTokenPrice.tokenId) || 0;
        const newEntry =
          (currentEntry * currentSize + yesPrice * config.orderSize) /
          (currentSize + config.orderSize);
        this.entryPrices.set(yesTokenPrice.tokenId, newEntry);
        this.positionSizes.set(
          yesTokenPrice.tokenId,
          currentSize + config.orderSize
        );
      }

      let reason = `Optimized: Buying YES at ${yesPrice.toFixed(4)}`;

      if (yesPrice < 0.35) {
        reason += ` (low YES price ${yesPrice.toFixed(
          4
        )}, total: ${totalCost.toFixed(4)})`;
      } else {
        reason += ` (favorable conditions, total: ${totalCost.toFixed(4)})`;
      }

      return {
        action: "BUY_YES",
        tokenId: yesTokenPrice.tokenId,
        price: yesPrice,
        size: config.orderSize,
        reason,
      };
    }

    if (
      !shouldBuyYes &&
      noSize < config.maxPositionSize &&
      noPrice >= config.minPrice &&
      noPrice <= config.maxPrice
    ) {
      if (noSize === 0) {
        this.entryPrices.set(noTokenPrice.tokenId, noPrice);
        this.positionSizes.set(noTokenPrice.tokenId, config.orderSize);
        this.highestProfit.set(noTokenPrice.tokenId, 0);
      } else {
        const currentEntry =
          this.entryPrices.get(noTokenPrice.tokenId) || noPrice;
        const currentSize = this.positionSizes.get(noTokenPrice.tokenId) || 0;
        const newEntry =
          (currentEntry * currentSize + noPrice * config.orderSize) /
          (currentSize + config.orderSize);
        this.entryPrices.set(noTokenPrice.tokenId, newEntry);
        this.positionSizes.set(
          noTokenPrice.tokenId,
          currentSize + config.orderSize
        );
      }

      let reason = `Optimized: Buying NO at ${noPrice.toFixed(4)}`;
      if (noPrice < 0.35) {
        reason += ` (low NO price ${noPrice.toFixed(
          4
        )}, total: ${totalCost.toFixed(4)})`;
      } else {
        reason += ` (favorable conditions, total: ${totalCost.toFixed(4)})`;
      }

      return {
        action: "BUY_NO",
        tokenId: noTokenPrice.tokenId,
        price: noPrice,
        size: config.orderSize,
        reason,
      };
    }

    return null;
  }

  private updateEntryPrices(
    positions: any[],
    yesTokenPrice: any,
    noTokenPrice: any
  ): void {
    positions.forEach((position) => {
      if (!this.entryPrices.has(position.asset)) {
        const currentPrice =
          position.asset === yesTokenPrice.tokenId
            ? yesTokenPrice.midPrice
            : noTokenPrice.midPrice;
        this.entryPrices.set(position.asset, currentPrice);
        this.positionSizes.set(position.asset, position.size);
        this.highestProfit.set(position.asset, 0);
      }
    });

    const positionAssets = new Set(positions.map((p) => p.asset));
    for (const [asset] of this.entryPrices) {
      if (!positionAssets.has(asset)) {
        this.entryPrices.delete(asset);
        this.positionSizes.delete(asset);
        this.highestProfit.delete(asset);
      }
    }
  }
}
