"use client";

import { ReactNode } from "react";
import { WagmiProvider as Wagmi, createConfig } from "wagmi";
import { POLYGON_RPC_URL } from "@/constants/polymarket";
import { injected } from "wagmi/connectors";
import { polygon } from "wagmi/chains";
import { http } from "viem";

const config = createConfig({
  chains: [polygon],
  transports: {
    [polygon.id]: http(POLYGON_RPC_URL),
  },
  connectors: [injected({ shimDisconnect: true })],
  ssr: true,
});

export default function WagmiProvider({ children }: { children: ReactNode }) {
  return <Wagmi config={config}>{children}</Wagmi>;
}
