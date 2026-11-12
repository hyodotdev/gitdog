import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Helmet } from "react-helmet-async";
import { Layout } from "../../components/Layout";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { MarkdownContent } from "../../components/uis/MarkdownContent";
import { StatusBadge } from "../../components/uis/StatusBadge";
import { Modal } from "../../components/uis/Modal";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  X,
  Clock,
  MessageCircle,
  Edit3,
  AlertTriangle,
  FileEdit,
  MessageSquare,
  Users,
  RefreshCw,
  GitPullRequest,
  ChevronDown,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Id } from "../../../convex/_generated/dataModel";
import { cn } from "../../utils/cn";
import { showToast } from "../../utils/signals/toast";
import { translateErrorMessage } from "../../utils/errorMessages";
import { useState, useMemo } from "react";
import { parseGitdogBody } from "../../utils/parseGitdogContent";

export function TicketDetailPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();

  // Build back URL with all filters preserved
  const backUrl = useMemo(() => {
    const params = new URLSearchParams();
    const repo = searchParams.get("repo");
    const type = searchParams.get("type");
    const status = searchParams.get("status");
    if (repo) params.set("repo", repo);
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    const queryString = params.toString();
    return `/tickets${queryString ? `?${queryString}` : ""}`;
  }, [searchParams]);

  // Get ticket with actions
  const ticket = useQuery(
    api.tickets.query.getById,
    id ? { id: id as Id<"tickets"> } : "skip",
  );

  // Action handlers
  const approveAction = useAction(api.ticketActions.action.approve);
  const rejectAction = useAction(api.ticketActions.action.reject);
  const requestChangesAction = useAction(
    api.ticketActions.action.requestChanges,
  );
  const softDeleteTicket = useMutation(api.tickets.mutation.softDelete);
  const recheckReview = useAction(api.pullRequests.action.recheck);

  // Modal states
  const [requestChangesModalOpen, setRequestChangesModalOpen] = useState(false);
  const [requestChangesFeedback, setRequestChangesFeedback] = useState("");
  const [selectedActionId, setSelectedActionId] =
    useState<Id<"ticketActions"> | null>(null);

  // Loading states
  const [approvingActionId, setApprovingActionId] =
    useState<Id<"ticketActions"> | null>(null);
  const [rejectingActionId, setRejectingActionId] =
    useState<Id<"ticketActions"> | null>(null);
  const [isRequestingChanges, setIsRequestingChanges] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRechecking, setIsRechecking] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  // Accordion states - pending_approval and pending actions are expanded by default
  const [expandedActions, setExpandedActions] = useState<
    Set<Id<"ticketActions">>
  >(() => {
    // Initialize with pending and pending_approval actions expanded
    const initialSet = new Set<Id<"ticketActions">>();
    return initialSet;
  });

  // Chat history accordion state (collapsed by default)
  const [expandedChatHistories, setExpandedChatHistories] = useState<
    Set<Id<"ticketActions">>
  >(new Set());

  const toggleAction = (actionId: Id<"ticketActions">) => {
    setExpandedActions((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(actionId)) {
        newSet.delete(actionId);
      } else {
        newSet.add(actionId);
      }
      return newSet;
    });
  };

  const toggleChatHistory = (actionId: Id<"ticketActions">) => {
    setExpandedChatHistories((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(actionId)) {
        newSet.delete(actionId);
      } else {
        newSet.add(actionId);
      }
      return newSet;
    });
  };

  const isActionExpanded = (actionId: Id<"ticketActions">, status: string) => {
    // Pending and pending approval actions are expanded by default
    if (
      (status === "pending_approval" || status === "pending") &&
      !expandedActions.has(actionId)
    ) {
      return true;
    }
    // If explicitly toggled, use the toggle state
    if (
      (status === "pending_approval" || status === "pending") &&
      expandedActions.has(actionId)
    ) {
      return false; // User explicitly collapsed it
    }
    return expandedActions.has(actionId);
  };

  const isLoading = ticket === undefined;
  const failedReview = ticket?.actions
    .filter(
      (action) => action.actionType === "review" && action.status === "failed",
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const reviewProcessing =
    ticket?.actions.some(
      (action) => action.actionType === "review" && action.status === "pending",
    ) === true;
  const handleRecheck = async () => {
    if (!failedReview || isRechecking) return;
    setIsRechecking(true);
    try {
      await recheckReview({ actionId: failedReview._id });
    } catch (error) {
      showToast(
        translateErrorMessage(
          error instanceof Error ? error : String(error),
          t,
        ),
        "error",
      );
    } finally {
      setIsRechecking(false);
    }
  };

  // Parse the body content to extract original content if edited by gitdog
  const parsedBody = useMemo(() => {
    if (!ticket?.githubBody) return null;
    return parseGitdogBody(ticket.githubBody);
  }, [ticket]);

  // Find the format action to get original title if available
  const formatAction = useMemo(() => {
    if (!ticket?.actions) return null;
    return ticket.actions.find(
      (action) =>
        action.actionType === "format" && action.proposedChanges?.originalTitle,
    );
  }, [ticket]);

  // Determine if title was edited
  const titleInfo = useMemo(() => {
    if (!formatAction?.proposedChanges?.originalTitle || !ticket?.githubTitle) {
      return {
        isEdited: false,
        originalTitle: null,
        currentTitle: ticket?.githubTitle || "",
      };
    }
    const originalTitle = formatAction.proposedChanges.originalTitle;
    const currentTitle = ticket.githubTitle;
    const isEdited = originalTitle !== currentTitle;
    return { isEdited, originalTitle, currentTitle };
  }, [formatAction, ticket]);

  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleString(i18n.language, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getActionIcon = (actionType: string) => {
    switch (actionType) {
      case "review":
        return <GitPullRequest size={16} />;
      case "format":
        return <FileEdit size={16} />;
      case "answer":
        return <MessageSquare size={16} />;
      case "tag_maintainers":
        return <Users size={16} />;
      case "follow_up":
        return <RefreshCw size={16} />;
      default:
        return <MessageCircle size={16} />;
    }
  };

  const getActionTypeName = (actionType: string) => {
    switch (actionType) {
      case "review":
        return t("tickets.actionTypes.review");
      case "format":
        return t("tickets.actionTypes.format");
      case "answer":
        return t("tickets.actionTypes.answer");
      case "tag_maintainers":
        return t("tickets.actionTypes.tagMaintainers");
      case "follow_up":
        return t("tickets.actionTypes.followUp");
      default:
        return actionType;
    }
  };

  if (!id) {
    return (
      <Layout>
        <div className={cn("flex items-center justify-center min-h-[60vh]")}>
          <div className={cn("text-center")}>
            <p className={cn("text-gray-500", "dark:text-gray-400")}>
              {t("tickets.detail.invalidTicketId")}
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  if (isLoading) {
    return (
      <Layout>
        <div className={cn("flex items-center justify-center min-h-[60vh]")}>
          <LoadingIndicator />
        </div>
      </Layout>
    );
  }

  if (!ticket) {
    return (
      <Layout>
        <div className={cn("flex items-center justify-center min-h-[60vh]")}>
          <div className={cn("text-center")}>
            <p className={cn("text-gray-500", "dark:text-gray-400")}>
              {t("tickets.detail.ticketNotFound")}
            </p>
            <button
              onClick={() => navigate(backUrl)}
              className={cn(
                "mt-4 text-black",
                "hover:underline",
                "dark:text-white",
              )}
            >
              ← {t("tickets.detail.backToTickets")}
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <>
      <Helmet>
        <title>{`#${ticket.githubNumber} ${ticket.githubTitle} | Gitdog`}</title>
      </Helmet>

      <Layout>
        <div className={cn("max-w-5xl mx-auto px-4 py-8")}>
          {/* Back Button */}
          <Link
            to={backUrl}
            className={cn(
              "inline-flex items-center gap-2 text-gray-600 mb-6",
              "transition-colors",
              "hover:text-black",
              "dark:text-gray-400 dark:hover:text-white",
            )}
          >
            <ArrowLeft size={20} className="shrink-0" aria-hidden="true" />
            <span>{t("tickets.detail.backToTickets")}</span>
          </Link>

          {/* Header */}
          <div className={cn("mb-8")}>
            <div
              className={cn(
                "flex flex-col-reverse gap-3 mb-4",
                "sm:flex-row sm:items-start sm:justify-between sm:gap-6",
              )}
            >
              <div className={cn("flex items-start gap-3 min-w-0")}>
                {ticket.ticketType === "pull_request" ? (
                  <GitPullRequest
                    size={24}
                    className={cn(
                      "mt-1 shrink-0 text-gray-600",
                      "dark:text-gray-400",
                    )}
                    aria-hidden="true"
                  />
                ) : ticket.ticketType === "issue" ? (
                  <MessageCircle
                    size={24}
                    className={cn(
                      "mt-1 shrink-0 text-gray-600",
                      "dark:text-gray-400",
                    )}
                    aria-hidden="true"
                  />
                ) : (
                  <MessageSquare
                    size={24}
                    className={cn(
                      "mt-1 shrink-0 text-gray-600",
                      "dark:text-gray-400",
                    )}
                    aria-hidden="true"
                  />
                )}
                <div className={cn("min-w-0")}>
                  <h1 className={cn("text-2xl font-bold break-words")}>
                    <a
                      href={`https://github.com/${ticket.githubRepo}/${ticket.ticketType === "pull_request" ? "pull" : ticket.ticketType === "issue" ? "issues" : "discussions"}/${ticket.githubNumber}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn("hover:underline")}
                    >
                      #{ticket.githubNumber}
                    </a>{" "}
                    {ticket.githubTitle}
                  </h1>
                  <a
                    href={`https://github.com/${ticket.githubRepo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "text-gray-600 mt-1 block break-all",
                      "hover:underline",
                      "dark:text-gray-400",
                    )}
                  >
                    {ticket.githubRepo}
                  </a>
                </div>
              </div>
              <div className={cn("flex shrink-0 items-center gap-3")}>
                <StatusBadge
                  status={ticket.status}
                  label={t(`tickets.status.${ticket.status}`)}
                  size="medium"
                />
                <button
                  onClick={() => setDeleteModalOpen(true)}
                  className={cn(
                    "p-2",
                    "border border-gray-300 text-gray-600",
                    "transition-colors",
                    "hover:border-red-500 hover:text-red-500 hover:bg-red-50",
                    "dark:border-gray-700 dark:text-gray-400",
                    "dark:hover:border-red-500 dark:hover:text-red-400 dark:hover:bg-red-900/20",
                  )}
                  title={t("tickets.detail.deleteTicket")}
                  aria-label={t("tickets.detail.deleteTicket")}
                >
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* Metadata */}
            <div
              className={cn(
                "flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-gray-500",
                "dark:text-gray-400",
              )}
            >
              <div className={cn("flex items-center gap-2")}>
                <Clock size={16} className="shrink-0" aria-hidden="true" />
                <span>{formatDate(ticket.createdAt)}</span>
              </div>
              <a
                href={`https://github.com/${ticket.githubRepo}/${ticket.ticketType === "pull_request" ? "pull" : ticket.ticketType === "issue" ? "issues" : "discussions"}/${ticket.githubNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex items-center gap-2 underline underline-offset-4",
                  "transition-colors",
                  "hover:text-black",
                  "dark:hover:text-white",
                )}
              >
                {t("tickets.viewOnGitHub")}
              </a>
            </div>
          </div>

          {/* Original GitHub Content */}
          {ticket.githubBody && (
            <div className={cn("mb-8")}>
              <h2 className={cn("text-lg font-bold mb-3")}>
                {t("tickets.detail.originalContent")}
                {parsedBody?.isEdited && (
                  <span
                    className={cn(
                      "ml-2 text-xs font-normal px-2 py-0.5",
                      "bg-blue-100 text-blue-700",
                      "dark:bg-blue-900/30 dark:text-blue-400",
                    )}
                  >
                    {t("tickets.detail.editedByGitdog")}
                  </span>
                )}
              </h2>

              {/* Show edited title comparison if title was changed */}
              {titleInfo.isEdited && titleInfo.originalTitle && (
                <div
                  className={cn(
                    "mb-4 p-3",
                    "bg-gray-50 border border-gray-200",
                    "dark:bg-gray-900 dark:border-gray-800",
                  )}
                >
                  <div
                    className={cn(
                      "text-xs font-medium mb-2 text-gray-500 dark:text-gray-400",
                    )}
                  >
                    {t("tickets.detail.title")}
                  </div>
                  <div className={cn("space-y-2")}>
                    <p
                      className={cn(
                        "text-sm text-gray-500 dark:text-gray-400 line-through break-words",
                      )}
                    >
                      {titleInfo.originalTitle}
                    </p>
                    <div className={cn("flex items-center gap-2")}>
                      <ArrowRight
                        size={14}
                        className={cn("text-green-500 shrink-0")}
                      />
                      <p
                        className={cn(
                          "min-w-0 text-sm font-medium text-green-700 dark:text-green-400 break-words",
                        )}
                      >
                        {titleInfo.currentTitle}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div
                className={cn(
                  "p-4",
                  "bg-gray-50 border border-gray-200",
                  "dark:bg-gray-900 dark:border-gray-800",
                )}
              >
                {/* Show original content if edited and available, otherwise show cleaned content */}
                <MarkdownContent>
                  {parsedBody?.isEdited
                    ? parsedBody.originalContent ||
                      parsedBody.currentContent ||
                      ticket.githubBody
                    : ticket.githubBody}
                </MarkdownContent>
              </div>

              {/* Show current content separately if it was edited */}
              {parsedBody?.isEdited && parsedBody.currentContent && (
                <div className={cn("mt-4")}>
                  <h3
                    className={cn(
                      "text-sm font-medium mb-2 text-gray-600 dark:text-gray-400",
                    )}
                  >
                    {t("tickets.detail.currentContent")}
                  </h3>
                  <div
                    className={cn(
                      "p-4",
                      "bg-green-50 border border-green-200",
                      "dark:bg-green-900/20 dark:border-green-800",
                    )}
                  >
                    <MarkdownContent>
                      {parsedBody.currentContent}
                    </MarkdownContent>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Actions List */}
          <div className={cn("mb-8")}>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className={cn("text-lg font-bold")}>
                {t("tickets.detail.actions")} ({ticket.actions.length})
              </h2>
              {ticket.ticketType === "pull_request" && failedReview && (
                <button
                  type="button"
                  disabled={isRechecking || reviewProcessing}
                  onClick={() => void handleRecheck()}
                  className="px-3 py-2 text-sm border border-gray-300 disabled:opacity-50 dark:border-gray-700"
                >
                  {isRechecking ? (
                    <LoadingIndicator />
                  ) : (
                    t("tickets.detail.recheckReview")
                  )}
                </button>
              )}
            </div>

            {ticket.actions.length === 0 ? (
              <div
                className={cn(
                  "p-8 text-center",
                  "border border-gray-200",
                  "dark:border-gray-800",
                )}
              >
                <p className={cn("text-gray-500", "dark:text-gray-400")}>
                  {t("tickets.detail.noActions")}
                </p>
              </div>
            ) : (
              <div className={cn("space-y-3")}>
                {ticket.actions.map((action) => {
                  const isPendingApproval =
                    action.status === "pending_approval" &&
                    action.reviewVerificationOnly !== true;
                  const isProcessing = action.status === "pending";
                  const isApproving = approvingActionId === action._id;
                  const isRejecting = rejectingActionId === action._id;
                  const isExpanded = isActionExpanded(
                    action._id,
                    action.status,
                  );

                  return (
                    <div
                      key={action._id}
                      className={cn(
                        "border",
                        isPendingApproval
                          ? "border-yellow-300 bg-yellow-50/50 dark:border-yellow-900 dark:bg-yellow-950/20"
                          : isProcessing
                            ? "border-blue-300 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20"
                            : "border-gray-200 dark:border-gray-800",
                      )}
                    >
                      {/* Action Header - Clickable for accordion */}
                      <button
                        type="button"
                        onClick={() => toggleAction(action._id)}
                        aria-expanded={isExpanded}
                        className={cn(
                          "w-full flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4 text-left",
                          "cursor-pointer transition-colors",
                          "hover:bg-gray-50 dark:hover:bg-gray-900/50",
                        )}
                      >
                        <div className={cn("flex items-center gap-3")}>
                          {isPendingApproval && (
                            <AlertTriangle
                              size={16}
                              className={cn(
                                "shrink-0",
                                "text-yellow-600 animate-pulse",
                                "dark:text-yellow-500",
                              )}
                            />
                          )}
                          <div
                            className={cn(
                              "text-gray-600",
                              "dark:text-gray-400",
                            )}
                          >
                            {getActionIcon(action.actionType)}
                          </div>
                          <span className={cn("font-medium")}>
                            {action.reviewVerificationOnly === true
                              ? t("tickets.detail.reviewVerification")
                              : getActionTypeName(action.actionType)}
                          </span>
                        </div>
                        <div
                          className={cn(
                            "flex flex-wrap items-center gap-x-3 gap-y-1",
                          )}
                        >
                          <span
                            className={cn(
                              "text-xs text-gray-500 tabular-nums",
                              "dark:text-gray-400",
                            )}
                          >
                            {formatDate(action.createdAt)}
                          </span>
                          <StatusBadge
                            status={action.status}
                            label={t(`tickets.actionStatus.${action.status}`)}
                            size="small"
                          />
                          <ChevronDown
                            size={18}
                            className={cn(
                              "text-gray-400 transition-transform duration-200",
                              isExpanded && "rotate-180",
                            )}
                          />
                        </div>
                      </button>

                      {/* Accordion Content */}
                      {isExpanded && (
                        <>
                          {/* Chat History - GitHub Actions log style accordion */}
                          {action.chatHistory.filter(
                            (msg) => msg.content.trim().length > 0,
                          ).length > 0 && (
                            <div
                              className={cn(
                                "border-t border-gray-200 dark:border-gray-800",
                                "bg-gray-50 dark:bg-gray-900/30",
                              )}
                            >
                              {/* Accordion Header */}
                              <button
                                type="button"
                                onClick={() => toggleChatHistory(action._id)}
                                aria-expanded={expandedChatHistories.has(
                                  action._id,
                                )}
                                className={cn(
                                  "w-full flex items-center gap-2 px-4 py-3",
                                  "cursor-pointer transition-colors",
                                  "hover:bg-gray-50 dark:hover:bg-gray-900/50",
                                )}
                              >
                                <ChevronDown
                                  size={16}
                                  className={cn(
                                    "shrink-0",
                                    "text-gray-400 transition-transform duration-200",
                                    expandedChatHistories.has(action._id) &&
                                      "rotate-180",
                                  )}
                                />
                                <span
                                  className={cn(
                                    "text-sm font-medium text-gray-600 dark:text-gray-400",
                                  )}
                                >
                                  {t("tickets.detail.chatHistoryCount", {
                                    count: action.chatHistory.filter(
                                      (msg) => msg.content.trim().length > 0,
                                    ).length,
                                  })}
                                </span>
                              </button>

                              {/* Chat History Accordion Content */}
                              {expandedChatHistories.has(action._id) && (
                                <div className={cn("px-4 pb-4 space-y-2")}>
                                  {action.chatHistory
                                    .filter(
                                      (msg) => msg.content.trim().length > 0,
                                    )
                                    .map((msg, idx) => (
                                      <div
                                        key={idx}
                                        className={cn(
                                          "p-3",
                                          msg.role === "user"
                                            ? "bg-gray-50 dark:bg-gray-900/50"
                                            : "bg-blue-50/50 dark:bg-blue-900/10",
                                        )}
                                      >
                                        <div
                                          className={cn(
                                            "text-xs font-medium mb-2",
                                            msg.role === "user"
                                              ? "text-gray-700 dark:text-gray-300"
                                              : "text-blue-700 dark:text-blue-400",
                                          )}
                                        >
                                          {msg.role === "user"
                                            ? t("tickets.detail.user")
                                            : t("tickets.detail.assistant")}
                                        </div>
                                        <MarkdownContent>
                                          {msg.content}
                                        </MarkdownContent>
                                      </div>
                                    ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Proposed Changes */}
                          {action.proposedChanges && (
                            <div
                              className={cn(
                                "p-4 border-t border-gray-200 dark:border-gray-800",
                              )}
                            >
                              <h4
                                className={cn(
                                  "text-sm font-medium mb-3 text-gray-600 dark:text-gray-400",
                                )}
                              >
                                {t("tickets.detail.proposedChanges")}
                              </h4>

                              {/* Format action - show before/after */}
                              {action.actionType === "format" &&
                                action.proposedChanges.suggestedTitle && (
                                  <div className={cn("space-y-4")}>
                                    {action.proposedChanges.changesSummary && (
                                      <div
                                        className={cn(
                                          "p-3 text-sm",
                                          "bg-blue-50 border border-blue-200 text-blue-800",
                                          "dark:bg-blue-900/20 dark:border-blue-800 dark:text-blue-300",
                                        )}
                                      >
                                        <strong>
                                          {t("tickets.detail.changesSummary")}:
                                        </strong>{" "}
                                        {action.proposedChanges.changesSummary}
                                      </div>
                                    )}

                                    {/* Before/After grid layout */}
                                    <div
                                      className={cn(
                                        "grid grid-cols-1 gap-3",
                                        "lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
                                      )}
                                    >
                                      {/* Column headers */}
                                      <div
                                        className={cn(
                                          "hidden lg:block text-sm font-medium text-gray-500 dark:text-gray-400 pb-2 border-b border-gray-300 dark:border-gray-700",
                                        )}
                                      >
                                        {t("tickets.detail.before")}
                                      </div>
                                      <div
                                        className={cn(
                                          "hidden lg:block pb-2 border-b border-gray-300 dark:border-gray-700",
                                        )}
                                      />
                                      <div
                                        className={cn(
                                          "hidden lg:block text-sm font-medium text-green-700 dark:text-green-400 pb-2 border-b border-gray-300 dark:border-gray-700",
                                        )}
                                      >
                                        {t("tickets.detail.after")}
                                      </div>

                                      {/* Title row */}
                                      <div
                                        className={cn(
                                          "min-w-0 p-4",
                                          "bg-gray-100 border-l-4 border-gray-400",
                                          "dark:bg-gray-800 dark:border-gray-500",
                                        )}
                                      >
                                        <div
                                          className={cn(
                                            "text-xs font-medium mb-2 text-gray-500 dark:text-gray-400",
                                          )}
                                        >
                                          <span className="lg:hidden">
                                            {t("tickets.detail.before")}:{" "}
                                          </span>
                                          {t("tickets.detail.titleChange")}
                                        </div>
                                        <p
                                          className={cn(
                                            "text-sm text-gray-700 dark:text-gray-300 line-through opacity-70 break-words",
                                          )}
                                        >
                                          {action.proposedChanges.originalTitle}
                                        </p>
                                      </div>
                                      <div
                                        className={cn(
                                          "hidden lg:flex items-center justify-center",
                                        )}
                                      >
                                        <ArrowRight
                                          size={24}
                                          className={cn(
                                            "shrink-0",
                                            "text-green-500",
                                          )}
                                        />
                                      </div>
                                      <div
                                        className={cn(
                                          "min-w-0 p-4",
                                          "bg-green-50 border-l-4 border-green-500",
                                          "dark:bg-green-900/30 dark:border-green-400",
                                        )}
                                      >
                                        <div
                                          className={cn(
                                            "text-xs font-medium mb-2 text-green-700 dark:text-green-400",
                                          )}
                                        >
                                          <span className="lg:hidden">
                                            {t("tickets.detail.after")}:{" "}
                                          </span>
                                          {t("tickets.detail.titleChange")}
                                        </div>
                                        <p
                                          className={cn(
                                            "text-sm text-green-800 dark:text-green-200 font-medium break-words",
                                          )}
                                        >
                                          {
                                            action.proposedChanges
                                              .suggestedTitle
                                          }
                                        </p>
                                      </div>

                                      {/* Body row */}
                                      {action.proposedChanges.suggestedBody && (
                                        <>
                                          <div
                                            className={cn(
                                              "min-w-0 p-4",
                                              "bg-gray-100 border-l-4 border-gray-400",
                                              "dark:bg-gray-800 dark:border-gray-500",
                                            )}
                                          >
                                            <div
                                              className={cn(
                                                "text-xs font-medium mb-2 text-gray-500 dark:text-gray-400",
                                              )}
                                            >
                                              <span className="lg:hidden">
                                                {t("tickets.detail.before")}
                                                :{" "}
                                              </span>
                                              {t("tickets.detail.bodyChange")}
                                            </div>
                                            <MarkdownContent className="opacity-80">
                                              {action.proposedChanges
                                                .originalBody ||
                                                t("tickets.detail.emptyBody")}
                                            </MarkdownContent>
                                          </div>
                                          <div
                                            className={cn(
                                              "hidden lg:flex items-center justify-center",
                                            )}
                                          >
                                            <ArrowRight
                                              size={24}
                                              className={cn(
                                                "shrink-0",
                                                "text-green-500",
                                              )}
                                            />
                                          </div>
                                          <div
                                            className={cn(
                                              "min-w-0 p-4",
                                              "bg-green-50 border-l-4 border-green-500",
                                              "dark:bg-green-900/30 dark:border-green-400",
                                            )}
                                          >
                                            <div
                                              className={cn(
                                                "text-xs font-medium mb-2 text-green-700 dark:text-green-400",
                                              )}
                                            >
                                              <span className="lg:hidden">
                                                {t("tickets.detail.after")}
                                                :{" "}
                                              </span>
                                              {t("tickets.detail.bodyChange")}
                                            </div>
                                            <MarkdownContent>
                                              {
                                                action.proposedChanges
                                                  .suggestedBody
                                              }
                                            </MarkdownContent>
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                )}

                              {action.actionType === "review" && (
                                <div className="space-y-2 text-sm">
                                  {action.reviewVerificationOnly === true && (
                                    <p>
                                      {t(
                                        "tickets.detail.reviewVerificationNote",
                                      )}
                                    </p>
                                  )}
                                  <p>
                                    {t("tickets.detail.reviewScope", {
                                      sha:
                                        action.proposedChanges?.source?.headSha?.slice(
                                          0,
                                          12,
                                        ) ?? "",
                                    })}
                                  </p>
                                  <p>
                                    {action.proposedChanges.filesRead
                                      ? t("tickets.detail.reviewCoverage", {
                                          count:
                                            action.proposedChanges.filesRead
                                              .length,
                                        })
                                      : t(
                                          "tickets.detail.reviewCoverageUnknown",
                                        )}
                                  </p>
                                  {action.proposedChanges.coverageLimited && (
                                    <p>
                                      {t(
                                        "tickets.detail.reviewCoverageLimited",
                                      )}
                                    </p>
                                  )}
                                  {!!action.proposedChanges?.excludedPaths
                                    ?.length && (
                                    <p className="break-all">
                                      {t("tickets.detail.reviewExcluded")}:{" "}
                                      {action.proposedChanges.excludedPaths.join(
                                        ", ",
                                      )}
                                    </p>
                                  )}
                                </div>
                              )}

                              {/* Answer / Tag maintainers / Follow-up - show proposed comment */}
                              {(action.actionType === "review" ||
                                action.actionType === "answer" ||
                                action.actionType === "tag_maintainers" ||
                                action.actionType === "follow_up") &&
                                action.proposedChanges.suggestedResponse && (
                                  <div className={cn("space-y-3")}>
                                    {action.proposedChanges.reasoning && (
                                      <div
                                        className={cn(
                                          "p-3 text-sm",
                                          "bg-gray-50 border border-gray-200",
                                          "dark:bg-gray-800 dark:border-gray-700",
                                        )}
                                      >
                                        <strong>
                                          {t("tickets.detail.reasoning")}:
                                        </strong>{" "}
                                        {action.proposedChanges.reasoning}
                                      </div>
                                    )}

                                    <div
                                      className={cn(
                                        "p-4",
                                        "bg-gray-50 border border-gray-200",
                                        "dark:bg-gray-800 dark:border-gray-700",
                                      )}
                                    >
                                      <h5
                                        className={cn(
                                          "text-sm font-medium mb-2 text-gray-600 dark:text-gray-400",
                                        )}
                                      >
                                        {t("tickets.detail.proposedComment")}
                                      </h5>
                                      <MarkdownContent>
                                        {
                                          action.proposedChanges
                                            .suggestedResponse
                                        }
                                      </MarkdownContent>
                                    </div>

                                    {/* Show maintainer tag notice if actionable */}
                                    {action.proposedChanges.isActionable && (
                                      <div
                                        className={cn(
                                          "flex items-center gap-2 p-2 text-sm",
                                          "bg-blue-50 border border-blue-200",
                                          "dark:bg-blue-900/20 dark:border-blue-800",
                                          "text-blue-700 dark:text-blue-300",
                                        )}
                                      >
                                        <Users size={14} className="shrink-0" />
                                        <span>
                                          {t("tickets.detail.maintainerTagged")}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                )}

                              {/* Action buttons for pending approval */}
                              {isPendingApproval && (
                                <div
                                  className={cn(
                                    "flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-yellow-200 dark:border-yellow-900",
                                  )}
                                >
                                  <button
                                    onClick={async () => {
                                      setApprovingActionId(action._id);
                                      try {
                                        const result = await approveAction({
                                          actionId: action._id,
                                        });
                                        if (result.refreshing) {
                                          showToast(
                                            t(
                                              "tickets.detail.responseRefreshing",
                                            ),
                                            "info",
                                          );
                                          return;
                                        }
                                        if (!result.success) {
                                          throw new Error(
                                            result.reason ??
                                              t("tickets.detail.approveFailed"),
                                          );
                                        }
                                        showToast(
                                          t("tickets.detail.actionApproved"),
                                          "success",
                                        );
                                        // Collapse the accordion after successful approval
                                        setExpandedActions((prev) => {
                                          const newSet = new Set(prev);
                                          newSet.delete(action._id);
                                          return newSet;
                                        });
                                      } catch (error) {
                                        console.error(
                                          "Failed to approve:",
                                          error,
                                        );
                                        showToast(
                                          error instanceof Error
                                            ? translateErrorMessage(error, t)
                                            : t("tickets.detail.approveFailed"),
                                          "error",
                                        );
                                      } finally {
                                        setApprovingActionId(null);
                                      }
                                    }}
                                    disabled={isApproving}
                                    className={cn(
                                      "flex items-center gap-2 px-4 py-2",
                                      "bg-green-600 text-white font-medium",
                                      "transition-colors",
                                      "hover:bg-green-700",
                                      "disabled:opacity-50 disabled:cursor-not-allowed",
                                    )}
                                  >
                                    {isApproving ? (
                                      <LoadingIndicator />
                                    ) : (
                                      <Check size={16} />
                                    )}
                                    {action.actionType === "format"
                                      ? t("tickets.detail.applyFormatting")
                                      : t("tickets.detail.postComment")}
                                  </button>
                                  {action.actionType !== "review" && (
                                    <button
                                      onClick={() => {
                                        setSelectedActionId(action._id);
                                        setRequestChangesModalOpen(true);
                                      }}
                                      className={cn(
                                        "flex items-center gap-2 px-4 py-2",
                                        "border border-yellow-500 text-yellow-700 font-medium",
                                        "transition-colors",
                                        "hover:bg-yellow-50",
                                        "dark:border-yellow-600 dark:text-yellow-400 dark:hover:bg-yellow-900/20",
                                      )}
                                    >
                                      <Edit3 size={16} />
                                      {t("tickets.detail.requestChanges")}
                                    </button>
                                  )}
                                  <button
                                    onClick={async () => {
                                      setRejectingActionId(action._id);
                                      try {
                                        await rejectAction({
                                          actionId: action._id,
                                        });
                                        showToast(
                                          t("tickets.detail.actionRejected"),
                                          "success",
                                        );
                                        // Collapse the accordion after successful rejection
                                        setExpandedActions((prev) => {
                                          const newSet = new Set(prev);
                                          newSet.delete(action._id);
                                          return newSet;
                                        });
                                      } catch (error) {
                                        console.error(
                                          "Failed to reject:",
                                          error,
                                        );
                                        showToast(
                                          error instanceof Error
                                            ? translateErrorMessage(error, t)
                                            : t("tickets.detail.rejectFailed"),
                                          "error",
                                        );
                                      } finally {
                                        setRejectingActionId(null);
                                      }
                                    }}
                                    disabled={isRejecting}
                                    className={cn(
                                      "flex items-center gap-2 px-4 py-2",
                                      "border border-gray-300 text-gray-700 font-medium",
                                      "transition-colors",
                                      "hover:bg-gray-100",
                                      "dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
                                      "disabled:opacity-50 disabled:cursor-not-allowed",
                                    )}
                                  >
                                    {isRejecting ? (
                                      <LoadingIndicator />
                                    ) : (
                                      <X size={16} />
                                    )}
                                    {t("tickets.detail.reject")}
                                  </button>
                                </div>
                              )}

                              {/* Execution result for completed actions */}
                              {action.status === "completed" &&
                                action.executionResult && (
                                  <div
                                    className={cn(
                                      "mt-4 p-3",
                                      "bg-green-50 border border-green-200",
                                      "dark:bg-green-900/20 dark:border-green-800",
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        "text-sm text-green-700 dark:text-green-400",
                                      )}
                                    >
                                      ✓{" "}
                                      {t(
                                        action.actionType === "review" &&
                                          action.executionResult?.published ===
                                            false
                                          ? "tickets.detail.reviewNotPublished"
                                          : "tickets.detail.executionCompleted",
                                      )}
                                    </span>
                                  </div>
                                )}
                            </div>
                          )}

                          {/* Error message for failed actions */}
                          {action.status === "failed" &&
                            action.errorMessage && (
                              <div
                                className={cn(
                                  "p-4 border-t border-gray-200 dark:border-gray-800",
                                )}
                              >
                                <div
                                  className={cn(
                                    "p-3",
                                    "bg-red-50 border border-red-200",
                                    "dark:bg-red-900/20 dark:border-red-800",
                                  )}
                                >
                                  <div
                                    className={cn(
                                      "flex items-start justify-between gap-3",
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        "text-sm text-red-700 dark:text-red-400 flex-1",
                                      )}
                                    >
                                      ✗{" "}
                                      {translateErrorMessage(
                                        action.errorMessage,
                                        t,
                                      )}
                                      {action.reviewFailureDetails && (
                                        <span className="mt-2 block break-words whitespace-pre-wrap">
                                          <strong className="block">
                                            {t(
                                              "tickets.detail.reviewFailureDetails",
                                            )}
                                          </strong>
                                          {action.reviewFailureDetails}
                                        </span>
                                      )}
                                    </span>
                                    {/* Show upgrade button for token limit errors */}
                                    {action.errorMessage
                                      .toLowerCase()
                                      .includes("token limit") && (
                                      <button
                                        onClick={() => navigate("/pricing")}
                                        className={cn(
                                          "px-3 py-1 text-sm font-medium",
                                          "bg-black text-white",
                                          "hover:bg-gray-800",
                                          "dark:bg-white dark:text-black dark:hover:bg-gray-200",
                                        )}
                                      >
                                        {t("upgrade.viewPlans")}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}

                          {/* Loading state when no proposed changes yet */}
                          {!action.proposedChanges &&
                            action.status === "pending" && (
                              <div
                                className={cn(
                                  "p-6 border-t border-gray-200 dark:border-gray-800",
                                  "bg-blue-50/50 dark:bg-blue-950/20",
                                )}
                              >
                                <div
                                  className={cn("flex items-center gap-3 mb-4")}
                                >
                                  <LoadingIndicator />
                                  <span
                                    className={cn(
                                      "font-medium text-blue-700 dark:text-blue-400",
                                    )}
                                  >
                                    {t("tickets.detail.analyzingIssue")}
                                  </span>
                                </div>
                                <div
                                  className={cn(
                                    "ml-7 space-y-2 text-sm text-gray-600 dark:text-gray-400",
                                  )}
                                >
                                  <p className={cn("font-medium mb-2")}>
                                    {t("tickets.detail.processingStep")}
                                  </p>
                                  <ul className={cn("space-y-1.5 list-none")}>
                                    <li
                                      className={cn("flex items-center gap-2")}
                                    >
                                      <div
                                        className={cn(
                                          "w-1.5 h-1.5 bg-blue-500 animate-pulse",
                                        )}
                                      />
                                      {t("tickets.detail.stepExploring")}
                                    </li>
                                    <li
                                      className={cn("flex items-center gap-2")}
                                    >
                                      <div
                                        className={cn(
                                          "w-1.5 h-1.5 bg-blue-500 animate-pulse",
                                        )}
                                        style={{ animationDelay: "150ms" }}
                                      />
                                      {t("tickets.detail.stepReading")}
                                    </li>
                                    <li
                                      className={cn("flex items-center gap-2")}
                                    >
                                      <div
                                        className={cn(
                                          "w-1.5 h-1.5 bg-blue-500 animate-pulse",
                                        )}
                                        style={{ animationDelay: "300ms" }}
                                      />
                                      {t("tickets.detail.stepAnalyzing")}
                                    </li>
                                    <li
                                      className={cn("flex items-center gap-2")}
                                    >
                                      <div
                                        className={cn(
                                          "w-1.5 h-1.5 bg-blue-500 animate-pulse",
                                        )}
                                        style={{ animationDelay: "450ms" }}
                                      />
                                      {t("tickets.detail.stepGenerating")}
                                    </li>
                                  </ul>
                                </div>
                              </div>
                            )}

                          {/* Fallback when expanded but no content */}
                          {!action.proposedChanges &&
                            action.status !== "pending" &&
                            !action.errorMessage &&
                            action.chatHistory.filter(
                              (msg) => msg.content.trim().length > 0,
                            ).length === 0 && (
                              <div
                                className={cn(
                                  "p-6 border-t border-gray-200 dark:border-gray-800 text-center",
                                )}
                              >
                                <p
                                  className={cn(
                                    "text-sm text-gray-500 dark:text-gray-400",
                                  )}
                                >
                                  {t("tickets.detail.noActionDetails")}
                                </p>
                              </div>
                            )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Layout>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title={t("tickets.detail.deleteTicketTitle")}
      >
        <div className={cn("space-y-4")}>
          <p className={cn("text-sm text-gray-600", "dark:text-gray-400")}>
            {t("tickets.detail.deleteTicketDescription")}
          </p>
          <div className={cn("flex justify-end gap-3")}>
            <button
              onClick={() => setDeleteModalOpen(false)}
              className={cn(
                "px-4 py-2",
                "border border-gray-300 text-gray-700",
                "transition-colors",
                "hover:bg-gray-100",
                "dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
              )}
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={async () => {
                setIsDeleting(true);
                try {
                  await softDeleteTicket({ id: id as Id<"tickets"> });
                  showToast(t("tickets.detail.ticketDeleted"), "success");
                  navigate(backUrl);
                } catch (error) {
                  console.error("Failed to delete ticket:", error);
                  showToast(
                    error instanceof Error
                      ? translateErrorMessage(error, t)
                      : t("tickets.detail.deleteFailed"),
                    "error",
                  );
                } finally {
                  setIsDeleting(false);
                  setDeleteModalOpen(false);
                }
              }}
              disabled={isDeleting}
              className={cn(
                "flex items-center gap-2 px-4 py-2",
                "bg-red-600 text-white font-medium",
                "transition-colors",
                "hover:bg-red-700",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {isDeleting ? <LoadingIndicator /> : <Trash2 size={16} />}
              {t("tickets.detail.deleteConfirm")}
            </button>
          </div>
        </div>
      </Modal>

      {/* Request Changes Modal */}
      <Modal
        isOpen={requestChangesModalOpen}
        onClose={() => {
          setRequestChangesModalOpen(false);
          setRequestChangesFeedback("");
          setSelectedActionId(null);
        }}
        title={t("tickets.detail.requestChangesTitle")}
      >
        <div className={cn("space-y-4")}>
          <p className={cn("text-sm text-gray-600", "dark:text-gray-400")}>
            {t("tickets.detail.requestChangesDescription")}
          </p>
          <textarea
            name="feedback"
            aria-label={t("tickets.detail.requestChangesTitle")}
            value={requestChangesFeedback}
            onChange={(e) => setRequestChangesFeedback(e.target.value)}
            placeholder={t("tickets.detail.feedbackPlaceholder")}
            className={cn(
              "w-full h-32 p-3",
              "border border-gray-300",
              "focus:outline-hidden focus:border-black",
              "dark:border-gray-700 dark:bg-gray-800 dark:focus:border-white",
            )}
          />
          <div className={cn("flex justify-end gap-3")}>
            <button
              onClick={() => {
                setRequestChangesModalOpen(false);
                setRequestChangesFeedback("");
                setSelectedActionId(null);
              }}
              className={cn(
                "px-4 py-2",
                "border border-gray-300 text-gray-700",
                "transition-colors",
                "hover:bg-gray-100",
                "dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
              )}
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={async () => {
                if (!selectedActionId || !requestChangesFeedback.trim()) return;

                setIsRequestingChanges(true);
                try {
                  await requestChangesAction({
                    actionId: selectedActionId,
                    feedback: requestChangesFeedback,
                  });
                  showToast(t("tickets.detail.changesRequested"), "success");
                  // Collapse the accordion after requesting changes
                  setExpandedActions((prev) => {
                    const newSet = new Set(prev);
                    newSet.delete(selectedActionId);
                    return newSet;
                  });
                  setRequestChangesModalOpen(false);
                  setRequestChangesFeedback("");
                  setSelectedActionId(null);
                } catch (error) {
                  console.error("Failed to request changes:", error);
                  showToast(
                    error instanceof Error
                      ? translateErrorMessage(error, t)
                      : t("tickets.detail.requestChangesFailed"),
                    "error",
                  );
                } finally {
                  setIsRequestingChanges(false);
                }
              }}
              disabled={isRequestingChanges || !requestChangesFeedback.trim()}
              className={cn(
                "flex items-center gap-2 px-4 py-2",
                "bg-yellow-600 text-white font-medium",
                "transition-colors",
                "hover:bg-yellow-700",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {isRequestingChanges ? <LoadingIndicator /> : <Edit3 size={16} />}
              {t("tickets.detail.submitFeedback")}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
