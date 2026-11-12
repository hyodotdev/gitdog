import { cn } from "../../utils/cn";
import {
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  CircleX,
  CircleMinus,
} from "lucide-react";

type Status =
  | "pending"
  | "pending_approval"
  | "approved"
  | "executing"
  | "completed"
  | "failed"
  | "rejected"
  | "skipped"
  | "open"
  | "closed";

interface StatusBadgeProps {
  status: Status;
  label: string;
  size?: "small" | "medium";
}

export function StatusBadge({
  status,
  label,
  size = "medium",
}: StatusBadgeProps) {
  const isSmall = size === "small";

  // Get icon and styles based on status
  const getStatusConfig = () => {
    switch (status) {
      case "pending":
      case "pending_approval":
        return {
          icon: <Clock size={isSmall ? 14 : 18} className="animate-pulse" />,
          className:
            "bg-yellow-50 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-500",
        };
      case "approved":
        return {
          icon: <CheckCircle size={isSmall ? 14 : 18} />,
          className:
            "bg-blue-50 text-blue-800 dark:bg-blue-900/20 dark:text-blue-500",
        };
      case "executing":
        return {
          icon: <Loader2 size={isSmall ? 14 : 18} className="animate-spin" />,
          className:
            "bg-blue-50 text-blue-800 dark:bg-blue-900/20 dark:text-blue-500",
        };
      case "completed":
        return {
          icon: <CheckCircle size={isSmall ? 14 : 18} />,
          className:
            "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-500",
        };
      case "failed":
        return {
          icon: <XCircle size={isSmall ? 14 : 18} />,
          className:
            "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-500",
        };
      case "rejected":
        return {
          icon: <CircleX size={isSmall ? 14 : 18} />,
          className:
            "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
        };
      case "skipped":
        return {
          icon: <CircleMinus size={isSmall ? 14 : 18} />,
          className:
            "bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-400",
        };
      case "open":
        return {
          icon: <CheckCircle size={isSmall ? 14 : 18} />,
          className:
            "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-500",
        };
      case "closed":
        return {
          icon: <CircleX size={isSmall ? 14 : 18} />,
          className:
            "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
        };
      default:
        return {
          icon: <Clock size={isSmall ? 14 : 18} />,
          className:
            "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300",
        };
    }
  };

  const { icon, className } = getStatusConfig();

  return (
    <div
      className={cn(
        "flex items-center gap-2",
        isSmall ? "px-2 py-1" : "px-3 py-2",
        className,
      )}
    >
      {icon}
      <span className={cn(isSmall ? "text-xs" : "text-sm", "font-medium")}>
        {label}
      </span>
    </div>
  );
}
