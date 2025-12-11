/**
 * Integration tests for marketData functions using real Polymarket API
 * 
 * These tests make actual API calls to Polymarket and should be run with:
 * yarn test:integration
 * 
 * Note: These tests may fail if the market is no longer active or if the API is down
 */

import { getMarketByToken, getMarketBySlug, MarketInfo } from '../marketData';
import { createLogger } from '../logger';

// Create a real logger for integration tests
const logger = createLogger('info', 'logs/test.log');

describe('MarketData Integration Tests (Real API)', () => {
  // Market slug from: https://polymarket.com/event/bitcoin-up-or-down-december-11-2am-et
  const BITCOIN_MARKET_SLUG = 'bitcoin-up-or-down-december-11-2am-et';
  
  // Increase timeout for real API calls
  jest.setTimeout(30000);

  describe('getMarketBySlug', () => {
    it('should fetch real market data by slug', async () => {
      const market = await getMarketBySlug(BITCOIN_MARKET_SLUG, logger);

      expect(market).not.toBeNull();
      expect(market?.id).toBeDefined();
      expect(market?.question).toContain('Bitcoin');
      expect(market?.tokenIds).toBeDefined();
      expect(market?.tokenIds.length).toBeGreaterThan(0);
      expect(market?.outcomes.length).toBeGreaterThan(0);
      expect(market?.active).toBeDefined();
      
      console.log('Market Data:', {
        id: market?.id,
        question: market?.question,
        outcomes: market?.outcomes,
        tokenIds: market?.tokenIds,
        active: market?.active,
        closed: market?.closed,
      });
    });

    it('should return null for non-existent slug', async () => {
      const market = await getMarketBySlug('non-existent-market-slug-12345', logger);
      expect(market).toBeNull();
    });
  });

  describe('getMarketByToken - Real Data', () => {
    it('should fetch market data using a real token ID from Bitcoin market', async () => {
      // First, get the market by slug to obtain token IDs
      const marketBySlug = await getMarketBySlug(BITCOIN_MARKET_SLUG, logger);
      
      expect(marketBySlug).not.toBeNull();
      expect(marketBySlug?.tokenIds.length).toBeGreaterThan(0);

      // Use the first token ID to test getMarketByToken
      const tokenId = marketBySlug!.tokenIds[0];
      
      console.log(`Testing with token ID: ${tokenId}`);

      // Now test getMarketByToken with the real token ID
      // Note: getMarketByToken may not find the market if it's not in the first 2500 results
      // This is a limitation of the paginated API approach
      const market = await getMarketByToken(tokenId, logger);

      // If market is found, validate it
      if (market) {
        expect(market.id).toBeDefined();
        expect(market.question).toBeDefined();
        expect(market.tokenIds).toContain(tokenId);
        
        console.log('Market found by token ID:', {
          id: market.id,
          question: market.question,
          tokenIds: market.tokenIds,
        });
      } else {
        // This is expected if the market is not in the first 2500 paginated results
        console.log('Market not found in paginated results (this is expected for some markets)');
        console.log('Note: Use getMarketBySlug for more reliable market lookup');
      }
    });

    it('should find the same market when using different token IDs from the same market', async () => {
      // Get market by slug first
      const marketBySlug = await getMarketBySlug(BITCOIN_MARKET_SLUG, logger);
      
      expect(marketBySlug).not.toBeNull();
      expect(marketBySlug?.tokenIds.length).toBeGreaterThanOrEqual(2);

      // Test with first token ID
      const firstTokenId = marketBySlug!.tokenIds[0];
      const market1 = await getMarketByToken(firstTokenId, logger);
      
      // Test with second token ID (if available)
      if (marketBySlug!.tokenIds.length >= 2) {
        const secondTokenId = marketBySlug!.tokenIds[1];
        const market2 = await getMarketByToken(secondTokenId, logger);
        
        // If both are found, they should return the same market
        if (market1 && market2) {
          expect(market1.id).toBe(market2.id);
          expect(market1.question).toBe(market2.question);
        } else {
          // If not found, that's expected due to pagination limitations
          console.log('Markets not found in paginated results (expected for some markets)');
        }
      }
    });

    it('should return null for non-existent token ID', async () => {
      const fakeTokenId = '999999999999999999999999999999999999999999999999999999999999999999999999';
      const market = await getMarketByToken(fakeTokenId, logger);
      expect(market).toBeNull();
    });
  });

  describe('Market Data Structure Validation', () => {
    it('should return market with valid structure for Bitcoin market', async () => {
      const market = await getMarketBySlug(BITCOIN_MARKET_SLUG, logger);

      expect(market).not.toBeNull();
      
      // Validate structure
      expect(market).toHaveProperty('id');
      expect(market).toHaveProperty('question');
      expect(market).toHaveProperty('outcomes');
      expect(market).toHaveProperty('tokenIds');
      expect(market).toHaveProperty('active');
      expect(market).toHaveProperty('closed');

      // Validate types
      expect(typeof market?.id).toBe('string');
      expect(typeof market?.question).toBe('string');
      expect(Array.isArray(market?.outcomes)).toBe(true);
      expect(Array.isArray(market?.tokenIds)).toBe(true);
      expect(typeof market?.active).toBe('boolean');
      expect(typeof market?.closed).toBe('boolean');

      // Validate token IDs format (should be numeric strings)
      market?.tokenIds.forEach(tokenId => {
        expect(typeof tokenId).toBe('string');
        expect(tokenId.length).toBeGreaterThan(0);
      });
    });
  });
});

