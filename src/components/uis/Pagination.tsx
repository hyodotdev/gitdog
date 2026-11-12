import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../utils/cn";
import type { ClassValue } from "clsx";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  onPageChange: (page: number) => void;
  className?: ClassValue;
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage,
  onPageChange,
  className,
}: PaginationProps) {
  if (totalPages <= 1) {
    return null;
  }

  const startItem = (currentPage - 1) * itemsPerPage + 1;
  const endItem = Math.min(currentPage * itemsPerPage, totalItems);

  return (
    <div
      className={cn(
        "flex items-center justify-between",
        "border-t border-gray-200 pt-6",
        "dark:border-gray-800",
        className,
      )}
    >
      {/* Results count */}
      <div className={cn("text-sm text-gray-600", "dark:text-gray-400")}>
        Showing {startItem}-{endItem} of {totalItems} results
      </div>

      {/* Pagination controls */}
      <div className={cn("flex items-center gap-2")}>
        {/* Previous button */}
        <button
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage === 1}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm",
            "border border-gray-300",
            "transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "hover:bg-gray-100",
            "dark:border-gray-700 dark:hover:bg-gray-800",
          )}
        >
          <ChevronLeft size={16} />
          Previous
        </button>

        {/* Page numbers */}
        <div className={cn("flex items-center gap-1")}>
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((page) => {
              // Show first page, last page, current page, and pages around current
              return (
                page === 1 ||
                page === totalPages ||
                Math.abs(page - currentPage) <= 1
              );
            })
            .map((page, index, array) => (
              <div key={page} className={cn("flex items-center gap-1")}>
                {/* Show ellipsis if there's a gap */}
                {index > 0 && array[index - 1] !== page - 1 && (
                  <span className={cn("px-2 text-gray-400")}>...</span>
                )}
                <button
                  onClick={() => onPageChange(page)}
                  className={cn(
                    "px-3 py-2 text-sm transition-colors",
                    page === currentPage
                      ? "bg-black text-white dark:bg-white dark:text-black"
                      : "border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
                  )}
                >
                  {page}
                </button>
              </div>
            ))}
        </div>

        {/* Next button */}
        <button
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage === totalPages}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm",
            "border border-gray-300",
            "transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "hover:bg-gray-100",
            "dark:border-gray-700 dark:hover:bg-gray-800",
          )}
        >
          Next
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
