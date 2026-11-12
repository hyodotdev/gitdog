import type { RepositoryIndexStatus } from "../repositories/aiReadiness";

export type IncrementalIndexReadinessInput = {
  isActive: boolean;
  indexStatus: RepositoryIndexStatus;
  ragStatus: RepositoryIndexStatus;
  indexProgressAt: number;
  indexRateLimitRetryAt?: number;
};

export const INDEXING_STALE_THRESHOLD_MS = 12 * 60 * 1000;

export type IndexSource = { commitSha: string; defaultBranch: string };

export function matchesCurrentIndexSource(
  repository: {
    indexVersion: number;
    indexSource?: IndexSource & { indexVersion: number };
  },
  source: IndexSource | undefined,
): boolean {
  return (
    source !== undefined &&
    repository.indexSource?.indexVersion === repository.indexVersion &&
    repository.indexSource.commitSha === source.commitSha &&
    repository.indexSource.defaultBranch === source.defaultBranch
  );
}

export function coalesceIndexSyncSource(
  repository: {
    indexSyncPending: boolean;
    indexSyncPendingSource?: IndexSource;
  },
  source: IndexSource | undefined,
): IndexSource | undefined {
  if (!repository.indexSyncPending) return source;
  const previous = repository.indexSyncPendingSource;
  return previous !== undefined &&
    source !== undefined &&
    previous.commitSha === source.commitSha &&
    previous.defaultBranch === source.defaultBranch
    ? previous
    : undefined;
}

export type IncrementalIndexEligibility =
  { allowed: true } | { allowed: false; reason: string };

export type IncrementalIndexEligibilityOptions = {
  /** Manual sync may retry an initial/file index that previously failed. */
  allowFailedIndexRecovery?: boolean;
  /** Manual sync may replace file or RAG work with no recent heartbeat. */
  allowStaleIndexRecovery?: boolean;
  now?: number;
};

export function hasIncrementalIndexWorkInProgress(
  repository: IncrementalIndexReadinessInput,
): boolean {
  const indexStatus = repository.indexStatus;
  const ragStatus = repository.ragStatus;
  return (
    repository.isActive !== false &&
    (indexStatus === "pending" ||
      indexStatus === "indexing" ||
      ragStatus === "indexing" ||
      (indexStatus === "completed" && ragStatus === "pending"))
  );
}

export function getIncrementalIndexStaleAt(
  repository: IncrementalIndexReadinessInput,
): number | undefined {
  if (!hasIncrementalIndexWorkInProgress(repository)) {
    return undefined;
  }
  const progressAt = repository.indexProgressAt;

  return (
    Math.max(progressAt, repository.indexRateLimitRetryAt ?? progressAt) +
    INDEXING_STALE_THRESHOLD_MS
  );
}

export function hasStaleIncrementalIndexWork(
  repository: IncrementalIndexReadinessInput,
  now = Date.now(),
): boolean {
  const staleAt = getIncrementalIndexStaleAt(repository);
  return staleAt !== undefined && now >= staleAt;
}

/** Keep a completed file index stable until its matching RAG pass finishes. */
export function getIncrementalIndexEligibility(
  repository: IncrementalIndexReadinessInput,
  options: IncrementalIndexEligibilityOptions = {},
): IncrementalIndexEligibility {
  const indexStatus = repository.indexStatus;
  const ragStatus = repository.ragStatus;

  if (repository.isActive === false) {
    return { allowed: false, reason: "repository is paused" };
  }

  if (
    options.allowStaleIndexRecovery &&
    hasStaleIncrementalIndexWork(repository, options.now)
  ) {
    return { allowed: true };
  }

  const canRecoverFailedIndex =
    options.allowFailedIndexRecovery && indexStatus === "failed";
  if (indexStatus !== "completed" && !canRecoverFailedIndex) {
    return {
      allowed: false,
      reason:
        indexStatus === "indexing"
          ? "indexing already in progress"
          : indexStatus === "pending"
            ? "indexing already scheduled"
            : "initial indexing not completed",
    };
  }

  // A failed file pass never starts its reserved RAG job. Treat a leftover
  // "pending" RAG status as stale so an explicit user retry can recover it.
  if (canRecoverFailedIndex) {
    return ragStatus === "indexing"
      ? { allowed: false, reason: "RAG indexing already in progress" }
      : { allowed: true };
  }

  if (ragStatus === "indexing") {
    return { allowed: false, reason: "RAG indexing already in progress" };
  }

  if (ragStatus === "pending") {
    return { allowed: false, reason: "RAG indexing already scheduled" };
  }

  return { allowed: true };
}
