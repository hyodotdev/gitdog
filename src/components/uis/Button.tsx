import { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../utils/cn";
import { LoadingIndicator } from "./LoadingIndicator";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "auth";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  children,
  className,
  disabled,
  ...props
}: ButtonProps) {
  const baseStyles = cn(
    "inline-flex items-center justify-center gap-2",
    "font-medium transition-colors",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  );

  const sizeStyles = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-base",
    lg: "px-6 py-3 text-lg",
  };

  const variantStyles = {
    primary: cn(
      "bg-black text-white",
      "hover:bg-gray-800",
      "dark:bg-white dark:text-black dark:hover:bg-gray-200",
    ),
    secondary: cn(
      "bg-white text-black",
      "border border-gray-300",
      "hover:bg-gray-100",
      "dark:bg-[#0a0a0a] dark:text-white dark:border-gray-700 dark:hover:bg-gray-900",
    ),
    danger: cn(
      "bg-red-600 text-white",
      "hover:bg-red-700",
      "dark:bg-red-600 dark:hover:bg-red-700",
    ),
    ghost: cn(
      "text-gray-600 hover:text-black",
      "hover:bg-gray-100",
      "dark:text-gray-400 dark:hover:text-white dark:hover:bg-gray-900",
    ),
    auth: cn("bg-[#FF8C42] text-black", "hover:bg-[#FF7A2E]"),
  };

  return (
    <button
      type={props.type ?? "button"}
      className={cn(
        baseStyles,
        sizeStyles[size],
        variantStyles[variant],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <LoadingIndicator />
          <span>{children}</span>
        </>
      ) : (
        <>
          {icon && <span className="shrink-0">{icon}</span>}
          <span>{children}</span>
        </>
      )}
    </button>
  );
}
