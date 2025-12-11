import { cn } from "@/utils/classNames";

interface StatDisplayProps {
  label: string;
  value: string | number;
  highlight?: boolean;
  highlightColor?: "green" | "red";
  className?: string;
}

export default function StatDisplay({
  label,
  value,
  highlight = false,
  highlightColor = "green",
  className,
}: StatDisplayProps) {
  return (
    <div className={className}>
      <p className="text-white/60 text-xs mb-1">{label}</p>
      <p
        className={cn(
          "font-medium",
          highlight && highlightColor === "green" && "text-green-400",
          highlight && highlightColor === "red" && "text-red-400"
        )}
      >
        {value}
      </p>
    </div>
  );
}
