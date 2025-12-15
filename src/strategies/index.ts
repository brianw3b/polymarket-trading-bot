import { TradingStrategy } from "./base";
import { BalancedStrategy } from "./balanced";

import { AltLabStrategy } from "./altlab";

export * from "./base";
export { BalancedStrategy } from "./balanced";

export {
  TimeBasedMarketStrategy,
  createBitcoinHourlyPattern,
  createTimeBasedPattern,
} from "./timeBasedMarket";

const strategies: Map<string, TradingStrategy> = new Map([
  ["balanced", new BalancedStrategy()],
  ["altlab", new AltLabStrategy()],
]);

export function getStrategy(name: string): TradingStrategy | null {
  return strategies.get(name) || null;
}

export function listStrategies(): string[] {
  return Array.from(strategies.keys());
}
