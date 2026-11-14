import { convexTest } from "convex-test";
import { getFunctionName, type AnyFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import { PRICING } from "../../../convex/_ai/config";
import {
  createBillingGenerationKey,
  createMeteredProvider,
  getChatReservationLimits,
  recoveryTargetsMatch,
} from "../../../convex/_ai/chatBilling";
import {
  PENDING_GENERATION_LEASE_MS,
  PENDING_GENERATION_TTL_MS,
} from "../../../convex/_ai/chatRecovery";
import type { AiProvider } from "../../../convex/_ai/model";
import { ChatProviderRequestError } from "../../../convex/_ai/providerErrors";
import { settleEndedTrustedProSubscriptionQuota } from "../../../convex/subscriptions/billingBoundaries";
import schema from "../../../convex/schema";
import {
  ClaudeProvider,
  OpenAIProvider,
  CreditFallbackProvider,
} from "../../../convex/_ai/providers";
import {
  CLAUDE_API_ENDS_AT,
  GENERATION_MODELS,
} from "../../../convex/_ai/config";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/_ai/chatBilling.ts": () =>
    import("../../../convex/_ai/chatBilling"),
  "../../../convex/_ai/embeddingBilling.ts": () =>
    import("../../../convex/_ai/embeddingBilling"),
  "../../../convex/tokenUsage/internalMutation.ts": () =>
    import("../../../convex/tokenUsage/internalMutation"),
  "../../../convex/admin/paymentMutation.ts": () =>
    import("../../../convex/admin/paymentMutation"),
  "../../../convex/admin/utils.ts": () => import("../../../convex/admin/utils"),
};

it("reserves input quota for structured-output schemas as well as messages", () => {
  const messages = [{ role: "user" as const, content: "Review this change" }];
  const plain = getChatReservationLimits(messages);
  const structured = getChatReservationLimits(messages, {
    responseFormat: {
      name: "review",
      schema: {
        type: "object",
        description: "Schema instructions. ".repeat(100),
      },
    },
  });
  expect(structured.inputTokenLimit).toBeGreaterThan(
    plain.inputTokenLimit + 2000,
  );
  expect(structured.outputTokenLimit).toBe(plain.outputTokenLimit);
});

const originalSiteUrl = process.env.SITE_URL;

beforeEach(() => {
  process.env.SITE_URL = "https://gitdog.dev";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = originalSiteUrl;
});

async function insertFixture(t: ReturnType<typeof convexTest>): Promise<{
  userId: Id<"users">;
  repositoryId: Id<"repositories">;
  ticketActionId: Id<"ticketActions">;
  requirePendingTicketAction: true;
}> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    // The one-time trial is already used, so quota checks see only the
    // allowance each test sets up.
    await ctx.db.insert("trialCreditGrants", {
      userId,
      tokens: 100_000,
      grantedAt: 1,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: Date.now(),
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId: 101,
      githubRepositoryId: 101,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApproval: false,
        requireApprovalForDiscussions: false,
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const ticketId = await ctx.db.insert("tickets", {
      repositoryId,
      userId,
      githubRepo: "owner/repo",
      ticketType: "issue",
      githubNumber: 42,
      githubTitle: "Issue",
      aiInputVersion: 1,
      status: "open",
      createdAt: now,
    });
    const ticketActionId = await ctx.db.insert("ticketActions", {
      ticketId,
      actionType: "answer",
      chatHistory: [],
      proposalVersion: 0,
      status: "pending",
      createdAt: now,
    });
    return {
      userId,
      repositoryId,
      ticketActionId,
      requirePendingTicketAction: true,
    };
  });
}

async function cancelPendingSchedules(
  t: ReturnType<typeof convexTest>,
): Promise<void> {
  await t.run(async (ctx) => {
    const scheduled = await ctx.db.system
      .query("_scheduled_functions")
      .collect();
    for (const job of scheduled) {
      if (job.state.kind === "pending") {
        await ctx.scheduler.cancel(job._id);
      }
    }
  });
}

function reservationArgs(
  fixture: Awaited<ReturnType<typeof insertFixture>>,
  reservationKey: string,
  attempt = 1,
  limits: { inputTokenLimit?: number; outputTokenLimit?: number } = {},
) {
  return {
    ...fixture,
    reservationKey,
    attemptToken: `${reservationKey}:attempt:${attempt}`,
    generationKey: `generation:${reservationKey}`,
    operation: "test-chat",
    model: GENERATION_MODELS.anthropic.modelId,
    provider: "anthropic" as const,
    requestFingerprint: "0".repeat(64),
    inputTokenLimit: limits.inputTokenLimit ?? 2_000,
    outputTokenLimit: limits.outputTokenLimit ?? 2_000,
  };
}

async function insertLegacyEmbeddingReservation(
  t: ReturnType<typeof convexTest>,
  fixture: Awaited<ReturnType<typeof insertFixture>>,
  args: {
    reservationKey: string;
    status: "pending" | "ambiguous";
    providerStartedAt?: number;
    reservedTokens?: number;
  },
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("embeddingUsageReservations", {
      reservationKey: args.reservationKey,
      attemptToken: `${args.reservationKey}:attempt:1`,
      userId: fixture.userId,
      repositoryId: fixture.repositoryId,
      operation: "legacy embedding",
      provider: "openai",
      model: "text-embedding-3-small",
      inputCount: 1,
      providerTokenLimit: 100,
      reservedTokens: args.reservedTokens ?? 2,
      entitlementPlan: "free",
      includedTokens: 0,
      serviceFeeRate: 0,
      quotaPeriodStart: now,
      quotaPeriodEnd: now + 60_000,
      status: args.status,
      providerStartedAt: args.providerStartedAt,
      expiresAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function reserve(
  t: ReturnType<typeof convexTest>,
  args: ReturnType<typeof reservationArgs>,
) {
  return await t.mutation(internal._ai.chatBilling.reserveChatUsage, args);
}

async function markStartResult(
  t: ReturnType<typeof convexTest>,
  args: ReturnType<typeof reservationArgs>,
) {
  return await t.mutation(internal._ai.chatBilling.markChatProviderStarted, {
    reservationKey: args.reservationKey,
    attemptToken: args.attemptToken,
    userId: args.userId,
    repositoryId: args.repositoryId,
    ticketActionId: args.ticketActionId,
  });
}

async function markStarted(
  t: ReturnType<typeof convexTest>,
  args: ReturnType<typeof reservationArgs>,
) {
  return (await markStartResult(t, args)).started;
}

async function finalize(
  t: ReturnType<typeof convexTest>,
  args: ReturnType<typeof reservationArgs>,
  inputTokens = 100,
  outputTokens = 20,
  providerRequestId = "request-1",
) {
  return await t.mutation(internal.tokenUsage.internalMutation.recordUsage, {
    userId: args.userId,
    repositoryId: args.repositoryId,
    ticketActionId: args.ticketActionId,
    inputTokens,
    outputTokens,
    model: args.model,
    provider: "anthropic",
    reservationKey: args.reservationKey,
    reservationAttemptToken: args.attemptToken,
    providerRequestId,
  });
}

function exactUsageProvider(
  chat = vi.fn(async () => ({
    content: "Answer",
    finishReason: "stop" as const,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    provider: "anthropic",
    providerRequestId: "provider-request-exact",
  })),
): AiProvider {
  return {
    name: "AI test provider",
    modelId: GENERATION_MODELS.anthropic.modelId,
    providerId: "anthropic",
    chat,
  };
}

function failingProvider(error: ChatProviderRequestError): AiProvider {
  return {
    name: "AI test provider",
    modelId: GENERATION_MODELS.anthropic.modelId,
    providerId: "anthropic",
    chat: vi.fn(async () => {
      throw error;
    }),
  };
}

function getUntypedMutationRunner(t: ReturnType<typeof convexTest>) {
  return t.mutation.bind(t) as unknown as (
    reference: AnyFunctionReference,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

async function insertAdminUser(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    // The one-time trial is already used, so quota checks see only the
    // allowance each test sets up.
    await ctx.db.insert("trialCreditGrants", {
      userId,
      tokens: 100_000,
      grantedAt: 1,
    });
    const now = Date.now();
    await ctx.db.insert("userProfiles", {
      userId,
      githubUsername: "billing-admin",
      isAdmin: true,
      createdAt: now,
      updatedAt: now,
    });
    return userId;
  });
}

async function insertEndedProPeriod(
  t: ReturnType<typeof convexTest>,
  fixture: Awaited<ReturnType<typeof insertFixture>>,
  args: { purchasedTokens: number; overageTokens: number },
) {
  const now = Date.now();
  const periodEnd = now - 1_000;
  const periodStart = periodEnd - 30 * 24 * 60 * 60 * 1_000;
  return await t.run(async (ctx) => {
    const subscriptionId = await ctx.db.insert("subscriptions", {
      userId: fixture.userId,
      lemonSqueezySubscriptionId: `ended-${fixture.userId}`,
      lemonSqueezyCustomerId: "2201",
      lemonSqueezyVariantId: "9001",
      providerCreatedAt: periodStart,
      providerUpdatedAt: periodEnd,
      proEntitlementProvenance: {
        source: "lemon_squeezy_webhook",
        verifiedAt: periodStart,
      },
      plan: "pro",
      status: "canceled",
      includedTokens: PRICING.PRO_INCLUDED_TOKENS,
      purchasedTokens: args.purchasedTokens,
      serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
      periodStart,
      periodEnd,
      createdAt: periodStart,
      updatedAt: periodEnd,
    });
    const boundaryId = await ctx.db.insert("subscriptionBillingBoundaries", {
      subscriptionId,
      periodStart,
      periodEnd,
      providerUpdatedAt: periodEnd,
      status: "pending",
      createdAt: periodStart,
      updatedAt: periodEnd,
    });
    await ctx.db.insert("tokenUsage", {
      purchasedTokensDebited: 0,
      userId: fixture.userId,
      usageType: "chat",
      inputTokens: PRICING.PRO_INCLUDED_TOKENS + args.overageTokens,
      outputTokens: 0,
      totalTokens: PRICING.PRO_INCLUDED_TOKENS + args.overageTokens,
      inputCostCents: 1,
      outputCostCents: 0,
      baseCostCents: 1,
      serviceFeeCents: PRICING.PLATFORM_FEE_PRO,
      totalCostCents: 1 + PRICING.PLATFORM_FEE_PRO,
      model: GENERATION_MODELS.anthropic.modelId,
      provider: "anthropic",
      serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
      createdAt: periodEnd - 1,
    });
    return { subscriptionId, boundaryId, periodStart, periodEnd };
  });
}

async function insertTrustedProWallet(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  purchasedTokens: number,
): Promise<Id<"subscriptions">> {
  const now = Date.now();
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("subscriptions", {
        userId,
        plan: "pro",
        status: "active",
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now,
        },
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: now - 1_000,
        periodEnd: now + 60_000,
        createdAt: now,
        updatedAt: now,
      }),
  );
}

describe("AI chat usage reservations", () => {
  it("uses a private deterministic digest to separate learning attempts", async () => {
    const first = await createBillingGenerationKey("learning/action-1", [
      "private correction",
      "prior answer",
      "source-1",
    ]);
    const retry = await createBillingGenerationKey("learning/action-1", [
      "private correction",
      "prior answer",
      "source-1",
    ]);
    const next = await createBillingGenerationKey("learning/action-1", [
      "different correction",
      "prior answer",
      "source-1",
    ]);
    expect(retry).toBe(first);
    expect(next).not.toBe(first);
    expect(first).toMatch(/^learning\/action-1\/[a-f0-9]{64}$/);
    expect(first).not.toContain("private correction");
  });

  it("matches equivalent recovery targets independent of object key order", () => {
    expect(
      recoveryTargetsMatch(
        {
          expectedIndexVersion: 1,
          kind: "follow_up",
          forceApproval: true,
          expectedAiInputVersion: 1,
        },
        {
          forceApproval: true,
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
          kind: "follow_up",
        },
      ),
    ).toBe(true);
  });

  it("accepts equivalent recovery targets and rejects identity changes", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const args = reservationArgs(fixture, "reordered-recovery-target");

    await expect(
      t.mutation(internal._ai.chatBilling.reserveChatUsage, {
        ...args,
        recoveryTarget: {
          expectedIndexVersion: 1,
          kind: "follow_up",
          forceApproval: true,
          expectedAiInputVersion: 1,
        },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      t.mutation(internal._ai.chatBilling.reserveChatUsage, {
        ...args,
        attemptToken: `${args.reservationKey}:attempt:2`,
        recoveryTarget: {
          forceApproval: true,
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
          kind: "follow_up",
        },
      }),
    ).resolves.toMatchObject({ allowed: true });

    const mismatches = [
      {
        name: "kind",
        recoveryTarget: {
          kind: "regenerate" as const,
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
      },
      {
        name: "force-approval",
        recoveryTarget: {
          kind: "follow_up" as const,
          forceApproval: false,
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
      },
      {
        name: "ai-input-version",
        recoveryTarget: {
          kind: "follow_up" as const,
          forceApproval: true,
          expectedAiInputVersion: 2,
          expectedIndexVersion: 1,
        },
      },
      {
        name: "index-version",
        recoveryTarget: {
          kind: "follow_up" as const,
          forceApproval: true,
          expectedAiInputVersion: 1,
          expectedIndexVersion: 2,
        },
      },
    ];
    for (const mismatch of mismatches) {
      await expect(
        t.mutation(internal._ai.chatBilling.reserveChatUsage, {
          ...args,
          attemptToken: `${args.reservationKey}:attempt:${mismatch.name}`,
          recoveryTarget: mismatch.recoveryTarget,
        }),
      ).rejects.toThrow("AI chat reservation identity mismatch");
    }

    const initialArgs = reservationArgs(fixture, "changed-recovery-stage");
    await expect(
      t.mutation(internal._ai.chatBilling.reserveChatUsage, {
        ...initialArgs,
        recoveryTarget: {
          kind: "initial_ticket",
          stage: "start",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      t.mutation(internal._ai.chatBilling.reserveChatUsage, {
        ...initialArgs,
        attemptToken: `${initialArgs.reservationKey}:attempt:2`,
        recoveryTarget: {
          kind: "initial_ticket",
          stage: "answer",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
      }),
    ).rejects.toThrow("AI chat reservation identity mismatch");
  });

  it("caps trusted Pro at included plus prepaid tokens across mixed pending reservations", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const subscriptionId = await insertTrustedProWallet(t, fixture.userId, 100);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId: fixture.userId,
        repositoryId: fixture.repositoryId,
        usageType: "chat",
        inputTokens: PRICING.PRO_INCLUDED_TOKENS,
        outputTokens: 0,
        totalTokens: PRICING.PRO_INCLUDED_TOKENS,
        inputCostCents: 0,
        outputCostCents: 0,
        baseCostCents: 0,
        serviceFeeCents: 0,
        totalCostCents: 0,
        model: GENERATION_MODELS.anthropic.modelId,
        provider: "anthropic",
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        createdAt: now,
      });
    });

    const chat = reservationArgs(fixture, "pro-prepaid-chat", 1, {
      inputTokenLimit: 40,
      outputTokenLimit: 20,
    });
    await expect(reserve(t, chat)).resolves.toEqual({
      allowed: true,
      reservationKey: chat.reservationKey,
    });
    // A pending embedding hold from before embeddings were retired no
    // longer counts, so a chat reservation fills the remaining balance.
    await insertLegacyEmbeddingReservation(t, fixture, {
      reservationKey: "pro-prepaid-embedding-exact",
      status: "pending",
      reservedTokens: 40,
    });
    const fill = reservationArgs(fixture, "pro-prepaid-chat-fill", 1, {
      inputTokenLimit: 20,
      outputTokenLimit: 20,
    });
    await expect(reserve(t, fill)).resolves.toMatchObject({ allowed: true });

    await expect(
      reserve(
        t,
        reservationArgs(fixture, "pro-prepaid-chat-over", 1, {
          inputTokenLimit: 1,
          outputTokenLimit: 1,
        }),
      ),
    ).resolves.toEqual({ allowed: false, reason: "limit_reached" });

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      reservations: await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_user_and_status", (q) =>
          q.eq("userId", fixture.userId).eq("status", "pending"),
        )
        .collect(),
      embeddingReservations: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_user_and_status", (q) =>
          q.eq("userId", fixture.userId).eq("status", "pending"),
        )
        .collect(),
    }));
    expect(state.subscription?.purchasedTokens).toBe(100);
    expect(state.reservations).toEqual([
      expect.objectContaining({ reservedTokens: 60 }),
      expect.objectContaining({ reservedTokens: 40 }),
    ]);
    expect(state.embeddingReservations).toEqual([
      expect.objectContaining({ reservedTokens: 40 }),
    ]);
  });

  it("settles an ended Pro wallet exactly once across concurrent first-Free reservations", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const ended = await insertEndedProPeriod(t, fixture, {
      purchasedTokens: 100,
      overageTokens: 40,
    });
    const results = await Promise.all([
      reserve(t, reservationArgs(fixture, "first-free-a")),
      reserve(t, reservationArgs(fixture, "first-free-b")),
    ]);
    expect(results).toEqual([
      { allowed: true, reservationKey: "first-free-a" },
      { allowed: true, reservationKey: "first-free-b" },
    ]);
    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(ended.subscriptionId),
      boundary: await ctx.db.get(ended.boundaryId),
    }));
    expect(state.subscription?.purchasedTokens).toBe(60);
    expect(state.boundary).toMatchObject({
      status: "settled",
      settlementReason: "terminal_entitlement",
      purchasedTokensDebited: 40,
    });
  });

  it.each(["known_not_billed", "known_billed"] as const)(
    "resumes terminal settlement after %s provider reconciliation",
    async (reconciliationOutcome) => {
      const t = convexTest(schema, modules);
      const fixture = await insertFixture(t);
      const adminUserId = await insertAdminUser(t);
      const admin = t.withIdentity({ subject: `${adminUserId}|admin-session` });
      const ended = await insertEndedProPeriod(t, fixture, {
        purchasedTokens: 100,
        overageTokens: 40,
      });
      const now = Date.now();
      const reservationKey = `terminal-provider-hold-${reconciliationOutcome}`;
      const reservationId = await t.run(async (ctx) =>
        ctx.db.insert("chatUsageReservations", {
          reservationKey,
          attemptToken: `${reservationKey}:attempt:1`,
          userId: fixture.userId,
          repositoryId: fixture.repositoryId,
          ticketActionId: fixture.ticketActionId,
          requirePendingTicketAction: true,
          ticketActionProposalVersion: 0,
          generationKey: reservationKey,
          operation: "terminal-test",
          model: GENERATION_MODELS.anthropic.modelId,
          provider: "anthropic",
          requestFingerprint: "3".repeat(64),
          inputTokenLimit: 100,
          outputTokenLimit: 100,
          reservedTokens: 200,
          subscriptionId: ended.subscriptionId,
          entitlementPlan: "pro",
          includedTokens: PRICING.PRO_INCLUDED_TOKENS,
          serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
          quotaPeriodStart: ended.periodStart,
          quotaPeriodEnd: ended.periodEnd,
          status: "pending",
          providerStartedAt: ended.periodEnd - 10,
          expiresAt: now + 60_000,
          createdAt: ended.periodEnd - 20,
          updatedAt: now,
        }),
      );
      await expect(
        t.run(async (ctx) => {
          const subscription = await ctx.db.get(ended.subscriptionId);
          if (!subscription) throw new Error("subscription missing");
          return await settleEndedTrustedProSubscriptionQuota(
            ctx,
            subscription,
            Date.now(),
          );
        }),
      ).resolves.toEqual({ status: "in_progress" });
      await t.run(async (ctx) =>
        ctx.db.patch(reservationId, { expiresAt: Date.now() - 1 }),
      );
      await expect(
        t.run(async (ctx) => {
          const subscription = await ctx.db.get(ended.subscriptionId);
          if (!subscription) throw new Error("subscription missing");
          return await settleEndedTrustedProSubscriptionQuota(
            ctx,
            subscription,
            Date.now(),
          );
        }),
      ).resolves.toEqual({ status: "in_progress" });
      const paused = await t.run(async (ctx) => ({
        reservation: await ctx.db.get(reservationId),
        boundary: await ctx.db.get(ended.boundaryId),
        subscription: await ctx.db.get(ended.subscriptionId),
      }));
      expect(paused.reservation).toMatchObject({ status: "ambiguous" });
      expect(paused.boundary).toMatchObject({ status: "pending" });
      expect(paused.subscription).toMatchObject({ purchasedTokens: 100 });
      expect(
        paused.subscription?.billingBoundaryReconciliationRequired,
      ).toBeUndefined();
      expect(
        paused.subscription?.billingBoundaryManualReviewReason,
      ).toBeUndefined();

      await admin.mutation(api.admin.paymentMutation.reconcileChatUsage, {
        reservationKey,
        evidenceSource: "anthropic_usage_report",
        evidenceReference: `terminal-${reconciliationOutcome}`,
        outcome:
          reconciliationOutcome === "known_not_billed"
            ? { kind: "known_not_billed" as const }
            : {
                kind: "known_billed" as const,
                actualInputTokens: 10,
                actualOutputTokens: 5,
                providerRequestId: "terminal-provider-request",
              },
      });
      await expect(
        t.run(async (ctx) => {
          const subscription = await ctx.db.get(ended.subscriptionId);
          if (!subscription) throw new Error("subscription missing");
          return await settleEndedTrustedProSubscriptionQuota(
            ctx,
            subscription,
            Date.now(),
          );
        }),
      ).resolves.toEqual({ status: "settled", boundariesSettled: 1 });

      const settled = await t.run(async (ctx) => ({
        reservation: await ctx.db.get(reservationId),
        boundary: await ctx.db.get(ended.boundaryId),
        subscription: await ctx.db.get(ended.subscriptionId),
      }));
      const reconciledTokens =
        reconciliationOutcome === "known_billed" ? 15 : 0;
      expect(settled.subscription?.purchasedTokens).toBe(60 - reconciledTokens);
      expect(settled.boundary).toMatchObject({
        status: "settled",
        purchasedTokensDebited: 40 + reconciledTokens,
      });
      expect(settled.reservation?.status).toBe(
        reconciliationOutcome === "known_billed" ? "finalized" : "released",
      );
    },
  );

  it("does not partially debit an underfunded terminal Pro wallet", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const ended = await insertEndedProPeriod(t, fixture, {
      purchasedTokens: 20,
      overageTokens: 40,
    });
    await expect(
      t.run(async (ctx) => {
        const subscription = await ctx.db.get(ended.subscriptionId);
        if (!subscription) throw new Error("subscription missing");
        return await settleEndedTrustedProSubscriptionQuota(
          ctx,
          subscription,
          Date.now(),
        );
      }),
    ).resolves.toMatchObject({ status: "manual_review" });
    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(ended.subscriptionId),
      boundary: await ctx.db.get(ended.boundaryId),
    }));
    expect(state.subscription).toMatchObject({
      purchasedTokens: 20,
      billingBoundaryReconciliationRequired: true,
    });
    expect(state.boundary).toMatchObject({
      status: "manual_review",
    });
    expect(state.boundary?.purchasedTokensDebited).toBeUndefined();
  });

  it("does not let a production hostname containing localhost bypass chat quota", async () => {
    process.env.SITE_URL = "https://notlocalhost.example";
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const attempts = [
      reservationArgs(fixture, "concurrent-a", 1, {
        inputTokenLimit: 30_000,
        outputTokenLimit: 30_000,
      }),
      reservationArgs(fixture, "concurrent-b", 1, {
        inputTokenLimit: 30_000,
        outputTokenLimit: 30_000,
      }),
    ];
    const results = await Promise.all(attempts.map((args) => reserve(t, args)));
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toEqual([
      { allowed: false, reason: "limit_reached" },
    ]);
  });

  it("finalizes one usage row idempotently and rejects payload changes", async () => {
    const t = convexTest(schema, modules);
    const args = reservationArgs(await insertFixture(t), "finalize-once");
    await expect(reserve(t, args)).resolves.toMatchObject({ allowed: true });
    await expect(markStarted(t, args)).resolves.toBe(true);
    const usageId = await finalize(t, args);
    await expect(finalize(t, args)).resolves.toBe(usageId);
    await expect(finalize(t, args, 101, 20)).rejects.toThrow(
      "AI usage reservation identity mismatch",
    );

    const state = await t.run(async (ctx) => ({
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_chat_reservation", (q) =>
          q.eq("chatReservationKey", args.reservationKey),
        )
        .take(2),
      reservation: await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", args.reservationKey),
        )
        .unique(),
    }));
    expect(state.usage).toHaveLength(1);
    expect(state.reservation).toMatchObject({
      status: "finalized",
      usageId,
      providerRequestId: "request-1",
    });
    expect(state.usage[0]?.createdAt).toBe(
      state.reservation?.providerStartedAt,
    );
  });

  it("fails closed when actual usage exceeds its reservation", async () => {
    const t = convexTest(schema, modules);
    const args = reservationArgs(
      await insertFixture(t),
      "over-reservation",
      1,
      {
        inputTokenLimit: 10,
        outputTokenLimit: 10,
      },
    );
    await reserve(t, args);
    await markStarted(t, args);
    await expect(finalize(t, args, 11, 10)).rejects.toThrow(
      "AI usage reservation is not finalizable",
    );
    await expect(
      t.mutation(internal._ai.chatBilling.markChatUsageAmbiguous, {
        reservationKey: args.reservationKey,
        attemptToken: args.attemptToken,
        userId: args.userId,
        repositoryId: args.repositoryId,
        ticketActionId: args.ticketActionId,
      }),
    ).resolves.toBe(true);
    await expect(
      reserve(t, reservationArgs(args, "blocked-after-ambiguity")),
    ).resolves.toEqual({
      allowed: false,
      reason: "unresolved_provider_usage",
    });
  });

  it("stops blocking once an unresolved attempt is 30 minutes old", async () => {
    const t = convexTest(schema, modules);
    const args = reservationArgs(await insertFixture(t), "abandoned", 1);
    await reserve(t, args);
    await markStarted(t, args);
    await t.mutation(internal._ai.chatBilling.markChatUsageAmbiguous, {
      reservationKey: args.reservationKey,
      attemptToken: args.attemptToken,
      userId: args.userId,
      repositoryId: args.repositoryId,
      ticketActionId: args.ticketActionId,
    });
    await expect(
      reserve(t, reservationArgs(args, "still-blocked")),
    ).resolves.toMatchObject({ reason: "unresolved_provider_usage" });
    // By then the attempt cannot still be running.
    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", args.reservationKey),
        )
        .unique();
      await ctx.db.patch(reservation!._id, {
        providerStartedAt: Date.now() - 31 * 60_000,
      });
    });
    await expect(
      reserve(t, reservationArgs(args, "after-the-window")),
    ).resolves.toMatchObject({ allowed: true });
    // The attempt is kept for admin reconciliation.
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("chatUsageReservations")
          .withIndex("by_reservation_key", (q) =>
            q.eq("reservationKey", args.reservationKey),
          )
          .unique(),
      ),
    ).toMatchObject({ status: "ambiguous" });
  });

  it("fails closed when a corrupt reservation total is below actual usage", async () => {
    const t = convexTest(schema, modules);
    const args = reservationArgs(
      await insertFixture(t),
      "corrupt-reservation-total",
      1,
      {
        inputTokenLimit: 10,
        outputTokenLimit: 10,
      },
    );
    await expect(reserve(t, args)).resolves.toMatchObject({ allowed: true });
    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", args.reservationKey),
        )
        .unique();
      if (!reservation) throw new Error("chat reservation missing");
      await ctx.db.patch(reservation._id, { reservedTokens: 14 });
    });
    await expect(markStarted(t, args)).resolves.toBe(true);
    await expect(finalize(t, args, 10, 5)).rejects.toThrow(
      "AI usage reservation is not finalizable",
    );
    await expect(
      t.mutation(internal._ai.chatBilling.markChatUsageAmbiguous, {
        reservationKey: args.reservationKey,
        attemptToken: args.attemptToken,
        userId: args.userId,
        repositoryId: args.repositoryId,
        ticketActionId: args.ticketActionId,
      }),
    ).resolves.toBe(true);

    const state = await t.run(async (ctx) => ({
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_chat_reservation", (q) =>
          q.eq("chatReservationKey", args.reservationKey),
        )
        .first(),
      reservation: await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", args.reservationKey),
        )
        .unique(),
    }));
    expect(state.usage).toBeNull();
    expect(state.reservation).toMatchObject({
      status: "ambiguous",
      reservedTokens: 14,
    });
  });

  it("releases before provider start or after an explicit provider rejection", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const first = reservationArgs(fixture, "safe-reopen");
    await reserve(t, first);
    await expect(
      t.mutation(internal._ai.chatBilling.releaseChatUsage, {
        reservationKey: first.reservationKey,
        attemptToken: first.attemptToken,
        userId: first.userId,
        repositoryId: first.repositoryId,
        ticketActionId: first.ticketActionId,
        confirmedNotBilled: false,
      }),
    ).resolves.toBe(true);
    const second = reservationArgs(fixture, "safe-reopen", 2);
    await expect(reserve(t, second)).resolves.toMatchObject({ allowed: true });
    await expect(markStarted(t, second)).resolves.toBe(true);
    await expect(
      t.mutation(internal._ai.chatBilling.releaseChatUsage, {
        reservationKey: second.reservationKey,
        attemptToken: second.attemptToken,
        userId: second.userId,
        repositoryId: second.repositoryId,
        ticketActionId: second.ticketActionId,
        confirmedNotBilled: false,
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal._ai.chatBilling.releaseChatUsage, {
        reservationKey: second.reservationKey,
        attemptToken: second.attemptToken,
        userId: second.userId,
        repositoryId: second.repositoryId,
        ticketActionId: second.ticketActionId,
        confirmedNotBilled: true,
      }),
    ).resolves.toBe(true);
    const third = reservationArgs(fixture, "safe-reopen", 3);
    await expect(reserve(t, third)).resolves.toMatchObject({ allowed: true });
  });

  it("releases a metered reservation when AI explicitly rejects the request", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const generationKey = "wrapper-http-rejection";
    const billingLabel = "answer";
    const ctx = {
      runMutation: t.mutation.bind(t),
    } as unknown as ActionCtx;
    const provider = createMeteredProvider(ctx, {
      ...fixture,
      generationKey,
      operation: "wrapper-test",
      provider: failingProvider(
        new ChatProviderRequestError("rate limited", "not_billed", {
          httpStatus: 429,
          providerRequestId: "request-rejected",
        }),
      ),
    });

    await expect(
      provider.chat([{ role: "user", content: "Question" }], {
        maxTokens: 16,
        billingLabel,
      }),
    ).rejects.toMatchObject({
      name: "ChatProviderRequestError",
      billingOutcome: "not_billed",
      httpStatus: 429,
      providerRequestId: "request-rejected",
    });

    const reservationKey = `chat:v1:${generationKey}:${billingLabel}`;
    const reservation = await t.run(async (databaseCtx) =>
      databaseCtx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    );
    expect(reservation).toMatchObject({
      status: "released",
      releaseReason: "request_finished_without_provider_usage",
      providerRequestId: "request-rejected",
    });
    expect(reservation?.providerStartedAt).toEqual(expect.any(Number));

    await expect(
      reserve(t, reservationArgs(fixture, "after-http-rejection")),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("stages exact usage idempotently across a lost response and transient settlement failure", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const invokeMutation = getUntypedMutationRunner(t);
    let stageCalls = 0;
    let settlementCalls = 0;
    const ctx = {
      runMutation: async (
        reference: AnyFunctionReference,
        mutationArgs: Record<string, unknown>,
      ) => {
        const name = getFunctionName(reference);
        if (
          name === "_ai/chatBilling:stageChatProviderOutcome" &&
          stageCalls++ === 0
        ) {
          await invokeMutation(reference, mutationArgs);
          throw new Error("stage response was lost");
        }
        if (
          name === "_ai/chatBilling:settleStagedChatOutcome" &&
          settlementCalls++ === 0
        ) {
          throw new Error("transient settlement failure");
        }
        return await invokeMutation(reference, mutationArgs);
      },
    } as unknown as ActionCtx;
    const provider = createMeteredProvider(ctx, {
      ...fixture,
      generationKey: "durable-exact-response",
      operation: "durable-settlement-test",
      provider: exactUsageProvider(),
    });

    await expect(
      provider.chat([{ role: "user", content: "Question" }], {
        billingLabel: "answer",
        maxTokens: 20,
      }),
    ).resolves.toMatchObject({ content: "Answer" });

    const state = await t.run(async (databaseCtx) => ({
      reservation: await databaseCtx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", "chat:v1:durable-exact-response:answer"),
        )
        .unique(),
      usages: await databaseCtx.db
        .query("tokenUsage")
        .withIndex("by_user", (q) => q.eq("userId", fixture.userId))
        .collect(),
    }));
    expect(stageCalls).toBeGreaterThanOrEqual(2);
    expect(settlementCalls).toBeGreaterThanOrEqual(2);
    expect(state.reservation).toMatchObject({
      status: "finalized",
      providerRequestId: "provider-request-exact",
    });
    expect(state.reservation?.settlementState).toBeUndefined();
    expect(state.usages).toHaveLength(1);
    expect(state.usages[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      providerRequestId: "provider-request-exact",
    });
  });

  it("replays a checkpointed result after settlement without calling AI twice", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const rawProvider = exactUsageProvider();
    const createProvider = () =>
      createMeteredProvider(
        { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
        {
          ...fixture,
          generationKey: "checkpoint-replay",
          operation: "replay-test",
          provider: rawProvider,
          recoveryTarget: {
            kind: "regenerate",
            expectedAiInputVersion: 1,
            expectedIndexVersion: 1,
          },
        },
      );
    const messages = [{ role: "user" as const, content: "Question" }];
    const options = { billingLabel: "answer", maxTokens: 20 };

    await expect(
      createProvider().chat(messages, options),
    ).resolves.toMatchObject({
      content: "Answer",
      providerRequestId: "provider-request-exact",
    });
    // Simulate the action disappearing after provider settlement but before
    // its caller publishes the still-pending ticket action.
    await expect(
      createProvider().chat(messages, options),
    ).resolves.toMatchObject({
      content: "Answer",
      providerRequestId: "provider-request-exact",
    });

    expect(rawProvider.chat).toHaveBeenCalledOnce();
    const state = await t.run(async (ctx) => ({
      reservation: await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", "chat:v1:checkpoint-replay:answer"),
        )
        .unique(),
      action: await ctx.db.get(fixture.ticketActionId),
    }));
    expect(state.reservation).toMatchObject({
      status: "finalized",
      resultCheckpointJson: expect.any(String),
      recoveryTarget: {
        kind: "regenerate",
        expectedAiInputVersion: 1,
        expectedIndexVersion: 1,
      },
    });
    expect(state.action).toMatchObject({
      status: "pending",
      resultCheckpointKey: "chat:v1:checkpoint-replay:answer",
      resultRecoveryScheduleId: expect.any(String),
    });
  });

  it("does not replay settled source review output under a different schema", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const rawProvider = exactUsageProvider();
    const provider = createMeteredProvider(
      { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey: "schema-replay",
        operation: "schema-replay-test",
        provider: rawProvider,
      },
    );
    const messages = [{ role: "user" as const, content: "Review the source" }];
    const options = {
      billingLabel: "review",
      maxTokens: 20,
      responseFormat: { name: "review_v1", schema: { type: "object" } },
    };
    await provider.chat(messages, options);
    await expect(
      provider.chat(messages, {
        ...options,
        responseFormat: { ...options.responseFormat, name: "review_v2" },
      }),
    ).rejects.toThrow("identity mismatch");
    expect(rawProvider.chat).toHaveBeenCalledTimes(1);
  });

  it("never replays a checkpoint for a different same-sized request", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const rawProvider = exactUsageProvider();
    const createProvider = () =>
      createMeteredProvider(
        { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
        {
          ...fixture,
          generationKey: "checkpoint-fingerprint",
          operation: "fingerprint-test",
          provider: rawProvider,
        },
      );
    const options = { billingLabel: "answer", maxTokens: 20 };
    await createProvider().chat(
      [{ role: "user", content: "Question A" }],
      options,
    );

    await expect(
      createProvider().chat([{ role: "user", content: "Question B" }], options),
    ).rejects.toThrow("AI chat reservation identity mismatch");
    expect(rawProvider.chat).toHaveBeenCalledOnce();
  });

  it("rejects a malformed durable result instead of publishing it", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const rawProvider = exactUsageProvider();
    const createProvider = () =>
      createMeteredProvider(
        { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
        {
          ...fixture,
          generationKey: "malformed-checkpoint",
          operation: "malformed-checkpoint-test",
          provider: rawProvider,
        },
      );
    const messages = [{ role: "user" as const, content: "Question" }];
    const options = { billingLabel: "answer", maxTokens: 20 };
    await createProvider().chat(messages, options);
    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", "chat:v1:malformed-checkpoint:answer"),
        )
        .unique();
      if (!reservation) throw new Error("chat reservation missing");
      await ctx.db.patch(reservation._id, {
        resultCheckpointJson: JSON.stringify({
          content: "unsafe",
          finishReason: "tool_use",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          provider: "anthropic",
          providerRequestId: "provider-request-exact",
          historyContent: [
            { type: "tool_use", id: 42, name: "read_file", input: {} },
          ],
        }),
      });
    });

    await expect(createProvider().chat(messages, options)).rejects.toThrow(
      "AI chat result checkpoint is invalid",
    );
    expect(rawProvider.chat).toHaveBeenCalledOnce();
  });

  it("does not replay or resume a checkpoint from an older proposal", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const rawProvider = exactUsageProvider();
    const createProvider = () =>
      createMeteredProvider(
        { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
        {
          ...fixture,
          generationKey: "stale-proposal-checkpoint",
          operation: "stale-proposal-test",
          provider: rawProvider,
          recoveryTarget: {
            kind: "regenerate",
            expectedAiInputVersion: 1,
            expectedIndexVersion: 1,
          },
        },
      );
    const messages = [{ role: "user" as const, content: "Question" }];
    const options = { billingLabel: "answer", maxTokens: 20 };
    await createProvider().chat(messages, options);
    const reservationKey = "chat:v1:stale-proposal-checkpoint:answer";
    await t.run(async (ctx) => {
      const action = await ctx.db.get(fixture.ticketActionId);
      if (!action) throw new Error("ticket action missing");
      await ctx.db.patch(action._id, {
        proposalVersion: action.proposalVersion + 1,
        resultCheckpointKey: undefined,
        resultCheckpointExpiresAt: undefined,
        resultRecoveryLeaseUntil: undefined,
        resultRecoveryScheduleId: undefined,
      });
    });

    await expect(
      createProvider().chat(messages, options),
    ).rejects.toMatchObject({
      name: "ChatBillingError",
      reason: "reservation_closed",
    });
    await expect(
      t.mutation(internal._ai.chatBilling.resumeCheckpointedChatAction, {
        ticketActionId: fixture.ticketActionId,
        reservationKey,
      }),
    ).resolves.toEqual({ scheduled: false });
    expect(rawProvider.chat).toHaveBeenCalledOnce();
  });

  it("requeues an initial answer that vanished before provider checkpointing", async () => {
    const now = Date.now();
    vi.useFakeTimers({ now });
    try {
      const t = convexTest(schema, modules);
      const fixture = await insertFixture(t);
      await t.run(async (ctx) => {
        await ctx.db.patch(fixture.ticketActionId, {
          pendingGenerationTarget: {
            kind: "initial_ticket",
            stage: "answer",
            expectedAiInputVersion: 1,
            expectedIndexVersion: 1,
          },
          pendingGenerationExpiresAt: now + PENDING_GENERATION_TTL_MS,
        });
      });

      const result = await t.mutation(
        internal._ai.chatBilling.resumePendingChatGeneration,
        { ticketActionId: fixture.ticketActionId },
      );
      expect(result).toMatchObject({
        scheduled: true,
        workScheduleId: expect.any(String),
      });

      const state = await t.run(async (ctx) => ({
        action: await ctx.db.get(fixture.ticketActionId),
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      }));
      expect(state.action).toMatchObject({
        status: "pending",
        pendingGenerationTarget: {
          kind: "initial_ticket",
          stage: "answer",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
        pendingGenerationScheduleId: expect.any(String),
      });
      expect(state.scheduled.map((job) => job.name).sort()).toEqual([
        "_ai/chatBilling:resumePendingChatGeneration",
        "tickets/internalAction:processNewTicket",
      ]);
      const work = state.scheduled.find(
        (job) => job.name === "tickets/internalAction:processNewTicket",
      );
      expect(work?.args).toEqual([
        {
          ticketId: state.action?.ticketId,
          repositoryId: fixture.repositoryId,
          issueTitle: "Issue",
          issueBody: "",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
          processingStage: "answer",
          answerActionId: fixture.ticketActionId,
        },
      ]);
      await cancelPendingSchedules(t);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps one watchdog alive without duplicating work during an active generation lease", async () => {
    const now = Date.now();
    vi.useFakeTimers({ now });
    try {
      const t = convexTest(schema, modules);
      const fixture = await insertFixture(t);
      const providerRetryStartedAt = now - 1_000;
      await t.run(async (ctx) => {
        await ctx.db.patch(fixture.ticketActionId, {
          pendingGenerationTarget: {
            kind: "initial_ticket",
            stage: "answer",
            expectedAiInputVersion: 1,
            expectedIndexVersion: 1,
          },
          pendingGenerationExpiresAt: now + PENDING_GENERATION_TTL_MS,
          pendingGenerationLeaseUntil: now + PENDING_GENERATION_LEASE_MS,
          providerRetryStartedAt: providerRetryStartedAt,
        });
      });

      await expect(
        t.mutation(internal._ai.chatBilling.resumePendingChatGeneration, {
          ticketActionId: fixture.ticketActionId,
        }),
      ).resolves.toEqual({ scheduled: false });

      const state = await t.run(async (ctx) => ({
        action: await ctx.db.get(fixture.ticketActionId),
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      }));
      expect(state.action).toMatchObject({
        status: "pending",
        pendingGenerationLeaseUntil: now + PENDING_GENERATION_LEASE_MS,
        providerRetryStartedAt: providerRetryStartedAt,
        pendingGenerationScheduleId: expect.any(String),
      });
      expect(state.scheduled.map((job) => job.name)).toEqual([
        "_ai/chatBilling:resumePendingChatGeneration",
      ]);
      await cancelPendingSchedules(t);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("retires a pending answer and atomically schedules the current index epoch", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.ticketActionId, {
        pendingGenerationTarget: {
          kind: "initial_ticket",
          stage: "answer",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
        pendingGenerationExpiresAt: Date.now() + PENDING_GENERATION_TTL_MS,
      });
      await ctx.db.patch(fixture.repositoryId, { indexVersion: 2 });
    });

    await expect(
      t.mutation(internal._ai.chatBilling.resumePendingChatGeneration, {
        ticketActionId: fixture.ticketActionId,
      }),
    ).resolves.toEqual({ scheduled: false });

    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.ticketActionId),
      actions: await ctx.db.query("ticketActions").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.action).toMatchObject({
      status: "failed",
      errorMessage: "Repository index changed before AI generation completed",
      completedAt: expect.any(Number),
    });
    expect(state.action?.pendingGenerationTarget).toBeUndefined();
    const replacement = state.actions.find(
      (action) => action._id !== fixture.ticketActionId,
    );
    expect(replacement).toMatchObject({
      actionType: "answer",
      status: "pending",
      pendingGenerationTarget: {
        kind: "initial_ticket",
        stage: "answer",
        expectedAiInputVersion: 1,
        expectedIndexVersion: 2,
      },
    });
    const pending = state.scheduled.filter(
      (job) => job.state.kind === "pending",
    );
    expect(pending.map((job) => job.name).sort()).toEqual([
      "_ai/chatBilling:resumePendingChatGeneration",
      "tickets/internalAction:processNewTicket",
    ]);
    expect(
      pending.find(
        (job) => job.name === "tickets/internalAction:processNewTicket",
      )?.args,
    ).toEqual([
      {
        ticketId: state.action?.ticketId,
        repositoryId: fixture.repositoryId,
        issueTitle: "Issue",
        issueBody: "",
        expectedAiInputVersion: 1,
        expectedIndexVersion: 2,
        processingStage: "answer",
        answerActionId: replacement?._id,
      },
    ]);
    expect(
      pending.find(
        (job) => job.name === "_ai/chatBilling:resumePendingChatGeneration",
      )?.args,
    ).toEqual([{ ticketActionId: replacement?._id }]);
    await cancelPendingSchedules(t);
  });

  it("retires a checkpointed answer and schedules a fresh generation after reindexing", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const reservationKey = "chat:v1:stale-index-checkpoint:answer";
    const provider = createMeteredProvider(
      { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey: "stale-index-checkpoint",
        operation: "stale-index-checkpoint-test",
        provider: exactUsageProvider(),
        recoveryTarget: {
          kind: "initial_ticket",
          stage: "answer",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
      },
    );
    await provider.chat([{ role: "user", content: "Question" }], {
      billingLabel: "answer",
      maxTokens: 20,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, { indexVersion: 2 });
    });

    await expect(
      t.mutation(internal._ai.chatBilling.resumeCheckpointedChatAction, {
        ticketActionId: fixture.ticketActionId,
        reservationKey,
      }),
    ).resolves.toEqual({ scheduled: false });

    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.ticketActionId),
      actions: await ctx.db.query("ticketActions").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.action).toMatchObject({
      status: "failed",
      errorMessage:
        "Repository index changed after the AI result was generated",
      completedAt: expect.any(Number),
    });
    expect(state.action?.resultCheckpointKey).toBeUndefined();
    const replacement = state.actions.find(
      (action) => action._id !== fixture.ticketActionId,
    );
    expect(replacement).toMatchObject({
      actionType: "answer",
      status: "pending",
      pendingGenerationTarget: {
        kind: "initial_ticket",
        stage: "answer",
        expectedAiInputVersion: 1,
        expectedIndexVersion: 2,
      },
    });
    const pending = state.scheduled.filter(
      (job) => job.state.kind === "pending",
    );
    expect(pending.map((job) => job.name).sort()).toEqual([
      "_ai/chatBilling:resumePendingChatGeneration",
      "tickets/internalAction:processNewTicket",
    ]);
    expect(
      pending.find(
        (job) => job.name === "tickets/internalAction:processNewTicket",
      )?.args,
    ).toEqual([
      {
        ticketId: state.action?.ticketId,
        repositoryId: fixture.repositoryId,
        issueTitle: "Issue",
        issueBody: "",
        expectedAiInputVersion: 1,
        expectedIndexVersion: 2,
        processingStage: "answer",
        answerActionId: replacement?._id,
      },
    ]);
    expect(
      pending.find(
        (job) => job.name === "_ai/chatBilling:resumePendingChatGeneration",
      )?.args,
    ).toEqual([{ ticketActionId: replacement?._id }]);
    await cancelPendingSchedules(t);
  });

  it("preserves the initial formatting stage when replacing stale ticket input", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await t.run(async (ctx) => {
      const action = await ctx.db.get(fixture.ticketActionId);
      if (!action) throw new Error("ticket action missing");
      await ctx.db.patch(action._id, {
        actionType: "format",
        pendingGenerationTarget: {
          kind: "initial_ticket",
          stage: "start",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
        pendingGenerationExpiresAt: Date.now() + PENDING_GENERATION_TTL_MS,
      });
      await ctx.db.patch(action.ticketId, {
        githubTitle: "Edited issue",
        aiInputVersion: 2,
      });
    });

    await expect(
      t.mutation(internal._ai.chatBilling.resumePendingChatGeneration, {
        ticketActionId: fixture.ticketActionId,
      }),
    ).resolves.toEqual({ scheduled: false });

    const state = await t.run(async (ctx) => ({
      action: await ctx.db.get(fixture.ticketActionId),
      actions: await ctx.db.query("ticketActions").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.action).toMatchObject({
      status: "failed",
      errorMessage: "Ticket content changed before AI generation completed",
    });
    const replacement = state.actions.find(
      (action) => action._id !== fixture.ticketActionId,
    );
    expect(replacement).toMatchObject({
      actionType: "format",
      status: "pending",
      pendingGenerationTarget: {
        kind: "initial_ticket",
        stage: "start",
        expectedAiInputVersion: 2,
        expectedIndexVersion: 1,
      },
    });
    const pending = state.scheduled.filter(
      (job) => job.state.kind === "pending",
    );
    expect(pending.map((job) => job.name).sort()).toEqual([
      "_ai/chatBilling:resumePendingChatGeneration",
      "tickets/internalAction:processNewTicket",
    ]);
    expect(
      pending.find(
        (job) => job.name === "tickets/internalAction:processNewTicket",
      )?.args,
    ).toEqual([
      {
        ticketId: state.action?.ticketId,
        repositoryId: fixture.repositoryId,
        issueTitle: "Edited issue",
        issueBody: "",
        expectedAiInputVersion: 2,
        expectedIndexVersion: 1,
        processingStage: "start",
        formatActionId: replacement?._id,
      },
    ]);
    expect(
      pending.find(
        (job) => job.name === "_ai/chatBilling:resumePendingChatGeneration",
      )?.args,
    ).toEqual([{ ticketActionId: replacement?._id }]);
    await cancelPendingSchedules(t);
  });

  it("preserves feedback and proposal context in a fresh regeneration action", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const chatHistory = [
      { role: "assistant" as const, content: "Previous answer", timestamp: 1 },
      {
        role: "user" as const,
        content: "Request changes: Add evidence",
        timestamp: 2,
      },
    ];
    const proposedChanges = {
      originalTitle: "Issue",
      originalBody: "",
      suggestedResponse: "Previous answer",
      groundedIndexVersion: 1,
    };
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.ticketActionId, {
        requestedByUserId: fixture.userId,
        chatHistory,
        proposedChanges,
        proposalVersion: 3,
        userFeedback: "Add evidence",
        pendingGenerationTarget: {
          kind: "regenerate",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
        pendingGenerationExpiresAt: Date.now() + PENDING_GENERATION_TTL_MS,
      });
      await ctx.db.patch(fixture.repositoryId, { indexVersion: 2 });
    });

    await expect(
      t.mutation(internal._ai.chatBilling.resumePendingChatGeneration, {
        ticketActionId: fixture.ticketActionId,
      }),
    ).resolves.toEqual({ scheduled: false });

    const state = await t.run(async (ctx) => {
      const original = await ctx.db.get(fixture.ticketActionId);
      if (!original) throw new Error("original action missing");
      return {
        actions: await ctx.db
          .query("ticketActions")
          .withIndex("by_ticket", (q) => q.eq("ticketId", original.ticketId))
          .collect(),
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      };
    });
    const original = state.actions.find(
      (action) => action._id === fixture.ticketActionId,
    );
    const replacement = state.actions.find(
      (action) => action._id !== fixture.ticketActionId,
    );
    expect(original).toMatchObject({
      status: "failed",
      errorMessage: "Repository index changed before AI generation completed",
    });
    expect(replacement).toMatchObject({
      actionType: "answer",
      status: "pending",
      requestedByUserId: fixture.userId,
      chatHistory,
      proposedChanges,
      proposalVersion: 0,
      userFeedback: "Add evidence",
      pendingGenerationTarget: {
        kind: "regenerate",
        expectedAiInputVersion: 1,
        expectedIndexVersion: 2,
      },
      pendingGenerationLeaseUntil: expect.any(Number),
      pendingGenerationScheduleId: expect.any(String),
    });
    expect(state.scheduled.map((job) => job.name).sort()).toEqual([
      "_ai/chatBilling:resumePendingChatGeneration",
      "ticketActions/internalAction:regenerateWithFeedback",
    ]);
    const work = state.scheduled.find(
      (job) =>
        job.name === "ticketActions/internalAction:regenerateWithFeedback",
    );
    expect(work?.args).toEqual([
      {
        actionId: replacement?._id,
        expectedIndexVersion: 2,
      },
    ]);
    await cancelPendingSchedules(t);
  });

  it("preserves follow-up conversation, requester, and approval intent in a fresh action", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const chatHistory = [
      {
        role: "user" as const,
        content: "[maintainer]: What about the new index?",
        timestamp: 1,
      },
      {
        role: "assistant" as const,
        content: "Previous follow-up answer",
        timestamp: 2,
      },
      {
        role: "user" as const,
        content: "Request changes: Be precise",
        timestamp: 3,
      },
    ];
    const proposedChanges = {
      commentId: 55,
      sourceCommentBody: "What about the new index?",
      sourceCommentRawBody: "@gitdogbot What about the new index?",
      author: "maintainer",
      suggestedResponse: "Previous follow-up answer",
      groundedIndexVersion: 1,
    };
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.ticketActionId, {
        sourceCommentId: 55,
        requestedByUserId: fixture.userId,
        actionType: "follow_up",
        chatHistory,
        proposedChanges,
        proposalVersion: 4,
        userFeedback: "Be precise",
        pendingGenerationTarget: {
          kind: "follow_up",
          forceApproval: true,
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
        pendingGenerationExpiresAt: Date.now() + PENDING_GENERATION_TTL_MS,
      });
      await ctx.db.patch(fixture.repositoryId, { indexVersion: 2 });
    });

    await expect(
      t.mutation(internal._ai.chatBilling.resumePendingChatGeneration, {
        ticketActionId: fixture.ticketActionId,
      }),
    ).resolves.toEqual({ scheduled: false });

    const state = await t.run(async (ctx) => {
      const original = await ctx.db.get(fixture.ticketActionId);
      if (!original) throw new Error("original action missing");
      return {
        actions: await ctx.db
          .query("ticketActions")
          .withIndex("by_ticket", (q) => q.eq("ticketId", original.ticketId))
          .collect(),
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      };
    });
    const original = state.actions.find(
      (action) => action._id === fixture.ticketActionId,
    );
    const replacement = state.actions.find(
      (action) => action._id !== fixture.ticketActionId,
    );
    expect(original).toMatchObject({
      status: "failed",
      errorMessage: "Repository index changed before AI generation completed",
    });
    expect(original?.sourceCommentId).toBeUndefined();
    expect(replacement).toMatchObject({
      sourceCommentId: 55,
      actionType: "follow_up",
      status: "pending",
      requestedByUserId: fixture.userId,
      chatHistory,
      proposedChanges,
      proposalVersion: 0,
      userFeedback: "Be precise",
      pendingGenerationTarget: {
        kind: "follow_up",
        forceApproval: true,
        expectedAiInputVersion: 1,
        expectedIndexVersion: 2,
      },
      pendingGenerationLeaseUntil: expect.any(Number),
      pendingGenerationScheduleId: expect.any(String),
    });
    expect(state.scheduled.map((job) => job.name).sort()).toEqual([
      "_ai/chatBilling:resumePendingChatGeneration",
      "ticketActions/internalAction:processFollowUp",
    ]);
    const work = state.scheduled.find(
      (job) => job.name === "ticketActions/internalAction:processFollowUp",
    );
    expect(work?.args).toEqual([
      {
        actionId: replacement?._id,
        expectedIndexVersion: 2,
        forceApproval: true,
      },
    ]);
    await cancelPendingSchedules(t);
  });

  it("fails a pre-provider recovery deterministically when its ticket closes", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await t.run(async (ctx) => {
      const action = await ctx.db.get(fixture.ticketActionId);
      if (!action) throw new Error("ticket action missing");
      await ctx.db.patch(action._id, {
        pendingGenerationTarget: {
          kind: "regenerate",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
        pendingGenerationExpiresAt: Date.now() + PENDING_GENERATION_TTL_MS,
      });
      await ctx.db.patch(action.ticketId, { status: "closed" });
    });

    await expect(
      t.mutation(internal._ai.chatBilling.resumePendingChatGeneration, {
        ticketActionId: fixture.ticketActionId,
      }),
    ).resolves.toEqual({ scheduled: false });
    const action = await t.run((ctx) => ctx.db.get(fixture.ticketActionId));
    expect(action).toMatchObject({
      status: "failed",
      errorMessage: "Ticket closed before AI generation completed",
      completedAt: expect.any(Number),
    });
    expect(action?.pendingGenerationTarget).toBeUndefined();
    expect(action?.pendingGenerationExpiresAt).toBeUndefined();
    expect(action?.pendingGenerationScheduleId).toBeUndefined();
  });

  it("terminates an expired checkpoint instead of orphaning its action", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const provider = createMeteredProvider(
      { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey: "expired-checkpoint",
        operation: "expired-checkpoint-test",
        provider: exactUsageProvider(),
        recoveryTarget: {
          kind: "regenerate",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
      },
    );
    await provider.chat([{ role: "user", content: "Question" }], {
      billingLabel: "answer",
      maxTokens: 20,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.ticketActionId, {
        resultCheckpointExpiresAt: Date.now() - 1,
      });
    });

    await expect(
      t.mutation(internal._ai.chatBilling.recoverCheckpointedChatActions, {}),
    ).resolves.toEqual({ scheduled: 0 });
    const action = await t.run((ctx) => ctx.db.get(fixture.ticketActionId));
    expect(action).toMatchObject({
      status: "failed",
      errorMessage: "AI result recovery expired before publication",
    });
    expect(action?.resultCheckpointKey).toBeUndefined();
  });

  it("terminates a checkpoint when its ticket closes", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const provider = createMeteredProvider(
      { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey: "closed-ticket-checkpoint",
        operation: "closed-ticket-test",
        provider: exactUsageProvider(),
        recoveryTarget: {
          kind: "regenerate",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
      },
    );
    await provider.chat([{ role: "user", content: "Question" }], {
      billingLabel: "answer",
      maxTokens: 20,
    });
    const reservationKey = "chat:v1:closed-ticket-checkpoint:answer";
    await t.run(async (ctx) => {
      const action = await ctx.db.get(fixture.ticketActionId);
      if (!action) throw new Error("ticket action missing");
      await ctx.db.patch(action.ticketId, { status: "closed" });
    });

    await t.mutation(internal._ai.chatBilling.resumeCheckpointedChatAction, {
      ticketActionId: fixture.ticketActionId,
      reservationKey,
    });
    const action = await t.run((ctx) => ctx.db.get(fixture.ticketActionId));
    expect(action).toMatchObject({
      status: "failed",
      errorMessage: "Ticket closed before AI result publication",
    });
    expect(action?.resultCheckpointKey).toBeUndefined();
  });

  it("retains a checkpoint across temporary repository access loss", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const provider = createMeteredProvider(
      { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey: "access-restore-checkpoint",
        operation: "access-restore-test",
        provider: exactUsageProvider(),
        recoveryTarget: {
          kind: "regenerate",
          expectedAiInputVersion: 1,
          expectedIndexVersion: 1,
        },
      },
    );
    await provider.chat([{ role: "user", content: "Question" }], {
      billingLabel: "answer",
      maxTokens: 20,
    });
    const reservationKey = "chat:v1:access-restore-checkpoint:answer";
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, {
        githubAccessRevokedAt: Date.now(),
      });
    });
    await expect(
      t.mutation(internal._ai.chatBilling.resumeCheckpointedChatAction, {
        ticketActionId: fixture.ticketActionId,
        reservationKey,
      }),
    ).resolves.toEqual({ scheduled: false });
    const paused = await t.run((ctx) => ctx.db.get(fixture.ticketActionId));
    expect(paused).toMatchObject({
      status: "pending",
      resultCheckpointKey: reservationKey,
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, {
        githubAccessRevokedAt: undefined,
      });
    });
    const resumed = await t.mutation(
      internal._ai.chatBilling.resumeCheckpointedChatAction,
      { ticketActionId: fixture.ticketActionId, reservationKey },
    );
    expect(resumed).toMatchObject({ scheduled: true });
    if (resumed.scheduled) {
      await t.run((ctx) => ctx.scheduler.cancel(resumed.scheduleId));
    }
  });

  it("recovers only after the tracked checkpoint job is no longer live", async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      const t = convexTest(schema, modules);
      const fixture = await insertFixture(t);
      const provider = createMeteredProvider(
        { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
        {
          ...fixture,
          generationKey: "checkpoint-recovery",
          operation: "recovery-test",
          provider: exactUsageProvider(),
          recoveryTarget: {
            kind: "regenerate",
            expectedAiInputVersion: 1,
            expectedIndexVersion: 1,
          },
        },
      );
      await provider.chat([{ role: "user", content: "Question" }], {
        billingLabel: "answer",
        maxTokens: 20,
      });
      const originalScheduleId = await t.run(async (ctx) => {
        const action = await ctx.db.get(fixture.ticketActionId);
        if (!action?.resultRecoveryScheduleId) {
          throw new Error("checkpoint recovery schedule is missing");
        }
        await ctx.db.patch(action._id, {
          resultRecoveryLeaseUntil: Date.now() - 1,
        });
        return action.resultRecoveryScheduleId;
      });

      await expect(
        t.mutation(internal._ai.chatBilling.recoverCheckpointedChatActions, {}),
      ).resolves.toEqual({ scheduled: 0 });

      await t.run(async (ctx) => {
        await ctx.scheduler.cancel(originalScheduleId);
        await ctx.db.patch(fixture.ticketActionId, {
          resultRecoveryLeaseUntil: Date.now() - 1,
        });
      });
      await expect(
        t.mutation(internal._ai.chatBilling.recoverCheckpointedChatActions, {}),
      ).resolves.toEqual({ scheduled: 1 });
      const recoveredAction = await t.run((ctx) =>
        ctx.db.get(fixture.ticketActionId),
      );
      expect(recoveredAction?.resultRecoveryScheduleId).not.toBe(
        originalScheduleId,
      );
      if (recoveredAction?.resultRecoveryScheduleId) {
        await t.run((ctx) =>
          ctx.scheduler.cancel(recoveredAction.resultRecoveryScheduleId!),
        );
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("recovers staged exact usage after synchronous settlement retries are exhausted", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const invokeMutation = getUntypedMutationRunner(t);
    const ctx = {
      runMutation: async (
        reference: AnyFunctionReference,
        mutationArgs: Record<string, unknown>,
      ) => {
        if (
          getFunctionName(reference) ===
          "_ai/chatBilling:settleStagedChatOutcome"
        ) {
          throw new Error("settlement service unavailable");
        }
        return await invokeMutation(reference, mutationArgs);
      },
    } as unknown as ActionCtx;
    const provider = createMeteredProvider(ctx, {
      ...fixture,
      generationKey: "settlement-retry-exhausted",
      operation: "durable-settlement-test",
      provider: exactUsageProvider(),
    });
    await expect(
      provider.chat([{ role: "user", content: "Question" }], {
        billingLabel: "answer",
        maxTokens: 20,
      }),
    ).resolves.toMatchObject({ content: "Answer" });

    const staged = await t.run(async (databaseCtx) =>
      databaseCtx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", "chat:v1:settlement-retry-exhausted:answer"),
        )
        .unique(),
    );
    expect(staged).toMatchObject({
      status: "pending",
      settlementState: "staged",
      settlementOutcome: {
        kind: "known_billed",
        inputTokens: 10,
        outputTokens: 5,
      },
    });

    if (!staged?.settlementScheduleId) {
      throw new Error("staged settlement schedule is missing");
    }
    await t.run(async (databaseCtx) => {
      await databaseCtx.scheduler.cancel(staged.settlementScheduleId!);
    });
    await t.mutation(internal._ai.chatBilling.settleStagedChatOutcome, {
      reservationKey: staged.reservationKey,
      attemptToken: staged.attemptToken,
      fromScheduler: true,
    });
    const recovered = await t.run(async (databaseCtx) => ({
      reservation: await databaseCtx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", "chat:v1:settlement-retry-exhausted:answer"),
        )
        .unique(),
      usage: await databaseCtx.db
        .query("tokenUsage")
        .withIndex("by_chat_reservation", (q) =>
          q.eq(
            "chatReservationKey",
            "chat:v1:settlement-retry-exhausted:answer",
          ),
        )
        .unique(),
    }));
    expect(recovered.reservation).toMatchObject({ status: "finalized" });
    expect(recovered.reservation?.settlementState).toBeUndefined();
    expect(recovered.usage).toMatchObject({ totalTokens: 15 });
  });

  it("periodically reschedules an exact outcome without letting expiry overwrite it", async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      const t = convexTest(schema, modules);
      const fixture = await insertFixture(t);
      const args = reservationArgs(fixture, "periodic-staged-recovery", 1, {
        inputTokenLimit: 20,
        outputTokenLimit: 20,
      });
      await reserve(t, args);
      await markStarted(t, args);
      await t.mutation(internal._ai.chatBilling.stageChatProviderOutcome, {
        reservationKey: args.reservationKey,
        attemptToken: args.attemptToken,
        userId: args.userId,
        repositoryId: args.repositoryId,
        ticketActionId: args.ticketActionId,
        outcome: {
          kind: "known_billed",
          inputTokens: 10,
          outputTokens: 5,
          providerRequestId: "periodic-recovery-request",
        },
      });
      const staged = await t.run(async (ctx) => {
        const reservation = await ctx.db
          .query("chatUsageReservations")
          .withIndex("by_reservation_key", (q) =>
            q.eq("reservationKey", args.reservationKey),
          )
          .unique();
        if (!reservation?.settlementScheduleId) {
          throw new Error("staged settlement schedule is missing");
        }
        await ctx.scheduler.cancel(reservation.settlementScheduleId);
        await ctx.db.patch(reservation._id, {
          expiresAt: Date.now() - 1,
          settlementNextRecoveryAt: Date.now() - 1,
        });
        return reservation;
      });
      expect(staged.settlementState).toBe("staged");
      await expect(
        t.mutation(internal._ai.chatBilling.cleanupChatReservations, {}),
      ).resolves.toMatchObject({ expired: 0 });
      await expect(
        t.mutation(internal._ai.chatBilling.markChatUsageAmbiguous, {
          reservationKey: args.reservationKey,
          attemptToken: args.attemptToken,
          userId: args.userId,
          repositoryId: args.repositoryId,
          ticketActionId: args.ticketActionId,
        }),
      ).resolves.toBe(false);
      await expect(
        t.mutation(internal._ai.chatBilling.recoverStagedChatOutcomes, {}),
      ).resolves.toEqual({ scheduled: 1 });
      await t.finishAllScheduledFunctions(() => vi.advanceTimersToNextTimer());
      await t.finishInProgressScheduledFunctions();

      const recovered = await t.run(async (ctx) =>
        ctx.db
          .query("chatUsageReservations")
          .withIndex("by_reservation_key", (q) =>
            q.eq("reservationKey", args.reservationKey),
          )
          .unique(),
      );
      expect(recovered).toMatchObject({ status: "finalized" });
      expect(recovered?.settlementState).toBeUndefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("defers immediately when reservation sees account provider contention", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const blocker = reservationArgs(fixture, "provider-contention-blocker");
    await reserve(t, blocker);
    await markStarted(t, blocker);
    const rawProvider = exactUsageProvider();
    const invokeMutation = getUntypedMutationRunner(t);
    let reserveCalls = 0;
    const provider = createMeteredProvider(
      {
        runMutation: async (
          reference: AnyFunctionReference,
          mutationArgs: Record<string, unknown>,
        ) => {
          if (
            getFunctionName(reference) === "_ai/chatBilling:reserveChatUsage"
          ) {
            reserveCalls++;
          }
          return await invokeMutation(reference, mutationArgs);
        },
      } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey: "provider-contention-waiter",
        operation: "contention-wait-test",
        provider: rawProvider,
      },
    );
    await expect(
      provider.chat(
        [{ role: "user", content: "Retry after the first request" }],
        { billingLabel: "answer", maxTokens: 20 },
      ),
    ).rejects.toMatchObject({
      name: "ChatBillingError",
      reason: "provider_attempt_in_progress",
      durableRetrySafe: true,
    });
    expect(reserveCalls).toBe(1);
    expect(rawProvider.chat).not.toHaveBeenCalled();
    await finalize(t, blocker);
  });

  it("releases a waiter when provider-start contention wins the race", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const blocker = reservationArgs(
      fixture,
      "provider-start-contention-blocker",
    );
    await reserve(t, blocker);
    const rawProvider = exactUsageProvider();
    const generationKey = "provider-start-contention-waiter";
    const beforeProviderStart = vi.fn(async () => {
      await expect(markStarted(t, blocker)).resolves.toBe(true);
    });
    const provider = createMeteredProvider(
      { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey,
        operation: "provider-start-contention-test",
        provider: rawProvider,
        beforeProviderStart,
      },
    );

    await expect(
      provider.chat([{ role: "user", content: "Retry this request" }], {
        billingLabel: "answer",
        maxTokens: 20,
      }),
    ).rejects.toMatchObject({
      name: "ChatBillingError",
      reason: "provider_attempt_in_progress",
      durableRetrySafe: true,
    });
    expect(beforeProviderStart).toHaveBeenCalledOnce();
    expect(rawProvider.chat).not.toHaveBeenCalled();

    const waiter = await t.run(async (ctx) =>
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", `chat:v1:${generationKey}:answer`),
        )
        .unique(),
    );
    expect(waiter).toMatchObject({
      status: "released",
      releaseReason: "request_finished_without_provider_usage",
    });
    expect(waiter?.providerStartedAt).toBeUndefined();
    await finalize(t, blocker);
  });

  it("retries provider-start mutation errors exactly three times", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const invokeMutation = getUntypedMutationRunner(t);
    const rawProvider = exactUsageProvider();
    let providerStartCalls = 0;
    const provider = createMeteredProvider(
      {
        runMutation: async (
          reference: AnyFunctionReference,
          mutationArgs: Record<string, unknown>,
        ) => {
          if (
            getFunctionName(reference) ===
              "_ai/chatBilling:markChatProviderStarted" &&
            providerStartCalls++ < 2
          ) {
            throw new Error("transient provider-start mutation failure");
          }
          return await invokeMutation(reference, mutationArgs);
        },
      } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey: "provider-start-third-attempt",
        operation: "provider-start-retry-test",
        provider: rawProvider,
      },
    );

    await expect(
      provider.chat([{ role: "user", content: "Retry provider start" }], {
        billingLabel: "answer",
        maxTokens: 20,
      }),
    ).resolves.toMatchObject({ content: "Answer" });
    expect(providerStartCalls).toBe(3);
    expect(rawProvider.chat).toHaveBeenCalledOnce();
  });

  it("releases the reservation after three provider-start mutation errors", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const invokeMutation = getUntypedMutationRunner(t);
    const rawProvider = exactUsageProvider();
    const generationKey = "provider-start-retry-exhausted";
    let providerStartCalls = 0;
    const provider = createMeteredProvider(
      {
        runMutation: async (
          reference: AnyFunctionReference,
          mutationArgs: Record<string, unknown>,
        ) => {
          if (
            getFunctionName(reference) ===
            "_ai/chatBilling:markChatProviderStarted"
          ) {
            providerStartCalls++;
            throw new Error("persistent provider-start mutation failure");
          }
          return await invokeMutation(reference, mutationArgs);
        },
      } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey,
        operation: "provider-start-retry-exhaustion-test",
        provider: rawProvider,
      },
    );

    await expect(
      provider.chat([{ role: "user", content: "Do not call AI" }], {
        billingLabel: "answer",
        maxTokens: 20,
      }),
    ).rejects.toMatchObject({
      name: "ChatBillingError",
      reason: "provider_start_failed",
      durableRetrySafe: true,
    });
    expect(providerStartCalls).toBe(3);
    expect(rawProvider.chat).not.toHaveBeenCalled();

    const reservation = await t.run(async (ctx) =>
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", `chat:v1:${generationKey}:answer`),
        )
        .unique(),
    );
    expect(reservation).toMatchObject({
      status: "released",
      releaseReason: "request_finished_without_provider_usage",
    });
    expect(reservation?.providerStartedAt).toBeUndefined();
  });

  it("does not enter AI after the owning ticket action is no longer pending", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const invokeMutation = getUntypedMutationRunner(t);
    const rawProvider = exactUsageProvider();
    const generationKey = "stale-ticket-action";
    let providerStartCalls = 0;
    const provider = createMeteredProvider(
      {
        runMutation: async (
          reference: AnyFunctionReference,
          mutationArgs: Record<string, unknown>,
        ) => {
          if (
            getFunctionName(reference) ===
              "_ai/chatBilling:markChatProviderStarted" &&
            providerStartCalls++ === 0
          ) {
            await invokeMutation(reference, mutationArgs);
            await t.run(async (databaseCtx) => {
              await databaseCtx.db.patch(fixture.ticketActionId, {
                status: "completed",
              });
            });
            throw new Error("provider-start response was lost");
          }
          return await invokeMutation(reference, mutationArgs);
        },
      } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey,
        operation: "stale-action-test",
        provider: rawProvider,
      },
    );

    await expect(
      provider.chat([{ role: "user", content: "Do not duplicate this" }], {
        billingLabel: "answer",
        maxTokens: 20,
      }),
    ).rejects.toMatchObject({
      name: "ChatBillingError",
      reason: "reservation_closed",
      durableRetrySafe: false,
    });
    expect(rawProvider.chat).not.toHaveBeenCalled();

    const reservation = await t.run(async (ctx) =>
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", `chat:v1:${generationKey}:answer`),
        )
        .unique(),
    );
    expect(reservation).toMatchObject({
      status: "released",
      releaseReason: "request_finished_without_provider_usage",
    });
    expect(reservation?.providerStartedAt).toEqual(expect.any(Number));
  });

  it("keeps a metered reservation ambiguous after an ambiguous provider failure", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const generationKey = "wrapper-ambiguous";
    const billingLabel = "answer";
    const ctx = {
      runMutation: t.mutation.bind(t),
    } as unknown as ActionCtx;
    const provider = createMeteredProvider(ctx, {
      ...fixture,
      generationKey,
      operation: "wrapper-test",
      provider: failingProvider(
        new ChatProviderRequestError("network unavailable", "ambiguous"),
      ),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      provider.chat([{ role: "user", content: "Question" }], {
        maxTokens: 16,
        billingLabel,
      }),
    ).rejects.toMatchObject({
      name: "ChatProviderRequestError",
      billingOutcome: "ambiguous",
    });

    const reservationKey = `chat:v1:${generationKey}:${billingLabel}`;
    const reservation = await t.run(async (databaseCtx) =>
      databaseCtx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    );
    expect(reservation).toMatchObject({
      status: "ambiguous",
      releaseReason: "ambiguous_provider_attempt",
    });

    await expect(
      reserve(t, reservationArgs(fixture, "after-ambiguous-provider")),
    ).resolves.toEqual({
      allowed: false,
      reason: "unresolved_provider_usage",
    });
  });

  it("records exact usage without ambiguity when billed response parsing fails", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const generationKey = "wrapper-known-billed-parse-error";
    const billingLabel = "answer";
    const provider = createMeteredProvider(
      { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey,
        operation: "wrapper-test",
        provider: failingProvider(
          new ChatProviderRequestError("invalid content", "billed", {
            providerRequestId: "request-known-billed",
            usage: {
              promptTokens: 10,
              completionTokens: 512,
              totalTokens: 522,
            },
          }),
        ),
      },
    );

    await expect(
      provider.chat([{ role: "user", content: "Question" }], {
        maxTokens: 512,
        billingLabel,
      }),
    ).rejects.toMatchObject({
      name: "ChatProviderRequestError",
      billingOutcome: "billed",
      usage: {
        promptTokens: 10,
        completionTokens: 512,
        totalTokens: 522,
      },
    });

    const reservationKey = `chat:v1:${generationKey}:${billingLabel}`;
    const state = await t.run(async (databaseCtx) => ({
      reservation: await databaseCtx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
      usage: await databaseCtx.db
        .query("tokenUsage")
        .withIndex("by_chat_reservation", (q) =>
          q.eq("chatReservationKey", reservationKey),
        )
        .unique(),
    }));
    expect(state.reservation).toMatchObject({
      status: "finalized",
      providerRequestId: "request-known-billed",
    });
    expect(state.reservation?.outputTokenLimit).toBe(512);
    expect(state.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 512,
    });
    await expect(
      reserve(t, reservationArgs(fixture, "after-known-billed-parse-error")),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("does not cross the reserved entitlement-period provider boundary", async () => {
    let now = Date.parse("2026-07-31T23:59:59.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const t = convexTest(schema, modules);
    const args = reservationArgs(await insertFixture(t), "period-end");
    await reserve(t, args);
    now = Date.parse("2026-08-01T00:00:00.000Z");
    await expect(markStarted(t, args)).resolves.toBe(false);
    await expect(
      t.mutation(internal._ai.chatBilling.releaseChatUsage, {
        reservationKey: args.reservationKey,
        attemptToken: args.attemptToken,
        userId: args.userId,
        repositoryId: args.repositoryId,
        ticketActionId: args.ticketActionId,
        confirmedNotBilled: false,
      }),
    ).resolves.toBe(true);
  });

  it("reconciles known-not-billed and exact known-billed outcomes idempotently", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const adminUserId = await insertAdminUser(t);
    const admin = t.withIdentity({ subject: `${adminUserId}|admin-session` });
    const notBilled = reservationArgs(fixture, "reconcile-not-billed");
    await reserve(t, notBilled);
    await markStarted(t, notBilled);
    await t.mutation(internal._ai.chatBilling.markChatUsageAmbiguous, {
      reservationKey: notBilled.reservationKey,
      attemptToken: notBilled.attemptToken,
      userId: notBilled.userId,
      repositoryId: notBilled.repositoryId,
      ticketActionId: notBilled.ticketActionId,
    });
    const notBilledArgs = {
      reservationKey: notBilled.reservationKey,
      evidenceSource: "anthropic_support_confirmation" as const,
      evidenceReference: "support-case-1",
      outcome: { kind: "known_not_billed" as const },
    };
    await expect(
      admin.mutation(
        api.admin.paymentMutation.reconcileChatUsage,
        notBilledArgs,
      ),
    ).resolves.toEqual({ status: "released" });
    await expect(
      admin.mutation(
        api.admin.paymentMutation.reconcileChatUsage,
        notBilledArgs,
      ),
    ).resolves.toEqual({ status: "released" });

    const billed = reservationArgs(fixture, "reconcile-billed", 1, {
      inputTokenLimit: 10,
      outputTokenLimit: 10,
    });
    await reserve(t, billed);
    await markStarted(t, billed);
    await t.mutation(internal._ai.chatBilling.markChatUsageAmbiguous, {
      reservationKey: billed.reservationKey,
      attemptToken: billed.attemptToken,
      userId: billed.userId,
      repositoryId: billed.repositoryId,
      ticketActionId: billed.ticketActionId,
      providerRequestId: "request-billed",
    });
    const billedArgs = {
      reservationKey: billed.reservationKey,
      evidenceSource: "anthropic_usage_report" as const,
      evidenceReference: "usage-row-1",
      outcome: {
        kind: "known_billed" as const,
        actualInputTokens: 10,
        actualOutputTokens: 5,
        providerRequestId: "request-billed",
      },
    };
    const result = await admin.mutation(
      api.admin.paymentMutation.reconcileChatUsage,
      billedArgs,
    );
    expect(result).toMatchObject({ status: "finalized" });
    await expect(
      admin.mutation(api.admin.paymentMutation.reconcileChatUsage, billedArgs),
    ).resolves.toEqual(result);
  });

  it("keeps ceiling-exceeding billed evidence ambiguous and permits a corrected retry", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const adminUserId = await insertAdminUser(t);
    const admin = t.withIdentity({ subject: `${adminUserId}|admin-session` });
    const subscriptionId = await insertTrustedProWallet(t, fixture.userId, 100);
    const billed = reservationArgs(fixture, "reconcile-over-ceiling", 1, {
      inputTokenLimit: 10,
      outputTokenLimit: 10,
    });
    const waiting = reservationArgs(
      fixture,
      "waiting-during-reconciliation",
      1,
      {
        inputTokenLimit: 10,
        outputTokenLimit: 10,
      },
    );
    await expect(reserve(t, billed)).resolves.toMatchObject({ allowed: true });
    await expect(reserve(t, waiting)).resolves.toMatchObject({ allowed: true });
    await expect(markStarted(t, billed)).resolves.toBe(true);
    await expect(
      t.mutation(internal._ai.chatBilling.markChatUsageAmbiguous, {
        reservationKey: billed.reservationKey,
        attemptToken: billed.attemptToken,
        userId: billed.userId,
        repositoryId: billed.repositoryId,
        ticketActionId: billed.ticketActionId,
        providerRequestId: "request-over-ceiling",
      }),
    ).resolves.toBe(true);

    for (const [actualInputTokens, actualOutputTokens] of [
      [11, 5],
      [5, 11],
    ] as const) {
      await expect(
        admin.mutation(api.admin.paymentMutation.reconcileChatUsage, {
          reservationKey: billed.reservationKey,
          evidenceSource: "anthropic_usage_report",
          evidenceReference: "usage-row-over-ceiling",
          outcome: {
            kind: "known_billed",
            actualInputTokens,
            actualOutputTokens,
            providerRequestId: "request-over-ceiling",
          },
        }),
      ).rejects.toThrow(
        "Known billed AI usage exceeds its reservation ceiling and requires manual reconciliation",
      );
    }

    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", billed.reservationKey),
        )
        .unique();
      if (!reservation) throw new Error("chat reservation missing");
      await ctx.db.patch(reservation._id, { reservedTokens: 14 });
    });
    await expect(
      admin.mutation(api.admin.paymentMutation.reconcileChatUsage, {
        reservationKey: billed.reservationKey,
        evidenceSource: "anthropic_usage_report",
        evidenceReference: "usage-row-over-ceiling",
        outcome: {
          kind: "known_billed",
          actualInputTokens: 10,
          actualOutputTokens: 5,
          providerRequestId: "request-over-ceiling",
        },
      }),
    ).rejects.toThrow(
      "Known billed AI usage exceeds its reservation ceiling and requires manual reconciliation",
    );

    const unresolved = await t.run(async (ctx) => ({
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_chat_reservation", (q) =>
          q.eq("chatReservationKey", billed.reservationKey),
        )
        .first(),
      billed: await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", billed.reservationKey),
        )
        .unique(),
      waiting: await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", waiting.reservationKey),
        )
        .unique(),
      subscription: await ctx.db.get(subscriptionId),
    }));
    expect(unresolved.usage).toBeNull();
    expect(unresolved.billed).toMatchObject({
      status: "ambiguous",
      releaseReason: "ambiguous_provider_attempt",
      providerRequestId: "request-over-ceiling",
      reservedTokens: 14,
    });
    expect(unresolved.billed?.reconciliation).toBeUndefined();
    expect(unresolved.waiting).toMatchObject({ status: "pending" });
    expect(unresolved.waiting?.providerStartedAt).toBeUndefined();
    expect(unresolved.subscription?.purchasedTokens).toBe(100);
    await expect(markStarted(t, waiting)).resolves.toBe(false);

    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", billed.reservationKey),
        )
        .unique();
      if (!reservation) throw new Error("chat reservation missing");
      await ctx.db.patch(reservation._id, { reservedTokens: 20 });
    });

    const corrected = await admin.mutation(
      api.admin.paymentMutation.reconcileChatUsage,
      {
        reservationKey: billed.reservationKey,
        evidenceSource: "anthropic_usage_report",
        evidenceReference: "usage-row-over-ceiling",
        outcome: {
          kind: "known_billed",
          actualInputTokens: 10,
          actualOutputTokens: 5,
          providerRequestId: "request-over-ceiling",
        },
      },
    );
    expect(corrected).toMatchObject({ status: "finalized" });
    await expect(markStarted(t, waiting)).resolves.toBe(true);
  });

  it("does not block a chat provider start on a retired ambiguous embedding hold", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const chat = reservationArgs(fixture, "chat-waiting-on-embedding", 1, {
      inputTokenLimit: 10,
      outputTokenLimit: 10,
    });
    await expect(reserve(t, chat)).resolves.toMatchObject({ allowed: true });

    // An unresolved embedding call from before embeddings were retired.
    await insertLegacyEmbeddingReservation(t, fixture, {
      reservationKey: "ambiguous-embedding-before-chat-start",
      status: "ambiguous",
      providerStartedAt: Date.now(),
    });

    await expect(markStartResult(t, chat)).resolves.toEqual({
      started: true,
      alreadyStarted: false,
    });
  });

  it("allows only one provider-started AI request per account", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const firstChat = reservationArgs(fixture, "single-provider-chat-1");
    const secondChat = reservationArgs(fixture, "single-provider-chat-2");
    await expect(reserve(t, firstChat)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(reserve(t, secondChat)).resolves.toMatchObject({
      allowed: true,
    });

    await expect(markStarted(t, firstChat)).resolves.toBe(true);
    await expect(markStartResult(t, secondChat)).resolves.toEqual({
      started: false,
      reason: "provider_attempt_in_progress",
    });
    await finalize(t, firstChat);
    await expect(markStarted(t, secondChat)).resolves.toBe(true);
  });
});

describe("metered multi-provider replay", () => {
  it.each(["fallback-replenished", "primary-expired"])(
    "replays %s without a second billed request",
    async (scenario) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const t = convexTest(schema, modules);
      const fixture = await insertFixture(t);
      const ctx = { runMutation: t.mutation.bind(t) } as unknown as ActionCtx;
      const makeProvider = () =>
        createMeteredProvider(ctx, {
          ...fixture,
          generationKey: `route-replay-${scenario}`,
          operation: "answer",
          provider: new CreditFallbackProvider(
            new ClaudeProvider("claude-test"),
            new OpenAIProvider("openai-test"),
          ),
        });
      const fetch = vi.spyOn(globalThis, "fetch");
      if (scenario === "fallback-replenished") {
        fetch.mockResolvedValueOnce(
          Response.json({ error: { type: "billing_error" } }, { status: 402 }),
        );
        fetch.mockResolvedValueOnce(
          Response.json({
            status: "completed",
            output: [
              {
                type: "reasoning",
                id: "rs_saved",
                encrypted_content: "encrypted-saved-state",
                summary: [],
              },
              {
                type: "message",
                phase: "final_answer",
                content: [{ type: "output_text", text: "saved OpenAI answer" }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
        );
      } else {
        fetch.mockResolvedValueOnce(
          Response.json({
            content: [{ type: "text", text: "saved Claude answer" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        );
      }
      const messages = [{ role: "user" as const, content: "Question" }];
      const result = await makeProvider().chat(messages, {
        billingLabel: "answer",
      });
      const calls = fetch.mock.calls.length;
      if (scenario === "primary-expired")
        vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT);
      const retry = makeProvider();
      expect(await retry.chat(messages, { billingLabel: "answer" })).toEqual(
        result,
      );
      expect(fetch).toHaveBeenCalledTimes(calls);
      expect(retry.providerId).toBe(
        scenario === "fallback-replenished" ? "openai" : "anthropic",
      );
      const state = await t.run(async (ctx) => ({
        usage: await ctx.db.query("tokenUsage").take(10),
        reservations: await ctx.db.query("chatUsageReservations").take(10),
      }));
      expect(state.usage).toHaveLength(1);
      expect(state.reservations).toHaveLength(1);
      expect(state.usage[0]).toMatchObject({
        provider: scenario === "fallback-replenished" ? "openai" : "anthropic",
        inputTokens: 10,
        outputTokens: 5,
      });
      expect(state.usage[0].baseCostCents).toBeCloseTo(0.007);
    },
  );
});

it("keeps a deadline-crossing in-flight request retryable without dispatching another provider", async () => {
  const now = CLAUDE_API_ENDS_AT - 1_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const t = convexTest(schema, modules);
  const fixture = await insertFixture(t);
  // Free periods after the monthly allowance ended need prepaid tokens.
  await t.run(async (dbCtx) => {
    const date = new Date(now);
    await dbCtx.db.insert("subscriptions", {
      userId: fixture.userId,
      plan: "free",
      status: "active",
      includedTokens: 0,
      purchasedTokens: PRICING.TRIAL_TOKENS,
      serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
      periodStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      periodEnd: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
      createdAt: now,
      updatedAt: now,
    });
  });
  const ctx = { runMutation: t.mutation.bind(t) } as unknown as ActionCtx;
  const makeProvider = () =>
    createMeteredProvider(ctx, {
      ...fixture,
      generationKey: "deadline-crossing-pending",
      operation: "answer",
      provider: new CreditFallbackProvider(
        new ClaudeProvider("test"),
        new OpenAIProvider("test"),
      ),
    });
  let resolveResponse!: (value: Response) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    signalStarted();
    return new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
  });
  const messages = [{ role: "user" as const, content: "Question" }];
  const first = makeProvider().chat(messages, { billingLabel: "answer" });
  await started;
  vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT);
  await expect(
    makeProvider().chat(messages, { billingLabel: "answer" }),
  ).rejects.toMatchObject({ reason: "provider_attempt_in_progress" });
  expect(fetch).toHaveBeenCalledTimes(1);
  resolveResponse(
    Response.json({
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  );
  const result = await first;
  expect(
    await makeProvider().chat(messages, { billingLabel: "answer" }),
  ).toEqual(result);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("waits for another request on the account when given a wait budget", async () => {
  // Only the wait poll is held back; convex-test keeps its real timers.
  const polls: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  const poll = async () => {
    await vi.waitFor(() => expect(polls.length).toBeGreaterThan(0));
    polls.shift()?.();
  };
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    if (delay !== 2_000) return realSetTimeout(callback, delay);
    polls.push(callback);
    return 0;
  }) as typeof setTimeout);
  try {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const ctx = { runMutation: t.mutation.bind(t) } as unknown as ActionCtx;
    let finishFirst!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const answer = {
      content: "Answer",
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      provider: "anthropic",
    };
    const slow = exactUsageProvider(
      vi.fn(async () => {
        signalStarted();
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        return { ...answer, providerRequestId: "first" };
      }),
    );
    const fast = vi.fn(async () => ({
      ...answer,
      providerRequestId: "second",
    }));
    const messages = [{ role: "user" as const, content: "Question" }];
    const first = createMeteredProvider(ctx, {
      ...fixture,
      generationKey: "concurrent-first",
      operation: "answer",
      provider: slow,
    }).chat(messages, { billingLabel: "answer", maxTokens: 20 });
    await started;
    const second = (activeProviderWaitMs?: number) =>
      createMeteredProvider(ctx, {
        ...fixture,
        generationKey: "concurrent-second",
        operation: "answer",
        provider: exactUsageProvider(fast),
        activeProviderWaitMs,
      }).chat(messages, { billingLabel: "answer", maxTokens: 20 });

    await expect(second()).rejects.toMatchObject({
      reason: "provider_attempt_in_progress",
    });
    const expired = expect(second(4_000)).rejects.toMatchObject({
      reason: "provider_attempt_in_progress",
    });
    await poll();
    await poll();
    await expired;
    expect(fast).not.toHaveBeenCalled();

    const waiting = second(10_000);
    await poll();
    await vi.waitFor(() => expect(polls).toHaveLength(1));
    expect(fast).not.toHaveBeenCalled();
    finishFirst();
    await first;
    await poll();
    await expect(waiting).resolves.toMatchObject({
      providerRequestId: "second",
    });
    expect(fast).toHaveBeenCalledTimes(1);
  } finally {
    vi.mocked(globalThis.setTimeout).mockRestore();
  }
});

describe("chat reservation during repository indexing", () => {
  it("reserves for a disconnecting repository and rejects it at provider start", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const args = reservationArgs(fixture, "disconnecting-repository");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, {
        disconnectCleanupPending: true,
      });
    });

    await expect(reserve(t, args)).resolves.toMatchObject({ allowed: true });
    await expect(markStartResult(t, args)).resolves.toEqual({
      started: false,
      reason: "reservation_closed",
    });
  });
});
