import { convexTest } from "convex-test";
import { drainScheduledFunctions } from "../scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v } from "convex/values";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../../../convex/_generated/server";
import { EMBEDDING_DIMENSIONS } from "../../../convex/_ai/legacyEmbeddings";
import { getUtf8ByteLength } from "../../../convex/ragV2/chunkBudget";
import { stableChunkId } from "../../../convex/ragV2/parser";
import schema from "../../../convex/schema";
import { readRepositoryAiAccessSnapshot } from "../../../convex/repositories/aiReadiness";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../../convex/users/legal";

const timerApi = vi as unknown as {
  advanceTimersByTime?: (milliseconds: number) => void;
  advanceTimersByTimeAsync?: (milliseconds: number) => Promise<void>;
};

async function yieldToRuntime(): Promise<void> {
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

async function advanceTestTime(milliseconds: number): Promise<void> {
  if (timerApi.advanceTimersByTimeAsync) {
    await timerApi.advanceTimersByTimeAsync(milliseconds);
    return;
  }
  if (timerApi.advanceTimersByTime) {
    await yieldToRuntime();
    timerApi.advanceTimersByTime(milliseconds);
    await yieldToRuntime();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const chunkedFileContent = Array.from(
  { length: 65 },
  (_, index) => `export const fn${index} = () => { return ${index}; };`,
).join("\n");
const oversizedFileContent = `export function oversized(${"parameterName, ".repeat(
  5_000,
)}) { return "stored-tail-marker"; }`;
const multibyteLongLineFileContent = `export function localized() { return "${"한글🙂".repeat(
  85_000,
)}다국어-tail"; }`;
const embeddingErrorFileContent = "export const value = 1;";

const EMBEDDING_ENDPOINT = "https://api.openai.com/v1/embeddings";

type BatchRequestBody = {
  model: string;
  input: string[];
  dimensions: number;
};

function parseBatchRequest(init?: RequestInit): BatchRequestBody {
  return JSON.parse(String(init?.body)) as BatchRequestBody;
}

function createVector(seed = 0): Array<number> {
  return Array.from(
    { length: EMBEDDING_DIMENSIONS },
    (_, index) => seed + index / 10_000,
  );
}

function createBatchResponse(
  count: number,
  tokens = Math.max(1, count),
): Response {
  return new Response(
    JSON.stringify({
      model: EMBEDDING_MODEL,
      data: Array.from({ length: count }, (_, index) => ({
        index,
        embedding: createVector(index + 1),
      })),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const getById = internalQuery({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => await ctx.db.get(args.repositoryId),
});

const getAiAccessSnapshot = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const snapshot = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.expectedIndexVersion,
    );
    return snapshot ? { indexVersion: snapshot.indexVersion } : null;
  },
});

const getRepositoryFilesPage = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const repository = await ctx.db.get(args.repositoryId);
    if (repository?.name === "chunked") {
      return {
        files: [
          {
            path: "chunked.ts",
            url: "https://storage.test/chunked.ts",
            language: "typescript",
            size: chunkedFileContent.length,
            isText: true,
          },
        ],
        cursor: null,
        hasMore: false,
      };
    }

    if (repository?.name === "oversized") {
      return {
        files: [
          {
            path: "oversized.ts",
            url: "https://storage.test/oversized.ts",
            language: "typescript",
            size: oversizedFileContent.length,
            isText: true,
          },
        ],
        cursor: null,
        hasMore: false,
      };
    }

    if (repository?.name === "multibyte-long-line") {
      return {
        files: [
          {
            path: "multibyte-long-line.ts",
            url: "https://storage.test/multibyte-long-line.ts",
            language: "typescript",
            size: getUtf8ByteLength(multibyteLongLineFileContent),
            isText: true,
          },
        ],
        cursor: null,
        hasMore: false,
      };
    }

    if (repository?.name.startsWith("embedding-error")) {
      if (args.cursor !== undefined) {
        return { files: [], cursor: null, hasMore: false };
      }

      return {
        files: [
          {
            path: "embedding-error.ts",
            url: "https://storage.test/embedding-error.ts",
            language: "typescript",
            size: embeddingErrorFileContent.length,
            isText: true,
          },
        ],
        cursor: "remaining-files",
        hasMore: true,
      };
    }

    if (repository?.name === "binary") {
      return {
        files: [
          {
            path: "assets/image.png",
            url: "https://storage.test/image.png",
            language: undefined,
            size: 128,
            isText: false,
          },
        ],
        cursor: null,
        hasMore: false,
      };
    }

    if (args.cursor === undefined) {
      return { files: [], cursor: "next-page", hasMore: true };
    }
    if (args.cursor === "middle-page") {
      return { files: [], cursor: "final-page", hasMore: true };
    }

    return { files: [], cursor: null, hasMore: false };
  },
});

const cleanupOldChunks = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    currentVersion: v.number(),
    batchSize: v.number(),
  },
  handler: async (ctx, args) => {
    const oldChunks = await ctx.db
      .query("repoChunks")
      .withIndex("by_index_version", (q) =>
        q.eq("repositoryId", args.repositoryId),
      )
      .filter((q) => q.lt(q.field("indexVersion"), args.currentVersion))
      .take(1);

    for (const chunk of oldChunks) {
      await ctx.db.delete(chunk._id);
    }

    const nextOldChunk = await ctx.db
      .query("repoChunks")
      .withIndex("by_index_version", (q) =>
        q.eq("repositoryId", args.repositoryId),
      )
      .filter((q) => q.lt(q.field("indexVersion"), args.currentVersion))
      .first();

    return { deleted: oldChunks.length, hasMore: nextOldChunk !== null };
  },
});

const recordEmbeddingUsage = internalMutation({
  args: {
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    tokens: v.number(),
    model: v.string(),
    provider: v.literal("google"),
    billingTier: v.union(v.literal("free"), v.literal("paid")),
  },
  handler: async () => {
    throw new Error("sensitive-metering-secret");
  },
});

const noopIndexRepository = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    expectedIndexVersion: v.number(),
  },
  handler: async () => ({ success: true }),
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/ragV2/action.ts": () =>
    import("../../../convex/ragV2/action"),
  "../../../convex/_ai/embeddingBilling.ts": () =>
    import("../../../convex/_ai/embeddingBilling"),
  "../../../convex/ragV2/internalQuery.ts": () =>
    import("../../../convex/ragV2/internalQuery"),
  "../../../convex/ragV2/internalMutation.ts": () =>
    import("../../../convex/ragV2/internalMutation"),
  "../../../convex/repositories/internalQuery.ts": async () => ({
    getById,
    getAiAccessSnapshot,
  }),
  "../../../convex/repoIndexing/internalQuery.ts": async () => ({
    getRepositoryFilesPage,
  }),
  "../../../convex/repoIndexing/mutation.ts": async () => ({
    cleanupOldChunks,
  }),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
  "../../../convex/repoIndexing/action.ts": async () => ({
    indexRepository: noopIndexRepository,
  }),
  "../../../convex/tokenUsage/internalMutation.ts": async () => ({
    recordEmbeddingUsage,
  }),
  "../../../convex/subscriptions/internalQuery.ts": () =>
    import("../../../convex/subscriptions/internalQuery"),
  "../../../convex/users/internalQuery.ts": () =>
    import("../../../convex/users/internalQuery"),
};

const originalPaidApiKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  ragStatus: "pending" | "indexing",
  indexVersion = 3,
  name = "repo",
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    await ctx.db.insert("userProfiles", {
      userId,
      githubUsername: "owner",
      minimumAgeAttestedAt: now,
      professionalUseAttestedAt: now,
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: 101,
      ownerGithubAccountId: "5001",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexProgressAt: Date.now(),
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId: 101,
      githubRepositoryId: 1001,
      githubRepo: `owner/${name}`,
      githubRepoKey: `owner/${name}`,
      name,
      githubUrl: `https://github.com/owner/${name}`,
      githubVisibility: "public",
      licenseKey: "mit",
      licenseSpdxId: "MIT",
      licenseOsiApproved: true,
      licenseOsiCheckedAt: now,
      repositoryMetadataCheckedAt: now,
      isActive: true,
      indexVersion,
      indexStatus: "completed",
      ragStatus,
      ragEmbeddingMode: ragStatus === "indexing" ? "keyword_only" : undefined,
      ragEmbeddingBillingTier: ragStatus === "indexing" ? "paid" : undefined,
      ragEmbeddingKey: undefined,
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
  });
}

async function seedContinuation(
  t: ReturnType<typeof convexTest>,
  repositoryId: Id<"repositories">,
  args: {
    phase: "files" | "cleanup";
    cursor?: string;
    token: string;
    totalChunks?: number;
    successCount?: number;
    errorCount?: number;
    processedFiles?: number;
  },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.patch(repositoryId, {
      ragIndexPhase: args.phase,
      ragIndexCursor: args.cursor,
      ragIndexFileOffset: 0,
      ragIndexChunkOffset: 0,
      ragContinuationToken: args.token,
      ragTotalChunks: args.totalChunks ?? 0,
      ragIndexedChunks: args.successCount ?? 0,
      ragFailedChunks: args.errorCount ?? 0,
      ragProcessedFiles: args.processedFiles ?? 0,
    });
  });
}

async function insertOldChunks(
  t: ReturnType<typeof convexTest>,
  repositoryId: Id<"repositories">,
  count: number,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    for (let index = 0; index < count; index++) {
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:2`,
        chunkId: `old-${index}`,
        path: `old-${index}.ts`,
        language: "typescript",
        code: `const old${index} = true;`,
        startLine: 1,
        endLine: 1,
        symbols: [`old${index}`],
        embedding: [0.1],
        searchableText: `old${index}`,
        contentHash: `hash-${index}`,
        indexVersion: 2,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-paid-key";
  vi.useFakeTimers();
});

afterEach(() => {
  if (originalPaidApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalPaidApiKey;
  }
  globalThis.fetch = originalFetch;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function finishPendingRagContinuations(
  t: ReturnType<typeof convexTest>,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    await advanceTestTime(1);
    await t.finishInProgressScheduledFunctions();
    const hasPendingRagWork = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).some(
        (scheduled) =>
          scheduled.name === "ragV2/action:generateChunkEmbeddings" &&
          (scheduled.state.kind === "pending" ||
            scheduled.state.kind === "inProgress"),
      ),
    );
    if (!hasPendingRagWork) {
      return;
    }
  }
  throw new Error("RAG continuation fixture did not reach a terminal state");
}

describe("RAG embedding work continuations", () => {
  it("claims an initial call and atomically schedules bounded work", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "pending");

    const result = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      { repositoryId },
    );

    expect(result).toEqual({
      success: true,
      totalChunks: 0,
      successCount: 0,
      errorCount: 0,
    });

    const firstWorkState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(firstWorkState.repository).toMatchObject({
      indexVersion: 3,
      ragStatus: "indexing",
      ragEmbeddingMode: "keyword_only",
      ragIndexPhase: "files",
      ragIndexCursor: "next-page",
      ragIndexFileOffset: 0,
      ragIndexChunkOffset: 0,
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
    });
    expect(firstWorkState.repository?.ragContinuationToken).toEqual(
      expect.any(String),
    );
    expect(
      firstWorkState.scheduled.filter(
        (scheduled) =>
          scheduled.name === "ragV2/action:generateChunkEmbeddings",
      ),
    ).toHaveLength(1);

    await finishPendingRagContinuations(t);

    const completedState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(completedState.repository).toMatchObject({
      indexVersion: 3,
      ragStatus: "completed",
      ragEmbeddingMode: "keyword_only",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
    });
    expect(completedState.repository?.ragIndexPhase).toBeUndefined();
    expect(completedState.repository?.ragContinuationToken).toBeUndefined();
    const ragActions = completedState.scheduled.filter(
      (scheduled) => scheduled.name === "ragV2/action:generateChunkEmbeddings",
    );
    expect(ragActions).toHaveLength(2);
    expect(
      ragActions.every((scheduled) => scheduled.state.kind === "success"),
    ).toBe(true);
  });

  it.each(["503", "timeout"] as const)(
    "retries the exact source cursor after a transient %s and then completes",
    async (failure) => {
      const t = convexTest(schema, modules);
      const repositoryId = await insertRepository(
        t,
        "pending",
        3,
        `embedding-error-transient-${failure}`,
      );
      let sourceRequests = 0;
      let embeddingRequests = 0;
      globalThis.fetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          if (url === "https://storage.test/embedding-error.ts") {
            sourceRequests++;
            if (sourceRequests === 1) {
              if (failure === "503") {
                return new Response("temporarily unavailable", {
                  status: 503,
                });
              }
              throw new Error("source request timed out");
            }
            return new Response(embeddingErrorFileContent, { status: 200 });
          }

          if (url === EMBEDDING_ENDPOINT) {
            embeddingRequests++;
            const body = parseBatchRequest(init);
            return createBatchResponse(body.input.length);
          }

          throw new Error(`Unexpected fetch: ${url}`);
        },
      ) as unknown as typeof fetch;
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const firstAttempt = await t.action(
        internal.ragV2.action.generateChunkEmbeddings,
        { repositoryId },
      );
      const retryState = await t.run(async (ctx) => ({
        repository: await ctx.db.get(repositoryId),
        chunks: await ctx.db
          .query("repoChunks")
          .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
          .collect(),
      }));

      expect(firstAttempt).toEqual({
        success: true,
        totalChunks: 0,
        successCount: 0,
        errorCount: 0,
      });
      expect(sourceRequests).toBe(1);
      expect(embeddingRequests).toBe(0);
      expect(retryState.repository).toMatchObject({
        ragStatus: "indexing",
        ragIndexPhase: "files",
        ragIndexFileOffset: 0,
        ragIndexChunkOffset: 0,
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        ragProcessedFiles: 0,
        ragContinuationToken: expect.any(String),
      });
      expect(retryState.repository?.ragIndexCursor).toBeUndefined();
      expect(retryState.chunks).toHaveLength(0);

      await advanceTestTime(15_000);
      await finishPendingRagContinuations(t);

      const completedState = await t.run(async (ctx) => ({
        repository: await ctx.db.get(repositoryId),
        chunks: await ctx.db
          .query("repoChunks")
          .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
          .collect(),
      }));
      expect(sourceRequests).toBe(2);
      expect(embeddingRequests).toBe(0);
      expect(completedState.repository).toMatchObject({
        ragStatus: "completed",
        ragEmbeddingMode: "keyword_only",
        ragTotalChunks: 1,
        ragIndexedChunks: 1,
        ragFailedChunks: 0,
      });
      expect(completedState.chunks).toHaveLength(1);
      expect(completedState.chunks[0]).toMatchObject({});
    },
  );

  it("terminates a source retry at the declared maximum without scheduling more provider work", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "indexing",
      3,
      "embedding-error-source-max",
    );
    await seedContinuation(t, repositoryId, {
      phase: "files",
      token: "source-max-claim",
    });
    let sourceRequests = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === "https://storage.test/embedding-error.ts") {
        sourceRequests++;
        return new Response("still unavailable", { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      {
        repositoryId,
        indexVersion: 3,
        phase: "files",
        fileOffset: 0,
        chunkOffset: 0,
        claimToken: "source-max-claim",
        transientFileFetchAttempt: 32,
      },
    );
    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));

    expect(result.success).toBe(false);
    expect(sourceRequests).toBe(1);
    expect(state.repository).toMatchObject({
      ragStatus: "failed",
      ragError: expect.stringContaining("exhausted 32 retries"),
    });
    expect(state.repository?.ragContinuationToken).toBeUndefined();
    expect(
      state.scheduled.some(
        (job) =>
          job.name === "ragV2/action:generateChunkEmbeddings" &&
          job.state.kind === "pending",
      ),
    ).toBe(false);
  });

  it("continues a large file at the embedding-batch boundary", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "pending", 3, "chunked");
    const embeddingBatchSizes: Array<number> = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://storage.test/chunked.ts") {
          return new Response(chunkedFileContent, { status: 200 });
        }

        if (url === EMBEDDING_ENDPOINT) {
          const body = parseBatchRequest(init);
          embeddingBatchSizes.push(body.input.length);
          expect(body).toMatchObject({
            model: EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
          });
          return createBatchResponse(body.input.length);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    ) as unknown as typeof fetch;

    const firstBatch = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      { repositoryId },
    );
    expect(firstBatch).toEqual({
      success: true,
      totalChunks: 65,
      successCount: 32,
      errorCount: 0,
    });

    const checkpoint = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(checkpoint.repository).toMatchObject({
      ragStatus: "indexing",
      ragEmbeddingMode: "keyword_only",
      ragIndexPhase: "files",
      ragIndexFileOffset: 0,
      ragIndexChunkOffset: 32,
      ragTotalChunks: 65,
      ragIndexedChunks: 32,
      ragFailedChunks: 0,
      ragProcessedFiles: 0,
    });
    expect(
      checkpoint.scheduled.filter(
        (scheduled) =>
          scheduled.name === "ragV2/action:generateChunkEmbeddings",
      ),
    ).toHaveLength(1);

    await drainScheduledFunctions(t);

    const completedState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 3),
        )
        .collect(),
    }));
    expect(completedState.repository).toMatchObject({
      ragStatus: "completed",
      ragEmbeddingMode: "keyword_only",
      ragTotalChunks: 65,
      ragIndexedChunks: 65,
      ragFailedChunks: 0,
    });
    expect(completedState.chunks).toHaveLength(65);
    expect(
      completedState.chunks.every(
        (chunk) =>
          chunk.embedding === undefined && chunk.embeddingKey === undefined,
      ),
    ).toBe(true);
    expect(embeddingBatchSizes).toEqual([]);
  });

  it("skips a non-text file before fetching its stored content", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "pending", 3, "binary");
    const fetchMock = vi.fn(async () => {
      throw new Error("Non-text RAG files must not be fetched");
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      { repositoryId },
    );
    await finishPendingRagContinuations(t);

    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(result).toEqual({
      success: true,
      totalChunks: 0,
      successCount: 0,
      errorCount: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository).toMatchObject({
      indexVersion: 3,
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
    });
  });

  it("completes in keyword-only mode when AI credentials are missing", async () => {
    delete process.env.OPENAI_API_KEY;

    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "embedding-error-config",
    );
    let embeddingRequests = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url === "https://storage.test/embedding-error.ts") {
        return new Response(embeddingErrorFileContent, { status: 200 });
      }
      if (url === EMBEDDING_ENDPOINT) {
        embeddingRequests++;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      { repositoryId },
    );
    await drainScheduledFunctions(t);

    const completedState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 3),
        )
        .collect(),
    }));
    expect(result).toEqual({
      success: true,
      totalChunks: 1,
      successCount: 1,
      errorCount: 0,
    });
    expect(embeddingRequests).toBe(0);
    expect(completedState.repository).toMatchObject({
      ragStatus: "completed",
      ragEmbeddingMode: "keyword_only",
      ragEmbeddingError: expect.stringContaining("embeddings are retired"),
      ragTotalChunks: 1,
      ragIndexedChunks: 1,
      ragFailedChunks: 0,
    });
    expect(completedState.repository?.ragEmbeddingKey).toBeUndefined();
    expect(completedState.chunks).toHaveLength(1);
    expect(completedState.chunks[0].embedding).toBeUndefined();
    expect(completedState.chunks[0].embeddingKey).toBeUndefined();
  });

  it("indexes keyword-only without OpenAI requests even when a key is configured", async () => {
    process.env.OPENAI_API_KEY = "configured-generation-key";

    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "embedding-error-config",
    );
    let embeddingRequests = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url === "https://storage.test/embedding-error.ts") {
        return new Response(embeddingErrorFileContent, { status: 200 });
      }
      if (url.startsWith("https://api.openai.com/")) {
        embeddingRequests++;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      { repositoryId },
    );
    await drainScheduledFunctions(t);

    const completedState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 3),
        )
        .collect(),
    }));
    expect(result).toEqual({
      success: true,
      totalChunks: 1,
      successCount: 1,
      errorCount: 0,
    });
    expect(embeddingRequests).toBe(0);
    expect(completedState.repository).toMatchObject({
      ragStatus: "completed",
      ragEmbeddingMode: "keyword_only",
      ragEmbeddingError: expect.stringContaining("embeddings are retired"),
      ragTotalChunks: 1,
      ragIndexedChunks: 1,
      ragFailedChunks: 0,
    });
    expect(completedState.repository?.ragEmbeddingKey).toBeUndefined();
    expect(completedState.chunks).toHaveLength(1);
    expect(completedState.chunks[0].embedding).toBeUndefined();
    expect(completedState.chunks[0].embeddingKey).toBeUndefined();
  });

  it("loads counters from the claimed checkpoint and rejects duplicate work", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "indexing");
    await seedContinuation(t, repositoryId, {
      phase: "files",
      cursor: "middle-page",
      token: "claim-once",
      totalChunks: 7,
      successCount: 5,
      errorCount: 2,
      processedFiles: 100,
    });
    await insertOldChunks(t, repositoryId, 2);

    const continuationArgs = {
      repositoryId,
      indexVersion: 3,
      phase: "files" as const,
      cursor: "middle-page",
      fileOffset: 0,
      chunkOffset: 0,
      claimToken: "claim-once",
    };
    const first = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      continuationArgs,
    );
    const duplicate = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      continuationArgs,
    );

    expect(first).toEqual({
      success: false,
      totalChunks: 7,
      successCount: 5,
      errorCount: 2,
    });
    expect(duplicate.success).toBe(false);

    const checkpoint = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(checkpoint.repository).toMatchObject({
      ragStatus: "indexing",
      ragIndexPhase: "files",
      ragIndexCursor: "final-page",
      ragTotalChunks: 7,
      ragIndexedChunks: 5,
      ragFailedChunks: 2,
      ragProcessedFiles: 100,
    });
    expect(
      checkpoint.scheduled.filter(
        (scheduled) =>
          scheduled.name === "ragV2/action:generateChunkEmbeddings",
      ),
    ).toHaveLength(1);

    await drainScheduledFunctions(t);

    const completedState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      oldChunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 2),
        )
        .collect(),
    }));
    expect(completedState.repository).toMatchObject({
      indexVersion: 3,
      ragStatus: "failed",
      ragTotalChunks: 7,
      ragIndexedChunks: 5,
      ragFailedChunks: 2,
      ragError: "RAG embedding completed with 2 errors",
    });
    expect(completedState.oldChunks).toHaveLength(2);
  });

  it("keeps prior-version chunks isolated until the new generation succeeds", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "indexing");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(repositoryId, {
        ragIndexPhase: "files",
        ragIndexFileOffset: 0,
        ragIndexChunkOffset: 0,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:2`,
        chunkId: "shared-chunk",
        path: "old.ts",
        language: "typescript",
        code: "const value = 'old';",
        startLine: 1,
        endLine: 1,
        symbols: ["value"],
        embedding: [0.1],
        searchableText: "old value",
        contentHash: "old-hash",
        indexVersion: 2,
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.mutation(internal.ragV2.internalMutation.upsertChunks, {
      repositoryId,
      indexVersion: 3,
      chunks: [
        {
          chunkId: "shared-chunk",
          path: "new.ts",
          language: "typescript",
          code: "const value = 'new';",
          startLine: 1,
          endLine: 1,
          symbols: ["value"],
          searchableText: "new value",
          contentHash: "new-hash",
        },
      ],
    });

    const versions = await t.run(async (ctx) =>
      (
        await Promise.all(
          [2, 3].map((indexVersion) =>
            ctx.db
              .query("repoChunks")
              .withIndex("by_index_version_and_chunk", (q) =>
                q
                  .eq("repositoryId", repositoryId)
                  .eq("indexVersion", indexVersion)
                  .eq("chunkId", "shared-chunk"),
              )
              .unique(),
          ),
        )
      ).filter((chunk) => chunk !== null),
    );
    expect(versions.map((chunk) => chunk.indexVersion).sort()).toEqual([2, 3]);
    const currentVersion = versions.find((chunk) => chunk.indexVersion === 3);
    expect(currentVersion?.embedding).toBeUndefined();
    expect(currentVersion?.embeddingKey).toBeUndefined();
  });

  it("cleans previous-version chunks without removing current chunks", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "indexing");
    const stableId = stableChunkId("src/new.ts:1:1");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:2`,
        chunkId: "65d09ed6",
        path: "src/previous.ts",
        language: "typescript",
        code: "export const previous = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["previous"],
        searchableText: "previous",
        contentHash: "previous-hash",
        indexVersion: 2,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:3`,
        chunkId: stableId,
        path: "src/new.ts",
        language: "typescript",
        code: "export const current = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["current"],
        searchableText: "current",
        contentHash: "current-hash",
        indexVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
    });

    expect(stableId).toHaveLength(32);
    await expect(
      t.mutation(internal.repoIndexing.mutation.cleanupOldChunks, {
        repositoryId,
        currentVersion: 3,
        batchSize: 32,
      }),
    ).resolves.toMatchObject({ deleted: 1, hasMore: false });

    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId),
        )
        .collect(),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      chunkId: stableId,
      indexVersion: 3,
      path: "src/new.ts",
    });
  });

  it("runs old-chunk cleanup as one bounded batch per action", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "indexing");
    await seedContinuation(t, repositoryId, {
      phase: "cleanup",
      token: "cleanup-once",
    });
    await insertOldChunks(t, repositoryId, 2);

    const firstCleanup = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      {
        repositoryId,
        indexVersion: 3,
        phase: "cleanup",
        fileOffset: 0,
        chunkOffset: 0,
        claimToken: "cleanup-once",
      },
    );
    expect(firstCleanup.success).toBe(true);

    const firstCleanupState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      oldChunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId),
        )
        .collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(firstCleanupState.repository).toMatchObject({
      ragStatus: "indexing",
      ragIndexPhase: "cleanup",
    });
    expect(firstCleanupState.repository?.ragContinuationToken).toEqual(
      expect.any(String),
    );
    expect(firstCleanupState.oldChunks).toHaveLength(1);
    expect(
      firstCleanupState.scheduled.filter(
        (scheduled) =>
          scheduled.name === "ragV2/action:generateChunkEmbeddings",
      ),
    ).toHaveLength(1);

    await drainScheduledFunctions(t);

    const completedState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      oldChunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId),
        )
        .collect(),
    }));
    expect(completedState.repository?.ragStatus).toBe("completed");
    expect(completedState.oldChunks).toHaveLength(0);
  });

  it("rejects a continuation that does not own the current generation", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "indexing", 4);
    await seedContinuation(t, repositoryId, {
      phase: "files",
      cursor: "stale-page",
      token: "stale-token",
      totalChunks: 7,
      successCount: 5,
      errorCount: 2,
    });
    const before = await t.run(async (ctx) => ctx.db.get(repositoryId));

    const result = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      {
        repositoryId,
        indexVersion: 3,
        phase: "files",
        cursor: "stale-page",
        fileOffset: 0,
        chunkOffset: 0,
        claimToken: "stale-token",
      },
    );

    expect(result).toEqual({
      success: false,
      totalChunks: 7,
      successCount: 5,
      errorCount: 2,
    });

    const after = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(after.repository).toEqual(before);
    expect(after.scheduled).toHaveLength(0);
  });

  it("serves completed keyword-only indexes without calling AI", async () => {
    process.env.OPENAI_API_KEY = "configured-generation-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "pending", 3, "keyword");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(repositoryId, {
        ragStatus: "completed",
        ragEmbeddingMode: "keyword_only",
        ragEmbeddingKey: undefined,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:3`,
        chunkId: "keyword-result",
        path: "src/keyword.ts",
        language: "typescript",
        code: "export const uniqueNeedle = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["uniqueNeedle"],
        searchableText: "uniqueNeedle export const true",
        contentHash: "keyword-hash",
        indexVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("AI must not be called in keyword-only mode");
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const results = await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId,
      indexVersion: 3,
      query: "uniqueNeedle",
      topK: 5,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      chunkId: "keyword-result",
      path: "src/keyword.ts",
    });
  });

  it("rejects more than eight unique language filters before searching", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "language-filter-limit",
    );
    const fetchMock = vi.fn(async () => createBatchResponse(1, 3));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      t.action(internal.ragV2.action.hybridSearch, {
        repositoryId,
        indexVersion: 3,
        query: "bounded language filters",
        filters: {
          language: [
            "TypeScript",
            "JavaScript",
            "Python",
            "Java",
            "Go",
            "Rust",
            "C",
            "C++",
            "C#",
          ],
        },
      }),
    ).rejects.toThrow("Language filters are limited to 8 values");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
