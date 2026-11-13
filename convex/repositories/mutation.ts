import { detachUsageRepositoryInPeriodTotals } from "../tokenUsage/periodTotals";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  armIndexWatchdog,
  cancelIndexWatchdog,
} from "../repoIndexing/watchdog";
import { scheduleRepositoryTreeSnapshotCleanup } from "../repoIndexing/treeSnapshot";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import { getCanonicalGitHubRepositoryFullNameKey } from "../github/repositoryIdentity";
import { pauseRepositoryForAccessRemoval } from "./accessLifecycle";
import {
  getRepositoryNameQuarantineFullName,
  readCanonicalRepositoryNameMatches,
} from "./nameIdentity";
import { readRepositoriesByUserAndGitHubRepositoryId } from "./immutableIdentity";
import {
  CLAIMED_EXECUTION_RECOVERY_GRACE_MS,
  CLAIMED_EXECUTION_RECOVERY_LEASE_MS,
  CLAIMED_EXECUTION_RECOVERY_TTL_MS,
  DISCONNECT_EXECUTION_RECONCILIATION_TTL_MS,
} from "../ticketActions/executionRecovery";

async function reactivateInstallationReconnect(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
  args: {
    installationId: number;
    githubRepositoryId: number;
    githubRepo: string;
    name: string;
    description?: string;
    githubUrl: string;
    language?: string;
    stars?: number;
  },
): Promise<Id<"repositories">> {
  if (
    repository.githubInstallationReconnectRequired !== true ||
    repository.githubRepositoryId !== args.githubRepositoryId ||
    repository.disconnectCleanupPending === true
  ) {
    throw new Error("invalid installation reconnect target");
  }

  await cancelIndexWatchdog(ctx, repository.indexWatchdogScheduleId);
  await scheduleRepositoryTreeSnapshotCleanup(
    ctx,
    repository.indexTreeSnapshotId,
  );

  const now = Date.now();
  const shouldReactivate = repository.isActiveBeforeAccessRevocation === true;
  const indexVersion = repository.indexVersion + 1;
  const watchdog = shouldReactivate
    ? await armIndexWatchdog(ctx, {
        repositoryId: repository._id,
        expectedIndexVersion: indexVersion,
        previousSequence: repository.indexWatchdogSequence,
      })
    : undefined;
  await ctx.db.patch(repository._id, {
    installationId: args.installationId,
    githubRepositoryId: args.githubRepositoryId,
    githubRepo: args.githubRepo,
    githubRepoKey: getCanonicalGitHubRepositoryFullNameKey(args.githubRepo),
    name: args.name,
    description: args.description,
    githubUrl: args.githubUrl,
    language: args.language,
    stars: args.stars,
    githubVisibility: undefined,
    licenseKey: undefined,
    licenseSpdxId: undefined,
    licenseOsiApproved: false,
    licenseOsiCheckedAt: undefined,
    repositoryMetadataCheckedAt: Math.max(
      now,
      (repository.repositoryMetadataCheckedAt ?? 0) + 1,
    ),
    isActive: shouldReactivate,
    githubAccessRevokedAt: undefined,
    isActiveBeforeAccessRevocation: undefined,
    githubInstallationReconnectRequired: undefined,
    githubAccessRestoreIndexPending: undefined,
    githubAccessRestoreIndexNextAttemptAt: undefined,
    githubAccessRestoreIndexRetryCount: undefined,
    githubAccessReconciliationEpoch: undefined,
    defaultBranch: undefined,
    indexVersion,
    indexStatus: shouldReactivate ? "pending" : "failed",
    indexError: shouldReactivate
      ? undefined
      : "Repository indexing was paused by its owner",
    lastIndexedAt: shouldReactivate ? undefined : repository.lastIndexedAt,
    ragStatus: shouldReactivate ? "pending" : "failed",
    ragError: shouldReactivate
      ? undefined
      : "Repository indexing was paused by its owner",
    ragLastIndexedAt: shouldReactivate
      ? undefined
      : repository.ragLastIndexedAt,
    ragTotalChunks: shouldReactivate ? 0 : repository.ragTotalChunks,
    ragIndexedChunks: shouldReactivate ? 0 : repository.ragIndexedChunks,
    ragFailedChunks: shouldReactivate ? 0 : repository.ragFailedChunks,
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
    indexWatchdogToken: watchdog?.token,
    indexWatchdogScheduleId: watchdog?.scheduleId,
    indexWatchdogSequence:
      watchdog?.sequence ?? repository.indexWatchdogSequence,
    indexWatchdogRetryCount: shouldReactivate ? 0 : undefined,
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
    repositoryId: repository._id,
    indexVersion,
    level: "info",
    message: `Repository reconnected: ${args.githubRepo}`,
    createdAt: now,
  });
  if (shouldReactivate) {
    await ctx.scheduler.runAfter(
      0,
      internal.repoIndexing.action.indexRepository,
      { repositoryId: repository._id, expectedIndexVersion: indexVersion },
    );
  }
  return repository._id;
}

export const create = internalMutation({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
    githubRepo: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    githubUrl: v.string(),
    language: v.optional(v.string()),
    stars: v.optional(v.number()),
    reconnectRepositoryId: v.optional(v.id("repositories")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }

    const installation = await getExactGitHubInstallation(
      ctx,
      args.installationId,
    );
    if (
      !isGitHubInstallationReady(installation) ||
      installation.userId !== userId ||
      installation.installationId !== args.installationId
    ) {
      throw new Error("unauthorized installation");
    }
    if (
      !Number.isSafeInteger(args.githubRepositoryId) ||
      args.githubRepositoryId <= 0
    ) {
      throw new Error("invalid GitHub repository id");
    }

    const reconnectRepository = args.reconnectRepositoryId
      ? await ctx.db.get(args.reconnectRepositoryId)
      : null;
    if (
      args.reconnectRepositoryId !== undefined &&
      (!reconnectRepository ||
        reconnectRepository.userId !== userId ||
        reconnectRepository.githubInstallationReconnectRequired !== true ||
        reconnectRepository.githubRepositoryId !== args.githubRepositoryId ||
        reconnectRepository.disconnectCleanupPending === true)
    ) {
      throw new Error("invalid repository reconnect target");
    }

    const [{ githubRepoKey, repositories: existingByName }, identityMatches] =
      await Promise.all([
        readCanonicalRepositoryNameMatches(ctx, {
          userId,
          githubRepo: args.githubRepo,
        }),
        readRepositoriesByUserAndGitHubRepositoryId(
          ctx,
          userId,
          args.githubRepositoryId,
        ),
      ]);

    if (reconnectRepository) {
      const hasNameConflict = existingByName.some(
        (repository) =>
          repository._id !== reconnectRepository._id &&
          repository.githubRepositoryId !== args.githubRepositoryId,
      );
      const hasIdentityConflict = identityMatches.some(
        (repository) => repository._id !== reconnectRepository._id,
      );
      if (hasNameConflict || hasIdentityConflict) {
        throw new Error("repository already connected");
      }
      return await reactivateInstallationReconnect(
        ctx,
        reconnectRepository,
        args,
      );
    }

    if (
      identityMatches.some(
        (repository) => repository.disconnectCleanupPending === true,
      )
    ) {
      throw new Error("repository disconnect cleanup is still in progress");
    }
    if (identityMatches.length > 0) {
      throw new Error("repository already connected");
    }
    if (
      existingByName.some(
        (repository) => repository.disconnectCleanupPending === true,
      )
    ) {
      throw new Error("repository disconnect cleanup is still in progress");
    }

    // A GitHub full name can be reused for a different immutable repository.
    // Quarantine the previous identity before publishing the new route.
    for (const repository of existingByName) {
      await pauseRepositoryForAccessRemoval(ctx, repository);
      const quarantinedRepo = getRepositoryNameQuarantineFullName(repository);
      await ctx.db.patch(repository._id, {
        githubRepo: quarantinedRepo,
        githubRepoKey: getCanonicalGitHubRepositoryFullNameKey(quarantinedRepo),
        githubUrl: `https://github.com/${quarantinedRepo}`,
        updatedAt: Date.now(),
      });
    }
    const now = Date.now();

    // Default settings - Issue Assistant enabled by default
    const defaultSettings = {
      issueAssistantEnabled: true,
      autoFormatIssue: true,
      autoAnswerQuestions: true,
      tagMaintainersForCodeChanges: true,
      requireApproval: true,
      discussionAssistantEnabled: true,
      autoFormatDiscussion: true,
      autoAnswerDiscussionQuestions: true,
      tagMaintainersForDiscussionCodeChanges: true,
      requireApprovalForDiscussions: true,
    };

    const repoId = await ctx.db.insert("repositories", {
      userId,
      installationId: args.installationId,
      githubRepositoryId: args.githubRepositoryId,
      githubRepo: args.githubRepo,
      githubRepoKey,
      name: args.name,
      description: args.description,
      githubUrl: args.githubUrl,
      language: args.language,
      stars: args.stars,
      isActive: true,
      // Initialize indexing status
      indexStatus: "pending",
      indexVersion: 0,
      ragStatus: "pending",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      indexProgressAt: now,
      indexSyncPending: false,
      settings: defaultSettings,
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: repoId,
      expectedIndexVersion: 0,
    });
    await ctx.db.patch(repoId, {
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexWatchdogRetryCount: 0,
    });

    await ctx.db.insert("repoIndexingLogs", {
      repositoryId: repoId,
      indexVersion: 0,
      level: "info",
      message: `Repository connected: ${args.githubRepo}`,
      createdAt: now,
    });
    await ctx.db.insert("repoIndexingLogs", {
      repositoryId: repoId,
      indexVersion: 0,
      level: "info",
      message: "Preparing to index repository structure",
      createdAt: now,
    });
    await ctx.db.insert("repoIndexingLogs", {
      repositoryId: repoId,
      indexVersion: 0,
      level: "info",
      message: "Indexing job scheduled, starting soon...",
      createdAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.repoIndexing.action.indexRepository,
      { repositoryId: repoId, expectedIndexVersion: 0 },
    );

    return repoId;
  },
});

export const updateSettings = mutation({
  args: {
    repositoryId: v.id("repositories"),
    settings: v.object({
      issueAssistantEnabled: v.boolean(),
      autoFormatIssue: v.boolean(),
      autoAnswerQuestions: v.boolean(),
      tagMaintainersForCodeChanges: v.boolean(),
      issueResponseStyle: v.optional(v.string()),
      requireApproval: v.boolean(),
      discussionAssistantEnabled: v.boolean(),
      autoFormatDiscussion: v.boolean(),
      autoAnswerDiscussionQuestions: v.boolean(),
      tagMaintainersForDiscussionCodeChanges: v.boolean(),
      discussionResponseStyle: v.optional(v.string()),
      requireApprovalForDiscussions: v.boolean(),
      pullRequestReviewsEnabled: v.optional(v.boolean()),
      pullRequestSuggestionsEnabled: v.optional(v.boolean()),
      requireApprovalForPullRequests: v.optional(v.boolean()),
    }),
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
    if (repo.disconnectCleanupPending === true) {
      throw new Error("repository disconnect cleanup is still in progress");
    }

    await ctx.db.patch(args.repositoryId, {
      settings: { ...repo.settings, ...args.settings },
      updatedAt: Date.now(),
    });

    return args.repositoryId;
  },
});

export const toggleActive = mutation({
  args: {
    repositoryId: v.id("repositories"),
    isActive: v.optional(v.boolean()),
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
    if (repo.disconnectCleanupPending === true) {
      throw new Error("repository disconnect cleanup is still in progress");
    }

    if (repo.githubAccessRevokedAt !== undefined) {
      throw new Error("GitHub App repository access has been removed");
    }

    const nextIsActive = args.isActive ?? !repo.isActive;
    if (nextIsActive === repo.isActive) return args.repositoryId;
    if (nextIsActive) {
      const installation = await getExactGitHubInstallation(
        ctx,
        repo.installationId,
      );
      if (
        !isGitHubInstallationReady(installation) ||
        installation.userId !== userId ||
        installation.installationId !== repo.installationId
      ) {
        throw new Error("GitHub App installation is not ready");
      }
    }
    if (!nextIsActive) {
      await cancelIndexWatchdog(ctx, repo.indexWatchdogScheduleId);
      await scheduleRepositoryTreeSnapshotCleanup(
        ctx,
        repo.indexTreeSnapshotId,
      );
    }
    const now = Date.now();
    const activationVersion = repo.indexVersion;
    const activationWatchdog = nextIsActive
      ? await armIndexWatchdog(ctx, {
          repositoryId: args.repositoryId,
          expectedIndexVersion: activationVersion,
          previousScheduleId: repo.indexWatchdogScheduleId,
          previousSequence: repo.indexWatchdogSequence,
        })
      : undefined;
    await ctx.db.patch(args.repositoryId, {
      isActive: nextIsActive,
      githubAccessRestoreIndexPending: nextIsActive
        ? repo.githubAccessRestoreIndexPending
        : undefined,
      githubAccessRestoreIndexNextAttemptAt: nextIsActive
        ? repo.githubAccessRestoreIndexNextAttemptAt
        : undefined,
      githubAccessRestoreIndexRetryCount: nextIsActive
        ? repo.githubAccessRestoreIndexRetryCount
        : undefined,
      ...(nextIsActive
        ? {
            indexStatus: "pending" as const,
            indexError: undefined,
            ragStatus: "pending" as const,
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
            indexWatchdogToken: activationWatchdog!.token,
            indexWatchdogScheduleId: activationWatchdog!.scheduleId,
            indexWatchdogSequence: activationWatchdog!.sequence,
            indexWatchdogRetryCount: 0,
            indexTreeSnapshotId: undefined,
            indexRateLimitRetryToken: undefined,
            indexRateLimitRetryAt: undefined,
            indexIdentityVerifiedVersion: undefined,
            indexIdentityVerifiedInstallationId: undefined,
            indexIdentityVerifiedGithubRepositoryId: undefined,
            indexIdentityVerifiedGithubRepo: undefined,
            indexProgressAt: now,
          }
        : {}),
      ...(!nextIsActive
        ? {
            indexVersion: repo.indexVersion + 1,
            indexStatus: "failed" as const,
            indexError: "Repository indexing was paused by its owner",
            ragStatus: "failed" as const,
            ragError: "Repository indexing was paused by its owner",
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
            indexProgressAt: now,
          }
        : {}),
      updatedAt: now,
    });

    if (nextIsActive) {
      await ctx.scheduler.runAfter(
        0,
        internal.repoIndexing.action.indexRepository,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: activationVersion,
        },
      );
    }

    return args.repositoryId;
  },
});

const DISCONNECT_CLEANUP_BATCH_SIZE = 50;
const DISCONNECT_CLEANUP_STALE_MS = 5 * 60 * 1_000;

type DisconnectCleanupPhase =
  | "tree"
  | "chunks"
  | "file_maps"
  | "logs"
  | "learnings"
  | "embedding_batches"
  | "members"
  | "invitations"
  | "api_keys"
  | "tickets"
  | "history"
  | "notifications"
  | "finalize";

async function scheduleDisconnectCleanup(
  ctx: Pick<MutationCtx, "scheduler">,
  repositoryId: Id<"repositories">,
  delayMs = 0,
) {
  await ctx.scheduler.runAfter(
    Math.max(0, delayMs),
    internal.repositories.mutation.continueRepositoryDisconnectCleanup,
    { repositoryId },
  );
}

async function advanceDisconnectCleanup(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
  phase: DisconnectCleanupPhase,
) {
  await ctx.db.patch(repositoryId, {
    disconnectCleanupPhase: phase,
    updatedAt: Date.now(),
  });
  await scheduleDisconnectCleanup(ctx, repositoryId);
}

async function beginRepositoryDisconnectCleanup(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
  reason: string,
): Promise<boolean> {
  if (repository.disconnectCleanupPending === true) {
    return false;
  }

  await cancelIndexWatchdog(ctx, repository.indexWatchdogScheduleId);
  await scheduleRepositoryTreeSnapshotCleanup(
    ctx,
    repository.indexTreeSnapshotId,
  );

  const now = Date.now();
  await ctx.db.patch(repository._id, {
    isActive: false,
    indexVersion: repository.indexVersion + 1,
    indexStatus: "failed",
    indexError: reason,
    ragStatus: "failed",
    ragError: reason,
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
    indexRateLimitRetryToken: undefined,
    indexRateLimitRetryAt: undefined,
    indexIdentityVerifiedVersion: undefined,
    indexIdentityVerifiedInstallationId: undefined,
    indexIdentityVerifiedGithubRepositoryId: undefined,
    indexIdentityVerifiedGithubRepo: undefined,
    githubAccessRestoreIndexPending: undefined,
    githubAccessRestoreIndexNextAttemptAt: undefined,
    githubAccessRestoreIndexRetryCount: undefined,
    githubInstallationReconnectRequired: undefined,
    disconnectCleanupPending: true,
    disconnectCleanupPhase: "tree",
    indexProgressAt: now,
    updatedAt: now,
  });
  await scheduleDisconnectCleanup(ctx, repository._id);
  return true;
}

/** Start a fail-closed, durable cleanup and return immediately to the UI. */
export const remove = mutation({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("not authenticated");
    }
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository) {
      throw new Error("repository not found");
    }
    if (repository.userId !== userId) {
      throw new Error("unauthorized");
    }
    await beginRepositoryDisconnectCleanup(
      ctx,
      repository,
      "Repository was disconnected by its owner",
    );
    return args.repositoryId;
  },
});

/** Execute at most one bounded disconnect cleanup page. */
export const continueRepositoryDisconnectCleanup = internalMutation({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.disconnectCleanupPending !== true) {
      return { completed: repository === null, processed: 0 };
    }
    const phase = repository.disconnectCleanupPhase ?? "tree";

    if (phase === "tree") {
      const snapshotId = repository.indexTreeSnapshotId;
      if (snapshotId) {
        const snapshot = await ctx.db.get(snapshotId);
        if (snapshot) {
          await scheduleRepositoryTreeSnapshotCleanup(ctx, snapshotId);
          await ctx.db.patch(args.repositoryId, { updatedAt: Date.now() });
          await scheduleDisconnectCleanup(ctx, args.repositoryId, 1_000);
          return { completed: false, processed: 0 };
        }
        await ctx.db.patch(args.repositoryId, {
          indexTreeSnapshotId: undefined,
        });
      }
      await advanceDisconnectCleanup(ctx, args.repositoryId, "chunks");
      return { completed: false, processed: 0 };
    }

    if (phase === "chunks") {
      const documents = await ctx.db
        .query("repoChunks")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .take(DISCONNECT_CLEANUP_BATCH_SIZE);
      for (const document of documents) await ctx.db.delete(document._id);
      if (documents.length === DISCONNECT_CLEANUP_BATCH_SIZE) {
        await ctx.db.patch(args.repositoryId, { updatedAt: Date.now() });
        await scheduleDisconnectCleanup(ctx, args.repositoryId);
      } else {
        await advanceDisconnectCleanup(ctx, args.repositoryId, "file_maps");
      }
      return { completed: false, processed: documents.length };
    }

    if (phase === "file_maps") {
      const documents = await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .take(DISCONNECT_CLEANUP_BATCH_SIZE);
      for (const document of documents) await ctx.db.delete(document._id);
      // Blobs are shared across repositories and map publication is a later
      // transaction than blob reuse. The weekly stale-blob cleanup owns
      // deletion after its grace period and rechecks references atomically.
      if (documents.length === DISCONNECT_CLEANUP_BATCH_SIZE) {
        await ctx.db.patch(args.repositoryId, { updatedAt: Date.now() });
        await scheduleDisconnectCleanup(ctx, args.repositoryId);
      } else {
        await advanceDisconnectCleanup(ctx, args.repositoryId, "logs");
      }
      return { completed: false, processed: documents.length };
    }

    const deleteRepositoryPage = async (
      table:
        | "repoIndexingLogs"
        | "repoLearnings"
        | "ragEmbeddingBatches"
        | "repositoryMembers"
        | "projectApiKeys"
        | "invitations",
      nextPhase: DisconnectCleanupPhase,
    ) => {
      const documents = await ctx.db
        .query(table)
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .take(DISCONNECT_CLEANUP_BATCH_SIZE);
      for (const document of documents) await ctx.db.delete(document._id);
      if (documents.length === DISCONNECT_CLEANUP_BATCH_SIZE) {
        await ctx.db.patch(args.repositoryId, { updatedAt: Date.now() });
        await scheduleDisconnectCleanup(ctx, args.repositoryId);
      } else {
        await advanceDisconnectCleanup(ctx, args.repositoryId, nextPhase);
      }
      return { completed: false, processed: documents.length };
    };

    if (phase === "logs") {
      return await deleteRepositoryPage("repoIndexingLogs", "learnings");
    }
    if (phase === "learnings") {
      return await deleteRepositoryPage("repoLearnings", "embedding_batches");
    }
    if (phase === "embedding_batches") {
      return await deleteRepositoryPage("ragEmbeddingBatches", "members");
    }
    if (phase === "members") {
      return await deleteRepositoryPage("repositoryMembers", "invitations");
    }
    if (phase === "invitations") {
      return await deleteRepositoryPage("invitations", "api_keys");
    }
    if (phase === "api_keys") {
      return await deleteRepositoryPage("projectApiKeys", "tickets");
    }

    if (phase === "tickets") {
      const ticket = await ctx.db
        .query("tickets")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first();
      if (!ticket) {
        await advanceDisconnectCleanup(ctx, args.repositoryId, "history");
        return { completed: false, processed: 0 };
      }
      const approvedActions = await ctx.db
        .query("ticketActions")
        .withIndex("by_ticket_and_status", (q) =>
          q.eq("ticketId", ticket._id).eq("status", "approved"),
        )
        .take(DISCONNECT_CLEANUP_BATCH_SIZE);
      const claimedActions = approvedActions.filter(
        (action) =>
          action.executionClaimedAt !== undefined &&
          action.executionResult === undefined &&
          action.executionIdempotencyKey !== undefined,
      );
      if (claimedActions.length > 0) {
        const now = Date.now();
        for (const action of claimedActions) {
          let trackedState: "pending" | "inProgress" | undefined;
          if (action.executionRecoveryScheduleId) {
            const tracked = await ctx.db.system.get(
              action.executionRecoveryScheduleId,
            );
            trackedState =
              tracked?.state.kind === "pending" ||
              tracked?.state.kind === "inProgress"
                ? tracked.state.kind
                : undefined;
          }
          if (
            action.executionRecoveryReconcileOnly &&
            (action.executionRecoveryReconcileDeadlineAt ?? 0) <= now
          ) {
            if (
              action.executionRecoveryScheduleId &&
              trackedState === "pending"
            ) {
              await ctx.scheduler.cancel(action.executionRecoveryScheduleId);
            }
            await ctx.db.patch(action._id, {
              status: "failed",
              errorMessage:
                "Repository disconnect completed before the external GitHub outcome could be verified",
              completedAt: now,
              executionIdempotencyKey: undefined,
              executionRecoveryMode: undefined,
              executionRecoveryReconcileOnly: undefined,
              executionRecoveryReconcileDeadlineAt: undefined,
              executionRecoveryExpiresAt: undefined,
              executionRecoveryLeaseUntil: undefined,
              executionRecoveryScheduleId: undefined,
            });
            continue;
          }
          if (action.executionRecoveryReconcileOnly && trackedState) {
            continue;
          }
          if (
            action.executionRecoveryScheduleId &&
            trackedState === "pending"
          ) {
            await ctx.scheduler.cancel(action.executionRecoveryScheduleId);
          } else if (trackedState === "inProgress") {
            await ctx.db.patch(action._id, {
              executionRecoveryReconcileOnly: true,
              executionRecoveryReconcileDeadlineAt:
                action.executionRecoveryReconcileDeadlineAt ??
                now + DISCONNECT_EXECUTION_RECONCILIATION_TTL_MS,
              executionRecoveryExpiresAt:
                now + CLAIMED_EXECUTION_RECOVERY_TTL_MS,
              executionRecoveryLeaseUntil:
                now + CLAIMED_EXECUTION_RECOVERY_LEASE_MS,
            });
            continue;
          }
          const scheduleId = await ctx.scheduler.runAfter(
            CLAIMED_EXECUTION_RECOVERY_GRACE_MS,
            internal.ticketActions.internalAction.reconcileClaimedExecution,
            {
              actionId: action._id,
              expectedClaimedAt: action.executionClaimedAt!,
              expectedProposalVersion: action.proposalVersion,
              retryAttempt: 0,
            },
          );
          await ctx.db.patch(action._id, {
            executionRecoveryReconcileOnly: true,
            executionRecoveryReconcileDeadlineAt:
              action.executionRecoveryReconcileDeadlineAt ??
              now + DISCONNECT_EXECUTION_RECONCILIATION_TTL_MS,
            executionRecoveryExpiresAt: now + CLAIMED_EXECUTION_RECOVERY_TTL_MS,
            executionRecoveryLeaseUntil:
              now + CLAIMED_EXECUTION_RECOVERY_LEASE_MS,
            executionRecoveryScheduleId: scheduleId,
          });
        }
        await ctx.db.patch(args.repositoryId, { updatedAt: now });
        await scheduleDisconnectCleanup(ctx, args.repositoryId, 60_000);
        return { completed: false, processed: claimedActions.length };
      }
      for (const status of [
        "pending",
        "pending_approval",
        "approved",
      ] as const) {
        const actions = await ctx.db
          .query("ticketActions")
          .withIndex("by_ticket_and_status", (q) =>
            q.eq("ticketId", ticket._id).eq("status", status),
          )
          .take(DISCONNECT_CLEANUP_BATCH_SIZE);
        if (actions.length === 0) {
          continue;
        }
        for (const action of actions) {
          for (const scheduleId of [
            action.resultRecoveryScheduleId,
            action.pendingGenerationScheduleId,
            action.autoExecutionRecoveryScheduleId,
            action.executionRecoveryScheduleId,
          ]) {
            if (!scheduleId) continue;
            const scheduled = await ctx.db.system.get(scheduleId);
            if (scheduled?.state.kind === "pending") {
              await ctx.scheduler.cancel(scheduleId);
            }
          }
          await ctx.db.patch(action._id, {
            status: "failed",
            errorMessage: "Repository was disconnected by its owner",
            completedAt: Date.now(),
            reviewBatch: undefined,
            reviewQuotaUserId: undefined,
            reviewQuotaHold: undefined,
            resultCheckpointKey: undefined,
            resultCheckpointExpiresAt: undefined,
            resultRecoveryLeaseUntil: undefined,
            resultRecoveryScheduleId: undefined,
            pendingGenerationTarget: undefined,
            pendingGenerationExpiresAt: undefined,
            pendingGenerationScheduleId: undefined,
            pendingGenerationLeaseUntil: undefined,
            providerRetryStartedAt: undefined,
            autoExecutionRecoveryExpiresAt: undefined,
            autoExecutionRecoveryLeaseUntil: undefined,
            autoExecutionRecoveryScheduleId: undefined,
            executionIdempotencyKey: undefined,
            executionRecoveryMode: undefined,
            executionRecoveryReconcileOnly: undefined,
            executionRecoveryReconcileDeadlineAt: undefined,
            executionRecoveryExpiresAt: undefined,
            executionRecoveryLeaseUntil: undefined,
            executionRecoveryScheduleId: undefined,
          });
        }
        await ctx.db.patch(args.repositoryId, { updatedAt: Date.now() });
        await scheduleDisconnectCleanup(ctx, args.repositoryId);
        return { completed: false, processed: actions.length };
      }
      await ctx.db.patch(ticket._id, { repositoryId: undefined });
      await ctx.db.patch(args.repositoryId, { updatedAt: Date.now() });
      await scheduleDisconnectCleanup(ctx, args.repositoryId);
      return { completed: false, processed: 1 };
    }

    if (phase === "history") {
      const usage = await ctx.db
        .query("tokenUsage")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .take(DISCONNECT_CLEANUP_BATCH_SIZE);
      for (const row of usage) {
        await detachUsageRepositoryInPeriodTotals(ctx, row);
        await ctx.db.patch(row._id, { repositoryId: undefined });
      }
      if (usage.length === DISCONNECT_CLEANUP_BATCH_SIZE) {
        await ctx.db.patch(args.repositoryId, { updatedAt: Date.now() });
        await scheduleDisconnectCleanup(ctx, args.repositoryId);
        return { completed: false, processed: usage.length };
      }
      const logs = await ctx.db
        .query("aiLogs")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .take(DISCONNECT_CLEANUP_BATCH_SIZE);
      for (const row of logs) {
        await ctx.db.patch(row._id, { repositoryId: undefined });
      }
      if (logs.length === DISCONNECT_CLEANUP_BATCH_SIZE) {
        await ctx.db.patch(args.repositoryId, { updatedAt: Date.now() });
        await scheduleDisconnectCleanup(ctx, args.repositoryId);
      } else {
        await advanceDisconnectCleanup(ctx, args.repositoryId, "notifications");
      }
      return { completed: false, processed: usage.length + logs.length };
    }

    if (phase === "notifications") {
      const notifications = await ctx.db
        .query("notifications")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .take(DISCONNECT_CLEANUP_BATCH_SIZE);
      for (const notification of notifications) {
        await ctx.db.patch(notification._id, {
          repositoryId: undefined,
          invitationId: undefined,
        });
      }
      if (notifications.length === DISCONNECT_CLEANUP_BATCH_SIZE) {
        await ctx.db.patch(args.repositoryId, { updatedAt: Date.now() });
        await scheduleDisconnectCleanup(ctx, args.repositoryId);
      } else {
        await advanceDisconnectCleanup(ctx, args.repositoryId, "finalize");
      }
      return { completed: false, processed: notifications.length };
    }

    // Re-check every durable child category before deleting the workflow row.
    const detachedSnapshot = await ctx.db
      .query("repoTreeSnapshots")
      .withIndex("by_repository_and_version", (q) =>
        q.eq("repositoryId", args.repositoryId),
      )
      .first();
    if (detachedSnapshot) {
      await ctx.db.patch(args.repositoryId, {
        indexTreeSnapshotId: detachedSnapshot._id,
        disconnectCleanupPhase: "tree",
        updatedAt: Date.now(),
      });
      await scheduleRepositoryTreeSnapshotCleanup(ctx, detachedSnapshot._id);
      await scheduleDisconnectCleanup(ctx, args.repositoryId, 1_000);
      return { completed: false, processed: 0 };
    }

    const remaining = await Promise.all([
      ctx.db
        .query("repoChunks")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
      ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
      ctx.db
        .query("repoIndexingLogs")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
      ctx.db
        .query("repoLearnings")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
      ctx.db
        .query("ragEmbeddingBatches")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
      ctx.db
        .query("repositoryMembers")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
      ctx.db
        .query("invitations")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
      ctx.db
        .query("tickets")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
      ctx.db
        .query("tokenUsage")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
      ctx.db
        .query("aiLogs")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
      ctx.db
        .query("notifications")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", args.repositoryId),
        )
        .first(),
    ]);
    const restartPhases: Array<DisconnectCleanupPhase> = [
      "chunks",
      "file_maps",
      "logs",
      "learnings",
      "embedding_batches",
      "members",
      "invitations",
      "tickets",
      "history",
      "history",
      "notifications",
    ];
    const remainingIndex = remaining.findIndex((value) => value !== null);
    if (remainingIndex >= 0) {
      await advanceDisconnectCleanup(
        ctx,
        args.repositoryId,
        restartPhases[remainingIndex],
      );
      return { completed: false, processed: 0 };
    }

    const remainingKey = await ctx.db
      .query("projectApiKeys")
      .withIndex("by_repository", (q) =>
        q.eq("repositoryId", args.repositoryId),
      )
      .first();
    if (remainingKey) {
      await advanceDisconnectCleanup(ctx, args.repositoryId, "api_keys");
      return { completed: false, processed: 0 };
    }
    // embeddingUsageReservations deliberately retain the immutable repository
    // ID after disconnect. Pending/ambiguous provider attempts must remain
    // reconcilable for billing; they never grant repository access.
    await ctx.db.delete(args.repositoryId);
    return { completed: true, processed: 1 };
  },
});

/** Re-enqueue disconnect workflows whose scheduled cleanup disappeared. */
export const recoverStalledDisconnectCleanups = internalMutation({
  args: {},
  handler: async (ctx) => {
    const repositories = await ctx.db
      .query("repositories")
      .withIndex("by_disconnect_cleanup_pending_and_updated_at", (q) =>
        q
          .eq("disconnectCleanupPending", true)
          .lt("updatedAt", Date.now() - DISCONNECT_CLEANUP_STALE_MS),
      )
      .take(25);
    const now = Date.now();
    for (const repository of repositories) {
      await ctx.db.patch(repository._id, { updatedAt: now });
      await scheduleDisconnectCleanup(ctx, repository._id);
    }
    return repositories.length;
  },
});
