import dotenv from "dotenv";

dotenv.config();

export interface BotConfig {
  // Wallet
  privateKey: string;
  polygonRpcUrl: string;

  // Polymarket API
  clobApiUrl: string;
  relayerUrl: string;
  polygonChainId: number;

  // Builder Credentials (optional)
  builderApiKey?: string;
  builderSecret?: string;
  builderPassphrase?: string;

  // Trading
  targetTokenId?: string;
  targetMarketSlug?: string;
  marketSlugPattern?: {
    baseSlug: string;
    timePattern: "hourly" | "daily" | "15min" | "static";
  };
  tradingStrategy: string;
  orderSize: number;
  minPrice: number;
  maxPrice: number;
  pollIntervalMs: number;
  maxOrdersPerCycle: number;

  // Risk Management
  maxPositionSize: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;

  // Logging
  logLevel: string;
  logFile: string;
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && !defaultValue) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || defaultValue!;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseFloat(value) : defaultValue;
}

export function loadConfig(): BotConfig {
  return {
    // Wallet
    privateKey: getEnvVar("PRIVATE_KEY"),
    polygonRpcUrl: getEnvVar("POLYGON_RPC_URL", "https://polygon-rpc.com"),

    // Polymarket API
    clobApiUrl: getEnvVar("CLOB_API_URL", "https://clob.polymarket.com"),
    relayerUrl: getEnvVar("RELAYER_URL", "https://relayer-v2.polymarket.com"),
    polygonChainId: getEnvNumber("POLYGON_CHAIN_ID", 137),

    // Builder Credentials (optional)
    builderApiKey: process.env.POLYMARKET_BUILDER_API_KEY,
    builderSecret: process.env.POLYMARKET_BUILDER_SECRET,
    builderPassphrase: process.env.POLYMARKET_BUILDER_PASSPHRASE,

    targetMarketSlug: process.env.TARGET_MARKET_SLUG,
    marketSlugPattern:
      process.env.MARKET_SLUG_PATTERN_BASE &&
      process.env.MARKET_SLUG_PATTERN_TIME
        ? {
            baseSlug: process.env.MARKET_SLUG_PATTERN_BASE,
            timePattern:
              (process.env.MARKET_SLUG_PATTERN_TIME as
                | "hourly"
                | "daily"
                | "15min"
                | "static") || "hourly",
          }
        : undefined,
    tradingStrategy: getEnvVar("TRADING_STRATEGY", "nuoiem"),
    orderSize: getEnvNumber("ORDER_SIZE", 10),
    minPrice: getEnvNumber("MIN_PRICE", 0.01),
    maxPrice: getEnvNumber("MAX_PRICE", 0.99),
    pollIntervalMs: getEnvNumber("POLL_INTERVAL_MS", 1000),
    maxOrdersPerCycle: getEnvNumber("MAX_ORDERS_PER_CYCLE", 1),

    // Risk Management
    maxPositionSize: getEnvNumber("MAX_POSITION_SIZE", 100),
    stopLossPercentage: getEnvNumber("STOP_LOSS_PERCENTAGE", 0.05),
    takeProfitPercentage: getEnvNumber("TAKE_PROFIT_PERCENTAGE", 0.1),

    // Logging
    logLevel: getEnvVar("LOG_LEVEL", "info"),
    logFile: getEnvVar("LOG_FILE", "logs/bot.log"),
  };
}
