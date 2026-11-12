import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PublicRepository } from "../../../convex/repositories/query";

export function RepositoryIndexingProgress({
  repository,
}: {
  repository: PublicRepository;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const progress = repository.indexingProgress;
  const staleAt = progress?.staleAt;
  const isStale = staleAt !== undefined && now >= staleAt;
  const isSearch = repository.indexStatus === "completed";
  const phase = isStale
    ? "stalled"
    : isSearch
      ? progress?.phase === "cleanup"
        ? "finalizingSearch"
        : "indexingSearch"
      : repository.indexStatus === "pending"
        ? "connecting"
        : "indexingCode";
  const minutes = progress
    ? Math.max(0, Math.floor((now - progress.lastProgressAt) / 60_000))
    : undefined;

  return (
    <div className="mt-2 mb-3 text-sm" role="status">
      <span
        className={
          isStale
            ? "text-amber-800 dark:text-amber-200"
            : "text-gray-600 dark:text-gray-400"
        }
      >
        {t(`home.workspace.repoCard.${phase}`)}
        {isSearch && (
          <>
            {" "}
            ·{" "}
            {t("home.workspace.repoCard.searchProgress", {
              chunks: repository.ragIndexedChunks,
              files: progress?.processedFiles ?? 0,
            })}
          </>
        )}
        {minutes !== undefined && (
          <> · {t("home.workspace.repoCard.lastProgress", { minutes })}</>
        )}
      </span>
      {progress?.syncQueued && (
        <p className="text-gray-500">
          {t("home.workspace.repoCard.syncQueued")}
        </p>
      )}
      {isStale && (
        <p className="text-amber-800 dark:text-amber-200">
          {t("home.workspace.repoCard.stalledHelp")}
        </p>
      )}
    </div>
  );
}
