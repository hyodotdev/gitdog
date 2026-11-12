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
