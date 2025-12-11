import { useCallback, useMemo } from "react";
import { useWallet } from "@/providers/WalletContext";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";
import { POLYGON_CHAIN_ID } from "@/constants/polymarket";

// This hook is responsible for deploying the Safe wallet and offers two additional helper functions
// to check if the Safe is already deployed and what the deterministic address is for the Safe

export default function useSafeDeployment() {
  const { eoaAddress, isConnected, publicClient } = useWallet();

  // This function derives the Safe address from the EOA address
  const derivedSafeAddressFromEoa = useMemo(() => {
    if (!eoaAddress || !isConnected || !POLYGON_CHAIN_ID) return null;

    try {
      const config = getContractConfig(POLYGON_CHAIN_ID);
      return deriveSafe(eoaAddress, config.SafeContracts.SafeFactory);
    } catch (error) {
      console.error("Error deriving Safe address:", error);
      return null;
    }
  }, [eoaAddress, isConnected, POLYGON_CHAIN_ID]);

  // This function checks if the Safe is deployed by querying the relay client or RPC
  const isSafeDeployed = useCallback(
    async (relayClient: RelayClient, safeAddr: string): Promise<boolean> => {
      try {
        // Try relayClient first
        const deployed = await (relayClient as any).getDeployed(safeAddr);
        return deployed;
      } catch (err) {
        console.warn("API check failed, falling back to RPC", err);

        // Fallback to RPC
        if (publicClient) {
          const code = await publicClient.getBytecode({
            address: safeAddr as `0x${string}`,
          });
          return code !== undefined && code !== "0x" && code.length > 2;
        }

        return false;
      }
    },
    [publicClient]
  );

  // This function deploys the Safe using the relayClient
  const deploySafe = useCallback(
    async (relayClient: RelayClient): Promise<string> => {
      try {
        // Prompts signer for a signature
        const response = await relayClient.deploy();
        const result = await response.wait();

        if (!result) {
          throw new Error("Safe deployment failed");
        }

        return result.proxyAddress;
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error("Failed to deploy Safe");
        throw error;
      }
    },
    []
  );

  return {
    derivedSafeAddressFromEoa,
    isSafeDeployed,
    deploySafe,
  };
}
