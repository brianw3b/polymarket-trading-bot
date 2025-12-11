import { ERROR_STYLES } from "@/constants/ui";

interface ErrorStateProps {
  error: Error | string | unknown;
  title?: string;
  className?: string;
}

export default function ErrorState({
  error,
  title = "Error",
  className,
}: ErrorStateProps) {
  const errorMessage =
    error instanceof Error ? error.message : String(error || "Unknown error");

  return (
    <div className={`${ERROR_STYLES} ${className || ""}`}>
      <p className="text-center text-red-300">
        {title}: {errorMessage}
      </p>
    </div>
  );
}
