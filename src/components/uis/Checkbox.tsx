import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: CheckboxProps) {
  return (
    <label
      className={cn(
        // Display & Flex
        "flex items-start gap-3",
        // Interactivity
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      {/* Fixed-size box so a wrapping label never squeezes the control */}
      <span
        className={cn(
          // Display & Flex
          "relative block shrink-0",
          // Sizing
          "w-5 h-5",
          // Spacing
          "mt-0.5",
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className={cn(
            // Peer for the check mark overlay
            "peer",
            // Reset native chrome so every platform renders the same square
            "appearance-none rounded-none m-0",
            // Sizing
            "block w-5 h-5",
            // Background & Border
            "bg-white border-2 border-gray-300",
            // Interactivity
            disabled ? "cursor-not-allowed" : "cursor-pointer",
            // State
            "checked:bg-black checked:border-black",
            "focus-visible:outline focus-visible:outline-2",
            "focus-visible:outline-offset-2 focus-visible:outline-black",
            // Dark mode
            "dark:bg-[#0a0a0a] dark:border-gray-700",
            "dark:checked:bg-white dark:checked:border-white",
            "dark:focus-visible:outline-white",
          )}
        />
        <Check
          aria-hidden="true"
          strokeWidth={3}
          className={cn(
            // Position
            "pointer-events-none absolute inset-0 m-auto",
            // Sizing
            "w-3.5 h-3.5",
            // Typography
            "text-white",
            // State
            "opacity-0 peer-checked:opacity-100",
            // Dark mode
            "dark:text-black",
          )}
        />
      </span>
      <span className={cn("flex-1 min-w-0")}>
        <span
          className={cn(
            // Typography
            "block text-black",
            description && "font-medium",
            // Dark mode
            "dark:text-white",
          )}
        >
          {label}
        </span>
        {description && (
          <span
            className={cn(
              // Typography
              "block text-sm text-gray-600",
              // Dark mode
              "dark:text-gray-400",
            )}
          >
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
