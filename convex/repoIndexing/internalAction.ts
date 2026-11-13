import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { hasStaleIncrementalIndexWork } from "./readiness";
import type { ActiveRepositoryRecoveryPage } from "./internalQuery";
import { REPOSITORY_TREE_SNAPSHOT_CLEANUP_STALE_MS } from "./treeSnapshot";
import { fetchDefaultBranchHead } from "./action";

const STALE_RECOVERY_SCAN_PAGE_SIZE = 25;
const STALE_RECOVERY_SCAN_MAX_PAGE_SIZE = 50;
const REPOSITORY_FILE_FETCH_TIMEOUT_MS = 30_000;

type StaleRepositoryRecoveryResult = {
  scanned: number;
  recovered: number;
  skipped: number;
  failed: number;
  hasMore: boolean;
  nextCursor: string | null;
};

/**
 * Enroll active generations missing durable watchdog leases. Each invocation
 * handles one cursor page.
 */
export const recoverStaleRepositoryIndexes = internalAction({
  args: {
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<StaleRepositoryRecoveryResult> => {
    const pageSize = Math.min(
      Math.max(Math.floor(args.pageSize ?? STALE_RECOVERY_SCAN_PAGE_SIZE), 1),
      STALE_RECOVERY_SCAN_MAX_PAGE_SIZE,
    );
    const now = Date.now();
    const page: ActiveRepositoryRecoveryPage = await ctx.runQuery(
      internal.repoIndexing.internalQuery.getActiveRepositoryRecoveryPage,
      {
        cursor: args.cursor,
        limit: pageSize,
      },
    );

    let recovered = 0;
    let skipped = 0;
    let failed = 0;

    for (const repository of page.repositories) {
      try {
        if (repository.indexWatchdogToken !== undefined) {
          if (!hasStaleIncrementalIndexWork(repository, now)) {
            skipped++;
            continue;
          }
          const recovery = await ctx.runMutation(
            internal.repoIndexing.watchdog.recoverStalledIndex,
            {
              repositoryId: repository._id,
              expectedIndexVersion: repository.indexVersion,
              watchdogToken: repository.indexWatchdogToken,
            },
          );
          if (recovery.outcome === "ignored") {
            skipped++;
          } else {
            recovered++;
          }
          continue;
        }

        const enrollment = await ctx.runMutation(
          internal.repoIndexing.watchdog.enrollIndexWatchdog,
          { repositoryId: repository._id },
        );
        if (enrollment.outcome === "ignored") {
          skipped++;
          continue;
        }

        recovered++;
        if (enrollment.stale) {
          const recovery = await ctx.runMutation(
            internal.repoIndexing.watchdog.recoverStalledIndex,
            {
              repositoryId: repository._id,
              expectedIndexVersion: enrollment.expectedIndexVersion,
              watchdogToken: enrollment.watchdogToken,
            },
          );
          if (recovery.outcome === "restarted") {
            try {
              await ctx.runMutation(
                internal.repoIndexing.mutation.addIndexingLog,
                {
                  repositoryId: repository._id,
                  indexVersion: recovery.indexVersion,
                  level: "warning",
                  message: `Automatically recovering stalled indexing for ${repository.githubRepo}`,
                },
              );
            } catch {
              console.warn("[StaleIndexRecovery] Unable to add recovery log");
            }
          }
        }
      } catch {
        failed++;
        console.error("[StaleIndexRecovery] Failed to recover repository");
      }
    }

    if (page.hasMore && page.cursor) {
      await ctx.scheduler.runAfter(
        0,
        internal.repoIndexing.internalAction.recoverStaleRepositoryIndexes,
        { cursor: page.cursor, pageSize },
      );
    }

    return {
      scanned: page.repositories.length,
      recovered,
      skipped,
      failed,
      hasMore: page.hasMore,
      nextCursor: page.cursor,
    };
  },
});

/** Re-enqueue bounded deletion when a prior cleanup job disappeared. */
export const recoverTreeSnapshotCleanup = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; resumed: number }> => {
    const snapshots = await ctx.runQuery(
      internal.repoIndexing.internalQuery.getDeletingTreeSnapshots,
      {
        staleBefore: Date.now() - REPOSITORY_TREE_SNAPSHOT_CLEANUP_STALE_MS,
        limit: 25,
      },
    );

    let resumed = 0;
    for (const snapshot of snapshots) {
      const result = await ctx.runMutation(
        internal.repoIndexing.mutation.continueIndexTreeSnapshotCleanup,
        { snapshotId: snapshot._id },
      );
      if (result.deleted > 0 || result.completed) {
        resumed++;
      }
    }

    return { checked: snapshots.length, resumed };
  },
});

/**
 * Get repository files with content for AI context
 * Fetches actual file content from storage URLs
 */
export const getRepositoryFilesWithContent = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    filePaths: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
    indexVersion: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{ path: string; content: string; language: string | undefined }>
  > => {
    const access = await ctx.runQuery(
      internal.repositories.internalQuery.getAiAccessSnapshot,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.indexVersion,
      },
    );
    if (!access) {
      return [];
    }

    // Get file metadata with URLs from query
    const filesWithUrls = await ctx.runQuery(
      internal.repoIndexing.internalQuery.getRepositoryFiles,
      {
        repositoryId: args.repositoryId,
        filePaths: args.filePaths,
        limit: args.limit,
        indexVersion: access.indexVersion,
      },
    );

    // Fetch content from each URL
    const filesWithContent: Array<{
      path: string;
      content: string;
      language: string | undefined;
    } | null> = await Promise.all(
      filesWithUrls.map(
        async (
          file: {
            path: string;
            url: string | null;
            language: string | undefined;
            size: number;
          },
          filePosition: number,
        ) => {
          if (!file.url) {
            return null;
          }

          try {
            const response = await fetch(file.url, {
              signal: AbortSignal.timeout(REPOSITORY_FILE_FETCH_TIMEOUT_MS),
            });
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined);
              console.error("Failed to fetch repository file content", {
                filePosition,
                status: response.status,
              });
              return null;
            }
            const content = await response.text();

            return {
              path: file.path,
              content,
              language: file.language,
            };
          } catch {
            console.error("Repository file content fetch timed out or failed", {
              filePosition,
            });
            return null;
          }
        },
      ),
    );

    // Filter out null results
    const result = filesWithContent.filter(
      (
        f: {
          path: string;
          content: string;
          language: string | undefined;
        } | null,
      ): f is { path: string; content: string; language: string | undefined } =>
        f !== null,
    );
    const currentAccess = await ctx.runQuery(
      internal.repositories.internalQuery.getAiAccessSnapshot,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: access.indexVersion,
      },
    );
    return currentAccess ? result : [];
  },
});

/**
 * Trigger incremental indexing for repository (called by webhook)
 *
 * Race condition prevention:
 * - prepareIncrementalIndex mutation atomically checks status and sets to "pending"
 * - Only "completed" → "pending" transition is allowed
 * - Convex mutations are serialized, so only one trigger can win
 */
export const triggerIncrementalIndex = internalAction({
  args: {
    repositoryFullName: v.string(),
    installationId: v.number(),
    githubRepositoryId: v.number(),
    reason: v.string(), // "push"
    source: v.optional(
      v.object({ commitSha: v.string(), defaultBranch: v.string() }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    { success: false; error: string } | { success: true; newVersion: number }
  > => {
    console.log(`Incremental indexing triggered (reason: ${args.reason})`);

    // Atomically check status and set to "pending"
    // Only "completed" status can transition - prevents race conditions
    const prepareResult = await ctx.runMutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        installationId: args.installationId,
        githubRepositoryId: args.githubRepositoryId,
        queueIfBusy: true,
        source: args.source,
      },
    );

    if (!prepareResult.success) {
      console.log(`Skipping incremental index: ${prepareResult.error}`);
      return { success: false, error: prepareResult.error };
    }

    const { newVersion } = prepareResult;

    console.log(`Incremented index version to ${newVersion}`);

    console.log("Scheduled indexing job");

    return {
      success: true,
      newVersion,
    };
  },
});

/**
 * Clean up old cached files (called by cron)
 * Implements bounded LRU eviction based on last access time
 */
export const cleanupOldFileCache = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; deleted: number }> => {
    const now = Date.now();
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000; // 1 week in milliseconds

    // Get a bounded batch of blobs not accessed in the last week.
    const staleBlobs = await ctx.runQuery(
      internal.repoIndexing.internalQuery.getStaleFileBlobs,
      {
        threshold: now - ONE_WEEK,
      },
    );

    console.log(`Found ${staleBlobs.length} stale file blobs to clean up`);

    let deleted = 0;

    for (const blob of staleBlobs) {
      try {
        // Delete blob record (storage deletion happens inside mutation now)
        const wasDeleted = await ctx.runMutation(
          internal.repoIndexing.mutation.deleteFileBlobIfStale,
          {
            blobId: blob._id,
            threshold: now - ONE_WEEK,
          },
        );

        if (wasDeleted) {
          deleted++;
        }
      } catch {
        console.error("Failed to delete stale file blob");
      }
    }

    console.log(`Deleted ${deleted} stale file blobs`);

    return {
      checked: staleBlobs.length,
      deleted,
    };
  },
});

/**
 * Daily sync all repositories (called by cron)
 * Triggers re-indexing for all completed repositories
 */
export const dailySyncAllRepositories = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    total: number;
    scheduled: number;
    skipped: number;
    hasMore: boolean;
  }> => {
    const page = await ctx.runQuery(
      internal.repoIndexing.internalQuery.getPeriodicSyncPage,
      { cursor: args.cursor },
    );
    let scheduled = 0;
    let skipped = page.scanned - page.repositories.length;
    for (const repo of page.repositories) {
      try {
        // Push webhooks index every default-branch change; this daily pass
        // only catches missed deliveries. An unchanged head costs one GitHub
        // request and no database work, and an unreadable head is left for
        // the next pass instead of forcing a blind reindex.
        const head = await fetchDefaultBranchHead({
          installationId: repo.installationId,
          githubRepositoryId: repo.githubRepositoryId,
          githubRepo: repo.githubRepo,
          defaultBranch: repo.defaultBranch,
        });
        if (
          !head ||
          (repo.indexedSource?.commitSha === head.commitSha &&
            repo.indexedSource.defaultBranch === head.defaultBranch)
        ) {
          skipped++;
          continue;
        }
        const prepared = await ctx.runMutation(
          internal.repoIndexing.mutation.prepareIncrementalIndex,
          {
            repositoryId: repo._id,
            scheduleDelayMs: scheduled * 30_000,
            source: head,
          },
        );
        if (!prepared.success) {
          skipped++;
          continue;
        }
        scheduled++;
        await ctx.runMutation(internal.repoIndexing.mutation.addIndexingLog, {
          repositoryId: repo._id,
          indexVersion: prepared.newVersion,
          level: "info",
          message: `Periodic sync initiated for ${repo.githubRepo}`,
        });
      } catch {
        skipped++;
      }
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(
        5 * 60_000,
        internal.repoIndexing.internalAction.dailySyncAllRepositories,
        { cursor: page.continueCursor },
      );
    return { total: page.scanned, scheduled, skipped, hasMore: !page.isDone };
  },
});
