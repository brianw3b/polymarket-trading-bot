import { TokenPrice, Position } from "../utils/marketData";

export interface TradingDecision {
  action: "BUY_YES" | "BUY_NO" | "HOLD" | "SELL";
  tokenId: string;
  price: number;
  size: number;
  reason: string;
}

export interface StrategyContext {
  tokenPrice: TokenPrice;
  yesTokenPrice?: TokenPrice;
  noTokenPrice?: TokenPrice;
  positions: Position[];
  marketEndTime?: Date; // Market end time for time-based markets
  timeUntilEnd?: number; // Milliseconds until market ends
  config: {
    orderSize: number;
    minPrice: number;
    maxPrice: number;
    maxPositionSize: number;
    stopLossPercentage?: number;
    takeProfitPercentage?: number;
  };
}

export abstract class TradingStrategy {
  abstract name: string;
  abstract description: string;

  abstract execute(context: StrategyContext): TradingDecision | null;

  protected validatePrice(price: number, minPrice: number, maxPrice: number): boolean {
    return price >= minPrice && price <= maxPrice;
  }

  protected calculatePositionSize(
    currentPositions: Position[],
    tokenId: string,
    maxPositionSize: number
  ): number {
    const currentPosition = currentPositions.find((p) => p.asset === tokenId);
    const currentSize = currentPosition ? currentPosition.size : 0;
    return Math.max(0, maxPositionSize - currentSize);
  }
}

