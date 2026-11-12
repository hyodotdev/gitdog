import { cn } from "../../utils/cn";

export function LoadingIndicator() {
  return (
    <div role="status" aria-label="Loading" className={cn("inline-flex gap-1")}>
      <div
        className={cn(
          // Sizing
          "w-2 h-2",
          // Background
          "bg-gray-900",
          // Animation
          "animate-pulse",
          // Dark mode
          "dark:bg-white",
        )}
        style={{ animationDelay: "0ms" }}
      />
      <div
        className={cn(
          // Sizing
          "w-2 h-2",
          // Background
          "bg-gray-900",
          // Animation
          "animate-pulse",
          // Dark mode
          "dark:bg-white",
        )}
        style={{ animationDelay: "150ms" }}
      />
      <div
        className={cn(
          // Sizing
          "w-2 h-2",
          // Background
          "bg-gray-900",
          // Animation
          "animate-pulse",
          // Dark mode
          "dark:bg-white",
        )}
        style={{ animationDelay: "300ms" }}
      />
    </div>
  );
}
