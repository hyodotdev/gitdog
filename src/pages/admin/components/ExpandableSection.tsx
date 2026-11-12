import { cn } from "../../../utils/cn";

interface ExpandableSectionProps {
  title: string;
  content: string;
}

export function ExpandableSection({ title, content }: ExpandableSectionProps) {
  return (
    <div>
      <div
        className={cn(
          "text-xs font-bold text-gray-600 mb-1",
          "dark:text-gray-400",
        )}
      >
        {title}
      </div>
      <pre
        className={cn(
          "text-xs whitespace-pre-wrap p-3 bg-gray-100 overflow-x-auto max-h-96 overflow-y-auto font-mono",
          "dark:bg-gray-800 dark:text-gray-300",
        )}
      >
        {content}
      </pre>
    </div>
  );
}
