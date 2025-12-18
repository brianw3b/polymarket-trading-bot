import { TradingStrategy } from "./base";

import { LadderScaleStrategy } from "./ladderScale";

export * from "./base";

export { LadderScaleStrategy } from "./ladderScale";

export {
  TimeBasedMarketStrategy,
  createBitcoinHourlyPattern,
  createTimeBasedPattern,
} from "./timeBasedMarket";

// Register all available strategies using the common TradingStrategy base type
const strategies: Map<string, TradingStrategy> = new Map();
strategies.set("ladderScale", new LadderScaleStrategy());

export function getStrategy(name: string): TradingStrategy | null {
  return strategies.get(name) || null;
}

export function listStrategies(): string[] {
  return Array.from(strategies.keys());
}
