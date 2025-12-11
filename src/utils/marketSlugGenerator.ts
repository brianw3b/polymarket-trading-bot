import { Logger } from "./logger";

/**
 * Market Slug Generator
 * Generates market slugs based on patterns and time rules
 * Useful for markets that follow time-based patterns (e.g., hourly Bitcoin markets)
 */

export interface MarketSlugPattern {
  baseSlug: string;
  timePattern: "hourly" | "daily" | "15min" | "custom";
  startTime?: string;
  timeFormat?: "12h" | "24h" | "timestamp";
  customPattern?: (date: Date) => string;
}

/**
 * Generate market slug based on pattern and current time
 */
export function generateMarketSlug(
  pattern: MarketSlugPattern,
  targetDate?: Date,
  logger?: Logger
): string {
  const date = targetDate || new Date();
  
  try {
    switch (pattern.timePattern) {
      case "hourly":
        return generateHourlySlug(pattern, date, logger);
      
      case "daily":
        return generateDailySlug(pattern, date, logger);
      
      case "15min":
        return generate15MinSlug(pattern, date, logger);
      
      case "custom":
        if (pattern.customPattern) {
          return pattern.customPattern(date);
        }
        throw new Error("Custom pattern requires customPattern function");
      
      default:
        return pattern.baseSlug;
    }
  } catch (error) {
    logger?.error("Failed to generate market slug", { pattern, error });
    return pattern.baseSlug;
  }
}

/**
 * Generate hourly market slug
 * Example: "bitcoin-up-or-down-december-11-2am-et" -> "bitcoin-up-or-down-december-11-3am-et"
 */
function generateHourlySlug(
  pattern: MarketSlugPattern,
  date: Date,
  logger?: Logger
): string {
  const baseSlug = pattern.baseSlug;
  
  const timeMatch = baseSlug.match(/(\d{1,2})(am|pm)(-et)?/i);
  
  if (timeMatch) {
    const timeUnit = timeMatch[2].toLowerCase();
    
    let currentHour = date.getHours();
    const is12h = timeUnit === "am" || timeUnit === "pm";
    
    if (is12h) {
      const period = currentHour >= 12 ? "pm" : "am";
      currentHour = currentHour % 12 || 12;
      
      const suffix = timeMatch[3] || "";
      return baseSlug.replace(
        /(\d{1,2})(am|pm)(-et)?/i,
        `${currentHour}${period}${suffix}`
      );
    }
  }
  
  const timeMatch24 = baseSlug.match(/(\d{1,2})h(-et)?/i);
  if (timeMatch24) {
    const currentHour = date.getHours();
    const suffix = timeMatch24[2] || "";
    return baseSlug.replace(
      /(\d{1,2})h(-et)?/i,
      `${currentHour}h${suffix}`
    );
  }
  
  const hour = date.getHours();
  const period = hour >= 12 ? "pm" : "am";
  const hour12 = hour % 12 || 12;
  
  if (baseSlug.includes("-et")) {
    return baseSlug.replace(/(-et)$/, `-${hour12}${period}-et`);
  }
  
  return `${baseSlug}-${hour12}${period}-et`;
}

/**
 * Generate daily market slug
 * Example: "bitcoin-up-or-down-december-11-2am-et" -> "bitcoin-up-or-down-december-12-2am-et"
 */
function generateDailySlug(
  pattern: MarketSlugPattern,
  date: Date,
  logger?: Logger
): string {
  const baseSlug = pattern.baseSlug;
  
  const dateMatch = baseSlug.match(/(january|february|march|april|may|june|july|august|september|october|november|december)-(\d{1,2})/i);
  
  if (dateMatch) {
    const monthNames = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december"
    ];
    
    const currentMonth = monthNames[date.getMonth()];
    const currentDay = date.getDate();
    
    return baseSlug.replace(
      /(january|february|march|april|may|june|july|august|september|october|november|december)-(\d{1,2})/i,
      `${currentMonth}-${currentDay}`
    );
  }
  
  return baseSlug;
}

/**
 * Generate 15-minute interval market slug
 * Example: "btc-updown-15m-1765449000" -> "btc-updown-15m-1765449900"
 * These markets use Unix timestamps that increment by 900 seconds (15 minutes)
 */
function generate15MinSlug(
  pattern: MarketSlugPattern,
  date: Date,
  logger?: Logger
): string {
  const baseSlug = pattern.baseSlug;
  
  const timestampMatch = baseSlug.match(/(\d{10,})/);
  
  if (timestampMatch) {
    const baseTimestamp = parseInt(timestampMatch[1]);
    
    const now = Math.floor(date.getTime() / 1000);
    const intervalSeconds = 15 * 60;
    const currentInterval = Math.floor(now / intervalSeconds) * intervalSeconds;
    
    const baseInterval = Math.floor(baseTimestamp / intervalSeconds) * intervalSeconds;
    const intervalsDiff = (currentInterval - baseInterval) / intervalSeconds;
    
    const newTimestamp = baseInterval + (intervalsDiff * intervalSeconds);
    
    return baseSlug.replace(/\d{10,}/, newTimestamp.toString());
  }
  
  if (baseSlug.includes("15m")) {
    const now = Math.floor(date.getTime() / 1000);
    const intervalSeconds = 15 * 60;
    const currentInterval = Math.floor(now / intervalSeconds) * intervalSeconds;
    
    if (baseSlug.match(/\d{10,}/)) {
      return baseSlug.replace(/\d{10,}/, currentInterval.toString());
    } else {
      return baseSlug.replace(/-15m-?/, `-15m-${currentInterval}`);
    }
  }
  
  logger?.warn("Could not generate 15min slug - no timestamp pattern found", { baseSlug });
  return baseSlug;
}

/**
 * Get next market slug in sequence
 * Useful for finding the next hourly/daily/15min market
 */
export function getNextMarketSlug(
  currentSlug: string,
  pattern: MarketSlugPattern,
  logger?: Logger
): string {
  const now = new Date();
  
  if (pattern.timePattern === "hourly") {
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1);
    return generateMarketSlug(pattern, nextHour, logger);
  }
  
  if (pattern.timePattern === "daily") {
    const nextDay = new Date(now);
    nextDay.setDate(nextDay.getDate() + 1);
    return generateMarketSlug(pattern, nextDay, logger);
  }
  
  if (pattern.timePattern === "15min") {
    const next15Min = new Date(now);
    next15Min.setMinutes(next15Min.getMinutes() + 15);
    return generateMarketSlug(pattern, next15Min, logger);
  }
  
  return currentSlug;
}

/**
 * Parse market slug pattern from example
 * Example: "bitcoin-up-or-down-december-11-2am-et" -> pattern for hourly Bitcoin markets
 */
export function parseMarketSlugPattern(
  exampleSlug: string,
  timePattern: "hourly" | "daily" = "hourly"
): MarketSlugPattern {
  return {
    baseSlug: exampleSlug,
    timePattern,
    timeFormat: exampleSlug.match(/\d{1,2}(am|pm)/i) ? "12h" : "24h",
  };
}

/**
 * Get current active market slug based on pattern
 * This finds the market that should be active right now
 */
export async function getCurrentMarketSlug(
  pattern: MarketSlugPattern,
  logger?: Logger
): Promise<string | null> {
  try {
    const currentSlug = generateMarketSlug(pattern, new Date(), logger);
    
    return currentSlug;
  } catch (error) {
    logger?.error("Failed to get current market slug", { pattern, error });
    return null;
  }
}

