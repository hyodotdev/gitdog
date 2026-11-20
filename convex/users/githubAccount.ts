import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

type ReadCtx = Pick<QueryCtx, "db">;

/** A GitHub user id: a positive integer, as a string. */
export function readGitHubAccountId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  return Number.isSafeInteger(Number(value)) ? value : null;
}

/**
 * The one Gitdog user signed in with this GitHub account, or null when none
 * or, against the invariant, more than one claims it.
 */
export async function readUserIdByGitHubAccountId(
  ctx: ReadCtx,
  value: string,
): Promise<Id<"users"> | null> {
  const githubAccountId = readGitHubAccountId(value);
  if (githubAccountId === null) return null;
  const owners = await ctx.db
    .query("users")
    .withIndex("by_github_account_id", (q) =>
      q.eq("githubAccountId", githubAccountId),
    )
    .take(2);
  return owners.length === 1 ? owners[0]._id : null;
}

/**
 * The GitHub account a Gitdog user signs in with, or null when the user has
 * none or another user claims the same account. Installation access is
 * attested against it.
 */
export async function readLinkedGitHubAccountId(
  ctx: ReadCtx,
  userId: Id<"users">,
): Promise<string | null> {
  const user = await ctx.db.get(userId);
  const githubAccountId = readGitHubAccountId(user?.githubAccountId);
  if (githubAccountId === null) return null;
  return (await readUserIdByGitHubAccountId(ctx, githubAccountId)) === userId
    ? githubAccountId
    : null;
}
