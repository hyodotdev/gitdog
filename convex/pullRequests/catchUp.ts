import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// Turning reviews off and on again cannot start this more than once an hour.
const CATCH_UP_COOLDOWN_MS = 60 * 60_000;

/**
 * Reviews start on pull request events, so pull requests opened before
 * reviews were on never get one. Each path that turns reviews on for an
 * active repository calls this; it schedules a few of them for review.
 */
export async function reviewOpenPullRequests(
  ctx: MutationCtx,
  repository: Doc<"repositories">,
): Promise<void> {
  const now = Date.now();
  if (
    repository.pullRequestCatchUpAt !== undefined &&
    now - repository.pullRequestCatchUpAt < CATCH_UP_COOLDOWN_MS
  )
    return;
  await ctx.db.patch(repository._id, { pullRequestCatchUpAt: now });
  await ctx.scheduler.runAfter(
    0,
    internal.pullRequests.internalAction.reviewOpenPullRequests,
    { repositoryId: repository._id },
  );
}

/** Whether a settings change turns pull request reviews on. */
export function turnsReviewsOn(
  before: Doc<"repositories">["settings"],
  after: { pullRequestReviewsEnabled?: boolean },
): boolean {
  return (
    before.pullRequestReviewsEnabled !== true &&
    after.pullRequestReviewsEnabled === true
  );
}
