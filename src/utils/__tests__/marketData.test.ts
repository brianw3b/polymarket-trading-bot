import { getMarketByToken, MarketInfo } from '../marketData';
import { Logger } from '../logger';

// Mock fetch globally
global.fetch = jest.fn();

// Mock logger
const mockLogger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
  silly: jest.fn(),
} as unknown as Logger;

describe('getMarketByToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockClear();
  });

  it('should return market info when token ID is found', async () => {
    const tokenId = '0x1234567890abcdef';
    const mockMarkets = [
      {
        id: 'market-1',
        question: 'Will it rain tomorrow?',
        outcomes: '["YES", "NO"]',
        clobTokenIds: '["0x1234567890abcdef", "0xfedcba0987654321"]',
        active: true,
        closed: false,
      },
      {
        id: 'market-2',
        question: 'Another market',
        outcomes: '["YES", "NO"]',
        clobTokenIds: '["0xabcdef1234567890", "0x9876543210fedcba"]',
        active: true,
        closed: false,
      },
    ];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockMarkets,
    });

    const result = await getMarketByToken(tokenId, mockLogger);

    expect(result).not.toBeNull();
    expect(result).toEqual({
      id: 'market-1',
      question: 'Will it rain tomorrow?',
      outcomes: ['YES', 'NO'],
      tokenIds: ['0x1234567890abcdef', '0xfedcba0987654321'],
      active: true,
      closed: false,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://gamma-api.polymarket.com/markets?limit=500&offset=0'
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should return null when token ID is not found', async () => {
    const tokenId = '0xnonexistent';
    const mockMarkets = [
      {
        id: 'market-1',
        question: 'Will it rain tomorrow?',
        outcomes: '["YES", "NO"]',
        clobTokenIds: '["0x1234567890abcdef", "0xfedcba0987654321"]',
        active: true,
        closed: false,
      },
    ];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockMarkets,
    });

    const result = await getMarketByToken(tokenId, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should return null when API response is not ok', async () => {
    const tokenId = '0x1234567890abcdef';

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await getMarketByToken(tokenId, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to fetch market by token',
      expect.objectContaining({
        tokenId,
        error: expect.any(Error),
      })
    );
  });

  it('should return null when API response is not an array', async () => {
    const tokenId = '0x1234567890abcdef';

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'Invalid response' }),
    });

    const result = await getMarketByToken(tokenId, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to fetch market by token',
      expect.objectContaining({
        tokenId,
        error: expect.any(Error),
      })
    );
  });

  it('should handle market with missing clobTokenIds', async () => {
    const tokenId = '0x1234567890abcdef';
    const mockMarkets = [
      {
        id: 'market-1',
        question: 'Will it rain tomorrow?',
        outcomes: '["YES", "NO"]',
        active: true,
        closed: false,
      },
    ];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockMarkets,
    });

    const result = await getMarketByToken(tokenId, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should handle market with invalid JSON in clobTokenIds', async () => {
    const tokenId = '0x1234567890abcdef';
    const mockMarkets = [
      {
        id: 'market-1',
        question: 'Will it rain tomorrow?',
        outcomes: '["YES", "NO"]',
        clobTokenIds: 'invalid-json',
        active: true,
        closed: false,
      },
    ];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockMarkets,
    });

    const result = await getMarketByToken(tokenId, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should handle market with missing outcomes field', async () => {
    const tokenId = '0x1234567890abcdef';
    const mockMarkets = [
      {
        id: 'market-1',
        question: 'Will it rain tomorrow?',
        clobTokenIds: '["0x1234567890abcdef", "0xfedcba0987654321"]',
        active: true,
        closed: false,
      },
    ];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockMarkets,
    });

    const result = await getMarketByToken(tokenId, mockLogger);

    expect(result).not.toBeNull();
    expect(result?.outcomes).toEqual([]);
    expect(result?.tokenIds).toEqual(['0x1234567890abcdef', '0xfedcba0987654321']);
  });

  it('should handle network errors', async () => {
    const tokenId = '0x1234567890abcdef';
    const networkError = new Error('Network request failed');

    (global.fetch as jest.Mock).mockRejectedValueOnce(networkError);

    const result = await getMarketByToken(tokenId, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to fetch market by token',
      expect.objectContaining({
        tokenId,
        error: networkError,
      })
    );
  });

  it('should find market when token ID is in the second position', async () => {
    const tokenId = '0xfedcba0987654321';
    const mockMarkets = [
      {
        id: 'market-1',
        question: 'Will it rain tomorrow?',
        outcomes: '["YES", "NO"]',
        clobTokenIds: '["0x1234567890abcdef", "0xfedcba0987654321"]',
        active: true,
        closed: false,
      },
    ];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockMarkets,
    });

    const result = await getMarketByToken(tokenId, mockLogger);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('market-1');
    expect(result?.tokenIds).toContain(tokenId);
  });

  it('should handle multiple markets and find the correct one', async () => {
    const tokenId = '0x9876543210fedcba';
    const mockMarkets = [
      {
        id: 'market-1',
        question: 'First market',
        outcomes: '["YES", "NO"]',
        clobTokenIds: '["0x1111111111111111", "0x2222222222222222"]',
        active: true,
        closed: false,
      },
      {
        id: 'market-2',
        question: 'Second market',
        outcomes: '["YES", "NO"]',
        clobTokenIds: '["0x9876543210fedcba", "0xaaaaaaaaaaaaaaaa"]',
        active: true,
        closed: false,
      },
      {
        id: 'market-3',
        question: 'Third market',
        outcomes: '["YES", "NO"]',
        clobTokenIds: '["0xbbbbbbbbbbbbbbbb", "0xcccccccccccccccc"]',
        active: true,
        closed: false,
      },
    ];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockMarkets,
    });

    const result = await getMarketByToken(tokenId, mockLogger);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('market-2');
    expect(result?.question).toBe('Second market');
    expect(result?.tokenIds).toContain(tokenId);
  });
});

