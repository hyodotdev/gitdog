import { cn } from "../../../utils/cn";
import {
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
  Copy,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { ExpandableSection } from "../components/ExpandableSection";
import type { Id } from "../../../../convex/_generated/dataModel";

type AiLogStatus =
  | "success"
  | "failed"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "request_changes";

interface LogItemProps {
  log: {
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
  };
  isExpanded: boolean;
  onToggle: () => void;
  formatDate: (timestamp: number) => string;
  formatTokens: (tokens: number) => string;
  showTicketInfo?: boolean;
}

export function LogItem({
  log,
  isExpanded,
  onToggle,
  formatDate,
  formatTokens,
  showTicketInfo = false,
}: LogItemProps) {
  const { t } = useTranslation();

  const getStatusIcon = (status: AiLogStatus) => {
    switch (status) {
      case "success":
      case "approved":
        return <CheckCircle size={14} className="text-green-500" />;
      case "failed":
      case "rejected":
        return <XCircle size={14} className="text-red-500" />;
      case "pending_approval":
        return <Clock size={14} className="text-yellow-500" />;
      case "request_changes":
        return <RefreshCw size={14} className="text-orange-500" />;
      default:
        return <Clock size={14} className="text-gray-500" />;
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  };

  const generateAnalysisPrompt = () => {
    return `AI Response Analysis Request

## Context
- Workflow Type: ${log.workflowType}
- Action Type: ${log.actionType || "N/A"}
${log.ticketTitle ? `- Ticket Title: ${log.ticketTitle}` : ""}

## System Prompt
\`\`\`
${log.systemPrompt || "N/A"}
\`\`\`

## User Prompt
\`\`\`
${log.userPrompt || "N/A"}
\`\`\`

## AI Response
\`\`\`
${log.aiResponse || "N/A"}
\`\`\`

${log.errorMessage ? `## Error Message\n\`\`\`\n${log.errorMessage}\n\`\`\`` : ""}
${log.userFeedback ? `## User Feedback\n\`\`\`\n${log.userFeedback}\n\`\`\`` : ""}

## Request
Please analyze this AI response and identify:
1. What went wrong or could be improved
2. Suggestions for improving the system prompt
3. Any patterns that might cause similar issues`;
  };

  return (
    <div
      className={cn(
        "border-b border-gray-100 last:border-b-0",
        "dark:border-gray-800",
      )}
    >
      {/* Log Header */}
      <div
        className={cn(
          "px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50",
          "dark:hover:bg-gray-900/50",
        )}
        onClick={onToggle}
      >
        <div className={cn("flex items-center gap-3")}>
          {getStatusIcon(log.status)}
          <div>
            <div className={cn("flex items-center gap-2")}>
              <span className={cn("text-sm font-medium", "dark:text-white")}>
                {log.workflowType}
              </span>
              {log.actionType && (
                <span
                  className={cn(
                    "text-xs px-1.5 py-0.5 bg-gray-100",
                    "dark:bg-gray-800 dark:text-gray-300",
                  )}
                >
                  {log.actionType}
                </span>
              )}
              {log.requestChangesCount && log.requestChangesCount > 0 && (
                <span
                  className={cn(
                    "text-xs px-1.5 py-0.5 bg-orange-100 text-orange-600",
                    "dark:bg-orange-900/30 dark:text-orange-400",
                  )}
                >
                  {t("admin.workflows.changes", {
                    count: log.requestChangesCount,
                  })}
                </span>
              )}
            </div>
            {showTicketInfo && log.githubRepo && (
              <div className={cn("text-xs text-gray-500")}>
                {log.githubRepo} #{log.githubNumber}
              </div>
            )}
          </div>
        </div>
        <div className={cn("flex items-center gap-4")}>
          {log.inputTokens !== undefined && (
            <span className={cn("text-xs text-gray-500")}>
              {formatTokens(log.inputTokens + (log.outputTokens || 0))}{" "}
              {t("admin.workflows.tokens")}
            </span>
          )}
          {log.durationMs !== undefined && (
            <span className={cn("text-xs text-gray-500")}>
              {(log.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          <span className={cn("text-xs text-gray-500 w-20")}>
            {formatDate(log.createdAt)}
          </span>
          {isExpanded ? (
            <ChevronUp size={16} className="text-gray-400" />
          ) : (
            <ChevronDown size={16} className="text-gray-400" />
          )}
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className={cn("px-4 pb-4 space-y-3")}>
          {/* Error message */}
          {log.errorMessage && (
            <div className={cn("p-3 bg-red-50", "dark:bg-red-900/20")}>
              <div
                className={cn(
                  "text-xs font-bold text-red-600 mb-1",
                  "dark:text-red-400",
                )}
              >
                {t("admin.workflows.logDetails.error")}
              </div>
              <pre
                className={cn(
                  "text-xs text-red-700 whitespace-pre-wrap",
                  "dark:text-red-300",
                )}
              >
                {log.errorMessage}
              </pre>
            </div>
          )}

          {/* User feedback */}
          {log.userFeedback && (
            <div className={cn("p-3 bg-yellow-50", "dark:bg-yellow-900/20")}>
              <div
                className={cn(
                  "text-xs font-bold text-yellow-600 mb-1",
                  "dark:text-yellow-400",
                )}
              >
                {t("admin.workflows.logDetails.userFeedback")}
              </div>
              <pre
                className={cn(
                  "text-xs text-yellow-700 whitespace-pre-wrap",
                  "dark:text-yellow-300",
                )}
              >
                {log.userFeedback}
              </pre>
            </div>
          )}

          {/* Prompts and Response */}
          <div className={cn("space-y-3")}>
            {log.systemPrompt && (
              <ExpandableSection
                title={t("admin.workflows.logDetails.systemPrompt")}
                content={log.systemPrompt}
              />
            )}
            {log.userPrompt && (
              <ExpandableSection
                title={t("admin.workflows.logDetails.userPrompt")}
                content={log.userPrompt}
              />
            )}
            {log.aiResponse && (
              <ExpandableSection
                title={t("admin.workflows.logDetails.aiResponse")}
                content={log.aiResponse}
              />
            )}
          </div>

          {/* Actions */}
          <div className={cn("flex gap-2 flex-wrap pt-2")}>
            <button
              onClick={() => copyToClipboard(generateAnalysisPrompt())}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs",
                "bg-black text-white hover:bg-gray-800",
                "dark:bg-white dark:text-black dark:hover:bg-gray-200",
              )}
            >
              <Copy size={12} />
              {t("admin.workflows.copyAnalysisPrompt")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
