"use client";

import {
  useConnection,
  useDisconnect,
  useWalletClient,
  useConnect,
  useConnectors,
} from "wagmi";
import { providers } from "ethers";
import { createPublicClient, http } from "viem";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { WalletContext, WalletContextType } from "./WalletContext";
import { POLYGON_RPC_URL } from "@/constants/polymarket";
import { polygon } from "viem/chains";

const publicClient = createPublicClient({
  chain: polygon,
  transport: http(POLYGON_RPC_URL),
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [ethersSigner, setEthersSigner] =
    useState<providers.JsonRpcSigner | null>(null);

  const { address: eoaAddress, isConnected: wagmiConnected } = useConnection();
  const { data: wagmiWalletClient } = useWalletClient();
  const { disconnectAsync } = useDisconnect();
  const { connectAsync } = useConnect();
  const connectors = useConnectors();

  useEffect(() => {
    if (wagmiWalletClient) {
      try {
        const provider = new providers.Web3Provider(wagmiWalletClient as any);
        setEthersSigner(provider.getSigner());
      } catch (error) {
        console.error("Failed to create ethers signer:", error);
        setEthersSigner(null);
      }
    } else {
      setEthersSigner(null);
    }
  }, [wagmiWalletClient]);

  const connect = async () => {
    try {
      const injectedConnector = connectors.find((c) => c.id === "injected");
      if (injectedConnector) {
        await connectAsync({ connector: injectedConnector });
      }
    } catch (error) {
      console.error("Connect error:", error);
    }
  };

  const disconnect = async () => {
    try {
      await disconnectAsync();
      setEthersSigner(null);
    } catch (error) {
      console.error("Disconnect error:", error);
    }
  };

  const value = useMemo<WalletContextType>(
    () => ({
      eoaAddress,
      walletClient: wagmiWalletClient || null,
      ethersSigner,
      publicClient,
      connect,
      disconnect,
      isConnected: wagmiConnected,
    }),
    [eoaAddress, wagmiWalletClient, ethersSigner, wagmiConnected]
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}
