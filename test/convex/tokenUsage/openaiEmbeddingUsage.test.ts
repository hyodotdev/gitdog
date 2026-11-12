import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import { executeEmbeddingRequest } from "../../../convex/_ai/embeddingBilling";
import schema from "../../../convex/schema";
const modules = import.meta.glob("../../../convex/**/*.ts");
beforeEach(() => vi.stubEnv("SITE_URL", "https://gitdog.hyo.dev"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

async function reserve(
  t: ReturnType<typeof convexTest>,
  f: Awaited<ReturnType<typeof insertFixture>>,
  key: string,
  provider: "google" | "openai" = "openai",
) {
  const args = {
    userId: f.userId,
    repositoryId: f.repositoryId,
    reservationKey: key,
    attemptToken: key + ":1",
    operation: "RAG index",
    inputCount: 1,
    providerTokenLimit: 1000,
    provider,
    model:
      provider === "openai" ? "text-embedding-3-small" : "gemini-embedding-2",
  };
  expect(
    await t.mutation(
      internal._ai.embeddingBilling.reservePaidEmbeddingUsage,
      args,
    ),
  ).toMatchObject({ allowed: true });
  return args;
}
async function start(
  t: ReturnType<typeof convexTest>,
  a: Awaited<ReturnType<typeof reserve>>,
) {
  return await t.mutation(
    internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
    {
      reservationKey: a.reservationKey,
      attemptToken: a.attemptToken,
      userId: a.userId,
      repositoryId: a.repositoryId,
    },
  );
}
describe("provider-specific OpenAI embedding accounting", () => {
  it("reserves and settles the OpenAI price exactly, including after staged recovery", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    const a = await reserve(t, f, "openai-price");
    expect(await start(t, a)).toMatchObject({ started: true });
    const before = await t.run((ctx) =>
      ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", a.reservationKey),
        )
        .unique(),
    );
    expect(before).toMatchObject({
      provider: "openai",
      model: a.model,
      reservedTokens: 20,
    });
    await t.mutation(
      internal._ai.embeddingBilling.stageEmbeddingProviderOutcome,
      {
        reservationKey: a.reservationKey,
        attemptToken: a.attemptToken,
        userId: f.userId,
        repositoryId: f.repositoryId,
        tokens: 1000,
        provider: "openai",
        model: a.model,
      },
    );
    const result = await t.mutation(
      internal._ai.embeddingBilling.settleStagedEmbeddingOutcome,
      { reservationKey: a.reservationKey, attemptToken: a.attemptToken },
    );
    expect(result.status).toBe("finalized");
    const usage = await t.run((ctx) =>
      ctx.db
        .query("tokenUsage")
        .withIndex("by_embedding_reservation", (q) =>
          q.eq("embeddingReservationKey", a.reservationKey),
        )
        .unique(),
    );
    expect(usage).toMatchObject({
      provider: "openai",
      model: a.model,
      embeddingTokens: 1000,
      totalTokens: 20,
    });
    expect(usage?.baseCostCents).toBeCloseTo(0.002);
    expect(usage?.serviceFeeCents).toBeCloseTo(0.0005);
  });
  it("rejects cross-provider reservation replay, staging and finalization", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    const a = await reserve(t, f, "identity");
    await expect(
      t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
        ...a,
        provider: "google",
        model: "gemini-embedding-2",
      }),
    ).rejects.toThrow("identity mismatch");
    expect(await start(t, a)).toMatchObject({ started: true });
    await expect(
      t.mutation(internal._ai.embeddingBilling.stageEmbeddingProviderOutcome, {
        reservationKey: a.reservationKey,
        attemptToken: a.attemptToken,
        userId: f.userId,
        repositoryId: f.repositoryId,
        tokens: 50,
        provider: "google",
        model: "gemini-embedding-2",
      }),
    ).rejects.toThrow("identity mismatch");
    await expect(
      t.mutation(internal.tokenUsage.internalMutation.recordEmbeddingUsage, {
        userId: f.userId,
        repositoryId: f.repositoryId,
        tokens: 50,
        provider: "google",
        model: "gemini-embedding-2",
        billingTier: "paid",
        reservationKey: a.reservationKey,
        reservationAttemptToken: a.attemptToken,
      }),
    ).rejects.toThrow("not finalizable");
  });
  it("requires evidence from the same provider for reconciliation", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    const a = await reserve(t, f, "evidence");
    await start(t, a);
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageAmbiguous,
      {
        reservationKey: a.reservationKey,
        attemptToken: a.attemptToken,
        userId: f.userId,
        repositoryId: f.repositoryId,
      },
    );
    const { reconcilePaidEmbeddingUsageInTransaction } =
      await import("../../../convex/tokenUsage/internalMutation");
    await expect(
      t.run((ctx) =>
        reconcilePaidEmbeddingUsageInTransaction(ctx, {
          reservationKey: a.reservationKey,
          evidenceSource: "google_api_response",
          evidenceReference: "provider-evidence",
          reconciledBy: f.userId,
          outcome: { kind: "known_not_billed" },
        }),
      ),
    ).rejects.toThrow("evidence provider");
    expect(
      await t.run((ctx) =>
        reconcilePaidEmbeddingUsageInTransaction(ctx, {
          reservationKey: a.reservationKey,
          evidenceSource: "openai_api_response",
          evidenceReference: "provider-evidence",
          reconciledBy: f.userId,
          outcome: { kind: "known_not_billed" },
        }),
      ),
    ).toEqual({ status: "released" });
  });
  it("ignores only old Google serialization while OpenAI ambiguity blocks both chat and embeddings", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    const old = await reserve(t, f, "old-google", "google");
    await start(t, old);
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageAmbiguous,
      {
        reservationKey: old.reservationKey,
        attemptToken: old.attemptToken,
        userId: f.userId,
        repositoryId: f.repositoryId,
      },
    );
    const a = await reserve(t, f, "new-openai");
    expect(await start(t, a)).toMatchObject({ started: true });
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageAmbiguous,
      {
        reservationKey: a.reservationKey,
        attemptToken: a.attemptToken,
        userId: f.userId,
        repositoryId: f.repositoryId,
      },
    );
    expect(
      await t.mutation(
        internal._ai.embeddingBilling.reservePaidEmbeddingUsage,
        { ...a, reservationKey: "blocked-embedding", attemptToken: "new" },
      ),
    ).toMatchObject({ allowed: false, reason: "unresolved_provider_usage" });
    expect(
      await t.mutation(internal._ai.chatBilling.reserveChatUsage, {
        ...f,
        reservationKey: "blocked-chat",
        attemptToken: "new",
        generationKey: "blocked-chat",
        operation: "answer",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        requestFingerprint: "0".repeat(64),
        inputTokenLimit: 100,
        outputTokenLimit: 100,
      }),
    ).toMatchObject({ allowed: false, reason: "unresolved_provider_usage" });
  });
});

describe("embedding identity failure settlement", () => {
  it.each(["provider", "model"])(
    "does not record mismatched %s usage as the requested model",
    async (mismatch) => {
      const t = convexTest(schema, modules);
      const f = await insertFixture(t);
      const key = `wrong-${mismatch}`;
      await expect(
        executeEmbeddingRequest(
          { runMutation: t.mutation.bind(t) } as unknown as ActionCtx,
          {
            userId: f.userId,
            repositoryId: f.repositoryId,
            provider: "openai",
            model: "text-embedding-3-small",
            policy: { route: "paid", allowPaidFallback: false },
            keys: { paidApiKey: "test" },
            inputCount: 1,
            inputTokenLimit: 1000,
            operation: "RAG search",
            reservationKey: key,
            request: async (_policy, client) => {
              await client.beforeProviderRequest("paid");
              return {
                provider: mismatch === "provider" ? "google" : "openai",
                model:
                  mismatch === "model"
                    ? "text-embedding-3-large"
                    : "text-embedding-3-small",
                dimensions: 1536,
                embeddings: [],
                tokens: 10,
                route: "paid",
              };
            },
          },
        ),
      ).rejects.toThrow("does not match");
      const result = await t.run(async (ctx) => ({
        reservation: await ctx.db
          .query("embeddingUsageReservations")
          .withIndex("by_reservation_key", (q) => q.eq("reservationKey", key))
          .unique(),
        usage: await ctx.db
          .query("tokenUsage")
          .withIndex("by_embedding_reservation", (q) =>
            q.eq("embeddingReservationKey", key),
          )
          .first(),
      }));
      expect(result.reservation?.status).toBe("ambiguous");
      expect(result.usage).toBeNull();
    },
  );
});
