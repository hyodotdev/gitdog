import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { commandAccess, parseReviewCommand } from "./commands";

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

/**
 * A "@gitdogbot <command>" comment on a pull request. Only the PR author and
 * repository collaborators can run commands, and a redelivered comment runs
 * once.
 */
export async function handlePullRequestCommentEvent(
  ctx: ActionCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  if (payload.action !== "created") return;
  const { repository, installation, issue, comment } = payload;
  if (
    !record(repository) ||
    !record(installation) ||
    !record(issue) ||
    !record(comment) ||
    !record(comment.user) ||
    !Number.isSafeInteger(repository.id) ||
    !Number.isSafeInteger(installation.id) ||
    !Number.isSafeInteger(issue.number) ||
    !Number.isSafeInteger(comment.id) ||
    !Number.isSafeInteger(comment.user.id) ||
    typeof comment.user.login !== "string" ||
    typeof comment.body !== "string" ||
    comment.user.type === "Bot"
  )
    return;
  const command = parseReviewCommand(comment.body);
  if (!command) return;
  const author = record(issue.user) ? issue.user.id : undefined;
  const access = commandAccess(
    comment.author_association,
    comment.user.id as number,
    typeof author === "number" ? author : undefined,
  );
  if (!access) return;
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
  const run = command === "unknown" ? "help" : command;
  // Recorded and scheduled in one transaction, so a redelivery never runs a
  // command twice and a recorded command always runs.
  await ctx.runMutation(internal.pullRequests.internalMutation.recordCommand, {
    repositoryId: repo._id,
    githubNumber: issue.number as number,
    commentId: comment.id as number,
    githubUserId: comment.user.id as number,
    login: comment.user.login,
    command: run,
    allowed: run !== "full_review" || access === "collaborator",
  });
}
