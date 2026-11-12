import { cn } from "../../../utils/cn";

interface EmptyStateProps {
  icon: React.ReactNode;
  message: string;
}

export function EmptyState({ icon, message }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "p-12 text-center border border-gray-200",
        "dark:border-gray-800",
      )}
    >
      <div className={cn("mx-auto mb-4 text-gray-400", "dark:text-gray-600")}>
        {icon}
      </div>
      <p className={cn("text-gray-600", "dark:text-gray-400")}>{message}</p>
    </div>
  );
}
