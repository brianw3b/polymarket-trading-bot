import { TradingStrategy } from "./base";

import { LadderScaleStrategy } from "./ladderScale";

export * from "./base";
export { BalancedStrategy } from "./balanced";
export { AltLabStrategy } from "./altlab";
export { DipScaleStrategy } from "./dipScale";
export { ImprovedDipScaleStrategy } from "./improvedDipScale";

export {
  TimeBasedMarketStrategy,
  createBitcoinHourlyPattern,
  createTimeBasedPattern,
} from "./timeBasedMarket";

const strategies: Map<string, TradingStrategy> = new Map([
  ["ladderScale", new LadderScaleStrategy()],
]);

export function getStrategy(name: string): TradingStrategy | null {
  return strategies.get(name) || null;
}

export function listStrategies(): string[] {
  return Array.from(strategies.keys());
}
