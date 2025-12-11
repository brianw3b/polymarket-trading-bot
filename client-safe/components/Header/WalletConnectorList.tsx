import { useCallback } from "react";
import { Connector, useConnect, useConnectors, useSwitchChain } from "wagmi";
import { polygon } from "wagmi/chains";

export default function WalletConnectorList({
  onConnect,
}: {
  onConnect: () => void;
}) {
  const { connect } = useConnect();
  const { switchChain } = useSwitchChain();
  const connectors = useConnectors();

  const handleConnect = useCallback(
    async (connector: Connector) => {
      try {
        connect({ connector, chainId: polygon.id });

        if (switchChain) {
          try {
            switchChain({ chainId: polygon.id });
          } catch (switchError) {
            console.warn("User rejected network switch:", switchError);
          }
        }

        onConnect();
      } catch (error) {
        console.error("Connection error:", error);
      }
    },
    [connect, switchChain, onConnect]
  );

  const availableConnectors = connectors.filter(
    (connector: Connector) => connector.name !== "Injected"
  );

  if (availableConnectors.length === 0) {
    return (
      <div className="flex flex-col gap-3 w-full text-center p-6 bg-white/5 border border-white/10 rounded-lg">
        <p className="text-white/70 font-medium">
          No wallet extensions detected
        </p>
        <p className="text-white/50 text-sm">
          Please install MetaMask, Rabby, Phantom, or another browser wallet
          extension.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 w-full">
      {availableConnectors.map((connector: Connector) => (
        <button
          key={connector.uid}
          onClick={() => handleConnect(connector)}
          className="bg-white/5 hover:bg-white/15 border border-white/10 hover:border-white/30 rounded-lg px-4 py-3 cursor-pointer transition-all font-medium text-center"
        >
          {connector.name}
        </button>
      ))}
    </div>
  );
}
