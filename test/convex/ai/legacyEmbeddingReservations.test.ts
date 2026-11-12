import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";

const modules = import.meta.glob("../../../convex/**/*.ts");

beforeEach(() => {
  vi.stubEnv("SITE_URL", "https://gitdog.dev");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function insertOwner(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
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
    const date = new Date(now);
    const subscriptionId = await ctx.db.insert("subscriptions", {
      userId,
      plan: "free",
      status: "active",
      includedTokens: 0,
      purchasedTokens: 1_000,
      serviceFeeRate: 0.25,
      periodStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      periodEnd: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
      createdAt: now,
      updatedAt: now,
    });
    return { userId, repositoryId, subscriptionId };
  });
}

async function insertReservation(
  t: ReturnType<typeof convexTest>,
  owner: {
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    subscriptionId: Id<"subscriptions">;
  },
  key: string,
  fields: {
    status: "pending" | "ambiguous";
    providerStartedAt?: number;
    expiresAt: number;
    settlementTokens?: number;
  },
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("embeddingUsageReservations", {
      reservationKey: key,
      attemptToken: `${key}:1`,
      userId: owner.userId,
      repositoryId: owner.repositoryId,
      operation: "RAG search",
      provider: "openai",
      model: "text-embedding-3-small",
      inputCount: 1,
      providerTokenLimit: 100,
      reservedTokens: 2,
      subscriptionId: owner.subscriptionId,
      entitlementPlan: "free",
      includedTokens: 0,
      serviceFeeRate: 0.25,
      quotaPeriodStart: now - 60_000,
      quotaPeriodEnd: now + 60_000,
      status: fields.status,
      providerStartedAt: fields.providerStartedAt,
      ...(fields.settlementTokens !== undefined
        ? {
            settlementState: "staged" as const,
            settlementTokens: fields.settlementTokens,
            settlementStagedAt: now - 60_000,
            settlementNextRecoveryAt: now - 1,
          }
        : {}),
      expiresAt: fields.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function reservation(t: ReturnType<typeof convexTest>, key: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("embeddingUsageReservations")
      .withIndex("by_reservation_key", (q) => q.eq("reservationKey", key))
      .unique(),
  );
}

describe("retired embedding reservations", () => {
  it("releases calls that can no longer finish instead of leaving them ambiguous", async () => {
    const t = convexTest(schema, modules);
    const owner = await insertOwner(t);
    const now = Date.now();
    await insertReservation(t, owner, "started-expired", {
      status: "pending",
      providerStartedAt: now - 120_000,
      expiresAt: now - 1,
    });
    await insertReservation(t, owner, "old-ambiguous", {
      status: "ambiguous",
      providerStartedAt: now - 120_000,
      expiresAt: now + 60_000,
    });
    await insertReservation(t, owner, "staged", {
      status: "pending",
      providerStartedAt: now - 120_000,
      expiresAt: now - 1,
      settlementTokens: 17,
    });

    await t.mutation(
      internal._ai.embeddingBilling.cleanupEmbeddingUsageReservations,
      {},
    );
    for (const key of ["started-expired", "old-ambiguous"])
      expect(await reservation(t, key)).toMatchObject({
        status: "released",
        releaseReason: "embeddings_retired",
      });
    expect(await reservation(t, "staged")).toMatchObject({
      status: "pending",
      settlementState: "staged",
    });
  });

  it("still settles a staged, known-billed outcome into usage", async () => {
    const t = convexTest(schema, modules);
    const owner = await insertOwner(t);
    const now = Date.now();
    await insertReservation(t, owner, "staged", {
      status: "pending",
      providerStartedAt: now - 120_000,
      expiresAt: now + 60_000,
      settlementTokens: 17,
    });
    await t.mutation(
      internal._ai.embeddingBilling.recoverStagedEmbeddingOutcomes,
      {},
    );
    await t.finishAllScheduledFunctions(() => undefined);
    const state = await t.run(async (ctx) => ({
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", "staged"),
        )
        .unique(),
      usage: await ctx.db.query("tokenUsage").collect(),
    }));
    expect(state.reservation).toMatchObject({ status: "finalized" });
    expect(state.usage).toEqual([
      expect.objectContaining({
        usageType: "embedding",
        embeddingTokens: 17,
        provider: "openai",
      }),
    ]);
  });
});

describe("retired embedding cleanup scheduling", () => {
  it("does not reschedule itself for a full page of staged rows", async () => {
    const t = convexTest(schema, modules);
    const owner = await insertOwner(t);
    const now = Date.now();
    for (let index = 0; index < 100; index++)
      await insertReservation(t, owner, `staged-${index}`, {
        status: "ambiguous",
        providerStartedAt: now - 120_000,
        expiresAt: now + 60_000,
        settlementTokens: 1,
      });
    await expect(
      t.mutation(
        internal._ai.embeddingBilling.cleanupEmbeddingUsageReservations,
        {},
      ),
    ).resolves.toMatchObject({ continuationScheduled: false });
  });
});
