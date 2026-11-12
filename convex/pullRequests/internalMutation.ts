import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { v } from "convex/values";
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
  combinedReviewBody,
  findingBody,
  findingValidator,
  reviewBatchProgressValidator,
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
    for (const action of actions) {
      if (
        ["pending", "pending_approval", "approved"].includes(action.status) &&
        action.executionClaimedAt === undefined &&
        (!matches(action) ||
          (!args.open && action.reviewVerificationOnly !== true))
      )
        await ctx.db.patch(action._id, {
          status: "failed",
          errorMessage: SUPERSEDED_REVIEW,
          ...ENDED_BATCH,
          completedAt: Date.now(),
        });
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
export const observe = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    number: v.number(),
    observedAt: v.optional(v.number()),
    author: v.string(),
    open: v.boolean(),
    snapshot: snapshotValidator,
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (
      !repo ||
      repo.settings.pullRequestReviewsEnabled !== true ||
      !repo.isActive ||
      repo.disconnectCleanupPending ||
      repo.githubAccessRevokedAt !== undefined ||
      isBotPullRequestAuthor({ login: args.author })
    )
      return null;
    const install = await getExactGitHubInstallation(ctx, repo.installationId);
    if (!isGitHubInstallationReady(install) || install.userId !== repo.userId)
      return null;
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
      if (!args.open) return null;
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
      return null;
    const actions = await listTicketActions(ctx, ticket._id);
    const source = args.snapshot;
    const commitChanged = !sameCommit(
      {
        headSha: ticket.pullRequestHeadSha,
        baseSha: ticket.pullRequestBaseSha,
      },
      source,
    );
    const changed =
      commitChanged ||
      ticket.githubTitle !== source.title ||
      ticket.githubBody !== source.body;
    const sameHeadReviews = actions.filter((action) =>
      isAutomaticReviewForHead(action, source.headSha),
    );
    const attempted = sameHeadReviews.some(hasAttemptedReview);
    const queued =
      args.open && !attempted
        ? sameHeadReviews.find((action) => action.status === "pending")
        : undefined;
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
      )
        await ctx.db.patch(action._id, {
          status: "failed",
          errorMessage: SUPERSEDED_REVIEW,
          ...ENDED_BATCH,
          completedAt: now,
        });
    }
    await ctx.db.patch(ticket._id, {
      pullRequestObservedAt: observedAt,
      status: args.open ? "open" : "closed",
      closedAt: args.open ? undefined : now,
      pullRequestHeadSha: source.headSha,
      pullRequestBaseSha: source.baseSha,
      githubTitle: source.title,
      githubBody: source.body,
      aiInputVersion: changed
        ? ticket.aiInputVersion + 1
        : ticket.aiInputVersion,
    });
    if (!args.open || attempted || queued) return null;
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
      return null;
    const actionId = await ctx.db.insert("ticketActions", {
      ticketId: ticket._id,
      actionType: "review",
      proposedChanges: { source },
      proposalVersion: 1,
      status: "pending",
      chatHistory: [],
      createdAt: now,
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
    await settleThenGrantTrialCredit(ctx, ticket.userId);
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
    excludedPaths: v.array(v.string()),
    filesRead: v.array(v.string()),
    page: v.optional(v.number()),
    group: v.optional(v.number()),
    next: v.optional(v.object({ page: v.number(), group: v.number() })),
    batchProgress: v.optional(reviewBatchProgressValidator),
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
    const noFindings = args.findings.length === 0;
    const verificationOnly = action.reviewVerificationOnly === true;
    const approval = repo.settings.requireApprovalForPullRequests !== false;
    const suggestions = repo.settings.pullRequestSuggestionsEnabled !== false;
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
          : {}),
        findings: args.findings,
        excludedPaths: args.excludedPaths,
        filesRead: args.filesRead,
        // Approvers preview the exact body a batched review will post.
        suggestedResponse: noFindings
          ? "No supported findings in the inspected changes. This is not a merge approval; tests were not run."
          : batch
            ? combinedReviewBody(
                args.findings,
                args.source.headSha,
                batch,
                suggestions,
              )
            : args.findings
                .map(
                  (f) => `${f.path}:${f.line}\n${findingBody(f, suggestions)}`,
                )
                .join("\n\n"),
      },
      status:
        noFindings || verificationOnly
          ? "completed"
          : approval
            ? "pending_approval"
            : "approved",
      completedAt: noFindings || verificationOnly ? Date.now() : undefined,
      executionResult:
        noFindings || verificationOnly
          ? {
              published: false,
              reason: verificationOnly
                ? "verification_only"
                : "no_supported_findings",
            }
          : undefined,
    });
    if (!noFindings && !verificationOnly && !approval)
      await ctx.scheduler.runAfter(
        0,
        internal.pullRequests.internalAction.publish,
        { actionId: action._id, manual: false },
      );
    return true;
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
    if (
      !args.manual &&
      repo.settings.requireApprovalForPullRequests !== false
    ) {
      await ctx.db.patch(action._id, { status: "pending_approval" });
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
      ...ENDED_BATCH,
      errorMessage: args.error,
      reviewFailureDetails: args.error ? args.reviewFailureDetails : undefined,
      completedAt: Date.now(),
      executionResult: args.reviewId
        ? {
            reviewId: args.reviewId,
            reviewUrl: args.reviewUrl,
            published: true,
          }
        : undefined,
    });
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
    if (
      action?.actionType === "review" &&
      (args.claimedAt === undefined
        ? action.status === "pending" && isBatchCursor(action.reviewBatch, args)
        : action.status === "approved" &&
          action.executionClaimedAt === args.claimedAt)
    )
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
  },
});
