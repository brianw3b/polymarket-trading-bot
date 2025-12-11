"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@/providers/WalletContext";

import WalletInfo from "@/components/Header/WalletInfo";
import ConnectButton from "@/components/Header/ConnectButton";

export default function Header() {
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false);
  const { eoaAddress, disconnect } = useWallet();

  useEffect(() => {
    if (eoaAddress) {
      setIsConnectModalOpen(false);
    }
  }, [eoaAddress, setIsConnectModalOpen]);

  const handleDisconnect = useCallback(async () => {
    try {
      setIsConnectModalOpen(false);
      disconnect();
    } catch (error) {
      console.error("Disconnect error:", error);
    } finally {
      setIsConnectModalOpen(false);
    }
  }, [disconnect, setIsConnectModalOpen]);

  return (
    <div className="flex flex-col items-center relative">
      {eoaAddress ? (
        <WalletInfo onDisconnect={handleDisconnect} />
      ) : (
        <ConnectButton
          isModalOpen={isConnectModalOpen}
          onToggleModal={() => setIsConnectModalOpen(!isConnectModalOpen)}
          onConnect={() => setIsConnectModalOpen(false)}
        />
      )}
    </div>
  );
}
