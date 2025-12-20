import { NextRequest, NextResponse } from "next/server";

const GAMMA_API = "https://gamma-api.polymarket.com";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const slug = searchParams.get("slug");

  if (!slug) {
    return NextResponse.json(
      { error: "slug parameter is required" },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(
      `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`,
      {
        headers: { "Content-Type": "application/json" },
        next: { revalidate: 60 },
      }
    );

    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    const markets = await response.json();

    if (!Array.isArray(markets) || markets.length === 0) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const market = markets[0];

    // Parse token IDs and outcomes
    let tokenIds: string[] = [];
    let outcomes: string[] = [];
    let outcomePrices: number[] = [];

    try {
      tokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];
    } catch (e) {
      // Ignore parse errors
    }

    try {
      outcomes = market.outcomes ? JSON.parse(market.outcomes) : [];
    } catch (e) {
      // Ignore parse errors
    }

    try {
      const prices = market.outcomePrices ? JSON.parse(market.outcomePrices) : [];
      outcomePrices = prices.map((p: string) => parseFloat(p));
    } catch (e) {
      // Ignore parse errors
    }

    return NextResponse.json({
      ...market,
      parsedTokenIds: tokenIds,
      parsedOutcomes: outcomes,
      parsedOutcomePrices: outcomePrices,
    });
  } catch (error) {
    console.error("Error fetching market by slug:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch market by slug",
      },
      { status: 500 }
    );
  }
}









