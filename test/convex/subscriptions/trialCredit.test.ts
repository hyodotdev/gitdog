import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { ActionCtx } from "../../../convex/_generated/server";
import { createMeteredProvider } from "../../../convex/_ai/chatBilling";
import {
  FREE_MONTHLY_ALLOWANCE_ENDS_AT,
  GENERATION_MODELS,
  getFreeIncludedTokens,
  LEGACY_FREE_MONTHLY_TOKENS,
  PRICING,
} from "../../../convex/_ai/config";
import { getEffectiveSubscriptionEntitlement } from "../../../convex/subscriptions/entitlement";
import schema from "../../../convex/schema";

const modules = import.meta.glob("../../../convex/**/*.ts");
const AFTER_CUTOFF = Date.parse("2026-12-15T12:00:00Z");

afterEach(() => {
  vi.restoreAllMocks();
});

async function signedIn(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

async function wallet(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("subscriptions").collect();
    return rows.reduce((total, row) => total + row.purchasedTokens, 0);
  });
}

describe("free monthly allowance cutoff", () => {
  it("keeps the allowance only for free periods that started before the cutoff", () => {
    expect(getFreeIncludedTokens(Date.parse("2026-11-01T00:00:00Z"))).toBe(
      LEGACY_FREE_MONTHLY_TOKENS,
    );
    expect(getFreeIncludedTokens(FREE_MONTHLY_ALLOWANCE_ENDS_AT)).toBe(0);
    expect(
      getEffectiveSubscriptionEntitlement(null, AFTER_CUTOFF),
    ).toMatchObject({ plan: "free", includedTokens: 0 });
    expect(
      getEffectiveSubscriptionEntitlement(
        null,
        Date.parse("2026-11-20T00:00:00Z"),
      ),
    ).toMatchObject({
      plan: "free",
      includedTokens: LEGACY_FREE_MONTHLY_TOKENS,
    });
  });
});

describe("one-time trial credit", () => {
  it("grants the trial once, even after wallet rows are removed", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    await expect(
      as.mutation(api.subscriptions.mutation.claimTrialCredit, {}),
    ).resolves.toEqual({ granted: true, tokens: PRICING.TRIAL_TOKENS });
    expect(await wallet(t)).toBe(PRICING.TRIAL_TOKENS);

    await expect(
      as.mutation(api.subscriptions.mutation.claimTrialCredit, {}),
    ).resolves.toEqual({ granted: false, tokens: PRICING.TRIAL_TOKENS });
    await t.mutation(internal.subscriptions.internalMutation.grantTrialCredit, {
      userId,
    });
    expect(await wallet(t)).toBe(PRICING.TRIAL_TOKENS);

    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("subscriptions").collect())
        await ctx.db.delete(row._id);
    });
    await as.mutation(api.subscriptions.mutation.claimTrialCredit, {});
    expect(await wallet(t)).toBe(0);
  });

  it("does nothing for signed-out callers", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.subscriptions.mutation.claimTrialCredit, {}),
    ).resolves.toEqual({ granted: false, tokens: 0 });
    expect(await wallet(t)).toBe(0);
  });

  it("is the only Gitdog allowance a free account has after the cutoff", async () => {
    vi.spyOn(Date, "now").mockReturnValue(AFTER_CUTOFF);
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    await expect(
      t.query(internal.subscriptions.internalQuery.canPerformActionInternal, {
        userId,
      }),
    ).resolves.toMatchObject({ allowed: false });

    await as.mutation(api.subscriptions.mutation.claimTrialCredit, {});
    await expect(
      t.query(internal.subscriptions.internalQuery.canPerformActionInternal, {
        userId,
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      as.query(api.subscriptions.query.getCurrent, {}),
    ).resolves.toMatchObject({
      plan: "free",
      includedTokens: 0,
      purchasedTokens: PRICING.TRIAL_TOKENS,
    });
  });

  it("schedules the trial when the user accepts the terms", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "octocat" }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { CURRENT_PRIVACY_POLICY_VERSION, CURRENT_TERMS_VERSION } =
      await import("../../../convex/users/legal");
    vi.useFakeTimers();
    try {
      await as.mutation(api.users.mutation.attestLegalEligibility, {
        minimumAgeConfirmed: true,
        professionalUseConfirmed: true,
        termsAccepted: true,
        privacyPolicyAccepted: true,
        displayedTermsVersion: CURRENT_TERMS_VERSION,
        displayedPrivacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(await wallet(t)).toBe(PRICING.TRIAL_TOKENS);
  });
});

async function insertTicketFixture(
  t: ReturnType<typeof convexTest>,
  options: { trialUsed: boolean },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    if (options.trialUsed)
      await ctx.db.insert("trialCreditGrants", {
        userId,
        tokens: PRICING.TRIAL_TOKENS,
        grantedAt: 1,
      });
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: now,
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId: 1,
      githubRepositoryId: 1,
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
      githubNumber: 1,
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
    return { userId, repositoryId, ticketActionId };
  });
}

function reservationArgs(
  fixture: Awaited<ReturnType<typeof insertTicketFixture>>,
  key: string,
) {
  return {
    ...fixture,
    reservationKey: key,
    attemptToken: `${key}:1`,
    requirePendingTicketAction: true,
    generationKey: `generation:${key}`,
    operation: "answer",
    model: GENERATION_MODELS.anthropic.modelId,
    provider: "anthropic" as const,
    requestFingerprint: "0".repeat(64),
    inputTokenLimit: 2_000,
    outputTokenLimit: 2_000,
  };
}

describe("trial grant rules", () => {
  it("does not grant the trial to a Pro account", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("subscriptions", {
        userId,
        plan: "pro",
        status: "active",
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: now - 60_000,
        periodEnd: now + 86_400_000,
        proEntitlementProvenance: {
          source: "admin_override",
          verifiedAt: now - 1_000,
        },
        createdAt: now,
        updatedAt: now,
      }),
    );
    await expect(
      as.mutation(api.subscriptions.mutation.claimTrialCredit, {}),
    ).resolves.toEqual({ granted: false, tokens: 0 });
    await expect(
      t.run(async (ctx) => ctx.db.query("trialCreditGrants").collect()),
    ).resolves.toEqual([]);
  });

  it("grants once when the claim races the consent-scheduled grant", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    await Promise.all([
      as.mutation(api.subscriptions.mutation.claimTrialCredit, {}),
      t.mutation(internal.subscriptions.internalMutation.grantTrialCredit, {
        userId,
      }),
      as.mutation(api.subscriptions.mutation.claimTrialCredit, {}),
    ]);
    const grants = await t.run(async (ctx) =>
      ctx.db.query("trialCreditGrants").collect(),
    );
    expect(grants).toHaveLength(1);
    expect(await wallet(t)).toBe(PRICING.TRIAL_TOKENS);
  });

  it("grants the trial when a free owner's quota is first checked", async () => {
    vi.spyOn(Date, "now").mockReturnValue(AFTER_CUTOFF);
    const t = convexTest(schema, modules);
    const fixture = await insertTicketFixture(t, { trialUsed: false });
    await expect(
      t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        reservationArgs(fixture, "first-webhook"),
      ),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      t.run(async (ctx) => ctx.db.query("trialCreditGrants").collect()),
    ).resolves.toEqual([expect.objectContaining({ userId: fixture.userId })]);
    expect(await wallet(t)).toBe(PRICING.TRIAL_TOKENS);
  });

  it("settles a free reservation started in November after the cutoff", async () => {
    const reservedAt = FREE_MONTHLY_ALLOWANCE_ENDS_AT - 5_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(reservedAt);
    const t = convexTest(schema, modules);
    const fixture = await insertTicketFixture(t, { trialUsed: true });
    const provider = createMeteredProvider(
      { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
      {
        ...fixture,
        generationKey: "cutoff-span",
        operation: "answer",
        requirePendingTicketAction: true,
        provider: {
          name: "test",
          modelId: GENERATION_MODELS.anthropic.modelId,
          providerId: "anthropic",
          chat: async () => {
            // The provider answers after the free allowance has ended.
            clock.mockReturnValue(FREE_MONTHLY_ALLOWANCE_ENDS_AT + 30_000);
            return {
              content: "Answer",
              finishReason: "stop" as const,
              usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
              provider: "anthropic",
            };
          },
        },
      },
    );
    await expect(
      provider.chat([{ role: "user", content: "Question" }], {
        maxTokens: 16,
        billingLabel: "answer",
      }),
    ).resolves.toMatchObject({ content: "Answer" });
    const usage = await t.run(async (ctx) =>
      ctx.db.query("tokenUsage").collect(),
    );
    expect(usage).toEqual([
      expect.objectContaining({ totalTokens: 15, purchasedTokensDebited: 0 }),
    ]);
  });
});

describe("trial grant with Pro history", () => {
  async function insertProHistory(
    t: ReturnType<typeof convexTest>,
    userId: Awaited<ReturnType<typeof insertTicketFixture>>["userId"],
    state: "unsettled" | "manual_review" | "expired_before_period_end",
  ) {
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("subscriptions", {
        userId,
        plan: "pro",
        status: state === "expired_before_period_end" ? "expired" : "canceled",
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: now - 40 * 86_400_000,
        periodEnd:
          state === "expired_before_period_end"
            ? now + 86_400_000
            : now - 86_400_000,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now - 40 * 86_400_000,
        },
        ...(state === "manual_review"
          ? { billingBoundaryManualReviewReason: "Needs an operator." }
          : {}),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  for (const state of [
    "unsettled",
    "manual_review",
    "expired_before_period_end",
  ] as const) {
    it(`skips the grant without writes or errors for ${state} Pro history`, async () => {
      const t = convexTest(schema, modules);
      const fixture = await insertTicketFixture(t, { trialUsed: false });
      await insertProHistory(t, fixture.userId, state);
      const before = await t.run(async (ctx) =>
        ctx.db.query("subscriptions").collect(),
      );

      await expect(
        t.mutation(internal.subscriptions.internalMutation.grantTrialCredit, {
          userId: fixture.userId,
        }),
      ).resolves.toEqual({ status: "pro_settling", tokens: 0 });
      // The chat path refuses as before instead of throwing.
      await expect(
        t.mutation(
          internal._ai.chatBilling.reserveChatUsage,
          reservationArgs(fixture, `chat-${state}`),
        ),
      ).resolves.toMatchObject({ allowed: false });

      const after = await t.run(async (ctx) => ({
        grants: await ctx.db.query("trialCreditGrants").collect(),
        subscriptions: await ctx.db.query("subscriptions").collect(),
      }));
      expect(after.grants).toEqual([]);
      expect(after.subscriptions.map((row) => row.purchasedTokens)).toEqual(
        before.map((row) => row.purchasedTokens),
      );
    });
  }

  it("leaves a batched review refusal intact for an owner with unsettled Pro history", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertTicketFixture(t, { trialUsed: false });
    await insertProHistory(t, fixture.userId, "unsettled");
    const reviewAction = await t.run(async (ctx) => {
      const action = await ctx.db.get(fixture.ticketActionId);
      return await ctx.db.insert("ticketActions", {
        ticketId: action!.ticketId,
        actionType: "review",
        chatHistory: [],
        proposalVersion: 0,
        status: "pending",
        createdAt: Date.now(),
      });
    });
    await expect(
      t.mutation(
        internal.pullRequests.internalMutation.reserveBatchedReviewQuota,
        { actionId: reviewAction, batches: 1 },
      ),
    ).resolves.toMatchObject({ reserved: false });
    await expect(
      t.run(async (ctx) => ctx.db.query("trialCreditGrants").collect()),
    ).resolves.toEqual([]);
  });
});

describe("trial tokens in the wallet", () => {
  it("spends the trial before paid tokens and keeps it out of refunds", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    await as.mutation(api.subscriptions.mutation.claimTrialCredit, {});
    const { consolidatePurchasedTokenWallet, debitPurchasedTokenWallet } =
      await import("../../../convex/subscriptions/wallet");
    const state = await t.run(async (ctx) => {
      const [row] = await ctx.db.query("subscriptions").collect();
      const now = Date.now();
      // A 200-token pack on top of the trial, then 150 tokens of usage.
      await consolidatePurchasedTokenWallet(ctx, {
        userId,
        targetSubscriptionId: row._id,
        tokensToAdd: 200,
        now,
      });
      await debitPurchasedTokenWallet(ctx, {
        userId,
        targetSubscriptionId: row._id,
        tokensToDebit: 150,
        now,
      });
      return await ctx.db.get(row._id);
    });
    expect(state).toMatchObject({
      purchasedTokens: PRICING.TRIAL_TOKENS + 50,
      trialTokens: PRICING.TRIAL_TOKENS - 150,
    });
    // All 200 paid tokens are still refundable.
    expect(
      (state?.purchasedTokens ?? 0) - 200 >= (state?.trialTokens ?? 0),
    ).toBe(true);
    await expect(
      as.query(api.subscriptions.query.getCurrent, {}),
    ).resolves.toMatchObject({ trialTokens: PRICING.TRIAL_TOKENS - 150 });
  });
});

describe("round 3 wallet and boundary safety", () => {
  it("refunds take back paid tokens only", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    await as.mutation(api.subscriptions.mutation.claimTrialCredit, {});
    const { consolidatePurchasedTokenWallet, debitPurchasedTokenWallet } =
      await import("../../../convex/subscriptions/wallet");
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("subscriptions").collect();
      const now = Date.now();
      await consolidatePurchasedTokenWallet(ctx, {
        userId,
        targetSubscriptionId: row._id,
        tokensToAdd: 200,
        now,
      });
      await expect(
        debitPurchasedTokenWallet(ctx, {
          userId,
          targetSubscriptionId: row._id,
          tokensToDebit: 300,
          now,
          paidOnly: true,
        }),
      ).rejects.toThrow("trial tokens");
      await debitPurchasedTokenWallet(ctx, {
        userId,
        targetSubscriptionId: row._id,
        tokensToDebit: 200,
        now,
        paidOnly: true,
      });
      expect(await ctx.db.get(row._id)).toMatchObject({
        purchasedTokens: PRICING.TRIAL_TOKENS,
        trialTokens: PRICING.TRIAL_TOKENS,
      });
    });
  });

  it("does not crash a batched review when Pro boundary history is corrupt", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertTicketFixture(t, { trialUsed: false });
    const now = Date.now();
    await t.run(async (ctx) => {
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId: fixture.userId,
        plan: "pro",
        status: "canceled",
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart: now - 40 * 86_400_000,
        periodEnd: now - 86_400_000,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now - 40 * 86_400_000,
        },
        createdAt: now,
        updatedAt: now,
      });
      for (let copy = 0; copy < 2; copy++)
        await ctx.db.insert("subscriptionBillingBoundaries", {
          subscriptionId,
          periodStart: now - 40 * 86_400_000,
          periodEnd: now - 86_400_000,
          providerUpdatedAt: now,
          status: "settled",
          createdAt: now,
          updatedAt: now,
        });
    });
    const grant = await t.mutation(
      internal.subscriptions.internalMutation.grantTrialCredit,
      { userId: fixture.userId },
    );
    expect(grant).toEqual({ status: "pro_settling", tokens: 0 });
    const reviewAction = await t.run(async (ctx) => {
      const action = await ctx.db.get(fixture.ticketActionId);
      return await ctx.db.insert("ticketActions", {
        ticketId: action!.ticketId,
        actionType: "review",
        chatHistory: [],
        proposalVersion: 0,
        status: "pending",
        createdAt: now,
      });
    });
    const result = await t
      .mutation(
        internal.pullRequests.internalMutation.reserveBatchedReviewQuota,
        { actionId: reviewAction, batches: 1 },
      )
      .catch((error: Error) => ({ thrown: error.message }));
    // The grant step itself never throws; any refusal comes from the
    // existing quota check, as it did before the trial existed.
    expect(result).not.toHaveProperty(
      "thrown",
      expect.stringContaining("trial"),
    );
  });

  it("degrades getCurrent instead of throwing for more than 100 wallet rows", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 101; index++)
        await ctx.db.insert("subscriptions", {
          userId,
          plan: "free",
          status: "active",
          includedTokens: 0,
          purchasedTokens: 1,
          serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
          periodStart: now - 1_000,
          periodEnd: now + 86_400_000,
          createdAt: now + index,
          updatedAt: now,
        });
    });
    await expect(
      as.query(api.subscriptions.query.getCurrent, {}),
    ).resolves.toMatchObject({ plan: "free", walletUnverified: true });
  });

  it("counts a staged embedding outcome as open usage and caps embedding holds", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertTicketFixture(t, { trialUsed: true });
    const { hasOpenUsageReservation } =
      await import("../../../convex/_ai/chatBilling");
    const { checkBillingBoundaryProviderHolds } =
      await import("../../../convex/subscriptions/billingBoundaries");
    const now = Date.now();
    const subscriptionId = await t.run(async (ctx) =>
      ctx.db.insert("subscriptions", {
        userId: fixture.userId,
        plan: "free",
        status: "active",
        includedTokens: 0,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        periodStart: now - 1_000,
        periodEnd: now + 86_400_000,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const insert = (key: string, staged: boolean) =>
      t.run(async (ctx) =>
        ctx.db.insert("embeddingUsageReservations", {
          reservationKey: key,
          attemptToken: `${key}:1`,
          userId: fixture.userId,
          repositoryId: fixture.repositoryId,
          operation: "RAG search",
          provider: "openai",
          model: "text-embedding-3-small",
          inputCount: 1,
          providerTokenLimit: 100,
          reservedTokens: 2,
          subscriptionId,
          entitlementPlan: "free",
          includedTokens: 0,
          serviceFeeRate: 0.25,
          quotaPeriodStart: now - 1_000,
          quotaPeriodEnd: now + 60_000,
          status: "pending",
          providerStartedAt: now - 1_000,
          ...(staged
            ? { settlementState: "staged" as const, settlementTokens: 1 }
            : {}),
          expiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
        }),
      );
    await insert("plain", false);
    await expect(
      t.run((ctx) => hasOpenUsageReservation(ctx, fixture.userId)),
    ).resolves.toBe(false);
    await insert("staged", true);
    await expect(
      t.run((ctx) => hasOpenUsageReservation(ctx, fixture.userId)),
    ).resolves.toBe(true);

    for (let index = 0; index < 100; index++)
      await insert(`hold-${index}`, false);
    await expect(
      t.run(async (ctx) =>
        checkBillingBoundaryProviderHolds(
          ctx,
          (await ctx.db.get(subscriptionId))!,
          {
            subscriptionId,
            periodStart: now - 1_000,
            periodEnd: now + 86_400_000,
          } as never,
          now,
        ),
      ),
    ).resolves.toBe("ambiguous");
  });
});

describe("former Pro owners", () => {
  it("get the trial on the first request after their Pro period settles", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertTicketFixture(t, { trialUsed: false });
    const now = Date.now();
    await t.run(async (ctx) => {
      const periodStart = now - 31 * 86_400_000;
      const periodEnd = now - 60_000;
      await ctx.db.insert("subscriptions", {
        userId: fixture.userId,
        plan: "pro",
        status: "canceled",
        includedTokens: PRICING.PRO_INCLUDED_TOKENS,
        purchasedTokens: 0,
        serviceFeeRate: PRICING.PLATFORM_FEE_PRO,
        periodStart,
        periodEnd,
        providerUpdatedAt: periodStart,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: periodStart,
        },
        createdAt: periodStart,
        updatedAt: periodStart,
      });
    });
    await expect(
      t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        reservationArgs(fixture, "after-pro"),
      ),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      t.run(async (ctx) => ctx.db.query("trialCreditGrants").collect()),
    ).resolves.toEqual([expect.objectContaining({ userId: fixture.userId })]);
  });
});

describe("staged embedding charges in chat quota", () => {
  it("keeps tokens owed for a staged embedding outcome out of new chat reservations", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertTicketFixture(t, { trialUsed: true });
    const now = Date.now();
    await t.run(async (ctx) => {
      const date = new Date(now);
      const subscriptionId = await ctx.db.insert("subscriptions", {
        userId: fixture.userId,
        plan: "free",
        status: "active",
        includedTokens: 0,
        purchasedTokens: 5_000,
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        periodStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
        periodEnd: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
        createdAt: now,
        updatedAt: now,
      });
      // Exhaust the free allowance so only the 5,000 wallet tokens remain.
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId: fixture.userId,
        repositoryId: fixture.repositoryId,
        usageType: "chat",
        inputTokens: getFreeIncludedTokens(now),
        outputTokens: 0,
        totalTokens: getFreeIncludedTokens(now),
        inputCostCents: 0,
        outputCostCents: 0,
        baseCostCents: 0,
        serviceFeeCents: 0,
        totalCostCents: 0,
        model: GENERATION_MODELS.anthropic.modelId,
        provider: "anthropic",
        serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
        createdAt: now,
      });
      await ctx.db.insert("embeddingUsageReservations", {
        reservationKey: "staged-before-retirement",
        attemptToken: "1",
        userId: fixture.userId,
        repositoryId: fixture.repositoryId,
        operation: "RAG search",
        provider: "openai",
        model: "text-embedding-3-small",
        inputCount: 1,
        providerTokenLimit: 1_000,
        reservedTokens: 2_000,
        subscriptionId,
        entitlementPlan: "free",
        includedTokens: 0,
        serviceFeeRate: 0.25,
        quotaPeriodStart: now - 1_000,
        quotaPeriodEnd: now + 60_000,
        status: "pending",
        providerStartedAt: now - 1_000,
        settlementState: "staged",
        settlementTokens: 900,
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
    });
    // 4,000 tokens fit the wallet alone but not with the 2,000 still owed.
    await expect(
      t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        reservationArgs(fixture, "chat-over-owed"),
      ),
    ).resolves.toEqual({ allowed: false, reason: "limit_reached" });
  });
});
