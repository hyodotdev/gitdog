import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import {
  CLAUDE_API_ENDS_AT,
  GENERATION_MODELS,
  PRICING,
  getFreeIncludedTokens,
} from "../../../convex/_ai/config";
import {
  CHAT_RESERVATION_TTL_MS,
  createMeteredProvider,
  hasOpenUsageReservation,
} from "../../../convex/_ai/chatBilling";
import type { AiProvider } from "../../../convex/_ai/model";
import {
  resolveGenerationProvider,
  UserApiKeyError,
} from "../../../convex/_ai/providerResolution";
import { CreditFallbackProvider } from "../../../convex/_ai/providers";
import { encryptProviderKey } from "../../../convex/providerApiKeys/crypto";
import { OUT_OF_CREDIT_RETRY_MS } from "../../../convex/providerApiKeys/usability";
import {
  getUsageHourStart,
  insertTokenUsage,
  rebuildUsageTotalsHour,
} from "../../../convex/tokenUsage/totals";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/_ai/chatBilling.ts": () =>
    import("../../../convex/_ai/chatBilling"),
  "../../../convex/_ai/embeddingBilling.ts": () =>
    import("../../../convex/_ai/embeddingBilling"),
  "../../../convex/tokenUsage/internalMutation.ts": () =>
    import("../../../convex/tokenUsage/internalMutation"),
  "../../../convex/providerApiKeys/internalMutation.ts": () =>
    import("../../../convex/providerApiKeys/internalMutation"),
  "../../../convex/providerApiKeys/internalQuery.ts": () =>
    import("../../../convex/providerApiKeys/internalQuery"),
  "../../../convex/ticketActions/internalQuery.ts": () =>
    import("../../../convex/ticketActions/internalQuery"),
  "../../../convex/pullRequests/internalMutation.ts": () =>
    import("../../../convex/pullRequests/internalMutation"),
  "../../../convex/tokenUsage/query.ts": () =>
    import("../../../convex/tokenUsage/query"),
  "../../../convex/providerApiKeys/query.ts": () =>
    import("../../../convex/providerApiKeys/query"),
};

const ANTHROPIC_KEY = `sk-ant-api03-${"a".repeat(40)}`;
const OPENAI_KEY = `sk-proj-${"b".repeat(40)}`;
const originalSiteUrl = process.env.SITE_URL;
const originalEncryptionKey = process.env.BYOK_ENCRYPTION_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalOpenAIKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.SITE_URL = "https://gitdog.dev";
  process.env.BYOK_ENCRYPTION_KEY = btoa("k".repeat(32));
  process.env.ANTHROPIC_API_KEY = "gitdog-anthropic-key";
  process.env.OPENAI_API_KEY = "gitdog-openai-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of [
    ["SITE_URL", originalSiteUrl],
    ["BYOK_ENCRYPTION_KEY", originalEncryptionKey],
    ["ANTHROPIC_API_KEY", originalAnthropicKey],
    ["OPENAI_API_KEY", originalOpenAIKey],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Fixture = {
  userId: Id<"users">;
  repositoryId: Id<"repositories">;
  ticketId: Id<"tickets">;
  ticketActionId: Id<"ticketActions">;
};

async function insertFixture(
  t: ReturnType<typeof convexTest>,
): Promise<Fixture> {
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
      indexProgressAt: now,
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
    return { userId, repositoryId, ticketId, ticketActionId };
  });
}

async function insertAction(
  t: ReturnType<typeof convexTest>,
  fixture: Fixture,
  actionType: "answer" | "review" = "answer",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("ticketActions", {
      ticketId: fixture.ticketId,
      actionType,
      chatHistory: [],
      proposalVersion: 0,
      status: "pending",
      createdAt: Date.now(),
    }),
  );
}

async function saveKey(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  provider: "anthropic" | "openai",
  apiKey: string,
) {
  const encrypted = await encryptProviderKey(userId, provider, apiKey);
  await t.mutation(internal.providerApiKeys.internalMutation.upsert, {
    userId,
    provider,
    ...encrypted,
    last4: apiKey.slice(-4),
  });
}

async function savedIv(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  provider: "anthropic" | "openai",
) {
  const row = await t.run(async (ctx) =>
    ctx.db
      .query("providerApiKeys")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", userId).eq("provider", provider),
      )
      .unique(),
  );
  return row!.iv;
}

async function exhaustFreeQuota(
  t: ReturnType<typeof convexTest>,
  fixture: Fixture,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("tokenUsage", {
      purchasedTokensDebited: 0,
      userId: fixture.userId,
      repositoryId: fixture.repositoryId,
      usageType: "chat",
      inputTokens: getFreeIncludedTokens(Date.now()),
      outputTokens: 0,
      totalTokens: getFreeIncludedTokens(Date.now()),
      inputCostCents: 0,
      outputCostCents: 0,
      baseCostCents: 0,
      serviceFeeCents: 0,
      totalCostCents: 0,
      model: GENERATION_MODELS.anthropic.modelId,
      provider: "anthropic",
      serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
      createdAt: Date.now(),
    });
  });
}

function actionCtx(t: ReturnType<typeof convexTest>): ActionCtx {
  return {
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  } as unknown as ActionCtx;
}

function userKeyProvider(): AiProvider {
  return {
    name: "User key provider",
    modelId: GENERATION_MODELS.anthropic.modelId,
    providerId: "anthropic",
    keySource: "user",
    chat: vi.fn(async () => ({
      content: "Answer",
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      provider: "anthropic",
      providerRequestId: "user-key-request",
    })),
  };
}

function reservation(
  fixture: Fixture,
  key: string,
  ticketActionId: Id<"ticketActions"> = fixture.ticketActionId,
  keySource?: "user",
) {
  return {
    reservationKey: key,
    attemptToken: `${key}:attempt:1`,
    userId: fixture.userId,
    repositoryId: fixture.repositoryId,
    ticketActionId,
    requirePendingTicketAction: true,
    generationKey: `generation:${key}`,
    operation: "test-chat",
    model: GENERATION_MODELS.anthropic.modelId,
    provider: "anthropic" as const,
    requestFingerprint: "0".repeat(64),
    inputTokenLimit: 2_000,
    outputTokenLimit: 2_000,
    ...(keySource ? { keySource } : {}),
  };
}

const question = [{ role: "user" as const, content: "Question" }];

describe("generation on the owner's own provider key", () => {
  it("runs with exhausted quota and records usage outside the quota", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    await exhaustFreeQuota(t, fixture);

    const provider = createMeteredProvider(actionCtx(t), {
      ...fixture,
      generationKey: "user-key-generation",
      operation: "user-key-test",
      provider: userKeyProvider(),
      requirePendingTicketAction: true,
    });
    await expect(
      provider.chat(question, { maxTokens: 16, billingLabel: "answer" }),
    ).resolves.toMatchObject({ content: "Answer" });

    const { usage, totals, action, reservationRow } = await t.run(
      async (ctx) => ({
        usage: await ctx.db
          .query("tokenUsage")
          .withIndex("by_user_key_source_and_created_at", (q) =>
            q.eq("userId", fixture.userId).eq("keySource", "user"),
          )
          .collect(),
        totals: await ctx.db.query("tokenUsageHourlyTotals").collect(),
        action: await ctx.db.get(fixture.ticketActionId),
        reservationRow: await ctx.db
          .query("chatUsageReservations")
          .withIndex("by_reservation_key", (q) =>
            q.eq("reservationKey", "chat:v1:user-key-generation:answer"),
          )
          .unique(),
      }),
    );
    expect(usage).toEqual([
      expect.objectContaining({
        keySource: "user",
        totalTokens: 15,
        purchasedTokensDebited: 0,
        serviceFeeRate: 0,
        serviceFeeCents: 0,
      }),
    ]);
    expect(totals).toEqual([]);
    expect(action?.aiKeySource).toBe("user");
    expect(reservationRow).toMatchObject({
      status: "finalized",
      keySource: "user",
    });
    expect(reservationRow?.subscriptionId).toBeUndefined();

    // Gitdog-paid work for the same account is still limited.
    const otherAction = await insertAction(t, fixture);
    await expect(
      t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        reservation(fixture, "gitdog-paid", otherAction),
      ),
    ).resolves.toEqual({ allowed: false, reason: "limit_reached" });
  });

  it("refuses a user-key reservation without a usable key and pins only started actions", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await expect(
      t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        reservation(fixture, "no-key", fixture.ticketActionId, "user"),
      ),
    ).resolves.toEqual({ allowed: false, reason: "user_key_unavailable" });

    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    const userArgs = reservation(
      fixture,
      "with-key",
      fixture.ticketActionId,
      "user",
    );
    await expect(
      t.mutation(internal._ai.chatBilling.reserveChatUsage, userArgs),
    ).resolves.toMatchObject({ allowed: true });
    // A reservation that never reaches the provider does not pin the action.
    await t.mutation(internal._ai.chatBilling.releaseChatUsage, {
      reservationKey: userArgs.reservationKey,
      attemptToken: userArgs.attemptToken,
      userId: fixture.userId,
      repositoryId: fixture.repositoryId,
      ticketActionId: fixture.ticketActionId,
      confirmedNotBilled: true,
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get(fixture.ticketActionId)))
        ?.aiKeySource,
    ).toBeUndefined();
    await expect(
      t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        reservation(fixture, "gitdog-before-start"),
      ),
    ).resolves.toMatchObject({ allowed: true });

    const started = reservation(
      fixture,
      "started",
      fixture.ticketActionId,
      "user",
    );
    await t.mutation(internal._ai.chatBilling.reserveChatUsage, started);
    await t.mutation(internal._ai.chatBilling.markChatProviderStarted, {
      reservationKey: started.reservationKey,
      attemptToken: started.attemptToken,
      userId: fixture.userId,
      repositoryId: fixture.repositoryId,
      ticketActionId: fixture.ticketActionId,
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get(fixture.ticketActionId)))
        ?.aiKeySource,
    ).toBe("user");
    await expect(
      t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        reservation(fixture, "gitdog-after-user"),
      ),
    ).resolves.toEqual({ allowed: false, reason: "user_key_required" });

    await t.mutation(
      internal.providerApiKeys.internalMutation.recordKeyFailure,
      {
        userId: fixture.userId,
        provider: "anthropic",
        keyIv: await savedIv(t, fixture.userId, "anthropic"),
        code: "invalid",
        httpStatus: 401,
      },
    );
    await expect(
      t.mutation(
        internal._ai.chatBilling.reserveChatUsage,
        reservation(fixture, "invalid-key", fixture.ticketActionId, "user"),
      ),
    ).resolves.toEqual({ allowed: false, reason: "user_key_unavailable" });
  });

  it("refuses to start a user-key call whose key was removed after reserving", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    const args = reservation(fixture, "race", fixture.ticketActionId, "user");
    await t.mutation(internal._ai.chatBilling.reserveChatUsage, args);
    await t.run(async (ctx) => {
      for (const key of await ctx.db.query("providerApiKeys").collect())
        await ctx.db.delete(key._id);
    });
    await expect(
      t.mutation(internal._ai.chatBilling.markChatProviderStarted, {
        reservationKey: args.reservationKey,
        attemptToken: args.attemptToken,
        userId: fixture.userId,
        repositoryId: fixture.repositoryId,
        ticketActionId: fixture.ticketActionId,
      }),
    ).resolves.toEqual({ started: false, reason: "user_key_unavailable" });
    expect(
      (await t.run(async (ctx) => ctx.db.get(fixture.ticketActionId)))
        ?.aiKeySource,
    ).toBeUndefined();
  });

  it("surfaces a key removed mid-request as an actionable provider error", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const provider = createMeteredProvider(actionCtx(t), {
      ...fixture,
      generationKey: "missing-key",
      operation: "user-key-test",
      provider: userKeyProvider(),
      requirePendingTicketAction: true,
    });
    await expect(
      provider.chat(question, { maxTokens: 16, billingLabel: "answer" }),
    ).rejects.toMatchObject({
      name: "UserApiKeyError",
      code: "unavailable",
      billingOutcome: "not_billed",
      message: expect.stringContaining("Gitdog settings"),
    });
  });

  it("lets a retry take over an ambiguous user-key reservation", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    const first = reservation(fixture, "retry", fixture.ticketActionId, "user");
    await t.mutation(internal._ai.chatBilling.reserveChatUsage, first);
    await t.mutation(internal._ai.chatBilling.markChatProviderStarted, {
      reservationKey: first.reservationKey,
      attemptToken: first.attemptToken,
      userId: fixture.userId,
      repositoryId: fixture.repositoryId,
      ticketActionId: fixture.ticketActionId,
    });
    await t.mutation(internal._ai.chatBilling.markChatUsageAmbiguous, {
      reservationKey: first.reservationKey,
      attemptToken: first.attemptToken,
      userId: fixture.userId,
      repositoryId: fixture.repositoryId,
      ticketActionId: fixture.ticketActionId,
    });
    expect(
      (
        await t.run(async (ctx) =>
          ctx.db.query("chatUsageReservations").first(),
        )
      )?.status,
    ).toBe("ambiguous");
    const retry = {
      ...first,
      attemptToken: `${first.reservationKey}:attempt:2`,
    };
    await expect(
      t.mutation(internal._ai.chatBilling.reserveChatUsage, retry),
    ).resolves.toEqual({ allowed: true, reservationKey: first.reservationKey });
    expect(
      await t.run(async (ctx) => ctx.db.query("chatUsageReservations").first()),
    ).toMatchObject({
      status: "pending",
      attemptToken: retry.attemptToken,
      keySource: "user",
    });
  });

  it("replays a pinned action's checkpoint after its key is removed", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    const meter = (provider: AiProvider) =>
      createMeteredProvider(actionCtx(t), {
        ...fixture,
        generationKey: "replay",
        operation: "user-key-test",
        provider,
        requirePendingTicketAction: true,
      });
    const original = await meter(userKeyProvider()).chat(question, {
      maxTokens: 16,
      billingLabel: "answer",
    });
    await t.run(async (ctx) => {
      for (const key of await ctx.db.query("providerApiKeys").collect())
        await ctx.db.delete(key._id);
    });
    const gitdogRoute = { ...userKeyProvider(), keySource: undefined };
    await expect(
      meter(gitdogRoute).chat(question, {
        maxTokens: 16,
        billingLabel: "answer",
      }),
    ).resolves.toMatchObject({
      content: original.content,
      providerRequestId: original.providerRequestId,
    });
    expect(gitdogRoute.chat).not.toHaveBeenCalled();
  });

  it("keeps in-flight user-key calls out of Gitdog quota guards", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    const userArgs = reservation(
      fixture,
      "user-in-flight",
      fixture.ticketActionId,
      "user",
    );
    await t.mutation(internal._ai.chatBilling.reserveChatUsage, userArgs);
    await expect(
      t.mutation(internal._ai.chatBilling.markChatProviderStarted, {
        reservationKey: userArgs.reservationKey,
        attemptToken: userArgs.attemptToken,
        userId: fixture.userId,
        repositoryId: fixture.repositoryId,
        ticketActionId: fixture.ticketActionId,
      }),
    ).resolves.toMatchObject({ started: true });
    await expect(
      t.run(async (ctx) => hasOpenUsageReservation(ctx, fixture.userId)),
    ).resolves.toBe(false);

    const otherAction = await insertAction(t, fixture);
    const gitdogArgs = reservation(fixture, "gitdog-in-flight", otherAction);
    await expect(
      t.mutation(internal._ai.chatBilling.reserveChatUsage, gitdogArgs),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      t.mutation(internal._ai.chatBilling.markChatProviderStarted, {
        reservationKey: gitdogArgs.reservationKey,
        attemptToken: gitdogArgs.attemptToken,
        userId: fixture.userId,
        repositoryId: fixture.repositoryId,
        ticketActionId: otherAction,
      }),
    ).resolves.toMatchObject({ started: true });
  });

  it("drops old ambiguous user-key reservations during cleanup", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    const args = reservation(
      fixture,
      "old-user",
      fixture.ticketActionId,
      "user",
    );
    await t.mutation(internal._ai.chatBilling.reserveChatUsage, args);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", args.reservationKey),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        status: "ambiguous",
        providerStartedAt: 1,
        expiresAt: 1,
      });
    });
    await t.mutation(internal._ai.chatBilling.cleanupChatReservations, {});
    await expect(
      t.run(async (ctx) => ctx.db.query("chatUsageReservations").collect()),
    ).resolves.toEqual([]);
    expect(CHAT_RESERVATION_TTL_MS).toBeGreaterThan(0);
  });

  it("keeps a not-pending batched review a busy refusal, not a key error", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const reviewAction = await insertAction(t, fixture, "review");
    await t.run(async (ctx) =>
      ctx.db.patch(reviewAction, { status: "failed" }),
    );
    const result = await t.mutation(
      internal.pullRequests.internalMutation.reserveBatchedReviewQuota,
      { actionId: reviewAction, batches: 1, userKey: true },
    );
    expect(result).toMatchObject({ reserved: false, reason: "busy" });
    expect(result).not.toHaveProperty("userKeyUnavailable");
  });

  it("starts batched reviews on the owner's key without a quota hold", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const reviewAction = await insertAction(t, fixture, "review");
    await exhaustFreeQuota(t, fixture);
    await expect(
      t.mutation(
        internal.pullRequests.internalMutation.reserveBatchedReviewQuota,
        {
          actionId: reviewAction,
          batches: 3,
          userKey: true,
        },
      ),
    ).resolves.toMatchObject({
      reserved: false,
      reason: "unverified",
      userKeyUnavailable: true,
    });
    await saveKey(t, fixture.userId, "openai", OPENAI_KEY);
    await expect(
      t.mutation(
        internal.pullRequests.internalMutation.reserveBatchedReviewQuota,
        {
          actionId: reviewAction,
          batches: 3,
          userKey: true,
        },
      ),
    ).resolves.toEqual({ reserved: true });
    const action = await t.run(async (ctx) => ctx.db.get(reviewAction));
    expect(action?.reviewQuotaHold).toBeUndefined();
    expect(action?.reviewQuotaUserId).toBeUndefined();
  });
});

function claudeResponse() {
  return Response.json(
    {
      content: [{ type: "text", text: "Claude answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 4 },
    },
    { headers: { "request-id": "claude-user" } },
  );
}

function openaiResponse() {
  return Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "OpenAI answer" }],
      },
    ],
    usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
  });
}

function sentKeys(fetch: ReturnType<typeof vi.spyOn>) {
  return fetch.mock.calls.map(([, init]) => {
    const headers = (init as RequestInit).headers as Record<string, string>;
    return headers["x-api-key"] ?? headers.Authorization;
  });
}

describe("provider resolution with user keys", () => {
  it("uses Gitdog's route when the owner saved no key", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const provider = await resolveGenerationProvider(actionCtx(t), {
      userId: fixture.userId,
    });
    expect(provider).toBeInstanceOf(CreditFallbackProvider);
    expect(provider.keySource).toBeUndefined();
  });

  it("runs Claude on the owner's key even after Gitdog's Claude deadline", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    const provider = await resolveGenerationProvider(actionCtx(t), {
      userId: fixture.userId,
    });
    vi.spyOn(Date, "now").mockReturnValue(CLAUDE_API_ENDS_AT + 1_000);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(claudeResponse());
    await expect(provider.chat(question)).resolves.toMatchObject({
      content: "Claude answer",
    });
    expect(provider.keySource).toBe("user");
    expect(sentKeys(fetch)).toEqual([ANTHROPIC_KEY]);
  });

  it("falls back to the owner's OpenAI key on credit exhaustion only", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    await saveKey(t, fixture.userId, "openai", OPENAI_KEY);
    const provider = await resolveGenerationProvider(actionCtx(t), {
      userId: fixture.userId,
    });
    expect(provider).toBeInstanceOf(CreditFallbackProvider);
    expect(provider.keySource).toBe("user");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              message: "Your credit balance is too low",
            },
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(openaiResponse());
    await expect(provider.chat(question)).resolves.toMatchObject({
      content: "OpenAI answer",
    });
    expect(sentKeys(fetch)).toEqual([ANTHROPIC_KEY, `Bearer ${OPENAI_KEY}`]);
    const keys = await t.run(async (ctx) =>
      ctx.db.query("providerApiKeys").collect(),
    );
    expect(keys.find((key) => key.provider === "anthropic")?.status).toBe(
      "out_of_credit",
    );
  });

  it("fails a rejected key without touching Gitdog's keys", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    const provider = await resolveGenerationProvider(actionCtx(t), {
      userId: fixture.userId,
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(provider.chat(question)).rejects.toMatchObject({
      name: "UserApiKeyError",
      code: "invalid",
    });
    expect(sentKeys(fetch)).toEqual([ANTHROPIC_KEY]);
    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).rejects.toBeInstanceOf(UserApiKeyError);
  });

  it("falls back to the owner's OpenAI key when Anthropic rejects it mid-request", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    await saveKey(t, fixture.userId, "openai", OPENAI_KEY);
    const ctx = actionCtx(t);
    const provider = createMeteredProvider(ctx, {
      ...fixture,
      generationKey: "runtime-401",
      operation: "user-key-test",
      provider: await resolveGenerationProvider(ctx, {
        userId: fixture.userId,
      }),
      requirePendingTicketAction: true,
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(openaiResponse());
    await expect(
      provider.chat(question, { maxTokens: 16, billingLabel: "answer" }),
    ).resolves.toMatchObject({ content: "OpenAI answer" });
    expect(sentKeys(fetch)).toEqual([ANTHROPIC_KEY, `Bearer ${OPENAI_KEY}`]);
    const { usage, keys } = await t.run(async (dbCtx) => ({
      usage: await dbCtx.db.query("tokenUsage").collect(),
      keys: await dbCtx.db.query("providerApiKeys").collect(),
    }));
    expect(usage).toEqual([
      expect.objectContaining({ provider: "openai", keySource: "user" }),
    ]);
    expect(keys.find((key) => key.provider === "anthropic")?.status).toBe(
      "invalid",
    );
  });

  it("skips an out-of-credit key for an hour unless it is checked again", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    await t.mutation(
      internal.providerApiKeys.internalMutation.recordKeyFailure,
      {
        userId: fixture.userId,
        provider: "anthropic",
        keyIv: await savedIv(t, fixture.userId, "anthropic"),
        code: "out_of_credit",
      },
    );
    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).rejects.toMatchObject({ code: "out_of_credit" });
    const later = Date.now() + OUT_OF_CREDIT_RETRY_MS + 1_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).resolves.toMatchObject({ keySource: "user" });
  });

  it("does not mark keys rejected when the server key changed", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    process.env.BYOK_ENCRYPTION_KEY = btoa("z".repeat(32));
    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    const [key] = await t.run(async (ctx) =>
      ctx.db.query("providerApiKeys").collect(),
    );
    expect(key.status).toBe("active");
    expect(key.lastError).toBeUndefined();
  });

  it("refuses to finish a pinned action on Gitdog's key after the key is removed", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await t.run(async (ctx) =>
      ctx.db.patch(fixture.ticketActionId, { aiKeySource: "user" }),
    );
    await expect(
      resolveGenerationProvider(actionCtx(t), {
        userId: fixture.userId,
        ticketActionId: fixture.ticketActionId,
      }),
    ).rejects.toMatchObject({ code: "removed" });
  });

  it("keeps the user-key route options through the billing wrapper", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    await saveKey(t, fixture.userId, "openai", OPENAI_KEY);
    const ctx = actionCtx(t);
    const metered = createMeteredProvider(ctx, {
      ...fixture,
      generationKey: "wrapped",
      operation: "wrap-test",
      provider: await resolveGenerationProvider(ctx, {
        userId: fixture.userId,
      }),
      requirePendingTicketAction: true,
    });
    expect(metered).toBeInstanceOf(CreditFallbackProvider);
    expect((metered as CreditFallbackProvider).options).toEqual({
      enforceClaudeDeadline: false,
    });
    expect(metered.keySource).toBe("user");
  });
});

describe("usage reporting for user keys", () => {
  it("reports user-key usage apart from quota usage and keeps it out of totals", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    const now = Date.now();
    const row = {
      purchasedTokensDebited: 0,
      userId: fixture.userId,
      repositoryId: fixture.repositoryId,
      usageType: "chat" as const,
      inputTokens: 70,
      outputTokens: 30,
      totalTokens: 100,
      inputCostCents: 1,
      outputCostCents: 2,
      baseCostCents: 3,
      serviceFeeCents: 0,
      totalCostCents: 3,
      model: GENERATION_MODELS.anthropic.modelId,
      provider: "anthropic" as const,
      serviceFeeRate: 0,
      createdAt: now,
    };
    await t.run(async (ctx) => {
      await insertTokenUsage(ctx, { ...row, totalTokens: 40 });
      await insertTokenUsage(ctx, { ...row, keySource: "user" });
      await rebuildUsageTotalsHour(ctx, fixture.userId, getUsageHourStart(now));
    });
    const totals = await t.run(async (ctx) =>
      ctx.db.query("tokenUsageHourlyTotals").collect(),
    );
    expect(totals).toEqual([expect.objectContaining({ totalTokens: 40 })]);

    const as = t.withIdentity({ subject: `${fixture.userId}|session` });
    await expect(
      as.query(api.tokenUsage.query.getCurrentMonthUsage, {}),
    ).resolves.toMatchObject({
      totalTokens: 40,
      totalActions: 1,
      userKey: {
        totalTokens: 100,
        totalActions: 1,
        estimatedProviderCostCents: 3,
        isPartial: false,
      },
    });
    await expect(
      as.query(api.tokenUsage.query.getUsageByRepository, {}),
    ).resolves.toEqual([
      expect.objectContaining({
        repositoryId: fixture.repositoryId,
        totalTokens: 40,
        userKeyTokens: 100,
        userKeyActions: 1,
      }),
    ]);
  });
});

describe("user key recovery and server key problems", () => {
  it("marks an out-of-credit key active again after a successful call", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    await t.mutation(
      internal.providerApiKeys.internalMutation.recordKeyFailure,
      {
        userId: fixture.userId,
        provider: "anthropic",
        keyIv: await savedIv(t, fixture.userId, "anthropic"),
        code: "out_of_credit",
      },
    );
    vi.spyOn(Date, "now").mockReturnValue(
      Date.now() + OUT_OF_CREDIT_RETRY_MS + 1_000,
    );
    const provider = await resolveGenerationProvider(actionCtx(t), {
      userId: fixture.userId,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(claudeResponse());
    await provider.chat(question);
    const [key] = await t.run(async (ctx) =>
      ctx.db.query("providerApiKeys").collect(),
    );
    expect(key).toMatchObject({ status: "active" });
    expect(key.lastError).toBeUndefined();
  });

  it("treats a missing server encryption key as a service problem, not the user's", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    delete process.env.BYOK_ENCRYPTION_KEY;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    const state = await t.run(async (ctx) => ({
      notifications: await ctx.db.query("notifications").collect(),
      keys: await ctx.db.query("providerApiKeys").collect(),
    }));
    expect(state.notifications).toEqual([]);
    expect(state.keys[0].unreadableAt).toBeUndefined();
  });
});

describe("round 3 provider key state", () => {
  it("flags a key that fails to decrypt under the right server key", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "openai", OPENAI_KEY);
    await t.run(async (ctx) => {
      const [key] = await ctx.db.query("providerApiKeys").collect();
      await ctx.db.patch(key._id, { ciphertext: btoa("corrupt-ciphertext") });
    });
    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).rejects.toMatchObject({ code: "unreadable" });
    const as = t.withIdentity({ subject: `${fixture.userId}|session` });
    await expect(as.query(api.providerApiKeys.query.list, {})).resolves.toEqual(
      [expect.objectContaining({ readable: false, status: "active" })],
    );
    await saveKey(t, fixture.userId, "openai", OPENAI_KEY);
    await expect(as.query(api.providerApiKeys.query.list, {})).resolves.toEqual(
      [expect.objectContaining({ readable: true })],
    );
  });

  it("treats a server key that differs from the saved one as a server problem", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "openai", OPENAI_KEY);
    process.env.BYOK_ENCRYPTION_KEY = btoa("w".repeat(32));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    const as = t.withIdentity({ subject: `${fixture.userId}|session` });
    await expect(as.query(api.providerApiKeys.query.list, {})).resolves.toEqual(
      [expect.objectContaining({ serviceUnavailable: true, readable: true })],
    );
    await expect(
      t.run(async (ctx) => ctx.db.query("notifications").collect()),
    ).resolves.toEqual([]);
  });

  it("does not let a late success hide a newer failure or a replaced key", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    await t.mutation(
      internal.providerApiKeys.internalMutation.recordKeyFailure,
      {
        userId: fixture.userId,
        provider: "anthropic",
        keyIv: await savedIv(t, fixture.userId, "anthropic"),
        code: "out_of_credit",
      },
    );
    const key = async () =>
      (
        await t.run(async (ctx) => ctx.db.query("providerApiKeys").collect())
      )[0];
    const failed = await key();
    // Request started before the failure was recorded.
    await t.mutation(internal.providerApiKeys.internalMutation.markKeyWorking, {
      userId: fixture.userId,
      provider: "anthropic",
      keyIv: failed.iv,
      requestStartedAt: failed.lastError!.at - 1,
    });
    expect((await key()).status).toBe("out_of_credit");
    // A different saved key (another iv).
    await t.mutation(internal.providerApiKeys.internalMutation.markKeyWorking, {
      userId: fixture.userId,
      provider: "anthropic",
      keyIv: "another-iv",
      requestStartedAt: failed.lastError!.at + 1,
    });
    expect((await key()).status).toBe("out_of_credit");
    await t.mutation(internal.providerApiKeys.internalMutation.markKeyWorking, {
      userId: fixture.userId,
      provider: "anthropic",
      keyIv: failed.iv,
      requestStartedAt: failed.lastError!.at + 1,
    });
    expect((await key()).status).toBe("active");
  });
});

describe("round 4 server key expectations", () => {
  it("derives the expected server key from existing keys when none is recorded", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "openai", OPENAI_KEY);
    // Keys that predate the record: drop it so only the key rows remain.
    await t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("providerKeyEncryptionState")
        .collect())
        await ctx.db.delete(row._id);
    });
    const correctKey = process.env.BYOK_ENCRYPTION_KEY;
    process.env.BYOK_ENCRYPTION_KEY = btoa("w".repeat(32));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const as = t.withIdentity({ subject: `${fixture.userId}|session` });

    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(as.query(api.providerApiKeys.query.list, {})).resolves.toEqual(
      [expect.objectContaining({ serviceUnavailable: true, readable: true })],
    );
    // Saving under the wrong server key is refused, so the record is not
    // seeded with it.
    await expect(
      saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY),
    ).rejects.toThrow("does not match saved keys");
    await expect(
      t.run(async (ctx) => ({
        notifications: await ctx.db.query("notifications").collect(),
        state: await ctx.db.query("providerKeyEncryptionState").collect(),
      })),
    ).resolves.toEqual({ notifications: [], state: [] });

    process.env.BYOK_ENCRYPTION_KEY = correctKey;
    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).resolves.toMatchObject({ keySource: "user" });
  });

  it("rotates the server key only through the operator mutation", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "openai", OPENAI_KEY);
    process.env.BYOK_ENCRYPTION_KEY = btoa("w".repeat(32));
    const { currentEncryptionKeyId } =
      await import("../../../convex/providerApiKeys/crypto");
    const newKeyId = (await currentEncryptionKeyId())!;
    await t.mutation(
      internal.providerApiKeys.internalMutation.setExpectedEncryptionKeyId,
      { keyId: newKeyId },
    );
    const as = t.withIdentity({ subject: `${fixture.userId}|session` });
    // Keys saved under the old server key must be entered again.
    await expect(as.query(api.providerApiKeys.query.list, {})).resolves.toEqual(
      [expect.objectContaining({ serviceUnavailable: false, readable: false })],
    );
    await saveKey(t, fixture.userId, "openai", OPENAI_KEY);
    await expect(as.query(api.providerApiKeys.query.list, {})).resolves.toEqual(
      [expect.objectContaining({ readable: true })],
    );
  });
});

describe("round 6 recovery", () => {
  it("clears the unreadable flag after a successful request on the same key", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    const key = async () =>
      (
        await t.run(async (ctx) => ctx.db.query("providerApiKeys").collect())
      )[0];
    // Flagged during a rotation that was later rolled back.
    const saved = await key();
    await t.run(async (ctx) =>
      ctx.db.patch(saved._id, { unreadableAt: Date.now() - 60_000 }),
    );
    const flagged = await key();
    // A request that started before the flag leaves it in place.
    await t.mutation(internal.providerApiKeys.internalMutation.markKeyWorking, {
      userId: fixture.userId,
      provider: "anthropic",
      keyIv: flagged.iv,
      requestStartedAt: flagged.unreadableAt! - 1,
    });
    expect((await key()).unreadableAt).toBeDefined();

    const provider = await resolveGenerationProvider(actionCtx(t), {
      userId: fixture.userId,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(claudeResponse());
    await provider.chat(question);
    expect((await key()).unreadableAt).toBeUndefined();
  });
});

describe("user key reports from a running action", () => {
  it("clears a failure another action recorded once a newer request on the same key succeeds", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    // Resolved while the key was healthy.
    const provider = await resolveGenerationProvider(actionCtx(t), {
      userId: fixture.userId,
    });
    await t.mutation(
      internal.providerApiKeys.internalMutation.recordKeyFailure,
      {
        userId: fixture.userId,
        provider: "anthropic",
        code: "out_of_credit",
        keyIv: await savedIv(t, fixture.userId, "anthropic"),
      },
    );
    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).rejects.toMatchObject({ code: "out_of_credit" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(claudeResponse());
    await provider.chat(question);
    const [key] = await t.run(async (ctx) =>
      ctx.db.query("providerApiKeys").collect(),
    );
    expect(key).toMatchObject({ status: "active" });
    expect(key.lastError).toBeUndefined();
    await expect(
      resolveGenerationProvider(actionCtx(t), { userId: fixture.userId }),
    ).resolves.toMatchObject({ keySource: "user" });
  });

  it("does not mark a replacement key rejected when the replaced key fails", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t);
    await saveKey(t, fixture.userId, "anthropic", ANTHROPIC_KEY);
    const provider = await resolveGenerationProvider(actionCtx(t), {
      userId: fixture.userId,
    });
    await saveKey(
      t,
      fixture.userId,
      "anthropic",
      `sk-ant-api03-${"c".repeat(40)}`,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 401 }),
    );
    await expect(provider.chat(question)).rejects.toMatchObject({
      code: "invalid",
    });
    const state = await t.run(async (ctx) => ({
      keys: await ctx.db.query("providerApiKeys").collect(),
      notifications: await ctx.db.query("notifications").collect(),
    }));
    expect(state.notifications).toEqual([]);
    expect(state.keys).toEqual([
      expect.objectContaining({ status: "active", last4: "cccc" }),
    ]);
    expect(state.keys[0].lastError).toBeUndefined();
  });
});
