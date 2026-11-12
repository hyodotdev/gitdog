import { cn } from "../../../utils/cn";
import {
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  CircleDot,
  ExternalLink,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { LogItem } from "./LogItem";
import type { Id } from "../../../../convex/_generated/dataModel";

type AiLogStatus =
  | "success"
  | "failed"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "request_changes";

interface TicketLog {
  _id: Id<"aiLogs">;
  workflowType: string;
  actionType?: string;
  status: AiLogStatus;
  githubRepo?: string;
  githubNumber?: number;
  ticketTitle?: string;
  ticketBody?: string;
  systemPrompt?: string;
  userPrompt?: string;
  aiResponse?: string;
  errorMessage?: string;
  userFeedback?: string;
  requestChangesCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  createdAt: number;
}

interface TicketData {
  ticketId?: string | null;
  githubRepo?: string;
  githubNumber?: number;
  ticketTitle?: string;
  successCount: number;
  failedCount: number;
  pendingCount: number;
  totalLogs: number;
  logs: TicketLog[];
}

interface TicketCardProps {
  ticket: TicketData;
  isExpanded: boolean;
  expandedLogId: string | null;
  onToggle: () => void;
  onLogToggle: (logId: string | null) => void;
  formatDate: (timestamp: number) => string;
  formatTokens: (tokens: number) => string;
}

export function TicketCard({
  ticket,
  isExpanded,
  expandedLogId,
  onToggle,
  onLogToggle,
  formatDate,
  formatTokens,
}: TicketCardProps) {
  const { t } = useTranslation();

  return (
    <div className={cn("border border-gray-200", "dark:border-gray-800")}>
      {/* Ticket Header */}
      <div
        className={cn(
          "p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50",
          "dark:hover:bg-gray-900",
        )}
        onClick={onToggle}
      >
        <div className={cn("flex items-center gap-4")}>
          <CircleDot size={20} className={cn("shrink-0", "text-gray-500")} />
          <div>
            <div className={cn("flex items-center gap-2")}>
              <span className={cn("font-bold", "dark:text-white")}>
                {ticket.githubRepo} #{ticket.githubNumber}
              </span>
              {ticket.githubRepo && (
                <a
                  href={`https://github.com/${ticket.githubRepo}/issues/${ticket.githubNumber}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "text-gray-400 hover:text-gray-600",
                    "dark:hover:text-gray-300",
                  )}
                >
                  <ExternalLink size={14} />
                </a>
              )}
            </div>
            <div
              className={cn(
                "text-sm text-gray-600 truncate max-w-md",
                "dark:text-gray-400",
              )}
            >
              {ticket.ticketTitle || t("admin.workflows.noTitle")}
            </div>
          </div>
        </div>
        <div className={cn("flex items-center gap-6")}>
          <div className={cn("flex items-center gap-3")}>
            <div className={cn("flex items-center gap-1 text-sm")}>
              <CheckCircle size={14} className="shrink-0 text-green-500" />
              <span className={cn("dark:text-gray-300")}>
                {ticket.successCount}
              </span>
            </div>
            <div className={cn("flex items-center gap-1 text-sm")}>
              <XCircle size={14} className="shrink-0 text-red-500" />
              <span className={cn("dark:text-gray-300")}>
                {ticket.failedCount}
              </span>
            </div>
            {ticket.pendingCount > 0 && (
              <div className={cn("flex items-center gap-1 text-sm")}>
                <Clock size={14} className="shrink-0 text-yellow-500" />
                <span className={cn("dark:text-gray-300")}>
                  {ticket.pendingCount}
                </span>
              </div>
            )}
          </div>
          <div className={cn("text-sm text-gray-500 w-24 text-right")}>
            {ticket.totalLogs} {t("admin.workflows.logs")}
          </div>
          {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </div>
      </div>

      {/* Expanded Logs */}
      {isExpanded && (
        <div className={cn("border-t border-gray-200", "dark:border-gray-800")}>
          {ticket.logs.map((log) => (
            <LogItem
              key={log._id}
              log={log}
              isExpanded={expandedLogId === log._id}
              onToggle={() =>
                onLogToggle(expandedLogId === log._id ? null : log._id)
              }
              formatDate={formatDate}
              formatTokens={formatTokens}
            />
          ))}
        </div>
      )}
    </div>
  );
}
