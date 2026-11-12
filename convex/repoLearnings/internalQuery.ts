import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { readRepositoryAiAccessSnapshot } from "../repositories/aiReadiness";
import { getTrustedLearningRepositoryKey } from "./trust";

export const getById = internalQuery({
  args: {
    id: v.id("repoLearnings"),
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const access = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.expectedIndexVersion,
    );
    if (!access) {
      return null;
    }

    const learning = await ctx.db.get(args.id);
    return learning?.repositoryId === args.repositoryId ? learning : null;
  },
});

export const keywordSearch = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    query: v.string(),
    limit: v.number(),
    embeddingDataProvenance: v.union(
      v.literal("public_github"),
      v.literal("private_user_input"),
    ),
  },
  handler: async (ctx, args) => {
    const access = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.expectedIndexVersion,
    );
    if (!access) {
      return [];
    }

    return await ctx.db
      .query("repoLearnings")
      .withSearchIndex("search_text", (q) => {
        const trustedQuery = q
          .search("content", args.query)
          .eq(
            "repositoryTrustKey",
            getTrustedLearningRepositoryKey(args.repositoryId),
          );

        return args.embeddingDataProvenance === "public_github"
          ? trustedQuery.eq("embeddingDataProvenance", "public_github")
          : trustedQuery;
      })
      .take(Math.min(Math.max(args.limit, 1), 20));
  },
});

export const hasTrustedEmbeddingInScope = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
    embeddingScopeKey: v.string(),
    embeddingDataProvenance: v.union(
      v.literal("public_github"),
      v.literal("private_user_input"),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const access = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.expectedIndexVersion,
    );
    if (!access) {
      return false;
    }

    const repositoryTrustKey = getTrustedLearningRepositoryKey(
      args.repositoryId,
    );
    const learning =
      args.embeddingDataProvenance === "public_github"
        ? await ctx.db
            .query("repoLearnings")
            .withIndex("by_repository_trust_and_public_embedding_scope", (q) =>
              q
                .eq("repositoryId", args.repositoryId)
                .eq("repositoryTrustKey", repositoryTrustKey)
                .eq("publicEmbeddingScopeKey", args.embeddingScopeKey),
            )
            .first()
        : await ctx.db
            .query("repoLearnings")
            .withIndex("by_repository_trust_and_embedding_scope", (q) =>
              q
                .eq("repositoryId", args.repositoryId)
                .eq("repositoryTrustKey", repositoryTrustKey)
                .eq("embeddingScopeKey", args.embeddingScopeKey),
            )
            .first();

    return learning !== null;
  },
});
