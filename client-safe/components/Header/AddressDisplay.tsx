import { cn } from "@/utils/classNames";
import { formatAddress } from "@/utils/formatting";

interface AddressDisplayProps {
  address: string;
  label: string;
  onClick?: () => void;
  variant?: "default" | "primary";
}

export default function AddressDisplay({
  address,
  label,
  onClick,
  variant = "default",
}: AddressDisplayProps) {
  const baseStyles =
    "border rounded-lg px-4 py-2 transition-all select-none font-mono text-sm w-full sm:w-auto text-center";

  const variantStyles = {
    default:
      "bg-white/5 border-white/10 hover:bg-white/15 hover:border-white/30",
    primary:
      "bg-blue-500/10 border-blue-500/30 hover:bg-blue-500/20 hover:border-blue-500/50 text-blue-300 hover:text-blue-200",
  };

  return (
    <div
      onClick={onClick}
      className={cn(
        baseStyles,
        variantStyles[variant],
        onClick && "cursor-pointer"
      )}
      role={onClick ? "button" : undefined}
    >
      {label}: {formatAddress(address)}
    </div>
  );
}
