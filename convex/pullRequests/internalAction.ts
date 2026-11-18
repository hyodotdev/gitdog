import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import {
  resolveVerifiedRepositoryAccess,
  type VerifiedRepositoryAccess,
} from "../github/repositoryIdentity";
import { requireCurrentAiLegalAttestation } from "../_ai/legalAttestation";
import { createMeteredProvider, ChatBillingError } from "../_ai/chatBilling";
import {
  resolveGenerationProvider,
  UserApiKeyError,
  usesUserKey,
} from "../_ai/providerResolution";
import {
  BATCH_REVIEW_THRESHOLD,
  changedSince,
  getPullRequest,
  listOpenPullRequests,
  hasUnresolvedOwnThreads,
  resolveOwnThreads,
  isBotPullRequestAuthor,
  minimumReviewBatches,
  PullRequestDiffBudgetError,
  PullRequestSizeLimitError,
  REVIEW_DIFF_BUDGET,
  root,
  readReviewJson,
  snapshot,
  splitReviewDiff,
  readReviewFile,
  treePaths,
  type PullRequest,
} from "./github";
import { reviewWithContext } from "./workflow";
import { REVIEW_QUOTA_FAILURES } from "./internalMutation";
import {
  isReviewGroupModelFailure,
  isLifecycleChange,
  isReviewRefusal,
  ReviewQuotaError,
  reviewGenerationError,
  reviewFailureCause,
  reviewFailureDetails,
  runReviewRequest,
} from "./errors";
import {
  canApproveReview,
  combinedReviewBody,
  hasReviewablePatch,
  MAX_REVIEW_FINDINGS,
  reviewBody,
  reviewComments,
  validateFindings,
  type ChangedFile,
  type Finding,
} from "./review";
import {
  addIssueComment,
  updateIssueComment,
  GITHUB_API_VERSION,
  fetchGitHubAppJsonWithRetry,
} from "../github/helpers";
import {
  COMMAND_PAUSE_MS,
  helpText,
  isCancelledReview,
  reviewStatusBody,
} from "./commands";
import { getConfiguredGitHubAppSlug } from "../github/botIdentity";

type Source = { headSha: string; baseSha: string; title: string; body: string };
function readReviewSource(
  access: VerifiedRepositoryAccess,
  path: string,
  commit: string,
  changed?: ChangedFile,
  onWindowed?: () => void,
  windowFrom?: number,
) {
  return runReviewRequest(
    { operation: "Read GitHub source file", file: { path, commit } },
    () => readReviewFile(access, path, commit, changed, onWindowed, windowFrom),
  );
}

/**
 * Whether a review may still run or be posted on its pinned commit. A newer
 * push does not stop it: pushes during a review are dropped, and the review
 * finishes on the commit it started on.
 */
function sameSource(pr: PullRequest, verificationOnly = false): boolean {
  return (
    (verificationOnly || pr.state === "open") &&
    !isBotPullRequestAuthor(pr.user) &&
    !pr.draft
  );
}

/** The reviewed commit pair, independent of the live PR head. */
function pinned(pr: PullRequest, source: Source): PullRequest {
  return {
    ...pr,
    head: { sha: source.headSha },
    base: { ...pr.base, sha: source.baseSha },
  };
}
function sourceOf(value: unknown): Source {
  const s = value as Source | undefined;
  if (
    !s ||
    !/^[a-f0-9]{40}$/.test(s.headSha) ||
    !/^[a-f0-9]{40}$/.test(s.baseSha) ||
    typeof s.title !== "string" ||
    typeof s.body !== "string"
  )
    throw new Error("Review source snapshot is missing");
  return s;
}
async function guard(
  ctx: ActionCtx,
  actionId: Id<"ticketActions">,
  source: Source,
  stage: "generation" | "publication",
  manual = false,
) {
  const state = await ctx.runQuery(internal.pullRequests.internalQuery.get, {
    actionId,
  });
  if (
    !state ||
    state.action.status !== (stage === "generation" ? "pending" : "approved") ||
    (state.ticket.status !== "open" &&
      !(
        stage === "generation" && state.action.reviewVerificationOnly === true
      )) ||
    (stage === "publication" && state.action.reviewVerificationOnly === true) ||
    state.repository.settings.pullRequestReviewsEnabled !== true ||
    isBotPullRequestAuthor({ login: state.ticket.githubAuthor ?? "" }) ||
    state.ticket.pullRequestHeadSha !== source.headSha ||
    state.ticket.pullRequestBaseSha !== source.baseSha ||
    (!manual &&
      stage === "publication" &&
      state.repository.settings.requireApprovalForPullRequests !== false &&
      state.action.proposedChanges?.findings?.length !== 0)
  )
    throw new Error("Review source, settings or lifecycle changed");
  await requireCurrentAiLegalAttestation(ctx, state.repository.userId);
  const access = await runReviewRequest(
    { operation: "Verify GitHub App repository access" },
    () => resolveVerifiedRepositoryAccess(ctx, state.repository._id),
  );
  return { state, access };
}

export const observe = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    number: v.number(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const observedAt = Date.now();
    const repo = await ctx.runQuery(
      internal.repositories.internalQuery.getById,
      { repositoryId: args.repositoryId },
    );
    if (!repo || repo.settings.pullRequestReviewsEnabled !== true) return;
    try {
      const access = await resolveVerifiedRepositoryAccess(
        ctx,
        args.repositoryId,
      );
      const pr = await getPullRequest(access, args.number);
      if (isBotPullRequestAuthor(pr.user)) return;
      await ctx.runMutation(internal.pullRequests.internalMutation.observe, {
        repositoryId: args.repositoryId,
        number: args.number,
        observedAt,
        author: pr.user.login,
        open: pr.state === "open" && !pr.draft,
        snapshot: {
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
          title: pr.title,
          body: pr.body ?? "",
        },
      });
    } catch {
      const attempt = args.attempt ?? 0;
      if (attempt < 3) {
        await ctx.scheduler.runAfter(
          30_000 * 4 ** attempt,
          internal.pullRequests.internalAction.observe,
          {
            repositoryId: args.repositoryId,
            number: args.number,
            attempt: attempt + 1,
          },
        );
        return;
      }
      throw new Error(
        "PR observation failed after bounded retries. Check GitHub App permissions and installation access.",
      );
    }
  },
});

// Reviews start on pull request events, so pull requests opened before reviews
// were on never get one. When reviews turn on, a few recently updated ones that
// were never reviewed get their first review, spaced further apart than one
// review action can run, because an account runs one review at a time.
const CATCH_UP_PULL_REQUESTS = 5;
const CATCH_UP_WINDOW_MS = 30 * 24 * 60 * 60_000;
const CATCH_UP_SPACING_MS = 12 * 60_000;

export const reviewOpenPullRequests = internalAction({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<void> => {
    const repo = await ctx.runQuery(
      internal.repositories.internalQuery.getById,
      { repositoryId: args.repositoryId },
    );
    if (
      !repo ||
      repo.isActive !== true ||
      repo.settings.pullRequestReviewsEnabled !== true
    )
      return;
    // Reviews the account cannot pay for would only post failure comments on
    // old pull requests; the owner can still ask for one with a command.
    const provider = await resolveGenerationProvider(ctx, {
      userId: repo.userId,
    }).catch(() => null);
    if (!provider) return;
    if (
      !usesUserKey(provider) &&
      !(await ctx.runQuery(
        internal.pullRequests.internalQuery.hasReviewAllowance,
        { userId: repo.userId },
      ))
    )
      return;
    const access = await resolveVerifiedRepositoryAccess(
      ctx,
      args.repositoryId,
    );
    const now = Date.now();
    const candidates = (await listOpenPullRequests(access)).filter(
      (pr) =>
        pr !== null &&
        typeof pr === "object" &&
        Number.isSafeInteger(pr.number) &&
        pr.draft !== true &&
        typeof pr.user?.login === "string" &&
        !isBotPullRequestAuthor(pr.user) &&
        now - Date.parse(pr.updated_at) <= CATCH_UP_WINDOW_MS,
    );
    const reviewed = new Set(
      await ctx.runQuery(internal.pullRequests.internalQuery.reviewedNumbers, {
        repositoryId: args.repositoryId,
        numbers: candidates.map((pr) => pr.number),
      }),
    );
    const recent = candidates
      .filter((pr) => !reviewed.has(pr.number))
      .slice(0, CATCH_UP_PULL_REQUESTS);
    // observe reviews a pull request only until it has one finished review.
    for (const [index, pr] of recent.entries())
      await ctx.scheduler.runAfter(
        index * CATCH_UP_SPACING_MS,
        internal.pullRequests.internalAction.observe,
        { repositoryId: args.repositoryId, number: pr.number },
      );
  },
});

const REVIEW_COVERAGE_PREVIEW = 100;
const MAX_FAILED_REVIEW_GROUPS = 2;
const MAX_REFUSED_REVIEW_GROUPS = 5;
// Reviews of one account share a single provider slot. Wait this long per
// action for other work to release it before failing the review.
const REVIEW_ACTIVE_PROVIDER_WAIT_MS = 90_000;

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
export const generate = internalAction({
  args: {
    actionId: v.id("ticketActions"),
    page: v.optional(v.number()),
    group: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const startedAt = Date.now();
    const token = await ctx.runMutation(
      internal.pullRequests.internalMutation.claimGeneration,
      args,
    );
    if (!token) return;
    const page = args.page ?? 1;
    const group = args.group ?? 0;
    let stage = "Source preflight";
    let batched = args.page !== undefined;
    try {
      const initial = await ctx.runQuery(
        internal.pullRequests.internalQuery.get,
        { actionId: args.actionId },
      );
      if (!initial || initial.action.status !== "pending") return;
      const source = sourceOf(initial.action.proposedChanges?.source);
      const verificationOnly = initial.action.reviewVerificationOnly === true;
      const { access } = await guard(ctx, args.actionId, source, "generation");
      const live = await getPullRequest(access, initial.ticket.githubNumber);
      if (isBotPullRequestAuthor(live.user))
        throw new Error("Bot-authored pull requests are not reviewed");
      if (!sameSource(live, verificationOnly))
        throw new Error("Pull request changed before review");
      const pr = pinned(live, source);
      const previous = initial.action.reviewBatch?.result;
      // A push after a finished review covers only the files it changed, as
      // long as they fit one review; otherwise the whole PR is reviewed.
      const since = initial.action.reviewSince;
      let scoped: Awaited<ReturnType<typeof snapshot>> | undefined;
      // Files that left the PR diff since the earlier review: a file the PR
      // added and then deleted, or one reverted to base.
      let leftDiff = 0;
      if (since && !batched && !verificationOnly) {
        const scope = await changedSince(access, since, pr);
        if (scope) {
          const candidate = await snapshot(access, pr, verificationOnly, {
            findingPaths: scope.paths,
          });
          if (
            // The scope is only valid against the merge base it was built on.
            candidate.baseSha === scope.mergeBaseSha &&
            candidate.files.length <= BATCH_REVIEW_THRESHOLD &&
            JSON.stringify(candidate.files).length <= REVIEW_DIFF_BUDGET
          ) {
            scoped = candidate;
            const now = new Set(candidate.files.map((f) => f.filename));
            leftDiff = scope.previous
              ? [...scope.paths].filter(
                  (path) => scope.previous!.has(path) && !now.has(path),
                ).length
              : // Unknown earlier diff: treat it as changed.
                1;
          }
        }
      }
      const data = scoped
        ? scoped
        : batched
          ? await snapshot(access, pr, verificationOnly, { page })
          : await snapshot(access, pr, verificationOnly).catch(
              async (error) => {
                if (!(error instanceof PullRequestDiffBudgetError)) throw error;
                // A diff over the single-review budget is reviewed in batches.
                const paged = await snapshot(access, pr, verificationOnly, {
                  page,
                });
                // Batches cannot help when no diff is left after the oversized
                // ones are dropped.
                if (
                  paged.files.length === paged.changedFiles &&
                  !splitReviewDiff(paged.files).flat().some(hasReviewablePatch)
                )
                  throw error;
                batched = true;
                return paged;
              },
            );
      if (
        previous &&
        (previous.changedFiles !== data.changedFiles ||
          previous.mergeBaseSha !== data.baseSha)
      )
        throw new Error("Pull request changed while reading its diff");
      if (scoped && !data.files.some(hasReviewablePatch)) {
        // Nothing reviewable changed in this PR's diff, such as a merge of the
        // base branch or a deletion, so no model call is made. A binary or
        // oversized file this push changed is reported as not reviewed.
        const unreviewable = data.files.filter((f) => f.status !== "removed");
        await ctx.runMutation(internal.pullRequests.internalMutation.propose, {
          actionId: args.actionId,
          source,
          findings: [],
          excludedPaths: unreviewable.map((f) => f.filename),
          filesRead: [],
          mergeBaseSha: data.baseSha,
          coverage: {
            changedFiles: unreviewable.length,
            uncoveredFiles: unreviewable.length,
            since: since?.headSha,
            // A deletion has no added line a finding could point at.
            removedFiles: data.files.length - unreviewable.length + leftDiff,
          },
        });
        return;
      }
      // Show on the pull request that a review is running, once per review.
      if (
        !previous &&
        !verificationOnly &&
        initial.action.statusCommentId === undefined &&
        // After a recent automatic failure, a retry on the next push stays
        // quiet until it has something to show.
        (initial.action.reviewRequested === true ||
          initial.ticket.pullRequestLimitNoticeAt === undefined ||
          initial.ticket.pullRequestLimitNoticeAt <
            Date.now() - COMMAND_PAUSE_MS)
      )
        await postReviewingStatus(ctx, access, initial, data);
      const fileKeys = new Set(previous?.fileKeys);
      if (batched) {
        // Keep the complete file inventory bounded even when paths are long.
        const keys = await Promise.all(
          data.files.map(({ filename }) => sha256Base64(filename)),
        );
        for (const key of keys) {
          // Later groups of a page revisit files the first group recorded.
          if (fileKeys.has(key) !== group > 0)
            throw new Error("Pull request diff is incomplete");
          fileKeys.add(key);
        }
      }
      const findings = [...(previous?.findings ?? [])];
      let findingCount = previous?.findingCount ?? 0;
      let inspectedFiles = previous?.inspectedFiles ?? 0;
      let uncoveredFiles = previous?.uncoveredFiles ?? 0;
      let failedGroups = previous?.failedGroups ?? 0;
      let refusedGroups = previous?.refusedGroups ?? 0;
      // A record of the files a safety filter declined.
      const refusedPaths = new Set(previous?.refusedPaths);
      const filesRead = new Set(previous?.filesRead);
      // Head files this group saw around their diff.
      const windowedPaths = new Set<string>();
      const excludedPaths = new Set(previous?.excludedPaths);
      const groups = batched ? splitReviewDiff(data.files) : [data.files];
      // Later groups of a page must see the same ordered split as the first.
      const pageLayout = batched
        ? await sha256Base64(
            JSON.stringify(groups.map((files) => files.map((f) => f.filename))),
          )
        : undefined;
      if (
        !Number.isSafeInteger(group) ||
        group < 0 ||
        group >= groups.length ||
        (group > 0 && previous?.pageLayout !== pageLayout)
      )
        throw new Error("Pull request diff is incomplete");
      // One action reviews one group so a page of large diffs cannot outlive
      // the action deadline and strand a started provider request.
      const selected = batched ? groups[group] : data.files;
      stage = "Model provider selection";
      const rawAiProvider = await resolveGenerationProvider(ctx, {
        userId: initial.repository.userId,
        ticketActionId: args.actionId,
      });
      if (batched && !previous && group === 0) {
        // Refuse up front instead of spending tokens on early batches and
        // stopping at the account limit with nothing published.
        stage = "Token quota check";
        const quota = await ctx
          .runMutation(
            internal.pullRequests.internalMutation.reserveBatchedReviewQuota,
            {
              actionId: args.actionId,
              userKey: usesUserKey(rawAiProvider),
              // The first page is already split; later pages count one each.
              batches:
                groups.length +
                minimumReviewBatches(data.changedFiles - data.files.length),
            },
          )
          .catch(() => {
            // Convex records the mutation's own failure. Only a fixed reason
            // is stored with the review.
            throw new ReviewQuotaError(
              "The token quota check did not complete, so the review did not start.",
              "unverified",
            );
          });
        if (!quota.reserved && quota.userKeyUnavailable)
          throw new UserApiKeyError(
            "unavailable",
            rawAiProvider.providerId === "openai" ? "openai" : "anthropic",
          );
        if (!quota.reserved)
          throw new ReviewQuotaError(quota.message, quota.reason);
      }
      const ensureCurrent = async () => {
        await guard(ctx, args.actionId, source, "generation");
      };
      stage = "Commit context retrieval";
      const hasReviewableFiles = !batched || selected.some(hasReviewablePatch);
      const paths = hasReviewableFiles
        ? await treePaths(access, data.headSha)
        : [];
      const basePaths = hasReviewableFiles
        ? await treePaths(access, data.baseSha)
        : [];
      stage = "AI generation and evidence validation";
      if (batched && !hasReviewableFiles) {
        for (const file of selected) excludedPaths.add(file.filename);
        // A removed file has no added code to review.
        uncoveredFiles += selected.filter((f) => f.status !== "removed").length;
      } else {
        const generationKey = `pr/${args.actionId}/${source.headSha}`;
        const provider = createMeteredProvider(ctx, {
          userId: initial.repository.userId,
          repositoryId: initial.repository._id,
          ticketActionId: args.actionId,
          generationKey: batched
            ? `${generationKey}/batch/${page}/${group + 1}`
            : generationKey,
          operation: "pull-request-review",
          provider: rawAiProvider,
          requirePendingTicketAction: true,
          beforeProviderStart: ensureCurrent,
          activeProviderWaitMs: REVIEW_ACTIVE_PROVIDER_WAIT_MS,
        });
        let result: Awaited<ReturnType<typeof reviewWithContext>>;
        try {
          result = await reviewWithContext({
            startedAt,
            provider,
            batchGroup: batched,
            allowSuggestions:
              initial.repository.settings.pullRequestSuggestionsEnabled !==
              false,
            repository: access.githubRepo,
            title: source.title,
            body: source.body,
            files: selected,
            paths,
            basePaths,
            guard: ensureCurrent,
            read: (path, ref) =>
              ref === "head"
                ? readReviewSource(
                    access,
                    path,
                    data.headSha,
                    data.files.find((file) => file.filename === path),
                    () => windowedPaths.add(path),
                  )
                : readReviewSource(access, path, data.baseSha),
          });
        } catch (error) {
          // A failure that keeps recurring is not one bad response; stop
          // instead of paying for every remaining batch. Safety declines are
          // about content, so they have their own, larger limit, and a single
          // review reports declined files instead of failing.
          const refused = isReviewRefusal(error);
          if (
            !isReviewGroupModelFailure(error) ||
            (!batched && !refused) ||
            (!refused && failedGroups >= MAX_FAILED_REVIEW_GROUPS) ||
            (refused && refusedGroups >= MAX_REFUSED_REVIEW_GROUPS)
          )
            throw error;
          if (refused) {
            refusedGroups++;
            for (const file of selected) refusedPaths.add(file.filename);
          } else failedGroups++;
          // Keep the batches already paid for and report this group as not
          // reviewed, as when its files cannot be read.
          await ensureCurrent();
          result = {
            findings: [],
            reads: [],
            excludedPaths: selected.map((file) => file.filename),
          };
        }
        // Each review group decides windowing for its own reads, so the way
        // each quoted file was seen travels with the evidence itself.
        findings.push(
          ...result.findings.map((finding) => ({
            ...finding,
            evidence: finding.evidence.map((e) =>
              e.ref === "head"
                ? { ...e, windowed: windowedPaths.has(e.path) }
                : e,
            ),
          })),
        );
        findingCount += result.findings.length;
        const inspected = new Set(
          result.reads.filter((r) => r.ref === "head").map((r) => r.path),
        );
        for (const file of selected) {
          if (file.status === "removed") continue;
          // A diff dropped for size was not reviewed even if its source was read.
          if (hasReviewablePatch(file) && inspected.has(file.filename))
            inspectedFiles++;
          else uncoveredFiles++;
        }
        for (const path of result.excludedPaths) excludedPaths.add(path);
        for (const read of result.reads)
          filesRead.add(`${read.ref}:${read.path}`);
      }
      const next = !batched
        ? undefined
        : group + 1 < groups.length
          ? { page, group: group + 1 }
          : fileKeys.size < data.changedFiles
            ? { page: page + 1, group: 0 }
            : undefined;
      // Base guide reads do not count: some changed file must be inspected.
      if (batched && !next && inspectedFiles === 0)
        throw new Error("Reviewer did not inspect the changed implementation");
      if (batched)
        findings.sort(
          (a, b) =>
            a.priority.localeCompare(b.priority) || b.confidence - a.confidence,
        );
      stage = "Final source validation";
      await ensureCurrent();
      if (
        !sameSource(await getPullRequest(access, pr.number), verificationOnly)
      )
        throw new Error("Pull request changed during review");
      await ctx.runMutation(internal.pullRequests.internalMutation.propose, {
        actionId: args.actionId,
        source,
        page: args.page,
        mergeBaseSha: data.baseSha,
        group: args.group,
        next,
        findings: findings.slice(0, MAX_REVIEW_FINDINGS),
        // Findings past the cap never become threads.
        ...(!batched && findings.length > MAX_REVIEW_FINDINGS
          ? { findingCount: findings.length }
          : {}),
        refusedPaths: [...refusedPaths].slice(0, REVIEW_COVERAGE_PREVIEW),
        excludedPaths: [...excludedPaths].slice(
          0,
          batched ? REVIEW_COVERAGE_PREVIEW : undefined,
        ),
        filesRead: [...filesRead].slice(
          0,
          batched ? REVIEW_COVERAGE_PREVIEW : undefined,
        ),
        batchProgress: batched
          ? {
              changedFiles: data.changedFiles,
              batchCount: (previous?.batchCount ?? 0) + 1,
              mergeBaseSha: data.baseSha,
              fileKeys: [...fileKeys],
              findingCount,
              inspectedFiles,
              uncoveredFiles,
              failedGroups,
              refusedGroups,
              remainingBatches: next
                ? groups.length -
                  group -
                  1 +
                  minimumReviewBatches(data.changedFiles - fileKeys.size)
                : 0,
              pageLayout,
              coverageLimited:
                previous?.coverageLimited === true ||
                filesRead.size > REVIEW_COVERAGE_PREVIEW ||
                excludedPaths.size > REVIEW_COVERAGE_PREVIEW,
            }
          : undefined,
        coverage: batched
          ? undefined
          : scoped
            ? {
                // Removed files have nothing to review, as in uncoveredFiles.
                changedFiles: data.files.filter((f) => f.status !== "removed")
                  .length,
                uncoveredFiles,
                since: since?.headSha,
                ...(leftDiff ? { removedFiles: leftDiff } : {}),
              }
            : {
                // Counted like uncoveredFiles: removed files have nothing to
                // review.
                changedFiles: data.files.filter((f) => f.status !== "removed")
                  .length,
                uncoveredFiles,
              },
      });
    } catch (error) {
      // Do not persist provider bodies, source snippets or credentials in errors.
      if (batched)
        stage = `${stage} (review batch ${page}${group ? `, part ${group + 1}` : ""})`;
      const cause = reviewFailureCause(error);
      const billingReason =
        cause instanceof ChatBillingError
          ? cause.reason === "limit_reached"
            ? "The account token limit cannot cover this review."
            : `Usage accounting stopped the model request (${cause.reason}).`
          : undefined;
      await ctx.runMutation(internal.pullRequests.internalMutation.finish, {
        actionId: args.actionId,
        stage: "generation",
        cancelled: isLifecycleChange(error),
        page: args.page,
        group: args.group,
        error:
          cause instanceof ReviewQuotaError
            ? REVIEW_QUOTA_FAILURES[cause.reason]
            : cause instanceof ChatBillingError
              ? cause.reason === "limit_reached"
                ? "Token limit reached before review could complete. No review was published."
                : cause.reason === "provider_attempt_in_progress"
                  ? "Other AI work for this account did not finish in time. No review was published."
                  : "Review billing could not proceed safely; inspect pending provider usage before retrying."
              : cause instanceof PullRequestSizeLimitError ||
                  cause instanceof UserApiKeyError
                ? cause.message
                : reviewGenerationError(error, stage),
        reviewFailureDetails: reviewFailureDetails(
          error,
          stage,
          billingReason ??
            (cause instanceof PullRequestSizeLimitError ||
            cause instanceof ReviewQuotaError
              ? cause.message
              : undefined),
        ),
      });
    }
  },
});

type Review = {
  id: number;
  html_url: string;
  body: string;
  commit_id: string;
  state?: string;
  user: { type: string; login: string };
};
function botLogin() {
  return `${getConfiguredGitHubAppSlug() ?? ""}[bot]`;
}
/** This review if it was already posted, and Gitdog's standing approvals. */
async function ownReviews(
  access: VerifiedRepositoryAccess,
  number: number,
  marker: string | null,
  sha: string,
): Promise<{ prior: Review | null; approvals: Review[] }> {
  let prior: Review | null = null;
  const approvals: Review[] = [];
  for (let page = 1; page <= 5; page++) {
    const reviews = await readReviewJson<Review[]>(
      access,
      `/pulls/${number}/reviews?per_page=100&page=${page}`,
      "Reconcile pull request review",
    );
    if (!Array.isArray(reviews))
      throw new Error("Review history is unavailable");
    for (const r of reviews) {
      if (r.user?.type !== "Bot" || r.user.login.toLowerCase() !== botLogin())
        continue;
      if (marker && r.body?.includes(marker) && r.commit_id === sha)
        prior ??= r;
      if (r.state === "APPROVED") approvals.push(r);
    }
    if (reviews.length < 100) return { prior, approvals };
  }
  throw new Error("Review history exceeded the reconciliation limit");
}
/**
 * An earlier approval no longer holds once a review of newer changes does not
 * approve. Dismissing is best effort: the new review is already posted.
 */
async function dismissApprovals(
  access: VerifiedRepositoryAccess,
  number: number,
  approvals: Review[],
  message: string,
  // Only approvals posted before this review id; a newer one stands.
  before = Number.MAX_SAFE_INTEGER,
): Promise<number[]> {
  const kept: number[] = [];
  // Bounded, so a degraded GitHub cannot hold a posted review past expiry.
  for (const approval of approvals.filter((a) => a.id < before).slice(0, 5))
    await fetchGitHubAppJsonWithRetry(
      `${root(access)}/pulls/${number}/reviews/${approval.id}/dismissals`,
      access.token,
      "Dismiss earlier approval",
      {
        method: "PUT",
        jsonBody: { message },
      },
    ).catch((error) => {
      kept.push(approval.id);
      console.warn(
        "Earlier Gitdog approval could not be dismissed:",
        error instanceof Error ? error.message : "unknown error",
      );
    });
  return kept;
}
export const publish = internalAction({
  args: { actionId: v.id("ticketActions"), manual: v.boolean() },
  handler: async (
    ctx,
    args,
  ): Promise<{ success: boolean; reason?: string }> => {
    let claimed: number | false = false;
    // Set once a review POST may have reached GitHub. Before that, or when
    // GitHub answered with an error, nothing was posted for certain.
    let mayHavePosted = false;
    try {
      const initial = await ctx.runQuery(
        internal.pullRequests.internalQuery.get,
        { actionId: args.actionId },
      );
      if (
        !initial ||
        initial.action.reviewVerificationOnly === true ||
        initial.action.status !==
          (args.manual ? "pending_approval" : "approved")
      ) {
        await ctx.runMutation(
          internal.pullRequests.internalMutation
            .observeAfterUnclaimedPublication,
          { actionId: args.actionId },
        );
        return {
          success: false,
          reason: "Review is not ready for publication",
        };
      }
      const source = sourceOf(initial.action.proposedChanges?.source);
      const access = await runReviewRequest(
        { operation: "Verify GitHub App repository access" },
        () => resolveVerifiedRepositoryAccess(ctx, initial.repository._id),
      );
      const live = await getPullRequest(access, initial.ticket.githubNumber);
      if (!sameSource(live))
        throw new Error("Pull request changed after the review was generated");
      // A dropped push is fine, but a force push that removed the reviewed
      // commit would make GitHub refuse the review after it is claimed.
      if (live.head.sha !== source.headSha) {
        const { status } = await readReviewJson<{ status: string }>(
          access,
          `/compare/${source.headSha}...${live.head.sha}?per_page=1`,
          "Read pull request history",
        );
        if (status !== "ahead" && status !== "identical")
          throw new Error(
            "Pull request changed after the review was generated",
          );
      }
      const proposal = initial.action.proposedChanges;
      const findings = proposal?.findings as Finding[];
      if (!Array.isArray(findings) || findings.length > MAX_REVIEW_FINDINGS)
        throw new Error("Review findings are invalid");
      // Re-read diff and evidence at publication, including after human approval.
      const batched = typeof proposal.batchCount === "number";
      const data =
        findings.length === 0
          ? undefined
          : // Re-read only the files the findings need, on the reviewed
            // commit. Evidence in a changed file is re-read around its diff
            // when the review saw it that way, so its diff is needed too.
            await snapshot(access, pinned(live, source), false, {
              findingPaths: new Set(
                findings.flatMap((finding) => [
                  finding.path,
                  ...finding.evidence
                    .filter((e) => e.ref === "head")
                    .map((e) => e.path),
                ]),
              ),
            });
      if (data) {
        // Re-read each quoted file the way the review group that quoted it
        // saw it. Two groups can have seen one file differently, so reads are
        // keyed by that view, and findings are checked one by one when views
        // differ.
        const view = (e: Finding["evidence"][number]) =>
          e.ref === "base"
            ? "base"
            : e.windowed === true
              ? "window"
              : e.windowed === false
                ? "whole"
                : "legacy";
        const cache = new Map<string, Promise<string>>();
        const readEvidence = (e: Finding["evidence"][number]) => {
          const key = `${view(e)}:${e.path}`;
          let content = cache.get(key);
          if (!content) {
            const changed = data.files.find((f) => f.filename === e.path);
            content =
              e.ref === "base"
                ? readReviewSource(access, e.path, data.baseSha)
                : e.windowed === false
                  ? readReviewSource(access, e.path, data.headSha)
                  : readReviewSource(
                      access,
                      e.path,
                      data.headSha,
                      changed,
                      undefined,
                      e.windowed === true ? undefined : 40_000,
                    );
            cache.set(key, content);
          }
          return content;
        };
        const evidenceOf = async (finding: Finding) =>
          await Promise.all(
            finding.evidence.map(async (e) => ({
              path: e.path,
              ref: e.ref,
              content: await readEvidence(e),
            })),
          );
        const views = new Map<string, string>();
        let mixed = false;
        for (const finding of findings)
          for (const e of finding.evidence) {
            const seen = views.get(`${e.ref}:${e.path}`);
            if (seen !== undefined && seen !== view(e)) mixed = true;
            views.set(`${e.ref}:${e.path}`, view(e));
          }
        if (mixed)
          for (const finding of findings)
            validateFindings(
              { findings: [finding] },
              data.files,
              await evidenceOf(finding),
            );
        else {
          const evidence = [];
          for (const finding of findings)
            evidence.push(...(await evidenceOf(finding)));
          validateFindings({ findings }, data.files, evidence);
        }
      }
      const marker = `<!-- gitdog-pr-review:${args.actionId} -->`;
      const { prior, approvals } = await ownReviews(
        access,
        live.number,
        marker,
        source.headSha,
      );
      // Read before claiming, so a slow read never delays a claimed post.
      // A failed read is no reason to fail a review that is ready.
      const threadsOpen =
        findings.length === 0 && canApproveReview(0, proposal.coverageComplete)
          ? await hasUnresolvedOwnThreads(
              access,
              live.number,
              botLogin(),
            ).catch(() => true)
          : true;
      // A follow-up with no new PR changes posts only to approve again.
      if (
        proposal.changedFiles === 0 &&
        findings.length === 0 &&
        (threadsOpen ||
          live.head.sha !== source.headSha ||
          initial.ticket.pullRequestDroppedAt !== undefined)
      ) {
        await ctx.runMutation(
          internal.pullRequests.internalMutation.completeUnposted,
          { actionId: args.actionId },
        );
        return { success: true };
      }
      claimed = await ctx.runMutation(
        internal.pullRequests.internalMutation.claim,
        args,
      );
      if (!claimed) {
        await ctx.runMutation(
          internal.pullRequests.internalMutation
            .observeAfterUnclaimedPublication,
          { actionId: args.actionId },
        );
        return {
          success: false,
          reason: "Review approval or repository settings changed",
        };
      }
      const findingCount =
        typeof proposal.findingCount === "number"
          ? proposal.findingCount
          : findings.length;
      if (prior) {
        if (prior.state === "APPROVED")
          await ctx.runMutation(
            internal.pullRequests.internalMutation.markApproval,
            { actionId: args.actionId },
          );
        const kept =
          findingCount > 0
            ? await dismissApprovals(
                access,
                live.number,
                approvals,
                `A newer Gitdog review found issues: ${prior.html_url}`,
                prior.id,
              )
            : [];
        await ctx.runMutation(internal.pullRequests.internalMutation.finish, {
          actionId: args.actionId,
          stage: "publication",
          claimedAt: claimed || undefined,
          reviewId: prior.id,
          reviewUrl: prior.html_url,
          inlineFindings: undefined,
          ...(kept.length ? { keptApprovals: kept } : {}),
        });
        return { success: true };
      }
      const current = await guard(
        ctx,
        args.actionId,
        source,
        "publication",
        args.manual,
      );
      const latest = await getPullRequest(current.access, live.number);
      if (!sameSource(latest))
        throw new Error("Pull request changed before publication");
      // POST has no automatic retries: an ambiguous external write must never be
      // repeated and spam the PR. Commit ID binds even a last-millisecond push.
      const posted = await runReviewRequest(
        { operation: "Publish GitHub review" },
        async () => {
          const suggestions =
            current.state.repository.settings.pullRequestSuggestionsEnabled !==
            false;
          const coverage =
            typeof proposal.changedFiles === "number" &&
            typeof proposal.uncoveredFiles === "number"
              ? {
                  changedFiles: proposal.changedFiles,
                  uncoveredFiles: proposal.uncoveredFiles,
                  since:
                    typeof proposal.reviewedSince === "string"
                      ? proposal.reviewedSince
                      : undefined,
                }
              : undefined;
          // Approve only fully covered changes with no finding left open,
          // including one an earlier Gitdog review raised, and only while
          // the reviewed commit is still the PR head.
          let approve =
            canApproveReview(findingCount, proposal.coverageComplete) &&
            !threadsOpen &&
            latest.head.sha === source.headSha &&
            current.state.ticket.pullRequestDroppedAt === undefined;
          // Recorded before posting, so an approval whose outcome is unclear
          // is still withdrawn after a later push.
          if (approve)
            await ctx.runMutation(
              internal.pullRequests.internalMutation.markApproval,
              { actionId: args.actionId },
            );
          // A follow-up with no new PR changes posts only to approve again.
          const noChange = proposal.changedFiles === 0 && findingCount === 0;
          if (noChange && !approve) return null;
          const body = (approved: boolean) =>
            reviewBody(
              findingCount,
              source.headSha,
              coverage,
              findingCount > findings.length
                ? [
                    `Showing the ${findings.length} highest-priority findings out of ${findingCount}.`,
                  ]
                : [],
              approved,
            );
          // Every finding becomes its own thread unless some are left out
          // or GitHub refuses the inline comments.
          let inlineFindings = findingCount === findings.length;
          const post = (payload: Record<string, unknown>) =>
            fetch(`${root(current.access)}/pulls/${live.number}/reviews`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${current.access.token}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": GITHUB_API_VERSION,
                "User-Agent": "Gitdog",
              },
              body: JSON.stringify({
                commit_id: source.headSha,
                event: approve ? "APPROVE" : "COMMENT",
                ...payload,
              }),
              signal: AbortSignal.timeout(30_000),
            });
          mayHavePosted = true;
          let response = await post({
            body: `${body(approve)}\n\n${marker}`,
            ...(findings.length
              ? { comments: reviewComments(findings, suggestions) }
              : {}),
          });
          // GitHub creates nothing when it refuses an approval, for example
          // after a merge, so the same review is posted as a comment.
          if (response.status === 422 && approve) {
            await response.body?.cancel().catch(() => undefined);
            if (noChange) return null;
            approve = false;
            response = await post({ body: `${body(false)}\n\n${marker}` });
          }
          // GitHub creates nothing when it rejects an inline comment, so a
          // batched review that cost many batches falls back to one body.
          if (response.status === 422 && batched && findings.length) {
            await response.body?.cancel().catch(() => undefined);
            inlineFindings = false;
            response = await post({
              body: `${combinedReviewBody(
                findings,
                source.headSha,
                {
                  batchCount: proposal.batchCount,
                  findingCount,
                  changedFiles: proposal.changedFiles,
                  uncoveredFiles: proposal.uncoveredFiles,
                },
                suggestions,
              )}\n\n${marker}`,
            });
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            // A client error means GitHub created no review; a server error
            // may come after it did.
            if (response.status < 500) mayHavePosted = false;
            throw new Error(
              `Publish GitHub review failed (HTTP ${response.status})`,
            );
          }
          const result = (await response.json()) as Review;
          if (
            !Number.isSafeInteger(result.id) ||
            result.commit_id !== source.headSha ||
            !result.body?.includes(marker)
          )
            throw new Error("GitHub review result could not be verified");
          return { ...result, approve, inlineFindings };
        },
      );
      if (!posted) {
        await ctx.runMutation(
          internal.pullRequests.internalMutation.completeUnposted,
          { actionId: args.actionId, claimedAt: claimed || undefined },
        );
        return { success: true };
      }
      // An approval no longer holds once a review finds issues. The post is
      // already made, so a dismissal that fails is recorded, never turned
      // into a failed review.
      const kept =
        findingCount > 0
          ? await dismissApprovals(
              current.access,
              live.number,
              approvals,
              `A newer Gitdog review found issues: ${posted.html_url}`,
              posted.id,
            )
          : [];
      await ctx.runMutation(internal.pullRequests.internalMutation.finish, {
        actionId: args.actionId,
        stage: "publication",
        claimedAt: claimed || undefined,
        reviewId: posted.id,
        reviewUrl: posted.html_url,
        inlineFindings: posted.inlineFindings,
        ...(kept.length ? { keptApprovals: kept } : {}),
      });
      return { success: true };
    } catch (error) {
      await ctx.runMutation(internal.pullRequests.internalMutation.finish, {
        actionId: args.actionId,
        stage: claimed ? "publication" : "preflight",
        // A pull request that moved on before anything could be posted was
        // cancelled.
        cancelled: !mayHavePosted && isLifecycleChange(error),
        claimedAt: claimed || undefined,
        error: !claimed
          ? "Review is stale or GitHub access is unavailable; no review was published"
          : mayHavePosted
            ? "GitHub publication outcome requires inspection; no automatic retry was performed"
            : "GitHub did not accept the review; no review was published",
        reviewFailureDetails: reviewFailureDetails(
          error,
          claimed ? "Review publication" : "Publication preflight",
        ),
      });
      return {
        success: false,
        reason:
          "Review could not be safely published. Inspect the PR and its current commit.",
      };
    }
  },
});

/**
 * Withdraw Gitdog's approvals of commits older than the PR head after a push.
 * The ticket forgets the approval only once this ran, so a failure is
 * retried on the next push.
 */
export const dismissStaleApproval = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    number: v.number(),
    ticketId: v.id("tickets"),
    staleSha: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const access = await resolveVerifiedRepositoryAccess(
      ctx,
      args.repositoryId,
    );
    const pr = await getPullRequest(access, args.number);
    const { approvals } = await ownReviews(access, args.number, null, "");
    // An approval of the current head is a newer review's; keep it.
    const stale = approvals.filter(
      (approval) => approval.commit_id !== pr.head.sha,
    );
    const kept = await dismissApprovals(
      access,
      args.number,
      stale,
      `New commits were pushed after the commit Gitdog approved. Comment @${getConfiguredGitHubAppSlug() ?? "gitdogai"} review to review them.`,
    );
    // Remembered until GitHub accepts every dismissal, including any past
    // the per-run cap, so a later push retries.
    if (kept.length || stale.length > 5) return;
    await ctx.runMutation(
      internal.pullRequests.internalMutation.forgetApproval,
      { ticketId: args.ticketId, staleSha: args.staleSha },
    );
  },
});

/** Best effort: the review runs whether or not GitHub takes the comment. */
async function postReviewingStatus(
  ctx: ActionCtx,
  access: VerifiedRepositoryAccess,
  state: {
    action: Doc<"ticketActions">;
    ticket: Doc<"tickets">;
  },
  data: { changedFiles: number },
) {
  const slug = getConfiguredGitHubAppSlug();
  if (!slug) return;
  const body = reviewStatusBody(
    {
      ...state.action,
      proposedChanges: {
        ...state.action.proposedChanges,
        changedFiles: data.changedFiles,
      },
    },
    slug,
  );
  if (!body) return;
  try {
    const commentId = await addIssueComment(
      access.owner,
      access.repo,
      state.ticket.githubNumber,
      body,
      access.token,
    );
    await ctx.runMutation(
      internal.pullRequests.internalMutation.recordStatusComment,
      { actionId: state.action._id, commentId, reviewing: true },
    );
  } catch (error) {
    console.warn(
      "Review status comment could not be posted:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

async function reply(
  access: VerifiedRepositoryAccess,
  number: number,
  body: string,
) {
  await addIssueComment(access.owner, access.repo, number, body, access.token);
}

export type PullRequestCommandResult =
  | {
      command: "review" | "full_review";
      status:
        | "started"
        | "running"
        | "up_to_date"
        | "unavailable"
        | "closed"
        | "bot_author"
        | "awaiting_approval"
        | "stale"
        | "not_allowed";
      headSha?: string;
      // The review a "started" request queued.
      actionId?: Id<"ticketActions"> | null;
    }
  | { command: "resolve"; resolved: number; open: number };

/**
 * Run a review, full review or resolve command on a pull request. Comment
 * commands and the CLI share this, so both behave the same.
 */
export async function runPullRequestCommand(
  ctx: ActionCtx,
  access: VerifiedRepositoryAccess,
  repositoryId: Id<"repositories">,
  number: number,
  command: "review" | "full_review" | "resolve",
): Promise<PullRequestCommandResult> {
  if (command === "resolve")
    return {
      command,
      ...(await resolveOwnThreads(access, number, botLogin())),
    };
  // Stamped before the read, so a push observed meanwhile wins.
  const observedAt = Date.now();
  const pr = await getPullRequest(access, number);
  if (isBotPullRequestAuthor(pr.user))
    return { command, status: "bot_author", headSha: pr.head.sha };
  if (pr.state !== "open" || pr.draft)
    return { command, status: "closed", headSha: pr.head.sha };
  const result = await ctx.runMutation(
    internal.pullRequests.internalMutation.requestReview,
    {
      repositoryId,
      number,
      observedAt,
      author: pr.user.login,
      open: true,
      snapshot: {
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        title: pr.title,
        body: pr.body ?? "",
      },
      full: command === "full_review",
    },
  );
  return {
    command,
    status: result.status,
    headSha: pr.head.sha,
    actionId: result.actionId,
  };
}

/** The reply a command comment gets on the pull request. */
export function commandReply(
  result: PullRequestCommandResult,
  slug: string,
): string {
  const mention = `@${slug}`;
  if (result.command === "resolve")
    return result.open === 0
      ? "**No open Gitdog review threads to resolve.**"
      : result.resolved === result.open
        ? `**Resolved ${result.resolved} Gitdog review ${result.resolved === 1 ? "thread" : "threads"}.**`
        : `**Resolved ${result.resolved} of ${result.open} Gitdog review threads.** GitHub refused the rest; try again or resolve them on GitHub.`;
  switch (result.status) {
    case "started":
      return `**${result.command === "full_review" ? "Full review" : "Review"} started** for ${result.headSha}`;
    case "running":
      return `**A review is already running.** Comment \`${mention} review\` again once it is posted.`;
    case "up_to_date":
      return `**Already reviewed** ${result.headSha}\n\nComment \`${mention} full review\` to review the whole pull request again.`;
    case "closed":
      return "**Review not started**\n\nGitdog reviews open pull requests that are ready for review.";
    case "bot_author":
      return "**Review not started**\n\nGitdog does not review pull requests opened by bots, such as Dependabot.";
    case "awaiting_approval":
      return "**A review of this commit is waiting for approval.** The repository owner can post it from Gitdog.";
    case "stale":
      return `**Review not started**\n\nGitdog is processing a newer update to this pull request. Comment \`${mention} review\` again in a moment.`;
    case "not_allowed":
      return (
        "**Full review not started**\n\nOnly repository collaborators can request a full review. The pull request author can comment `" +
        mention +
        " review`."
      );
    default:
      return "**Review not started**\n\nPull request reviews are not available for this repository right now.";
  }
}

/** Run one "@gitdogai <command>" comment on a pull request and answer it. */
export const runCommand = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    number: v.number(),
    command: v.union(
      v.literal("review"),
      v.literal("full_review"),
      v.literal("resolve"),
      v.literal("help"),
      v.literal("pause_now"),
      v.literal("not_allowed"),
    ),
    login: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const slug = getConfiguredGitHubAppSlug();
    if (!slug) return;
    const access = await resolveVerifiedRepositoryAccess(
      ctx,
      args.repositoryId,
    );
    switch (args.command) {
      case "pause_now":
        return reply(
          access,
          args.number,
          `**Commands paused**\n\n@${args.login} sent too many Gitdog commands, so commands from this account are paused on this repository for 24 hours.`,
        );
      case "help":
        return reply(access, args.number, helpText(slug));
      case "not_allowed":
        return reply(
          access,
          args.number,
          commandReply({ command: "full_review", status: "not_allowed" }, slug),
        );
      default: {
        const result = await runPullRequestCommand(
          ctx,
          access,
          args.repositoryId,
          args.number,
          args.command,
        ).catch(async (error) => {
          // A command that could not run says so instead of going silent.
          await reply(
            access,
            args.number,
            "**Command not completed**\n\nGitdog could not reach GitHub or the review queue. Try again in a few minutes.",
          ).catch(() => undefined);
          throw error;
        });
        // A started review announces itself in its status comment.
        if (result.command !== "resolve" && result.status === "started") return;
        return reply(access, args.number, commandReply(result, slug));
      }
    }
  },
});

/**
 * Bring a review's status comment up to date once its outcome is known: post
 * one for a failure or a no-change follow-up that has none yet, and
 * otherwise edit it in place. A running review is left alone; its comment
 * already says so.
 */
export const settleStatusComment = internalAction({
  args: { actionId: v.id("ticketActions") },
  handler: async (ctx, args): Promise<void> => {
    const slug = getConfiguredGitHubAppSlug();
    if (!slug) return;
    const read = () =>
      ctx.runQuery(internal.pullRequests.internalQuery.get, args);
    // Whether this state changes the pull request at all, decided before
    // any GitHub token is fetched.
    const plan = (state: NonNullable<Awaited<ReturnType<typeof read>>>) => {
      const { action } = state;
      if (
        action.reviewVerificationOnly === true ||
        action.status === "pending" ||
        action.status === "approved"
      )
        return null;
      const body = reviewStatusBody(action, slug);
      if (!body) return null;
      if (action.statusCommentId !== undefined)
        return { body, commentId: action.statusCommentId };
      // Only something a reader is waiting on gets a new comment: a failure
      // worth retrying or a requested no-change result, while reviews stay on.
      const wanted =
        action.status === "failed"
          ? !isCancelledReview(action)
          : action.executionResult?.reason === "no_new_changes" &&
            action.reviewRequested === true;
      return wanted &&
        state.ticket.status === "open" &&
        state.repository.settings.pullRequestReviewsEnabled === true
        ? { body, commentId: undefined }
        : null;
    };
    const first = await read();
    if (!first || !plan(first)) return;
    const access = await resolveVerifiedRepositoryAccess(
      ctx,
      first.repository._id,
    );
    // Re-read right before writing, so a late settle never overwrites a
    // newer outcome with an older one.
    const state = await read();
    const next = state && plan(state);
    if (!state || !next) return;
    const { action } = state;
    // An automatic review that failed counts toward the daily allowance
    // whether it edits its comment or needs a new one.
    const automaticFailure =
      action.reviewRequested !== true &&
      action.status === "failed" &&
      !isCancelledReview(action);
    if (next.commentId !== undefined) {
      await updateIssueComment(
        access.owner,
        access.repo,
        next.commentId,
        next.body,
        access.token,
      );
      if (automaticFailure)
        await ctx.runMutation(
          internal.pullRequests.internalMutation.stampAutomaticNotice,
          { ticketId: state.ticket._id },
        );
      return;
    }
    if (
      automaticFailure &&
      !(await ctx.runMutation(
        internal.pullRequests.internalMutation.claimAutomaticNotice,
        { ticketId: state.ticket._id },
      ))
    )
      return;
    const commentId = await addIssueComment(
      access.owner,
      access.repo,
      state.ticket.githubNumber,
      next.body,
      access.token,
    );
    await ctx.runMutation(
      internal.pullRequests.internalMutation.recordStatusComment,
      { actionId: args.actionId, commentId },
    );
  },
});
