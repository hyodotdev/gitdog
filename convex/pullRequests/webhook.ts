import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export async function handlePullRequestEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  if (
    ![
      "opened",
      "synchronize",
      "reopened",
      "ready_for_review",
      "edited",
      "closed",
      "converted_to_draft",
    ].includes(String(payload.action))
  )
    return;
  const { repository, installation, pull_request: pr } = payload;
  if (
    !record(repository) ||
    !record(installation) ||
    !record(pr) ||
    !Number.isSafeInteger(repository.id) ||
    (repository.id as number) < 1 ||
    !Number.isSafeInteger(installation.id) ||
    (installation.id as number) < 1 ||
    !Number.isSafeInteger(pr.number) ||
    (pr.number as number) < 1
  )
    return;
  const repo = await ctx.runQuery(
    internal.repositories.internalQuery.getByInstallationAndGitHubRepositoryId,
    {
      installationId: installation.id as number,
      githubRepositoryId: repository.id as number,
    },
  );
  if (
    !repo ||
    repo.settings.pullRequestReviewsEnabled !== true ||
    repo.isActive !== true
  )
    return;
  // Payload body, head and state are hints only; the worker reads GitHub's live
  // immutable repository identity and current PR state before scheduling AI.
  await ctx.scheduler.runAfter(
    0,
    internal.pullRequests.internalAction.observe,
    { repositoryId: repo._id, number: pr.number as number },
  );
}
