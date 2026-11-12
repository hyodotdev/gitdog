import { ReactNode, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "../../utils/cn";
import { useTranslation } from "react-i18next";

export interface ModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Modal title */
  title: string;
  /** Modal content */
  children: ReactNode;
  /** Custom class name for the modal content */
  className?: string;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  className,
}: ModalProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Close on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  // Prevent body scroll when modal is open and manage focus
  useEffect(() => {
    if (isOpen) {
      // Capture the element that had focus before opening
      previousFocusRef.current = document.activeElement as HTMLElement;
      document.body.style.overflow = "hidden";
      // Move focus into the dialog
      requestAnimationFrame(() => {
        containerRef.current?.focus();
      });
    } else {
      document.body.style.overflow = "";
      // Restore focus to the previously focused element
      if (previousFocusRef.current) {
        requestAnimationFrame(() => {
          previousFocusRef.current?.focus();
        });
      }
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center",
        "bg-black/50 backdrop-blur-xs",
      )}
      role="presentation"
      onClick={onClose}
    >
      <div
        className={cn(
          "relative max-w-2xl w-full mx-4 max-h-[80vh]",
          "bg-white dark:bg-gray-900",
          "border border-gray-200 dark:border-gray-800",
          "shadow-2xl",
          "flex flex-col",
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        ref={containerRef}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className={cn(
            "flex items-center justify-between px-6 py-4",
            "border-b border-gray-200 dark:border-gray-800",
          )}
        >
          <h2 id="modal-title" className={cn("text-lg font-bold font-display")}>
            {title}
          </h2>
          <button
            onClick={onClose}
            className={cn(
              "p-1 hover:bg-gray-100 dark:hover:bg-gray-800",
              "transition-colors",
            )}
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className={cn("overflow-y-auto px-6 py-4")}>{children}</div>
      </div>
    </div>
  );
}
