import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import {
  COMMAND_PAUSE_MS,
  COMMANDS_PER_DAY,
  COMMANDS_PER_HOUR,
} from "./commands";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";
import { hasCurrentLegalAttestation } from "../users/legal";
import { checkAccountTokenAllowance } from "../subscriptions/internalQuery";
import { isUsableProviderKey } from "../providerApiKeys/usability";
import { settleThenGrantTrialCredit } from "../subscriptions/credit";
import type { ReviewQuotaRefusal } from "./errors";
import {
  MAX_OPEN_REQUESTS,
  findingBody,
  findingValidator,
  openRequestNotes,
  reviewBatchProgressValidator,
  reviewSummary,
} from "./review";
import { isBotPullRequestAuthor, REVIEW_BATCH_TOKEN_ESTIMATE } from "./github";

const snapshotValidator = v.object({
  headSha: v.string(),
  baseSha: v.string(),
  title: v.string(),
  body: v.string(),
});
const SUPERSEDED_REVIEW =
  "Pull request changed or closed; this review is superseded";

async function listTicketActions(ctx: MutationCtx, ticketId: Id<"tickets">) {
  const actions = await ctx.db
    .query("ticketActions")
    .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
    .take(1001);
  if (actions.length > 1000)
    throw new Error("Pull request review history exceeds its bound");
  return actions;
}

function isAutomaticReviewForHead(
  action: Doc<"ticketActions">,
  headSha: string,
) {
  return (
    action.actionType === "review" &&
    action.reviewVerificationOnly !== true &&
    action.proposedChanges?.source?.headSha === headSha
  );
}

// Ending a batch, by any path, also releases its quota hold.
const ENDED_BATCH = {
  reviewBatch: undefined,
  reviewQuotaUserId: undefined,
  reviewQuotaHold: undefined,
};
const MAX_QUOTA_HOLDS = 50;
// User-facing failure for each quota refusal, shared with generation.
export const REVIEW_QUOTA_FAILURES: Record<ReviewQuotaRefusal, string> = {
  insufficient:
    "Not enough tokens remain for this pull request review. No review was published.",
  unverified:
    "The token balance could not be verified for this pull request review. No review was published.",
  busy: "Too many batched reviews are in progress for this account. No review was published.",
};

// Title and description edits do not change what a review of a commit covers.
function sameCommit(
  source: { headSha?: unknown; baseSha?: unknown } | undefined,
  other: { headSha: string; baseSha: string },
) {
  return source?.headSha === other.headSha && source?.baseSha === other.baseSha;
}

// The first worker runs without a cursor; each later one owns one page group.
function isBatchCursor(
  batch: { page: number; group?: number } | undefined,
  args: { page?: number; group?: number },
) {
  return batch?.page === args.page && (batch?.group ?? 0) === (args.group ?? 0);
}

/**
 * The newest automatic review that finished, which a later push can build on
 * instead of reviewing the whole PR again.
 */
function latestFinishedReview(
  actions: Doc<"ticketActions">[],
  headSha?: string,
) {
  let latest: Doc<"ticketActions"> | undefined;
  for (const action of actions) {
    if (
      action.actionType !== "review" ||
      action.reviewVerificationOnly === true ||
      action.status !== "completed" ||
      (action.executionResult?.published !== true &&
        action.executionResult?.reason !== "no_new_changes") ||
      (headSha !== undefined &&
        action.proposedChanges?.source?.headSha !== headSha)
    )
      continue;
    if (!latest || action.createdAt > latest.createdAt) latest = action;
  }
  return latest;
}

function lastReviewed(actions: Doc<"ticketActions">[], headSha: string) {
  // A rerun on the same head scopes from the review before it, never from a
  // review of this head, which would make it review the whole PR.
  const latest = latestFinishedReview(
    actions.filter(
      (action) => action.proposedChanges?.source?.headSha !== headSha,
    ),
  );
  const proposal = latest?.proposedChanges;
  const source = proposal?.source;
  // Older reviews do not record the merge base or their coverage counts, so
  // the next push reviews the whole PR. By design, files a review could not
  // cover, for whatever reason, are not offered again unless a later push
  // changes them, so a small push never pays to resend them.
  if (
    typeof source?.headSha !== "string" ||
    typeof proposal.mergeBaseSha !== "string" ||
    source.headSha === headSha ||
    typeof proposal.uncoveredFiles !== "number"
  )
    return undefined;
  return {
    headSha: source.headSha as string,
    mergeBaseSha: proposal.mergeBaseSha as string,
  };
}

/** A review whose model request or GitHub post may be in flight. */
function isRunningReview(action: Doc<"ticketActions">) {
  return (
    action.actionType === "review" &&
    ((action.status === "pending" &&
      action.reviewGenerationToken !== undefined) ||
      (action.status === "approved" && action.executionClaimedAt !== undefined))
  );
}

/**
 * Once a review stops running, observe the PR again if a push was dropped
 * meanwhile, so the newest head is reviewed from the commit just reviewed.
 */
async function observeDroppedPush(ctx: MutationCtx, ticketId: Id<"tickets">) {
  const ticket = await ctx.db.get(ticketId);
  if (ticket?.pullRequestDroppedAt === undefined || !ticket.repositoryId)
    return;
  const actions = await listTicketActions(ctx, ticket._id);
  if (actions.some(isRunningReview)) return;
  await ctx.db.patch(ticket._id, { pullRequestDroppedAt: undefined });
  await ctx.scheduler.runAfter(
    0,
    internal.pullRequests.internalAction.observe,
    { repositoryId: ticket.repositoryId, number: ticket.githubNumber },
  );
}

/** Bring a review's status comment on the pull request up to date. */
async function settleStatus(ctx: MutationCtx, actionId: Id<"ticketActions">) {
  await ctx.scheduler.runAfter(
    0,
    internal.pullRequests.internalAction.settleStatusComment,
    { actionId },
  );
}

function hasAttemptedReview(action: Doc<"ticketActions">) {
  if (action.reviewGenerationToken !== undefined) return true;
  // Keep the slot available when a queued review was superseded before its worker started.
  return (
    action.status !== "pending" &&
    !(action.status === "failed" && action.errorMessage === SUPERSEDED_REVIEW)
  );
}

export const queueVerification = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    requestedByUserId: v.id("users"),
    source: snapshotValidator,
    observedAt: v.number(),
    expectedObservedAt: v.optional(v.number()),
    author: v.string(),
    open: v.boolean(),
  },
  handler: async (ctx, args) => {
    const failed = await ctx.db.get(args.actionId);
    const ticket = failed ? await ctx.db.get(failed.ticketId) : null;
    const repo = ticket?.repositoryId
      ? await ctx.db.get(ticket.repositoryId)
      : null;
    if (
      !failed ||
      failed.actionType !== "review" ||
      failed.status !== "failed" ||
      !ticket ||
      ticket.ticketType !== "pull_request" ||
      ticket.deletedAt !== undefined ||
      ticket.userId !== args.requestedByUserId ||
      !repo ||
      repo.userId !== args.requestedByUserId ||
      !repo.isActive ||
      repo.disconnectCleanupPending ||
      repo.githubAccessRevokedAt !== undefined ||
      repo.settings.pullRequestReviewsEnabled !== true ||
      isBotPullRequestAuthor({ login: args.author })
    )
      throw new Error(
        "Review cannot be rechecked with the current access or settings",
      );
    const install = await getExactGitHubInstallation(ctx, repo.installationId);
    if (!isGitHubInstallationReady(install) || install.userId !== repo.userId)
      throw new Error("Repository installation is unavailable");
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", repo.userId))
      .take(2);
    if (profiles.length !== 1 || !hasCurrentLegalAttestation(profiles[0]))
      throw new Error("Current AI legal attestation is required");
    const commitChanged = !sameCommit(
      {
        headSha: ticket.pullRequestHeadSha,
        baseSha: ticket.pullRequestBaseSha,
      },
      args.source,
    );
    const changed =
      commitChanged ||
      ticket.githubTitle !== args.source.title ||
      ticket.githubBody !== args.source.body;
    const actions = await listTicketActions(ctx, ticket._id);
    const matches = (a: (typeof actions)[number]) =>
      sameCommit(a.proposedChanges?.source, args.source);
    const pending = actions.find(
      (a) =>
        a.actionType === "review" &&
        a.status === "pending" &&
        matches(a) &&
        a.reviewVerificationOnly === true,
    );
    if (ticket.pullRequestObservedAt !== args.expectedObservedAt) {
      if (
        pending &&
        !commitChanged &&
        ticket.status === (args.open ? "open" : "closed")
      )
        return pending._id;
      throw new Error(
        "A newer pull request update arrived; request a fresh recheck",
      );
    }
    // A recheck never cancels a review mid-request.
    if (actions.some(isRunningReview))
      throw new Error("A review is already running; recheck after it finishes");
    for (const action of actions) {
      if (
        ["pending", "pending_approval", "approved"].includes(action.status) &&
        action.executionClaimedAt === undefined &&
        (!matches(action) ||
          (!args.open && action.reviewVerificationOnly !== true))
      ) {
        await ctx.db.patch(action._id, {
          status: "failed",
          errorMessage: SUPERSEDED_REVIEW,
          ...ENDED_BATCH,
          completedAt: Date.now(),
        });
        if (action.statusCommentId !== undefined)
          await settleStatus(ctx, action._id);
      }
    }
    await ctx.db.patch(ticket._id, {
      pullRequestObservedAt: Math.max(
        ticket.pullRequestObservedAt ?? 0,
        args.observedAt,
      ),
      pullRequestHeadSha: args.source.headSha,
      pullRequestBaseSha: args.source.baseSha,
      githubTitle: args.source.title,
      githubBody: args.source.body,
      githubAuthor: args.author,
      aiInputVersion: changed
        ? ticket.aiInputVersion + 1
        : ticket.aiInputVersion,
      status: args.open ? "open" : "closed",
      closedAt: args.open ? undefined : (ticket.closedAt ?? Date.now()),
    });
    if (pending) return pending._id;
    if (
      args.open &&
      actions.some(
        (a) =>
          a.actionType === "review" &&
          a.status === "pending" &&
          matches(a) &&
          a.reviewVerificationOnly !== true,
      )
    )
      throw new Error("Another review is already processing");
    const actionId = await ctx.db.insert("ticketActions", {
      ticketId: ticket._id,
      actionType: "review",
      status: "pending",
      proposalVersion: 1,
      proposedChanges: { source: args.source },
      reviewVerificationOnly: true,
      reviewRecheckOfActionId: failed._id,
      requestedByUserId: args.requestedByUserId,
      chatHistory: [],
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      0,
      internal.pullRequests.internalAction.generate,
      { actionId },
    );
    await ctx.scheduler.runAfter(
      15 * 60_000,
      internal.pullRequests.internalMutation.expire,
      { actionId },
    );
    return actionId;
  },
});
type ObserveArgs = {
  repositoryId: Id<"repositories">;
  number: number;
  observedAt?: number;
  author: string;
  open: boolean;
  snapshot: { headSha: string; baseSha: string; title: string; body: string };
};
const UNAVAILABLE = { status: "unavailable" as const, actionId: null };
const RUNNING = { status: "running" as const, actionId: null };
const UP_TO_DATE = { status: "up_to_date" as const, actionId: null };
const AWAITING_APPROVAL = {
  status: "awaiting_approval" as const,
  actionId: null,
};
// A newer observation of the PR already won; the request read an old head.
const STALE = { status: "stale" as const, actionId: null };

/**
 * Record the PR's current state and queue a review when one is due: the
 * first review of the PR, or one a command requested ("review" covers what
 * changed since the last review, "full" the whole PR).
 */
async function observePullRequest(
  ctx: MutationCtx,
  args: ObserveArgs,
  requested?: "review" | "full",
) {
  let request = requested;
  const repo = await ctx.db.get(args.repositoryId);
  if (
    !repo ||
    repo.settings.pullRequestReviewsEnabled !== true ||
    !repo.isActive ||
    repo.disconnectCleanupPending ||
    repo.githubAccessRevokedAt !== undefined ||
    isBotPullRequestAuthor({ login: args.author })
  )
    return UNAVAILABLE;
  const install = await getExactGitHubInstallation(ctx, repo.installationId);
  if (!isGitHubInstallationReady(install) || install.userId !== repo.userId)
    return UNAVAILABLE;
  const existing = await ctx.db
    .query("tickets")
    .withIndex("by_github_number", (q) =>
      q.eq("repositoryId", repo._id).eq("githubNumber", args.number),
    )
    .take(3);
  if (
    existing.some((t) => t.ticketType !== "pull_request") ||
    existing.length > 1
  )
    throw new Error("Conflicting pull request identity");
  const now = Date.now();
  const observedAt = args.observedAt ?? now;
  let ticket = existing[0];
  if (!ticket) {
    if (!args.open) return UNAVAILABLE;
    const ticketId = await ctx.db.insert("tickets", {
      repositoryId: repo._id,
      userId: repo.userId,
      githubRepo: repo.githubRepo,
      ticketType: "pull_request",
      githubNumber: args.number,
      githubTitle: args.snapshot.title,
      githubBody: args.snapshot.body,
      githubAuthor: args.author,
      aiInputVersion: 1,
      status: "open",
      createdAt: now,
    });
    ticket = (await ctx.db.get(ticketId))!;
  }
  if (
    ticket.deletedAt !== undefined ||
    (ticket.pullRequestObservedAt ?? 0) > observedAt
  )
    return ticket.deletedAt === undefined && request ? STALE : UNAVAILABLE;
  const actions = await listTicketActions(ctx, ticket._id);
  const source = args.snapshot;
  const commitChanged = !sameCommit(
    {
      headSha: ticket.pullRequestHeadSha,
      baseSha: ticket.pullRequestBaseSha,
    },
    source,
  );
  // Gitdog's approval covered only the commit it approved.
  if (
    ticket.pullRequestApprovedSha !== undefined &&
    ticket.pullRequestApprovedSha !== source.headSha
  )
    await ctx.scheduler.runAfter(
      0,
      internal.pullRequests.internalAction.dismissStaleApproval,
      {
        repositoryId: repo._id,
        number: args.number,
        ticketId: ticket._id,
        staleSha: ticket.pullRequestApprovedSha,
      },
    );
  // A push while a review is running is dropped: the review finishes on
  // the commit it started on, and the ticket keeps that commit so a later
  // push is reviewed from there.
  if (args.open && commitChanged && actions.some(isRunningReview)) {
    const edited =
      ticket.githubTitle !== source.title || ticket.githubBody !== source.body;
    await ctx.db.patch(ticket._id, {
      pullRequestObservedAt: observedAt,
      pullRequestDroppedAt: now,
      githubTitle: source.title,
      githubBody: source.body,
      aiInputVersion: edited
        ? ticket.aiInputVersion + 1
        : ticket.aiInputVersion,
    });
    return RUNNING;
  }
  const changed =
    commitChanged ||
    ticket.githubTitle !== source.title ||
    ticket.githubBody !== source.body;
  // A requested review a push cancelled before it ran carries over to the
  // new head, so the command is still answered with a review.
  if (
    !request &&
    args.open &&
    commitChanged &&
    actions.some(
      (action) =>
        action.reviewRequested === true &&
        action.status === "pending" &&
        action.reviewGenerationToken === undefined,
    )
  )
    request = "review";
  const sameHeadReviews = actions.filter((action) =>
    isAutomaticReviewForHead(action, source.headSha),
  );
  const attempted = sameHeadReviews.some(hasAttemptedReview);
  const queued =
    args.open && !sameHeadReviews.some(hasAttemptedReview)
      ? sameHeadReviews.find((action) => action.status === "pending")
      : undefined;
  // Without a command, only a pull request's first review runs. A first
  // review that failed does not count, so the next push tries again.
  const reviewedBefore = actions.some(
    (action) =>
      action.actionType === "review" &&
      action.reviewVerificationOnly !== true &&
      action.status === "completed" &&
      (action.executionResult?.published === true ||
        action.executionResult?.reason === "no_new_changes"),
  );
  for (const action of actions) {
    if (action._id === queued?._id) {
      const queuedSource = action.proposedChanges?.source;
      if (
        queuedSource?.baseSha !== source.baseSha ||
        queuedSource.title !== source.title ||
        queuedSource.body !== source.body
      ) {
        await ctx.db.patch(action._id, { proposedChanges: { source } });
      }
      continue;
    }
    if (
      (!args.open || commitChanged) &&
      (action.reviewVerificationOnly !== true || commitChanged) &&
      ["pending", "pending_approval", "approved"].includes(action.status) &&
      action.executionClaimedAt === undefined
    ) {
      await ctx.db.patch(action._id, {
        status: "failed",
        errorMessage: SUPERSEDED_REVIEW,
        ...ENDED_BATCH,
        completedAt: now,
      });
      if (action.statusCommentId !== undefined)
        await settleStatus(ctx, action._id);
    }
  }
  await ctx.db.patch(ticket._id, {
    pullRequestObservedAt: observedAt,
    status: args.open ? "open" : "closed",
    closedAt: args.open ? undefined : now,
    pullRequestHeadSha: source.headSha,
    pullRequestBaseSha: source.baseSha,
    // The newest head is now observed, so nothing is waiting to be.
    pullRequestDroppedAt: undefined,
    githubTitle: source.title,
    githubBody: source.body,
    aiInputVersion: changed ? ticket.aiInputVersion + 1 : ticket.aiInputVersion,
  });
  if (!args.open) return UNAVAILABLE;
  if (request) {
    const thisHead = actions.filter(
      (action) =>
        action.actionType === "review" &&
        action.proposedChanges?.source?.headSha === source.headSha,
    );
    // One review at a time: a queued, running or about-to-post review, or a
    // queued recheck, answers the request.
    if (
      actions.some(isRunningReview) ||
      thisHead.some(
        (action) =>
          (action.status === "pending" &&
            action.reviewGenerationToken === undefined) ||
          // Publication is scheduled; one that never claimed within the
          // expiry window is stuck and no longer holds the commit.
          (action.status === "approved" &&
            action.executionClaimedAt === undefined &&
            (action.approvedAt ?? action.createdAt) > now - 15 * 60_000),
      )
    )
      return RUNNING;
    if (sameHeadReviews.some((action) => action.status === "pending_approval"))
      return AWAITING_APPROVAL;
    // Only a finished review of this commit makes it up to date; a failed
    // or limit-stopped one can be retried. One whose post could not be
    // confirmed may already be on GitHub, so it is not posted again.
    if (
      request === "review" &&
      sameHeadReviews.some(
        (action) =>
          (action.status === "completed" &&
            (action.executionResult?.published === true ||
              // Asking again may restore an approval, for no model call.
              (action.executionResult?.reason === "no_new_changes" &&
                ticket.pullRequestApprovedSha === source.headSha))) ||
          (action.status === "failed" &&
            action.errorMessage?.startsWith(
              "GitHub publication outcome requires inspection",
            ) === true),
      )
    )
      return UP_TO_DATE;
  } else {
    if (queued) return RUNNING;
    if (attempted || reviewedBefore) return UP_TO_DATE;
  }
  const user = await ctx.db.get(repo.userId);
  const profiles = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", repo.userId))
    .take(2);
  if (
    !user ||
    profiles.length !== 1 ||
    !hasCurrentLegalAttestation(profiles[0])
  )
    return UNAVAILABLE;
  const since =
    request === "full" ? undefined : lastReviewed(actions, source.headSha);
  const actionId = await ctx.db.insert("ticketActions", {
    ticketId: ticket._id,
    actionType: "review",
    proposedChanges: { source },
    proposalVersion: 1,
    status: "pending",
    chatHistory: [],
    createdAt: now,
    ...(since ? { reviewSince: since } : {}),
    // A requested review may follow an earlier attempt on the same commit.
    ...(request ? { reviewRequested: true } : {}),
  });
  await ctx.scheduler.runAfter(
    0,
    internal.pullRequests.internalAction.generate,
    { actionId },
  );
  await ctx.scheduler.runAfter(
    15 * 60_000,
    internal.pullRequests.internalMutation.expire,
    { actionId },
  );
  return { status: "started" as const, actionId };
}

export const observe = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    number: v.number(),
    observedAt: v.optional(v.number()),
    author: v.string(),
    open: v.boolean(),
    snapshot: snapshotValidator,
  },
  handler: async (ctx, args) => (await observePullRequest(ctx, args)).actionId,
});

/** A review a PR command asked for, and what became of the request. */
export const requestReview = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    number: v.number(),
    observedAt: v.optional(v.number()),
    author: v.string(),
    open: v.boolean(),
    snapshot: snapshotValidator,
    full: v.boolean(),
  },
  handler: async (ctx, { full, ...args }) =>
    await observePullRequest(ctx, args, full ? "full" : "review"),
});
export const claimGeneration = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    page: v.optional(v.number()),
    group: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (
      !action ||
      action.actionType !== "review" ||
      action.status !== "pending"
    )
      return null;
    const batch = action.reviewBatch;
    if (args.page !== undefined) {
      if (
        !batch ||
        !isBatchCursor(batch, args) ||
        batch.claimed ||
        !action.reviewGenerationToken
      )
        return null;
      await ctx.db.patch(action._id, {
        reviewBatch: { ...batch, claimed: true },
      });
      return action.reviewGenerationToken;
    }
    if (action.reviewGenerationToken !== undefined) return null;
    const source = action.proposedChanges?.source;
    if (
      action.reviewVerificationOnly !== true &&
      typeof source?.headSha === "string"
    ) {
      const ticket = await ctx.db.get(action.ticketId);
      if (
        !ticket ||
        ticket.status !== "open" ||
        ticket.deletedAt !== undefined ||
        ticket.pullRequestHeadSha !== source.headSha ||
        ticket.pullRequestBaseSha !== source.baseSha
      ) {
        await ctx.db.patch(action._id, {
          status: "failed",
          errorMessage: SUPERSEDED_REVIEW,
          ...ENDED_BATCH,
          completedAt: Date.now(),
        });
        return null;
      }
      const actions = await listTicketActions(ctx, action.ticketId);
      if (
        action.reviewRequested !== true &&
        actions.some(
          (other) =>
            other._id !== action._id &&
            isAutomaticReviewForHead(other, source.headSha) &&
            hasAttemptedReview(other),
        )
      ) {
        await ctx.db.patch(action._id, {
          status: "failed",
          errorMessage: "Automatic review already attempted for this commit",
          completedAt: Date.now(),
        });
        return null;
      }
    }
    const token = crypto.randomUUID();
    await ctx.db.patch(action._id, { reviewGenerationToken: token });
    return token;
  },
});

type QuotaCheck =
  | { ok: true; hold: boolean }
  | { ok: false; reason: ReviewQuotaRefusal; message: string };

/**
 * Whether the account can cover `batches` more review batches for this action,
 * net of what its other in-progress batched reviews still hold. Runs inside a
 * mutation so checking and holding are one transaction.
 */
async function checkBatchQuota(
  ctx: MutationCtx,
  actionId: Id<"ticketActions">,
  userId: Id<"users">,
  batches: number,
): Promise<QuotaCheck> {
  const allowance = await checkAccountTokenAllowance(ctx, userId);
  if ("isDev" in allowance) return { ok: true, hold: false };
  if (!allowance.allowed && allowance.reason !== "limit_reached")
    return { ok: false, reason: "unverified", message: allowance.message };
  const holders = await ctx.db
    .query("ticketActions")
    .withIndex("by_review_quota_user", (q) => q.eq("reviewQuotaUserId", userId))
    .take(MAX_QUOTA_HOLDS + 1);
  let held = 0;
  for (const holder of holders) {
    if (holder._id === actionId) continue;
    // Any path that ends an action without releasing its hold is healed
    // here, so stale rows can never lock the account out.
    if (holder.status !== "pending")
      await ctx.db.patch(holder._id, {
        reviewQuotaUserId: undefined,
        reviewQuotaHold: undefined,
      });
    else held += holder.reviewQuotaHold ?? 0;
  }
  if (holders.length > MAX_QUOTA_HOLDS)
    return {
      ok: false,
      reason: "busy",
      message:
        "Too many batched reviews are in progress for this account. Retry after some of them finish.",
    };
  const remaining =
    allowance.allowed && "tokenLimit" in allowance
      ? Math.max(0, allowance.tokenLimit - allowance.tokensUsed)
      : 0;
  const available = Math.max(0, remaining - held);
  const required = batches * REVIEW_BATCH_TOKEN_ESTIMATE;
  if (available < required)
    return {
      ok: false,
      reason: "insufficient",
      message: `This pull request needs at least ${batches} more review batches, estimated at ${required.toLocaleString("en-US")} tokens; ${available.toLocaleString("en-US")} tokens remain${
        held > 0
          ? ` after ${held.toLocaleString("en-US")} held by other reviews in progress`
          : ""
      }.`,
    };
  return { ok: true, hold: true };
}

/** Check and hold the tokens a batched review is expected to need. */
export const reserveBatchedReviewQuota = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    batches: v.number(),
    // The review runs on the owner's own provider key and holds no quota.
    userKey: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { reserved: true }
    | {
        reserved: false;
        reason: ReviewQuotaRefusal;
        message: string;
        userKeyUnavailable?: true;
      }
  > => {
    const action = await ctx.db.get(args.actionId);
    const ticket = action ? await ctx.db.get(action.ticketId) : null;
    if (
      !action ||
      action.actionType !== "review" ||
      action.status !== "pending" ||
      !ticket?.repositoryId
    )
      return {
        reserved: false,
        reason: "busy",
        message: "The review is no longer pending.",
      };
    if (args.userKey) {
      const keys = await ctx.db
        .query("providerApiKeys")
        .withIndex("by_user_and_provider", (q) => q.eq("userId", ticket.userId))
        .collect();
      const now = Date.now();
      return keys.some((key) => isUsableProviderKey(key, now))
        ? { reserved: true }
        : {
            reserved: false,
            reason: "unverified",
            message: "Your AI provider API key is no longer available.",
            userKeyUnavailable: true,
          };
    }
    // Optional: an unexpected settlement problem must not end the review as
    // a failed quota check; the check below reports real quota problems.
    try {
      await settleThenGrantTrialCredit(ctx, ticket.userId);
    } catch {
      console.warn("Trial credit grant was skipped");
    }
    // The owner comes from the ticket. Indexing patches the repository
    // several times a second, and this slow usage read would conflict with
    // those writes on every retry.
    const quota = await checkBatchQuota(
      ctx,
      action._id,
      ticket.userId,
      args.batches,
    );
    if (!quota.ok)
      return { reserved: false, reason: quota.reason, message: quota.message };
    if (quota.hold)
      await ctx.db.patch(action._id, {
        reviewQuotaUserId: ticket.userId,
        reviewQuotaHold: args.batches * REVIEW_BATCH_TOKEN_ESTIMATE,
      });
    return { reserved: true };
  },
});

export const propose = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    source: snapshotValidator,
    findings: v.array(findingValidator),
    openRequests: v.optional(
      v.array(v.object({ author: v.string(), request: v.string() })),
    ),
    excludedPaths: v.array(v.string()),
    refusedPaths: v.optional(v.array(v.string())),
    filesRead: v.array(v.string()),
    page: v.optional(v.number()),
    group: v.optional(v.number()),
    next: v.optional(v.object({ page: v.number(), group: v.number() })),
    batchProgress: v.optional(reviewBatchProgressValidator),
    // A single review's finding count when more were found than kept.
    findingCount: v.optional(v.number()),
    // Coverage of a single (non-batched) review; batches carry their own.
    // The merge base the review compared against, so a later push can tell
    // whether a merge of the base branch brought new changes into the diff.
    mergeBaseSha: v.optional(v.string()),
    coverage: v.optional(
      v.object({
        changedFiles: v.number(),
        uncoveredFiles: v.number(),
        // Set when only the files changed since this reviewed head were covered.
        since: v.optional(v.string()),
        removedFiles: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    const ticket = action ? await ctx.db.get(action.ticketId) : null;
    const repo = ticket?.repositoryId
      ? await ctx.db.get(ticket.repositoryId)
      : null;
    if (
      !action ||
      action.actionType !== "review" ||
      action.status !== "pending" ||
      !isBatchCursor(action.reviewBatch, args) ||
      (action.reviewBatch &&
        (!action.reviewBatch.claimed || !args.batchProgress)) ||
      !ticket ||
      (ticket.status !== "open" && action.reviewVerificationOnly !== true) ||
      ticket.deletedAt !== undefined ||
      !repo ||
      repo.settings.pullRequestReviewsEnabled !== true ||
      !repo.isActive ||
      repo.disconnectCleanupPending ||
      ticket.pullRequestHeadSha !== args.source.headSha ||
      ticket.pullRequestBaseSha !== args.source.baseSha
    )
      return false;
    const batch = args.batchProgress;
    if (batch && args.next) {
      const { page, group } = args.next;
      const hold = batch.remainingBatches * REVIEW_BATCH_TOKEN_ESTIMATE;
      // A page that split into more groups than estimated needs more tokens:
      // check again and stop now rather than at the account limit.
      if (action.reviewQuotaUserId && hold > (action.reviewQuotaHold ?? 0)) {
        const quota = await checkBatchQuota(
          ctx,
          action._id,
          action.reviewQuotaUserId,
          batch.remainingBatches,
        );
        if (!quota.ok) {
          await ctx.db.patch(action._id, {
            ...ENDED_BATCH,
            status: "failed",
            errorMessage: REVIEW_QUOTA_FAILURES[quota.reason],
            reviewFailureDetails: `Stage · Token quota check (review batch ${page})\nReason · ${quota.message}`,
            completedAt: Date.now(),
          });
          await settleStatus(ctx, action._id);
          return false;
        }
      }
      // Hold only what the remaining batches are still expected to spend.
      await ctx.db.patch(action._id, {
        ...(action.reviewQuotaUserId ? { reviewQuotaHold: hold } : {}),
        reviewBatch: {
          page,
          group,
          claimed: false,
          result: {
            ...batch,
            findings: args.findings,
            filesRead: args.filesRead,
            excludedPaths: args.excludedPaths,
            refusedPaths: args.refusedPaths,
          },
        },
      });
      await ctx.scheduler.runAfter(
        0,
        internal.pullRequests.internalAction.generate,
        { actionId: action._id, page, group },
      );
      await ctx.scheduler.runAfter(
        15 * 60_000,
        internal.pullRequests.internalMutation.expire,
        { actionId: action._id, page, group },
      );
      return true;
    }
    // Reviewer requests left open are reported in the review like findings.
    const openRequests = args.openRequests?.slice(0, MAX_OPEN_REQUESTS) ?? [];
    const noFindings = args.findings.length === 0 && openRequests.length === 0;
    // A push that changed nothing in the PR diff, such as a base merge.
    const nothingNew = noFindings && args.coverage?.changedFiles === 0;
    const verificationOnly = action.reviewVerificationOnly === true;
    const approval = repo.settings.requireApprovalForPullRequests !== false;
    const suggestions = repo.settings.pullRequestSuggestionsEnabled !== false;
    const coverage = batch ?? args.coverage;
    // Whether every file of the PR so far was reviewed: by this review, and
    // for a follow-up also by the review it built on.
    const since = batch ? undefined : args.coverage?.since;
    const base = since
      ? latestFinishedReview(await listTicketActions(ctx, ticket._id), since)
      : undefined;
    // An earlier finding without its own thread can never be seen resolved.
    const baseFindings =
      base?.proposedChanges?.findingCount ??
      base?.proposedChanges?.findings?.length;
    // A deletion is never reviewed: nothing added remains to point at.
    const coverageComplete =
      coverage !== undefined &&
      coverage.uncoveredFiles === 0 &&
      !args.coverage?.removedFiles &&
      // A review that reviewed nothing approves nothing.
      (since !== undefined || coverage.changedFiles > 0) &&
      (!since ||
        (base?.proposedChanges?.coverageComplete === true &&
          (baseFindings === 0 ||
            base.executionResult?.inlineFindings === true)));
    // A requested follow-up with nothing new still posts when it can
    // approve, so "@gitdogai review" restores an approval a push such as a
    // base merge withdrew.
    const unpublished = verificationOnly || (nothingNew && !coverageComplete);
    await ctx.db.patch(action._id, {
      ...ENDED_BATCH,
      proposedChanges: {
        source: args.source,
        ...(batch
          ? {
              batchCount: batch.batchCount,
              findingCount: batch.findingCount,
              changedFiles: batch.changedFiles,
              uncoveredFiles: batch.uncoveredFiles,
              coverageLimited: batch.coverageLimited,
            }
          : args.coverage
            ? {
                changedFiles: args.coverage.changedFiles,
                uncoveredFiles: args.coverage.uncoveredFiles,
                ...(args.coverage.since
                  ? { reviewedSince: args.coverage.since }
                  : {}),
                ...(args.findingCount !== undefined
                  ? { findingCount: args.findingCount }
                  : {}),
              }
            : {}),
        findings: args.findings,
        ...(openRequests.length ? { openRequests } : {}),
        excludedPaths: args.excludedPaths,
        ...(args.refusedPaths?.length
          ? { refusedPaths: args.refusedPaths }
          : {}),
        filesRead: args.filesRead,
        ...(args.mergeBaseSha ? { mergeBaseSha: args.mergeBaseSha } : {}),
        coverageComplete,
        // Approvers preview the posted summary and every finding, which a
        // batched review posts inline like a single one.
        suggestedResponse: [
          reviewSummary(
            batch?.findingCount ?? args.findingCount ?? args.findings.length,
            args.source.headSha,
            coverage,
            [
              ...((batch?.findingCount ?? args.findingCount ?? 0) >
              args.findings.length
                ? [
                    `Showing the ${args.findings.length} highest-priority findings out of ${batch?.findingCount ?? args.findingCount}.`,
                  ]
                : []),
              ...openRequestNotes(openRequests),
            ],
          ),
          ...args.findings.map(
            (f) => `${f.path}:${f.line}\n${findingBody(f, suggestions)}`,
          ),
        ].join("\n\n"),
      },
      // The no-findings summary is fixed text, so it needs no approval.
      status: unpublished
        ? "completed"
        : approval && !noFindings
          ? "pending_approval"
          : "approved",
      // When publication was scheduled, for the post's expiry window.
      ...(!unpublished && !(approval && !noFindings)
        ? { approvedAt: Date.now() }
        : {}),
      completedAt: unpublished ? Date.now() : undefined,
      executionResult: unpublished
        ? {
            published: false,
            reason: verificationOnly ? "verification_only" : "no_new_changes",
          }
        : undefined,
    });
    if (!unpublished && (!approval || noFindings))
      await ctx.scheduler.runAfter(
        0,
        internal.pullRequests.internalAction.publish,
        { actionId: action._id, manual: false },
      );
    // A review that ended unpublished is done, so a dropped push can be
    // reviewed now. One waiting for approval keeps it: reviewing the newer
    // head would supersede the review before the owner sees it.
    else if (unpublished) await observeDroppedPush(ctx, action.ticketId);
    // The status comment says the review is ready, waiting or found nothing.
    await settleStatus(ctx, action._id);
    return true;
  },
});

/** Observe a dropped push again when publication stopped before claiming. */
export const observeAfterUnclaimedPublication = internalMutation({
  args: { actionId: v.id("ticketActions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    // A review waiting for approval keeps a dropped push until it is acted on.
    if (
      action &&
      !isRunningReview(action) &&
      action.status !== "pending_approval"
    )
      await observeDroppedPush(ctx, action.ticketId);
  },
});

export const claim = internalMutation({
  args: { actionId: v.id("ticketActions"), manual: v.boolean() },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    const ticket = action ? await ctx.db.get(action.ticketId) : null;
    const repo = ticket?.repositoryId
      ? await ctx.db.get(ticket.repositoryId)
      : null;
    if (
      !action ||
      action.actionType !== "review" ||
      action.reviewVerificationOnly === true ||
      action.executionClaimedAt !== undefined ||
      action.status !== (args.manual ? "pending_approval" : "approved") ||
      !ticket ||
      ticket.status !== "open" ||
      ticket.deletedAt !== undefined ||
      !repo ||
      !repo.isActive ||
      repo.disconnectCleanupPending ||
      repo.githubAccessRevokedAt !== undefined ||
      repo.settings.pullRequestReviewsEnabled !== true
    )
      return false;
    // The no-findings summary is fixed text and is published without approval.
    if (
      !args.manual &&
      repo.settings.requireApprovalForPullRequests !== false &&
      action.proposedChanges?.findings?.length !== 0
    ) {
      await ctx.db.patch(action._id, { status: "pending_approval" });
      await settleStatus(ctx, action._id);
      return false;
    }
    const user = await ctx.db.get(repo.userId);
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", repo.userId))
      .take(2);
    const installation = await getExactGitHubInstallation(
      ctx,
      repo.installationId,
    );
    if (
      !user ||
      profiles.length !== 1 ||
      !hasCurrentLegalAttestation(profiles[0]) ||
      !isGitHubInstallationReady(installation) ||
      installation.userId !== repo.userId
    )
      return false;
    const claimedAt = Date.now();
    await ctx.db.patch(action._id, {
      status: "approved",
      executionClaimedAt: claimedAt,
      approvedAt: claimedAt,
    });
    await ctx.scheduler.runAfter(
      15 * 60_000,
      internal.pullRequests.internalMutation.expire,
      {
        actionId: action._id,
        claimedAt: action.executionClaimedAt ?? claimedAt,
      },
    );
    return action.executionClaimedAt ?? claimedAt;
  },
});

export const finish = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    stage: v.union(
      v.literal("generation"),
      v.literal("preflight"),
      v.literal("publication"),
    ),
    claimedAt: v.optional(v.number()),
    page: v.optional(v.number()),
    group: v.optional(v.number()),
    error: v.optional(v.string()),
    reviewFailureDetails: v.optional(v.string()),
    reviewId: v.optional(v.number()),
    reviewUrl: v.optional(v.string()),
    // Whether every finding of the post became its own review thread.
    inlineFindings: v.optional(v.boolean()),
    // Earlier Gitdog approvals GitHub refused to dismiss.
    keptApprovals: v.optional(v.array(v.number())),
    // The pull request moved on mid-review; the review was cancelled.
    cancelled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.actionType !== "review") return;
    if (
      args.stage === "generation" &&
      (action.status !== "pending" || !isBatchCursor(action.reviewBatch, args))
    )
      return;
    if (
      args.stage === "preflight" &&
      (action.executionClaimedAt !== undefined ||
        !["pending_approval", "approved"].includes(action.status))
    )
      return;
    if (
      args.stage === "publication" &&
      (action.status !== "approved" ||
        args.claimedAt === undefined ||
        action.executionClaimedAt !== args.claimedAt)
    )
      return;
    await ctx.db.patch(action._id, {
      status: args.error ? "failed" : "completed",
      ...(args.error && args.cancelled ? { reviewCancelled: true } : {}),
      ...ENDED_BATCH,
      errorMessage: args.error,
      reviewFailureDetails: args.error ? args.reviewFailureDetails : undefined,
      completedAt: Date.now(),
      executionResult: args.reviewId
        ? {
            reviewId: args.reviewId,
            reviewUrl: args.reviewUrl,
            published: true,
            ...(args.inlineFindings !== undefined
              ? { inlineFindings: args.inlineFindings }
              : {}),
            ...(args.keptApprovals
              ? { keptApprovals: args.keptApprovals }
              : {}),
          }
        : undefined,
    });
    await settleStatus(ctx, action._id);
    await observeDroppedPush(ctx, action.ticketId);
  },
});
export const expire = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    claimedAt: v.optional(v.number()),
    page: v.optional(v.number()),
    group: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    const expired =
      action?.actionType === "review" &&
      (args.claimedAt === undefined
        ? action.status === "pending" && isBatchCursor(action.reviewBatch, args)
        : action.status === "approved" &&
          action.executionClaimedAt === args.claimedAt);
    if (action && expired)
      await ctx.db.patch(action._id, {
        status: "failed",
        completedAt: Date.now(),
        ...ENDED_BATCH,
        ...(args.page
          ? {
              reviewFailureDetails: `Stage · Review batch ${args.page}${args.group ? `, part ${args.group + 1}` : ""}\nReason · Review exceeded its processing deadline.`,
            }
          : {}),
        errorMessage:
          action.executionClaimedAt === undefined
            ? "Review exceeded its processing deadline"
            : "GitHub publication outcome requires inspection; automatic retries are disabled",
      });
    if (action) {
      // Only an expiry that ended the review changes what the comment says.
      if (expired) await settleStatus(ctx, action._id);
      await observeDroppedPush(ctx, action.ticketId);
    }
  },
});

/** Note that Gitdog approved, or may have approved, the reviewed commit. */
export const markApproval = internalMutation({
  args: { actionId: v.id("ticketActions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    const headSha = action?.proposedChanges?.source?.headSha;
    if (action && typeof headSha === "string")
      await ctx.db.patch(action.ticketId, { pullRequestApprovedSha: headSha });
  },
});

/** Forget a withdrawn approval, unless a newer one replaced it meanwhile. */
export const forgetApproval = internalMutation({
  args: { ticketId: v.id("tickets"), staleSha: v.string() },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    // A review being posted may still approve the stale commit; the push it
    // dropped is observed again once it ends, which retries the dismissal.
    if (
      ticket?.pullRequestApprovedSha === args.staleSha &&
      !(await listTicketActions(ctx, ticket._id)).some(
        (action) =>
          action.status === "approved" &&
          action.executionClaimedAt !== undefined,
      )
    )
      await ctx.db.patch(ticket._id, { pullRequestApprovedSha: undefined });
  },
});

/** End an approved review that turned out to have nothing to post. */
export const completeUnposted = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    claimedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (
      !action ||
      action.actionType !== "review" ||
      action.status !== "approved" ||
      action.executionClaimedAt !== args.claimedAt
    )
      return;
    await ctx.db.patch(action._id, {
      status: "completed",
      completedAt: Date.now(),
      executionResult: { published: false, reason: "no_new_changes" },
    });
    await settleStatus(ctx, action._id);
    await observeDroppedPush(ctx, action.ticketId);
  },
});

/**
 * Record a command comment and decide whether it runs. A commenter who sends
 * too many commands to one repository is paused for a day; only the command
 * that pauses them gets a reply, so a paused commenter cannot make Gitdog
 * post either.
 */
export const recordCommand = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    githubNumber: v.number(),
    commentId: v.number(),
    githubUserId: v.number(),
    login: v.string(),
    command: v.union(
      v.literal("review"),
      v.literal("full_review"),
      v.literal("resolve"),
      v.literal("help"),
    ),
    // False when the commenter may not run this command.
    allowed: v.boolean(),
  },
  handler: async (ctx, { login, allowed, ...args }) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo?.isActive ||
      repo.disconnectCleanupPending ||
      repo.settings.pullRequestReviewsEnabled !== true
    )
      return "unavailable" as const;
    const seen = await ctx.db
      .query("pullRequestCommands")
      .withIndex("by_comment", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("commentId", args.commentId),
      )
      .first();
    if (seen) return "duplicate" as const;
    const now = Date.now();
    const recent = await ctx.db
      .query("pullRequestCommands")
      .withIndex("by_repository_user", (q) =>
        q
          .eq("repositoryId", args.repositoryId)
          .eq("githubUserId", args.githubUserId)
          .gt("createdAt", now - COMMAND_PAUSE_MS),
      )
      .take(COMMANDS_PER_DAY + 1);
    if (recent.some((row) => row.outcome === "paused"))
      return "paused" as const;
    const lastHour = recent.filter((row) => row.createdAt > now - 60 * 60_000);
    const pause =
      lastHour.length >= COMMANDS_PER_HOUR || recent.length >= COMMANDS_PER_DAY;
    await ctx.db.insert("pullRequestCommands", {
      ...args,
      outcome: pause ? "paused" : "accepted",
      createdAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.pullRequests.internalAction.runCommand,
      {
        repositoryId: args.repositoryId,
        number: args.githubNumber,
        command: pause ? "pause_now" : allowed ? args.command : "not_allowed",
        login,
      },
    );
    return pause ? ("pause_now" as const) : ("accepted" as const);
  },
});

/**
 * Allow one new status comment a day for a pull request's automatic
 * reviews, so a pull request that keeps failing is not flooded.
 */
export const claimAutomaticNotice = internalMutation({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    const now = Date.now();
    if (
      !ticket ||
      (ticket.pullRequestLimitNoticeAt !== undefined &&
        ticket.pullRequestLimitNoticeAt > now - COMMAND_PAUSE_MS)
    )
      return false;
    await ctx.db.patch(ticket._id, { pullRequestLimitNoticeAt: now });
    return true;
  },
});

/** Start the daily quiet window after an automatic review failed. */
export const stampAutomaticNotice = internalMutation({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (ticket)
      await ctx.db.patch(ticket._id, { pullRequestLimitNoticeAt: Date.now() });
  },
});

/** Remember the status comment posted for a review, once. */
/** The status comment was deleted because the review it described was posted. */
export const forgetStatusComment = internalMutation({
  args: { actionId: v.id("ticketActions"), commentId: v.number() },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (action?.statusCommentId === args.commentId)
      await ctx.db.patch(action._id, { statusCommentId: undefined });
  },
});

export const recordStatusComment = internalMutation({
  args: {
    actionId: v.id("ticketActions"),
    commentId: v.number(),
    // A "Reviewing" comment, which a review that has since ended must update.
    reviewing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.statusCommentId !== undefined) return false;
    await ctx.db.patch(action._id, { statusCommentId: args.commentId });
    // The review may have ended while its comment was being posted.
    if (args.reviewing && action.status !== "pending")
      await settleStatus(ctx, action._id);
    return true;
  },
});
