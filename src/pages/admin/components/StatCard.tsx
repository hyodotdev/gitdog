import { cn } from "../../../utils/cn";

interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  valueColor?: string;
}

export function StatCard({ label, value, icon, valueColor }: StatCardProps) {
  return (
    <div className={cn("p-4 border border-gray-200", "dark:border-gray-800")}>
      <div className={cn("flex items-center gap-2 mb-2")}>
        <span className={cn("text-gray-600", "dark:text-gray-400")}>
          {icon}
        </span>
        <span className={cn("text-sm text-gray-600", "dark:text-gray-400")}>
          {label}
        </span>
      </div>
      <div
        className={cn(
          "text-2xl font-brand font-bold",
          valueColor || "text-black dark:text-white",
        )}
      >
        {value}
      </div>
    </div>
  );
}
