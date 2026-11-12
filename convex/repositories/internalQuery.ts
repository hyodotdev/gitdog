import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { readRepositoryAiAccessSnapshot } from "./aiReadiness";
import {
  readRepositoriesByInstallationAndGitHubRepositoryId,
  REPOSITORY_IDENTITY_MATCH_LIMIT,
  resolveUniquePreferredRepositoryIdentity,
} from "./immutableIdentity";

/**
 * Get repository by ID (internal - no auth required)
 * Used by background jobs and actions
 */
export const getById = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args): Promise<Doc<"repositories"> | null> => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo || repo.disconnectCleanupPending === true) {
      return null;
    }
    return repo;
  },
});

/** Read immutable identity while disconnect cleanup performs read-only reconciliation. */
export const getByIdIncludingDisconnecting = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args): Promise<Doc<"repositories"> | null> =>
    await ctx.db.get(args.repositoryId),
});

/** Pin one installation-ready repository generation for AI cache access. */
export const getAiAccessSnapshot = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ indexVersion: number } | null> => {
    const snapshot = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.expectedIndexVersion,
    );
    return snapshot ? { indexVersion: snapshot.indexVersion } : null;
  },
});

/** Bounded watchdog scan for restored repositories whose re-index is due. */
export const listDueAccessRestoreIndexRetries = internalQuery({
  args: {
    now: v.number(),
  },
  handler: async (ctx, args): Promise<Array<Doc<"repositories">>> => {
    return await ctx.db
      .query("repositories")
      .withIndex("by_access_restore_index_retry", (q) =>
        q
          .eq("githubAccessRestoreIndexPending", true)
          .lte("githubAccessRestoreIndexNextAttemptAt", args.now),
      )
      .take(25);
  },
});

/** Locate a signed webhook repository without crossing installation scope. */
export const getByInstallationAndGitHubRepositoryId = internalQuery({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
  },
  handler: async (ctx, args) => {
    const repositories =
      await readRepositoriesByInstallationAndGitHubRepositoryId(
        ctx,
        args.installationId,
        args.githubRepositoryId,
      );
    return resolveUniquePreferredRepositoryIdentity(repositories).repository;
  },
});

/** Locate connected rows across renames and account transfers. */
export const listByGitHubRepositoryId = internalQuery({
  args: {
    githubRepositoryId: v.number(),
  },
  handler: async (ctx, args) => {
    const repositories = await ctx.db
      .query("repositories")
      .withIndex("by_github_repository_id", (q) =>
        q.eq("githubRepositoryId", args.githubRepositoryId),
      )
      .take(REPOSITORY_IDENTITY_MATCH_LIMIT + 1);
    if (repositories.length > REPOSITORY_IDENTITY_MATCH_LIMIT) {
      throw new Error("repository identity lookup exceeded its safety limit");
    }
    return repositories;
  },
});
