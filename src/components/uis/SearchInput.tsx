import { Search } from "lucide-react";
import { cn } from "../../utils/cn";
import type { ClassValue } from "clsx";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: ClassValue;
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search...",
  className,
}: SearchInputProps) {
  return (
    <div className={cn("relative", className)}>
      <Search
        size={18}
        aria-hidden="true"
        className={cn("absolute left-3 top-1/2 -translate-y-1/2 text-gray-400")}
      />
      <input
        type="search"
        name="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full pl-10 pr-4 py-2",
          "bg-white border border-gray-300",
          "text-black placeholder-gray-500",
          "transition-colors",
          "focus:outline-hidden focus:border-black",
          "dark:bg-black dark:border-gray-700 dark:text-white dark:placeholder-gray-400",
          "dark:focus:border-white",
        )}
      />
    </div>
  );
}
