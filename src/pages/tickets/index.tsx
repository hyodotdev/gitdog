import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Helmet } from "react-helmet-async";
import { Layout } from "../../components/Layout";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { SearchInput } from "../../components/uis/SearchInput";
import { Pagination } from "../../components/uis/Pagination";
import { StatusBadge } from "../../components/uis/StatusBadge";
import { Link, useSearchParams } from "react-router";
import { useState, useEffect, useRef } from "react";
import {
  Ticket,
  GitPullRequest,
  MessageCircle,
  X,
  AlertTriangle,
  MessagesSquare,
  ChevronDown,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";

type TicketType = "all" | "issue" | "discussion" | "pull_request";
type TicketStatus = "all" | "open" | "closed" | "pending";

export function TicketsPage() {
  const { t, i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const repoFilter = searchParams.get("repo");

  const currentUser = useQuery(api.users.query.getCurrentUser);
  const connectedRepos = useQuery(api.repositories.query.getConnectedRepos);
  const typeParam = searchParams.get("type") as TicketType | null;
  const statusParam = searchParams.get("status") as TicketStatus | null;
  const selectedType: TicketType =
    typeParam &&
    ["all", "issue", "discussion", "pull_request"].includes(typeParam)
      ? typeParam
      : "all";
  const selectedStatus: TicketStatus =
    statusParam && ["all", "open", "closed", "pending"].includes(statusParam)
      ? statusParam
      : "all";
  const [searchQuery, setSearchQuery] = useState("");
  const filterKey = `${repoFilter ?? ""}:${selectedType}:${selectedStatus}:${searchQuery}`;
  const [pagination, setPagination] = useState({ key: filterKey, page: 1 });
  const currentPage = pagination.key === filterKey ? pagination.page : 1;
  const setCurrentPage = (page: number) =>
    setPagination({ key: filterKey, page });
  const itemsPerPage = 10;
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const repoDropdownRef = useRef<HTMLDivElement>(null);

  // Pending approvals pagination
  const [pendingVisibleCount, setPendingVisibleCount] = useState(2);

  // Pending approval dismissal state (localStorage)
  const [lastSeenPendingCount, setLastSeenPendingCount] = useState<number>(
    () => {
      const stored = localStorage.getItem("lastSeenPendingCount");
      return stored ? parseInt(stored, 10) : 0;
    },
  );

  // Get tickets with pending actions
  const pendingData = useQuery(api.tickets.query.listPendingApproval, {
    githubRepo: repoFilter || undefined,
    ticketType: selectedType === "all" ? undefined : selectedType,
    limit: pendingVisibleCount,
    offset: 0,
  });
  const pendingTotal = pendingData?.total ?? 0;

  // Close repo dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        repoDropdownRef.current &&
        !repoDropdownRef.current.contains(event.target as Node)
      ) {
        setRepoDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const pendingTickets = pendingData?.items ?? [];
  const isLoadingMore = pendingData === undefined;

  // Get tickets list
  const listArgs = {
    githubRepo: repoFilter || undefined,
    ticketType: selectedType === "all" ? undefined : selectedType,
    search: searchQuery || undefined,
    limit: itemsPerPage,
    offset: (currentPage - 1) * itemsPerPage,
  };
  const ticketsData = useQuery(
    api.tickets.query.list,
    selectedStatus === "pending"
      ? "skip"
      : {
          ...listArgs,
          status: selectedStatus === "all" ? undefined : selectedStatus,
        },
  );
  const pendingTicketsPage = useQuery(
    api.tickets.query.listPendingApproval,
    selectedStatus === "pending" ? listArgs : "skip",
  );

  const tickets =
    selectedStatus === "pending"
      ? pendingTicketsPage?.items.map((ticket) => ({
          ...ticket,
          actionCount: ticket.pendingActions.length,
          pendingActionCount: ticket.pendingActions.length,
        }))
      : ticketsData?.items;
  const totalTickets =
    selectedStatus === "pending"
      ? (pendingTicketsPage?.total ?? 0)
      : (ticketsData?.total ?? 0);
  const totalPages = Math.ceil(totalTickets / itemsPerPage);

  const isUserLoading = currentUser === undefined;
  const isTicketsLoading = tickets === undefined;

  const typeLabels: Record<TicketType, string> = {
    all: t("tickets.types.all"),
    issue: t("tickets.types.issue"),
    discussion: t("tickets.types.discussion"),
    pull_request: t("tickets.types.pullRequest"),
  };

  const statusLabels: Record<TicketStatus, string> = {
    all: t("tickets.status.all"),
    open: t("tickets.status.open"),
    closed: t("tickets.status.closed"),
    pending: t("tickets.status.pending"),
  };

  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t("common.justNow");
    if (diffMins < 60) return t("common.minutesAgo", { count: diffMins });
    if (diffHours < 24) return t("common.hoursAgo", { count: diffHours });
    if (diffDays < 7) return t("common.daysAgo", { count: diffDays });

    return date.toLocaleDateString(i18n.language, {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  };

  if (isUserLoading) {
    return (
      <>
        <Helmet>
          <title>{t("tickets.title") || "Tickets - Gitdog"}</title>
        </Helmet>
        <Layout>
          <div className={cn("py-24 flex justify-center items-center")}>
            <LoadingIndicator />
          </div>
        </Layout>
      </>
    );
  }

  if (!currentUser) {
    return (
      <>
        <Helmet>
          <title>{t("tickets.title") || "Tickets - Gitdog"}</title>
        </Helmet>
        <Layout>
          <div className={cn("py-24 text-center")}>
            <p className={cn("text-gray-600", "dark:text-gray-400")}>
              {t("tickets.signInRequired")}
            </p>
          </div>
        </Layout>
      </>
    );
  }

  return (
    <>
      <Helmet>
        <title>{t("tickets.title") || "Tickets - Gitdog"}</title>
        <meta name="description" content={t("tickets.description") || ""} />
      </Helmet>
      <Layout>
        <div className={cn("max-w-7xl mx-auto px-6 py-12")}>
          {/* Header */}
          <div className={cn("mb-8")}>
            <h1
              className={cn(
                "text-3xl font-brand font-bold text-black mb-2",
                "dark:text-white",
              )}
            >
              {t("tickets.heading")}
            </h1>
            <p className={cn("text-gray-600", "dark:text-gray-400")}>
              {t("tickets.subtitle")}
            </p>
          </div>

          {/* Search and Filters */}
          <div className={cn("mb-6 space-y-4")}>
            {/* Search */}
            <SearchInput
              value={searchQuery}
              onChange={(value) => {
                setSearchQuery(value);
                setCurrentPage(1);
              }}
              placeholder={t("tickets.searchPlaceholder")}
            />

            {/* Type, Status & Repo Filters */}
            <div className={cn("flex items-center gap-6 flex-wrap")}>
              {/* Repo Filter */}
              {connectedRepos && connectedRepos.length >= 1 && (
                <div
                  className={cn("flex items-center gap-3")}
                  ref={repoDropdownRef}
                >
                  <span
                    className={cn(
                      "text-sm font-medium text-gray-600",
                      "dark:text-gray-400",
                    )}
                  >
                    {t("tickets.filterRepo")}
                  </span>
                  <div className={cn("relative")}>
                    <button
                      onClick={() => setRepoDropdownOpen(!repoDropdownOpen)}
                      aria-expanded={repoDropdownOpen}
                      className={cn(
                        "px-4 py-2 text-sm transition-colors flex items-center gap-2 min-w-[140px] justify-between",
                        repoFilter
                          ? "bg-black text-white dark:bg-white dark:text-black"
                          : "border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
                      )}
                    >
                      <span className={cn("truncate max-w-[200px]")}>
                        {repoFilter
                          ? repoFilter.split("/")[1]
                          : t("tickets.types.all")}
                      </span>
                      <ChevronDown
                        size={16}
                        className={cn(
                          "transition-transform shrink-0",
                          repoDropdownOpen && "rotate-180",
                        )}
                      />
                    </button>
                    {repoDropdownOpen && (
                      <div
                        className={cn(
                          "absolute top-full left-0 mt-1 z-50 min-w-[200px] max-h-[300px] overflow-y-auto",
                          "bg-white border border-gray-300",
                          "dark:bg-gray-900 dark:border-gray-700",
                        )}
                      >
                        <button
                          onClick={() => {
                            const newParams = new URLSearchParams(searchParams);
                            newParams.delete("repo");
                            setSearchParams(newParams);
                            setRepoDropdownOpen(false);
                            setCurrentPage(1);
                          }}
                          className={cn(
                            "w-full px-4 py-2 text-sm text-left transition-colors",
                            !repoFilter
                              ? "bg-gray-100 dark:bg-gray-800"
                              : "hover:bg-gray-100 dark:hover:bg-gray-800",
                          )}
                        >
                          {t("tickets.types.all")}
                        </button>
                        {connectedRepos.map((repo) => (
                          <button
                            key={repo}
                            onClick={() => {
                              const newParams = new URLSearchParams(
                                searchParams,
                              );
                              newParams.set("repo", repo);
                              setSearchParams(newParams);
                              setRepoDropdownOpen(false);
                              setCurrentPage(1);
                            }}
                            className={cn(
                              "w-full px-4 py-2 text-sm text-left transition-colors truncate",
                              repoFilter === repo
                                ? "bg-gray-100 dark:bg-gray-800"
                                : "hover:bg-gray-100 dark:hover:bg-gray-800",
                            )}
                          >
                            {repo}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Type Filter */}
              <div className={cn("flex flex-wrap items-center gap-2 sm:gap-3")}>
                <span
                  className={cn(
                    "text-sm font-medium text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  {t("tickets.filterType")}
                </span>
                {(
                  ["all", "issue", "discussion", "pull_request"] as TicketType[]
                ).map((type) => (
                  <button
                    key={type}
                    onClick={() => {
                      setCurrentPage(1);
                      setPendingVisibleCount(2);
                      const newParams = new URLSearchParams(searchParams);
                      if (type === "all") {
                        newParams.delete("type");
                      } else {
                        newParams.set("type", type);
                      }
                      setSearchParams(newParams);
                    }}
                    aria-pressed={selectedType === type}
                    className={cn(
                      "px-4 py-2 text-sm whitespace-nowrap transition-colors",
                      selectedType === type
                        ? "bg-black text-white dark:bg-white dark:text-black"
                        : "border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
                    )}
                  >
                    {typeLabels[type]}
                  </button>
                ))}
              </div>

              {/* Status Filter */}
              <div className={cn("flex flex-wrap items-center gap-2 sm:gap-3")}>
                <span
                  className={cn(
                    "text-sm font-medium text-gray-600",
                    "dark:text-gray-400",
                  )}
                >
                  {t("tickets.filterStatus")}
                </span>
                {(["all", "pending", "open", "closed"] as TicketStatus[]).map(
                  (status) => (
                    <button
                      key={status}
                      onClick={() => {
                        setCurrentPage(1);
                        const newParams = new URLSearchParams(searchParams);
                        if (status === "all") {
                          newParams.delete("status");
                        } else {
                          newParams.set("status", status);
                        }
                        setSearchParams(newParams);
                      }}
                      aria-pressed={selectedStatus === status}
                      className={cn(
                        "px-4 py-2 text-sm whitespace-nowrap transition-colors flex items-center gap-2",
                        selectedStatus === status
                          ? "bg-black text-white dark:bg-white dark:text-black"
                          : "border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
                      )}
                    >
                      {statusLabels[status]}
                      {status === "pending" && pendingTotal > 0 && (
                        <span
                          className={cn(
                            "inline-flex items-center justify-center",
                            "min-w-[20px] h-5 px-1.5",
                            "text-xs font-bold",
                            selectedStatus === "pending"
                              ? "bg-white text-black dark:bg-black dark:text-white"
                              : "bg-yellow-600 text-white dark:bg-yellow-500 dark:text-black",
                          )}
                        >
                          {pendingTotal}
                        </span>
                      )}
                    </button>
                  ),
                )}
              </div>
            </div>
          </div>

          {/* Pending Approvals */}
          {!!pendingTickets?.length && pendingTotal > lastSeenPendingCount && (
            <div
              className={cn(
                "mb-8 p-6",
                "border-2 border-yellow-600",
                "bg-yellow-50/30",
                "dark:border-yellow-800 dark:bg-yellow-950/10",
              )}
            >
              {/* Header */}
              <div className={cn("flex items-center justify-between mb-4")}>
                <div className={cn("flex items-center gap-2")}>
                  <AlertTriangle
                    size={20}
                    className={cn(
                      "shrink-0",
                      "text-yellow-600 dark:text-yellow-500",
                    )}
                  />
                  <h2
                    className={cn(
                      "text-lg font-brand font-bold text-yellow-600 dark:text-yellow-500",
                    )}
                  >
                    {t("tickets.pendingApprovals")}
                  </h2>
                </div>
                {/* Close button */}
                <button
                  onClick={() => {
                    const newCount = pendingTotal;
                    setLastSeenPendingCount(newCount);
                    localStorage.setItem(
                      "lastSeenPendingCount",
                      newCount.toString(),
                    );
                  }}
                  className={cn(
                    "p-2 transition-colors",
                    "text-yellow-600 hover:bg-yellow-100",
                    "dark:text-yellow-500 dark:hover:bg-yellow-950/50",
                  )}
                  aria-label="Close pending approvals"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Ticket List with Progressive Loading */}
              <div className={cn("space-y-3")}>
                {pendingTickets.map((ticket) => {
                  const params = new URLSearchParams();
                  if (repoFilter) params.set("repo", repoFilter);
                  if (selectedType !== "all") params.set("type", selectedType);
                  if (selectedStatus !== "all")
                    params.set("status", selectedStatus);
                  const queryString = params.toString();

                  return (
                    <Link
                      key={ticket._id}
                      to={`/tickets/${ticket._id}${queryString ? `?${queryString}` : ""}`}
                      className={cn(
                        "block p-6",
                        "bg-yellow-50/50",
                        "border-2 border-yellow-300",
                        "transition-colors duration-200 cursor-pointer",
                        "hover:border-yellow-500 hover:bg-yellow-100 hover:shadow-md",
                        "dark:bg-yellow-950/20 dark:border-yellow-900",
                        "dark:hover:border-yellow-700 dark:hover:bg-yellow-950/30 dark:hover:shadow-lg",
                      )}
                    >
                      <div
                        className={cn("flex items-start justify-between gap-4")}
                      >
                        <div className={cn("flex-1")}>
                          <div className={cn("flex items-center gap-2 mb-2")}>
                            <AlertTriangle
                              size={18}
                              className={cn(
                                "shrink-0 text-yellow-600 animate-pulse",
                                "dark:text-yellow-500",
                              )}
                            />
                            {ticket.ticketType === "pull_request" ? (
                              <GitPullRequest size={16} className="shrink-0" />
                            ) : ticket.ticketType === "issue" ? (
                              <MessageCircle size={16} className="shrink-0" />
                            ) : (
                              <MessagesSquare size={16} className="shrink-0" />
                            )}
                            <h3
                              className={cn(
                                "min-w-0 font-medium text-black break-words dark:text-white",
                              )}
                            >
                              #{ticket.githubNumber} {ticket.githubTitle}
                            </h3>
                          </div>
                          <p
                            className={cn(
                              "text-sm text-gray-600 dark:text-gray-400",
                            )}
                          >
                            {ticket.githubRepo} •{" "}
                            {t("tickets.pendingActionsCount", {
                              count: ticket.pendingActions.length,
                            })}
                          </p>
                        </div>
                      </div>
                    </Link>
                  );
                })}

                {/* Load More Button */}
                {(pendingTotal > pendingVisibleCount || isLoadingMore) && (
                  <button
                    onClick={() => {
                      setPendingVisibleCount((prev) => prev + 10);
                    }}
                    disabled={isLoadingMore}
                    className={cn(
                      "w-full py-3 text-sm font-medium",
                      "border-2 transition-colors",
                      isLoadingMore
                        ? "border-yellow-400 text-yellow-400 cursor-not-allowed dark:border-yellow-600 dark:text-yellow-600"
                        : "border-yellow-600 text-yellow-600 hover:bg-yellow-600 hover:text-white dark:border-yellow-500 dark:text-yellow-500 dark:hover:bg-yellow-500 dark:hover:text-black",
                    )}
                  >
                    {isLoadingMore ? (
                      <span
                        className={cn("flex items-center justify-center gap-2")}
                      >
                        <LoadingIndicator />
                        {t("common.loading")}
                      </span>
                    ) : (
                      t("common.loadMore", {
                        count: Math.min(10, pendingTotal - pendingVisibleCount),
                      })
                    )}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Tickets List */}
          {isTicketsLoading ? (
            <div
              className={cn(
                "py-24 flex justify-center items-center",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <LoadingIndicator />
            </div>
          ) : !tickets?.length ? (
            <div
              className={cn(
                "p-12 text-center",
                "border border-gray-200",
                "dark:border-gray-800",
              )}
            >
              <Ticket
                size={48}
                className={cn(
                  "mx-auto mb-4 text-gray-400",
                  "dark:text-gray-600",
                )}
              />
              <h3
                className={cn(
                  "text-xl font-bold text-black mb-2",
                  "dark:text-white",
                )}
              >
                {t("tickets.noTickets.title")}
              </h3>
              <p className={cn("text-gray-600", "dark:text-gray-400")}>
                {t("tickets.noTickets.description")}
              </p>
            </div>
          ) : (
            <div className={cn("space-y-3")}>
              {tickets.map((ticket) => {
                const params = new URLSearchParams();
                if (repoFilter) params.set("repo", repoFilter);
                if (selectedType !== "all") params.set("type", selectedType);
                if (selectedStatus !== "all")
                  params.set("status", selectedStatus);
                const queryString = params.toString();

                return (
                  <div
                    key={ticket._id}
                    className={cn(
                      "p-6",
                      "border border-gray-200",
                      "transition-colors",
                      "hover:border-gray-400 hover:bg-gray-50",
                      "dark:border-gray-800 dark:hover:border-gray-600 dark:hover:bg-gray-900",
                    )}
                  >
                    <div
                      className={cn("flex items-start justify-between gap-4")}
                    >
                      <div className={cn("flex-1 min-w-0")}>
                        {/* Repository */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSearchParams({ repo: ticket.githubRepo });
                          }}
                          className={cn(
                            "text-sm font-medium text-gray-600 mb-2 block",
                            "transition-colors",
                            "hover:text-black hover:underline",
                            "dark:text-gray-400 dark:hover:text-white",
                          )}
                        >
                          {ticket.githubRepo}
                        </button>

                        {/* Title and Status */}
                        <div
                          className={cn(
                            "flex flex-wrap items-center justify-between gap-3 mb-2",
                          )}
                        >
                          <div
                            className={cn("flex min-w-0 items-center gap-3")}
                          >
                            <div
                              className={cn(
                                "shrink-0 text-gray-600",
                                "dark:text-gray-400",
                              )}
                            >
                              {ticket.ticketType === "pull_request" ? (
                                <GitPullRequest size={20} />
                              ) : ticket.ticketType === "issue" ? (
                                <MessageCircle size={18} />
                              ) : (
                                <MessagesSquare size={18} />
                              )}
                            </div>
                            <h3
                              className={cn(
                                "min-w-0 font-medium text-black break-words",
                                "dark:text-white",
                              )}
                            >
                              <Link
                                to={`/tickets/${ticket._id}${queryString ? `?${queryString}` : ""}`}
                                className="hover:underline focus-visible:underline"
                              >
                                #{ticket.githubNumber} {ticket.githubTitle}
                              </Link>
                            </h3>
                          </div>
                          <StatusBadge
                            status={ticket.status}
                            label={t(`tickets.status.${ticket.status}`)}
                            size="small"
                          />
                        </div>

                        {/* Action counts */}
                        <div
                          className={cn(
                            "flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 mt-2 dark:text-gray-400",
                          )}
                        >
                          <span>
                            {t("tickets.actionCount", {
                              count: ticket.actionCount,
                            })}
                          </span>
                          {ticket.pendingActionCount > 0 && (
                            <span
                              className={cn(
                                "text-yellow-600",
                                "dark:text-yellow-500",
                              )}
                            >
                              {t("tickets.pendingActionCount", {
                                count: ticket.pendingActionCount,
                              })}
                            </span>
                          )}
                          <a
                            href={`https://github.com/${ticket.githubRepo}/${ticket.ticketType === "pull_request" ? "pull" : ticket.ticketType === "issue" ? "issues" : "discussions"}/${ticket.githubNumber}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                              "transition-colors",
                              "hover:text-black hover:underline",
                              "dark:hover:text-white",
                            )}
                          >
                            {t("tickets.viewOnGitHub")}
                          </a>
                          <span className={cn("tabular-nums")}>
                            {formatDate(ticket.createdAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {!!tickets?.length && (
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={totalTickets}
              itemsPerPage={itemsPerPage}
              onPageChange={setCurrentPage}
              className="mt-6"
            />
          )}
        </div>
      </Layout>
    </>
  );
}
