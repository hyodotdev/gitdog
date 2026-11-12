import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";

export type RepositoryIndexStatus =
  "pending" | "indexing" | "completed" | "failed";

export type RepositoryAiReadinessInput = {
  isActive?: boolean;
  indexStatus: RepositoryIndexStatus;
  ragStatus: RepositoryIndexStatus;
  indexVersion: number;
  indexSyncPending: boolean;
  githubAccessRevokedAt?: number;
  githubInstallationReconnectRequired?: boolean;
  githubAccessRestoreIndexPending?: boolean;
  githubAccessRestoreIndexNextAttemptAt?: number;
  ragTotalChunks: number;
  ragIndexedChunks: number;
  ragFailedChunks: number;
  updatedAt?: number;
};

export type ReadinessRetryState = {
  startedAt?: number;
  progressAt?: number;
  progressKey?: string;
};

export type ReadinessRetryWindow = {
  startedAt: number;
  progressAt: number;
  progressKey: string;
  timeoutReason?: string;
};

export type RepositoryAiReadiness =
  | { state: "ready"; indexVersion: number }
  | { state: "waiting"; reason: string; indexVersion: number }
  | { state: "blocked"; reason: string; indexVersion: number };

export type RepositoryAiAccessSnapshot = {
  repository: Doc<"repositories">;
  indexVersion: number;
};

const READINESS_RETRY_BASE_MS = 15_000;
const READINESS_RETRY_MAX_MS = 5 * 60_000;
export const READINESS_STALL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const READINESS_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

function getReadinessProgressKey(
  repository: RepositoryAiReadinessInput,
): string {
  return JSON.stringify([
    repository.indexVersion,
    repository.indexStatus,
    repository.ragStatus,
    repository.indexSyncPending,
    repository.githubAccessRevokedAt ?? null,
    repository.githubInstallationReconnectRequired === true,
    repository.githubAccessRestoreIndexPending === true,
    repository.githubAccessRestoreIndexNextAttemptAt ?? null,
    repository.ragTotalChunks,
    repository.ragIndexedChunks,
    repository.ragFailedChunks,
    repository.updatedAt ?? 0,
  ]);
}

/**
 * Bound durable readiness polling without treating normal index progress as
 * a failure. A version, status, progress counter, or repository heartbeat
 * change resets the 24-hour inactivity window; a seven-day absolute deadline
 * still prevents perpetual scheduling during continuous churn.
 */
export function getReadinessRetryWindow(
  repository: RepositoryAiReadinessInput,
  previous: ReadinessRetryState,
  now: number = Date.now(),
): ReadinessRetryWindow {
  const progressKey = getReadinessProgressKey(repository);
  const startedAt = previous.startedAt ?? now;
  const progressAt =
    previous.progressKey === progressKey ? (previous.progressAt ?? now) : now;

  let timeoutReason: string | undefined;
  if (now - startedAt >= READINESS_ABSOLUTE_TIMEOUT_MS) {
    timeoutReason = "Repository indexes did not become ready within seven days";
  } else if (now - progressAt >= READINESS_STALL_TIMEOUT_MS) {
    timeoutReason =
      "Repository indexing made no observable progress for 24 hours";
  }

  return { startedAt, progressAt, progressKey, timeoutReason };
}

export function calculateReadinessRetryDelay(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 0), 5);
  return Math.min(
    READINESS_RETRY_BASE_MS * 2 ** exponent,
    READINESS_RETRY_MAX_MS,
  );
}

/**
 * Classify whether repository-backed AI can safely read a coherent index.
 * Pending work is retryable; paused or failed repositories require an
 * explicit repository state change before AI should run again.
 */
export function getRepositoryAiReadiness(
  repository: RepositoryAiReadinessInput,
): RepositoryAiReadiness {
  const indexVersion = repository.indexVersion;

  if (
    repository.isActive === false ||
    repository.githubAccessRevokedAt !== undefined ||
    repository.githubInstallationReconnectRequired === true
  ) {
    return {
      state: "blocked",
      reason: "repository is paused",
      indexVersion,
    };
  }

  if (
    repository.githubAccessRestoreIndexPending === true ||
    repository.githubAccessRestoreIndexNextAttemptAt !== undefined
  ) {
    return {
      state: "waiting",
      reason: "repository access restore indexing is pending",
      indexVersion,
    };
  }

  if (repository.indexStatus === "failed") {
    return {
      state: "blocked",
      reason: "repository file indexing failed",
      indexVersion,
    };
  }

  if (repository.ragStatus === "failed") {
    return {
      state: "blocked",
      reason: "repository RAG indexing failed",
      indexVersion,
    };
  }

  if (
    repository.indexSyncPending ||
    repository.indexStatus !== "completed" ||
    repository.ragStatus !== "completed"
  ) {
    return {
      state: "waiting",
      reason: "repository indexes are not ready",
      indexVersion,
    };
  }

  return { state: "ready", indexVersion };
}

/**
 * Read the exact repository generation that may supply cached code to AI.
 * Query handlers are snapshot-consistent, while actions must call this before
 * and after any external work that can outlive the database snapshot.
 */
export async function readRepositoryAiAccessSnapshot(
  ctx: Pick<QueryCtx, "db">,
  repositoryId: Id<"repositories">,
  expectedIndexVersion?: number,
): Promise<RepositoryAiAccessSnapshot | null> {
  const repository = await ctx.db.get(repositoryId);
  const indexVersion = repository?.indexVersion;
  if (
    repository?.isActive !== true ||
    repository.disconnectCleanupPending === true ||
    repository.githubAccessRevokedAt !== undefined ||
    repository.githubInstallationReconnectRequired === true ||
    repository.githubAccessRestoreIndexPending === true ||
    repository.githubAccessRestoreIndexNextAttemptAt !== undefined ||
    !Number.isSafeInteger(indexVersion) ||
    (expectedIndexVersion !== undefined &&
      indexVersion !== expectedIndexVersion)
  ) {
    return null;
  }

  const installation = await getExactGitHubInstallation(
    ctx,
    repository.installationId,
  );
  if (
    !isGitHubInstallationReady(installation) ||
    installation.userId !== repository.userId
  ) {
    return null;
  }

  return { repository, indexVersion: repository.indexVersion };
}
