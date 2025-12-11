"use client";

import { ReactNode } from "react";
import QueryProvider from "./QueryProvider";
import WagmiProvider from "./WagmiProvider";
import { WalletProvider } from "./WalletProvider";
import TradingProvider from "./TradingProvider";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider>
      <QueryProvider>
        <WalletProvider>
          <TradingProvider>{children}</TradingProvider>
        </WalletProvider>
      </QueryProvider>
    </WagmiProvider>
  );
}
