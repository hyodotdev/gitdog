import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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
  ReviewQuotaError,
  reviewGenerationError,
  reviewFailureCause,
  reviewFailureDetails,
  runReviewRequest,
} from "./errors";
import {
  combinedReviewBody,
  hasReviewablePatch,
  MAX_REVIEW_FINDINGS,
  reviewBody,
  reviewComments,
  validateFindings,
  type ChangedFile,
  type Finding,
} from "./review";
import { GITHUB_API_VERSION } from "../github/helpers";

type Source = { headSha: string; baseSha: string; title: string; body: string };
function readReviewSource(
  access: VerifiedRepositoryAccess,
  path: string,
  commit: string,
  changed?: ChangedFile,
) {
  return runReviewRequest(
    { operation: "Read GitHub source file", file: { path, commit } },
    () => readReviewFile(access, path, commit, changed),
  );
}

function sameSource(
  pr: PullRequest,
  source: Source,
  verificationOnly = false,
): boolean {
  return (
    (verificationOnly || pr.state === "open") &&
    !isBotPullRequestAuthor(pr.user) &&
    !pr.draft &&
    // Title and description edits do not change the reviewed commit.
    pr.head.sha === source.headSha &&
    pr.base.sha === source.baseSha
  );
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

const REVIEW_COVERAGE_PREVIEW = 100;
const MAX_FAILED_REVIEW_GROUPS = 2;
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
      const pr = await getPullRequest(access, initial.ticket.githubNumber);
      if (isBotPullRequestAuthor(pr.user))
        throw new Error("Bot-authored pull requests are not reviewed");
      if (!sameSource(pr, source, verificationOnly))
        throw new Error("Pull request changed before review");
      const previous = initial.action.reviewBatch?.result;
      // A push after a finished review covers only the files it changed, as
      // long as they fit one review; otherwise the whole PR is reviewed.
      const since = initial.action.reviewSince;
      let scoped: Awaited<ReturnType<typeof snapshot>> | undefined;
      let changed: Set<string> | undefined;
      if (since && !batched && !verificationOnly) {
        const scope = await changedSince(access, since, pr);
        // Files the earlier review could not cover get another chance.
        if (scope) {
          const candidate = await snapshot(access, pr, verificationOnly, {
            findingPaths: new Set([...scope.paths, ...since.uncoveredPaths]),
          });
          // A removed file the earlier review listed has nothing to review.
          const files = candidate.files.filter(
            (f) => f.status !== "removed" || scope.paths.has(f.filename),
          );
          if (
            // The scope is only valid against the merge base it was built on.
            candidate.baseSha === scope.mergeBaseSha &&
            files.length <= BATCH_REVIEW_THRESHOLD &&
            JSON.stringify(files).length <= REVIEW_DIFF_BUDGET
          ) {
            scoped = { ...candidate, files };
            changed = scope.paths;
          }
        }
      }
      batched ||= !scoped && pr.changed_files > BATCH_REVIEW_THRESHOLD;
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
                  paged.files.length === pr.changed_files &&
                  !splitReviewDiff(paged.files).flat().some(hasReviewablePatch)
                )
                  throw error;
                batched = true;
                return paged;
              },
            );
      if (
        previous &&
        (previous.changedFiles !== pr.changed_files ||
          previous.mergeBaseSha !== data.baseSha)
      )
        throw new Error("Pull request changed while reading its diff");
      if (scoped && !data.files.some(hasReviewablePatch)) {
        // Nothing reviewable changed in this PR's diff, such as a merge of the
        // base branch or a deletion, so no model call is made. A binary or
        // oversized file this push changed is reported as not reviewed; one
        // carried from an earlier review is carried again without a post.
        const unreviewable = data.files.filter((f) => f.status !== "removed");
        const reported = unreviewable.filter((f) => changed?.has(f.filename));
        await ctx.runMutation(internal.pullRequests.internalMutation.propose, {
          actionId: args.actionId,
          source,
          findings: [],
          excludedPaths: unreviewable.map((f) => f.filename),
          filesRead: [],
          mergeBaseSha: data.baseSha,
          coverage: {
            changedFiles: reported.length,
            uncoveredFiles: reported.length,
            since: since?.headSha,
          },
        });
        return;
      }
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
      const filesRead = new Set(previous?.filesRead);
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
                minimumReviewBatches(pr.changed_files - data.files.length),
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
                  )
                : readReviewSource(access, path, data.baseSha),
          });
        } catch (error) {
          // A failure that keeps recurring is not one bad response; stop
          // instead of paying for every remaining batch.
          if (
            !batched ||
            failedGroups >= MAX_FAILED_REVIEW_GROUPS ||
            !isReviewGroupModelFailure(error)
          )
            throw error;
          failedGroups++;
          // Keep the batches already paid for and report this group as not
          // reviewed, as when its files cannot be read.
          await ensureCurrent();
          result = {
            findings: [],
            reads: [],
            excludedPaths: selected.map((file) => file.filename),
          };
        }
        findings.push(...result.findings);
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
          : fileKeys.size < pr.changed_files
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
        !sameSource(
          await getPullRequest(access, pr.number),
          source,
          verificationOnly,
        )
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
              changedFiles: pr.changed_files,
              batchCount: (previous?.batchCount ?? 0) + 1,
              mergeBaseSha: data.baseSha,
              fileKeys: [...fileKeys],
              findingCount,
              inspectedFiles,
              uncoveredFiles,
              failedGroups,
              remainingBatches: next
                ? groups.length -
                  group -
                  1 +
                  minimumReviewBatches(pr.changed_files - fileKeys.size)
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
              }
            : { changedFiles: pr.changed_files, uncoveredFiles },
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
  user: { type: string; login: string };
};
async function existingReview(
  access: VerifiedRepositoryAccess,
  number: number,
  marker: string,
  sha: string,
): Promise<Review | null> {
  for (let page = 1; page <= 5; page++) {
    const reviews = await readReviewJson<Review[]>(
      access,
      `/pulls/${number}/reviews?per_page=100&page=${page}`,
      "Reconcile pull request review",
    );
    if (!Array.isArray(reviews))
      throw new Error("Review history is unavailable");
    const own = reviews.find(
      (r) =>
        r.body?.includes(marker) &&
        r.commit_id === sha &&
        r.user?.type === "Bot" &&
        r.user.login.toLowerCase() ===
          `${process.env.GITHUB_APP_SLUG}[bot]`.toLowerCase(),
    );
    if (own) return own;
    if (reviews.length < 100) return null;
  }
  throw new Error("Review history exceeded the reconciliation limit");
}
export const publish = internalAction({
  args: { actionId: v.id("ticketActions"), manual: v.boolean() },
  handler: async (
    ctx,
    args,
  ): Promise<{ success: boolean; reason?: string }> => {
    let claimed: number | false = false;
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
      )
        return {
          success: false,
          reason: "Review is not ready for publication",
        };
      const source = sourceOf(initial.action.proposedChanges?.source);
      const access = await runReviewRequest(
        { operation: "Verify GitHub App repository access" },
        () => resolveVerifiedRepositoryAccess(ctx, initial.repository._id),
      );
      const live = await getPullRequest(access, initial.ticket.githubNumber);
      if (!sameSource(live, source))
        throw new Error("Pull request changed after the review was generated");
      const proposal = initial.action.proposedChanges;
      const findings = proposal?.findings as Finding[];
      if (!Array.isArray(findings) || findings.length > MAX_REVIEW_FINDINGS)
        throw new Error("Review findings are invalid");
      // Re-read diff and evidence at publication, including after human approval.
      const batched = typeof proposal.batchCount === "number";
      const data =
        findings.length === 0
          ? undefined
          : // A follow-up review of a large PR may exceed the single diff
            // budget, so it re-reads only the files its findings need.
            batched || typeof proposal.reviewedSince === "string"
            ? await snapshot(access, live, false, {
                // Evidence in a large changed file is re-read around its diff,
                // as it was during review, so its diff is needed too.
                findingPaths: new Set(
                  findings.flatMap((finding) => [
                    finding.path,
                    ...finding.evidence
                      .filter((e) => e.ref === "head")
                      .map((e) => e.path),
                  ]),
                ),
              })
            : await snapshot(access, live);
      if (data) {
        const evidence = [];
        const references = new Set<string>();
        for (const finding of findings) {
          for (const e of finding.evidence) {
            const key = `${e.ref}:${e.path}`;
            if (references.has(key)) continue;
            references.add(key);
            evidence.push({
              path: e.path,
              ref: e.ref,
              content:
                e.ref === "head"
                  ? await readReviewSource(
                      access,
                      e.path,
                      data.headSha,
                      data.files.find((file) => file.filename === e.path),
                    )
                  : await readReviewSource(access, e.path, data.baseSha),
            });
          }
        }
        validateFindings({ findings }, data.files, evidence);
      }
      const marker = `<!-- gitdog-pr-review:${args.actionId} -->`;
      const prior = await existingReview(
        access,
        live.number,
        marker,
        source.headSha,
      );
      claimed = await ctx.runMutation(
        internal.pullRequests.internalMutation.claim,
        args,
      );
      if (!claimed)
        return {
          success: false,
          reason: "Review approval or repository settings changed",
        };
      if (prior) {
        await ctx.runMutation(internal.pullRequests.internalMutation.finish, {
          actionId: args.actionId,
          stage: "publication",
          claimedAt: claimed || undefined,
          reviewId: prior.id,
          reviewUrl: prior.html_url,
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
      if (
        !sameSource(await getPullRequest(current.access, live.number), source)
      )
        throw new Error("Pull request changed before publication");
      // POST has no automatic retries: an ambiguous external write must never be
      // repeated and spam the PR. Commit ID binds even a last-millisecond push.
      const posted = await runReviewRequest(
        { operation: "Publish GitHub review" },
        async () => {
          const suggestions =
            current.state.repository.settings.pullRequestSuggestionsEnabled !==
            false;
          const findingCount = batched
            ? proposal.findingCount
            : findings.length;
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
          const body = [
            reviewBody(findingCount, source.headSha, coverage),
            ...(batched && findingCount > findings.length
              ? [
                  `Showing the ${findings.length} highest-priority findings out of ${findingCount}.`,
                ]
              : []),
          ].join("\n\n");
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
                event: "COMMENT",
                ...payload,
              }),
              signal: AbortSignal.timeout(30_000),
            });
          let response = await post({
            body: `${body}\n\n${marker}`,
            ...(findings.length
              ? { comments: reviewComments(findings, suggestions) }
              : {}),
          });
          // GitHub creates nothing when it rejects an inline comment, so a
          // batched review that cost many batches falls back to one body.
          if (response.status === 422 && batched && findings.length) {
            await response.body?.cancel().catch(() => undefined);
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
          return result;
        },
      );
      await ctx.runMutation(internal.pullRequests.internalMutation.finish, {
        actionId: args.actionId,
        stage: "publication",
        claimedAt: claimed || undefined,
        reviewId: posted.id,
        reviewUrl: posted.html_url,
      });
      return { success: true };
    } catch (error) {
      await ctx.runMutation(internal.pullRequests.internalMutation.finish, {
        actionId: args.actionId,
        stage: claimed ? "publication" : "preflight",
        claimedAt: claimed || undefined,
        error: claimed
          ? "GitHub publication outcome requires inspection; no automatic retry was performed"
          : "Review is stale or GitHub access is unavailable; no review was published",
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
