import {
  mutation,
  internalMutation,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  coalesceIndexSyncSource,
  matchesCurrentIndexSource,
  getIncrementalIndexEligibility,
  hasIncrementalIndexWorkInProgress,
  INDEXING_STALE_THRESHOLD_MS,
} from "./readiness";
import { armIndexWatchdog, cancelIndexWatchdog } from "./watchdog";
import {
  getRepositoryTreeSnapshotPagesBytes,
  REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_BYTES,
  REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_PAGES,
  REPOSITORY_TREE_SNAPSHOT_CLEANUP_BATCH_SIZE,
  REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE,
  REPOSITORY_TREE_TRAVERSAL_ITEMS_PER_ACTION,
  REPOSITORY_TREE_TRAVERSAL_MAX_ITEMS,
  REPOSITORY_TREE_TRAVERSAL_MAX_REQUESTS,
  scheduleRepositoryTreeSnapshotCleanup,
} from "./treeSnapshot";
import { RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE } from "../ragV2/chunkBudget";
import { deleteChunksForPath } from "../ragV2/chunkPaths";
import { quarantineRepositoryForMissingInstallation } from "../repositories/accessLifecycle";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReconciliationPending,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import {
  readRepositoriesByInstallationAndGitHubRepositoryId,
  resolveUniquePreferredRepositoryIdentity,
} from "../repositories/immutableIdentity";

const rateLimitedIndexContinuationArgs = {
  continuation: v.optional(v.boolean()),
  treeTraversal: v.optional(v.boolean()),
  pageIndex: v.optional(v.number()),
  treeSnapshotId: v.optional(v.id("repoTreeSnapshots")),
  fileOffset: v.optional(v.number()),
  treeResponseRetryAttempt: v.optional(v.number()),
};

const INSTALLATION_ACCESS_RETRY_MS = 5 * 60 * 1_000;
// With the one-week stale threshold, a referenced blob is checked about
// every five weeks.
export const REFERENCED_BLOB_RECHECK_MS = 28 * 24 * 60 * 60 * 1_000;

async function hasReadyRepositoryInstallation(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(repository.installationId) ||
    repository.installationId <= 0
  ) {
    return false;
  }
  const installation = await getExactGitHubInstallation(
    ctx,
    repository.installationId,
  );
  return (
    isGitHubInstallationReady(installation) &&
    installation.userId === repository.userId
  );
}

/**
 * Initialize repository indexing
 * Sets repository status to "pending" to trigger indexing action
 */
export const initializeIndexing = mutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }

    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) {
      throw new Error("repository not found");
    }

    if (repo.userId !== userId) {
      throw new Error("unauthorized");
    }
    if (!(await hasReadyRepositoryInstallation(ctx, repo))) {
      if (await quarantineRepositoryForMissingInstallation(ctx, repo)) {
        return args.repositoryId;
      }
      throw new Error("repository installation access is not ready");
    }

    const eligibility = getIncrementalIndexEligibility(repo, {
      allowFailedIndexRecovery: true,
    });
    if (!eligibility.allowed) {
      throw new Error(eligibility.reason);
    }

    const now = Date.now();
    const newVersion = repo.indexVersion + 1;
    await scheduleRepositoryTreeSnapshotCleanup(ctx, repo.indexTreeSnapshotId);
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: newVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      indexStatus: "pending",
      indexVersion: newVersion,
      // A reindex the owner asks for rebuilds every chunk, not only those of
      // changed files.
      ragFullRebuildRequested: true,
      indexError: undefined,
      ragStatus: "pending",
      ragError: undefined,
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
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
      indexSyncPendingSource: undefined,
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexWatchdogRetryCount: 0,
      indexTreeSnapshotId: undefined,
      indexRateLimitRetryToken: undefined,
      indexRateLimitRetryAt: undefined,
      indexIdentityVerifiedVersion: undefined,
      indexIdentityVerifiedInstallationId: undefined,
      indexIdentityVerifiedGithubRepositoryId: undefined,
      indexIdentityVerifiedGithubRepo: undefined,
      indexProgressAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.repoIndexing.action.indexRepository,
      { repositoryId: args.repositoryId, expectedIndexVersion: newVersion },
    );

    return args.repositoryId;
  },
});

/**
 * Update repository indexing status (internal only)
 */
export const updateIndexingStatus = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    status: v.union(
      v.literal("pending"),
      v.literal("indexing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
    expectedIndexVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) {
      throw new Error("repository not found");
    }

    const expectedIndexVersion = args.expectedIndexVersion ?? repo.indexVersion;
    if (repo.indexVersion !== expectedIndexVersion) {
      return false;
    }
    if (
      repo.isActive !== true ||
      repo.githubAccessRevokedAt !== undefined ||
      repo.disconnectCleanupPending === true
    ) {
      return false;
    }
    if (!(await hasReadyRepositoryInstallation(ctx, repo))) {
      await quarantineRepositoryForMissingInstallation(ctx, repo);
      return false;
    }
    if (
      (args.status === "indexing" && repo.indexStatus !== "pending") ||
      ((args.status === "completed" || args.status === "failed") &&
        repo.indexStatus !== "indexing")
    ) {
      return false;
    }

    const now = Date.now();
    const updates: Record<string, unknown> = {
      indexStatus: args.status,
      indexProgressAt: now,
      updatedAt: now,
    };

    if (args.status === "indexing") {
      updates.indexRateLimitRetryToken = undefined;
      updates.indexRateLimitRetryAt = undefined;
      updates.indexIdentityVerifiedVersion = undefined;
      updates.indexIdentityVerifiedInstallationId = undefined;
      updates.indexIdentityVerifiedGithubRepositoryId = undefined;
      updates.indexIdentityVerifiedGithubRepo = undefined;
    }

    if (args.status === "completed") {
      updates.lastIndexedAt = now;
      updates.indexError = undefined;
      // File-index completion and the matching RAG reservation must become
      // visible atomically. Otherwise a push can advance indexVersion in the
      // gap and make the just-finished generation stale before RAG starts.
      updates.ragStatus = "pending";
      updates.ragError = undefined;
      updates.ragTotalChunks = 0;
      updates.ragIndexedChunks = 0;
      updates.ragFailedChunks = 0;
      updates.ragIndexPhase = undefined;
      updates.ragIndexCursor = undefined;
      updates.ragIndexFileOffset = undefined;
      updates.ragIndexChunkOffset = undefined;
      updates.ragContinuationToken = undefined;
      updates.ragProcessedFiles = undefined;
    } else if (args.status === "failed") {
      updates.indexError = args.error ?? "Unknown error";
    } else {
      updates.indexError = undefined;
    }

    if (args.status === "completed" || args.status === "failed") {
      await scheduleRepositoryTreeSnapshotCleanup(
        ctx,
        repo.indexTreeSnapshotId,
      );
      updates.indexTreeSnapshotId = undefined;
      updates.indexRateLimitRetryToken = undefined;
      updates.indexRateLimitRetryAt = undefined;
      updates.indexIdentityVerifiedVersion = undefined;
      updates.indexIdentityVerifiedInstallationId = undefined;
      updates.indexIdentityVerifiedGithubRepositoryId = undefined;
      updates.indexIdentityVerifiedGithubRepo = undefined;
    }

    if (args.status === "failed") {
      await cancelIndexWatchdog(ctx, repo.indexWatchdogScheduleId);
      updates.indexWatchdogToken = undefined;
      updates.indexWatchdogScheduleId = undefined;
      updates.indexWatchdogRetryCount = undefined;
    } else {
      const watchdog = await armIndexWatchdog(ctx, {
        repositoryId: args.repositoryId,
        expectedIndexVersion,
        previousScheduleId: repo.indexWatchdogScheduleId,
        previousSequence: repo.indexWatchdogSequence,
      });
      updates.indexWatchdogToken = watchdog.token;
      updates.indexWatchdogScheduleId = watchdog.scheduleId;
      updates.indexWatchdogSequence = watchdog.sequence;
    }

    await ctx.db.patch(args.repositoryId, updates);

    if (args.status === "completed") {
      await ctx.scheduler.runAfter(
        0,
        internal.ragV2.action.generateChunkEmbeddings,
        {
          repositoryId: args.repositoryId,
          indexVersion: expectedIndexVersion,
        },
      );
    }

    return true;
  },
});

/** Refresh progress only for the exact active file-index generation. */
export const touchIndexingProgress = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo ||
      repo.isActive !== true ||
      repo.githubAccessRevokedAt !== undefined ||
      repo.disconnectCleanupPending === true ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing"
    ) {
      return false;
    }

    const now = Date.now();
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    return true;
  },
});

/** Cache one numeric-ID verification only for the exact active generation. */
export const recordIndexIdentityVerification = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    installationId: v.number(),
    githubRepositoryId: v.number(),
    githubRepo: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const [repository, installation] = await Promise.all([
      ctx.db.get(args.repositoryId),
      getExactGitHubInstallation(ctx, args.installationId),
    ]);
    if (
      !repository ||
      repository.indexVersion !== args.expectedIndexVersion ||
      repository.indexStatus !== "indexing" ||
      repository.isActive !== true ||
      repository.githubAccessRevokedAt !== undefined ||
      repository.disconnectCleanupPending === true ||
      repository.installationId !== args.installationId ||
      repository.githubRepositoryId !== args.githubRepositoryId ||
      repository.githubRepo !== args.githubRepo ||
      !isGitHubInstallationReady(installation) ||
      installation.userId !== repository.userId ||
      installation.installationId !== args.installationId
    ) {
      return false;
    }

    const now = Date.now();
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repository.indexWatchdogScheduleId,
      previousSequence: repository.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      indexIdentityVerifiedVersion: args.expectedIndexVersion,
      indexIdentityVerifiedInstallationId: args.installationId,
      indexIdentityVerifiedGithubRepositoryId: args.githubRepositoryId,
      indexIdentityVerifiedGithubRepo: args.githubRepo,
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    return true;
  },
});

/** Persist an exact continuation instead of failing a generation at quota reset. */
export const scheduleRateLimitedIndexRetry = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    retryAt: v.number(),
    ...rateLimitedIndexContinuationArgs,
    treeTraversalClaimToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const repository = await ctx.db.get(args.repositoryId);
    if (
      !repository ||
      repository.indexVersion !== args.expectedIndexVersion ||
      repository.indexStatus !== "indexing" ||
      repository.isActive !== true ||
      repository.githubAccessRevokedAt !== undefined ||
      repository.disconnectCleanupPending === true
    ) {
      return false;
    }
    if (
      args.pageIndex !== undefined &&
      (!Number.isSafeInteger(args.pageIndex) || args.pageIndex < 0)
    ) {
      return false;
    }
    if (
      args.fileOffset !== undefined &&
      (!Number.isSafeInteger(args.fileOffset) ||
        args.fileOffset < 0 ||
        args.fileOffset >= REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE)
    ) {
      return false;
    }
    if (
      args.treeResponseRetryAttempt !== undefined &&
      (!Number.isSafeInteger(args.treeResponseRetryAttempt) ||
        args.treeResponseRetryAttempt < 1 ||
        args.treeResponseRetryAttempt > 6 ||
        args.treeTraversalClaimToken === undefined)
    ) {
      return false;
    }
    if (args.treeSnapshotId !== undefined) {
      const snapshot = await ctx.db.get(args.treeSnapshotId);
      if (
        !snapshot ||
        repository.indexTreeSnapshotId !== args.treeSnapshotId ||
        snapshot.repositoryId !== args.repositoryId ||
        snapshot.indexVersion !== args.expectedIndexVersion ||
        snapshot.status === "deleting"
      ) {
        return false;
      }
    }
    if (args.treeTraversalClaimToken !== undefined) {
      if (args.treeTraversal !== true || args.treeSnapshotId === undefined) {
        return false;
      }
      const snapshot = await ctx.db.get(args.treeSnapshotId);
      if (
        !snapshot ||
        snapshot.status !== "building" ||
        snapshot.traversalState !== "traversing" ||
        snapshot.traversalClaimToken !== args.treeTraversalClaimToken
      ) {
        return false;
      }
    }

    const now = Date.now();
    const retryAt = Math.max(now + 1_000, args.retryAt);
    const retryToken = crypto.randomUUID();
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repository.indexWatchdogScheduleId,
      previousSequence: repository.indexWatchdogSequence,
      delayMs: retryAt - now + INDEXING_STALE_THRESHOLD_MS,
    });
    await ctx.db.patch(args.repositoryId, {
      indexRateLimitRetryToken: retryToken,
      indexRateLimitRetryAt: retryAt,
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    if (
      args.treeTraversalClaimToken !== undefined &&
      args.treeSnapshotId !== undefined
    ) {
      await ctx.db.patch(args.treeSnapshotId, {
        traversalClaimToken: undefined,
        traversalClaimedAt: undefined,
        updatedAt: now,
      });
    }
    await ctx.scheduler.runAfter(
      retryAt - now,
      internal.repoIndexing.action.indexRepository,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        ...(args.continuation === undefined
          ? {}
          : { continuation: args.continuation }),
        ...(args.treeTraversal === undefined
          ? {}
          : { treeTraversal: args.treeTraversal }),
        ...(args.pageIndex === undefined ? {} : { pageIndex: args.pageIndex }),
        ...(args.treeSnapshotId === undefined
          ? {}
          : { treeSnapshotId: args.treeSnapshotId }),
        ...(args.fileOffset === undefined
          ? {}
          : { fileOffset: args.fileOffset }),
        ...(args.treeResponseRetryAttempt === undefined
          ? {}
          : { treeResponseRetryAttempt: args.treeResponseRetryAttempt }),
        rateLimitResume: true,
        rateLimitRetryToken: retryToken,
      },
    );
    return true;
  },
});

/** Claim only the one durable rate-limit retry still owned by this generation. */
export const claimRateLimitedIndexRetry = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    retryToken: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const repository = await ctx.db.get(args.repositoryId);
    if (
      !repository ||
      repository.indexVersion !== args.expectedIndexVersion ||
      repository.indexStatus !== "indexing" ||
      repository.isActive !== true ||
      repository.githubAccessRevokedAt !== undefined ||
      repository.disconnectCleanupPending === true ||
      repository.indexRateLimitRetryToken !== args.retryToken ||
      repository.indexRateLimitRetryAt === undefined ||
      Date.now() + 1_000 < repository.indexRateLimitRetryAt
    ) {
      return false;
    }

    const now = Date.now();
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repository.indexWatchdogScheduleId,
      previousSequence: repository.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      indexRateLimitRetryToken: undefined,
      indexRateLimitRetryAt: undefined,
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    return true;
  },
});

/** Persist server-verified GitHub metadata for embedding billing policy. */
export const updateRepositoryMetadata = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    expectedMetadataCheckedAt: v.optional(v.number()),
    defaultBranch: v.string(),
    githubVisibility: v.union(
      v.literal("public"),
      v.literal("private"),
      v.literal("internal"),
      v.null(),
    ),
    licenseKey: v.union(v.string(), v.null()),
    licenseSpdxId: v.union(v.string(), v.null()),
    licenseOsiApproved: v.union(v.boolean(), v.null()),
    licenseOsiCheckedAt: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const repo = await ctx.db.get(args.repositoryId);
    const installation = repo
      ? await getExactGitHubInstallation(ctx, repo.installationId)
      : null;
    if (
      !repo ||
      repo.isActive !== true ||
      repo.githubAccessRevokedAt !== undefined ||
      repo.disconnectCleanupPending === true ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing" ||
      repo.repositoryMetadataCheckedAt !== args.expectedMetadataCheckedAt ||
      repo.indexIdentityVerifiedVersion !== args.expectedIndexVersion ||
      repo.indexIdentityVerifiedInstallationId !== repo.installationId ||
      repo.indexIdentityVerifiedGithubRepositoryId !==
        repo.githubRepositoryId ||
      repo.indexIdentityVerifiedGithubRepo !== repo.githubRepo ||
      !isGitHubInstallationReady(installation) ||
      installation.userId !== repo.userId ||
      installation.installationId !== repo.installationId
    ) {
      return false;
    }

    const now = Date.now();
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      defaultBranch: args.defaultBranch,
      githubVisibility: args.githubVisibility ?? undefined,
      licenseKey: args.licenseKey ?? undefined,
      licenseSpdxId: args.licenseSpdxId ?? undefined,
      licenseOsiApproved: args.licenseOsiApproved ?? undefined,
      licenseOsiCheckedAt: args.licenseOsiCheckedAt ?? undefined,
      repositoryMetadataCheckedAt: Math.max(
        now,
        (repo.repositoryMetadataCheckedAt ?? 0) + 1,
      ),
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    return true;
  },
});

/** Persist progress and reserve the next file-index page atomically. */
export const scheduleIndexContinuation = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    pageIndex: v.number(),
    treeSnapshotId: v.id("repoTreeSnapshots"),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const [repo, snapshot] = await Promise.all([
      ctx.db.get(args.repositoryId),
      ctx.db.get(args.treeSnapshotId),
    ]);
    if (
      !repo ||
      !snapshot ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing" ||
      repo.indexTreeSnapshotId !== args.treeSnapshotId ||
      snapshot.repositoryId !== args.repositoryId ||
      snapshot.indexVersion !== args.expectedIndexVersion ||
      snapshot.status !== "ready" ||
      !Number.isSafeInteger(args.pageIndex) ||
      args.pageIndex < 0 ||
      args.pageIndex >= snapshot.totalPages
    ) {
      return false;
    }

    const now = Date.now();
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.repoIndexing.action.indexRepository,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        continuation: true,
        pageIndex: args.pageIndex,
        treeSnapshotId: args.treeSnapshotId,
      },
    );
    return true;
  },
});

const repositoryTreeSnapshotPageValidator = v.array(
  v.object({
    path: v.string(),
    sha: v.string(),
    size: v.optional(v.number()),
  }),
);

function validateRepositoryTreeSnapshotTotals(
  totalFiles: number,
  totalPages: number,
): void {
  const expectedTotalPages =
    totalFiles === 0
      ? 0
      : Math.ceil(totalFiles / REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE);
  if (
    !Number.isSafeInteger(totalFiles) ||
    totalFiles < 0 ||
    !Number.isSafeInteger(totalPages) ||
    totalPages !== expectedTotalPages
  ) {
    throw new Error("invalid repository tree snapshot totals");
  }
}

function validateRepositoryTreeSnapshotPage(
  page: Array<{ path: string; sha: string; size?: number }>,
  pageIndex: number,
  totalFiles: number,
  totalPages: number,
): void {
  const expectedLength =
    pageIndex === totalPages - 1
      ? totalFiles - pageIndex * REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE
      : REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE;
  if (page.length !== expectedLength || expectedLength <= 0) {
    throw new Error("invalid repository tree snapshot page");
  }
}

function repositoryTreeSnapshotPagesMatch(
  left: Array<{ path: string; sha: string; size?: number }>,
  right: Array<{ path: string; sha: string; size?: number }>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) =>
        file.path === right[index]?.path &&
        file.sha === right[index]?.sha &&
        file.size === right[index]?.size,
    )
  );
}

function buildRepositoryTreeTraversalIdentity(
  sha: string,
  prefix: string,
): string {
  return [sha, prefix].join(String.fromCharCode(0));
}

/** Start a durable subtree traversal after GitHub truncates the recursive tree. */
export const beginIndexTreeTraversal = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    defaultBranch: v.string(),
    commitSha: v.string(),
    treeSha: v.string(),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing"
    ) {
      return null;
    }

    if (repo.indexTreeSnapshotId) {
      const existing = await ctx.db.get(repo.indexTreeSnapshotId);
      if (
        !existing ||
        existing.repositoryId !== args.repositoryId ||
        existing.indexVersion !== args.expectedIndexVersion ||
        existing.defaultBranch !== args.defaultBranch ||
        existing.commitSha !== args.commitSha ||
        existing.treeSha !== args.treeSha ||
        existing.status !== "building" ||
        existing.traversalState !== "traversing"
      ) {
        return null;
      }
      await ctx.scheduler.runAfter(
        0,
        internal.repoIndexing.action.indexRepository,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: args.expectedIndexVersion,
          continuation: true,
          treeTraversal: true,
          treeSnapshotId: existing._id,
        },
      );
      return { snapshotId: existing._id, resumed: true };
    }

    const now = Date.now();
    const snapshotId = await ctx.db.insert("repoTreeSnapshots", {
      repositoryId: args.repositoryId,
      indexVersion: args.expectedIndexVersion,
      defaultBranch: args.defaultBranch,
      commitSha: args.commitSha,
      treeSha: args.treeSha,
      totalFiles: 0,
      totalPages: 0,
      nextPageIndex: 0,
      traversalState: "traversing",
      traversalRequestCount: 0,
      traversalItemCount: 0,
      traversalPendingFiles: [],
      status: "building",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("repoTreeTraversalQueue", {
      snapshotId,
      identityKey: buildRepositoryTreeTraversalIdentity(args.treeSha, ""),
      sha: args.treeSha,
      prefix: "",
      itemOffset: 0,
      createdAt: now,
      updatedAt: now,
    });

    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      indexTreeSnapshotId: snapshotId,
      indexSource: {
        indexVersion: args.expectedIndexVersion,
        commitSha: args.commitSha,
        defaultBranch: args.defaultBranch,
      },
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.repoIndexing.action.indexRepository,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        continuation: true,
        treeTraversal: true,
        treeSnapshotId: snapshotId,
      },
    );
    return { snapshotId, resumed: false };
  },
});

/** Claim exactly one durable subtree/cursor so concurrent actions cannot race. */
export const claimIndexTreeTraversal = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    snapshotId: v.id("repoTreeSnapshots"),
  },
  handler: async (ctx, args) => {
    const [repo, snapshot] = await Promise.all([
      ctx.db.get(args.repositoryId),
      ctx.db.get(args.snapshotId),
    ]);
    if (
      !repo ||
      !snapshot ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing" ||
      repo.indexTreeSnapshotId !== args.snapshotId ||
      snapshot.repositoryId !== args.repositoryId ||
      snapshot.indexVersion !== args.expectedIndexVersion ||
      snapshot.status !== "building" ||
      snapshot.traversalState !== "traversing" ||
      snapshot.traversalClaimToken !== undefined
    ) {
      return null;
    }

    const queue = await ctx.db
      .query("repoTreeTraversalQueue")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
      .first();
    if (!queue) {
      return null;
    }
    if (
      queue.responseStorageId === undefined &&
      (snapshot.traversalRequestCount ?? 0) >=
        REPOSITORY_TREE_TRAVERSAL_MAX_REQUESTS
    ) {
      throw new Error(
        "Repository tree requires too many GitHub subtree requests to index safely",
      );
    }

    const claimToken = crypto.randomUUID();
    const now = Date.now();
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.snapshotId, {
      traversalClaimToken: claimToken,
      traversalClaimedAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(args.repositoryId, {
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    return {
      claimToken,
      queueId: queue._id,
      sha: queue.sha,
      prefix: queue.prefix,
      responseStorageId: queue.responseStorageId,
      itemOffset: queue.itemOffset,
      totalItems: queue.totalItems,
      totalFiles: snapshot.totalFiles,
    };
  },
});

/** Attach one fetched subtree response; stale actions discard their own file. */
export const attachIndexTreeTraversalResponse = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    snapshotId: v.id("repoTreeSnapshots"),
    queueId: v.id("repoTreeTraversalQueue"),
    claimToken: v.string(),
    responseStorageId: v.id("_storage"),
    totalItems: v.number(),
  },
  handler: async (ctx, args) => {
    const [repo, snapshot, queue] = await Promise.all([
      ctx.db.get(args.repositoryId),
      ctx.db.get(args.snapshotId),
      ctx.db.get(args.queueId),
    ]);
    const ownsClaim =
      repo !== null &&
      snapshot !== null &&
      queue !== null &&
      repo.indexVersion === args.expectedIndexVersion &&
      repo.indexStatus === "indexing" &&
      repo.indexTreeSnapshotId === args.snapshotId &&
      snapshot.repositoryId === args.repositoryId &&
      snapshot.indexVersion === args.expectedIndexVersion &&
      snapshot.status === "building" &&
      snapshot.traversalState === "traversing" &&
      snapshot.traversalClaimToken === args.claimToken &&
      queue.snapshotId === args.snapshotId;
    if (!ownsClaim) {
      await ctx.storage.delete(args.responseStorageId);
      return { accepted: false, reason: "stale traversal claim" };
    }
    if (queue.responseStorageId !== undefined) {
      if (queue.responseStorageId !== args.responseStorageId) {
        await ctx.storage.delete(args.responseStorageId);
      }
      return { accepted: true };
    }
    if (!Number.isSafeInteger(args.totalItems) || args.totalItems < 0) {
      await ctx.storage.delete(args.responseStorageId);
      return { accepted: false, reason: "invalid subtree item count" };
    }
    if (
      (snapshot.traversalItemCount ?? 0) + args.totalItems >
      REPOSITORY_TREE_TRAVERSAL_MAX_ITEMS
    ) {
      await ctx.storage.delete(args.responseStorageId);
      return { accepted: false, reason: "repository tree item limit exceeded" };
    }

    const now = Date.now();
    await ctx.db.patch(args.queueId, {
      responseStorageId: args.responseStorageId,
      totalItems: args.totalItems,
      itemOffset: 0,
      updatedAt: now,
    });
    await ctx.db.patch(args.snapshotId, {
      traversalRequestCount: (snapshot.traversalRequestCount ?? 0) + 1,
      traversalItemCount: (snapshot.traversalItemCount ?? 0) + args.totalItems,
      updatedAt: now,
    });
    return { accepted: true };
  },
});

/** Delete an ambiguous action upload only when no traversal queue published it. */
export const deleteUnpublishedTreeTraversalResponseStorage = internalMutation({
  args: { storageId: v.id("_storage") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const published = await ctx.db
      .query("repoTreeTraversalQueue")
      .withIndex("by_response_storage_id", (q) =>
        q.eq("responseStorageId", args.storageId),
      )
      .first();
    if (published) {
      return false;
    }
    await ctx.storage.delete(args.storageId);
    return true;
  },
});

/** Commit one bounded cursor slice, emitted pages, and child queue entries. */
export const commitIndexTreeTraversalSlice = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    snapshotId: v.id("repoTreeSnapshots"),
    queueId: v.id("repoTreeTraversalQueue"),
    claimToken: v.string(),
    expectedItemOffset: v.number(),
    nextItemOffset: v.number(),
    complete: v.boolean(),
    children: v.array(
      v.object({
        sha: v.string(),
        prefix: v.string(),
      }),
    ),
    files: repositoryTreeSnapshotPageValidator,
  },
  handler: async (ctx, args) => {
    const [repo, snapshot, queue] = await Promise.all([
      ctx.db.get(args.repositoryId),
      ctx.db.get(args.snapshotId),
      ctx.db.get(args.queueId),
    ]);
    if (
      !repo ||
      !snapshot ||
      !queue ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing" ||
      repo.indexTreeSnapshotId !== args.snapshotId ||
      snapshot.repositoryId !== args.repositoryId ||
      snapshot.indexVersion !== args.expectedIndexVersion ||
      snapshot.status !== "building" ||
      snapshot.traversalState !== "traversing" ||
      snapshot.traversalClaimToken !== args.claimToken ||
      queue.snapshotId !== args.snapshotId ||
      queue.itemOffset !== args.expectedItemOffset ||
      queue.totalItems === undefined ||
      queue.responseStorageId === undefined
    ) {
      return { accepted: false, ready: false, totalFiles: 0 };
    }

    const processedItems = args.nextItemOffset - args.expectedItemOffset;
    if (
      !Number.isSafeInteger(args.expectedItemOffset) ||
      !Number.isSafeInteger(args.nextItemOffset) ||
      processedItems < 0 ||
      processedItems > REPOSITORY_TREE_TRAVERSAL_ITEMS_PER_ACTION ||
      args.nextItemOffset > queue.totalItems ||
      args.complete !== (args.nextItemOffset === queue.totalItems) ||
      args.children.length + args.files.length > processedItems
    ) {
      throw new Error("invalid repository tree traversal slice");
    }

    const now = Date.now();
    for (const child of args.children) {
      await ctx.db.insert("repoTreeTraversalQueue", {
        snapshotId: args.snapshotId,
        identityKey: buildRepositoryTreeTraversalIdentity(
          child.sha,
          child.prefix,
        ),
        sha: child.sha,
        prefix: child.prefix,
        itemOffset: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    let pageIndex = snapshot.nextPageIndex ?? 0;
    const bufferedFiles = [
      ...(snapshot.traversalPendingFiles ?? []),
      ...args.files,
    ];
    if (
      (snapshot.traversalPendingFiles?.length ?? 0) >=
      REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE
    ) {
      throw new Error("repository tree traversal pending page is unbounded");
    }
    while (bufferedFiles.length >= REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE) {
      await ctx.db.insert("repoTreeSnapshotPages", {
        snapshotId: args.snapshotId,
        pageIndex,
        files: bufferedFiles.splice(0, REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE),
        createdAt: now,
      });
      pageIndex++;
    }

    if (args.complete) {
      await ctx.storage.delete(queue.responseStorageId);
      await ctx.db.delete(args.queueId);
    } else {
      await ctx.db.patch(args.queueId, {
        itemOffset: args.nextItemOffset,
        updatedAt: now,
      });
    }

    const remainingQueue = await ctx.db
      .query("repoTreeTraversalQueue")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
      .first();
    const totalFiles = snapshot.totalFiles + args.files.length;
    let ready = false;
    if (!remainingQueue) {
      if (bufferedFiles.length > 0) {
        await ctx.db.insert("repoTreeSnapshotPages", {
          snapshotId: args.snapshotId,
          pageIndex,
          files: bufferedFiles.splice(0),
          createdAt: now,
        });
        pageIndex++;
      }
      const expectedTotalPages =
        totalFiles === 0
          ? 0
          : Math.ceil(totalFiles / REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE);
      if (pageIndex !== expectedTotalPages) {
        throw new Error("repository tree traversal page totals diverged");
      }
      await ctx.db.patch(args.snapshotId, {
        totalFiles,
        totalPages: pageIndex,
        nextPageIndex: pageIndex,
        traversalState: undefined,
        traversalPendingFiles: undefined,
        traversalClaimToken: undefined,
        traversalClaimedAt: undefined,
        status: "ready",
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.repoIndexing.action.indexRepository,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: args.expectedIndexVersion,
          continuation: true,
          pageIndex: 0,
          treeSnapshotId: args.snapshotId,
        },
      );
      ready = true;
    } else {
      await ctx.db.patch(args.snapshotId, {
        totalFiles,
        totalPages: pageIndex,
        nextPageIndex: pageIndex,
        traversalPendingFiles: bufferedFiles,
        traversalClaimToken: undefined,
        traversalClaimedAt: undefined,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.repoIndexing.action.indexRepository,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: args.expectedIndexVersion,
          continuation: true,
          treeTraversal: true,
          treeSnapshotId: args.snapshotId,
        },
      );
    }

    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    return { accepted: true, ready, totalFiles };
  },
});

/** Attach a discoverable building manifest before any page data is written. */
export const beginIndexTreeSnapshot = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    defaultBranch: v.string(),
    commitSha: v.string(),
    treeSha: v.string(),
    totalFiles: v.number(),
    totalPages: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    snapshotId: Id<"repoTreeSnapshots">;
    nextPageIndex: number;
    ready: boolean;
  } | null> => {
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing"
    ) {
      return null;
    }
    validateRepositoryTreeSnapshotTotals(args.totalFiles, args.totalPages);

    if (repo.indexTreeSnapshotId !== undefined) {
      const existing = await ctx.db.get(repo.indexTreeSnapshotId);
      if (
        !existing ||
        existing.repositoryId !== args.repositoryId ||
        existing.indexVersion !== args.expectedIndexVersion ||
        existing.defaultBranch !== args.defaultBranch ||
        existing.commitSha !== args.commitSha ||
        existing.treeSha !== args.treeSha ||
        existing.totalFiles !== args.totalFiles ||
        existing.totalPages !== args.totalPages ||
        existing.status === "deleting"
      ) {
        return null;
      }

      return {
        snapshotId: existing._id,
        nextPageIndex:
          existing.nextPageIndex ??
          (existing.status === "ready" ? existing.totalPages : 0),
        ready: existing.status === "ready",
      };
    }

    const now = Date.now();
    const snapshotId = await ctx.db.insert("repoTreeSnapshots", {
      repositoryId: args.repositoryId,
      indexVersion: args.expectedIndexVersion,
      defaultBranch: args.defaultBranch,
      commitSha: args.commitSha,
      treeSha: args.treeSha,
      totalFiles: args.totalFiles,
      totalPages: args.totalPages,
      nextPageIndex: 0,
      status: "building",
      createdAt: now,
      updatedAt: now,
    });

    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      indexTreeSnapshotId: snapshotId,
      indexSource: {
        indexVersion: args.expectedIndexVersion,
        commitSha: args.commitSha,
        defaultBranch: args.defaultBranch,
      },
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    return { snapshotId, nextPageIndex: 0, ready: false };
  },
});

/** Append one contiguous, retry-safe page batch to a building manifest. */
export const appendIndexTreeSnapshotPages = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    snapshotId: v.id("repoTreeSnapshots"),
    startPageIndex: v.number(),
    pages: v.array(repositoryTreeSnapshotPageValidator),
  },
  handler: async (ctx, args) => {
    const [repo, snapshot] = await Promise.all([
      ctx.db.get(args.repositoryId),
      ctx.db.get(args.snapshotId),
    ]);
    if (
      !repo ||
      !snapshot ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing" ||
      repo.indexTreeSnapshotId !== args.snapshotId ||
      snapshot.repositoryId !== args.repositoryId ||
      snapshot.indexVersion !== args.expectedIndexVersion ||
      snapshot.status === "deleting" ||
      !Number.isSafeInteger(args.startPageIndex) ||
      args.startPageIndex < 0 ||
      args.pages.length === 0 ||
      args.pages.length > REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_PAGES ||
      getRepositoryTreeSnapshotPagesBytes(args.pages) >
        REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_BYTES
    ) {
      return {
        accepted: false,
        appended: 0,
        nextPageIndex: snapshot?.nextPageIndex ?? 0,
        ready: snapshot?.status === "ready",
      };
    }

    validateRepositoryTreeSnapshotTotals(
      snapshot.totalFiles,
      snapshot.totalPages,
    );
    const endPageIndex = args.startPageIndex + args.pages.length;
    if (endPageIndex > snapshot.totalPages) {
      return {
        accepted: false,
        appended: 0,
        nextPageIndex: snapshot.nextPageIndex ?? 0,
        ready: snapshot.status === "ready",
      };
    }
    for (let offset = 0; offset < args.pages.length; offset++) {
      validateRepositoryTreeSnapshotPage(
        args.pages[offset],
        args.startPageIndex + offset,
        snapshot.totalFiles,
        snapshot.totalPages,
      );
    }

    const nextPageIndex =
      snapshot.nextPageIndex ??
      (snapshot.status === "ready" ? snapshot.totalPages : 0);
    if (args.startPageIndex < nextPageIndex && endPageIndex <= nextPageIndex) {
      for (let offset = 0; offset < args.pages.length; offset++) {
        const pageIndex = args.startPageIndex + offset;
        const existingPage = await ctx.db
          .query("repoTreeSnapshotPages")
          .withIndex("by_snapshot_and_page", (q) =>
            q.eq("snapshotId", args.snapshotId).eq("pageIndex", pageIndex),
          )
          .first();
        if (
          !existingPage ||
          !repositoryTreeSnapshotPagesMatch(
            existingPage.files,
            args.pages[offset],
          )
        ) {
          return {
            accepted: false,
            appended: 0,
            nextPageIndex,
            ready: snapshot.status === "ready",
          };
        }
      }
      return {
        accepted: true,
        appended: 0,
        nextPageIndex,
        ready: snapshot.status === "ready",
      };
    }
    if (
      snapshot.status !== "building" ||
      args.startPageIndex !== nextPageIndex
    ) {
      return {
        accepted: false,
        appended: 0,
        nextPageIndex,
        ready: snapshot.status === "ready",
      };
    }

    const now = Date.now();
    for (let offset = 0; offset < args.pages.length; offset++) {
      await ctx.db.insert("repoTreeSnapshotPages", {
        snapshotId: args.snapshotId,
        pageIndex: args.startPageIndex + offset,
        files: args.pages[offset],
        createdAt: now,
      });
    }
    await ctx.db.patch(args.snapshotId, {
      nextPageIndex: endPageIndex,
      updatedAt: now,
    });
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    return {
      accepted: true,
      appended: args.pages.length,
      nextPageIndex: endPageIndex,
      ready: false,
    };
  },
});

/** Publish a building snapshot only after every exact page is durable. */
export const finalizeIndexTreeSnapshot = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    snapshotId: v.id("repoTreeSnapshots"),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const [repo, snapshot] = await Promise.all([
      ctx.db.get(args.repositoryId),
      ctx.db.get(args.snapshotId),
    ]);
    if (
      !repo ||
      !snapshot ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing" ||
      repo.indexTreeSnapshotId !== args.snapshotId ||
      snapshot.repositoryId !== args.repositoryId ||
      snapshot.indexVersion !== args.expectedIndexVersion
    ) {
      return false;
    }
    if (snapshot.status === "ready") {
      return true;
    }
    if (
      snapshot.status !== "building" ||
      (snapshot.nextPageIndex ?? 0) !== snapshot.totalPages
    ) {
      return false;
    }

    const now = Date.now();
    await ctx.db.patch(args.snapshotId, {
      status: "ready",
      nextPageIndex: snapshot.totalPages,
      updatedAt: now,
    });
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    return true;
  },
});

/** Release only the snapshot owned by the exact active file-index generation. */
export const releaseIndexTreeSnapshot = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    snapshotId: v.id("repoTreeSnapshots"),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const [repo, snapshot] = await Promise.all([
      ctx.db.get(args.repositoryId),
      ctx.db.get(args.snapshotId),
    ]);
    if (
      !repo ||
      !snapshot ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing" ||
      repo.indexTreeSnapshotId !== args.snapshotId ||
      snapshot.repositoryId !== args.repositoryId ||
      snapshot.indexVersion !== args.expectedIndexVersion
    ) {
      return false;
    }

    await scheduleRepositoryTreeSnapshotCleanup(ctx, args.snapshotId);
    await ctx.db.patch(args.repositoryId, {
      indexTreeSnapshotId: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** Delete one bounded page batch from a detached tree snapshot. */
export const continueIndexTreeSnapshotCleanup = internalMutation({
  args: {
    snapshotId: v.id("repoTreeSnapshots"),
  },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db.get(args.snapshotId);
    if (!snapshot) {
      return { deleted: 0, hasMore: false, completed: true };
    }
    if (snapshot.status !== "deleting") {
      return { deleted: 0, hasMore: false, completed: false };
    }

    const pages = await ctx.db
      .query("repoTreeSnapshotPages")
      .withIndex("by_snapshot", (q) => q.eq("snapshotId", args.snapshotId))
      .take(REPOSITORY_TREE_SNAPSHOT_CLEANUP_BATCH_SIZE);
    for (const page of pages) {
      await ctx.db.delete(page._id);
    }

    const remainingCleanupCapacity =
      REPOSITORY_TREE_SNAPSHOT_CLEANUP_BATCH_SIZE - pages.length;
    const queueEntries =
      remainingCleanupCapacity > 0
        ? await ctx.db
            .query("repoTreeTraversalQueue")
            .withIndex("by_snapshot", (q) =>
              q.eq("snapshotId", args.snapshotId),
            )
            .take(remainingCleanupCapacity)
        : [];
    for (const entry of queueEntries) {
      if (entry.responseStorageId) {
        await ctx.storage.delete(entry.responseStorageId);
      }
      await ctx.db.delete(entry._id);
    }

    const deleted = pages.length + queueEntries.length;
    const hasMore = deleted === REPOSITORY_TREE_SNAPSHOT_CLEANUP_BATCH_SIZE;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.repoIndexing.mutation.continueIndexTreeSnapshotCleanup,
        { snapshotId: args.snapshotId },
      );
    } else {
      await ctx.db.delete(args.snapshotId);
    }

    return { deleted, hasMore, completed: !hasMore };
  },
});

/**
 * Store file blob in cache (internal only)
 */
const fileBlobPublicationArgs = {
  repositoryId: v.id("repositories"),
  expectedUserId: v.id("users"),
  expectedInstallationId: v.number(),
  expectedGithubRepositoryId: v.number(),
  expectedGithubRepo: v.string(),
  expectedIndexVersion: v.number(),
  filePath: v.string(),
  sha256: v.string(),
  language: v.optional(v.string()),
  size: v.number(),
  isText: v.boolean(),
};

type FileBlobPublicationArgs = {
  repositoryId: Id<"repositories">;
  expectedUserId: Id<"users">;
  expectedInstallationId: number;
  expectedGithubRepositoryId: number;
  expectedGithubRepo: string;
  expectedIndexVersion: number;
  filePath: string;
  sha256: string;
  language?: string;
  size: number;
  isText: boolean;
};

async function ownsExactFileBlobPublication(
  ctx: MutationCtx,
  args: FileBlobPublicationArgs,
): Promise<boolean> {
  const [repository, installation] = await Promise.all([
    ctx.db.get(args.repositoryId),
    getExactGitHubInstallation(ctx, args.expectedInstallationId),
  ]);
  return (
    repository !== null &&
    repository.userId === args.expectedUserId &&
    repository.installationId === args.expectedInstallationId &&
    repository.githubRepositoryId === args.expectedGithubRepositoryId &&
    repository.githubRepo === args.expectedGithubRepo &&
    repository.isActive === true &&
    repository.githubAccessRevokedAt === undefined &&
    repository.githubInstallationReconnectRequired !== true &&
    repository.disconnectCleanupPending !== true &&
    repository.indexVersion === args.expectedIndexVersion &&
    repository.indexStatus === "indexing" &&
    repository.indexIdentityVerifiedVersion === args.expectedIndexVersion &&
    repository.indexIdentityVerifiedInstallationId ===
      args.expectedInstallationId &&
    repository.indexIdentityVerifiedGithubRepositoryId ===
      args.expectedGithubRepositoryId &&
    repository.indexIdentityVerifiedGithubRepo === args.expectedGithubRepo &&
    isGitHubInstallationReady(installation) &&
    installation.userId === args.expectedUserId &&
    installation.installationId === args.expectedInstallationId
  );
}

async function upsertFileMapForPublication(
  ctx: MutationCtx,
  args: FileBlobPublicationArgs,
): Promise<Id<"repoFileMap">> {
  const existing = await ctx.db
    .query("repoFileMap")
    .withIndex("by_repository_and_path", (q) =>
      q.eq("repositoryId", args.repositoryId).eq("filePath", args.filePath),
    )
    .first();
  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, {
      sha256: args.sha256,
      language: args.language,
      size: args.size,
      isText: args.isText,
      indexVersion: args.expectedIndexVersion,
      ragPending:
        existing.ragPending === true || !isUnchangedFileMap(existing, args)
          ? true
          : undefined,
      updatedAt: now,
    });
    return existing._id;
  }
  return await ctx.db.insert("repoFileMap", {
    repositoryId: args.repositoryId,
    filePath: args.filePath,
    sha256: args.sha256,
    language: args.language,
    size: args.size,
    isText: args.isText,
    indexVersion: args.expectedIndexVersion,
    ragPending: true,
    createdAt: now,
    updatedAt: now,
  });
}

type FileMapIdentity = Pick<
  Doc<"repoFileMap">,
  "sha256" | "language" | "size" | "isText"
>;

/** The same blob at the same path needs no new blob work and no re-chunking. */
export function isUnchangedFileMap(
  existing: FileMapIdentity,
  next: FileMapIdentity,
): boolean {
  return (
    existing.sha256 === next.sha256 &&
    existing.isText === next.isText &&
    existing.size === next.size &&
    existing.language === next.language
  );
}

export const MAX_UNCHANGED_FILE_MAP_BATCH = 64;

/**
 * Carry every unchanged file of one tree page into the new generation in a
 * single transaction. Only the generation number of each map row changes;
 * blobs and chunks are not touched. Returns the paths that still need the
 * per-file blob workflow, or "stale" when the generation lost ownership.
 */
export const reuseUnchangedFileMaps = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedUserId: v.id("users"),
    expectedInstallationId: v.number(),
    expectedGithubRepositoryId: v.number(),
    expectedGithubRepo: v.string(),
    expectedIndexVersion: v.number(),
    files: v.array(
      v.object({
        filePath: v.string(),
        sha256: v.string(),
        language: v.optional(v.string()),
        size: v.number(),
        isText: v.boolean(),
      }),
    ),
  },
  returns: v.union(
    v.literal("stale"),
    v.object({ changedPaths: v.array(v.string()) }),
  ),
  handler: async (ctx, args) => {
    if (args.files.length > MAX_UNCHANGED_FILE_MAP_BATCH) {
      throw new Error("Unchanged file map batch is too large");
    }
    const first = args.files[0];
    if (!first) return { changedPaths: [] };
    if (
      !(await ownsExactFileBlobPublication(ctx, {
        ...args,
        ...first,
      }))
    ) {
      return "stale" as const;
    }
    const changedPaths: string[] = [];
    for (const file of args.files) {
      const existing = await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository_and_path", (q) =>
          q.eq("repositoryId", args.repositoryId).eq("filePath", file.filePath),
        )
        .first();
      if (!existing || !isUnchangedFileMap(existing, file)) {
        changedPaths.push(file.filePath);
        continue;
      }
      if (existing.indexVersion !== args.expectedIndexVersion) {
        await ctx.db.patch(existing._id, {
          indexVersion: args.expectedIndexVersion,
        });
      }
    }
    return { changedPaths };
  },
});

export const storeFileBlob = internalMutation({
  args: {
    ...fileBlobPublicationArgs,
    storageId: v.id("_storage"),
  },
  returns: v.union(v.id("repoFileBlobs"), v.null()),
  handler: async (ctx, args) => {
    if (!(await ownsExactFileBlobPublication(ctx, args))) {
      await ctx.storage.delete(args.storageId);
      return null;
    }

    // Check if blob already exists
    const existing = await ctx.db
      .query("repoFileBlobs")
      .withIndex("by_sha256", (q) => q.eq("sha256", args.sha256))
      .first();

    const now = Date.now();

    if (existing) {
      if (existing.storageId !== args.storageId) {
        await ctx.storage.delete(args.storageId);
      }
      // Update access count and time
      await ctx.db.patch(existing._id, {
        lastAccessedAt: now,
        accessCount: existing.accessCount + 1,
      });
      await upsertFileMapForPublication(ctx, args);
      return existing._id;
    }

    const blobId = await ctx.db.insert("repoFileBlobs", {
      sha256: args.sha256,
      storageId: args.storageId,
      size: args.size,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 1,
    });
    await upsertFileMapForPublication(ctx, args);
    return blobId;
  },
});

/** Reuse and map an existing shared blob under the exact indexing fence. */
export const reuseFileBlob = internalMutation({
  args: fileBlobPublicationArgs,
  returns: v.union(v.boolean(), v.literal("stale")),
  handler: async (ctx, args): Promise<boolean | "stale"> => {
    if (!(await ownsExactFileBlobPublication(ctx, args))) {
      return "stale";
    }
    const existing = await ctx.db
      .query("repoFileBlobs")
      .withIndex("by_sha256", (q) => q.eq("sha256", args.sha256))
      .first();

    if (!existing) {
      return false;
    }

    await ctx.db.patch(existing._id, {
      lastAccessedAt: Date.now(),
      accessCount: existing.accessCount + 1,
    });
    await upsertFileMapForPublication(ctx, args);
    return true;
  },
});

/** Delete an action upload only when no published blob references it. */
export const deleteUnpublishedFileBlobStorage = internalMutation({
  args: { storageId: v.id("_storage") },
  returns: v.boolean(),
  handler: async (ctx, { storageId }): Promise<boolean> => {
    const published = await ctx.db
      .query("repoFileBlobs")
      .withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
      .first();
    if (published) {
      return false;
    }
    await ctx.storage.delete(storageId);
    return true;
  },
});

/**
 * Map file path to cached blob (internal only)
 */
export const mapFile = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    filePath: v.string(),
    sha256: v.string(),
    language: v.optional(v.string()),
    size: v.number(),
    isText: v.boolean(),
    indexVersion: v.number(),
  },
  returns: v.union(
    v.object({
      status: v.literal("mapped"),
      fileMapId: v.id("repoFileMap"),
    }),
    v.object({ status: v.literal("deferred") }),
  ),
  handler: async (ctx, args) => {
    // Binary files have metadata mappings without cached blob content.

    const repository = await ctx.db.get(args.repositoryId);
    if (
      !repository ||
      repository.isActive !== true ||
      repository.githubAccessRevokedAt !== undefined ||
      repository.disconnectCleanupPending === true ||
      repository.indexVersion !== args.indexVersion ||
      repository.indexStatus !== "indexing"
    ) {
      throw new Error("stale repository indexing generation");
    }
    if (!(await hasReadyRepositoryInstallation(ctx, repository))) {
      await quarantineRepositoryForMissingInstallation(ctx, repository);
      return { status: "deferred" as const };
    }

    const fileMapId = await upsertFileMapForPublication(ctx, {
      repositoryId: args.repositoryId,
      expectedUserId: repository.userId,
      expectedInstallationId: repository.installationId,
      expectedGithubRepositoryId: repository.githubRepositoryId,
      expectedGithubRepo: repository.githubRepo,
      expectedIndexVersion: args.indexVersion,
      filePath: args.filePath,
      sha256: args.sha256,
      language: args.language,
      size: args.size,
      isText: args.isText,
    });
    return { status: "mapped" as const, fileMapId };
  },
});

/**
 * Delete one bounded page of stale file maps and continue transactionally.
 * The final page publishes the file generation and reserves its RAG pass in
 * the same mutation, so cleanup can never consume an unbounded action runtime.
 */
export const continueFileMapCleanup = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    totalFiles: v.number(),
    deletedTotal: v.optional(v.number()),
    deferralCount: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    accepted: boolean;
    deleted: number;
    hasMore: boolean;
    completed: boolean;
  }> => {
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo ||
      repo.isActive !== true ||
      repo.githubAccessRevokedAt !== undefined ||
      repo.disconnectCleanupPending === true ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "indexing"
    ) {
      return { accepted: false, deleted: 0, hasMore: false, completed: false };
    }

    if (!(await hasReadyRepositoryInstallation(ctx, repo))) {
      if (await quarantineRepositoryForMissingInstallation(ctx, repo)) {
        return {
          accepted: false,
          deleted: 0,
          hasMore: false,
          completed: false,
        };
      }
      const now = Date.now();
      const deferralCount = args.deferralCount ?? 0;
      const watchdog = await armIndexWatchdog(ctx, {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        previousScheduleId: repo.indexWatchdogScheduleId,
        previousSequence: repo.indexWatchdogSequence,
        delayMs: INSTALLATION_ACCESS_RETRY_MS + INDEXING_STALE_THRESHOLD_MS,
      });
      await ctx.db.patch(args.repositoryId, {
        indexWatchdogToken: watchdog.token,
        indexWatchdogScheduleId: watchdog.scheduleId,
        indexWatchdogSequence: watchdog.sequence,
        indexProgressAt: now,
        updatedAt: now,
      });
      if (deferralCount === 0) {
        // Surface the wait once per deferral episode so the sync never looks
        // frozen while access reconciliation holds the cleanup back.
        await ctx.db.insert("repoIndexingLogs", {
          repositoryId: args.repositoryId,
          indexVersion: args.expectedIndexVersion,
          level: "warning",
          message:
            "GitHub App access is being reconciled; cleanup will resume automatically",
          createdAt: now,
        });
      }
      await ctx.scheduler.runAfter(
        INSTALLATION_ACCESS_RETRY_MS,
        internal.repoIndexing.mutation.continueFileMapCleanup,
        { ...args, deferralCount: deferralCount + 1 },
      );
      return { accepted: true, deleted: 0, hasMore: true, completed: false };
    }

    const batchSize = 100;
    const oldFileMaps = await ctx.db
      .query("repoFileMap")
      .withIndex("by_index_version", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .lt("indexVersion", args.expectedIndexVersion),
      )
      .take(batchSize);

    // A path missing from the new tree loses its chunks with its map row.
    let chunkBudget = RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE;
    let deletedMaps = 0;
    let deletedChunks = 0;
    let chunkBudgetExhausted = false;
    for (const fileMap of oldFileMaps) {
      const chunks = await deleteChunksForPath(
        ctx,
        args.repositoryId,
        fileMap.filePath,
        chunkBudget,
      );
      chunkBudget -= chunks.deleted;
      deletedChunks += chunks.deleted;
      if (!chunks.done) {
        chunkBudgetExhausted = true;
        break;
      }
      await ctx.db.delete(fileMap._id);
      deletedMaps++;
    }

    const now = Date.now();
    const hasMore = oldFileMaps.length === batchSize || chunkBudgetExhausted;
    const deletedTotal = (args.deletedTotal ?? 0) + deletedMaps;
    const liveChunks =
      repo.ragLiveChunks === undefined
        ? {}
        : { ragLiveChunks: Math.max(0, repo.ragLiveChunks - deletedChunks) };
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    if (hasMore) {
      await ctx.db.patch(args.repositoryId, {
        ...liveChunks,
        indexWatchdogToken: watchdog.token,
        indexWatchdogScheduleId: watchdog.scheduleId,
        indexWatchdogSequence: watchdog.sequence,
        indexProgressAt: now,
        updatedAt: now,
      });
      // Every 20 full batches, leave a durable progress line so long cleanups
      // stay visibly alive in the indexing log instead of appearing frozen.
      if (deletedTotal % 2000 === 0) {
        await ctx.db.insert("repoIndexingLogs", {
          repositoryId: args.repositoryId,
          indexVersion: args.expectedIndexVersion,
          level: "info",
          message: `Cleaning up previous index data... ${deletedTotal} stale entries removed`,
          createdAt: now,
        });
      }
      await ctx.scheduler.runAfter(
        0,
        internal.repoIndexing.mutation.continueFileMapCleanup,
        { ...args, deletedTotal, deferralCount: 0 },
      );
      return {
        accepted: true,
        deleted: oldFileMaps.length,
        hasMore: true,
        completed: false,
      };
    }

    await scheduleRepositoryTreeSnapshotCleanup(ctx, repo.indexTreeSnapshotId);
    await ctx.db.patch(args.repositoryId, {
      ...liveChunks,
      indexStatus: "completed",
      indexError: undefined,
      lastIndexedAt: now,
      ragStatus: "pending",
      ragError: undefined,
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
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
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexTreeSnapshotId: undefined,
      indexRateLimitRetryToken: undefined,
      indexRateLimitRetryAt: undefined,
      indexIdentityVerifiedVersion: undefined,
      indexIdentityVerifiedInstallationId: undefined,
      indexIdentityVerifiedGithubRepositoryId: undefined,
      indexIdentityVerifiedGithubRepo: undefined,
      indexProgressAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("repoIndexingLogs", {
      repositoryId: args.repositoryId,
      indexVersion: args.expectedIndexVersion,
      level: "success",
      message: `Cleanup completed; repository indexing finished with ${args.totalFiles} files`,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.ragV2.action.generateChunkEmbeddings,
      {
        repositoryId: args.repositoryId,
        indexVersion: args.expectedIndexVersion,
      },
    );
    await ctx.scheduler.runAfter(
      0,
      internal.admin.internalMutation.createAiLog,
      {
        repositoryId: args.repositoryId,
        userId: repo.userId,
        workflowType: "indexing",
        actionType: "index_repository",
        githubRepo: repo.githubRepo,
        status: "success",
      },
    );

    return {
      accepted: true,
      deleted: oldFileMaps.length,
      hasMore: false,
      completed: true,
    };
  },
});

/**
 * Clean up chunks of older generations. RAG passes now use
 * ragV2/internalMutation:cleanupRagGeneration; this stays for actions that
 * were already running when that change deployed.
 */
export const cleanupOldChunks = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    currentVersion: v.number(),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedBatchSize = Number.isFinite(args.batchSize)
      ? Math.floor(args.batchSize ?? RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE)
      : RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE;
    const batchSize = Math.min(
      RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE,
      Math.max(1, requestedBatchSize),
    );

    // Delete chunks from old versions using take() instead of pagination
    const oldChunks = await ctx.db
      .query("repoChunks")
      .withIndex("by_index_version", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .lt("indexVersion", args.currentVersion),
      )
      .take(batchSize);

    for (const chunk of oldChunks) {
      await ctx.db.delete(chunk._id);
    }

    return {
      deleted: oldChunks.length,
      hasMore: oldChunks.length === batchSize,
    };
  },
});

export const deleteFileBlobIfStale = internalMutation({
  args: {
    blobId: v.id("repoFileBlobs"),
    threshold: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const blob = await ctx.db.get(args.blobId);
    if (!blob || blob.lastAccessedAt >= args.threshold) {
      return false;
    }

    const referencedFile = await ctx.db
      .query("repoFileMap")
      .withIndex("by_sha256", (q) => q.eq("sha256", blob.sha256))
      .first();
    if (referencedFile) {
      // Unchanged files reuse their blobs without touching them, so a
      // referenced blob is rechecked once per REFERENCED_BLOB_RECHECK_MS
      // instead of coming back into the stale window every week.
      await ctx.db.patch(args.blobId, {
        lastAccessedAt: Date.now() + REFERENCED_BLOB_RECHECK_MS,
      });
      return false;
    }

    await ctx.storage.delete(blob.storageId);
    await ctx.db.delete(args.blobId);
    return true;
  },
});

/**
 * Prepare incremental indexing (internal only)
 * Atomically checks status and sets to "pending" to prevent race conditions
 *
 * Strategy: Only one complete file+RAG generation can advance at a time
 * - If file indexing is completed and RAG is not pending/indexing: start
 * - If "pending" or "indexing": skip (already processing)
 * - If the matching RAG pass is pending/indexing: preserve that version
 *
 * This is simple and safe: only a stable index → "pending" transition is allowed
 * Convex mutations are serialized, so concurrent triggers will execute sequentially
 */
export const prepareIncrementalIndex = internalMutation({
  args: {
    repositoryId: v.optional(v.id("repositories")),
    installationId: v.optional(v.number()),
    githubRepositoryId: v.optional(v.number()),
    allowFailedIndexRecovery: v.optional(v.boolean()),
    allowStaleIndexRecovery: v.optional(v.boolean()),
    queueIfBusy: v.optional(v.boolean()),
    scheduleDelayMs: v.optional(v.number()),
    clearAccessRestorePending: v.optional(v.boolean()),
    source: v.optional(
      v.object({ commitSha: v.string(), defaultBranch: v.string() }),
    ),
    // Owner-requested sync: rebuild every path's chunks.
    fullRebuild: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { success: false; error: string; queued?: boolean }
    | { success: true; repositoryId: string; newVersion: number }
  > => {
    // Find repository
    let repo = args.repositoryId ? await ctx.db.get(args.repositoryId) : null;
    const requestedInstallation =
      args.installationId === undefined
        ? undefined
        : await getExactGitHubInstallation(ctx, args.installationId);
    if (!repo && args.installationId !== undefined) {
      if (args.githubRepositoryId !== undefined) {
        const identityMatches =
          await readRepositoriesByInstallationAndGitHubRepositoryId(
            ctx,
            args.installationId,
            args.githubRepositoryId,
          );
        repo =
          resolveUniquePreferredRepositoryIdentity(identityMatches).repository;
        if (
          repo &&
          (!requestedInstallation ||
            repo.userId !== requestedInstallation.userId ||
            repo.githubAccessRevokedAt !== undefined ||
            repo.githubRepositoryId !== args.githubRepositoryId)
        ) {
          repo = null;
        }
      }
    }

    if (!repo) {
      return {
        success: false,
        error:
          args.repositoryId || args.installationId !== undefined
            ? "repository not found"
            : "repository identifier required",
      };
    }

    const repositoryInstallation =
      requestedInstallation?.installationId === repo.installationId
        ? requestedInstallation
        : await getExactGitHubInstallation(ctx, repo.installationId);
    if (
      !isGitHubInstallationReady(repositoryInstallation) ||
      repositoryInstallation.userId !== repo.userId
    ) {
      if (
        args.queueIfBusy === true &&
        isGitHubInstallationReconciliationPending(repositoryInstallation) &&
        repositoryInstallation.userId === repo.userId &&
        repositoryInstallation.installationId === repo.installationId &&
        repo.isActive === true &&
        repo.githubAccessRevokedAt === undefined &&
        repo.disconnectCleanupPending !== true
      ) {
        const now = Date.now();
        await ctx.db.patch(repo._id, {
          indexSyncPending: true,
          indexSyncPendingSource: coalesceIndexSyncSource(repo, args.source),
          githubAccessRestoreIndexPending: true,
          githubAccessRestoreIndexNextAttemptAt: now,
          githubAccessRestoreIndexRetryCount: 0,
        });
        return {
          success: false,
          error: "repository installation access is not ready",
          queued: true,
        };
      }
      await quarantineRepositoryForMissingInstallation(ctx, repo);
      return {
        success: false,
        error: "repository installation access is not ready",
      };
    }

    if (
      repo.isActive &&
      repo.githubAccessRevokedAt === undefined &&
      repo.disconnectCleanupPending !== true &&
      repo.indexStatus !== "failed" &&
      repo.ragStatus !== "failed" &&
      matchesCurrentIndexSource(repo, args.source)
    ) {
      return {
        success: false,
        error: "repository already indexes this commit",
        queued: false,
      };
    }

    const eligibility = getIncrementalIndexEligibility(repo, {
      allowFailedIndexRecovery: args.allowFailedIndexRecovery,
      allowStaleIndexRecovery: args.allowStaleIndexRecovery,
    });
    if (!eligibility.allowed) {
      const isTransientlyBusy = hasIncrementalIndexWorkInProgress(repo);
      const shouldQueue = isTransientlyBusy && args.queueIfBusy !== false;
      if (shouldQueue) {
        await ctx.db.patch(repo._id, {
          indexSyncPending: true,
          indexSyncPendingSource: coalesceIndexSyncSource(repo, args.source),
        });
      }
      return {
        success: false,
        error: eligibility.reason,
        queued: shouldQueue,
      };
    }

    // Increment version
    const newVersion = repo.indexVersion + 1;
    const now = Date.now();
    await scheduleRepositoryTreeSnapshotCleanup(ctx, repo.indexTreeSnapshotId);
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: repo._id,
      expectedIndexVersion: newVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });

    // Atomically: increment version, set status to pending
    // This locks the repository - no other trigger can start until completed
    await ctx.db.patch(repo._id, {
      indexVersion: newVersion,
      ...(args.fullRebuild === true ? { ragFullRebuildRequested: true } : {}),
      indexStatus: "pending", // Lock: only "completed" can transition here
      indexError: undefined,
      ragStatus: "pending",
      ragError: undefined,
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
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
      indexSyncPendingSource: undefined,
      githubAccessRestoreIndexPending:
        args.clearAccessRestorePending === true
          ? undefined
          : repo.githubAccessRestoreIndexPending,
      githubAccessRestoreIndexNextAttemptAt:
        args.clearAccessRestorePending === true
          ? undefined
          : repo.githubAccessRestoreIndexNextAttemptAt,
      githubAccessRestoreIndexRetryCount:
        args.clearAccessRestorePending === true
          ? undefined
          : repo.githubAccessRestoreIndexRetryCount,
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexWatchdogRetryCount: 0,
      indexTreeSnapshotId: undefined,
      indexRateLimitRetryToken: undefined,
      indexRateLimitRetryAt: undefined,
      indexIdentityVerifiedVersion: undefined,
      indexIdentityVerifiedInstallationId: undefined,
      indexIdentityVerifiedGithubRepositoryId: undefined,
      indexIdentityVerifiedGithubRepo: undefined,
      indexProgressAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      Math.max(0, args.scheduleDelayMs ?? 0),
      internal.repoIndexing.action.indexRepository,
      { repositoryId: repo._id, expectedIndexVersion: newVersion },
    );

    return {
      success: true,
      repositoryId: repo._id,
      newVersion,
    };
  },
});

/**
 * Consume one coalesced push after the matching RAG generation completes.
 * The state update and scheduling are transactional, so a failed schedule does
 * not strand the repository in a pending generation.
 */
export const startQueuedIncrementalIndex = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo?.indexSyncPending) {
      return { scheduled: false as const };
    }
    if (!(await hasReadyRepositoryInstallation(ctx, repo))) {
      await quarantineRepositoryForMissingInstallation(ctx, repo);
      return { scheduled: false as const };
    }

    const eligibility = getIncrementalIndexEligibility(repo);
    if (!eligibility.allowed) {
      return { scheduled: false as const };
    }

    if (
      repo.ragStatus === "completed" &&
      matchesCurrentIndexSource(repo, repo.indexSyncPendingSource)
    ) {
      await ctx.db.patch(repo._id, {
        indexSyncPending: false,
        indexSyncPendingSource: undefined,
      });
      return { scheduled: false as const };
    }

    const newVersion = repo.indexVersion + 1;
    const now = Date.now();
    await scheduleRepositoryTreeSnapshotCleanup(ctx, repo.indexTreeSnapshotId);
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: repo._id,
      expectedIndexVersion: newVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(repo._id, {
      indexVersion: newVersion,
      indexStatus: "pending",
      ragStatus: "pending",
      ragError: undefined,
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
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
      indexSyncPendingSource: undefined,
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexWatchdogRetryCount: 0,
      indexTreeSnapshotId: undefined,
      indexRateLimitRetryToken: undefined,
      indexRateLimitRetryAt: undefined,
      indexIdentityVerifiedVersion: undefined,
      indexIdentityVerifiedInstallationId: undefined,
      indexIdentityVerifiedGithubRepositoryId: undefined,
      indexIdentityVerifiedGithubRepo: undefined,
      indexProgressAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.repoIndexing.action.indexRepository,
      { repositoryId: repo._id, expectedIndexVersion: newVersion },
    );

    return { scheduled: true as const, newVersion };
  },
});

/**
 * Add indexing log (internal - called from actions)
 */
export const addIndexingLog = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    level: v.union(
      v.literal("info"),
      v.literal("success"),
      v.literal("warning"),
      v.literal("error"),
    ),
    message: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const repository = await ctx.db.get(args.repositoryId);
    if (
      !repository ||
      repository.disconnectCleanupPending === true ||
      repository.indexVersion !== args.indexVersion
    ) {
      return null;
    }
    const now = Date.now();
    return await ctx.db.insert("repoIndexingLogs", {
      repositoryId: args.repositoryId,
      indexVersion: args.indexVersion,
      level: args.level,
      message: args.message,
      metadata: args.metadata,
      createdAt: now,
    });
  },
});
