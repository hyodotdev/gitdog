import { v } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import {
  getIncrementalIndexStaleAt,
  hasIncrementalIndexWorkInProgress,
  INDEXING_STALE_THRESHOLD_MS,
} from "./readiness";
import { scheduleRepositoryTreeSnapshotCleanup } from "./treeSnapshot";
import { quarantineRepositoryForMissingInstallation } from "../repositories/accessLifecycle";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";

export const INDEX_WATCHDOG_MAX_RECOVERIES = 2;
const INDEX_WATCHDOG_ACCESS_RETRY_MS = 5 * 60 * 1_000;

type ArmIndexWatchdogArgs = {
  repositoryId: Id<"repositories">;
  expectedIndexVersion: number;
  previousScheduleId?: Id<"_scheduled_functions">;
  previousSequence?: number;
  delayMs?: number;
};

type IndexWatchdogReservation = {
  token: string;
  scheduleId: Id<"_scheduled_functions">;
  sequence: number;
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

export async function cancelIndexWatchdog(
  ctx: MutationCtx,
  scheduleId?: Id<"_scheduled_functions">,
): Promise<void> {
  if (!scheduleId) {
    return;
  }

  try {
    await ctx.scheduler.cancel(scheduleId);
  } catch {
    console.warn("[IndexWatchdog] Unable to cancel completed watchdog");
  }
}

/** Replace the previous heartbeat watchdog with one exact generation lease. */
export async function armIndexWatchdog(
  ctx: MutationCtx,
  args: ArmIndexWatchdogArgs,
): Promise<IndexWatchdogReservation> {
  await cancelIndexWatchdog(ctx, args.previousScheduleId);

  const sequence = (args.previousSequence ?? 0) + 1;
  const token = `${args.expectedIndexVersion}:${sequence}`;
  const scheduleId = await ctx.scheduler.runAfter(
    Math.max(0, args.delayMs ?? INDEXING_STALE_THRESHOLD_MS),
    internal.repoIndexing.watchdog.recoverStalledIndex,
    {
      repositoryId: args.repositoryId,
      expectedIndexVersion: args.expectedIndexVersion,
      watchdogToken: token,
    },
  );

  return { token, scheduleId, sequence };
}

function getWatchdogFields(reservation: IndexWatchdogReservation) {
  return {
    indexWatchdogToken: reservation.token,
    indexWatchdogScheduleId: reservation.scheduleId,
    indexWatchdogSequence: reservation.sequence,
  };
}

/**
 * Surface automatic recovery decisions in the indexing log so a stalled sync
 * never looks frozen in the UI while the watchdog works in the background.
 */
async function logWatchdogRecovery(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories">;
    indexVersion: number;
    level: "warning" | "error";
    message: string;
  },
): Promise<void> {
  await ctx.db.insert("repoIndexingLogs", {
    repositoryId: args.repositoryId,
    indexVersion: args.indexVersion,
    level: args.level,
    message: args.message,
    createdAt: Date.now(),
  });
}

/**
 * Give active generations a durable progress anchor without treating later
 * repository metadata writes as indexing heartbeats.
 */
export const enrollIndexWatchdog = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const repository = await ctx.db.get(args.repositoryId);
    if (
      repository &&
      !(await hasReadyRepositoryInstallation(ctx, repository))
    ) {
      await quarantineRepositoryForMissingInstallation(ctx, repository);
      return { outcome: "ignored" as const };
    }
    if (
      !repository ||
      !hasIncrementalIndexWorkInProgress(repository) ||
      repository.indexWatchdogToken !== undefined
    ) {
      return { outcome: "ignored" as const };
    }

    const now = Date.now();
    const expectedIndexVersion = repository.indexVersion;
    const progressAt = repository.indexProgressAt;
    const staleAt = progressAt + INDEXING_STALE_THRESHOLD_MS;
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion,
      previousScheduleId: repository.indexWatchdogScheduleId,
      previousSequence: repository.indexWatchdogSequence,
      delayMs: staleAt - now,
    });

    await ctx.db.patch(args.repositoryId, {
      indexVersion: expectedIndexVersion,
      indexProgressAt: progressAt,
      indexWatchdogRetryCount: repository.indexWatchdogRetryCount ?? 0,
      ...getWatchdogFields(watchdog),
    });

    return {
      outcome: "enrolled" as const,
      expectedIndexVersion,
      watchdogToken: watchdog.token,
      stale: now >= staleAt,
    };
  },
});

/**
 * Recover an at-most-once scheduled action that disappeared after its last
 * durable heartbeat. The version bump invalidates every stale file/RAG write.
 */
export const recoverStalledIndex = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    watchdogToken: v.string(),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo ||
      repo.indexVersion !== args.expectedIndexVersion ||
      repo.indexWatchdogToken !== args.watchdogToken
    ) {
      return { outcome: "ignored" as const };
    }
    if (!(await hasReadyRepositoryInstallation(ctx, repo))) {
      if (await quarantineRepositoryForMissingInstallation(ctx, repo)) {
        return { outcome: "failed" as const };
      }
      const watchdog = await armIndexWatchdog(ctx, {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        previousScheduleId: repo.indexWatchdogScheduleId,
        previousSequence: repo.indexWatchdogSequence,
        delayMs: INDEX_WATCHDOG_ACCESS_RETRY_MS,
      });
      await ctx.db.patch(args.repositoryId, {
        ...getWatchdogFields(watchdog),
        indexProgressAt: Date.now(),
      });
      return { outcome: "deferred" as const };
    }

    const staleAt = getIncrementalIndexStaleAt(repo);
    if (!hasIncrementalIndexWorkInProgress(repo) || staleAt === undefined) {
      await scheduleRepositoryTreeSnapshotCleanup(
        ctx,
        repo.indexTreeSnapshotId,
      );
      await ctx.db.patch(args.repositoryId, {
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
      });
      return { outcome: "ignored" as const };
    }

    const now = Date.now();
    if (now < staleAt) {
      const watchdog = await armIndexWatchdog(ctx, {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        previousSequence: repo.indexWatchdogSequence,
      });
      await ctx.db.patch(args.repositoryId, getWatchdogFields(watchdog));
      return { outcome: "rearmed" as const };
    }

    const retryCount = repo.indexWatchdogRetryCount ?? 0;
    if (retryCount >= INDEX_WATCHDOG_MAX_RECOVERIES) {
      const fileIndexActive = repo.indexStatus !== "completed";
      const watchdogError = fileIndexActive
        ? "Repository indexing failed before RAG generation"
        : "Repository RAG indexing stopped after automatic recovery attempts";
      await scheduleRepositoryTreeSnapshotCleanup(
        ctx,
        repo.indexTreeSnapshotId,
      );
      await ctx.db.patch(args.repositoryId, {
        indexStatus: fileIndexActive ? "failed" : repo.indexStatus,
        indexError: fileIndexActive
          ? "Repository indexing stopped after automatic recovery attempts"
          : repo.indexError,
        ragStatus: "failed",
        ragError: watchdogError,
        ragIndexPhase: undefined,
        ragIndexCursor: undefined,
        ragIndexFileOffset: undefined,
        ragIndexChunkOffset: undefined,
        ragContinuationToken: undefined,
        ragProcessedFiles: undefined,
        indexSyncPending: false,
        indexWatchdogToken: undefined,
        indexWatchdogScheduleId: undefined,
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
      await logWatchdogRecovery(ctx, {
        repositoryId: args.repositoryId,
        indexVersion: args.expectedIndexVersion,
        level: "error",
        message: fileIndexActive
          ? "Indexing stopped after automatic recovery attempts"
          : "AI search indexing stopped after automatic recovery attempts",
      });
      return { outcome: "failed" as const };
    }

    if (repo.indexStatus === "indexing" && repo.indexTreeSnapshotId) {
      const snapshot = await ctx.db.get(repo.indexTreeSnapshotId);
      if (
        snapshot?.repositoryId === args.repositoryId &&
        snapshot.indexVersion === args.expectedIndexVersion &&
        snapshot.status === "building" &&
        snapshot.traversalState === "traversing"
      ) {
        const watchdog = await armIndexWatchdog(ctx, {
          repositoryId: args.repositoryId,
          expectedIndexVersion: args.expectedIndexVersion,
          previousSequence: repo.indexWatchdogSequence,
        });
        await ctx.db.patch(snapshot._id, {
          traversalClaimToken: undefined,
          traversalClaimedAt: undefined,
          updatedAt: now,
        });
        await ctx.db.patch(args.repositoryId, {
          indexWatchdogRetryCount: retryCount + 1,
          ...getWatchdogFields(watchdog),
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
            treeSnapshotId: snapshot._id,
          },
        );
        await logWatchdogRecovery(ctx, {
          repositoryId: args.repositoryId,
          indexVersion: args.expectedIndexVersion,
          level: "warning",
          message: `Indexing stalled; resuming the file scan automatically (attempt ${retryCount + 1}/${INDEX_WATCHDOG_MAX_RECOVERIES})`,
        });
        return {
          outcome: "resumed" as const,
          indexVersion: args.expectedIndexVersion,
          retryCount: retryCount + 1,
        };
      }
    }

    if (
      repo.indexStatus === "completed" &&
      repo.ragStatus === "indexing" &&
      repo.ragEmbeddingMode === "keyword_only" &&
      repo.ragIndexPhase !== undefined &&
      repo.ragProcessedFiles !== undefined
    ) {
      const continuationToken =
        repo.ragContinuationToken ?? crypto.randomUUID();
      const watchdog = await armIndexWatchdog(ctx, {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        previousSequence: repo.indexWatchdogSequence,
      });
      await ctx.db.patch(args.repositoryId, {
        ragContinuationToken: continuationToken,
        indexWatchdogRetryCount: retryCount + 1,
        ...getWatchdogFields(watchdog),
        indexProgressAt: now,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.ragV2.action.generateChunkEmbeddings,
        {
          repositoryId: args.repositoryId,
          indexVersion: args.expectedIndexVersion,
          phase: repo.ragIndexPhase,
          cursor: repo.ragIndexCursor,
          fileOffset: repo.ragIndexFileOffset ?? 0,
          chunkOffset: repo.ragIndexChunkOffset ?? 0,
          claimToken: continuationToken,
        },
      );
      await logWatchdogRecovery(ctx, {
        repositoryId: args.repositoryId,
        indexVersion: args.expectedIndexVersion,
        level: "warning",
        message: `AI search indexing stalled; resuming automatically (attempt ${retryCount + 1}/${INDEX_WATCHDOG_MAX_RECOVERIES})`,
      });
      return {
        outcome: "resumed" as const,
        indexVersion: args.expectedIndexVersion,
        retryCount: retryCount + 1,
      };
    }

    if (repo.indexStatus === "completed" && repo.ragStatus === "pending") {
      // The reserved RAG kickoff disappeared before claiming its generation.
      // The completed file index is still intact, so re-dispatch the kickoff
      // instead of discarding the generation and re-downloading the repository.
      const watchdog = await armIndexWatchdog(ctx, {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.expectedIndexVersion,
        previousSequence: repo.indexWatchdogSequence,
      });
      await ctx.db.patch(args.repositoryId, {
        indexWatchdogRetryCount: retryCount + 1,
        ...getWatchdogFields(watchdog),
        indexProgressAt: now,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.ragV2.action.generateChunkEmbeddings,
        {
          repositoryId: args.repositoryId,
          indexVersion: args.expectedIndexVersion,
        },
      );
      await logWatchdogRecovery(ctx, {
        repositoryId: args.repositoryId,
        indexVersion: args.expectedIndexVersion,
        level: "warning",
        message: `AI search indexing did not start in time; retrying automatically (attempt ${retryCount + 1}/${INDEX_WATCHDOG_MAX_RECOVERIES})`,
      });
      return {
        outcome: "resumed" as const,
        indexVersion: args.expectedIndexVersion,
        retryCount: retryCount + 1,
      };
    }

    const newVersion = repo.indexVersion + 1;
    await scheduleRepositoryTreeSnapshotCleanup(ctx, repo.indexTreeSnapshotId);
    const watchdog = await armIndexWatchdog(ctx, {
      repositoryId: args.repositoryId,
      expectedIndexVersion: newVersion,
      previousSequence: repo.indexWatchdogSequence,
    });

    await ctx.db.patch(args.repositoryId, {
      indexVersion: newVersion,
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
      indexWatchdogRetryCount: retryCount + 1,
      ...getWatchdogFields(watchdog),
      indexProgressAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.repoIndexing.action.indexRepository,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: newVersion,
      },
    );
    await logWatchdogRecovery(ctx, {
      repositoryId: args.repositoryId,
      indexVersion: newVersion,
      level: "warning",
      message: `Indexing stalled; restarting automatically (attempt ${retryCount + 1}/${INDEX_WATCHDOG_MAX_RECOVERIES})`,
    });

    return {
      outcome: "restarted" as const,
      indexVersion: newVersion,
      retryCount: retryCount + 1,
    };
  },
});
