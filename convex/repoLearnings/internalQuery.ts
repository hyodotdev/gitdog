import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { readRepositoryAiAccessSnapshot } from "../repositories/aiReadiness";
import { getTrustedLearningRepositoryKey } from "./trust";

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
