import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type QueryCtx } from "../_generated/server";

// Everything here goes once production has run migrateToAuthV2 and the
// legacy tables are dropped from the schema.

/**
 * The user a GitHub account belonged to under @convex-dev/auth 0.0.x, for a
 * sign-in that lands before migrateToAuthV2 has linked it.
 */
export async function readLegacyGitHubUserId(
  ctx: Pick<QueryCtx, "db">,
  githubAccountId: string,
): Promise<Id<"users"> | null> {
  const account = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", "github").eq("providerAccountId", githubAccountId),
    )
    .unique();
  return account && (await ctx.db.get(account.userId)) ? account.userId : null;
}

const LEGACY_AUTH_TABLES = [
  "authAccounts",
  "authSessions",
  "authRefreshTokens",
  "authVerificationCodes",
  "authVerifiers",
  "authRateLimits",
] as const;
const MIGRATION_BATCH = 1_000;

/**
 * One-off move from @convex-dev/auth 0.0.x to 2.0: copy each GitHub account
 * onto its user, then delete the old auth rows. Deleting sessions and refresh
 * tokens signs every client out. Run it until `done` is true; each run handles
 * one bounded batch.
 */
export const migrateToAuthV2 = internalMutation({
  args: {},
  returns: v.object({
    linkedUsers: v.number(),
    deletedRows: v.number(),
    done: v.boolean(),
  }),
  handler: async (ctx) => {
    const accounts = await ctx.db.query("authAccounts").take(MIGRATION_BATCH);
    let linkedUsers = 0;
    for (const account of accounts) {
      if (account.provider !== "github") continue;
      const user = await ctx.db.get(account.userId);
      if (!user) continue;
      if (user.githubAccountId === account.providerAccountId) continue;
      const claimed = await ctx.db
        .query("users")
        .withIndex("by_github_account_id", (q) =>
          q.eq("githubAccountId", account.providerAccountId),
        )
        .first();
      if (user.githubAccountId !== undefined || claimed)
        throw new Error(
          `GitHub account ${account.providerAccountId} conflicts with an existing link`,
        );
      await ctx.db.patch(user._id, {
        githubAccountId: account.providerAccountId,
      });
      linkedUsers++;
    }

    let deletedRows = 0;
    for (const table of LEGACY_AUTH_TABLES) {
      const rows = await ctx.db
        .query(table)
        .take(MIGRATION_BATCH - deletedRows);
      for (const row of rows) await ctx.db.delete(row._id);
      deletedRows += rows.length;
      if (deletedRows >= MIGRATION_BATCH) break;
    }
    return {
      linkedUsers,
      deletedRows,
      done: deletedRows < MIGRATION_BATCH,
    };
  },
});
