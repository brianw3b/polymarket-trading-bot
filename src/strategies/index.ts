import { TradingStrategy } from "./base";
import { BalancedStrategy } from "./balanced";
import { AltLabStrategy } from "./altlab";
import { DipScaleStrategy } from "./dipScale";
import { ImprovedDipScaleStrategy } from "./improvedDipScale";
import { KarasStrategy } from "./karas";
import { LiamStrategy } from "./liam";

export * from "./base";
export { BalancedStrategy } from "./balanced";
export { AltLabStrategy } from "./altlab";
export { DipScaleStrategy } from "./dipScale";
export { ImprovedDipScaleStrategy } from "./improvedDipScale";
export { KarasStrategy } from "./karas";
export { LiamStrategy } from "./liam";


export {
  TimeBasedMarketStrategy,
  createBitcoinHourlyPattern,
  createTimeBasedPattern,
} from "./timeBasedMarket";

const strategies: Map<string, TradingStrategy> = new Map([
  ["balanced", new BalancedStrategy()],
  ["altlab", new AltLabStrategy()],
  ["dipscale", new DipScaleStrategy()],
  ["improvedipscale", new ImprovedDipScaleStrategy()],
  ["karas", new KarasStrategy()],
  ["liam", new LiamStrategy()],
]);

export function getStrategy(name: string): TradingStrategy | null {
  return strategies.get(name) || null;
}

export function listStrategies(): string[] {
  return Array.from(strategies.keys());
}
