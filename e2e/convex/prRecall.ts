import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
} from "../../convex/_generated/server";
import { PRICING } from "../../convex/_ai/config";
import { createMeteredProvider } from "../../convex/_ai/chatBilling";
import { getDefaultAiModel } from "../../convex/_ai/model";
import { CreditFallbackProvider } from "../../convex/_ai/providers";
import { reviewWithContext } from "../../convex/pullRequests/workflow";
import { ReviewContextLimitError } from "../../convex/pullRequests/errors";
import {
  hasReviewablePatch,
  windowChangedSource,
  type ChangedFile,
} from "../../convex/pullRequests/review";

function guard() {
  if (
    process.env.CONVEX_SITE_URL !==
    "https://fortunate-chihuahua-679.convex.site"
  )
    throw new Error("Development review evaluation only");
}

// Replays run on Gitdog's development key at Opus's weight, more than a fresh
// account's trial covers, so the fixture account is on Pro for the run.
export const fundReplay = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    guard();
    const now = Date.now();
    return await ctx.db.insert("subscriptions", {
      userId: args.userId,
      plan: "pro",
      status: "active",
      proEntitlementProvenance: {
        source: "lemon_squeezy_webhook",
        verifiedAt: now,
      },
      includedTokens: PRICING.PRO_INCLUDED_TOKENS,
      purchasedTokens: 0,
      serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
      periodStart: now - 1_000,
      periodEnd: now + 3 * 60 * 60_000,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const unfundReplay = internalMutation({
  args: { subscriptionId: v.id("subscriptions") },
  handler: async (ctx, args) => {
    guard();
    const subscription = await ctx.db.get(args.subscriptionId);
    if (
      subscription?.proEntitlementProvenance?.source === "lemon_squeezy_webhook"
    )
      await ctx.db.delete(args.subscriptionId);
  },
});

const changedFile = v.object({
  filename: v.string(),
  status: v.string(),
  additions: v.number(),
  deletions: v.number(),
  patch: v.optional(v.string()),
});

// Reads a public repository at a pinned commit with the size and windowing
// rules production reviews use (readReviewFile).
async function readPublic(
  repository: string,
  path: string,
  sha: string,
  changed?: ChangedFile,
): Promise<string> {
  const response = await fetch(
    `https://raw.githubusercontent.com/${repository}/${sha}/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  );
  if (!response.ok) throw new ReviewContextLimitError();
  const content = await response.text();
  if (content.includes("\u0000")) throw new ReviewContextLimitError();
  const bytes = new TextEncoder().encode(content).length;
  if (!changed?.patch || !hasReviewablePatch(changed)) {
    if (bytes > 40_000) throw new ReviewContextLimitError();
    return content;
  }
  if (bytes <= 24_000) return content;
  const windowed = windowChangedSource(content, changed.patch);
  if (windowed !== null) return windowed;
  if (bytes <= 40_000) return content;
  throw new ReviewContextLimitError();
}

/**
 * Replays the reviewer on a real commit of a public repository, so its
 * findings can be scored against issues found there by other reviewers.
 */
export const replayReview = internalAction({
  args: {
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    actionId: v.id("ticketActions"),
    repository: v.string(),
    headSha: v.string(),
    baseSha: v.string(),
    title: v.string(),
    body: v.string(),
    files: v.array(changedFile),
    paths: v.array(v.string()),
    basePaths: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    guard();
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(args.repository) ||
      !/^[a-f0-9]{40}$/.test(args.headSha) ||
      !/^[a-f0-9]{40}$/.test(args.baseSha)
    )
      throw new Error("Invalid replay source");
    const route = getDefaultAiModel();
    if (!(route instanceof CreditFallbackProvider))
      throw new Error("Unexpected provider route");
    const provider = createMeteredProvider(ctx, {
      userId: args.userId,
      repositoryId: args.repositoryId,
      ticketActionId: args.actionId,
      generationKey: `pr-recall/${args.actionId}/${args.headSha}`,
      operation: "pr-review-recall",
      provider: route.primary,
      requirePendingTicketAction: true,
    });
    const files = args.files as ChangedFile[];
    const started = Date.now();
    const trace: unknown[] = [];
    const result = await reviewWithContext({
      trace: (event) => trace.push(event),
      // As production single reviews run.
      secondLooks: true,
      provider,
      repository: args.repository,
      title: args.title,
      body: args.body,
      files,
      paths: args.paths,
      basePaths: args.basePaths,
      read: (path, ref) =>
        ref === "head"
          ? readPublic(
              args.repository,
              path,
              args.headSha,
              files.find((f) => f.filename === path),
            )
          : readPublic(args.repository, path, args.baseSha),
      guard: async () => guard(),
    });
    return {
      seconds: Math.round((Date.now() - started) / 1000),
      findings: result.findings.map((f) => ({
        path: f.path,
        line: f.line,
        priority: f.priority,
        confidence: f.confidence,
        title: f.title,
      })),
      headReads: result.reads.filter((r) => r.ref === "head").length,
      trace,
      excludedPaths: result.excludedPaths,
    };
  },
});
