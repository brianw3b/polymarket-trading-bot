import { TradingStrategy } from "./base";
import { BalancedStrategy } from "./balanced";
import { MeanReversionStrategy } from "./meanReversion";

import { ArbitrageStrategy } from "./arbitrage";
import { OptimizedStrategy } from "./optimized";
import { AltLabStrategy } from "./altlab";

export * from "./base";
export { BalancedStrategy } from "./balanced";
export { MeanReversionStrategy } from "./meanReversion";

export { ArbitrageStrategy } from "./arbitrage";
export { OptimizedStrategy } from "./optimized";
export {
  TimeBasedMarketStrategy,
  createBitcoinHourlyPattern,
  createTimeBasedPattern,
} from "./timeBasedMarket";

const strategies: Map<string, TradingStrategy> = new Map([
  ["balanced", new BalancedStrategy()],
  ["meanReversion", new MeanReversionStrategy()],
  ["arbitrage", new ArbitrageStrategy()],
  ["optimized", new OptimizedStrategy()],
  ["altlab", new AltLabStrategy()],
]);

export function getStrategy(name: string): TradingStrategy | null {
  return strategies.get(name) || null;
}

export function listStrategies(): string[] {
  return Array.from(strategies.keys());
}
