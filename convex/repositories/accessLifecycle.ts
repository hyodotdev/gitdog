import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { scheduleRepositoryTreeSnapshotCleanup } from "../repoIndexing/treeSnapshot";

export const MISSING_INSTALLATION_RECONNECT_ERROR =
  "The GitHub App installation is missing and must be reconnected";
export const UNVERIFIED_INSTALLATION_RECONNECT_ERROR =
  "The GitHub App installation ownership cannot be verified and must be reconnected";
export const INSTALLATION_RECONCILIATION_FAILED_ERROR =
  "GitHub App repository access reconciliation failed and must be retried";

async function cancelIndexWatchdog(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
): Promise<void> {
  if (!repository.indexWatchdogScheduleId) {
    return;
  }
  try {
    await ctx.scheduler.cancel(repository.indexWatchdogScheduleId);
  } catch {
    console.warn(
      "[RepositoryAccessLifecycle] Unable to cancel completed watchdog",
    );
  }
}

async function cancelRepositoryBackgroundWork(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
): Promise<void> {
  await cancelIndexWatchdog(ctx, repository);
  await scheduleRepositoryTreeSnapshotCleanup(
    ctx,
    repository.indexTreeSnapshotId,
  );
}

/** Pause a pinned identity without deleting it so reconciliation can restore it. */
export async function pauseRepositoryForAccessRemoval(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
  options: { installationReconnectRequired?: boolean } = {},
): Promise<boolean> {
  if (repository.disconnectCleanupPending === true) {
    return false;
  }
  await cancelRepositoryBackgroundWork(ctx, repository);
  if (repository.githubAccessRevokedAt !== undefined) {
    if (
      (options.installationReconnectRequired === true &&
        repository.githubInstallationReconnectRequired !== true) ||
      repository.indexTreeSnapshotId !== undefined ||
      repository.indexRateLimitRetryToken !== undefined ||
      repository.indexIdentityVerifiedVersion !== undefined ||
      repository.indexWatchdogToken !== undefined ||
      repository.indexWatchdogScheduleId !== undefined
    ) {
      await ctx.db.patch(repository._id, {
        ...(options.installationReconnectRequired === true
          ? { githubInstallationReconnectRequired: true }
          : {}),
        indexTreeSnapshotId: undefined,
        indexRateLimitRetryToken: undefined,
        indexRateLimitRetryAt: undefined,
        indexIdentityVerifiedVersion: undefined,
        indexIdentityVerifiedInstallationId: undefined,
        indexIdentityVerifiedGithubRepositoryId: undefined,
        indexIdentityVerifiedGithubRepo: undefined,
        indexWatchdogToken: undefined,
        indexWatchdogScheduleId: undefined,
        indexWatchdogRetryCount: undefined,
        updatedAt: Date.now(),
      });
    }
    return false;
  }

  const now = Date.now();
  await ctx.db.patch(repository._id, {
    isActive: false,
    githubAccessRevokedAt: now,
    isActiveBeforeAccessRevocation: repository.isActive,
    githubInstallationReconnectRequired:
      options.installationReconnectRequired === true ? true : undefined,
    githubAccessRestoreIndexPending: undefined,
    githubAccessRestoreIndexNextAttemptAt: undefined,
    githubAccessRestoreIndexRetryCount: undefined,
    indexVersion: repository.indexVersion + 1,
    indexStatus: "failed",
    indexError: "GitHub App repository access was removed",
    ragStatus: "failed",
    ragError: "GitHub App repository access was removed",
    ragEmbeddingMode: undefined,
    ragEmbeddingBillingTier: undefined,
    ragEmbeddingKey: undefined,
    ragIndexPhase: undefined,
    ragIndexCursor: undefined,
    ragIndexFileOffset: undefined,
    ragIndexChunkOffset: undefined,
    ragContinuationToken: undefined,
    ragProcessedFiles: undefined,
    indexSyncPending: false,
    indexWatchdogToken: undefined,
    indexWatchdogScheduleId: undefined,
    indexWatchdogRetryCount: undefined,
    indexTreeSnapshotId: undefined,
    indexRateLimitRetryToken: undefined,
    indexRateLimitRetryAt: undefined,
    indexIdentityVerifiedVersion: undefined,
    indexIdentityVerifiedInstallationId: undefined,
    indexIdentityVerifiedGithubRepositoryId: undefined,
    indexIdentityVerifiedGithubRepo: undefined,
    licenseOsiApproved: false,
    licenseOsiCheckedAt: undefined,
    repositoryMetadataCheckedAt: Math.max(
      now,
      (repository.repositoryMetadataCheckedAt ?? 0) + 1,
    ),
    indexProgressAt: now,
    updatedAt: now,
  });
  return true;
}

/**
 * Quarantine an immutable repository whose installation is missing, belongs
 * to another user, or reached a terminal access-reconciliation
 * failure. A verified but temporarily suspended or reconciling installation is
 * intentionally left for the watchdog to defer. Keeping the numeric repository
 * identity lets a later signed installation event restore this exact repository
 * without trusting its mutable name.
 */
export async function quarantineRepositoryForMissingInstallation(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
): Promise<boolean> {
  if (repository.disconnectCleanupPending === true) {
    return false;
  }
  const installations = await ctx.db
    .query("githubInstallations")
    .withIndex("by_installation_id", (q) =>
      q.eq("installationId", repository.installationId),
    )
    .take(2);
  const installation =
    installations.length === 1 ? installations[0] : undefined;
  const hasVerifiedMatchingInstallation =
    installation !== null &&
    installation !== undefined &&
    installation.userId === repository.userId;
  const accessReconciliationFailed =
    hasVerifiedMatchingInstallation &&
    installation.repositoryAccessReconciliationFailure !== undefined;
  if (hasVerifiedMatchingInstallation && !accessReconciliationFailed) {
    return false;
  }

  await cancelRepositoryBackgroundWork(ctx, repository);
  const now = Date.now();
  const reconnectError = accessReconciliationFailed
    ? INSTALLATION_RECONCILIATION_FAILED_ERROR
    : installations.length === 0
      ? MISSING_INSTALLATION_RECONNECT_ERROR
      : UNVERIFIED_INSTALLATION_RECONNECT_ERROR;
  const alreadyQuarantined =
    repository.isActive === false &&
    repository.githubInstallationReconnectRequired ===
      (accessReconciliationFailed ? undefined : true) &&
    repository.indexStatus === "failed" &&
    repository.indexError === reconnectError &&
    repository.ragStatus === "failed" &&
    repository.ragError === reconnectError;
  await ctx.db.patch(repository._id, {
    isActive: false,
    githubAccessRevokedAt: repository.githubAccessRevokedAt ?? now,
    isActiveBeforeAccessRevocation:
      repository.githubAccessRevokedAt === undefined
        ? repository.isActive
        : repository.isActiveBeforeAccessRevocation,
    githubInstallationReconnectRequired: accessReconciliationFailed
      ? undefined
      : true,
    githubAccessRestoreIndexPending: undefined,
    githubAccessRestoreIndexNextAttemptAt: undefined,
    githubAccessRestoreIndexRetryCount: undefined,
    indexVersion: alreadyQuarantined
      ? repository.indexVersion
      : repository.indexVersion + 1,
    indexStatus: "failed",
    indexError: reconnectError,
    ragStatus: "failed",
    ragError: reconnectError,
    ragEmbeddingMode: undefined,
    ragEmbeddingBillingTier: undefined,
    ragEmbeddingKey: undefined,
    ragEmbeddingError: undefined,
    ragIndexPhase: undefined,
    ragIndexCursor: undefined,
    ragIndexFileOffset: undefined,
    ragIndexChunkOffset: undefined,
    ragContinuationToken: undefined,
    ragProcessedFiles: undefined,
    indexSyncPending: false,
    indexWatchdogToken: undefined,
    indexWatchdogScheduleId: undefined,
    indexWatchdogRetryCount: undefined,
    indexTreeSnapshotId: undefined,
    indexRateLimitRetryToken: undefined,
    indexRateLimitRetryAt: undefined,
    indexIdentityVerifiedVersion: undefined,
    indexIdentityVerifiedInstallationId: undefined,
    indexIdentityVerifiedGithubRepositoryId: undefined,
    indexIdentityVerifiedGithubRepo: undefined,
    licenseOsiApproved: false,
    licenseOsiCheckedAt: undefined,
    repositoryMetadataCheckedAt: Math.max(
      now,
      (repository.repositoryMetadataCheckedAt ?? 0) + 1,
    ),
    indexProgressAt: now,
    updatedAt: now,
  });
  return true;
}
