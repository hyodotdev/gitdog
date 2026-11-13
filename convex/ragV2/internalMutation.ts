import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  armIndexWatchdog,
  cancelIndexWatchdog,
} from "../repoIndexing/watchdog";
import {
  INDEXING_STALE_THRESHOLD_MS,
  matchesCurrentIndexSource,
} from "../repoIndexing/readiness";
import { scheduleRepositoryTreeSnapshotCleanup } from "../repoIndexing/treeSnapshot";
import {
  assertRagChunkBatchWithinBudget,
  assertRagChunkStorageBounds,
  MAX_RAG_EMBEDDING_CACHE_BATCHES_PER_REPOSITORY,
  RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS,
  RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE,
  RAG_EMBEDDING_RESERVATION_MAX_WAITS,
} from "./chunkBudget";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import { quarantineRepositoryForMissingInstallation } from "../repositories/accessLifecycle";
import { satisfiesCurrentLegalAttestationRequirement } from "../users/legal";
import { deleteChunksForPath } from "./chunkPaths";

interface RagChunkInput {
  chunkId: string;
  path: string;
  language: string;
  code: string;
  retrievalText?: string;
  startLine: number;
  endLine: number;
  symbols: Array<string>;
  imports?: Array<string>;
  exports?: Array<string>;
  signature?: string;
  docstring?: string;
  contentHash: string;
  searchableText: string;
  embedding?: Array<number>;
  embeddingKey?: string;
  embeddingInputMode?: "raw_v1" | "deidentified_v1";
}

type RagContinuationClaim = {
  totalChunks: number;
  successCount: number;
  errorCount: number;
  processedFiles: number;
};

type RagEmbeddingPublicationExpectation = {
  userId: Id<"users">;
  installationId: number;
  githubRepositoryId: number;
  githubRepo: string;
  githubVisibility?: "public" | "private" | "internal";
  licenseKey?: string;
  licenseSpdxId?: string;
  licenseOsiApproved?: boolean;
  repositoryMetadataCheckedAt?: number;
  licenseOsiCheckedAt?: number;
  embeddingBillingTier: "free" | "paid";
  embeddingKey: string;
  phase: "files" | "cleanup";
  cursor?: string;
  fileOffset: number;
  chunkOffset: number;
};

async function hasReadyRepositoryInstallation(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
): Promise<boolean> {
  const installation = await getExactGitHubInstallation(
    ctx,
    repository.installationId,
  );
  return (
    isGitHubInstallationReady(installation) &&
    installation.userId === repository.userId
  );
}

async function repositoryOwnerHasCurrentLegalAttestation(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return satisfiesCurrentLegalAttestationRequirement(profile);
}

const ragIndexPhaseValidator = v.union(
  v.literal("files"),
  v.literal("cleanup"),
);

const ragEmbeddingModeValidator = v.union(
  v.literal("openai"),
  v.literal("keyword_only"),
);

const ragEmbeddingBillingTierValidator = v.union(
  v.literal("free"),
  v.literal("paid"),
);

const embeddingInputModeValidator = v.union(
  v.literal("raw_v1"),
  v.literal("deidentified_v1"),
);

export type LegalEligibilityBlockOutcome =
  "blocked" | "legal_current" | "stale";

function getEmbeddingInputModeForBillingTier(
  billingTier: "free" | "paid" | undefined,
): "raw_v1" | "deidentified_v1" | undefined {
  return billingTier === "free"
    ? "deidentified_v1"
    : billingTier === "paid"
      ? "raw_v1"
      : undefined;
}

const RAG_TRANSIENT_RETRY_MAX_DELAY_MS = 5 * 60_000;
const RAG_TRANSIENT_RETRY_MAX_ATTEMPT = 32;

const ragEmbeddingPublicationExpectationValidator = v.object({
  userId: v.id("users"),
  installationId: v.number(),
  githubRepositoryId: v.number(),
  githubRepo: v.string(),
  githubVisibility: v.optional(
    v.union(v.literal("public"), v.literal("private"), v.literal("internal")),
  ),
  licenseKey: v.optional(v.string()),
  licenseSpdxId: v.optional(v.string()),
  licenseOsiApproved: v.optional(v.boolean()),
  repositoryMetadataCheckedAt: v.optional(v.number()),
  licenseOsiCheckedAt: v.optional(v.number()),
  embeddingBillingTier: ragEmbeddingBillingTierValidator,
  embeddingKey: v.string(),
  phase: ragIndexPhaseValidator,
  cursor: v.optional(v.string()),
  fileOffset: v.number(),
  chunkOffset: v.number(),
});

const ragChunkValidator = v.object({
  chunkId: v.string(),
  path: v.string(),
  language: v.string(),
  code: v.string(),
  retrievalText: v.optional(v.string()),
  startLine: v.number(),
  endLine: v.number(),
  symbols: v.array(v.string()),
  imports: v.optional(v.array(v.string())),
  exports: v.optional(v.array(v.string())),
  signature: v.optional(v.string()),
  docstring: v.optional(v.string()),
  contentHash: v.string(),
  searchableText: v.string(),
  embedding: v.optional(v.array(v.number())),
  embeddingKey: v.optional(v.string()),
  embeddingInputMode: v.optional(
    v.union(v.literal("raw_v1"), v.literal("deidentified_v1")),
  ),
});

function ownsActiveRepositoryLifecycle(
  repository: Doc<"repositories">,
): boolean {
  return (
    repository.isActive === true &&
    repository.githubAccessRevokedAt === undefined &&
    repository.disconnectCleanupPending !== true
  );
}

function ownsExpectedRagEmbeddingWork(
  repository: Doc<"repositories">,
  indexVersion: number,
  publication: RagEmbeddingPublicationExpectation,
): boolean {
  return (
    ownsActiveRepositoryLifecycle(repository) &&
    repository.indexVersion === indexVersion &&
    repository.indexStatus === "completed" &&
    repository.ragStatus === "indexing" &&
    repository.ragEmbeddingMode === "openai" &&
    repository.ragEmbeddingBillingTier === publication.embeddingBillingTier &&
    repository.ragEmbeddingKey === publication.embeddingKey &&
    repository.ragIndexPhase === publication.phase &&
    repository.ragIndexCursor === publication.cursor &&
    (repository.ragIndexFileOffset ?? 0) === publication.fileOffset &&
    (repository.ragIndexChunkOffset ?? 0) === publication.chunkOffset &&
    repository.ragContinuationToken === undefined
  );
}

async function matchesRagEmbeddingPublicationPolicy(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
  publication: RagEmbeddingPublicationExpectation,
): Promise<boolean> {
  const installation = await getExactGitHubInstallation(
    ctx,
    publication.installationId,
  );

  return (
    repository.userId === publication.userId &&
    repository.installationId === publication.installationId &&
    repository.githubRepositoryId === publication.githubRepositoryId &&
    repository.githubRepo === publication.githubRepo &&
    repository.githubVisibility === publication.githubVisibility &&
    repository.licenseKey === publication.licenseKey &&
    repository.licenseSpdxId === publication.licenseSpdxId &&
    repository.licenseOsiApproved === publication.licenseOsiApproved &&
    repository.repositoryMetadataCheckedAt ===
      publication.repositoryMetadataCheckedAt &&
    repository.licenseOsiCheckedAt === publication.licenseOsiCheckedAt &&
    isGitHubInstallationReady(installation) &&
    installation.userId === publication.userId
  );
}

async function restartRagAfterEmbeddingPolicyChange(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
  indexVersion: number,
): Promise<boolean> {
  if (
    !ownsActiveRepositoryLifecycle(repository) ||
    repository.indexVersion !== indexVersion ||
    repository.indexStatus !== "completed" ||
    repository.ragStatus !== "indexing"
  ) {
    return false;
  }

  const now = Date.now();
  await ctx.db.patch(repository._id, {
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
    indexProgressAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(
    0,
    internal.ragV2.action.generateChunkEmbeddings,
    { repositoryId: repository._id, indexVersion },
  );
  return true;
}

/** Atomically claim one pending RAG generation. */
export const claimRagGeneration = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    embeddingMode: v.optional(ragEmbeddingModeValidator),
    embeddingBillingTier: v.optional(ragEmbeddingBillingTierValidator),
    embeddingKey: v.optional(v.string()),
    embeddingError: v.optional(v.string()),
    legalEligibilityBlocked: v.optional(v.literal(true)),
  },
  returns: v.union(v.boolean(), v.literal("legal_current")),
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo ||
      !ownsActiveRepositoryLifecycle(repo) ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "completed" ||
      repo.ragStatus !== "pending"
    ) {
      return false;
    }
    if (!(await hasReadyRepositoryInstallation(ctx, repo))) {
      await quarantineRepositoryForMissingInstallation(ctx, repo);
      return false;
    }

    if (
      args.legalEligibilityBlocked === true &&
      (await repositoryOwnerHasCurrentLegalAttestation(ctx, repo.userId))
    ) {
      return "legal_current" as const;
    }

    const now = Date.now();
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      ragStatus: "indexing",
      ragError: undefined,
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      ragEmbeddingMode: args.embeddingMode,
      ragEmbeddingBillingTier:
        args.embeddingMode === "openai" ? args.embeddingBillingTier : undefined,
      ragEmbeddingKey:
        args.embeddingMode === "keyword_only" ? undefined : args.embeddingKey,
      ragEmbeddingError: args.embeddingError,
      ragLegalEligibilityBlockedAt:
        args.legalEligibilityBlocked === true ? now : undefined,
      ragLegalEligibilityBlockedIndexVersion:
        args.legalEligibilityBlocked === true
          ? args.expectedIndexVersion
          : undefined,
      ragIndexPhase: "files",
      ragIndexCursor: undefined,
      ragIndexFileOffset: 0,
      ragIndexChunkOffset: 0,
      ragContinuationToken: undefined,
      ragProcessedFiles: 0,
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    // The search index pass runs after the visible cleanup log, so record
    // its start in the indexing log to keep the sync screen moving.
    await ctx.db.insert("repoIndexingLogs", {
      repositoryId: args.repositoryId,
      indexVersion: args.expectedIndexVersion,
      level: "info",
      message: "Building search index",
      createdAt: now,
    });
    return true;
  },
});

function sanitizeEmbeddingError(error: string): string {
  const redacted = error
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(
      /((?:api[-_ ]?key|authorization|token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return (redacted || "Embedding unavailable").slice(0, 500);
}

export type LegalEligibilityResumeOutcome = "scheduled" | "cleared" | "stale";

/** Reset one exact marked generation so it can rebuild from cached files. */
export async function resumeRagAfterLegalEligibilityAttestation(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
): Promise<LegalEligibilityResumeOutcome> {
  const markerMatchesCurrentGeneration =
    repository.ragLegalEligibilityBlockedAt !== undefined &&
    repository.ragLegalEligibilityBlockedIndexVersion ===
      repository.indexVersion;
  if (!markerMatchesCurrentGeneration) {
    if (
      repository.ragLegalEligibilityBlockedAt !== undefined ||
      repository.ragLegalEligibilityBlockedIndexVersion !== undefined
    ) {
      await ctx.db.patch(repository._id, {
        ragLegalEligibilityBlockedAt: undefined,
        ragLegalEligibilityBlockedIndexVersion: undefined,
      });
      return "cleared";
    }
    return "stale";
  }

  if (
    !(await repositoryOwnerHasCurrentLegalAttestation(ctx, repository.userId))
  ) {
    return "stale";
  }

  const isResumableState =
    repository.ragEmbeddingMode === "keyword_only" &&
    (repository.ragStatus === "indexing" ||
      repository.ragStatus === "completed" ||
      repository.ragStatus === "failed");
  const hasCurrentLifecycle =
    ownsActiveRepositoryLifecycle(repository) &&
    repository.githubInstallationReconnectRequired !== true &&
    repository.githubAccessRestoreIndexPending !== true &&
    repository.githubAccessRestoreIndexNextAttemptAt === undefined &&
    !repository.indexSyncPending &&
    repository.indexStatus === "completed" &&
    isResumableState &&
    (await hasReadyRepositoryInstallation(ctx, repository));
  if (!hasCurrentLifecycle) {
    await ctx.db.patch(repository._id, {
      ragLegalEligibilityBlockedAt: undefined,
      ragLegalEligibilityBlockedIndexVersion: undefined,
    });
    return "cleared";
  }

  const indexVersion = repository.indexVersion;
  const now = Date.now();
  await cancelIndexWatchdog(ctx, repository.indexWatchdogScheduleId);
  await ctx.db.patch(repository._id, {
    ragStatus: "pending",
    ragError: undefined,
    ragTotalChunks: 0,
    ragIndexedChunks: 0,
    ragFailedChunks: 0,
    ragEmbeddingMode: undefined,
    ragEmbeddingBillingTier: undefined,
    ragEmbeddingKey: undefined,
    ragEmbeddingError: undefined,
    ragLegalEligibilityBlockedAt: undefined,
    ragLegalEligibilityBlockedIndexVersion: undefined,
    ragIndexPhase: undefined,
    ragIndexCursor: undefined,
    ragIndexFileOffset: undefined,
    ragIndexChunkOffset: undefined,
    ragContinuationToken: undefined,
    ragProcessedFiles: undefined,
    indexWatchdogToken: undefined,
    indexWatchdogScheduleId: undefined,
    indexWatchdogRetryCount: undefined,
    indexProgressAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(
    0,
    internal.ragV2.action.generateChunkEmbeddings,
    { repositoryId: repository._id, indexVersion },
  );
  return "scheduled";
}

/** Atomically degrade one claimed work unit and yield it to a continuation. */
export const degradeRagEmbeddingAndContinue = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    expectedPhase: ragIndexPhaseValidator,
    expectedCursor: v.optional(v.string()),
    expectedFileOffset: v.number(),
    expectedChunkOffset: v.number(),
    error: v.string(),
    continuationToken: v.string(),
    totalChunks: v.number(),
    successCount: v.number(),
    errorCount: v.number(),
    processedFiles: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo ||
      !ownsActiveRepositoryLifecycle(repo) ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "completed" ||
      repo.ragStatus !== "indexing" ||
      repo.ragIndexPhase !== args.expectedPhase ||
      repo.ragIndexCursor !== args.expectedCursor ||
      (repo.ragIndexFileOffset ?? 0) !== args.expectedFileOffset ||
      (repo.ragIndexChunkOffset ?? 0) !== args.expectedChunkOffset ||
      repo.ragContinuationToken !== undefined ||
      repo.ragTotalChunks !== args.totalChunks ||
      repo.ragIndexedChunks !== args.successCount ||
      repo.ragFailedChunks !== args.errorCount ||
      repo.ragProcessedFiles !== args.processedFiles
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
      ragEmbeddingMode: "keyword_only",
      ragEmbeddingBillingTier: undefined,
      ragEmbeddingKey: undefined,
      ragEmbeddingError: sanitizeEmbeddingError(args.error),
      ragContinuationToken: args.continuationToken,
      ragTotalChunks: args.totalChunks,
      ragIndexedChunks: args.successCount,
      ragFailedChunks: args.errorCount,
      ragProcessedFiles: args.processedFiles,
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.ragV2.action.generateChunkEmbeddings,
      {
        repositoryId: args.repositoryId,
        indexVersion: args.expectedIndexVersion,
        phase: args.expectedPhase,
        cursor: args.expectedCursor,
        fileOffset: args.expectedFileOffset,
        chunkOffset: args.expectedChunkOffset,
        claimToken: args.continuationToken,
      },
    );
    await ctx.db.insert("repoIndexingLogs", {
      repositoryId: args.repositoryId,
      indexVersion: args.expectedIndexVersion,
      level: "warning",
      message:
        "Semantic embeddings became unavailable; continuing with keyword search index",
      createdAt: now,
    });
    return true;
  },
});

/** Claim one exact scheduled RAG work unit before it performs side effects. */
export const claimRagContinuation = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    phase: ragIndexPhaseValidator,
    cursor: v.optional(v.string()),
    fileOffset: v.number(),
    chunkOffset: v.number(),
    continuationToken: v.string(),
    embeddingPolicyTransition: v.optional(
      v.object({
        expectedRepositoryMetadataCheckedAt: v.optional(v.number()),
        expectedRagEmbeddingBillingTier: v.optional(
          ragEmbeddingBillingTierValidator,
        ),
        expectedEmbeddingInputMode: v.optional(embeddingInputModeValidator),
        nextRagEmbeddingBillingTier: ragEmbeddingBillingTierValidator,
        nextEmbeddingInputMode: embeddingInputModeValidator,
      }),
    ),
  },
  returns: v.union(
    v.null(),
    v.object({
      totalChunks: v.number(),
      successCount: v.number(),
      errorCount: v.number(),
      processedFiles: v.number(),
    }),
  ),
  handler: async (ctx, args): Promise<RagContinuationClaim | null> => {
    const repo = await ctx.db.get(args.repositoryId);
    const transition = args.embeddingPolicyTransition;
    if (
      !repo ||
      !ownsActiveRepositoryLifecycle(repo) ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "completed" ||
      repo.ragStatus !== "indexing" ||
      repo.ragIndexPhase !== args.phase ||
      repo.ragIndexCursor !== args.cursor ||
      (repo.ragIndexFileOffset ?? 0) !== args.fileOffset ||
      (repo.ragIndexChunkOffset ?? 0) !== args.chunkOffset ||
      repo.ragContinuationToken !== args.continuationToken ||
      (transition !== undefined &&
        (transition.expectedEmbeddingInputMode !==
          getEmbeddingInputModeForBillingTier(
            transition.expectedRagEmbeddingBillingTier,
          ) ||
          transition.nextEmbeddingInputMode !==
            getEmbeddingInputModeForBillingTier(
              transition.nextRagEmbeddingBillingTier,
            )))
    ) {
      return null;
    }

    if (
      transition !== undefined &&
      (repo.repositoryMetadataCheckedAt !==
        transition.expectedRepositoryMetadataCheckedAt ||
        repo.ragEmbeddingBillingTier !==
          transition.expectedRagEmbeddingBillingTier)
    ) {
      await restartRagAfterEmbeddingPolicyChange(
        ctx,
        repo,
        args.expectedIndexVersion,
      );
      return null;
    }

    if (
      transition !== undefined &&
      transition.expectedEmbeddingInputMode !==
        transition.nextEmbeddingInputMode
    ) {
      await restartRagAfterEmbeddingPolicyChange(
        ctx,
        repo,
        args.expectedIndexVersion,
      );
      return null;
    }

    if (repo.ragProcessedFiles === undefined) {
      throw new Error("RAG continuation checkpoint is incomplete");
    }

    const now = Date.now();
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
    });
    await ctx.db.patch(args.repositoryId, {
      ragContinuationToken: undefined,
      ...(transition
        ? {
            ragEmbeddingBillingTier: transition.nextRagEmbeddingBillingTier,
          }
        : {}),
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });

    return {
      totalChunks: repo.ragTotalChunks,
      successCount: repo.ragIndexedChunks,
      errorCount: repo.ragFailedChunks,
      processedFiles: repo.ragProcessedFiles,
    };
  },
});

/** Atomically checkpoint one work unit and schedule its exact successor. */
export const advanceRagGeneration = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    currentPhase: ragIndexPhaseValidator,
    currentCursor: v.optional(v.string()),
    currentFileOffset: v.number(),
    currentChunkOffset: v.number(),
    nextPhase: ragIndexPhaseValidator,
    nextCursor: v.optional(v.string()),
    nextFileOffset: v.number(),
    nextChunkOffset: v.number(),
    continuationToken: v.string(),
    totalChunks: v.number(),
    successCount: v.number(),
    errorCount: v.number(),
    processedFiles: v.number(),
    retryDelayMs: v.optional(v.number()),
    transientFileFetchAttempt: v.optional(v.number()),
    embeddingProviderAttempt: v.optional(v.number()),
    embeddingQueueAttempt: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const retryDelay = args.retryDelayMs;
    const sourceRetryAttempt = args.transientFileFetchAttempt;
    const embeddingRetryAttempt = args.embeddingProviderAttempt;
    const queueAttempt = args.embeddingQueueAttempt;
    const hasRetryDelay = retryDelay !== undefined;
    const retryAttemptCount =
      Number(sourceRetryAttempt !== undefined) +
      Number(embeddingRetryAttempt !== undefined) +
      Number(queueAttempt !== undefined);
    if (
      hasRetryDelay !== retryAttemptCount >= 1 ||
      (retryDelay !== undefined &&
        (!Number.isSafeInteger(retryDelay) ||
          retryDelay < 1_000 ||
          retryDelay > RAG_TRANSIENT_RETRY_MAX_DELAY_MS)) ||
      (sourceRetryAttempt !== undefined &&
        (!Number.isSafeInteger(sourceRetryAttempt) ||
          sourceRetryAttempt < 1 ||
          sourceRetryAttempt > RAG_TRANSIENT_RETRY_MAX_ATTEMPT)) ||
      (embeddingRetryAttempt !== undefined &&
        (!Number.isSafeInteger(embeddingRetryAttempt) ||
          embeddingRetryAttempt < 2 ||
          embeddingRetryAttempt > RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS)) ||
      (queueAttempt !== undefined &&
        (!Number.isSafeInteger(queueAttempt) ||
          queueAttempt < 1 ||
          queueAttempt > RAG_EMBEDDING_RESERVATION_MAX_WAITS))
    ) {
      throw new Error("invalid RAG continuation retry schedule");
    }
    const retryDelayMs = retryDelay ?? 0;
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo ||
      !ownsActiveRepositoryLifecycle(repo) ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexStatus !== "completed" ||
      repo.ragStatus !== "indexing" ||
      repo.ragIndexPhase !== args.currentPhase ||
      repo.ragIndexCursor !== args.currentCursor ||
      (repo.ragIndexFileOffset ?? 0) !== args.currentFileOffset ||
      (repo.ragIndexChunkOffset ?? 0) !== args.currentChunkOffset ||
      repo.ragContinuationToken !== undefined ||
      (args.currentPhase === "cleanup" && args.nextPhase !== "cleanup")
    ) {
      return false;
    }

    const now = Date.now();
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      previousScheduleId: repo.indexWatchdogScheduleId,
      previousSequence: repo.indexWatchdogSequence,
      ...(hasRetryDelay
        ? { delayMs: retryDelayMs + INDEXING_STALE_THRESHOLD_MS }
        : {}),
    });
    await ctx.db.patch(args.repositoryId, {
      ragIndexPhase: args.nextPhase,
      ragIndexCursor: args.nextCursor,
      ragIndexFileOffset: args.nextFileOffset,
      ragIndexChunkOffset: args.nextChunkOffset,
      ragContinuationToken: args.continuationToken,
      ragProcessedFiles: args.processedFiles,
      ragTotalChunks: args.totalChunks,
      ragIndexedChunks: args.successCount,
      ragFailedChunks: args.errorCount,
      ragError: undefined,
      indexWatchdogToken: watchdog.token,
      indexWatchdogScheduleId: watchdog.scheduleId,
      indexWatchdogSequence: watchdog.sequence,
      indexProgressAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(
      retryDelayMs,
      internal.ragV2.action.generateChunkEmbeddings,
      {
        repositoryId: args.repositoryId,
        indexVersion: args.expectedIndexVersion,
        phase: args.nextPhase,
        cursor: args.nextCursor,
        fileOffset: args.nextFileOffset,
        chunkOffset: args.nextChunkOffset,
        claimToken: args.continuationToken,
        ...(sourceRetryAttempt !== undefined
          ? {
              transientFileFetchAttempt: sourceRetryAttempt,
            }
          : {}),
        ...(embeddingRetryAttempt !== undefined
          ? { embeddingProviderAttempt: embeddingRetryAttempt }
          : {}),
        ...(queueAttempt !== undefined
          ? { embeddingQueueAttempt: queueAttempt }
          : {}),
      },
    );

    return true;
  },
});

function buildRepositoryIndexKey(
  repositoryId: Id<"repositories">,
  indexVersion: number,
): string {
  return `${repositoryId}:${indexVersion}`;
}

async function upsertChunkDocument(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
  repositoryIndexKey: string,
  chunk: RagChunkInput,
  indexVersion: number,
  now: number,
): Promise<Id<"repoChunks">> {
  assertRagChunkStorageBounds(chunk);
  const existingChunk = await ctx.db
    .query("repoChunks")
    .withIndex("by_index_version_and_chunk", (q) =>
      q
        .eq("repositoryId", repositoryId)
        .eq("indexVersion", indexVersion)
        .eq("chunkId", chunk.chunkId),
    )
    .first();

  if (existingChunk) {
    await ctx.db.patch(existingChunk._id, {
      path: chunk.path,
      repositoryIndexKey,
      language: chunk.language,
      code: chunk.code,
      retrievalText: chunk.retrievalText,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      symbols: chunk.symbols,
      imports: chunk.imports,
      exports: chunk.exports,
      signature: chunk.signature,
      docstring: chunk.docstring,
      embedding: chunk.embedding,
      embeddingKey: chunk.embeddingKey,
      embeddingInputMode: chunk.embeddingInputMode,
      embeddingScopeKey: chunk.embeddingKey
        ? `${repositoryIndexKey}:${chunk.embeddingKey}`
        : undefined,
      embeddingLanguageScopeKey: chunk.embeddingKey
        ? `${repositoryIndexKey}:${chunk.embeddingKey}:${chunk.language}`
        : undefined,
      searchableText: chunk.searchableText,
      contentHash: chunk.contentHash,
      indexVersion,
      updatedAt: now,
    });

    return existingChunk._id;
  }

  return await ctx.db.insert("repoChunks", {
    repositoryId,
    repositoryIndexKey,
    chunkId: chunk.chunkId,
    path: chunk.path,
    language: chunk.language,
    code: chunk.code,
    retrievalText: chunk.retrievalText,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    symbols: chunk.symbols,
    imports: chunk.imports,
    exports: chunk.exports,
    signature: chunk.signature,
    docstring: chunk.docstring,
    embedding: chunk.embedding,
    embeddingKey: chunk.embeddingKey,
    embeddingInputMode: chunk.embeddingInputMode,
    embeddingScopeKey: chunk.embeddingKey
      ? `${repositoryIndexKey}:${chunk.embeddingKey}`
      : undefined,
    embeddingLanguageScopeKey: chunk.embeddingKey
      ? `${repositoryIndexKey}:${chunk.embeddingKey}:${chunk.language}`
      : undefined,
    searchableText: chunk.searchableText,
    contentHash: chunk.contentHash,
    indexVersion,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Update repository RAG indexing status separately from file indexing status
 */
export const updateRagStatus = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    status: v.union(
      v.literal("pending"),
      v.literal("indexing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
    totalChunks: v.optional(v.number()),
    indexedChunks: v.optional(v.number()),
    failedChunks: v.optional(v.number()),
    expectedIndexVersion: v.optional(v.number()),
    expectedCurrentStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("indexing"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
    expectedPhase: v.optional(ragIndexPhaseValidator),
    expectedCursor: v.optional(v.string()),
    expectedFileOffset: v.optional(v.number()),
    expectedChunkOffset: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"repositories">> => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) {
      throw new Error("repository not found");
    }
    if (!(await hasReadyRepositoryInstallation(ctx, repo))) {
      await quarantineRepositoryForMissingInstallation(ctx, repo);
      return args.repositoryId;
    }

    if (
      args.expectedIndexVersion !== undefined &&
      (repo.indexVersion !== args.expectedIndexVersion ||
        !ownsActiveRepositoryLifecycle(repo))
    ) {
      return args.repositoryId;
    }

    if (
      args.expectedCurrentStatus !== undefined &&
      repo.ragStatus !== args.expectedCurrentStatus
    ) {
      return args.repositoryId;
    }

    if (
      args.expectedPhase !== undefined &&
      (repo.ragIndexPhase !== args.expectedPhase ||
        repo.ragIndexCursor !== args.expectedCursor ||
        (repo.ragIndexFileOffset ?? 0) !== (args.expectedFileOffset ?? 0) ||
        (repo.ragIndexChunkOffset ?? 0) !== (args.expectedChunkOffset ?? 0) ||
        repo.ragContinuationToken !== undefined)
    ) {
      return args.repositoryId;
    }

    const now = Date.now();
    const updates: Record<string, unknown> = {
      ragStatus: args.status,
      indexProgressAt: now,
      updatedAt: now,
    };

    switch (args.status) {
      case "completed":
        // A pass that reached completion through its cleanup phase leaves
        // exactly one chunk set per current path.
        if (args.expectedPhase === "cleanup") {
          updates.ragChunkLayout = "path_v1";
        }
        updates.ragLastIndexedAt = now;
        updates.ragError = undefined;
        updates.ragIndexPhase = undefined;
        updates.ragIndexCursor = undefined;
        updates.ragIndexFileOffset = undefined;
        updates.ragIndexChunkOffset = undefined;
        updates.ragContinuationToken = undefined;
        updates.ragProcessedFiles = undefined;
        break;
      case "failed":
        updates.ragError = args.error ?? "Unknown RAG indexing error";
        updates.ragIndexPhase = undefined;
        updates.ragIndexCursor = undefined;
        updates.ragIndexFileOffset = undefined;
        updates.ragIndexChunkOffset = undefined;
        updates.ragContinuationToken = undefined;
        updates.ragProcessedFiles = undefined;
        break;
      default:
        updates.ragError = undefined;
    }

    if (args.totalChunks !== undefined) {
      updates.ragTotalChunks = args.totalChunks;
    }
    if (args.indexedChunks !== undefined) {
      updates.ragIndexedChunks = args.indexedChunks;
    }
    if (args.failedChunks !== undefined) {
      updates.ragFailedChunks = args.failedChunks;
    }

    // Record terminal RAG transitions in the indexing log; this is the only
    // signal the sync screen has that the finalize phase actually ended. Skip
    // the failed log when the file index itself failed - that error is already
    // reported by the file-index pipeline.
    if (args.status === "completed" && repo.ragStatus !== "completed") {
      const indexedChunks = args.indexedChunks ?? repo.ragIndexedChunks;
      const totalChunks = args.totalChunks ?? repo.ragTotalChunks;
      await ctx.db.insert("repoIndexingLogs", {
        repositoryId: args.repositoryId,
        indexVersion: repo.indexVersion,
        level: "success",
        message: `AI search index completed: ${indexedChunks}/${totalChunks} chunks indexed`,
        createdAt: now,
      });
    } else if (
      args.status === "failed" &&
      repo.ragStatus !== "failed" &&
      repo.indexStatus === "completed"
    ) {
      await ctx.db.insert("repoIndexingLogs", {
        repositoryId: args.repositoryId,
        indexVersion: repo.indexVersion,
        level: "error",
        message: `AI search indexing failed: ${args.error ?? "Unknown RAG indexing error"}`,
        createdAt: now,
      });
    }

    let queuedIndexVersion: number | undefined;
    const needsQueuedIndex =
      repo.indexSyncPending &&
      !matchesCurrentIndexSource(repo, repo.indexSyncPendingSource);
    if (args.status === "completed") {
      updates.indexSyncPending = false;
      updates.indexSyncPendingSource = undefined;
    }
    if (args.status === "completed" && needsQueuedIndex) {
      await scheduleRepositoryTreeSnapshotCleanup(
        ctx,
        repo.indexTreeSnapshotId,
      );
      queuedIndexVersion = repo.indexVersion + 1;
      Object.assign(updates, {
        indexVersion: queuedIndexVersion,
        indexStatus: "pending",
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
        indexTreeSnapshotId: undefined,
        indexRateLimitRetryToken: undefined,
        indexRateLimitRetryAt: undefined,
        indexIdentityVerifiedVersion: undefined,
        indexIdentityVerifiedInstallationId: undefined,
        indexIdentityVerifiedGithubRepositoryId: undefined,
        indexIdentityVerifiedGithubRepo: undefined,
      });
    }

    if (queuedIndexVersion !== undefined) {
      const watchdog = await armIndexWatchdog(ctx, {
        repositoryId: args.repositoryId,
        expectedIndexVersion: queuedIndexVersion,
        previousScheduleId: repo.indexWatchdogScheduleId,
        previousSequence: repo.indexWatchdogSequence,
      });
      Object.assign(updates, {
        indexWatchdogToken: watchdog.token,
        indexWatchdogScheduleId: watchdog.scheduleId,
        indexWatchdogSequence: watchdog.sequence,
        indexWatchdogRetryCount: 0,
      });
    } else if (args.status === "completed" || args.status === "failed") {
      await cancelIndexWatchdog(ctx, repo.indexWatchdogScheduleId);
      Object.assign(updates, {
        indexWatchdogToken: undefined,
        indexWatchdogScheduleId: undefined,
        indexWatchdogRetryCount: undefined,
      });
    } else {
      const watchdog = await armIndexWatchdog(ctx, {
        repositoryId: args.repositoryId,
        expectedIndexVersion: repo.indexVersion,
        previousScheduleId: repo.indexWatchdogScheduleId,
        previousSequence: repo.indexWatchdogSequence,
      });
      Object.assign(updates, {
        indexWatchdogToken: watchdog.token,
        indexWatchdogScheduleId: watchdog.scheduleId,
        indexWatchdogSequence: watchdog.sequence,
      });
    }

    await ctx.db.patch(args.repositoryId, updates);

    if (queuedIndexVersion !== undefined) {
      await ctx.scheduler.runAfter(
        0,
        internal.repoIndexing.action.indexRepository,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: queuedIndexVersion,
        },
      );
    }

    return args.repositoryId;
  },
});

/**
 * Create or update code chunks with embeddings in one database mutation.
 */
export const upsertChunks = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    chunks: v.array(ragChunkValidator),
    indexVersion: v.number(),
    embeddingPublication: v.optional(
      ragEmbeddingPublicationExpectationValidator,
    ),
  },
  handler: async (ctx, args): Promise<Array<Id<"repoChunks">> | null> => {
    assertRagChunkBatchWithinBudget(args.chunks, false);
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) {
      throw new Error("repository not found");
    }

    if (
      !ownsActiveRepositoryLifecycle(repo) ||
      repo.indexVersion !== args.indexVersion ||
      repo.ragStatus !== "indexing" ||
      repo.ragIndexPhase !== "files" ||
      repo.ragContinuationToken !== undefined
    ) {
      throw new Error(
        `stale RAG chunk upsert for index version ${args.indexVersion}`,
      );
    }

    const publishesEmbeddings = args.chunks.some(
      (chunk) =>
        chunk.embedding !== undefined || chunk.embeddingKey !== undefined,
    );
    if (publishesEmbeddings) {
      if (
        !args.embeddingPublication ||
        args.chunks.some(
          (chunk) =>
            !chunk.embedding ||
            chunk.embeddingKey !== args.embeddingPublication?.embeddingKey,
        )
      ) {
        throw new Error("RAG embedding publication is invalid");
      }
      const policyMatches = await matchesRagEmbeddingPublicationPolicy(
        ctx,
        repo,
        args.embeddingPublication,
      );
      const ownsWork = ownsExpectedRagEmbeddingWork(
        repo,
        args.indexVersion,
        args.embeddingPublication,
      );
      if (!ownsWork || !policyMatches) {
        if (!policyMatches) {
          await restartRagAfterEmbeddingPolicyChange(
            ctx,
            repo,
            args.indexVersion,
          );
        }
        return null;
      }
    }

    const repositoryIndexKey = buildRepositoryIndexKey(
      args.repositoryId,
      args.indexVersion,
    );
    const now = Date.now();
    const chunkIds: Array<Id<"repoChunks">> = [];

    for (const chunk of args.chunks) {
      chunkIds.push(
        await upsertChunkDocument(
          ctx,
          args.repositoryId,
          repositoryIndexKey,
          chunk,
          args.indexVersion,
          now,
        ),
      );
    }

    return chunkIds;
  },
});

function ownsRagPhase(
  repo: Doc<"repositories">,
  indexVersion: number,
  phase: "files" | "cleanup",
): boolean {
  return (
    ownsActiveRepositoryLifecycle(repo) &&
    repo.indexVersion === indexVersion &&
    repo.indexStatus === "completed" &&
    repo.ragStatus === "indexing" &&
    repo.ragIndexPhase === phase &&
    repo.ragContinuationToken === undefined
  );
}

/**
 * Remove one bounded batch of a path's chunks before the path is re-chunked.
 * Readers are pinned to a completed generation, so a path being rebuilt is
 * never served half-written.
 */
export const deleteChunksForPathInGeneration = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    path: v.string(),
  },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo || !ownsRagPhase(repo, args.indexVersion, "files")) {
      throw new Error(
        `stale RAG chunk upsert for index version ${args.indexVersion}`,
      );
    }
    return await deleteChunksForPath(ctx, args.repositoryId, args.path);
  },
});

const RAG_PENDING_CLEAR_BATCH_SIZE = 200;

/**
 * Finish a generation's chunk bookkeeping in bounded steps. A pass that
 * rebuilt every path (no per-path layout yet) first sweeps chunks of older
 * generations; every pass then clears the re-chunk flags it consumed.
 */
export const cleanupRagGeneration = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      deleted: v.number(),
      cleared: v.number(),
      hasMore: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo || !ownsRagPhase(repo, args.indexVersion, "cleanup")) {
      return null;
    }
    if (repo.ragChunkLayout !== "path_v1") {
      const oldChunks = await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q
            .eq("repositoryId", args.repositoryId)
            .lt("indexVersion", args.indexVersion),
        )
        .take(RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE);
      for (const chunk of oldChunks) {
        await ctx.db.delete(chunk._id);
      }
      if (oldChunks.length === RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE) {
        return { deleted: oldChunks.length, cleared: 0, hasMore: true };
      }
    }
    const pending = await ctx.db
      .query("repoFileMap")
      .withIndex("by_repository_rag_pending_and_path", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("ragPending", true),
      )
      .take(RAG_PENDING_CLEAR_BATCH_SIZE);
    for (const fileMap of pending) {
      await ctx.db.patch(fileMap._id, { ragPending: undefined });
    }
    return {
      deleted: 0,
      cleared: pending.length,
      hasMore: pending.length === RAG_PENDING_CLEAR_BATCH_SIZE,
    };
  },
});

/** Keep only the newest bounded set of durable provider batches per repo. */
export const trimEmbeddingBatchCache = internalMutation({
  args: { repositoryId: v.id("repositories") },
  handler: async (
    ctx,
    args,
  ): Promise<{ deleted: number; hasMore: boolean }> => {
    const newest = await ctx.db
      .query("ragEmbeddingBatches")
      .withIndex("by_repository", (q) =>
        q.eq("repositoryId", args.repositoryId),
      )
      .order("desc")
      .take(MAX_RAG_EMBEDDING_CACHE_BATCHES_PER_REPOSITORY + 1);
    if (newest.length <= MAX_RAG_EMBEDDING_CACHE_BATCHES_PER_REPOSITORY) {
      return { deleted: 0, hasMore: false };
    }

    await ctx.db.delete(newest[newest.length - 1]._id);
    await ctx.scheduler.runAfter(
      0,
      internal.ragV2.internalMutation.trimEmbeddingBatchCache,
      { repositoryId: args.repositoryId },
    );
    return { deleted: 1, hasMore: true };
  },
});

/** Delete one potentially large cache document per transaction. */
export const deleteEmbeddingBatchCachePage = internalMutation({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<number> => {
    const cached = await ctx.db
      .query("ragEmbeddingBatches")
      .withIndex("by_repository", (q) =>
        q.eq("repositoryId", args.repositoryId),
      )
      .first();
    if (!cached) {
      return 0;
    }

    await ctx.db.delete(cached._id);
    await ctx.scheduler.runAfter(
      0,
      internal.ragV2.internalMutation.deleteEmbeddingBatchCachePage,
      { repositoryId: args.repositoryId },
    );
    return 1;
  },
});

// Page sizes keep one transaction well under Convex's read and write limits:
// a cached batch holds up to 32 vectors (about 400 KB), a chunk up to about
// 150 KB of code, text and vector, and a learning a few KB.
const RETIRED_EMBEDDING_PURGE_PAGE = {
  chunks: 25,
  batches: 8,
  learnings: 50,
} as const;
const retiredEmbeddingPhase = v.union(
  v.literal("chunks"),
  v.literal("batches"),
  v.literal("learnings"),
);

/**
 * One-off storage reclaim after embeddings were retired: clears stored
 * vectors from code chunks and learnings and deletes the batch cache. It is
 * not scheduled automatically. Run it once against a deployment with:
 *
 *   bunx convex run ragV2/internalMutation:purgeRetiredEmbeddings \
 *     '{"confirm":"delete-retired-embeddings"}'
 *
 * It continues itself in small batches until every phase is done.
 */
export const purgeRetiredEmbeddings = internalMutation({
  args: {
    confirm: v.literal("delete-retired-embeddings"),
    phase: v.optional(retiredEmbeddingPhase),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const phase = args.phase ?? "chunks";
    const paginationOpts = {
      numItems: RETIRED_EMBEDDING_PURGE_PAGE[phase],
      cursor: args.cursor ?? null,
    };
    let page: { isDone: boolean; continueCursor: string };
    let changed = 0;
    switch (phase) {
      case "chunks": {
        const result = await ctx.db
          .query("repoChunks")
          .paginate(paginationOpts);
        for (const chunk of result.page) {
          if (chunk.embedding === undefined) continue;
          await ctx.db.patch(chunk._id, { embedding: undefined });
          changed++;
        }
        page = result;
        break;
      }
      case "batches": {
        const result = await ctx.db
          .query("ragEmbeddingBatches")
          .paginate(paginationOpts);
        for (const batch of result.page) {
          await ctx.db.delete(batch._id);
          changed++;
        }
        page = result;
        break;
      }
      case "learnings": {
        const result = await ctx.db
          .query("repoLearnings")
          .paginate(paginationOpts);
        for (const learning of result.page) {
          if (learning.embedding === undefined) continue;
          await ctx.db.patch(learning._id, { embedding: undefined });
          changed++;
        }
        page = result;
        break;
      }
    }
    const nextPhase: "batches" | "learnings" | null =
      phase === "chunks" ? "batches" : phase === "batches" ? "learnings" : null;
    const next = !page.isDone
      ? { phase, cursor: page.continueCursor }
      : nextPhase
        ? { phase: nextPhase, cursor: null }
        : null;
    if (next)
      await ctx.scheduler.runAfter(
        0,
        internal.ragV2.internalMutation.purgeRetiredEmbeddings,
        { confirm: args.confirm, ...next },
      );
    return { phase, changed, done: next === null };
  },
});
