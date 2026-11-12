import { query, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { checkRepositoryAccess } from "../_utils/accessControl";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import {
  getIncrementalIndexStaleAt,
  INDEXING_STALE_THRESHOLD_MS,
} from "./readiness";

async function canReadRepositoryFileCache(
  ctx: QueryCtx,
  repository: Doc<"repositories">,
  userId: Id<"users">,
): Promise<boolean> {
  if (
    repository.userId !== userId ||
    repository.isActive !== true ||
    repository.githubAccessRevokedAt !== undefined ||
    repository.disconnectCleanupPending === true
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
 * Get repository indexing status
 */
export const getIndexingStatus = query({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const repo = await ctx.db.get(args.repositoryId);
    if (!repo || repo.disconnectCleanupPending === true) {
      return null;
    }
    const access = await checkRepositoryAccess(ctx, args.repositoryId, userId);
    if (!access.hasAccess) {
      return null;
    }

    const status = repo.indexStatus;
    const ragStatus = repo.ragStatus;
    const requiresReconnect = repo.githubInstallationReconnectRequired === true;
    const githubAccessRevoked = repo.githubAccessRevokedAt !== undefined;

    return {
      status,
      version: repo.indexVersion,
      lastIndexedAt: repo.lastIndexedAt,
      error: repo.indexError,
      ragStatus,
      ragError: repo.ragError,
      ragLastIndexedAt: repo.ragLastIndexedAt,
      ragTotalChunks: repo.ragTotalChunks,
      ragIndexedChunks: repo.ragIndexedChunks,
      ragFailedChunks: repo.ragFailedChunks,
      isActive: repo.isActive,
      updatedAt: repo.updatedAt,
      progressAt: repo.indexProgressAt,
      staleAt: getIncrementalIndexStaleAt({
        isActive: repo.isActive,
        indexStatus: status,
        ragStatus,
        indexProgressAt: repo.indexProgressAt,
        indexRateLimitRetryAt: repo.indexRateLimitRetryAt,
      }),
      staleThresholdMs: INDEXING_STALE_THRESHOLD_MS,
      githubAccessRevoked,
      canRestoreGithubAccess:
        githubAccessRevoked && !requiresReconnect && repo.userId === userId,
      requiresReconnect,
      canReconnect: requiresReconnect && repo.userId === userId,
      canRetry:
        !requiresReconnect && repo.userId === userId && !githubAccessRevoked,
    };
  },
});

/**
 * Get file content from cache
 */
export const getFileContent = query({
  args: {
    repositoryId: v.id("repositories"),
    filePath: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const repo = await ctx.db.get(args.repositoryId);
    if (!repo || !(await canReadRepositoryFileCache(ctx, repo, userId))) {
      return null;
    }

    // Get file mapping
    const fileMap = await ctx.db
      .query("repoFileMap")
      .withIndex("by_repository_and_path", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("filePath", args.filePath),
      )
      .first();

    if (!fileMap) {
      return null;
    }

    // Get blob
    const blob = await ctx.db
      .query("repoFileBlobs")
      .withIndex("by_sha256", (q) => q.eq("sha256", fileMap.sha256))
      .first();

    if (!blob) {
      return null;
    }

    // Return storage URL for fetching
    const url = await ctx.storage.getUrl(blob.storageId);
    if (!url) {
      return null;
    }

    return {
      filePath: fileMap.filePath,
      sha256: fileMap.sha256,
      language: fileMap.language,
      size: fileMap.size,
      isText: fileMap.isText,
      url,
    };
  },
});

/**
 * Get file list for repository
 */
export const getFileList = query({
  args: {
    repositoryId: v.id("repositories"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const repo = await ctx.db.get(args.repositoryId);
    if (!repo || !(await canReadRepositoryFileCache(ctx, repo, userId))) {
      return [];
    }

    const requestedLimit = args.limit ?? 500;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 500)
      : 500;
    const files = await ctx.db
      .query("repoFileMap")
      .withIndex("by_repository", (q) =>
        q.eq("repositoryId", args.repositoryId),
      )
      .take(limit);

    return files;
  },
});

/**
 * Get indexing logs for a repository
 * Returns logs for the current indexVersion only
 */
export const getIndexingLogs = query({
  args: {
    repositoryId: v.id("repositories"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const repo = await ctx.db.get(args.repositoryId);
    if (!repo || repo.disconnectCleanupPending === true) {
      return [];
    }
    const access = await checkRepositoryAccess(ctx, args.repositoryId, userId);
    if (!access.hasAccess) {
      return [];
    }

    const currentVersion = repo.indexVersion;
    const requestedLimit = args.limit ?? 100;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 500)
      : 100;

    // Get logs for the current index version only
    const logs = await ctx.db
      .query("repoIndexingLogs")
      .withIndex("by_repository_and_version", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .eq("indexVersion", currentVersion),
      )
      .order("desc")
      .take(limit);

    return logs.reverse(); // Show oldest first
  },
});
