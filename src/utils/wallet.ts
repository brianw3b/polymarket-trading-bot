import { Wallet, providers } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";
import { BotConfig } from "../config";
import { Logger } from "./logger";

export interface WalletSetup {
  wallet: Wallet;
  provider: providers.JsonRpcProvider;
  address: string; // EOA address
  safeAddress: string; // Safe (proxy) wallet address
  relayClient: RelayClient;
}

export async function initializeWallet(
  config: BotConfig,
  logger: Logger
): Promise<WalletSetup> {
  try {
    const provider = new providers.JsonRpcProvider(config.polygonRpcUrl);
    const wallet = new Wallet(config.privateKey, provider);
    const address = await wallet.getAddress();

    logger.info(`EOA Wallet initialized: ${address}`);
    logger.info(`Network: Polygon (Chain ID: ${config.polygonChainId})`);
    logger.info(
      `Note: Polymarket uses gasless trading - only USDC.e needed, not MATIC`
    );

    const balance = await provider.getBalance(address);
    logger.info(
      `USDCe balance: ${balance.toString()} wei (not required for gasless trading)`
    );

    let builderConfig: BuilderConfig | undefined;
    if (
      config.builderApiKey &&
      config.builderSecret &&
      config.builderPassphrase
    ) {
      builderConfig = new BuilderConfig({
        localBuilderCreds: {
          key: config.builderApiKey,
          secret: config.builderSecret,
          passphrase: config.builderPassphrase,
        },
      });
      logger.info("Builder config initialized for RelayClient");
    } else {
      logger.warn(
        "Builder credentials not provided - RelayClient may not work properly"
      );
    }

    const relayClient = new RelayClient(
      config.relayerUrl,
      config.polygonChainId,
      wallet,
      builderConfig
    );

    const contractConfig = getContractConfig(config.polygonChainId);
    const safeAddress = deriveSafe(
      address,
      contractConfig.SafeContracts.SafeFactory
    );
    logger.info(`Safe (proxy) wallet address: ${safeAddress}`);

    let isDeployed = false;
    try {
      isDeployed = await (relayClient as any).getDeployed(safeAddress);
    } catch (error) {
      const code = await provider.getCode(safeAddress);
      isDeployed = code !== "0x" && code.length > 2;
    }

    if (!isDeployed) {
      logger.info("Safe wallet not deployed yet. Deploying...");
      try {
        const response = await relayClient.deploy();
        const result = await response.wait();
        if (result?.proxyAddress) {
          logger.info(
            `Safe wallet deployed successfully at: ${result.proxyAddress}`
          );
        } else {
          logger.warn(
            "Safe deployment response missing proxyAddress, but continuing..."
          );
        }
      } catch (error: any) {
        logger.error("Failed to deploy Safe wallet", {
          error: error?.message || String(error),
          note: "You may need to deploy it manually via Polymarket website",
        });
      }
    } else {
      logger.info("Safe wallet already deployed");
    }

    logger.info(
      `IMPORTANT: Send USDC.e to Safe address (${safeAddress}), not EOA address!`
    );

    return { wallet, provider, address, safeAddress, relayClient };
  } catch (error) {
    logger.error("Failed to initialize wallet", { error });
    throw error;
  }
}

export async function initializeClobClient(
  config: BotConfig,
  wallet: Wallet,
  eoaAddress: string,
  safeAddress: string,
  logger: Logger
): Promise<ClobClient> {
  try {
    const tempClient = new ClobClient(
      config.clobApiUrl,
      config.polygonChainId,
      wallet
    );

    logger.info("Creating/deriving API credentials...");
    let apiCredentials;
    try {
      const derivedCreds = await tempClient.deriveApiKey().catch(() => null);

      if (
        derivedCreds?.key &&
        derivedCreds?.secret &&
        derivedCreds?.passphrase
      ) {
        apiCredentials = derivedCreds;
        logger.info("Derived existing API credentials");
      } else {
        logger.info("Creating new API credentials...");
        apiCredentials = await tempClient.createApiKey();
        logger.info("Created new API credentials");
      }
    } catch (error) {
      logger.error("Failed to get API credentials", { error });
      throw error;
    }

    let builderConfig: BuilderConfig | undefined;
    if (
      config.builderApiKey &&
      config.builderSecret &&
      config.builderPassphrase
    ) {
      builderConfig = new BuilderConfig({
        localBuilderCreds: {
          key: config.builderApiKey,
          secret: config.builderSecret,
          passphrase: config.builderPassphrase,
        },
      });
      logger.info("Builder config initialized for order attribution");
    }

    const clobClient = new ClobClient(
      config.clobApiUrl,
      config.polygonChainId,
      wallet,
      apiCredentials,
      2,
      safeAddress,
      undefined,
      false,
      builderConfig
    );

    logger.info("CLOB client initialized successfully");
    logger.info(
      `Using Safe wallet (${safeAddress}) as funder for gasless trading`
    );
    logger.info(`EOA wallet (${eoaAddress}) is used for signing only`);
    return clobClient;
  } catch (error) {
    logger.error("Failed to initialize CLOB client", { error });
    throw error;
  }
}
