import { internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { v } from "convex/values";
import { paginatedCollect } from "../_utils/pagination";
import { readRepositoryAiAccessSnapshot } from "../repositories/aiReadiness";
import { getIncrementalIndexEligibility } from "./readiness";

interface RepositoryFilePageItem {
  path: string;
  url: string | null;
  language: string | undefined;
  size: number;
  isText: boolean;
}

const STALE_FILE_BLOB_BATCH_SIZE = 100;

interface RepositoryFilesPage {
  files: Array<RepositoryFilePageItem>;
  cursor: string | null;
  hasMore: boolean;
}

export type ActiveRepositoryRecoveryPage = {
  repositories: Array<
    Pick<
      Doc<"repositories">,
      | "_id"
      | "githubRepo"
      | "githubRepositoryId"
      | "isActive"
      | "updatedAt"
      | "indexVersion"
      | "indexStatus"
      | "ragStatus"
      | "indexProgressAt"
      | "indexRateLimitRetryAt"
      | "indexWatchdogToken"
      | "indexWatchdogScheduleId"
    >
  >;
  cursor: string | null;
  hasMore: boolean;
};

/** Read one bounded page for the watchdog-enrollment sweep. */
export const getActiveRepositoryRecoveryPage = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ActiveRepositoryRecoveryPage> => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 25), 1), 50);
    const page = await ctx.db
      .query("repositories")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .paginate({
        numItems: limit,
        cursor: args.cursor ?? null,
      });

    return {
      repositories: page.page.map((repository) => ({
        _id: repository._id,
        githubRepo: repository.githubRepo,
        githubRepositoryId: repository.githubRepositoryId,
        isActive: repository.isActive,
        updatedAt: repository.updatedAt,
        indexVersion: repository.indexVersion,
        indexStatus: repository.indexStatus,
        ragStatus: repository.ragStatus,
        indexProgressAt: repository.indexProgressAt,
        ...(repository.indexRateLimitRetryAt === undefined
          ? {}
          : { indexRateLimitRetryAt: repository.indexRateLimitRetryAt }),
        ...(repository.indexWatchdogToken === undefined
          ? {}
          : { indexWatchdogToken: repository.indexWatchdogToken }),
        ...(repository.indexWatchdogScheduleId === undefined
          ? {}
          : { indexWatchdogScheduleId: repository.indexWatchdogScheduleId }),
      })),
      cursor: page.isDone ? null : page.continueCursor,
      hasMore: !page.isDone,
    };
  },
});

/** Read one exact bounded page after validating repository generation ownership. */
export const getIndexTreeSnapshotPage = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    snapshotId: v.id("repoTreeSnapshots"),
    pageIndex: v.number(),
  },
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.pageIndex) || args.pageIndex < 0) {
      return null;
    }

    const [repository, snapshot] = await Promise.all([
      ctx.db.get(args.repositoryId),
      ctx.db.get(args.snapshotId),
    ]);
    if (
      !repository ||
      !snapshot ||
      repository.indexVersion !== args.expectedIndexVersion ||
      repository.indexStatus !== "indexing" ||
      repository.indexTreeSnapshotId !== args.snapshotId ||
      snapshot.repositoryId !== args.repositoryId ||
      snapshot.indexVersion !== args.expectedIndexVersion ||
      snapshot.status !== "ready"
    ) {
      return null;
    }

    if (snapshot.totalPages === 0) {
      return args.pageIndex === 0
        ? {
            snapshotId: snapshot._id,
            defaultBranch: snapshot.defaultBranch,
            commitSha: snapshot.commitSha,
            treeSha: snapshot.treeSha,
            totalFiles: 0,
            totalPages: 0,
            pageIndex: 0,
            files: [],
          }
        : null;
    }
    if (args.pageIndex >= snapshot.totalPages) {
      return null;
    }

    const page = await ctx.db
      .query("repoTreeSnapshotPages")
      .withIndex("by_snapshot_and_page", (q) =>
        q.eq("snapshotId", args.snapshotId).eq("pageIndex", args.pageIndex),
      )
      .first();
    if (!page) {
      return null;
    }

    return {
      snapshotId: snapshot._id,
      defaultBranch: snapshot.defaultBranch,
      commitSha: snapshot.commitSha,
      treeSha: snapshot.treeSha,
      totalFiles: snapshot.totalFiles,
      totalPages: snapshot.totalPages,
      pageIndex: page.pageIndex,
      files: page.files,
    };
  },
});

/** Read a bounded cleanup-recovery batch without scanning live manifests. */
export const getDeletingTreeSnapshots = internalQuery({
  args: {
    staleBefore: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 25), 1), 50);
    return await ctx.db
      .query("repoTreeSnapshots")
      .withIndex("by_status_and_updated_at", (q) =>
        q.eq("status", "deleting").lt("updatedAt", args.staleBefore),
      )
      .take(limit);
  },
});

/**
 * Get repository file metadata for AI context (returns URLs, not content)
 * Use getRepositoryFilesWithContent action to get actual content.
 *
 * NOTE: when `filePaths` is omitted the no-filter branch uses `.take(limit)`,
 * defaulting to 50 if `args.limit` is unset. Callers that need broader
 * coverage (e.g. listing or AI guide discovery) MUST pass an explicit limit.
 */
export const getRepositoryFiles = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    filePaths: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
    indexVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.indexVersion,
    );
    if (!access) {
      return [];
    }

    const limit = args.limit || 50;
    const indexVersion = access.indexVersion;

    // When specific paths are requested, look each one up directly via the
    // by_repository_and_path index. This avoids the previous 1000-cap collect,
    // which silently dropped requested paths in repos with many blobbed files.
    // Cap at MAX_PATH_LOOKUPS to keep the per-invocation DB work bounded even
    // if a future caller passes a huge array. Deduplicate first and log a
    // warning on truncation so silent partial results are debuggable.
    const MAX_PATH_LOOKUPS = 100;
    let fileMaps: Array<Doc<"repoFileMap">>;
    if (args.filePaths) {
      const uniquePaths = Array.from(new Set(args.filePaths));
      if (uniquePaths.length > MAX_PATH_LOOKUPS) {
        console.warn(
          `[getRepositoryFiles] Truncating ${uniquePaths.length} unique paths to ${MAX_PATH_LOOKUPS} for repository ${args.repositoryId}`,
        );
      }
      const pathsToLookup = uniquePaths.slice(0, MAX_PATH_LOOKUPS);
      const results = await Promise.all(
        pathsToLookup.map((filePath) => {
          return ctx.db
            .query("repoFileMap")
            .withIndex("by_repository_version_and_path", (q) =>
              q
                .eq("repositoryId", args.repositoryId)
                .eq("indexVersion", indexVersion)
                .eq("filePath", filePath),
            )
            .first();
        }),
      );
      fileMaps = results.filter((fm): fm is Doc<"repoFileMap"> => fm !== null);
    } else {
      // Use .take(limit) so the limit is enforced at the database level
      // rather than collecting all repo files into memory and slicing.
      fileMaps = await ctx.db
        .query("repoFileMap")
        .withIndex("by_index_version", (q) =>
          q
            .eq("repositoryId", args.repositoryId)
            .eq("indexVersion", indexVersion),
        )
        .take(limit);
    }

    // Get file blobs URLs for each file
    const filesWithUrls = await Promise.all(
      fileMaps.map(async (fileMap) => {
        // Get blob by sha256
        const blob = await ctx.db
          .query("repoFileBlobs")
          .withIndex("by_sha256", (q) => q.eq("sha256", fileMap.sha256))
          .first();

        if (!blob) {
          return null;
        }

        // Get storage URL
        const url = await ctx.storage.getUrl(blob.storageId);

        return {
          path: fileMap.filePath,
          url,
          language: fileMap.language,
          size: fileMap.size,
        };
      }),
    );

    // Filter out null results (files without blobs)
    const validFiles = filesWithUrls.filter((f) => f !== null) as Array<{
      path: string;
      url: string | null;
      language: string | undefined;
      size: number;
    }>;

    return validFiles;
  },
});

/**
 * Get one cursor page of blob-backed repository files for RAG indexing.
 *
 * Unlike getRepositoryFiles, this is meant for full repository scans and does
 * not impose a fixed top-level limit across the whole repository.
 */
export const getRepositoryFilesPage = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<RepositoryFilesPage> => {
    const access = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.indexVersion,
    );
    if (!access) {
      return { files: [], cursor: null, hasMore: false };
    }

    const pageSize = args.limit ?? 100;

    const page = await ctx.db
      .query("repoFileMap")
      .withIndex("by_index_version", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .eq("indexVersion", args.indexVersion),
      )
      .paginate({
        numItems: pageSize,
        cursor: args.cursor ?? null,
      });

    const filesWithUrls = await Promise.all(
      page.page.map(async (fileMap) => {
        if (fileMap.isText === false) {
          return null;
        }

        const blob = await ctx.db
          .query("repoFileBlobs")
          .withIndex("by_sha256", (q) => q.eq("sha256", fileMap.sha256))
          .first();

        if (!blob) {
          return null;
        }

        const url = await ctx.storage.getUrl(blob.storageId);

        return {
          path: fileMap.filePath,
          url,
          language: fileMap.language,
          size: fileMap.size,
          isText: fileMap.isText,
        };
      }),
    );

    return {
      files: filesWithUrls.filter((f) => f !== null) as Array<{
        path: string;
        url: string | null;
        language: string | undefined;
        size: number;
        isText: boolean;
      }>,
      cursor: page.isDone ? null : page.continueCursor,
      hasMore: !page.isDone,
    };
  },
});

/** Compact current-version path scan for directory exploration tools. */
export const getRepositoryFilePathsPage = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.indexVersion,
    );
    if (!access) {
      return { paths: [], cursor: null, hasMore: false };
    }

    const page = await ctx.db
      .query("repoFileMap")
      .withIndex("by_index_version", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .eq("indexVersion", args.indexVersion),
      )
      .paginate({
        numItems: Math.min(Math.max(args.limit ?? 64, 1), 100),
        cursor: args.cursor ?? null,
      });

    return {
      paths: page.page.map((file) => file.filePath),
      cursor: page.isDone ? null : page.continueCursor,
      hasMore: !page.isDone,
    };
  },
});

/**
 * DEBUG: Check repository indexing status
 * Uses take() to get samples (for debug purposes, exact counts not needed)
 */
export const debugRepositoryIndexing = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    // Get repository
    const repo = await ctx.db.get(args.repositoryId);

    if (!repo) {
      return { error: "Repository not found", repositoryId: args.repositoryId };
    }

    // Get sample file maps (exact count not critical for debug)
    const sampleFileMaps = await ctx.db
      .query("repoFileMap")
      .withIndex("by_repository", (q) => q.eq("repositoryId", repo._id))
      .take(100);

    // Get sample chunks (without embeddings in response)
    const sampleChunksRaw = await ctx.db
      .query("repoChunks")
      .withIndex("by_repository", (q) => q.eq("repositoryId", repo._id))
      .take(10);

    const sampleChunks = sampleChunksRaw.slice(0, 3).map((c) => ({
      path: c.path,
      symbols: c.symbols,
      startLine: c.startLine,
      endLine: c.endLine,
      hasEmbedding: !!c.embedding,
    }));

    // Check sample file maps for blobs
    const sampleFilesWithBlobs = await Promise.all(
      sampleFileMaps.slice(0, 5).map(async (fm) => {
        const blob = await ctx.db
          .query("repoFileBlobs")
          .withIndex("by_sha256", (q) => q.eq("sha256", fm.sha256))
          .first();

        return {
          filePath: fm.filePath,
          sha256: fm.sha256,
          hasBlob: !!blob,
          blobId: blob?._id,
          storageId: blob?.storageId,
        };
      }),
    );

    const filesWithBlobs = sampleFilesWithBlobs.filter((f) => f.hasBlob);
    const filesWithoutBlobs = sampleFilesWithBlobs.filter((f) => !f.hasBlob);

    return {
      repository: {
        _id: repo._id,
        githubRepo: repo.githubRepo,
        indexVersion: repo.indexVersion,
      },
      sampleFileMapCount: sampleFileMaps.length,
      sampleChunksCount: sampleChunksRaw.length,
      sampleFilesWithBlobsCount: filesWithBlobs.length,
      sampleFilesWithoutBlobsCount: filesWithoutBlobs.length,
      sampleFilesWithBlobs: filesWithBlobs.slice(0, 5),
      sampleFilesWithoutBlobs: filesWithoutBlobs.slice(0, 5),
      sampleChunks,
      note: "Counts are samples (up to 100 fileMaps, 10 chunks), not exact totals",
    };
  },
});

/**
 * Get stale file blobs for cache cleanup
 */
export const getStaleFileBlobs = internalQuery({
  args: {
    threshold: v.number(), // Timestamp threshold
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.threshold)) {
      return [];
    }

    return await ctx.db
      .query("repoFileBlobs")
      .withIndex("by_last_accessed", (q) =>
        q.lt("lastAccessedAt", args.threshold),
      )
      .take(STALE_FILE_BLOB_BATCH_SIZE);
  },
});

/**
 * Get repositories that need indexing (internal only)
 */
export const getPendingIndexing = internalQuery({
  args: {},
  handler: async (ctx) => {
    const repos = await paginatedCollect(
      ctx.db
        .query("repositories")
        .withIndex("by_index_status", (q) => q.eq("indexStatus", "pending")),
      { maxItems: 100 },
    );

    return repos;
  },
});

/**
 * Get all active repositories for daily sync
 * Only returns repositories that are not currently indexing
 * Uses pagination to avoid 16MB read limit
 */
export const getAllActiveRepositories = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 100; // Default limit for daily sync

    const allRepos = await paginatedCollect(ctx.db.query("repositories"));

    // Filter to non-indexing repos and apply limit
    return allRepos
      .filter((repo) => repo.indexStatus !== "indexing")
      .slice(0, limit);
  },
});

/**
 * Get repositories that have completed indexing (for daily sync)
 * Only returns repositories with indexStatus === "completed"
 * Sorted by lastIndexedAt (oldest first) to ensure fair rotation
 * Uses pagination to avoid 16MB read limit
 */
export const getCompletedRepositories = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 500; // Default limit for daily sync rotation

    const repos = await paginatedCollect(
      ctx.db
        .query("repositories")
        .withIndex("by_index_status", (q) => q.eq("indexStatus", "completed")),
      { maxItems: limit },
    );

    const eligibleRepos = repos.filter(
      (repo) => getIncrementalIndexEligibility(repo).allowed,
    );

    // Sort by lastIndexedAt ascending (oldest first)
    // This ensures repositories that haven't been synced recently get priority
    return eligibleRepos.sort((a, b) => {
      const aTime = a.lastIndexedAt ?? 0;
      const bTime = b.lastIndexedAt ?? 0;
      return aTime - bTime;
    });
  },
});

/** Cursor pagination prevents periodic synchronization from starving later repositories. */
export const getPeriodicSyncPage = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("repositories")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .paginate({ cursor: args.cursor ?? null, numItems: 10 });
    return {
      repositories: result.page
        .filter((repo) => getIncrementalIndexEligibility(repo).allowed)
        .map((repo) => ({
          _id: repo._id,
          githubRepo: repo.githubRepo,
          installationId: repo.installationId,
          githubRepositoryId: repo.githubRepositoryId,
          defaultBranch: repo.defaultBranch,
          // Only a completed, unfailed generation proves its commit is indexed.
          indexedSource:
            repo.indexStatus === "completed" &&
            repo.ragStatus === "completed" &&
            repo.indexSource?.indexVersion === repo.indexVersion
              ? {
                  commitSha: repo.indexSource.commitSha,
                  defaultBranch: repo.indexSource.defaultBranch,
                }
              : null,
        })),
      scanned: result.page.length,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
