import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { LoadingIndicator } from "../../components/uis/LoadingIndicator";
import { Button } from "../../components/uis/Button";
import { cn } from "../../utils/cn";
import {
  AlertTriangle,
  CheckCircle,
  Circle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { Accordion } from "../../components/uis/Accordion";
import { useTranslation } from "react-i18next";
import { showToast } from "../../utils/signals/toast";
import { useNavigate } from "react-router";

const STALE_CHECK_INTERVAL_MS = 30 * 1000;

interface IndexingStatusProps {
  repositoryId: Id<"repositories">;
  repositoryName: string;
}

type LogPhase = {
  id: string;
  title: string;
  logs: Doc<"repoIndexingLogs">[];
  status: "pending" | "running" | "completed" | "failed";
};

export function IndexingStatus({
  repositoryId,
  repositoryName,
}: IndexingStatusProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const logs = useQuery(api.repoIndexing.query.getIndexingLogs, {
    repositoryId,
    limit: 100,
  });
  const indexingStatus = useQuery(api.repoIndexing.query.getIndexingStatus, {
    repositoryId,
  });
  const syncRepository = useAction(api.repositories.action.syncRepository);

  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [isRetrying, setIsRetrying] = useState(false);
  const requiresReconnect = indexingStatus?.requiresReconnect === true;
  const githubAccessRevoked =
    indexingStatus?.githubAccessRevoked === true && !requiresReconnect;

  const hasActiveWork =
    !githubAccessRevoked &&
    !requiresReconnect &&
    indexingStatus?.isActive !== false &&
    (indexingStatus?.status === "pending" ||
      indexingStatus?.status === "indexing" ||
      indexingStatus?.ragStatus === "indexing" ||
      (indexingStatus?.status === "completed" &&
        indexingStatus.ragStatus === "pending"));
  const staleAt = indexingStatus?.staleAt;
  const isStale =
    hasActiveWork && staleAt !== undefined && currentTime >= staleAt;
  const staleMinutes = Math.ceil(
    (indexingStatus?.staleThresholdMs ?? 0) / (60 * 1000),
  );

  useEffect(() => {
    if (!hasActiveWork) {
      return;
    }

    const timer = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, STALE_CHECK_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [hasActiveWork]);

  // Group logs into phases
  const phases = useMemo(() => {
    if (!logs || logs.length === 0) return [];

    const phaseGroups: LogPhase[] = [
      {
        id: "setup",
        title: t("home.indexing.phases.setup"),
        logs: [],
        status: "pending",
      },
      {
        id: "metadata",
        title: t("home.indexing.phases.metadata"),
        logs: [],
        status: "pending",
      },
      {
        id: "files",
        title: t("home.indexing.phases.files"),
        logs: [],
        status: "pending",
      },
      {
        id: "config",
        title: t("home.indexing.phases.config"),
        logs: [],
        status: "pending",
      },
      {
        id: "cleanup",
        title: t("home.indexing.phases.cleanup"),
        logs: [],
        status: "pending",
      },
      {
        id: "embeddings",
        title: t("home.indexing.phases.embeddings"),
        logs: [],
        status: "pending",
      },
    ];
    const [setup, metadata, files, config, cleanup, embeddings] = phaseGroups;

    // Categorize logs into phases. Order matters: specific later-phase
    // keywords (embeddings, configuration, cleanup) must win before the broad
    // "files" bucket so finalize-phase logs do not disappear into it.
    logs.forEach((log) => {
      const msg = log.message.toLowerCase();

      if (
        msg.includes("sync initiated") ||
        msg.includes("connected") ||
        msg.includes("preparing") ||
        msg.includes("scheduled") ||
        msg.includes("starting indexing") ||
        msg.includes("restarting") ||
        msg.includes("verifying") ||
        msg.includes("installation") ||
        msg.includes("requesting") ||
        msg.includes("token")
      ) {
        setup.logs.push(log);
      } else if (msg.includes("metadata") || msg.includes("branch")) {
        metadata.logs.push(log);
      } else if (
        msg.includes("search index") ||
        msg.includes("embedding") ||
        msg.includes("chunks")
      ) {
        embeddings.logs.push(log);
      } else if (
        msg.includes("configuration") ||
        msg.includes("package.json") ||
        msg.includes("tsconfig")
      ) {
        config.logs.push(log);
      } else if (
        msg.includes("cleanup") ||
        msg.includes("cleaning up") ||
        msg.includes("finalizing") ||
        msg.includes("completed successfully")
      ) {
        cleanup.logs.push(log);
      } else if (
        msg.includes("fetching complete") ||
        msg.includes("found") ||
        msg.includes("items") ||
        msg.includes("analyzing") ||
        msg.includes("take a moment") ||
        msg.includes("building") ||
        msg.includes("detecting") ||
        msg.includes("indexed") ||
        msg.includes("files")
      ) {
        files.logs.push(log);
      } else {
        // Uncategorized progress lines belong to the finalize phase
        cleanup.logs.push(log);
      }
    });

    // Determine status for each phase
    phaseGroups.forEach((phase) => {
      if (phase.logs.length === 0) {
        phase.status = "pending";
      } else {
        const hasError = phase.logs.some((log) => log.level === "error");
        const hasSuccess = phase.logs.some((log) => log.level === "success");
        const lastLog = phase.logs[phase.logs.length - 1];

        if (hasError) {
          phase.status = "failed";
        } else if (hasSuccess || lastLog.level === "success") {
          phase.status = "completed";
        } else {
          phase.status = "running";
        }
      }
    });

    return phaseGroups.filter(
      (p) => p.logs.length > 0 || p.status !== "pending",
    );
  }, [logs, t]);

  const runningPhaseId = phases.find((p) => p.status === "running")?.id;
  const visibleExpandedPhase = expandedPhase ?? runningPhaseId ?? null;

  const getPhaseIcon = (status: LogPhase["status"]) => {
    switch (status) {
      case "completed":
        return (
          <CheckCircle
            size={16}
            className="text-green-600 dark:text-green-400"
          />
        );
      case "running":
        return (
          <Loader2
            size={16}
            className="text-blue-600 dark:text-blue-400 animate-spin"
          />
        );
      case "failed":
        return (
          <CheckCircle size={16} className="text-red-600 dark:text-red-400" />
        );
      case "pending":
      default:
        return (
          <Circle size={16} className="text-gray-400 dark:text-gray-600" />
        );
    }
  };

  const getPhaseColor = (status: LogPhase["status"]) => {
    switch (status) {
      case "completed":
        return "text-green-700 dark:text-green-300";
      case "running":
        return "text-blue-700 dark:text-blue-300";
      case "failed":
        return "text-red-700 dark:text-red-300";
      case "pending":
      default:
        return "text-gray-500 dark:text-gray-500";
    }
  };

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  };

  const handleRetry = async () => {
    if (!indexingStatus?.canRetry) {
      return;
    }

    setIsRetrying(true);
    try {
      const result = await syncRepository({ repositoryId });
      if (result.success) {
        showToast(t("home.indexing.retryStarted"), "success");
      } else {
        showToast(result.message || t("home.indexing.retryFailed"), "error");
      }
    } catch {
      showToast(t("home.indexing.retryFailed"), "error");
    } finally {
      setIsRetrying(false);
    }
  };

  if (logs === undefined || indexingStatus === undefined) {
    return (
      <div className={cn("flex items-center justify-center py-8")}>
        <LoadingIndicator />
      </div>
    );
  }

  const isCompleted =
    indexingStatus?.isActive !== false &&
    indexingStatus?.status === "completed" &&
    indexingStatus?.ragStatus === "completed";
  const isPaused =
    !githubAccessRevoked &&
    !requiresReconnect &&
    indexingStatus?.isActive === false;
  const hasFailed =
    !githubAccessRevoked &&
    !isPaused &&
    (indexingStatus?.status === "failed" ||
      indexingStatus?.ragStatus === "failed" ||
      phases.some((p) => p.status === "failed"));

  return (
    <div
      className={cn(
        "min-h-[calc(100vh-200px)] flex flex-col",
        "bg-white dark:bg-[#0a0a0a]",
        "border border-gray-200 dark:border-gray-800",
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "px-6 py-4",
          "border-b border-gray-200 dark:border-gray-800",
        )}
      >
        <div className="flex items-center gap-3">
          {githubAccessRevoked ? (
            <AlertTriangle
              size={24}
              className="text-red-600 dark:text-red-400"
            />
          ) : requiresReconnect ? (
            <AlertTriangle
              size={24}
              className="text-amber-600 dark:text-amber-400"
            />
          ) : isStale ? (
            <AlertTriangle
              size={24}
              className="text-amber-600 dark:text-amber-400"
            />
          ) : isPaused ? (
            <Circle size={24} className="text-gray-500 dark:text-gray-400" />
          ) : isCompleted ? (
            <CheckCircle
              size={24}
              className="text-green-600 dark:text-green-400"
            />
          ) : hasFailed ? (
            <CheckCircle size={24} className="text-red-600 dark:text-red-400" />
          ) : (
            <LoadingIndicator />
          )}
          <div>
            <h2
              className={cn(
                "text-xl font-brand font-bold",
                "text-black dark:text-white",
              )}
            >
              {githubAccessRevoked
                ? t("home.indexing.accessRevokedTitle")
                : requiresReconnect
                  ? t("home.indexing.reconnectTitle")
                  : isStale
                    ? t("home.indexing.stalledTitle")
                    : isPaused
                      ? t("home.indexing.pausedTitle")
                      : isCompleted
                        ? t("home.indexing.repositoryConnected")
                        : hasFailed
                          ? t("home.indexing.connectionFailed")
                          : t("home.indexing.connectingRepository")}
            </h2>
            <p className={cn("text-sm text-gray-600 dark:text-gray-400")}>
              {repositoryName}
            </p>
          </div>
        </div>
      </div>

      {/* Phases */}
      <div className={cn("flex-1 overflow-y-auto", "p-6")}>
        {githubAccessRevoked ? (
          <div
            className={cn(
              "p-4",
              "text-red-950 bg-red-50 border border-red-300",
              "dark:text-red-100 dark:bg-red-950/30 dark:border-red-800",
            )}
          >
            <p className="text-sm">
              {indexingStatus.canRestoreGithubAccess
                ? t("home.indexing.accessRevokedDescription")
                : t("home.indexing.accessRevokedDescriptionReadOnly")}
            </p>
          </div>
        ) : requiresReconnect ? (
          <div
            className={cn(
              "flex flex-col items-start gap-3 p-4",
              "text-amber-950 bg-amber-50",
              "border border-amber-300",
              "dark:text-amber-100 dark:bg-amber-950/30 dark:border-amber-700",
            )}
          >
            <p className="text-sm">
              {indexingStatus?.canReconnect
                ? t("home.indexing.reconnectDescription")
                : t("home.indexing.reconnectDescriptionReadOnly")}
            </p>
            {indexingStatus?.canReconnect && (
              <Button
                size="sm"
                variant="secondary"
                icon={<RefreshCw size={16} />}
                onClick={() => {
                  const params = new URLSearchParams({
                    reconnectRepositoryId: repositoryId,
                  });
                  navigate(`/repositories/connect?${params.toString()}`);
                }}
              >
                {t("home.indexing.reconnectButton")}
              </Button>
            )}
          </div>
        ) : isPaused ? (
          <div
            className={cn(
              "p-4",
              "text-gray-700 bg-gray-50 border border-gray-300",
              "dark:text-gray-300 dark:bg-gray-900/50 dark:border-gray-700",
            )}
          >
            <p className="text-sm">{t("home.indexing.pausedDescription")}</p>
          </div>
        ) : (
          <>
            {isStale && (
              <div
                className={cn(
                  "flex flex-col items-start gap-3",
                  "mb-6 p-4",
                  "text-amber-950 bg-amber-50",
                  "border border-amber-300",
                  "dark:text-amber-100 dark:bg-amber-950/30 dark:border-amber-700",
                )}
              >
                <p className="text-sm">
                  {indexingStatus.canRetry
                    ? t("home.indexing.stalledDescription", {
                        minutes: staleMinutes,
                      })
                    : t("home.indexing.stalledDescriptionReadOnly", {
                        minutes: staleMinutes,
                      })}
                </p>
                {indexingStatus.canRetry && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={isRetrying}
                    icon={<RefreshCw size={16} />}
                    onClick={() => void handleRetry()}
                  >
                    {isRetrying
                      ? t("home.indexing.retrying")
                      : t("home.indexing.retryButton")}
                  </Button>
                )}
              </div>
            )}
            {phases.length === 0 ? (
              <div
                className={cn(
                  "flex items-center justify-center gap-3 py-8",
                  "text-gray-500 dark:text-gray-500",
                )}
              >
                <LoadingIndicator />
                <p>{t("home.indexing.initializing")}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {phases.map((phase) => (
                  <Accordion
                    key={phase.id}
                    expanded={visibleExpandedPhase === phase.id}
                    onExpandedChange={(expanded) => {
                      setExpandedPhase(expanded ? phase.id : null);
                    }}
                    title={
                      <div className="flex items-center gap-2">
                        {getPhaseIcon(phase.status)}
                        <span
                          className={cn(
                            "font-medium",
                            getPhaseColor(phase.status),
                          )}
                        >
                          {phase.title}
                        </span>
                      </div>
                    }
                    headerRight={
                      <span
                        className={cn("text-xs", getPhaseColor(phase.status))}
                      >
                        {phase.logs.length > 0 &&
                          formatTimestamp(
                            phase.logs[phase.logs.length - 1].createdAt,
                          )}
                      </span>
                    }
                    className="border-gray-200 dark:border-gray-800"
                    headerClassName={cn(
                      phase.status === "running" &&
                        "bg-blue-50 dark:bg-blue-900/10",
                      phase.status === "completed" &&
                        "bg-green-50 dark:bg-green-900/10",
                      phase.status === "failed" &&
                        "bg-red-50 dark:bg-red-900/10",
                    )}
                  >
                    <div className="p-4 space-y-2 bg-gray-50 dark:bg-black">
                      {phase.logs.map((log) => (
                        <div
                          key={log._id}
                          className={cn(
                            "flex items-start gap-2 text-sm font-mono",
                          )}
                        >
                          <span className="text-gray-400 dark:text-gray-600 shrink-0">
                            {formatTimestamp(log.createdAt)}
                          </span>
                          <span
                            className={cn(
                              "flex-1",
                              log.level === "error"
                                ? "text-red-700 dark:text-red-300"
                                : log.level === "success"
                                  ? "text-green-700 dark:text-green-300"
                                  : log.level === "warning"
                                    ? "text-yellow-700 dark:text-yellow-300"
                                    : "text-gray-700 dark:text-gray-300",
                            )}
                          >
                            {log.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Accordion>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer tip */}
      <div
        className={cn(
          "px-6 py-3",
          "border-t border-gray-200 dark:border-gray-800",
          "bg-gray-50 dark:bg-[#0a0a0a]",
        )}
      >
        <p className={cn("text-xs text-gray-500 dark:text-gray-500")}>
          {githubAccessRevoked
            ? t("home.indexing.accessRevokedTip")
            : requiresReconnect
              ? t("home.indexing.reconnectTip")
              : isStale
                ? indexingStatus.canRetry
                  ? t("home.indexing.stalledTip")
                  : t("home.indexing.stalledTipReadOnly")
                : isPaused
                  ? t("home.indexing.pausedTip")
                  : isCompleted
                    ? t("home.indexing.completedTip")
                    : hasFailed
                      ? t("home.indexing.failedTip")
                      : t("home.indexing.inProgressTip")}
        </p>
      </div>
    </div>
  );
}
