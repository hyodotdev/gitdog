import { useState } from "react";
import { useQuery } from "convex/react";
import { useTranslation } from "react-i18next";
import { api } from "../../../../convex/_generated/api";
import { Helmet } from "react-helmet-async";
import { AdminLayout } from "../../../components/AdminLayout";
import { LoadingIndicator } from "../../../components/uis/LoadingIndicator";
import { StatCard } from "../components/StatCard";
import { EmptyState } from "../components/EmptyState";
import { NotFoundPage } from "../../not-found";
import { cn } from "../../../utils/cn";
import { TicketCard } from "./TicketCard";
import { RepositoryCard } from "./RepositoryCard";
import { LogItem } from "./LogItem";
import { Activity, CheckCircle, XCircle, Zap, DollarSign } from "lucide-react";

type ViewMode = "by_ticket" | "by_indexing" | "all_logs";

export function AdminWorkflowsPage() {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>("by_ticket");
  const [expandedTicketKey, setExpandedTicketKey] = useState<string | null>(
    null,
  );
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [ticketCursor, setTicketCursor] = useState<number | undefined>(
    undefined,
  );
  const [indexingCursor, setIndexingCursor] = useState<number | undefined>(
    undefined,
  );

  const isAdmin = useQuery(api.admin.query.isAdmin);
  const stats = useQuery(api.admin.query.getAiLogStats, isAdmin ? {} : "skip");
  const ticketLogs = useQuery(
    api.admin.query.listAiLogsByTicket,
    isAdmin ? { limit: 50, cursor: ticketCursor } : "skip",
  );
  const indexingLogs = useQuery(
    api.admin.query.listAiLogsByIndexing,
    isAdmin ? { limit: 50, cursor: indexingCursor } : "skip",
  );

  if (isAdmin === undefined) {
    return (
      <AdminLayout>
        <div className={cn("flex items-center justify-center min-h-[60vh]")}>
          <LoadingIndicator />
        </div>
      </AdminLayout>
    );
  }

  if (!isAdmin) {
    return <NotFoundPage />;
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString("ko-KR", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(2)}M`;
    }
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k`;
    }
    return tokens.toString();
  };

  const formatCurrency = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  return (
    <>
      <Helmet>
        <title>{t("admin.workflows.title")}</title>
      </Helmet>
      <AdminLayout>
        <div className={cn("max-w-7xl mx-auto px-6 py-12")}>
          {/* Header */}
          <div className={cn("mb-6")}>
            <h1
              className={cn(
                "text-3xl font-brand font-bold text-black mb-2",
                "dark:text-white",
              )}
            >
              {t("admin.workflows.heading")}
            </h1>
          </div>

          {/* Stats Overview */}
          {stats && (
            <div
              className={cn("grid grid-cols-2 gap-4 mb-8", "md:grid-cols-6")}
            >
              <StatCard
                label={t("admin.workflows.stats.total")}
                value={stats.total}
                icon={<Activity size={20} />}
              />
              <StatCard
                label={t("admin.workflows.stats.successRate")}
                value={`${stats.successRate}%`}
                icon={<CheckCircle size={20} />}
                valueColor="text-green-600 dark:text-green-400"
              />
              <StatCard
                label={t("admin.workflows.stats.approvalRate")}
                value={`${stats.approvalRate}%`}
                icon={<CheckCircle size={20} />}
                valueColor="text-blue-600 dark:text-blue-400"
              />
              <StatCard
                label={t("admin.workflows.stats.failed")}
                value={stats.failed}
                icon={<XCircle size={20} />}
                valueColor="text-red-600 dark:text-red-400"
              />
              <StatCard
                label={t("admin.workflows.stats.tokensUsed")}
                value={formatTokens(
                  stats.totalInputTokens + stats.totalOutputTokens,
                )}
                icon={<Zap size={20} />}
              />
              <StatCard
                label={t("admin.workflows.stats.totalCost")}
                value={formatCurrency(stats.totalCostCents)}
                icon={<DollarSign size={20} />}
              />
            </div>
          )}

          {/* Workflow Type Breakdown */}
          {stats && Object.keys(stats.byWorkflowType).length > 0 && (
            <div
              className={cn(
                "mb-8 p-6 border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <h2
                className={cn(
                  "text-lg font-brand font-bold mb-4",
                  "dark:text-white",
                )}
              >
                {t("admin.workflows.byWorkflowType")}
              </h2>
              <div className={cn("grid grid-cols-2 gap-4", "md:grid-cols-4")}>
                {Object.entries(stats.byWorkflowType).map(([type, data]) => {
                  const workflowData = data as {
                    total: number;
                    success: number;
                    failed: number;
                  };
                  return (
                    <div
                      key={type}
                      className={cn(
                        "p-4 border border-gray-200",
                        "dark:border-gray-700",
                      )}
                    >
                      <div
                        className={cn(
                          "text-sm text-gray-600 mb-1",
                          "dark:text-gray-400",
                        )}
                      >
                        {type}
                      </div>
                      <div
                        className={cn("text-xl font-bold", "dark:text-white")}
                      >
                        {workflowData.total}
                      </div>
                      <div className={cn("text-xs text-gray-500")}>
                        {t("admin.workflows.successFailed", {
                          success: workflowData.success,
                          failed: workflowData.failed,
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* View Mode Toggle */}
          <div className={cn("mb-6 flex gap-2")}>
            <button
              onClick={() => setViewMode("by_ticket")}
              className={cn(
                "px-4 py-2 text-sm border",
                viewMode === "by_ticket"
                  ? "bg-black text-white border-black dark:bg-white dark:text-black dark:border-white"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100 dark:bg-gray-900 dark:text-gray-300 dark:border-gray-700 dark:hover:bg-gray-800",
              )}
            >
              {t("admin.workflows.viewModes.byTicket")}
            </button>
            <button
              onClick={() => setViewMode("by_indexing")}
              className={cn(
                "px-4 py-2 text-sm border",
                viewMode === "by_indexing"
                  ? "bg-black text-white border-black dark:bg-white dark:text-black dark:border-white"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100 dark:bg-gray-900 dark:text-gray-300 dark:border-gray-700 dark:hover:bg-gray-800",
              )}
            >
              {t("admin.workflows.viewModes.byIndexing")}
            </button>
            <button
              onClick={() => setViewMode("all_logs")}
              className={cn(
                "px-4 py-2 text-sm border",
                viewMode === "all_logs"
                  ? "bg-black text-white border-black dark:bg-white dark:text-black dark:border-white"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100 dark:bg-gray-900 dark:text-gray-300 dark:border-gray-700 dark:hover:bg-gray-800",
              )}
            >
              {t("admin.workflows.viewModes.allLogs")}
            </button>
          </div>

          {/* Ticket-based View */}
          {viewMode === "by_ticket" && (
            <>
              {ticketLogs === undefined ? (
                <div className={cn("flex items-center justify-center py-12")}>
                  <LoadingIndicator />
                </div>
              ) : ticketLogs.tickets.length === 0 ? (
                <EmptyState
                  icon={<Activity size={48} />}
                  message={t("admin.workflows.empty.noAiLogs")}
                />
              ) : (
                <div className={cn("space-y-4")}>
                  {ticketLogs.tickets.map((ticket) => {
                    const ticketKey =
                      ticket.ticketId ||
                      `${ticket.githubRepo}-${ticket.githubNumber}`;

                    return (
                      <TicketCard
                        key={ticketKey}
                        ticket={ticket}
                        isExpanded={expandedTicketKey === ticketKey}
                        expandedLogId={expandedLogId}
                        onToggle={() =>
                          setExpandedTicketKey(
                            expandedTicketKey === ticketKey ? null : ticketKey,
                          )
                        }
                        onLogToggle={setExpandedLogId}
                        formatDate={formatDate}
                        formatTokens={formatTokens}
                      />
                    );
                  })}

                  {/* Load More Button */}
                  {ticketLogs.hasMore && (
                    <div className={cn("flex justify-center pt-4")}>
                      <button
                        onClick={() =>
                          setTicketCursor(ticketLogs.nextCursor as number)
                        }
                        className={cn(
                          "px-6 py-2 text-sm border border-gray-300 hover:bg-gray-100",
                          "dark:border-gray-700 dark:hover:bg-gray-800 dark:text-gray-300",
                        )}
                      >
                        {t("admin.workflows.loadMore")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Indexing-based View */}
          {viewMode === "by_indexing" && (
            <>
              {indexingLogs === undefined ? (
                <div className={cn("flex items-center justify-center py-12")}>
                  <LoadingIndicator />
                </div>
              ) : indexingLogs.repositories.length === 0 ? (
                <EmptyState
                  icon={<Activity size={48} />}
                  message={t("admin.workflows.empty.noIndexingLogs")}
                />
              ) : (
                <div className={cn("space-y-4")}>
                  {indexingLogs.repositories.map((repo) => {
                    const repoKey =
                      repo.repositoryId || repo.githubRepo || "unknown";

                    return (
                      <RepositoryCard
                        key={repoKey}
                        repo={repo}
                        isExpanded={expandedTicketKey === repoKey}
                        expandedLogId={expandedLogId}
                        onToggle={() =>
                          setExpandedTicketKey(
                            expandedTicketKey === repoKey ? null : repoKey,
                          )
                        }
                        onLogToggle={setExpandedLogId}
                        formatDate={formatDate}
                        formatTokens={formatTokens}
                      />
                    );
                  })}

                  {/* Load More Button */}
                  {indexingLogs.hasMore && (
                    <div className={cn("flex justify-center pt-4")}>
                      <button
                        onClick={() =>
                          setIndexingCursor(indexingLogs.nextCursor as number)
                        }
                        className={cn(
                          "px-6 py-2 text-sm border border-gray-300 hover:bg-gray-100",
                          "dark:border-gray-700 dark:hover:bg-gray-800 dark:text-gray-300",
                        )}
                      >
                        {t("admin.workflows.loadMore")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* All Logs View */}
          {viewMode === "all_logs" && (
            <>
              {ticketLogs === undefined ? (
                <div className={cn("flex items-center justify-center py-12")}>
                  <LoadingIndicator />
                </div>
              ) : ticketLogs.tickets.length === 0 ? (
                <EmptyState
                  icon={<Activity size={48} />}
                  message={t("admin.workflows.empty.noAiLogs")}
                />
              ) : (
                <div className={cn("space-y-2")}>
                  {ticketLogs.tickets.flatMap((ticket) =>
                    ticket.logs.map((log) => (
                      <LogItem
                        key={log._id}
                        log={log}
                        isExpanded={expandedLogId === log._id}
                        onToggle={() =>
                          setExpandedLogId(
                            expandedLogId === log._id ? null : log._id,
                          )
                        }
                        formatDate={formatDate}
                        formatTokens={formatTokens}
                        showTicketInfo
                      />
                    )),
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </AdminLayout>
    </>
  );
}
