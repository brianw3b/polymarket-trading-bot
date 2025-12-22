"use client";

import { useState } from "react";
import Card from "@/components/shared/Card";
import LoadingState from "@/components/shared/LoadingState";
import ErrorState from "@/components/shared/ErrorState";
import Badge from "@/components/shared/Badge";
import StatDisplay from "@/components/shared/StatDisplay";
import { cn } from "@/utils/classNames";

interface MarketDetailProps {
  slug?: string;
  tokenId?: string;
}

export default function MarketDetail({ slug, tokenId }: MarketDetailProps) {
  const [inputValue, setInputValue] = useState(slug || "");
  const [market, setMarket] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMarket = async (searchValue: string) => {
    if (!searchValue.trim()) {
      setError("Please enter a market slug or token ID");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Try slug first
      let response = await fetch(`/api/polymarket/market-by-slug?slug=${encodeURIComponent(searchValue)}`);
      
      if (!response.ok && tokenId) {
        // Fallback to token ID if slug fails
        response = await fetch(`/api/polymarket/market-by-token?tokenId=${encodeURIComponent(tokenId)}`);
      }

      if (!response.ok) {
        throw new Error("Market not found");
      }

      const data = await response.json();
      setMarket(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch market");
      setMarket(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchMarket(inputValue);
  };

  return (
    <Card className="p-6">
      <h2 className="text-2xl font-bold mb-6">Market Detail Viewer</h2>

      {/* Search Form */}
      <form onSubmit={handleSubmit} className="mb-6">
        <div className="flex gap-3">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Enter market slug (e.g., bitcoin-up-or-down-december-11-2am-et)"
            className="flex-1 px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={isLoading}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {isLoading ? "Loading..." : "Load Market"}
          </button>
        </div>
        <p className="mt-2 text-sm text-gray-400">
          Enter a Polymarket market slug from the URL (e.g., from{" "}
          <code className="bg-black/50 px-1 rounded">
            polymarket.com/event/bitcoin-up-or-down-december-11-2am-et
          </code>
          )
        </p>
      </form>

      {isLoading && <LoadingState message="Loading market data..." />}

      {error && <ErrorState error={error} title="Error loading market" />}

      {market && (
        <div className="space-y-6">
          {/* Market Header */}
          <div>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold mb-2">{market.question}</h3>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={market.active ? "success" : "warning"}>
                    {market.active ? "Active" : "Inactive"}
                  </Badge>
                  {market.closed && (
                    <Badge variant="warning">Closed</Badge>
                  )}
                  {market.featured && (
                    <Badge variant="info">Featured</Badge>
                  )}
                </div>
              </div>
            </div>
            {market.description && (
              <p className="text-gray-300 text-sm mb-4">{market.description}</p>
            )}
          </div>

          {/* Market Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatDisplay
              label="Volume"
              value={`$${parseFloat(market.volume || "0").toLocaleString()}`}
            />
            <StatDisplay
              label="Liquidity"
              value={`$${parseFloat(market.liquidity || "0").toLocaleString()}`}
            />
            <StatDisplay
              label="24h Volume"
              value={`$${parseFloat(market.volume24hr || "0").toLocaleString()}`}
            />
            <StatDisplay
              label="Market ID"
              value={market.id}
              className="text-xs"
            />
          </div>

          {/* Outcomes & Token IDs */}
          {market.parsedOutcomes && market.parsedOutcomes.length > 0 && (
            <div>
              <h4 className="text-lg font-semibold mb-3">Outcomes & Token IDs</h4>
              <div className="space-y-3">
                {market.parsedOutcomes.map((outcome: string, idx: number) => {
                  const tokenId = market.parsedTokenIds?.[idx];
                  const price = market.parsedOutcomePrices?.[idx];
                  
                  return (
                    <div
                      key={idx}
                      className="p-4 bg-white/5 rounded-lg border border-white/10"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-semibold">{outcome}</span>
                        {price !== undefined && (
                          <Badge variant="info">
                            {(price * 100).toFixed(2)}%
                          </Badge>
                        )}
                      </div>
                      {tokenId && (
                        <div className="mt-2">
                          <p className="text-xs text-gray-400 mb-1">Token ID:</p>
                          <code className="text-xs bg-black/50 px-2 py-1 rounded break-all">
                            {tokenId}
                          </code>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Market Metadata */}
          <div>
            <h4 className="text-lg font-semibold mb-3">Market Information</h4>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-400 mb-1">Slug</p>
                <p className="font-mono text-xs break-all">{market.slug}</p>
              </div>
              {market.endDate && (
                <div>
                  <p className="text-gray-400 mb-1">End Date</p>
                  <p>{new Date(market.endDate).toLocaleString()}</p>
                </div>
              )}
              {market.resolutionSource && (
                <div className="col-span-2">
                  <p className="text-gray-400 mb-1">Resolution Source</p>
                  <a
                    href={market.resolutionSource}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline break-all"
                  >
                    {market.resolutionSource}
                  </a>
                </div>
              )}
            </div>
          </div>

          {/* Link to Polymarket */}
          {market.slug && (
            <div className="pt-4 border-t border-white/10">
              <a
                href={`https://polymarket.com/event/${market.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                View on Polymarket →
              </a>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}











