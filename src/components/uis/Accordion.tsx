import { useState, ReactNode, useEffect, useId, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../utils/cn";

export interface AccordionProps {
  /** Title to display in the header */
  title: ReactNode;
  /** Content to display when expanded */
  children: ReactNode;
  /** Initial expanded state */
  defaultExpanded?: boolean;
  /** Controlled expanded state (overrides defaultExpanded) */
  expanded?: boolean;
  /** Callback when expansion state changes */
  onExpandedChange?: (expanded: boolean) => void;
  /** Custom header content (rendered after chevron and title) */
  headerRight?: ReactNode;
  /** Custom class name for the container */
  className?: string;
  /** Custom class name for the header */
  headerClassName?: string;
  /** Custom class name for the content */
  contentClassName?: string;
  /** Whether to show border (default: true) */
  bordered?: boolean;
}

export function Accordion({
  title,
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  headerRight,
  className,
  headerClassName,
  contentClassName,
  bordered = true,
}: AccordionProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const [contentHeight, setContentHeight] = useState<number | undefined>(
    undefined,
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();

  // Support both controlled and uncontrolled modes
  const isControlled = controlledExpanded !== undefined;
  const isExpanded = isControlled ? controlledExpanded : internalExpanded;

  // Measure content height for animation
  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [children, isExpanded]);

  const handleToggle = () => {
    const newExpanded = !isExpanded;
    if (!isControlled) {
      setInternalExpanded(newExpanded);
    }
    onExpandedChange?.(newExpanded);
  };

  return (
    <div
      className={cn(
        bordered && "border border-gray-200 dark:border-gray-800",
        className,
      )}
    >
      {/* Header - Clickable */}
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className={cn(
          "w-full flex flex-row items-center gap-2 px-4 py-2",
          "bg-gray-100 hover:bg-gray-200",
          "transition-colors",
          "dark:bg-gray-900 dark:hover:bg-gray-800",
          headerClassName,
        )}
      >
        <ChevronDown
          size={16}
          className={cn(
            "transition-transform duration-200",
            !isExpanded && "-rotate-90",
          )}
        />
        <div className="flex-1 flex flex-row items-center gap-2 text-left">
          {title}
        </div>
        {headerRight && <div className="ml-auto">{headerRight}</div>}
      </button>

      {/* Content - Collapsible with animation */}
      <div
        id={contentId}
        ref={contentRef}
        className={cn(
          "overflow-hidden transition-[max-height,opacity] duration-200 ease-in-out",
          contentClassName,
        )}
        style={{
          maxHeight: isExpanded ? contentHeight : 0,
          opacity: isExpanded ? 1 : 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}
