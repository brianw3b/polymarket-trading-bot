/**
 * Time-Based Market Strategy
 * 
 * This strategy handles markets that follow time-based patterns,
 * such as hourly Bitcoin markets that update every hour.
 * 
 * Example: Bitcoin markets that change hourly
 * - bitcoin-up-or-down-december-11-2am-et
 * - bitcoin-up-or-down-december-11-3am-et
 * - bitcoin-up-or-down-december-11-4am-et
 * etc.
 */

import { TradingStrategy, TradingDecision, StrategyContext } from "./base";
import { generateMarketSlug, MarketSlugPattern } from "../utils/marketSlugGenerator";

/**
 * Time-Based Market Strategy
 * Wraps another strategy but handles time-based market slug updates
 */
export class TimeBasedMarketStrategy extends TradingStrategy {
  name = "timeBasedMarket";
  description = "Trades time-based markets (e.g., hourly Bitcoin markets) with automatic slug updates";
  
  private wrappedStrategy: TradingStrategy;
  private marketPattern: MarketSlugPattern;
  private lastSlugUpdate: Date = new Date();
  private currentSlug: string;

  constructor(
    baseStrategy: TradingStrategy,
    marketPattern: MarketSlugPattern
  ) {
    super();
    this.wrappedStrategy = baseStrategy;
    this.marketPattern = marketPattern;
    this.currentSlug = marketPattern.baseSlug;
  }

  /**
   * Get current market slug based on time pattern
   */
  getCurrentMarketSlug(): string {
    const now = new Date();
    
    // Update slug if needed (for hourly, check every hour)
    if (this.marketPattern.timePattern === "hourly") {
      const hoursSinceUpdate = (now.getTime() - this.lastSlugUpdate.getTime()) / (1000 * 60 * 60);
      if (hoursSinceUpdate >= 1) {
        this.currentSlug = generateMarketSlug(this.marketPattern, now);
        this.lastSlugUpdate = now;
      }
    } else if (this.marketPattern.timePattern === "daily") {
      const daysSinceUpdate = (now.getTime() - this.lastSlugUpdate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate >= 1) {
        this.currentSlug = generateMarketSlug(this.marketPattern, now);
        this.lastSlugUpdate = now;
      }
    }

    return this.currentSlug;
  }

  execute(context: StrategyContext): TradingDecision | null {
    // Update market slug if needed
    this.getCurrentMarketSlug();
    
    // Execute wrapped strategy
    return this.wrappedStrategy.execute(context);
  }
}

/**
 * Helper to create time-based market pattern from example slug
 */
export function createBitcoinHourlyPattern(
  exampleSlug: string = "bitcoin-up-or-down-december-11-2am-et"
): MarketSlugPattern {
  return {
    baseSlug: exampleSlug,
    timePattern: "hourly",
    timeFormat: "12h",
  };
}

/**
 * Helper to create custom time-based pattern
 */
export function createTimeBasedPattern(
  baseSlug: string,
  timePattern: "hourly" | "daily"
): MarketSlugPattern {
  return {
    baseSlug,
    timePattern,
    timeFormat: baseSlug.match(/\d{1,2}(am|pm)/i) ? "12h" : "24h",
  };
}

