import WalletConnectorList from "@/components/Header/WalletConnectorList";
import { cn } from "@/utils/classNames";

interface ConnectButtonProps {
  isModalOpen: boolean;
  onToggleModal: () => void;
  onConnect: () => void;
}

export default function ConnectButton({
  isModalOpen,
  onToggleModal,
  onConnect,
}: ConnectButtonProps) {
  return (
    <>
      <div className="relative flex items-center">
        <button
          className="bg-white/10 backdrop-blur-md rounded-lg px-6 py-3 hover:bg-white/20 cursor-pointer transition-colors font-semibold select-none"
          onClick={onToggleModal}
        >
          Connect Wallet
        </button>
      </div>

      <div
        className={cn(
          "absolute top-16 left-1/2 -translate-x-1/2 z-10 transition-all duration-200",
          isModalOpen ? "opacity-100 visible" : "opacity-0 invisible"
        )}
      >
        <div className="bg-white/10 backdrop-blur-md rounded-lg p-6 min-w-[280px] md:min-w-[360px] shadow-xl border border-white/20">
          <WalletConnectorList onConnect={onConnect} />
        </div>
      </div>
    </>
  );
}
