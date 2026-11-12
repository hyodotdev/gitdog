import { convexTest } from "convex-test";
import { drainScheduledFunctions } from "../scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";
import { hasOpenUsageReservation } from "../../../convex/_ai/chatBilling";
import { LEGACY_GOOGLE_MODELS } from "../../../convex/_ai/config";
import { getDefaultAiModel } from "../../../convex/_ai/model";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../../convex/users/legal";
import { CODE_EMBEDDING_KEY } from "../../../convex/ragV2/action";
const modules = import.meta.glob("../../../convex/**/*.ts");
beforeEach(() => {
  vi.stubEnv("SITE_URL", "https://gitdog.hyo.dev");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => {
  vi.useRealTimers();
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

function argsFor(
  f: Awaited<ReturnType<typeof insertFixture>>,
  key: string,
  provider: "google" | "anthropic" | "openai" = "anthropic",
  tokens = 1000,
) {
  return {
    ...f,
    reservationKey: key,
    attemptToken: key + ":1",
    generationKey: key,
    operation: "retirement-test",
    model:
      provider === "google"
        ? LEGACY_GOOGLE_MODELS.chatModelId
        : provider === "anthropic"
          ? "claude-sonnet-5-5"
          : "gpt-6.1-sol",
    provider,
    requestFingerprint: "0".repeat(64),
    inputTokenLimit: tokens,
    outputTokenLimit: tokens,
  };
}
async function seedHold(
  t: ReturnType<typeof convexTest>,
  args: ReturnType<typeof argsFor>,
) {
  expect(
    await t.mutation(internal._ai.chatBilling.reserveChatUsage, args),
  ).toMatchObject({ allowed: true });
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("chatUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .unique();
    await ctx.db.patch(row!._id, {
      status: "ambiguous",
      providerStartedAt: Date.now(),
      releaseReason: "ambiguous_provider_attempt",
    });
  });
}
function startArgs(a: ReturnType<typeof argsFor>) {
  return {
    reservationKey: a.reservationKey,
    attemptToken: a.attemptToken,
    userId: a.userId,
    repositoryId: a.repositoryId,
    ticketActionId: a.ticketActionId,
  };
}

describe("legacy Google usage", () => {
  it("rejects a removed generation route", () => {
    vi.stubEnv("AI_GENERATION_ROUTE", "gemini");
    expect(() => getDefaultAiModel()).toThrow(
      "Unsupported AI_GENERATION_ROUTE",
    );
  });
  it("allows Claude after a legacy Google hold without fabricating settlement", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    const old = argsFor(f, "legacy", "google");
    await seedHold(t, old);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", old.reservationKey),
        )
        .unique();
      await ctx.db.patch(row!._id, { provider: undefined });
    });
    const next = argsFor(f, "new-claude");
    expect(
      await t.mutation(internal._ai.chatBilling.reserveChatUsage, next),
    ).toMatchObject({ allowed: true });
    expect(
      await t.mutation(
        internal._ai.chatBilling.markChatProviderStarted,
        startArgs(next),
      ),
    ).toMatchObject({ started: true });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", old.reservationKey),
        )
        .unique();
      expect(row).toMatchObject({ status: "ambiguous", reservedTokens: 2000 });
      expect(row?.usageId).toBeUndefined();
      expect(row?.reconciliation).toBeUndefined();
      expect(await hasOpenUsageReservation(ctx, f.userId)).toBe(true);
    });
  });
  it("keeps the full retired Google ceiling reserved against future quota", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    await seedHold(t, argsFor(f, "large-old-hold", "google", 49950));
    expect(
      await t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        argsFor(f, "over-ceiling", "openai", 100),
      ),
    ).toEqual({ allowed: false, reason: "limit_reached" });
  });
  it("finds a later active-provider ambiguity behind an older Google hold at both gates", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    await seedHold(t, argsFor(f, "old-google", "google"));
    const pending = argsFor(f, "reserved-openai", "openai");
    expect(
      await t.mutation(internal._ai.chatBilling.reserveChatUsage, pending),
    ).toMatchObject({ allowed: true });
    await seedHold(t, argsFor(f, "new-anthropic-hold", "anthropic"));
    expect(
      await t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        argsFor(f, "blocked"),
      ),
    ).toEqual({ allowed: false, reason: "unresolved_provider_usage" });
    expect(
      await t.mutation(
        internal._ai.chatBilling.markChatProviderStarted,
        startArgs(pending),
      ),
    ).toEqual({ started: false, reason: "unresolved_provider_usage" });
  });
  it("holds retired embedding spend without serializing new OpenAI work", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("embeddingUsageReservations", {
        reservationKey: "old-embedding",
        attemptToken: "1",
        userId: f.userId,
        repositoryId: f.repositoryId,
        operation: "RAG index",
        inputCount: 1,
        providerTokenLimit: 1000,
        reservedTokens: 99900,
        entitlementPlan: "free",
        includedTokens: 100000,
        serviceFeeRate: 0.25,
        quotaPeriodStart: now,
        quotaPeriodEnd: now + 86400000,
        status: "ambiguous",
        providerStartedAt: now,
        expiresAt: now + 86400000,
        createdAt: now,
        updatedAt: now,
      });
    });
    expect(
      await t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        argsFor(f, "too-large", "openai", 100),
      ),
    ).toMatchObject({ allowed: false, reason: "limit_reached" });
    const next = argsFor(f, "fits", "openai", 50);
    expect(
      await t.mutation(internal._ai.chatBilling.reserveChatUsage, next),
    ).toMatchObject({ allowed: true });
    expect(
      await t.mutation(
        internal._ai.chatBilling.markChatProviderStarted,
        startArgs(next),
      ),
    ).toMatchObject({ started: true });
  });
});

async function enableRepositoryAccess(
  t: ReturnType<typeof convexTest>,
  f: Awaited<ReturnType<typeof insertFixture>>,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("userProfiles", {
      userId: f.userId,
      githubUsername: "owner",
      minimumAgeAttestedAt: now,
      professionalUseAttestedAt: now,
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("githubInstallations", {
      userId: f.userId,
      installationId: 101,
      ownerGithubAccountId: "5001",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
  });
}
describe("retrieval without embedding credentials", () => {
  it.each([false, true])(
    "completes keyword indexing with old credentials, continuation=%s",
    async (continuation) => {
      vi.useFakeTimers();
      const t = convexTest(schema, modules);
      const f = await insertFixture(t);
      await enableRepositoryAccess(t, f);
      await t.run(async (ctx) => {
        await ctx.db.patch(f.repositoryId, {
          ragStatus: continuation ? "indexing" : "pending",
          ragEmbeddingMode: continuation ? "openai" : undefined,
          ragEmbeddingKey: continuation ? CODE_EMBEDDING_KEY : undefined,
          ragEmbeddingBillingTier: continuation ? "paid" : undefined,
          ragIndexPhase: continuation ? "files" : undefined,
          ragIndexFileOffset: continuation ? 0 : undefined,
          ragIndexChunkOffset: continuation ? 0 : undefined,
          ragContinuationToken: continuation ? "old-token" : undefined,
          ragProcessedFiles: continuation ? 0 : undefined,
        });
      });
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("No external requests expected"));
      await t.action(internal.ragV2.action.generateChunkEmbeddings, {
        repositoryId: f.repositoryId,
        ...(continuation
          ? {
              indexVersion: 1,
              phase: "files" as const,
              claimToken: "old-token",
            }
          : {}),
      });
      await drainScheduledFunctions(t);
      const repo = await t.run((ctx) => ctx.db.get(f.repositoryId));
      expect(repo).toMatchObject({
        ragStatus: "completed",
        ragEmbeddingMode: "keyword_only",
        ragIndexedChunks: 0,
      });
      expect(repo?.ragEmbeddingKey).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("searches old vector indexes and publishes/retrieves learnings through keywords", async () => {
    const t = convexTest(schema, modules);
    const f = await insertFixture(t);
    await enableRepositoryAccess(t, f);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(f.repositoryId, {
        ragEmbeddingMode: "openai",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId: f.repositoryId,
        repositoryIndexKey: `${f.repositoryId}:1`,
        chunkId: "keyword-result",
        path: "src/keyword.ts",
        language: "typescript",
        code: "export const uniqueNeedle = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["uniqueNeedle"],
        searchableText: "uniqueNeedle export const true",
        contentHash: "keyword-hash",
        indexVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No external requests expected"));
    const results = await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId: f.repositoryId,
      indexVersion: 1,
      query: "uniqueNeedle",
      topK: 5,
    });
    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe("keyword-result");
    const learningId = await t.action(
      internal.repoLearnings.action.createLearning,
      {
        repositoryId: f.repositoryId,
        content: "uniqueNeedle requires a stable retry identifier",
        source: "owner correction",
        sourceType: "correction",
        isTrusted: true,
        requestedByUserId: f.userId,
      },
    );
    const learning = await t.run((ctx) => ctx.db.get(learningId));
    expect(learning?.embedding).toBeUndefined();
    const learnings = await t.action(
      internal.repoLearnings.action.searchLearnings,
      {
        repositoryId: f.repositoryId,
        query: "uniqueNeedle",
        requestedByUserId: f.userId,
      },
    );
    expect(learnings.map((x) => x._id)).toContain(learningId);
    expect(fetch).not.toHaveBeenCalled();
  });
});
