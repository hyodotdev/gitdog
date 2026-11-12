import { query } from "../_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { getTrustedLearningRepositoryKey } from "./trust";

/**
 * Count trusted learnings that are visible to repository vector search
 *
 * Note: This collects all documents to count them, which is acceptable for
 * typical usage (< 1000 trusted learnings per repo). For high-volume scenarios,
 * consider maintaining a counter field on the repositories table.
 */
export const countByRepository = query({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return 0;
    }

    // Verify user has access to this repository
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo ||
      repo.disconnectCleanupPending === true ||
      repo.userId !== userId
    ) {
      return 0;
    }

    const learnings = await ctx.db
      .query("repoLearnings")
      .withIndex("by_repository_trust_key", (q) =>
        q.eq(
          "repositoryTrustKey",
          getTrustedLearningRepositoryKey(args.repositoryId),
        ),
      )
      .collect();

    return learnings.length;
  },
});
