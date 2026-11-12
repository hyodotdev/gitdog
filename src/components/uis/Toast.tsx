import { X, CheckCircle, AlertCircle, Info } from "lucide-react";
import { toasts, dismissToast } from "../../utils/signals/toast";
import { useSignals } from "@preact/signals-react/runtime";
import { cn } from "../../utils/cn";

export function ToastContainer() {
  useSignals();

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className={cn(
        // Layout
        "fixed bottom-6 right-6 z-50",
        // Display & Flex
        "flex flex-col gap-2",
      )}
    >
      {toasts.value.map((toast) => (
        <div
          key={toast.id}
          role={toast.type === "error" ? "alert" : "status"}
          className={cn(
            // Display & Flex
            "flex items-center gap-3",
            // Sizing
            "w-[calc(100vw-3rem)] sm:w-auto sm:min-w-[300px] sm:max-w-[500px]",
            // Spacing
            "px-4 py-3",
            // Background & Border
            "bg-white border",
            toast.type === "error" && "border-red-500",
            toast.type === "success" && "border-green-500",
            toast.type === "info" && "border-gray-300",
            // Effects
            "shadow-lg",
            // Animation
            "animate-in slide-in-from-right",
            // Dark mode
            "dark:bg-[#0a0a0a]",
            toast.type === "info" && "dark:border-gray-700",
          )}
        >
          {toast.type === "success" && (
            <CheckCircle size={20} className={cn("shrink-0 text-green-500")} />
          )}
          {toast.type === "error" && (
            <AlertCircle size={20} className={cn("shrink-0 text-red-500")} />
          )}
          {toast.type === "info" && (
            <Info size={20} className={cn("shrink-0 text-gray-500")} />
          )}
          <p
            className={cn(
              // Flex
              "flex-1",
              // Typography
              "text-sm text-black",
              // Dark mode
              "dark:text-white",
            )}
          >
            {toast.message}
          </p>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dismissToast(toast.id);
            }}
            className={cn(
              // Flex
              "shrink-0",
              // Spacing
              "p-1",
              // Typography
              "text-gray-400",
              // Interactivity
              "cursor-pointer",
              // State
              "hover:text-gray-600",
              // Dark mode
              "dark:hover:text-gray-300",
            )}
            type="button"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
