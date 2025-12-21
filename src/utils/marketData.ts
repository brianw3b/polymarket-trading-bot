import { ClobClient } from "@polymarket/clob-client";
import { Side } from "@polymarket/clob-client";
import { Logger } from "./logger";

const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

export interface MarketInfo {
  id: string;
  question: string;
  outcomes: string[];
  tokenIds: string[];
  active: boolean;
  closed: boolean;
}

export interface TokenPrice {
  tokenId: string;
  bidPrice: number;
  askPrice: number;
  midPrice: number;
  spread: number;
}

export interface Position {
  asset: string;
  size: number;
  side: "YES" | "NO";
  conditionId?: string;
  outcomeIndex?: number;
  redeemable?: boolean;
  curPrice?: number;
  title?: string;
  slug?: string;
  outcome?: string;
}

/**
 * Get market information by slug
 * This is the most efficient way to get market data when you have the slug
 */
export async function getMarketBySlug(
  slug: string,
  logger: Logger
): Promise<MarketInfo | null> {
  try {
    // Add timeout (10 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(
      `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`,
      { signal: controller.signal }
    ).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    const markets = await response.json();

    if (!Array.isArray(markets) || markets.length === 0) {
      logger.warn("Market not found by slug", { slug });
      return null;
    }

    const market = markets[0];

    // Validate and parse market data
    let outcomes: string[] = [];
    let tokenIds: string[] = [];

    try {
      outcomes = market.outcomes ? JSON.parse(market.outcomes) : [];
    } catch (e) {
      logger.warn("Failed to parse outcomes", { slug, error: e });
    }

    try {
      tokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];
    } catch (e) {
      logger.warn("Failed to parse token IDs", { slug, error: e });
    }

    return {
      id: market.id,
      question: market.question,
      outcomes,
      tokenIds,
      active: market.active ?? true,
      closed: market.closed ?? false,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.error("Timeout fetching market by slug", { slug });
    } else {
      logger.error("Failed to fetch market by slug", {
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

/**
 * Get market information by token ID
 * Tries multiple search strategies to find the market:
 * 1. Search active markets
 * 2. Search closed markets
 * 3. Search all markets (no filters)
 * 4. Try with different pagination limits
 */
export async function getMarketByToken(
  tokenId: string,
  logger: Logger
): Promise<MarketInfo | null> {
  // Helper function to search markets with given parameters
  const searchMarkets = async (
    params: URLSearchParams,
    maxPages: number = 10
  ): Promise<MarketInfo | null> => {
    const limit = 500;
    let offset = 0;

    for (let page = 0; page < maxPages; page++) {
      params.set("limit", limit.toString());
      params.set("offset", offset.toString());

      try {
        // Add timeout (10 seconds)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(
          `${GAMMA_API}/markets?${params.toString()}`,
          { signal: controller.signal }
        ).finally(() => clearTimeout(timeoutId));

        if (!response.ok) {
          continue; // Try next strategy
        }

        const markets = await response.json();

        if (!Array.isArray(markets) || markets.length === 0) {
          break;
        }

        const market = markets.find((m) => {
          if (!m.clobTokenIds) return false;
          try {
            const tokenIds = JSON.parse(m.clobTokenIds);
            return Array.isArray(tokenIds) && tokenIds.includes(tokenId);
          } catch {
            return false;
          }
        });

        if (market) {
          return {
            id: market.id,
            question: market.question,
            outcomes: market.outcomes ? JSON.parse(market.outcomes) : [],
            tokenIds: market.clobTokenIds
              ? JSON.parse(market.clobTokenIds)
              : [],
            active: market.active,
            closed: market.closed,
          };
        }

        if (markets.length < limit) {
          break;
        }

        offset += limit;
      } catch (error) {
        logger.debug("Error in pagination search", { page, error });
        break;
      }
    }

    return null;
  };

  try {
    logger.debug("Searching active markets", { tokenId });
    const activeParams = new URLSearchParams({
      active: "true",
      closed: "false",
    });
    const activeResult = await searchMarkets(activeParams, 10);
    if (activeResult) return activeResult;

    logger.debug("Searching closed markets", { tokenId });
    const closedParams = new URLSearchParams({ closed: "true" });
    const closedResult = await searchMarkets(closedParams, 10);
    if (closedResult) return closedResult;

    logger.debug("Searching all markets", { tokenId });
    const allParams = new URLSearchParams();
    const allResult = await searchMarkets(allParams, 15);
    if (allResult) return allResult;

    logger.debug("Searching active markets (no closed filter)", { tokenId });
    const activeOnlyParams = new URLSearchParams({ active: "true" });
    const activeOnlyResult = await searchMarkets(activeOnlyParams, 10);
    if (activeOnlyResult) return activeOnlyResult;

    logger.warn("Market not found in paginated results", {
      tokenId,
      note: "Consider using getMarketBySlug for more reliable market lookup",
    });
    return null;
  } catch (error) {
    logger.error("Failed to fetch market by token", { tokenId, error });
    return null;
  }
}

/**
 * Get token price using ClobClient
 * This uses the ClobClient's getPrice method which is the recommended approach
 */
export async function getTokenPrice(
  clobClient: ClobClient,
  tokenId: string,
  logger: Logger
): Promise<TokenPrice | null> {
  try {
    logger.debug("Fetching price for token", { tokenId });

    // Add timeout wrapper (10 seconds per price fetch)
    const timeoutPromise = (promise: Promise<any>, timeoutMs: number = 10000) => {
      return Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Price fetch timeout")), timeoutMs)
        ),
      ]);
    };

    const [bidPriceData, askPriceData] = await Promise.all([
      timeoutPromise(clobClient.getPrice(tokenId, Side.BUY), 10000).catch((err) => {
        logger.warn("Failed to get bid price", {
          tokenId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }),
      timeoutPromise(clobClient.getPrice(tokenId, Side.SELL), 10000).catch((err) => {
        logger.warn("Failed to get ask price", {
          tokenId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }),
    ]);

    if (!bidPriceData || !askPriceData) {
      logger.error("Failed to get price data", {
        tokenId,
        hasBid: !!bidPriceData,
        hasAsk: !!askPriceData,
        bidData: bidPriceData,
        askData: askPriceData,
      });
      throw new Error("Failed to get price data from ClobClient");
    }

    logger.debug("Price data received", {
      tokenId,
      bidData: bidPriceData,
      askData: askPriceData,
    });

    const bidPrice = parseFloat(bidPriceData.price);
    const askPrice = parseFloat(askPriceData.price);

    if (isNaN(bidPrice) || isNaN(askPrice)) {
      logger.error("Invalid price data", {
        tokenId,
        bidPrice: bidPriceData.price,
        askPrice: askPriceData.price,
        bidParsed: bidPrice,
        askParsed: askPrice,
      });
      throw new Error("Invalid price data");
    }

    if (bidPrice < 0 || bidPrice > 1 || askPrice < 0 || askPrice > 1) {
      logger.warn("Price out of valid range", {
        tokenId,
        bidPrice,
        askPrice,
      });
    }

    const midPrice = (bidPrice + askPrice) / 2;
    const spread = askPrice - bidPrice;

    logger.debug("Price calculated", {
      tokenId,
      bidPrice,
      askPrice,
      midPrice,
      spread,
    });

    return {
      tokenId,
      bidPrice,
      askPrice,
      midPrice,
      spread,
    };
  } catch (error) {
    logger.error("Failed to get token price", {
      tokenId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}

export async function getUserPositions(
  userAddress: string,
  logger: Logger
): Promise<Position[]> {
  try {
    const params = new URLSearchParams({
      user: userAddress,
      sizeThreshold: "0.01",
      limit: "500",
    });

    // Add timeout (10 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${DATA_API}/positions?${params}`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      throw new Error(`Data API error: ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((pos) => ({
      asset: pos.asset,
      size: parseFloat(pos.size) || 0,
      side: pos.side || pos.outcome || "YES", // Use outcome if side not available
      conditionId: pos.conditionId || pos.condition_id || pos.conditionID,
      outcomeIndex: pos.outcomeIndex !== undefined 
        ? pos.outcomeIndex 
        : (pos.outcome_index !== undefined 
          ? pos.outcome_index 
          : undefined),
      redeemable: pos.redeemable !== undefined ? Boolean(pos.redeemable) : false,
      // Include additional fields that might be useful
      curPrice: pos.curPrice !== undefined ? parseFloat(pos.curPrice) : undefined,
      title: pos.title,
      slug: pos.slug,
      outcome: pos.outcome,
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.error("Timeout fetching user positions", { userAddress });
    } else {
      logger.error("Failed to fetch user positions", {
        userAddress,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
}

export function findTokenIdsForMarket(
  market: MarketInfo,
  outcome: "YES" | "NO"
): { yesTokenId: string | null; noTokenId: string | null } {
  if (market.outcomes.length !== 2 || market.tokenIds.length !== 2) {
    return { yesTokenId: null, noTokenId: null };
  }

  const yesIndex = market.outcomes.findIndex((o) => {
    const upper = o.toUpperCase();
    return upper === "YES" || upper === "FOR" || upper === "UP";
  });
  const noIndex = market.outcomes.findIndex((o) => {
    const upper = o.toUpperCase();
    return upper === "NO" || upper === "AGAINST" || upper === "DOWN";
  });

  if (yesIndex >= 0 && noIndex >= 0) {
    return {
      yesTokenId: market.tokenIds[yesIndex],
      noTokenId: market.tokenIds[noIndex],
    };
  }

  if (yesIndex >= 0 && noIndex < 0) {
    const otherIndex = yesIndex === 0 ? 1 : 0;
    return {
      yesTokenId: market.tokenIds[yesIndex],
      noTokenId: market.tokenIds[otherIndex],
    };
  }

  if (noIndex >= 0 && yesIndex < 0) {
    const otherIndex = noIndex === 0 ? 1 : 0;
    return {
      yesTokenId: market.tokenIds[otherIndex],
      noTokenId: market.tokenIds[noIndex],
    };
  }

  return {
    yesTokenId: market.tokenIds[0] || null,
    noTokenId: market.tokenIds[1] || null,
  };
}


