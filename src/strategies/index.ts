import { TradingStrategy } from "./base";

import { LadderScaleStrategy } from "./ladderScale";
import { NuoiemStrategy } from "./nuoiem";
import { RaisemStrategy } from "./raisem";
import { RaisemV1Strategy } from "./raisemV1";

export * from "./base";

export { LadderScaleStrategy } from "./ladderScale";
export { NuoiemStrategy } from "./nuoiem";
export { RaisemStrategy } from "./raisem";
export { RaisemV1Strategy } from "./raisemV1";

export {
  TimeBasedMarketStrategy,
  createBitcoinHourlyPattern,
  createTimeBasedPattern,
} from "./timeBasedMarket";

// Register all available strategies using the common TradingStrategy base type
const strategies: Map<string, TradingStrategy> = new Map();
strategies.set("ladderScale", new LadderScaleStrategy());
strategies.set("nuoiem", new NuoiemStrategy());
strategies.set("raisem", new RaisemStrategy());
strategies.set("raisemV1", new RaisemV1Strategy());

export function getStrategy(name: string): TradingStrategy | null {
  return strategies.get(name) || null;
}

export function listStrategies(): string[] {
  return Array.from(strategies.keys());
}
