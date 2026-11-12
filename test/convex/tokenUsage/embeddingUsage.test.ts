import { convexTest } from "convex-test";
import { mutationWithTime } from "../scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { LEGACY_GOOGLE_MODELS } from "../../../convex/_ai/config";
import {
  assertCompleteUsageAggregation,
  MAX_TOKEN_USAGE_AGGREGATION_RECORDS,
} from "../../../convex/tokenUsage/query";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/tokenUsage/internalMutation.ts": () =>
    import("../../../convex/tokenUsage/internalMutation"),
  "../../../convex/_ai/embeddingBilling.ts": () =>
    import("../../../convex/_ai/embeddingBilling"),
  "../../../convex/admin/paymentMutation.ts": () =>
    import("../../../convex/admin/paymentMutation"),
  "../../../convex/admin/utils.ts": () => import("../../../convex/admin/utils"),
  "../../../convex/subscriptions/internalQuery.ts": () =>
    import("../../../convex/subscriptions/internalQuery"),
  "../../../convex/tokenUsage/query.ts": () =>
    import("../../../convex/tokenUsage/query"),
};

const originalSiteUrl = process.env.SITE_URL;

function attemptTokenFor(reservationKey: string, attempt = 1): string {
  return `${reservationKey}:attempt:${attempt}`;
}

beforeEach(() => {
  process.env.SITE_URL = "https://gitdog.dev";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalSiteUrl === undefined) {
    delete process.env.SITE_URL;
  } else {
    process.env.SITE_URL = originalSiteUrl;
  }
});

async function insertUserAndRepositories(
  t: ReturnType<typeof convexTest>,
): Promise<{
  userId: Id<"users">;
  firstRepositoryId: Id<"repositories">;
  secondRepositoryId: Id<"repositories">;
}> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    const insertRepository = async (
      name: string,
    ): Promise<Id<"repositories">> =>
      await ctx.db.insert("repositories", {
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
        githubRepositoryId: name === "first" ? 101 : 102,
        githubRepo: `owner/${name}`,
        githubRepoKey: `owner/${name}`,
        name,
        githubUrl: `https://github.com/owner/${name}`,
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

    return {
      userId,
      firstRepositoryId: await insertRepository("first"),
      secondRepositoryId: await insertRepository("second"),
    };
  });
}

async function reservePaidEmbeddingUsage(
  t: ReturnType<typeof convexTest>,
  args: {
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    reservationKey: string;
    inputCount?: number;
    providerTokenLimit?: number;
    provider?: "openai";
  },
): Promise<string> {
  const inputCount = args.inputCount ?? 32;
  const result = await t.mutation(
    internal._ai.embeddingBilling.reservePaidEmbeddingUsage,
    {
      reservationKey: args.reservationKey,
      attemptToken: attemptTokenFor(args.reservationKey),
      userId: args.userId,
      repositoryId: args.repositoryId,
      operation: "test embedding usage",
      inputCount,
      providerTokenLimit: args.providerTokenLimit ?? inputCount * 8_192,
      ...(args.provider
        ? { provider: args.provider, model: "text-embedding-3-small" }
        : {}),
    },
  );
  expect(result.allowed).toBe(true);
  return args.reservationKey;
}

async function finalizePaidEmbeddingUsage(
  t: ReturnType<typeof convexTest>,
  args: {
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    reservationKey: string;
    tokens?: number;
  },
): Promise<Id<"tokenUsage">> {
  const reservation = await t.run(async (ctx) =>
    ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .unique(),
  );
  if (
    reservation?.status === "pending" &&
    reservation.providerStartedAt === undefined &&
    reservation.expiresAt > Date.now()
  ) {
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        userId: args.userId,
        repositoryId: args.repositoryId,
        reservationKey: args.reservationKey,
        attemptToken: attemptTokenFor(args.reservationKey),
      },
    );
  }
  const usageId = await t.mutation(
    internal.tokenUsage.internalMutation.recordEmbeddingUsage,
    {
      userId: args.userId,
      repositoryId: args.repositoryId,
      tokens: args.tokens ?? 12,
      model: LEGACY_GOOGLE_MODELS.embeddingModelId,
      provider: "google",
      billingTier: "paid",
      reservationKey: args.reservationKey,
      reservationAttemptToken: attemptTokenFor(args.reservationKey),
    },
  );
  if (!usageId) {
    throw new Error("paid embedding usage was not recorded");
  }
  return usageId;
}

async function markPaidEmbeddingUsageAmbiguous(
  t: ReturnType<typeof convexTest>,
  args: {
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    reservationKey: string;
  },
): Promise<void> {
  await expect(
    t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        reservationKey: args.reservationKey,
        attemptToken: attemptTokenFor(args.reservationKey),
        userId: args.userId,
        repositoryId: args.repositoryId,
      },
    ),
  ).resolves.toEqual({ started: true, alreadyStarted: false });
  await expect(
    t.mutation(internal._ai.embeddingBilling.markEmbeddingUsageAmbiguous, {
      reservationKey: args.reservationKey,
      attemptToken: attemptTokenFor(args.reservationKey),
      userId: args.userId,
      repositoryId: args.repositoryId,
    }),
  ).resolves.toBe(true);
}

async function insertAdminUser(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const adminUserId = await ctx.db.insert("users", {});
    const now = Date.now();
    await ctx.db.insert("userProfiles", {
      userId: adminUserId,
      githubUsername: "billing-admin",
      isAdmin: true,
      createdAt: now,
      updatedAt: now,
    });
    return adminUserId;
  });
}

describe("AI embedding usage", () => {
  it("does not create token usage for zero-cost free embeddings", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    await t.mutation(
      internal.tokenUsage.internalMutation.recordEmbeddingUsage,
      {
        userId,
        repositoryId: firstRepositoryId,
        tokens: 100_000,
        model: LEGACY_GOOGLE_MODELS.embeddingModelId,
        provider: "google",
        billingTier: "free",
      },
    );

    const usage = await t.run(
      async (ctx) => await ctx.db.query("tokenUsage").take(1),
    );
    expect(usage).toHaveLength(0);
  });

  it("atomically releases a paid-fallback reservation for a free result", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "free-fallback-release",
      inputCount: 1,
      providerTokenLimit: 128,
    });
    await expect(
      t.mutation(internal.tokenUsage.internalMutation.recordEmbeddingUsage, {
        userId,
        repositoryId: firstRepositoryId,
        tokens: 12,
        model: LEGACY_GOOGLE_MODELS.embeddingModelId,
        provider: "google",
        billingTier: "free",
        reservationKey,
        reservationAttemptToken: attemptTokenFor(reservationKey),
      }),
    ).resolves.toBeNull();

    const state = await t.run(async (ctx) => ({
      usage: await ctx.db.query("tokenUsage").take(1),
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    }));
    expect(state.usage).toHaveLength(0);
    expect(state.reservation).toMatchObject({
      status: "released",
      releaseReason: "request_finished_without_paid_usage",
    });
  });

  it("records paid AI cost and cost-equivalent quota tokens", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "paid-cost",
    });

    const usageId = await finalizePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey,
      tokens: 100_000,
    });

    const usage = await t.run(async (ctx) => await ctx.db.get(usageId));
    expect(usage).toMatchObject({
      usageType: "embedding",
      embeddingTokens: 100_000,
      embeddingBillingTier: "paid",
      inputTokens: 20_000,
      outputTokens: 0,
      totalTokens: 20_000,
      outputCostCents: 0,
      model: LEGACY_GOOGLE_MODELS.embeddingModelId,
      provider: "google",
    });
    expect(usage?.inputCostCents).toBeCloseTo(2);
    expect(usage?.baseCostCents).toBeCloseTo(2);
    expect(usage?.serviceFeeCents).toBeCloseTo(0.5);
    expect(usage?.totalCostCents).toBeCloseTo(2.5);
  });

  it("stages and settles exact paid usage idempotently", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "staged-exact-usage",
      inputCount: 1,
      providerTokenLimit: 128,
    });
    const attemptToken = attemptTokenFor(reservationKey);
    await expect(
      t.mutation(
        internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
        {
          reservationKey,
          attemptToken,
          userId,
          repositoryId: firstRepositoryId,
        },
      ),
    ).resolves.toEqual({ started: true, alreadyStarted: false });
    const stageArgs = {
      reservationKey,
      attemptToken,
      userId,
      repositoryId: firstRepositoryId,
      tokens: 17,
    };
    await expect(
      t.mutation(
        internal._ai.embeddingBilling.stageEmbeddingProviderOutcome,
        stageArgs,
      ),
    ).resolves.toEqual({ staged: true, alreadySettled: false });
    await expect(
      t.mutation(
        internal._ai.embeddingBilling.stageEmbeddingProviderOutcome,
        stageArgs,
      ),
    ).resolves.toEqual({ staged: true, alreadySettled: false });

    await expect(
      t.mutation(internal._ai.embeddingBilling.settleStagedEmbeddingOutcome, {
        reservationKey,
        attemptToken,
        fromScheduler: false,
      }),
    ).resolves.toMatchObject({ status: "finalized" });
    await expect(
      t.mutation(internal._ai.embeddingBilling.settleStagedEmbeddingOutcome, {
        reservationKey,
        attemptToken,
        fromScheduler: false,
      }),
    ).resolves.toMatchObject({ status: "finalized" });

    const state = await t.run(async (ctx) => ({
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_embedding_reservation", (q) =>
          q.eq("embeddingReservationKey", reservationKey),
        )
        .take(2),
    }));
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      embeddingTokens: 17,
      embeddingReservationAttemptToken: attemptToken,
    });
    expect(state.reservation).toMatchObject({ status: "finalized" });
    expect(state.reservation?.settlementState).toBeUndefined();
    expect(state.reservation?.settlementScheduleId).toBeUndefined();
  });

  it("preserves an exact staged outcome after its reservation TTL", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "staged-after-ttl",
      inputCount: 1,
      providerTokenLimit: 128,
    });
    const attemptToken = attemptTokenFor(reservationKey);
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        reservationKey,
        attemptToken,
        userId,
        repositoryId: firstRepositoryId,
      },
    );
    await t.mutation(
      internal._ai.embeddingBilling.stageEmbeddingProviderOutcome,
      {
        reservationKey,
        attemptToken,
        userId,
        repositoryId: firstRepositoryId,
        tokens: 17,
      },
    );
    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique();
      if (!reservation) throw new Error("embedding reservation missing");
      await ctx.db.patch(reservation._id, { expiresAt: Date.now() - 1 });
    });

    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey,
        attemptToken: `${reservationKey}:attempt:2`,
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 128,
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "provider_already_started",
    });
    const staged = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    );
    expect(staged).toMatchObject({
      status: "pending",
      settlementState: "staged",
      settlementTokens: 17,
    });

    await expect(
      t.mutation(internal._ai.embeddingBilling.settleStagedEmbeddingOutcome, {
        reservationKey,
        attemptToken,
        fromScheduler: false,
      }),
    ).resolves.toMatchObject({ status: "finalized" });
    const usages = await t.run(async (ctx) =>
      ctx.db
        .query("tokenUsage")
        .withIndex("by_embedding_reservation", (q) =>
          q.eq("embeddingReservationKey", reservationKey),
        )
        .collect(),
    );
    expect(usages).toHaveLength(1);
    expect(usages[0]?.embeddingTokens).toBe(17);
  });

  it("does not let a production hostname containing localhost bypass embedding quota", async () => {
    process.env.SITE_URL = "https://notlocalhost.example";
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);

    const results = await Promise.all(
      ["concurrent-first", "concurrent-second"].map(
        async (reservationKey) =>
          await t.mutation(
            internal._ai.embeddingBilling.reservePaidEmbeddingUsage,
            {
              reservationKey,
              attemptToken: attemptTokenFor(reservationKey),
              userId,
              repositoryId: firstRepositoryId,
              operation: "test embedding usage",
              inputCount: 32,
              providerTokenLimit: 250_001,
            },
          ),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toEqual([
      { allowed: false, reason: "limit_reached" },
    ]);
    const pendingReservations = await t.run(
      async (ctx) =>
        await ctx.db
          .query("embeddingUsageReservations")
          .withIndex("by_user_and_status", (q) =>
            q.eq("userId", userId).eq("status", "pending"),
          )
          .take(3),
    );
    expect(pendingReservations).toHaveLength(1);
  });

  it("does not let an untrusted Pro row bypass paid embedding quota", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const now = Date.now();
    const subscriptionId = await t.run(async (ctx) => {
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId,
        usageType: "chat",
        inputTokens: 100_000,
        outputTokens: 0,
        totalTokens: 100_000,
        inputCostCents: 0,
        outputCostCents: 0,
        baseCostCents: 0,
        serviceFeeCents: 0,
        totalCostCents: 0,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        serviceFeeRate: 0.25,
        createdAt: now,
      });
      return await ctx.db.insert("subscriptions", {
        userId,
        plan: "pro",
        status: "active",
        includedTokens: 2_400_000,
        serviceFeeRate: 0.18,
        purchasedTokens: 0,
        periodStart: now - 1_000,
        periodEnd: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "untrusted-forged-pro",
        attemptToken: attemptTokenFor("untrusted-forged-pro"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 1,
      }),
    ).resolves.toEqual({ allowed: false, reason: "limit_reached" });

    await t.run(async (ctx) => {
      await ctx.db.patch(subscriptionId, {
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: Date.now(),
        },
      });
    });
    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "verified-pro",
        attemptToken: attemptTokenFor("verified-pro"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 1,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("allows the exact trusted Pro prepaid boundary and rejects the next embedding", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const now = Date.now();
    const subscriptionId = await t.run(async (ctx) => {
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId,
        repositoryId: firstRepositoryId,
        usageType: "chat",
        inputTokens: 2_399_980,
        outputTokens: 0,
        totalTokens: 2_399_980,
        inputCostCents: 0,
        outputCostCents: 0,
        baseCostCents: 0,
        serviceFeeCents: 0,
        totalCostCents: 0,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        serviceFeeRate: 0.18,
        createdAt: now,
      });
      return await ctx.db.insert("subscriptions", {
        userId,
        plan: "pro",
        status: "active",
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now,
        },
        includedTokens: 2_400_000,
        purchasedTokens: 0,
        serviceFeeRate: 0.18,
        periodStart: now - 1_000,
        periodEnd: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "verified-pro-exact-limit",
        attemptToken: attemptTokenFor("verified-pro-exact-limit"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "exact prepaid boundary regression",
        inputCount: 1,
        providerTokenLimit: 100,
      }),
    ).resolves.toEqual({
      allowed: true,
      reservationKey: "verified-pro-exact-limit",
    });
    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "verified-pro-over-limit",
        attemptToken: attemptTokenFor("verified-pro-over-limit"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "exact prepaid boundary regression",
        inputCount: 1,
        providerTokenLimit: 1,
      }),
    ).resolves.toEqual({ allowed: false, reason: "limit_reached" });

    const state = await t.run(async (ctx) => ({
      subscription: await ctx.db.get(subscriptionId),
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", "verified-pro-exact-limit"),
        )
        .unique(),
    }));
    expect(state.subscription?.purchasedTokens).toBe(0);
    expect(state.reservation).toMatchObject({
      status: "pending",
      reservedTokens: 20,
    });
  });

  it("blocks verified Pro usage while a provider-started attempt is in progress", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId,
        plan: "pro",
        status: "active",
        includedTokens: 2_400_000,
        purchasedTokens: 0,
        serviceFeeRate: 0.18,
        periodStart: now - 1_000,
        periodEnd: now + 60_000,
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      });
    });
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "pro-ambiguous-provider-usage",
      inputCount: 1,
      providerTokenLimit: 128,
      provider: "openai",
    });
    await expect(
      t.mutation(
        internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
        {
          reservationKey,
          attemptToken: attemptTokenFor(reservationKey),
          userId,
          repositoryId: firstRepositoryId,
        },
      ),
    ).resolves.toEqual({ started: true, alreadyStarted: false });

    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "pro-follow-up-provider-usage",
        attemptToken: attemptTokenFor("pro-follow-up-provider-usage"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 128,
        provider: "openai",
        model: "text-embedding-3-small",
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "provider_attempt_in_progress",
    });

    await expect(
      t.mutation(internal._ai.embeddingBilling.markEmbeddingUsageAmbiguous, {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey),
        userId,
        repositoryId: firstRepositoryId,
      }),
    ).resolves.toBe(true);
    process.env.SITE_URL = "http://localhost:5173";
    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "pro-follow-up-after-ambiguity",
        attemptToken: attemptTokenFor("pro-follow-up-after-ambiguity"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 128,
        provider: "openai",
        model: "text-embedding-3-small",
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "unresolved_provider_usage",
    });
  });

  it("lets only an admin release ambiguity from exact not-billed evidence", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "reconcile-not-billed",
      inputCount: 1,
      providerTokenLimit: 128,
    });
    await expect(
      t.mutation(
        internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
        {
          reservationKey,
          attemptToken: attemptTokenFor(reservationKey),
          userId,
          repositoryId: firstRepositoryId,
        },
      ),
    ).resolves.toEqual({ started: true, alreadyStarted: false });

    const user = t.withIdentity({ subject: `${userId}|user-session` });
    await expect(
      user.mutation(api.admin.paymentMutation.reconcileEmbeddingUsage, {
        reservationKey,
        evidenceSource: "google_support_confirmation",
        evidenceReference: "support-case-123",
        outcome: { kind: "known_not_billed" },
      }),
    ).rejects.toThrow("Admin access required");

    const adminUserId = await insertAdminUser(t);
    const admin = t.withIdentity({
      subject: `${adminUserId}|admin-session`,
    });
    const reconciliation = {
      reservationKey,
      evidenceSource: "google_support_confirmation" as const,
      evidenceReference: "support-case-123",
      outcome: { kind: "known_not_billed" as const },
    };
    await expect(
      admin.mutation(
        api.admin.paymentMutation.reconcileEmbeddingUsage,
        reconciliation,
      ),
    ).rejects.toThrow("Only unresolved provider-started embedding usage");
    await expect(
      t.mutation(internal._ai.embeddingBilling.markEmbeddingUsageAmbiguous, {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey),
        userId,
        repositoryId: firstRepositoryId,
      }),
    ).resolves.toBe(true);
    await expect(
      admin.mutation(
        api.admin.paymentMutation.reconcileEmbeddingUsage,
        reconciliation,
      ),
    ).resolves.toEqual({ status: "released" });
    await expect(
      admin.mutation(
        api.admin.paymentMutation.reconcileEmbeddingUsage,
        reconciliation,
      ),
    ).resolves.toEqual({ status: "released" });
    await expect(
      admin.mutation(api.admin.paymentMutation.reconcileEmbeddingUsage, {
        ...reconciliation,
        evidenceReference: "support-case-456",
      }),
    ).rejects.toThrow("already reconciled");

    const state = await t.run(async (ctx) => ({
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_embedding_reservation", (q) =>
          q.eq("embeddingReservationKey", reservationKey),
        )
        .take(2),
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    }));
    expect(state.usage).toHaveLength(0);
    expect(state.reservation).toMatchObject({
      status: "released",
      releaseReason: "provider_reconciliation_not_billed",
      reconciliation: {
        outcome: "known_not_billed",
        evidenceSource: "google_support_confirmation",
        evidenceReference: "support-case-123",
        reconciledBy: adminUserId,
      },
    });

    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "usage-after-not-billed-reconciliation",
        attemptToken: attemptTokenFor("usage-after-not-billed-reconciliation"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 128,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("records exact billed reconciliation once and rejects conflicting evidence", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "reconcile-known-billed",
      inputCount: 1,
      providerTokenLimit: 128,
    });
    await markPaidEmbeddingUsageAmbiguous(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey,
    });
    const adminUserId = await insertAdminUser(t);
    const admin = t.withIdentity({
      subject: `${adminUserId}|admin-session`,
    });
    const mutationArgs = {
      reservationKey,
      evidenceSource: "google_cloud_billing_export" as const,
      evidenceReference: "billing-export-row-987",
      outcome: { kind: "known_billed" as const, actualProviderTokens: 12 },
    };

    await expect(
      admin.mutation(api.admin.paymentMutation.reconcileEmbeddingUsage, {
        ...mutationArgs,
        outcome: { kind: "known_billed", actualProviderTokens: 0 },
      }),
    ).rejects.toThrow("positive and within the reserved input limit");
    await expect(
      admin.mutation(api.admin.paymentMutation.reconcileEmbeddingUsage, {
        ...mutationArgs,
        outcome: { kind: "known_billed", actualProviderTokens: 129 },
      }),
    ).rejects.toThrow("positive and within the reserved input limit");

    const first = await admin.mutation(
      api.admin.paymentMutation.reconcileEmbeddingUsage,
      mutationArgs,
    );
    expect(first).toMatchObject({ status: "finalized" });
    await expect(
      admin.mutation(
        api.admin.paymentMutation.reconcileEmbeddingUsage,
        mutationArgs,
      ),
    ).resolves.toEqual(first);
    await expect(
      admin.mutation(api.admin.paymentMutation.reconcileEmbeddingUsage, {
        ...mutationArgs,
        evidenceSource: "google_api_response",
      }),
    ).rejects.toThrow("already reconciled");

    const state = await t.run(async (ctx) => ({
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_embedding_reservation", (q) =>
          q.eq("embeddingReservationKey", reservationKey),
        )
        .take(2),
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    }));
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      embeddingTokens: 12,
      embeddingBillingTier: "paid",
      model: LEGACY_GOOGLE_MODELS.embeddingModelId,
      provider: "google",
    });
    expect(state.reservation).toMatchObject({
      status: "finalized",
      usageId: state.usage[0]?._id,
      reconciliation: {
        outcome: "known_billed",
        evidenceSource: "google_cloud_billing_export",
        evidenceReference: "billing-export-row-987",
        actualProviderTokens: 12,
        reconciledBy: adminUserId,
      },
    });
  });

  it("atomically assigns one owner when the same deterministic key races", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = "same-key-race";
    const attemptTokens = [
      attemptTokenFor(reservationKey, 1),
      attemptTokenFor(reservationKey, 2),
    ];

    const results = await Promise.all(
      attemptTokens.map(
        async (attemptToken) =>
          await t.mutation(
            internal._ai.embeddingBilling.reservePaidEmbeddingUsage,
            {
              reservationKey,
              attemptToken,
              userId,
              repositoryId: firstRepositoryId,
              operation: "test embedding usage",
              inputCount: 1,
              providerTokenLimit: 1_024,
            },
          ),
      ),
    );
    const ownerIndex = results.findIndex((result) => result.allowed);
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toEqual([
      { allowed: false, reason: "attempt_in_progress" },
    ]);
    const ownerToken = attemptTokens[ownerIndex]!;
    const competingToken = attemptTokens[ownerIndex === 0 ? 1 : 0]!;

    await expect(
      t.mutation(
        internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
        {
          reservationKey,
          attemptToken: ownerToken,
          userId,
          repositoryId: firstRepositoryId,
        },
      ),
    ).resolves.toEqual({ started: true, alreadyStarted: false });
    await expect(
      t.mutation(internal._ai.embeddingBilling.releasePaidEmbeddingUsage, {
        reservationKey,
        attemptToken: competingToken,
        userId,
        repositoryId: firstRepositoryId,
        confirmedNotBilled: true,
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal.tokenUsage.internalMutation.recordEmbeddingUsage, {
        userId,
        repositoryId: firstRepositoryId,
        tokens: 12,
        model: LEGACY_GOOGLE_MODELS.embeddingModelId,
        provider: "google",
        billingTier: "paid",
        reservationKey,
        reservationAttemptToken: competingToken,
      }),
    ).rejects.toThrow("embedding usage reservation is not finalizable");

    const reservation = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    );
    expect(reservation).toMatchObject({
      attemptToken: ownerToken,
      status: "pending",
    });
    expect(reservation?.providerStartedAt).toBeTypeOf("number");
  });

  it("rejects finalization for released and expired reservations", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);

    const releasedKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "released-finalize",
      inputCount: 1,
    });
    await expect(
      t.mutation(internal._ai.embeddingBilling.releasePaidEmbeddingUsage, {
        reservationKey: releasedKey,
        attemptToken: attemptTokenFor(releasedKey),
        userId,
        repositoryId: firstRepositoryId,
        confirmedNotBilled: false,
      }),
    ).resolves.toBe(true);
    await expect(
      finalizePaidEmbeddingUsage(t, {
        userId,
        repositoryId: firstRepositoryId,
        reservationKey: releasedKey,
      }),
    ).rejects.toThrow("embedding usage reservation is not finalizable");

    const expiredKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "expired-finalize",
      inputCount: 1,
    });
    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", expiredKey),
        )
        .unique();
      expect(reservation).not.toBeNull();
      await ctx.db.patch(reservation!._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      finalizePaidEmbeddingUsage(t, {
        userId,
        repositoryId: firstRepositoryId,
        reservationKey: expiredKey,
      }),
    ).rejects.toThrow("embedding usage reservation is not finalizable");

    const usageRecords = await t.run(
      async (ctx) => await ctx.db.query("tokenUsage").take(1),
    );
    expect(usageRecords).toHaveLength(0);
  });

  it("releases a reservation instead of starting paid work after its quota period", async () => {
    let now = Date.parse("2026-07-31T23:59:59.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "embedding-period-boundary",
      inputCount: 1,
      providerTokenLimit: 128,
    });
    now = Date.parse("2026-08-01T00:00:00.000Z");
    await expect(
      t.mutation(
        internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
        {
          reservationKey,
          attemptToken: attemptTokenFor(reservationKey),
          userId,
          repositoryId: firstRepositoryId,
        },
      ),
    ).resolves.toEqual({ started: false, reason: "reservation_closed" });
    const reservation = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    );
    expect(reservation).toMatchObject({
      status: "released",
      releaseReason: "entitlement_period_ended",
    });
    expect(reservation?.providerStartedAt).toBeUndefined();

    const renewed = await mutationWithTime(
      t,
      internal._ai.embeddingBilling.reservePaidEmbeddingUsage,
      {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey, 2),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 128,
      },
    );
    expect(renewed.result).toEqual({ allowed: true, reservationKey });
    expect(renewed.now).toBeGreaterThanOrEqual(now);
    const reopened = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    );
    expect(reopened).toMatchObject({
      attemptToken: attemptTokenFor(reservationKey, 2),
      status: "pending",
      quotaPeriodStart: Date.parse("2026-08-01T00:00:00.000Z"),
      quotaPeriodEnd: Date.parse("2026-09-01T00:00:00.000Z"),
      createdAt: renewed.now,
    });
    expect(reopened?.releaseReason).toBeUndefined();
    expect(reopened?.providerStartedAt).toBeUndefined();
  });

  it("rejects oversized paid provider usage and keeps it reconcilable", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "oversized-paid-usage",
      inputCount: 1,
      providerTokenLimit: 128,
    });
    await expect(
      t.mutation(
        internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
        {
          reservationKey,
          attemptToken: attemptTokenFor(reservationKey),
          userId,
          repositoryId: firstRepositoryId,
        },
      ),
    ).resolves.toEqual({ started: true, alreadyStarted: false });
    await expect(
      t.mutation(internal.tokenUsage.internalMutation.recordEmbeddingUsage, {
        userId,
        repositoryId: firstRepositoryId,
        tokens: 129,
        model: LEGACY_GOOGLE_MODELS.embeddingModelId,
        provider: "google",
        billingTier: "paid",
        reservationKey,
        reservationAttemptToken: attemptTokenFor(reservationKey),
      }),
    ).rejects.toThrow("embedding usage reservation is not finalizable");
    await expect(
      t.mutation(internal._ai.embeddingBilling.markEmbeddingUsageAmbiguous, {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey),
        userId,
        repositoryId: firstRepositoryId,
      }),
    ).resolves.toBe(true);
    const state = await t.run(async (ctx) => ({
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_embedding_reservation", (q) =>
          q.eq("embeddingReservationKey", reservationKey),
        )
        .collect(),
    }));
    expect(state.reservation).toMatchObject({ status: "ambiguous" });
    expect(state.usage).toEqual([]);
  });

  it("reopens a safely released reservation without reusing its start marker", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "safe-retry",
      inputCount: 1,
      providerTokenLimit: 1_024,
    });
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey),
        userId,
        repositoryId: firstRepositoryId,
      },
    );
    await t.mutation(internal._ai.embeddingBilling.releasePaidEmbeddingUsage, {
      reservationKey,
      attemptToken: attemptTokenFor(reservationKey),
      userId,
      repositoryId: firstRepositoryId,
      confirmedNotBilled: true,
    });

    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey, 2),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 1_024,
      }),
    ).resolves.toEqual({ allowed: true, reservationKey });

    const reservation = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    );
    expect(reservation?.status).toBe("pending");
    expect(reservation?.releaseReason).toBeUndefined();
    expect(reservation?.providerStartedAt).toBeUndefined();
  });

  it("indexes a safely reopened attempt in its new quota period", async () => {
    let now = Date.parse("2026-07-31T23:59:50.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "cross-period-safe-retry",
      inputCount: 1,
      providerTokenLimit: 8_192,
      provider: "openai",
    });
    const firstCreatedAt = await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique();
      return reservation!.createdAt;
    });
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey),
        userId,
        repositoryId: firstRepositoryId,
      },
    );
    await t.mutation(internal._ai.embeddingBilling.releasePaidEmbeddingUsage, {
      reservationKey,
      attemptToken: attemptTokenFor(reservationKey),
      userId,
      repositoryId: firstRepositoryId,
      confirmedNotBilled: true,
    });

    now += 20_000;
    const reopenedAt = now;
    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey, 2),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 8_192,
        provider: "openai",
        model: "text-embedding-3-small",
      }),
    ).resolves.toEqual({ allowed: true, reservationKey });
    const reopened = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    );
    expect(reopened?.createdAt).toBe(reopenedAt);
    expect(reopened!.createdAt).toBeGreaterThan(firstCreatedAt);

    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey, 2),
        userId,
        repositoryId: firstRepositoryId,
      },
    );
    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique();
      await ctx.db.patch(reservation!._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      t.mutation(
        internal._ai.embeddingBilling.cleanupEmbeddingUsageReservations,
        {},
      ),
    ).resolves.toMatchObject({ expired: 1 });

    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId,
        repositoryId: firstRepositoryId,
        usageType: "chat",
        inputTokens: 97_000,
        outputTokens: 0,
        totalTokens: 97_000,
        inputCostCents: 9.7,
        outputCostCents: 0,
        baseCostCents: 9.7,
        serviceFeeCents: 2.425,
        totalCostCents: 12.125,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        provider: "google",
        serviceFeeRate: 0.25,
        createdAt: now,
      });
    });
    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "new-key-after-cross-period-ambiguity",
        attemptToken: attemptTokenFor("new-key-after-cross-period-ambiguity"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 8_192,
        provider: "openai",
        model: "text-embedding-3-small",
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "unresolved_provider_usage",
    });

    const ambiguous = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    );
    expect(ambiguous).toMatchObject({
      status: "ambiguous",
      createdAt: reopenedAt,
    });
  });

  it.each(["released", "expired"] as const)(
    "rechecks current quota before reopening a safely %s reservation",
    async (state) => {
      const t = convexTest(schema, modules);
      const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
      const reservationKey = await reservePaidEmbeddingUsage(t, {
        userId,
        repositoryId: firstRepositoryId,
        reservationKey: `quota-recheck-${state}`,
        inputCount: 1,
        providerTokenLimit: 8_192,
      });

      if (state === "released") {
        await t.mutation(
          internal._ai.embeddingBilling.releasePaidEmbeddingUsage,
          {
            reservationKey,
            attemptToken: attemptTokenFor(reservationKey),
            userId,
            repositoryId: firstRepositoryId,
            confirmedNotBilled: false,
          },
        );
      } else {
        await t.run(async (ctx) => {
          const reservation = await ctx.db
            .query("embeddingUsageReservations")
            .withIndex("by_reservation_key", (q) =>
              q.eq("reservationKey", reservationKey),
            )
            .unique();
          await ctx.db.patch(reservation!._id, { expiresAt: Date.now() - 1 });
        });
      }

      await t.run(async (ctx) => {
        const now = Date.now();
        await ctx.db.insert("tokenUsage", {
          purchasedTokensDebited: 0,
          userId,
          repositoryId: firstRepositoryId,
          usageType: "chat",
          inputTokens: 100_000,
          outputTokens: 0,
          totalTokens: 100_000,
          inputCostCents: 10,
          outputCostCents: 0,
          baseCostCents: 10,
          serviceFeeCents: 2.5,
          totalCostCents: 12.5,
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          serviceFeeRate: 0.25,
          createdAt: now,
        });
      });

      await expect(
        t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
          reservationKey,
          attemptToken: attemptTokenFor(reservationKey, 2),
          userId,
          repositoryId: firstRepositoryId,
          operation: "test embedding usage",
          inputCount: 1,
          providerTokenLimit: 8_192,
        }),
      ).resolves.toEqual({ allowed: false, reason: "limit_reached" });

      const reservation = await t.run(async (ctx) =>
        ctx.db
          .query("embeddingUsageReservations")
          .withIndex("by_reservation_key", (q) =>
            q.eq("reservationKey", reservationKey),
          )
          .unique(),
      );
      expect(reservation?.status).toBe("released");
    },
  );

  it("makes identical finalization idempotent and rejects payload changes", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "idempotent-finalize",
      inputCount: 1,
    });

    const firstUsageId = await finalizePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey,
    });
    await expect(
      finalizePaidEmbeddingUsage(t, {
        userId,
        repositoryId: firstRepositoryId,
        reservationKey,
      }),
    ).resolves.toBe(firstUsageId);
    await expect(
      finalizePaidEmbeddingUsage(t, {
        userId,
        repositoryId: firstRepositoryId,
        reservationKey,
        tokens: 13,
      }),
    ).rejects.toThrow("embedding usage reservation identity mismatch");

    const usageRecords = await t.run(
      async (ctx) => await ctx.db.query("tokenUsage").take(2),
    );
    expect(usageRecords).toHaveLength(1);
  });

  it("keeps late paid usage detached after its repository was deleted", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "deleted-repository-finalize",
      inputCount: 1,
    });

    await t.run(async (ctx) => await ctx.db.delete(firstRepositoryId));
    const usageId = await finalizePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey,
    });

    const state = await t.run(async (ctx) => ({
      usage: await ctx.db.get(usageId),
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    }));
    expect(state.usage?.repositoryId).toBeUndefined();
    expect(state.reservation?.repositoryId).toBe(firstRepositoryId);
    await expect(
      finalizePaidEmbeddingUsage(t, {
        userId,
        repositoryId: firstRepositoryId,
        reservationKey,
      }),
    ).resolves.toBe(usageId);
  });

  it("keeps finalized reservation keys consumed after reservation cleanup", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "cleaned-finalize",
      inputCount: 1,
    });
    const usageId = await finalizePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey,
    });

    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique();
      expect(reservation?.status).toBe("finalized");
      await ctx.db.patch(reservation!._id, {
        expiresAt: Date.now() - 25 * 60 * 60 * 1_000,
      });
    });
    await expect(
      t.mutation(
        internal._ai.embeddingBilling.cleanupEmbeddingUsageReservations,
        {},
      ),
    ).resolves.toMatchObject({ deleted: 1 });

    const persistedState = await t.run(async (ctx) => ({
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
      usage: await ctx.db.get(usageId),
    }));
    expect(persistedState.reservation).toBeNull();
    expect(persistedState.usage?.embeddingReservationKey).toBe(reservationKey);
    await expect(
      finalizePaidEmbeddingUsage(t, {
        userId,
        repositoryId: firstRepositoryId,
        reservationKey,
      }),
    ).resolves.toBe(usageId);
    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey, 2),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 8_192,
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "reservation_finalized",
    });
  });

  it("keeps provider-started expiration ambiguity as a durable tombstone", async () => {
    let now = Date.parse("2026-07-19T02:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "ambiguous-expiration",
      inputCount: 1,
    });
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey),
        userId,
        repositoryId: firstRepositoryId,
      },
    );
    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique();
      await ctx.db.patch(reservation!._id, {
        expiresAt: Date.now() - 25 * 60 * 60 * 1_000,
      });
    });

    await expect(
      t.mutation(
        internal._ai.embeddingBilling.cleanupEmbeddingUsageReservations,
        {},
      ),
    ).resolves.toMatchObject({ expired: 1, deleted: 0 });
    now += 7 * 24 * 60 * 60 * 1_000;
    await t.mutation(
      internal._ai.embeddingBilling.cleanupEmbeddingUsageReservations,
      {},
    );

    const reservation = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
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
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey, 2),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 8_192,
      }),
    ).resolves.toEqual({ allowed: false, reason: "reservation_closed" });
  });

  it("holds ambiguous provider usage against the hard quota", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "ambiguous-quota-hold",
      inputCount: 1,
      providerTokenLimit: 8_192,
      provider: "openai",
    });
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        reservationKey,
        attemptToken: attemptTokenFor(reservationKey),
        userId,
        repositoryId: firstRepositoryId,
      },
    );
    await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique();
      await ctx.db.patch(reservation!._id, { expiresAt: Date.now() - 1 });
      const now = Date.now();
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId,
        repositoryId: firstRepositoryId,
        usageType: "chat",
        inputTokens: 97_000,
        outputTokens: 0,
        totalTokens: 97_000,
        inputCostCents: 9.7,
        outputCostCents: 0,
        baseCostCents: 9.7,
        serviceFeeCents: 2.425,
        totalCostCents: 12.125,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        provider: "google",
        serviceFeeRate: 0.25,
        createdAt: now,
      });
    });

    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "new-key-after-ambiguous-attempt",
        attemptToken: attemptTokenFor("new-key-after-ambiguous-attempt"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "test embedding usage",
        inputCount: 1,
        providerTokenLimit: 8_192,
        provider: "openai",
        model: "text-embedding-3-small",
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "unresolved_provider_usage",
    });

    const ambiguous = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", reservationKey),
        )
        .unique(),
    );
    expect(ambiguous?.status).toBe("ambiguous");
  });

  it.each(["chat", "embedding"] as const)(
    "does not start a reserved embedding after new %s ambiguity appears",
    async (source) => {
      const t = convexTest(schema, modules);
      const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
      const reservationKey = await reservePaidEmbeddingUsage(t, {
        userId,
        repositoryId: firstRepositoryId,
        reservationKey: `start-after-${source}-ambiguity`,
        inputCount: 1,
        providerTokenLimit: 128,
      });
      const now = Date.now();
      await t.run(async (ctx) => {
        if (source === "embedding") {
          await ctx.db.insert("embeddingUsageReservations", {
            entitlementPlan: "free",
            includedTokens: 100_000,
            serviceFeeRate: 0.25,
            quotaPeriodStart: 0,
            quotaPeriodEnd: Number.MAX_SAFE_INTEGER,
            reservationKey: "new-embedding-ambiguity",
            attemptToken: "new-embedding-ambiguity:attempt:1",
            userId,
            repositoryId: firstRepositoryId,
            operation: "RAG index",
            inputCount: 1,
            providerTokenLimit: 128,
            provider: "openai",
            model: "text-embedding-3-small",
            reservedTokens: 26,
            status: "ambiguous",
            releaseReason: "ambiguous_provider_attempt",
            providerStartedAt: now - 1,
            expiresAt: now + 60_000,
            createdAt: now - 1,
            updatedAt: now,
          });
          return;
        }

        const ticketId = await ctx.db.insert("tickets", {
          aiInputVersion: 1,
          repositoryId: firstRepositoryId,
          userId,
          githubRepo: "owner/first",
          ticketType: "issue",
          githubNumber: 42,
          githubTitle: "Issue",
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
        await ctx.db.insert("chatUsageReservations", {
          reservationKey: "new-chat-ambiguity",
          attemptToken: "new-chat-ambiguity:attempt:1",
          userId,
          repositoryId: firstRepositoryId,
          ticketActionId,
          requirePendingTicketAction: true,
          ticketActionProposalVersion: 0,
          generationKey: "new-chat-ambiguity",
          operation: "test-chat",
          model: "claude-sonnet-5-5",
          provider: "anthropic",
          requestFingerprint: "4".repeat(64),
          inputTokenLimit: 100,
          outputTokenLimit: 100,
          reservedTokens: 200,
          entitlementPlan: "free",
          includedTokens: 100_000,
          serviceFeeRate: 0.25,
          quotaPeriodStart: now - 1_000,
          quotaPeriodEnd: now + 60_000,
          status: "ambiguous",
          releaseReason: "ambiguous_provider_attempt",
          providerStartedAt: now - 1,
          expiresAt: now + 60_000,
          createdAt: now - 1,
          updatedAt: now,
        });
      });

      await expect(
        t.mutation(
          internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
          {
            reservationKey,
            attemptToken: attemptTokenFor(reservationKey),
            userId,
            repositoryId: firstRepositoryId,
          },
        ),
      ).resolves.toEqual({
        started: false,
        reason: "provider_attempt_in_progress",
      });
      const reservation = await t.run(async (ctx) =>
        ctx.db
          .query("embeddingUsageReservations")
          .withIndex("by_reservation_key", (q) =>
            q.eq("reservationKey", reservationKey),
          )
          .unique(),
      );
      expect(reservation?.status).toBe("pending");
      expect(reservation?.providerStartedAt).toBeUndefined();
    },
  );

  it("reserves a short 32-input payload near quota and rejects true excess", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("tokenUsage", {
        purchasedTokensDebited: 0,
        userId,
        repositoryId: firstRepositoryId,
        usageType: "chat",
        inputTokens: 99_900,
        outputTokens: 0,
        totalTokens: 99_900,
        inputCostCents: 9.99,
        outputCostCents: 0,
        baseCostCents: 9.99,
        serviceFeeCents: 2.4975,
        totalCostCents: 12.4875,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        serviceFeeRate: 0.25,
        createdAt: now,
      });
    });

    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "short-near-limit",
        attemptToken: attemptTokenFor("short-near-limit"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "RAG index",
        inputCount: 32,
        providerTokenLimit: 400,
      }),
    ).resolves.toMatchObject({ allowed: true });

    const shortReservation = await t.run(async (ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", "short-near-limit"),
        )
        .unique(),
    );
    expect(shortReservation).toMatchObject({
      inputCount: 32,
      providerTokenLimit: 400,
      reservedTokens: 80,
    });
    await t.mutation(internal._ai.embeddingBilling.releasePaidEmbeddingUsage, {
      reservationKey: "short-near-limit",
      attemptToken: attemptTokenFor("short-near-limit"),
      userId,
      repositoryId: firstRepositoryId,
      confirmedNotBilled: false,
    });

    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        reservationKey: "true-excess",
        attemptToken: attemptTokenFor("true-excess"),
        userId,
        repositoryId: firstRepositoryId,
        operation: "RAG index",
        inputCount: 32,
        providerTokenLimit: 501,
      }),
    ).resolves.toEqual({ allowed: false, reason: "limit_reached" });
  });

  it("drains reservation cleanup backlog through bounded continuations", async () => {
    const now = Date.parse("2026-07-19T02:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const reservationCount = 205;
    await t.run(async (ctx) => {
      for (let index = 0; index < reservationCount; index++) {
        await ctx.db.insert("embeddingUsageReservations", {
          attemptToken: "fixture-attempt",
          entitlementPlan: "free",
          includedTokens: 100_000,
          serviceFeeRate: 0.25,
          quotaPeriodStart: 0,
          quotaPeriodEnd: Number.MAX_SAFE_INTEGER,
          reservationKey: `cleanup-${index}`,
          userId,
          repositoryId: firstRepositoryId,
          operation: "RAG search",
          inputCount: 1,
          providerTokenLimit: 32,
          reservedTokens: 7,
          status: "released",
          releaseReason: "request_finished_without_paid_usage",
          expiresAt: now - 25 * 60 * 60 * 1_000,
          createdAt: now - 26 * 60 * 60 * 1_000,
          updatedAt: now - 25 * 60 * 60 * 1_000,
        });
      }
    });

    await expect(
      t.mutation(
        internal._ai.embeddingBilling.cleanupEmbeddingUsageReservations,
        {},
      ),
    ).resolves.toMatchObject({ deleted: 100 });

    const scheduledContinuations = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (scheduled) =>
          scheduled.name ===
          "_ai/embeddingBilling:cleanupEmbeddingUsageReservations",
      ),
    );
    expect(scheduledContinuations).toHaveLength(1);

    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await t.finishInProgressScheduledFunctions();
    }
    const remaining = await t.run(
      async (ctx) => await ctx.db.query("embeddingUsageReservations").take(1),
    );
    expect(remaining).toHaveLength(0);
  });

  it("preserves fractional paid cost with the Pro service fee", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId,
        plan: "pro",
        status: "active",
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: now,
        },
        includedTokens: 2_400_000,
        purchasedTokens: 0,
        serviceFeeRate: 0.18,
        periodStart: now - 1_000,
        periodEnd: now + 1_000,
        createdAt: now,
        updatedAt: now,
      });
    });
    const reservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey: "pro-fractional-cost",
    });

    const usageId = await finalizePaidEmbeddingUsage(t, {
      userId,
      repositoryId: firstRepositoryId,
      reservationKey,
      tokens: 1,
    });

    const usage = await t.run(async (ctx) => await ctx.db.get(usageId));
    expect(usage?.serviceFeeRate).toBe(0.18);
    expect(usage?.inputTokens).toBe(1);
    expect(usage?.inputCostCents).toBeCloseTo(0.00002, 10);
    expect(usage?.serviceFeeCents).toBeCloseTo(0.0000036, 10);
    expect(usage?.totalCostCents).toBeCloseTo(0.0000236, 10);
  });

  it.each(["expired", "canceled"] as const)(
    "uses the free service fee for an invalid %s Pro subscription",
    async (status) => {
      const t = convexTest(schema, modules);
      const { userId, firstRepositoryId } = await insertUserAndRepositories(t);
      const now = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert("subscriptions", {
          userId,
          plan: "pro",
          status,
          proEntitlementProvenance: {
            source: "lemon_squeezy_webhook",
            verifiedAt: now,
          },
          includedTokens: 2_400_000,
          purchasedTokens: 0,
          serviceFeeRate: 0.18,
          periodStart: now - 2_000,
          periodEnd: now - 1_000,
          createdAt: now,
          updatedAt: now,
        });
      });
      const reservationKey = await reservePaidEmbeddingUsage(t, {
        userId,
        repositoryId: firstRepositoryId,
        reservationKey: `${status}-pro-fee`,
        inputCount: 1,
      });

      const usageId = await finalizePaidEmbeddingUsage(t, {
        userId,
        repositoryId: firstRepositoryId,
        reservationKey,
        tokens: 1,
      });
      const usage = await t.run(async (ctx) => await ctx.db.get(usageId));

      expect(usage?.serviceFeeRate).toBe(0.25);
      expect(usage?.serviceFeeCents).toBeCloseTo(0.000005, 10);
    },
  );

  it("aggregates actual embedding tokens while preserving quota totals", async () => {
    const t = convexTest(schema, modules);
    const { userId, firstRepositoryId, secondRepositoryId } =
      await insertUserAndRepositories(t);

    await t.mutation(internal.tokenUsage.internalMutation.recordUsage, {
      userId,
      repositoryId: firstRepositoryId,
      inputTokens: 10,
      outputTokens: 5,
      model: "claude-sonnet-5-5",
      provider: "anthropic",
    });
    await t.mutation(
      internal.tokenUsage.internalMutation.recordEmbeddingUsage,
      {
        userId,
        repositoryId: firstRepositoryId,
        tokens: 12,
        model: LEGACY_GOOGLE_MODELS.embeddingModelId,
        provider: "google",
        billingTier: "free",
      },
    );
    const paidReservationKey = await reservePaidEmbeddingUsage(t, {
      userId,
      repositoryId: secondRepositoryId,
      reservationKey: "aggregate-paid",
    });
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        userId,
        repositoryId: secondRepositoryId,
        reservationKey: paidReservationKey,
        attemptToken: attemptTokenFor(paidReservationKey),
      },
    );
    await t.mutation(
      internal.tokenUsage.internalMutation.recordEmbeddingUsage,
      {
        userId,
        repositoryId: secondRepositoryId,
        tokens: 20,
        model: LEGACY_GOOGLE_MODELS.embeddingModelId,
        provider: "google",
        billingTier: "paid",
        reservationKey: paidReservationKey,
        reservationAttemptToken: attemptTokenFor(paidReservationKey),
      },
    );

    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });
    const [currentUsage, repositories] = await Promise.all([
      authenticated.query(api.tokenUsage.query.getCurrentMonthUsage, {}),
      authenticated.query(api.tokenUsage.query.getUsageByRepository, {}),
    ]);

    expect(currentUsage).toMatchObject({
      totalInputTokens: 14,
      totalOutputTokens: 5,
      totalTokens: 19,
      totalActions: 1,
      totalEmbeddingTokens: 20,
    });
    expect(
      repositories
        .map((repository) => ({
          repositoryId: repository.repositoryId,
          totalTokens: repository.totalTokens,
          totalActions: repository.totalActions,
        }))
        .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId)),
    ).toEqual(
      [
        {
          repositoryId: firstRepositoryId,
          totalTokens: 15,
          totalActions: 1,
        },
        {
          repositoryId: secondRepositoryId,
          totalTokens: 4,
          totalActions: 0,
        },
      ].sort((a, b) => a.repositoryId.localeCompare(b.repositoryId)),
    );
  });

  it("fails explicitly instead of silently truncating oversized aggregates", async () => {
    expect(() =>
      assertCompleteUsageAggregation(MAX_TOKEN_USAGE_AGGREGATION_RECORDS),
    ).not.toThrow();
    expect(() =>
      assertCompleteUsageAggregation(MAX_TOKEN_USAGE_AGGREGATION_RECORDS + 1),
    ).toThrow("Usage history is too large to aggregate safely");

    const t = convexTest(schema, modules);
    const { userId } = await insertUserAndRepositories(t);
    const createdAt = Date.now();
    const totalRecords = MAX_TOKEN_USAGE_AGGREGATION_RECORDS + 1;
    const insertBatchSize = 500;
    for (let offset = 0; offset < totalRecords; offset += insertBatchSize) {
      await t.run(async (ctx) => {
        const end = Math.min(offset + insertBatchSize, totalRecords);
        for (let index = offset; index < end; index++) {
          await ctx.db.insert("tokenUsage", {
            purchasedTokensDebited: 0,
            userId,
            usageType: "embedding",
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            embeddingTokens: 1,
            embeddingBillingTier: "free",
            inputCostCents: 0,
            outputCostCents: 0,
            baseCostCents: 0,
            serviceFeeCents: 0,
            totalCostCents: 0,
            model: LEGACY_GOOGLE_MODELS.embeddingModelId,
            provider: "google",
            serviceFeeRate: 0.25,
            createdAt: createdAt + index,
          });
        }
      });
    }

    const authenticated = t.withIdentity({
      subject: `${userId}|test-session`,
    });
    await expect(
      authenticated.query(api.tokenUsage.query.getCurrentMonthUsage, {}),
    ).rejects.toThrow("Usage history is too large to aggregate safely");
    await expect(
      authenticated.query(api.tokenUsage.query.getUsageByRepository, {}),
    ).rejects.toThrow("Usage history is too large to aggregate safely");
    process.env.SITE_URL = "https://notlocalhost.example";
    await expect(
      t.query(internal.subscriptions.internalQuery.canPerformActionInternal, {
        userId,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "usage_history_too_large",
    });

    const now = Date.now();
    const untrustedSubscriptionId = await t.run(async (ctx) => {
      return await ctx.db.insert("subscriptions", {
        userId,
        plan: "pro",
        status: "active",
        includedTokens: 2_400_000,
        purchasedTokens: 0,
        serviceFeeRate: 0.18,
        periodStart: createdAt - 1,
        periodEnd: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(
      t.query(internal.subscriptions.internalQuery.canPerformActionInternal, {
        userId,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "usage_history_too_large",
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(untrustedSubscriptionId, {
        proEntitlementProvenance: {
          source: "lemon_squeezy_webhook",
          verifiedAt: Date.now(),
        },
      });
    });
    await expect(
      t.query(internal.subscriptions.internalQuery.canPerformActionInternal, {
        userId,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "usage_history_too_large",
    });
  });
});
