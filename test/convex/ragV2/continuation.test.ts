import { convexTest } from "convex-test";
import {
  drainScheduledFunctions,
  runNextScheduledFunctions,
} from "../scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v } from "convex/values";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../../../convex/_generated/server";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EmbeddingProviderError,
} from "../../../convex/_ai/retrievalEmbeddings";
import { PRICING, getFreeIncludedTokens } from "../../../convex/_ai/config";
import {
  buildFreeTierEmbeddingDocument,
  getNextRagEmbeddingProviderRetry,
  buildRagEmbeddingReservationKey,
  CODE_EMBEDDING_KEY,
} from "../../../convex/ragV2/action";
import {
  buildRagEmbeddingProviderAttemptKey,
  estimateRagEmbeddingCacheBytes,
  getUtf8ByteLength,
  MAX_RAG_CHUNK_CODE_BYTES,
  MAX_RAG_EMBEDDING_CACHE_BYTES,
  MAX_RAG_SEARCHABLE_TEXT_BYTES,
  RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS,
} from "../../../convex/ragV2/chunkBudget";
import {
  parseCodeIntoChunks,
  stableChunkId,
} from "../../../convex/ragV2/parser";
import * as embeddingPolicyRuntime from "../../../convex/repositories/embeddingPolicyRuntime";
import * as embeddingBillingRuntime from "../../../convex/_ai/embeddingBilling";
import schema from "../../../convex/schema";
import { readRepositoryAiAccessSnapshot } from "../../../convex/repositories/aiReadiness";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../../convex/users/legal";

let resolveEmbeddingPolicyMock: ReturnType<typeof vi.fn>;

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

function createPolicyResolution(
  repository: {
    _id: Id<"repositories">;
    userId: Id<"users">;
    installationId: number;
    githubRepositoryId: number;
    githubRepo: string;
    githubVisibility?: "public" | "private" | "internal";
    licenseKey?: string;
    licenseSpdxId?: string;
    licenseOsiApproved?: boolean;
    repositoryMetadataCheckedAt?: number;
    licenseOsiCheckedAt?: number;
    indexVersion: number;
    ragEmbeddingBillingTier?: "free" | "paid";
    ragEmbeddingKey?: string;
  },
  route: "free" | "paid",
) {
  return {
    status:
      route === "free"
        ? ("verified_free" as const)
        : ("verified_paid" as const),
    policy: { route, allowPaidFallback: route === "free" },
    attestation: {
      repositoryId: repository._id,
      userId: repository.userId,
      installationId: repository.installationId,
      githubRepositoryId: repository.githubRepositoryId,
      githubRepo: repository.githubRepo,
      githubVisibility: repository.githubVisibility,
      licenseKey: repository.licenseKey,
      licenseSpdxId: repository.licenseSpdxId,
      licenseOsiApproved: repository.licenseOsiApproved,
      repositoryMetadataCheckedAt: repository.repositoryMetadataCheckedAt,
      licenseOsiCheckedAt: repository.licenseOsiCheckedAt,
      indexVersion: repository.indexVersion,
      ragEmbeddingBillingTier: repository.ragEmbeddingBillingTier,
      ragEmbeddingKey: repository.ragEmbeddingKey,
    },
  };
}

function createRagPublicationExpectation(
  repository: Parameters<typeof createPolicyResolution>[0],
  overrides: Partial<{
    embeddingBillingTier: "free" | "paid";
    phase: "files" | "cleanup";
    cursor: string;
    fileOffset: number;
    chunkOffset: number;
  }> = {},
) {
  if (repository.githubRepositoryId === undefined) {
    throw new Error("repository has no immutable GitHub identity");
  }
  return {
    userId: repository.userId,
    installationId: repository.installationId,
    githubRepositoryId: repository.githubRepositoryId,
    githubRepo: repository.githubRepo,
    githubVisibility: repository.githubVisibility,
    licenseKey: repository.licenseKey,
    licenseSpdxId: repository.licenseSpdxId,
    licenseOsiApproved: repository.licenseOsiApproved,
    repositoryMetadataCheckedAt: repository.repositoryMetadataCheckedAt,
    licenseOsiCheckedAt: repository.licenseOsiCheckedAt,
    embeddingBillingTier: overrides.embeddingBillingTier ?? "paid",
    embeddingKey: CODE_EMBEDDING_KEY,
    phase: overrides.phase ?? "files",
    cursor: overrides.cursor,
    fileOffset: overrides.fileOffset ?? 0,
    chunkOffset: overrides.chunkOffset ?? 0,
  };
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

const durableRetryBillingModules = {
  ...modules,
  "../../../convex/_ai/embeddingBilling.ts": async () => ({
    PAID_USAGE_LIMIT_MESSAGE: "paid usage unavailable",
    resolveEmbeddingBillingDecision: async (
      _ctx: unknown,
      args: {
        policy: { route: "free" | "paid"; allowPaidFallback: boolean };
      },
    ) => ({
      policy: args.policy,
      canEmbed: true,
      paidUsageAllowed: true,
    }),
    executeEmbeddingRequest: async () => {
      throw new EmbeddingProviderError(
        "request",
        "transient reservation failure",
        { route: "paid", retryable: true, durableRetrySafe: true },
      );
    },
  }),
};

const vectorSearchModules = {
  ...modules,
  "../../../convex/tokenUsage/internalMutation.ts": () =>
    import("../../../convex/tokenUsage/internalMutation"),
};

const staleLegalAttestationReadModules = {
  ...modules,
  "../../../convex/users/internalQuery.ts": async () => ({
    hasCurrentLegalAttestation: internalQuery({
      args: { userId: v.id("users") },
      handler: async () => false,
    }),
  }),
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
      ragEmbeddingMode: ragStatus === "indexing" ? "openai" : undefined,
      ragEmbeddingBillingTier: ragStatus === "indexing" ? "paid" : undefined,
      ragEmbeddingKey:
        ragStatus === "indexing" ? CODE_EMBEDDING_KEY : undefined,
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

async function blockPaidUsage(
  t: ReturnType<typeof convexTest>,
  repositoryId: Id<"repositories">,
  remainingTokens = 0,
): Promise<void> {
  await t.run(async (ctx) => {
    const repository = await ctx.db.get(repositoryId);
    if (!repository) {
      throw new Error("repository not found");
    }
    const now = Date.now();
    await ctx.db.insert("subscriptions", {
      userId: repository.userId,
      plan: "free",
      status: "active",
      includedTokens: getFreeIncludedTokens(Date.now()),
      purchasedTokens: 0,
      serviceFeeRate: 0.25,
      periodStart: now,
      periodEnd: now + 30 * 24 * 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    });
    const usedTokens = getFreeIncludedTokens(Date.now()) - remainingTokens;
    await ctx.db.insert("tokenUsage", {
      userId: repository.userId,
      repositoryId,
      usageType: "chat",
      inputTokens: usedTokens,
      outputTokens: 0,
      totalTokens: usedTokens,
      inputCostCents: 0,
      outputCostCents: 0,
      baseCostCents: 0,
      serviceFeeCents: 0,
      totalCostCents: 0,
      purchasedTokensDebited: 0,
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      serviceFeeRate: PRICING.PLATFORM_FEE_FREE,
      createdAt: now,
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
  resolveEmbeddingPolicyMock = vi.spyOn(
    embeddingPolicyRuntime,
    "resolveFreshRepositoryEmbeddingPolicy",
  ) as unknown as ReturnType<typeof vi.fn>;
  resolveEmbeddingPolicyMock.mockImplementation(
    async (
      _ctx: unknown,
      repository: Parameters<typeof createPolicyResolution>[0],
    ) => createPolicyResolution(repository, "paid"),
  );
  resolveEmbeddingPolicyMock.mockClear();
  (
    vi.spyOn(
      embeddingPolicyRuntime,
      "resolveStoredRagEmbeddingPolicy",
    ) as unknown as ReturnType<typeof vi.fn>
  ).mockImplementation(
    (repository: { ragEmbeddingBillingTier?: "free" | "paid" }) => {
      const route = repository.ragEmbeddingBillingTier ?? "paid";
      return { route, allowPaidFallback: route === "free" };
    },
  );
  (
    vi.spyOn(
      embeddingPolicyRuntime,
      "resolveStoredRagEmbeddingPolicyWithRefresh",
    ) as unknown as ReturnType<typeof vi.fn>
  ).mockImplementation(
    async (
      _ctx: unknown,
      repository: { ragEmbeddingBillingTier?: "free" | "paid" },
    ) => {
      const route = repository.ragEmbeddingBillingTier ?? "paid";
      return createPolicyResolution(
        repository as Parameters<typeof createPolicyResolution>[0],
        route,
      );
    },
  );
  (
    vi.spyOn(
      embeddingPolicyRuntime,
      "assertRepositoryEmbeddingProviderRequest",
    ) as unknown as ReturnType<typeof vi.fn>
  ).mockResolvedValue(undefined);
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
  it("uses bounded exponential backoff for safe provider retries", () => {
    expect(getNextRagEmbeddingProviderRetry()).toEqual({
      attempt: 2,
      delayMs: 10_000,
    });
    expect(getNextRagEmbeddingProviderRetry(2)).toEqual({
      attempt: 3,
      delayMs: 20_000,
    });
    expect(getNextRagEmbeddingProviderRetry(5)).toEqual({
      attempt: 6,
      delayMs: 120_000,
    });
    expect(
      getNextRagEmbeddingProviderRetry(RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS),
    ).toBeNull();
  });

  it("de-identifies public open-source code before unpaid embedding", () => {
    const document = buildFreeTierEmbeddingDocument({
      chunkId: "sensitive",
      path: "people/alice/private-token.ts",
      language: "typescript",
      code: [
        "export function visible(flag: boolean) {",
        "  const quotient = flag ? 8 / 2 : 0;",
        '  const doubleQuoted = "while && double.person@example.com =>";',
        "  const singleQuoted = 'switch || single.person@example.com ::';",
        "  const templateQuoted = `class ?? template.person@example.com ->`;",
        "  if (flag) /interface\\s+private@regex\\.example!==/.test('ignored');",
        "  // throw && line.person@example.com =>",
        "  /* trait || block.person@example.com :: */",
        "  <!-- static ?? html.person@example.com -> -->",
        "  # def && hash.person@example.com =>",
        "  return quotient + 1;",
        "}",
      ].join("\n"),
      startLine: 1,
      endLine: 12,
      symbols: ["visible", "quotient"],
      searchableText: "visible quotient",
      contentHash: "sensitive-hash",
    });

    expect(document.title).toBe("public-open-source-code:typescript");
    expect(document.content).toContain(
      "export function identifier ( identifier : identifier ) {",
    );
    expect(document.content).toContain("number / number");
    expect(document.content).toContain("return identifier + number ;");
    expect(document.content).not.toMatch(
      /\b(?:while|switch|class|interface|private|throw|trait|static|def)\b/,
    );
    expect(document.content).not.toMatch(/&&|\|\||=>|::|\?\?|->|@|!==/);
    expect(document.content).not.toMatch(
      /double\.person|single\.person|template\.person|regex\.example|line\.person|block\.person|html\.person|hash\.person/,
    );
  });

  it("strips both Python triple-quoted literal forms before tokenizing", () => {
    const document = buildFreeTierEmbeddingDocument({
      chunkId: "python-literals",
      path: "private/example.py",
      language: "python",
      code: [
        "def visible():",
        '    """while && triple.double@example.com =>',
        '    class Hidden: pass"""',
        "    value = '''switch || triple.single@example.com ::",
        "    trait Hidden: pass'''",
        "    return value",
      ].join("\n"),
      startLine: 1,
      endLine: 6,
      symbols: ["visible"],
      searchableText: "visible",
      contentHash: "python-literals-hash",
    });

    expect(document.content).toContain("def identifier ( ) :");
    expect(document.content).toContain("return identifier");
    expect(document.content).not.toMatch(
      /\b(?:while|class|pass|switch|trait)\b|&&|\|\||=>|::|@/,
    );
  });

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
      ragEmbeddingMode: "openai",
      ragEmbeddingKey: CODE_EMBEDDING_KEY,
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
      ragEmbeddingMode: "openai",
      ragEmbeddingKey: CODE_EMBEDDING_KEY,
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

  it("immediately reclaims AI when consent wins the initial legal-check race", async () => {
    const t = convexTest(schema, staleLegalAttestationReadModules);
    const repositoryId = await insertRepository(t, "pending", 3, "legal-race");

    await t.action(internal.ragV2.action.generateChunkEmbeddings, {
      repositoryId,
    });

    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(repository).toMatchObject({
      ragStatus: "indexing",
      ragEmbeddingMode: "openai",
      ragEmbeddingBillingTier: "paid",
      ragEmbeddingKey: CODE_EMBEDDING_KEY,
    });
    expect(repository?.ragLegalEligibilityBlockedAt).toBeUndefined();
    expect(repository?.ragLegalEligibilityBlockedIndexVersion).toBeUndefined();
  });

  it("keeps an unconsented generation usable as keyword-only with an exact recovery marker", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "legal-blocked",
    );
    await t.run(async (ctx) => {
      const repository = await ctx.db.get(repositoryId);
      if (!repository) {
        throw new Error("repository fixture disappeared");
      }
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", repository.userId))
        .unique();
      if (!profile) {
        throw new Error("profile fixture disappeared");
      }
      await ctx.db.patch(profile._id, {
        professionalUseAttestedAt: undefined,
      });
    });

    await t.action(internal.ragV2.action.generateChunkEmbeddings, {
      repositoryId,
    });

    expect(await t.run(async (ctx) => ctx.db.get(repositoryId))).toMatchObject({
      ragStatus: "indexing",
      ragEmbeddingMode: "keyword_only",
      ragLegalEligibilityBlockedAt: expect.any(Number),
      ragLegalEligibilityBlockedIndexVersion: 3,
    });
  });

  it("persists keyword-only mode when credentials disappear between continuations", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "pending");
    const fetchMock = vi.fn(async () => {
      throw new Error("AI must not be called without credentials");
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await t.action(internal.ragV2.action.generateChunkEmbeddings, {
      repositoryId,
    });
    const firstCheckpoint = await t.run(async (ctx) =>
      ctx.db.get(repositoryId),
    );
    expect(firstCheckpoint).toMatchObject({
      ragStatus: "indexing",
      ragEmbeddingMode: "openai",
      ragEmbeddingKey: CODE_EMBEDDING_KEY,
    });
    delete process.env.OPENAI_API_KEY;
    await finishPendingRagContinuations(t);

    const completedState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(completedState.repository).toMatchObject({
      ragStatus: "completed",
      ragEmbeddingMode: "keyword_only",
      ragEmbeddingError: expect.stringContaining(
        "credentials are not configured",
      ),
    });
    expect(completedState.repository?.ragEmbeddingKey).toBeUndefined();
    expect(
      completedState.scheduled
        .filter(
          (scheduled) =>
            scheduled.name === "ragV2/action:generateChunkEmbeddings",
        )
        .every((scheduled) => scheduled.state.kind === "success"),
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
      expect(embeddingRequests).toBe(1);
      expect(completedState.repository).toMatchObject({
        ragStatus: "completed",
        ragEmbeddingMode: "openai",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
        ragTotalChunks: 1,
        ragIndexedChunks: 1,
        ragFailedChunks: 0,
      });
      expect(completedState.chunks).toHaveLength(1);
      expect(completedState.chunks[0]).toMatchObject({
        embeddingKey: CODE_EMBEDDING_KEY,
        embeddingScopeKey: `${repositoryId}:3:${CODE_EMBEDDING_KEY}`,
      });
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
      ragEmbeddingMode: "openai",
      ragEmbeddingKey: CODE_EMBEDDING_KEY,
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
      ragEmbeddingMode: "openai",
      ragEmbeddingKey: CODE_EMBEDDING_KEY,
      ragTotalChunks: 65,
      ragIndexedChunks: 65,
      ragFailedChunks: 0,
    });
    expect(completedState.chunks).toHaveLength(65);
    expect(
      completedState.chunks.every(
        (chunk) =>
          chunk.embedding?.length === EMBEDDING_DIMENSIONS &&
          chunk.embeddingKey === CODE_EMBEDDING_KEY &&
          chunk.embeddingScopeKey === `${repositoryId}:3:${CODE_EMBEDDING_KEY}`,
      ),
    ).toBe(true);
    expect(embeddingBatchSizes).toEqual([32, 32, 1]);
    expect(resolveEmbeddingPolicyMock).toHaveBeenCalledOnce();
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

  it("bounds oversized chunk documents without truncating stored code", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "pending", 3, "oversized");
    const requestPayloads: Array<string> = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://storage.test/oversized.ts") {
          return new Response(oversizedFileContent, { status: 200 });
        }

        if (url === EMBEDDING_ENDPOINT) {
          const body = parseBatchRequest(init);
          requestPayloads.push(...body.input.map((input) => input));
          return createBatchResponse(body.input.length);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    ) as unknown as typeof fetch;

    const result = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      { repositoryId },
    );
    expect(result.success).toBe(true);
    expect(result.totalChunks).toBeGreaterThan(1);
    expect(result.successCount).toBe(result.totalChunks);
    expect(result.errorCount).toBe(0);

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
    expect(requestPayloads).toHaveLength(result.totalChunks);
    expect(
      requestPayloads.every(
        (payload) => new TextEncoder().encode(payload).byteLength + 128 <= 8192,
      ),
    ).toBe(true);
    expect(completedState.repository).toMatchObject({
      ragStatus: "completed",
      ragEmbeddingMode: "openai",
      ragEmbeddingKey: CODE_EMBEDDING_KEY,
      ragTotalChunks: result.totalChunks,
      ragIndexedChunks: result.totalChunks,
      ragFailedChunks: 0,
    });
    expect(completedState.chunks).toHaveLength(result.totalChunks);
    expect(completedState.chunks.map((chunk) => chunk.code).join("")).toBe(
      oversizedFileContent,
    );
    expect(
      completedState.chunks.every(
        (chunk) =>
          chunk.embeddingKey === CODE_EMBEDDING_KEY &&
          chunk.embedding?.length === EMBEDDING_DIMENSIONS,
      ),
    ).toBe(true);
  });

  it("indexes a near-limit multibyte long line in bounded documents", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "multibyte-long-line",
    );
    const embeddingBatchSizes: Array<number> = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://storage.test/multibyte-long-line.ts") {
          return new Response(multibyteLongLineFileContent, { status: 200 });
        }
        if (url === EMBEDDING_ENDPOINT) {
          const body = parseBatchRequest(init);
          embeddingBatchSizes.push(body.input.length);
          return createBatchResponse(body.input.length);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    ) as unknown as typeof fetch;

    const result = await t.action(
      internal.ragV2.action.generateChunkEmbeddings,
      { repositoryId },
    );
    expect(result.success).toBe(true);
    expect(result.totalChunks).toBeGreaterThan(1);
    expect(result.successCount).toBe(32);

    await drainScheduledFunctions(t);

    const completedState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 3),
        )
        .collect(),
      embeddingBatches: await ctx.db
        .query("ragEmbeddingBatches")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
    }));
    expect(completedState.repository).toMatchObject({
      ragStatus: "completed",
      ragTotalChunks: result.totalChunks,
      ragIndexedChunks: result.totalChunks,
      ragFailedChunks: 0,
    });
    expect(completedState.chunks).toHaveLength(result.totalChunks);
    expect(
      completedState.chunks.reduce(
        (total, chunk) => total + getUtf8ByteLength(chunk.code),
        0,
      ),
    ).toBe(getUtf8ByteLength(multibyteLongLineFileContent));
    expect(
      completedState.chunks.every(
        (chunk) =>
          getUtf8ByteLength(chunk.code) <= MAX_RAG_CHUNK_CODE_BYTES &&
          getUtf8ByteLength(chunk.searchableText) <=
            MAX_RAG_SEARCHABLE_TEXT_BYTES,
      ),
    ).toBe(true);
    expect(
      completedState.chunks.some((chunk) => chunk.code.includes("다국어-tail")),
    ).toBe(true);
    expect(
      completedState.embeddingBatches.every(
        (batch) =>
          estimateRagEmbeddingCacheBytes(batch.embeddings.length) <=
          MAX_RAG_EMBEDDING_CACHE_BYTES,
      ),
    ).toBe(true);
    const providerEmbeddingCount = embeddingBatchSizes.reduce(
      (total, size) => total + size,
      0,
    );
    expect(providerEmbeddingCount).toBeGreaterThan(0);
    expect(providerEmbeddingCount).toBeLessThanOrEqual(result.totalChunks);
    expect(embeddingBatchSizes.every((size) => size <= 32)).toBe(true);
    expect(
      completedState.chunks.every(
        (chunk) =>
          chunk.embeddingKey === CODE_EMBEDDING_KEY &&
          chunk.embedding?.length === EMBEDDING_DIMENSIONS,
      ),
    ).toBe(true);
  }, 15_000);

  it("includes full chunk source in deterministic paid reservation keys", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "pending");
    const sharedDocument = [
      {
        title: "same.ts",
        content: `Code:\n${"x".repeat(4_000)}`,
      },
    ];
    const createChunk = (tail: string) => ({
      chunkId: `chunk-${tail}`,
      path: "same.ts",
      language: "typescript",
      code: `${"x".repeat(4_000)}${tail}`,
      startLine: 1,
      endLine: 10,
      symbols: ["same"],
      signature: "export function same()",
      contentHash: "same-content-hash",
      searchableText: "same",
    });

    const first = await buildRagEmbeddingReservationKey(
      repositoryId,
      sharedDocument,
      [createChunk("first")],
    );
    const second = await buildRagEmbeddingReservationKey(
      repositoryId,
      sharedDocument,
      [createChunk("second")],
    );

    expect(first).not.toBe(second);
  });

  it("degrades a paid-only index before calling AI when account usage is blocked", async () => {
    process.env.OPENAI_API_KEY = "test-paid-key";
    resolveEmbeddingPolicyMock.mockImplementation(
      async (
        _ctx: unknown,
        repository: Parameters<typeof createPolicyResolution>[0],
      ) => createPolicyResolution(repository, "paid"),
    );
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "embedding-error-paid-billing",
    );
    await blockPaidUsage(t, repositoryId);
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
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await t.action(internal.ragV2.action.generateChunkEmbeddings, {
      repositoryId,
    });
    await drainScheduledFunctions(t);

    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(embeddingRequests).toBe(0);
    expect(repository).toMatchObject({
      ragStatus: "completed",
      ragEmbeddingMode: "keyword_only",
    });
  });

  it("retries the exact work unit and fails after the provider attempt bound", async () => {
    process.env.OPENAI_API_KEY = "test-paid-key";
    resolveEmbeddingPolicyMock.mockImplementation(
      async (
        _ctx: unknown,
        repository: Parameters<typeof createPolicyResolution>[0],
      ) => createPolicyResolution(repository, "paid"),
    );
    const t = convexTest(schema, durableRetryBillingModules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "embedding-error-safe-retry",
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

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      t.action(internal.ragV2.action.generateChunkEmbeddings, {
        repositoryId,
      }),
    ).resolves.toEqual({
      success: true,
      totalChunks: 0,
      successCount: 0,
      errorCount: 0,
    });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunks: await ctx.db.query("repoChunks").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(embeddingRequests).toBe(0);
    expect(state.repository).toMatchObject({
      ragStatus: "indexing",
      ragEmbeddingMode: "openai",
      ragEmbeddingBillingTier: "paid",
      ragIndexPhase: "files",
      ragIndexFileOffset: 0,
      ragIndexChunkOffset: 0,
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      ragContinuationToken: expect.any(String),
    });
    expect(state.repository?.ragError).toBeUndefined();
    expect(state.chunks).toHaveLength(0);
    expect(
      state.scheduled.filter(
        (scheduled) =>
          scheduled.name === "ragV2/action:generateChunkEmbeddings" &&
          scheduled.state.kind === "pending",
      ),
    ).toHaveLength(1);

    for (
      let attempt = 2;
      attempt <= RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS;
      attempt++
    ) {
      await advanceTestTime(120_000);
      await t.finishInProgressScheduledFunctions();
    }

    const terminalState = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(terminalState.repository).toMatchObject({
      ragStatus: "failed",
      ragError: expect.stringContaining(
        `exhausted ${RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS} attempts`,
      ),
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
    });
    expect(terminalState.repository?.ragContinuationToken).toBeUndefined();
    expect(
      terminalState.scheduled.filter(
        (scheduled) =>
          scheduled.name === "ragV2/action:generateChunkEmbeddings",
      ),
    ).toHaveLength(RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS - 1);
  });

  it("queues account contention beyond the provider retry limit without spending attempts", async () => {
    process.env.OPENAI_API_KEY = "test-paid-key";
    resolveEmbeddingPolicyMock.mockImplementation(
      async (
        _ctx: unknown,
        repository: Parameters<typeof createPolicyResolution>[0],
      ) => createPolicyResolution(repository, "paid"),
    );
    let busy = true;
    const execute = vi.fn(async () => {
      throw new EmbeddingProviderError(
        busy ? "reservation_busy" : "request",
        busy ? "account slot busy" : "safe pre-provider failure",
        { route: "paid", retryable: true, durableRetrySafe: true },
      );
    });
    vi.spyOn(
      embeddingBillingRuntime,
      "executeEmbeddingRequest",
    ).mockImplementation(execute);
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "embedding-error-safe-retry",
    );
    globalThis.fetch = vi.fn(
      async () => new Response(embeddingErrorFileContent, { status: 200 }),
    ) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.action(internal.ragV2.action.generateChunkEmbeddings, {
      repositoryId,
    });
    for (let i = 0; i < 8; i++) {
      expect(await runNextScheduledFunctions(t)).toBe(true);
    }
    const queued = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      usage: await ctx.db.query("tokenUsage").collect(),
    }));
    expect(queued.repository).toMatchObject({
      ragStatus: "indexing",
      ragIndexFileOffset: 0,
      ragIndexChunkOffset: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
    });
    const pending = queued.scheduled.filter(
      (x) =>
        x.name === "ragV2/action:generateChunkEmbeddings" &&
        x.state.kind === "pending",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].args[0]).toMatchObject({ embeddingQueueAttempt: 9 });
    expect(pending[0].args[0]).not.toHaveProperty("embeddingProviderAttempt");
    expect(queued.usage).toHaveLength(0);
    busy = false;
    expect(await runNextScheduledFunctions(t)).toBe(true);
    const next = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      next.find(
        (x) =>
          x.name === "ragV2/action:generateChunkEmbeddings" &&
          x.state.kind === "pending",
      )?.args[0],
    ).toMatchObject({ embeddingProviderAttempt: 2, embeddingQueueAttempt: 9 });
  });

  it("bounds account-slot waiting separately from provider attempts", async () => {
    process.env.OPENAI_API_KEY = "test-paid-key";
    resolveEmbeddingPolicyMock.mockImplementation(
      async (
        _ctx: unknown,
        repository: Parameters<typeof createPolicyResolution>[0],
      ) => createPolicyResolution(repository, "paid"),
    );
    vi.spyOn(
      embeddingBillingRuntime,
      "executeEmbeddingRequest",
    ).mockImplementation(async () => {
      throw new EmbeddingProviderError(
        "reservation_busy",
        "account slot busy",
        { route: "paid", durableRetrySafe: true },
      );
    });
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "embedding-error-safe-retry",
    );
    globalThis.fetch = vi.fn(
      async () => new Response(embeddingErrorFileContent, { status: 200 }),
    ) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.action(internal.ragV2.action.generateChunkEmbeddings, {
      repositoryId,
    });
    const repo = await t.run((ctx) => ctx.db.get(repositoryId));
    await t.action(internal.ragV2.action.generateChunkEmbeddings, {
      repositoryId,
      indexVersion: 3,
      phase: "files",
      fileOffset: 0,
      chunkOffset: 0,
      claimToken: repo!.ragContinuationToken,
      embeddingQueueAttempt: 120,
    });
    const result = await t.run((ctx) => ctx.db.get(repositoryId));
    expect(result).toMatchObject({
      ragStatus: "failed",
      ragError: expect.stringContaining("account slot remained busy"),
    });
  });

  it("rolls back paid usage when atomic RAG publication is rejected", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "indexing",
      3,
      "atomic-publication-failure",
    );
    const repository = await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        ragIndexPhase: "files",
        ragEmbeddingBillingTier: "paid",
      });
      return await ctx.db.get(repositoryId);
    });
    if (!repository) throw new Error("repository missing");
    const embeddingPublication = createRagPublicationExpectation(repository, {
      embeddingBillingTier: "paid",
    });
    const batchReservationKey = "rejected-atomic-rag";
    const reservationKey = buildRagEmbeddingProviderAttemptKey(
      batchReservationKey,
      3,
    );
    await t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
      reservationKey,
      attemptToken: `${reservationKey}:attempt`,
      userId: repository.userId,
      repositoryId,
      operation: "RAG index",
      inputCount: 1,
      providerTokenLimit: 1_024,
      provider: "openai",
      model: EMBEDDING_MODEL,
    });
    await t.mutation(internal._ai.embeddingBilling.releasePaidEmbeddingUsage, {
      reservationKey,
      attemptToken: `${reservationKey}:attempt`,
      userId: repository.userId,
      repositoryId,
      confirmedNotBilled: false,
    });

    await expect(
      t.mutation(internal.ragV2.internalMutation.commitEmbeddedChunks, {
        repositoryId,
        indexVersion: 3,
        batchReservationKey,
        embeddingKey: CODE_EMBEDDING_KEY,
        embeddingPublication,
        chunks: [
          {
            chunkId: "atomic-chunk",
            path: "atomic.ts",
            language: "typescript",
            code: "export const atomic = true;",
            startLine: 1,
            endLine: 1,
            symbols: ["atomic"],
            contentHash: "atomic-hash",
            searchableText: "atomic",
            embedding: createVector(),
            embeddingKey: CODE_EMBEDDING_KEY,
          },
        ],
        usage: {
          tokens: 9,
          model: EMBEDDING_MODEL,
          provider: "openai",
          billingTier: "paid",
          reservationKey,
          reservationAttemptToken: `${reservationKey}:attempt`,
        },
      }),
    ).rejects.toThrow("embedding usage reservation is not finalizable");

    const state = await t.run(async (ctx) => ({
      chunks: await ctx.db.query("repoChunks").collect(),
      embeddingBatches: await ctx.db.query("ragEmbeddingBatches").collect(),
      usage: await ctx.db.query("tokenUsage").collect(),
    }));
    expect(state.chunks).toHaveLength(0);
    expect(state.embeddingBatches).toHaveLength(0);
    expect(state.usage).toHaveLength(0);
  });

  it("never caches or stages a malformed generated embedding count", async () => {
    const t = convexTest(schema, modules);
    for (const scenario of [
      { suffix: "short", expectedCount: 2, actualCount: 1 },
      { suffix: "long", expectedCount: 1, actualCount: 2 },
    ]) {
      const repositoryId = await insertRepository(
        t,
        "indexing",
        3,
        `malformed-generated-batch-${scenario.suffix}`,
      );
      const repository = await t.run(async (ctx) => {
        await ctx.db.patch(repositoryId, {
          ragIndexPhase: "files",
          ragEmbeddingBillingTier: "paid",
        });
        return await ctx.db.get(repositoryId);
      });
      if (!repository) throw new Error("repository missing");
      const embeddingPublication = createRagPublicationExpectation(repository, {
        embeddingBillingTier: "paid",
      });
      const batchReservationKey = `malformed-${scenario.suffix}`;
      const providerReservationKey = buildRagEmbeddingProviderAttemptKey(
        batchReservationKey,
        3,
      );
      const attemptToken = `${providerReservationKey}:attempt`;
      await t.mutation(
        internal._ai.embeddingBilling.reservePaidEmbeddingUsage,
        {
          reservationKey: providerReservationKey,
          attemptToken,
          userId: repository.userId,
          repositoryId,
          operation: "RAG index",
          inputCount: scenario.expectedCount,
          providerTokenLimit: 2_048,
          provider: "openai",
          model: EMBEDDING_MODEL,
        },
      );
      await t.mutation(
        internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
        {
          reservationKey: providerReservationKey,
          attemptToken,
          userId: repository.userId,
          repositoryId,
        },
      );
      await expect(
        t.mutation(
          internal.ragV2.internalMutation.stageGeneratedEmbeddingBatch,
          {
            repositoryId,
            indexVersion: 3,
            batchReservationKey,
            providerReservationKey,
            providerReservationAttemptToken: attemptToken,
            embeddingKey: CODE_EMBEDDING_KEY,
            embeddingPublication,
            expectedCount: scenario.expectedCount,
            embeddings: Array.from(
              { length: scenario.actualCount },
              (_, index) => createVector(index),
            ),
            tokens: 9,
          },
        ),
      ).rejects.toThrow("invalid RAG embedding batch");
    }

    const state = await t.run(async (ctx) => ({
      caches: await ctx.db.query("ragEmbeddingBatches").collect(),
      reservations: await ctx.db.query("embeddingUsageReservations").collect(),
    }));
    expect(state.caches).toHaveLength(0);
    expect(state.reservations).toHaveLength(2);
    for (const reservation of state.reservations) {
      expect(reservation).toMatchObject({ status: "pending" });
      expect(reservation.settlementState).toBeUndefined();
      expect(reservation.settlementTokens).toBeUndefined();
    }
  });

  it("restores a paid batch after staged usage settles before publication", async () => {
    const t = convexTest(schema, vectorSearchModules);
    const repositoryId = await insertRepository(
      t,
      "indexing",
      3,
      "staged-paid-recovery",
    );
    const repository = await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        ragIndexPhase: "files",
        ragEmbeddingBillingTier: "paid",
      });
      return await ctx.db.get(repositoryId);
    });
    if (!repository) throw new Error("repository missing");
    const embeddingPublication = createRagPublicationExpectation(repository, {
      embeddingBillingTier: "paid",
    });
    const batchReservationKey = "staged-paid-rag";
    const providerReservationKey = buildRagEmbeddingProviderAttemptKey(
      batchReservationKey,
      3,
    );
    const providerReservationAttemptToken = `${providerReservationKey}:attempt`;
    await t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
      reservationKey: providerReservationKey,
      attemptToken: providerReservationAttemptToken,
      userId: repository.userId,
      repositoryId,
      operation: "RAG index",
      inputCount: 1,
      providerTokenLimit: 1_024,
      provider: "openai",
      model: EMBEDDING_MODEL,
    });
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        reservationKey: providerReservationKey,
        attemptToken: providerReservationAttemptToken,
        userId: repository.userId,
        repositoryId,
      },
    );
    const vector = createVector(7);
    await expect(
      t.mutation(internal.ragV2.internalMutation.stageGeneratedEmbeddingBatch, {
        repositoryId,
        indexVersion: 3,
        batchReservationKey,
        providerReservationKey,
        providerReservationAttemptToken,
        embeddingKey: CODE_EMBEDDING_KEY,
        embeddingPublication,
        expectedCount: 1,
        embeddings: [vector],
        tokens: 9,
        provider: "openai",
        model: EMBEDDING_MODEL,
      }),
    ).resolves.toMatchObject({ cached: true, staged: true });

    const staged = await t.run(async (ctx) => ({
      cache: await ctx.db
        .query("ragEmbeddingBatches")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", batchReservationKey),
        )
        .unique(),
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", providerReservationKey),
        )
        .unique(),
    }));
    expect(staged.cache?.embeddings).toEqual([vector]);
    expect(staged.reservation).toMatchObject({
      status: "pending",
      settlementState: "staged",
      settlementTokens: 9,
    });

    // Simulate durable settlement after the action disappears. The known usage
    // is billed while the same batch remains publishable from its cache.
    await expect(
      t.mutation(internal._ai.embeddingBilling.settleStagedEmbeddingOutcome, {
        reservationKey: providerReservationKey,
        attemptToken: providerReservationAttemptToken,
        fromScheduler: false,
      }),
    ).resolves.toMatchObject({ status: "finalized" });
    const restored = await t.mutation(
      internal.ragV2.internalMutation.commitCachedEmbeddedChunks,
      {
        repositoryId,
        indexVersion: 3,
        batchReservationKey,
        embeddingKey: CODE_EMBEDDING_KEY,
        embeddingPublication,
        chunks: [
          {
            chunkId: "recovered-staged-chunk",
            path: "recovered.ts",
            language: "typescript",
            code: "export const recovered = true;",
            startLine: 1,
            endLine: 1,
            symbols: ["recovered"],
            contentHash: "recovered-staged-hash",
            searchableText: "recovered",
            embeddingInputMode: "raw_v1",
          },
        ],
      },
    );
    expect(restored).toMatchObject({ accepted: true });

    const recovered = await t.run(async (ctx) => ({
      reservation: await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", providerReservationKey),
        )
        .unique(),
      usage: await ctx.db
        .query("tokenUsage")
        .withIndex("by_embedding_reservation", (q) =>
          q.eq("embeddingReservationKey", providerReservationKey),
        )
        .unique(),
      chunk: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version_and_chunk", (q) =>
          q
            .eq("repositoryId", repositoryId)
            .eq("indexVersion", 3)
            .eq("chunkId", "recovered-staged-chunk"),
        )
        .unique(),
    }));
    expect(recovered.reservation?.status).toBe("finalized");
    expect(recovered.usage?.embeddingTokens).toBe(9);
    expect(recovered.chunk?.embedding).toEqual(vector);
  });

  it("meters and caches a paid response after generation ownership changes", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "indexing",
      3,
      "stale-paid-publication",
    );
    const repository = await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { ragIndexPhase: "files" });
      return await ctx.db.get(repositoryId);
    });
    if (!repository) throw new Error("repository missing");
    const embeddingPublication = createRagPublicationExpectation(repository);
    const batchReservationKey = "stale-paid-rag";
    const reservationKey = buildRagEmbeddingProviderAttemptKey(
      batchReservationKey,
      3,
    );
    await t.mutation(internal._ai.embeddingBilling.reservePaidEmbeddingUsage, {
      reservationKey,
      attemptToken: `${reservationKey}:attempt`,
      userId: repository.userId,
      repositoryId,
      operation: "RAG index",
      inputCount: 1,
      providerTokenLimit: 1_024,
      provider: "openai",
      model: EMBEDDING_MODEL,
    });
    await t.mutation(
      internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
      {
        reservationKey,
        attemptToken: `${reservationKey}:attempt`,
        userId: repository.userId,
        repositoryId,
      },
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { indexVersion: 4 });
    });

    await expect(
      t.mutation(internal.ragV2.internalMutation.commitEmbeddedChunks, {
        repositoryId,
        indexVersion: 3,
        batchReservationKey,
        embeddingKey: CODE_EMBEDDING_KEY,
        embeddingPublication,
        chunks: [
          {
            chunkId: "stale-paid-chunk",
            path: "stale.ts",
            language: "typescript",
            code: "export const stale = true;",
            startLine: 1,
            endLine: 1,
            symbols: ["stale"],
            contentHash: "stale-paid-hash",
            searchableText: "stale",
            embedding: createVector(),
            embeddingKey: CODE_EMBEDDING_KEY,
          },
        ],
        usage: {
          tokens: 9,
          model: EMBEDDING_MODEL,
          provider: "openai",
          billingTier: "paid",
          reservationKey,
          reservationAttemptToken: `${reservationKey}:attempt`,
        },
      }),
    ).resolves.toEqual({ accepted: false, chunkIds: [] });

    const state = await t.run(async (ctx) => ({
      chunks: await ctx.db.query("repoChunks").collect(),
      embeddingBatches: await ctx.db.query("ragEmbeddingBatches").collect(),
      reservations: await ctx.db.query("embeddingUsageReservations").collect(),
      usage: await ctx.db.query("tokenUsage").collect(),
    }));
    expect(state.chunks).toHaveLength(0);
    expect(state.embeddingBatches).toHaveLength(1);
    expect(state.reservations[0]?.status).toBe("finalized");
    expect(state.usage).toHaveLength(1);
  });

  it.each(["disconnecting", "revoked", "deleted"] as const)(
    "meters but does not cache a late paid response after the repository is %s",
    async (lifecycle) => {
      const t = convexTest(schema, modules);
      const repositoryId = await insertRepository(
        t,
        "indexing",
        3,
        `late-paid-${lifecycle}`,
      );
      const repository = await t.run(async (ctx) => {
        await ctx.db.patch(repositoryId, { ragIndexPhase: "files" });
        return await ctx.db.get(repositoryId);
      });
      if (!repository) throw new Error("repository missing");
      const embeddingPublication = createRagPublicationExpectation(repository);
      const batchReservationKey = `late-paid-${lifecycle}`;
      const reservationKey = buildRagEmbeddingProviderAttemptKey(
        batchReservationKey,
        3,
      );
      await t.mutation(
        internal._ai.embeddingBilling.reservePaidEmbeddingUsage,
        {
          reservationKey,
          attemptToken: `${reservationKey}:attempt`,
          userId: repository.userId,
          repositoryId,
          operation: "RAG index",
          inputCount: 1,
          providerTokenLimit: 1_024,
          provider: "openai",
          model: EMBEDDING_MODEL,
        },
      );
      await t.mutation(
        internal._ai.embeddingBilling.markEmbeddingUsageProviderStarted,
        {
          reservationKey,
          attemptToken: `${reservationKey}:attempt`,
          userId: repository.userId,
          repositoryId,
        },
      );
      await t.run(async (ctx) => {
        if (lifecycle === "deleted") {
          await ctx.db.delete(repositoryId);
          return;
        }
        await ctx.db.patch(
          repositoryId,
          lifecycle === "disconnecting"
            ? { disconnectCleanupPending: true }
            : {
                isActive: false,
                githubAccessRevokedAt: Date.now(),
              },
        );
      });

      await expect(
        t.mutation(internal.ragV2.internalMutation.commitEmbeddedChunks, {
          repositoryId,
          indexVersion: 3,
          batchReservationKey,
          embeddingKey: CODE_EMBEDDING_KEY,
          embeddingPublication,
          chunks: [
            {
              chunkId: `late-paid-${lifecycle}`,
              path: "late.ts",
              language: "typescript",
              code: "export const late = true;",
              startLine: 1,
              endLine: 1,
              symbols: ["late"],
              contentHash: `late-paid-${lifecycle}-hash`,
              searchableText: "late",
              embedding: createVector(),
              embeddingKey: CODE_EMBEDDING_KEY,
            },
          ],
          usage: {
            tokens: 9,
            model: EMBEDDING_MODEL,
            provider: "openai",
            billingTier: "paid",
            reservationKey,
            reservationAttemptToken: `${reservationKey}:attempt`,
          },
        }),
      ).resolves.toEqual({ accepted: false, chunkIds: [] });

      const state = await t.run(async (ctx) => ({
        chunks: await ctx.db.query("repoChunks").collect(),
        embeddingBatches: await ctx.db.query("ragEmbeddingBatches").collect(),
        reservations: await ctx.db
          .query("embeddingUsageReservations")
          .collect(),
        usage: await ctx.db.query("tokenUsage").collect(),
      }));
      expect(state.chunks).toHaveLength(0);
      expect(state.embeddingBatches).toHaveLength(0);
      expect(state.reservations[0]?.status).toBe("finalized");
      expect(state.usage).toHaveLength(1);
      if (lifecycle === "revoked") {
        expect(state.usage[0]?.repositoryId).toBe(repositoryId);
      } else {
        expect(state.usage[0]?.repositoryId).toBeUndefined();
      }
    },
  );

  it("rejects a chunk publication while installation reconciliation has only a phase marker", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "indexing",
      3,
      "phase-only-publication",
    );
    const repository = await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { ragIndexPhase: "files" });
      const repository = await ctx.db.get(repositoryId);
      if (!repository) throw new Error("repository missing");
      const installation = await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", repository.installationId),
        )
        .first();
      if (!installation) throw new Error("installation missing");
      await ctx.db.patch(installation._id, {
        repositoryAccessReconciliationPhase: "fetching",
      });
      return repository;
    });
    const embeddingPublication = createRagPublicationExpectation(repository);

    await expect(
      t.mutation(internal.ragV2.internalMutation.commitEmbeddedChunks, {
        repositoryId,
        indexVersion: 3,
        batchReservationKey: "phase-only-publication",
        embeddingKey: CODE_EMBEDDING_KEY,
        embeddingPublication,
        chunks: [
          {
            chunkId: "phase-only-chunk",
            path: "phase.ts",
            language: "typescript",
            code: "export const phase = true;",
            startLine: 1,
            endLine: 1,
            symbols: ["phase"],
            contentHash: "phase-only-hash",
            searchableText: "phase",
            embedding: createVector(),
            embeddingKey: CODE_EMBEDDING_KEY,
          },
        ],
        usage: {
          tokens: 7,
          model: EMBEDDING_MODEL,
          provider: "openai",
          billingTier: "free",
        },
      }),
    ).resolves.toEqual({ accepted: false, chunkIds: [] });

    expect(
      await t.run(async (ctx) => ctx.db.query("repoChunks").collect()),
    ).toEqual([]);
  });

  it.each([
    {
      key: "private",
      name: "repository becomes private",
      policyPatch: {
        githubVisibility: "private" as const,
        licenseOsiApproved: false,
        licenseOsiCheckedAt: undefined,
        ragEmbeddingBillingTier: undefined,
      },
    },
    {
      key: "license-revoked",
      name: "open-source license is revoked",
      policyPatch: {
        licenseKey: undefined,
        licenseSpdxId: undefined,
        licenseOsiApproved: false,
        licenseOsiCheckedAt: undefined,
        ragEmbeddingBillingTier: undefined,
      },
    },
  ])(
    "rejects a free in-flight publication when $name and restarts RAG",
    async ({ key, policyPatch }) => {
      const t = convexTest(schema, modules);
      const repositoryId = await insertRepository(
        t,
        "indexing",
        3,
        "free-policy-race",
      );
      const repository = await t.run(async (ctx) => {
        await ctx.db.patch(repositoryId, {
          ragIndexPhase: "files",
          ragIndexFileOffset: 0,
          ragIndexChunkOffset: 0,
        });
        return await ctx.db.get(repositoryId);
      });
      if (!repository) throw new Error("repository missing");
      const embeddingPublication = createRagPublicationExpectation(repository);

      await t.run(async (ctx) => {
        await ctx.db.patch(repositoryId, {
          ...policyPatch,
          repositoryMetadataCheckedAt:
            (repository.repositoryMetadataCheckedAt ?? 0) + 1,
          updatedAt: Date.now(),
        });
      });

      await expect(
        t.mutation(internal.ragV2.internalMutation.commitEmbeddedChunks, {
          repositoryId,
          indexVersion: 3,
          batchReservationKey: `free-policy-race-${key}`,
          embeddingKey: CODE_EMBEDDING_KEY,
          embeddingPublication,
          chunks: [
            {
              chunkId: "free-policy-race-chunk",
              path: "policy.ts",
              language: "typescript",
              code: "export const policy = true;",
              startLine: 1,
              endLine: 1,
              symbols: ["policy"],
              contentHash: "free-policy-race-hash",
              searchableText: "policy",
              embedding: createVector(),
              embeddingKey: CODE_EMBEDDING_KEY,
            },
          ],
          usage: {
            tokens: 7,
            model: EMBEDDING_MODEL,
            provider: "openai",
            billingTier: "free",
          },
        }),
      ).resolves.toEqual({ accepted: false, chunkIds: [] });

      const state = await t.run(async (ctx) => ({
        repository: await ctx.db.get(repositoryId),
        chunks: await ctx.db.query("repoChunks").collect(),
        embeddingBatches: await ctx.db.query("ragEmbeddingBatches").collect(),
        usage: await ctx.db.query("tokenUsage").collect(),
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      }));
      expect(state.chunks).toHaveLength(0);
      expect(state.embeddingBatches).toHaveLength(0);
      expect(state.usage).toHaveLength(0);
      expect(state.repository).toMatchObject({
        indexVersion: 3,
        ragStatus: "pending",
      });
      expect(state.repository?.ragEmbeddingMode).toBeUndefined();
      expect(state.repository?.ragEmbeddingBillingTier).toBeUndefined();
      expect(state.repository?.ragEmbeddingKey).toBeUndefined();
      expect(
        state.scheduled.some(
          (scheduled) =>
            scheduled.name === "ragV2/action:generateChunkEmbeddings" &&
            scheduled.state.kind === "pending",
        ),
      ).toBe(true);
    },
  );

  it("replays partial chunk progress from the durable pre-work checkpoint", async () => {
    const parsedChunks = parseCodeIntoChunks(
      "chunked.ts",
      chunkedFileContent,
      "typescript",
    );
    const reusableChunk = parsedChunks[0];
    if (!reusableChunk) {
      throw new Error("chunked fixture produced no reusable chunk");
    }

    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "indexing", 3, "chunked");
    await seedContinuation(t, repositoryId, {
      phase: "files",
      token: "partial-progress-claim",
      totalChunks: 7,
      successCount: 7,
      processedFiles: 169,
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      const repositoryIndexKey = `${repositoryId}:3`;
      const embeddingScopeKey = `${repositoryIndexKey}:${CODE_EMBEDDING_KEY}`;
      await ctx.db.insert("repoChunks", {
        ...reusableChunk,
        repositoryId,
        repositoryIndexKey,
        embedding: createVector(),
        embeddingKey: CODE_EMBEDDING_KEY,
        embeddingInputMode: "deidentified_v1",
        embeddingScopeKey,
        embeddingLanguageScopeKey: `${embeddingScopeKey}:${reusableChunk.language}`,
        indexVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
    });

    let embeddingRequests = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
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
        embeddingRequests++;
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "AI provider unavailable",
            },
          }),
          { status: 403 },
        );
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
        claimToken: "partial-progress-claim",
      },
    );
    const yielded = await t.run(async (ctx) => ({
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
      totalChunks: 7,
      successCount: 7,
      errorCount: 0,
    });
    expect(embeddingRequests).toBe(1);
    expect(yielded.repository).toMatchObject({
      ragStatus: "indexing",
      ragEmbeddingMode: "keyword_only",
      ragIndexPhase: "files",
      ragIndexFileOffset: 0,
      ragIndexChunkOffset: 0,
      ragTotalChunks: 7,
      ragIndexedChunks: 7,
      ragFailedChunks: 0,
      ragProcessedFiles: 169,
      ragContinuationToken: expect.any(String),
      ragEmbeddingError: expect.stringContaining("HTTP 403"),
    });
    expect(yielded.chunks).toHaveLength(1);
    expect(yielded.chunks[0]?.embedding).toHaveLength(EMBEDDING_DIMENSIONS);

    await finishPendingRagContinuations(t);

    const completed = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 3),
        )
        .collect(),
    }));
    expect(completed.repository).toMatchObject({
      ragStatus: "completed",
      ragEmbeddingMode: "keyword_only",
      ragTotalChunks: 7 + parsedChunks.length,
      ragIndexedChunks: 7 + parsedChunks.length,
      ragFailedChunks: 0,
    });
    expect(completed.repository?.ragProcessedFiles).toBeUndefined();
    expect(completed.chunks).toHaveLength(parsedChunks.length);
    expect(new Set(completed.chunks.map((chunk) => chunk.chunkId)).size).toBe(
      parsedChunks.length,
    );
    expect(
      completed.chunks.every(
        (chunk) =>
          chunk.embedding === undefined && chunk.embeddingKey === undefined,
      ),
    ).toBe(true);
    expect(embeddingRequests).toBe(1);
  });

  it("uses paid raw inputs and meters eligible OSS on a paid-only deployment", async () => {
    process.env.OPENAI_API_KEY = "test-paid-key";
    resolveEmbeddingPolicyMock.mockImplementation(
      async (
        _ctx: unknown,
        repository: Parameters<typeof createPolicyResolution>[0],
      ) => createPolicyResolution(repository, "paid"),
    );
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "embedding-error-paid-metering",
    );
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
          return new Response(embeddingErrorFileContent, { status: 200 });
        }
        if (url === EMBEDDING_ENDPOINT) {
          embeddingRequests++;
          const body = parseBatchRequest(init);
          return createBatchResponse(body.input.length, 11);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    ) as unknown as typeof fetch;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await t.action(internal.ragV2.action.generateChunkEmbeddings, {
      repositoryId,
    });
    await drainScheduledFunctions(t);

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 3),
        )
        .collect(),
      reservations: await ctx.db.query("embeddingUsageReservations").collect(),
      embeddingBatches: await ctx.db.query("ragEmbeddingBatches").collect(),
      usage: await ctx.db.query("tokenUsage").collect(),
    }));
    expect(embeddingRequests).toBe(1);
    expect(state.repository).toMatchObject({
      ragStatus: "completed",
      ragEmbeddingMode: "openai",
      ragEmbeddingBillingTier: "paid",
    });
    expect(state.chunks).toHaveLength(1);
    expect(state.chunks[0]?.embeddingInputMode).toBe("raw_v1");
    expect(state.chunks[0]?.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(state.reservations).toHaveLength(1);
    expect(state.embeddingBatches).toHaveLength(1);
    expect(state.embeddingBatches[0]).toMatchObject({
      repositoryId,
      reservationKey: expect.stringMatching(
        new RegExp(`^rag-index:${repositoryId}:[0-9a-f]{64}$`),
      ),
      embeddingKey: CODE_EMBEDDING_KEY,
    });
    expect(state.reservations[0]).toMatchObject({
      reservationKey: expect.stringMatching(
        new RegExp(`^rag-index:${repositoryId}:[0-9a-f]{64}:generation:3$`),
      ),
      status: "finalized",
      providerStartedAt: expect.any(Number),
    });
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      embeddingBillingTier: "paid",
      embeddingReservationKey: state.reservations[0].reservationKey,
    });
    expect(warning.mock.calls.flat().join(" ")).not.toContain(
      "sensitive-metering-secret",
    );

    await t.run(async (ctx) => {
      for (const chunk of await ctx.db
        .query("repoChunks")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect()) {
        await ctx.db.delete(chunk._id);
      }
      await ctx.db.patch(repositoryId, {
        indexVersion: 4,
        indexStatus: "completed",
        ragStatus: "pending",
        ragEmbeddingMode: undefined,
        ragEmbeddingKey: undefined,
        ragEmbeddingError: undefined,
      });
    });
    await t.action(internal.ragV2.action.generateChunkEmbeddings, {
      repositoryId,
    });
    await drainScheduledFunctions(t);
    expect(embeddingRequests).toBe(1);
    const restoredState = await t.run(async (ctx) => ({
      chunks: await ctx.db
        .query("repoChunks")
        .withIndex("by_index_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 4),
        )
        .collect(),
      embeddingBatches: await ctx.db.query("ragEmbeddingBatches").collect(),
      usage: await ctx.db.query("tokenUsage").collect(),
    }));
    expect(restoredState.chunks).toHaveLength(1);
    expect(restoredState.chunks[0]?.embedding).toHaveLength(
      EMBEDDING_DIMENSIONS,
    );
    expect(restoredState.embeddingBatches).toHaveLength(1);
    expect(restoredState.usage).toHaveLength(1);
  });

  it.each([
    {
      name: "quota",
      status: 429,
      providerStatus: "RESOURCE_EXHAUSTED",
      expectedRequests: 1,
    },
    {
      name: "authentication",
      status: 403,
      providerStatus: "PERMISSION_DENIED",
      expectedRequests: 1,
    },
  ])(
    "degrades AI $name failures to completed keyword-only indexing",
    async ({ name, status, providerStatus, expectedRequests }) => {
      const t = convexTest(schema, modules);
      const repositoryId = await insertRepository(
        t,
        "pending",
        3,
        `embedding-error-${name}`,
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
          return new Response(
            JSON.stringify({
              error: {
                code: status,
                status: providerStatus,
                message: "AI provider unavailable",
              },
            }),
            { status, headers: { "retry-after": "0" } },
          );
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
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      }));
      expect(result).toEqual({
        success: true,
        totalChunks: 0,
        successCount: 0,
        errorCount: 0,
      });
      expect(embeddingRequests).toBe(expectedRequests);
      expect(completedState.repository).toMatchObject({
        ragStatus: "completed",
        ragEmbeddingMode: "keyword_only",
        ragEmbeddingError: expect.stringContaining(`HTTP ${status}`),
        ragTotalChunks: 1,
        ragIndexedChunks: 1,
        ragFailedChunks: 0,
      });
      expect(completedState.repository?.ragEmbeddingKey).toBeUndefined();
      expect(completedState.repository?.ragError).toBeUndefined();
      expect(completedState.repository?.ragIndexPhase).toBeUndefined();
      expect(completedState.chunks).toHaveLength(1);
      expect(completedState.chunks[0].embedding).toBeUndefined();
      expect(completedState.chunks[0].embeddingKey).toBeUndefined();
      expect(completedState.chunks[0].embeddingScopeKey).toBeUndefined();
      const ragActions = completedState.scheduled.filter(
        (scheduled) =>
          scheduled.name === "ragV2/action:generateChunkEmbeddings",
      );
      expect(ragActions).toHaveLength(3);
      expect(
        ragActions.every((scheduled) => scheduled.state.kind === "success"),
      ).toBe(true);
    },
  );

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
      ragEmbeddingError: expect.stringContaining(
        "credentials are not configured",
      ),
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

    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    if (!repository) throw new Error("repository missing");
    await t.mutation(internal.ragV2.internalMutation.upsertChunks, {
      repositoryId,
      indexVersion: 3,
      embeddingPublication: createRagPublicationExpectation(repository),
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
          embedding: createVector(2),
          embeddingKey: CODE_EMBEDDING_KEY,
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
    expect(currentVersion).toMatchObject({
      embeddingKey: CODE_EMBEDDING_KEY,
      embeddingScopeKey: `${repositoryId}:3:${CODE_EMBEDDING_KEY}`,
    });
    expect(currentVersion?.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
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

  it("returns BM25 results when vector policy refresh fails", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "policy-refresh-search",
    );
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(repositoryId, {
        ragStatus: "completed",
        ragEmbeddingMode: "openai",
        ragEmbeddingBillingTier: "paid",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:3`,
        chunkId: "policy-refresh-keyword-result",
        path: "src/policy-refresh.ts",
        language: "typescript",
        code: "export const policyRefreshNeedle = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["policyRefreshNeedle"],
        searchableText: "policyRefreshNeedle export const true",
        contentHash: "policy-refresh-keyword-hash",
        indexVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
    });
    (
      embeddingPolicyRuntime.resolveStoredRagEmbeddingPolicyWithRefresh as unknown as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValueOnce(new Error("transient policy read failed"));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const results = await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId,
      indexVersion: 3,
      query: "policyRefreshNeedle",
      topK: 5,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      chunkId: "policy-refresh-keyword-result",
      path: "src/policy-refresh.ts",
    });
  });

  it("canonicalizes duplicate TitleCase language filters and searches the current vector scopes", async () => {
    process.env.OPENAI_API_KEY = "test-paid-key";
    const javascriptChunks = parseCodeIntoChunks(
      "src/client.js",
      "export function javascriptNeedle() { return true; }",
      "JavaScript",
    );
    const typescriptChunks = parseCodeIntoChunks(
      "src/server.ts",
      "export function typescriptNeedle(): boolean { return true; }",
      "TypeScript",
    );
    expect(new Set(javascriptChunks.map((chunk) => chunk.language))).toEqual(
      new Set(["javascript"]),
    );
    expect(new Set(typescriptChunks.map((chunk) => chunk.language))).toEqual(
      new Set(["typescript"]),
    );

    const t = convexTest(schema, vectorSearchModules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "language-filter",
    );
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(repositoryId, {
        ragStatus: "completed",
        ragEmbeddingMode: "openai",
        ragEmbeddingBillingTier: "paid",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
      });
      const repositoryIndexKey = `${repositoryId}:3`;
      const embeddingScopeKey = `${repositoryIndexKey}:${CODE_EMBEDDING_KEY}`;
      for (const chunk of [
        {
          chunkId: "current-javascript",
          path: "src/client.js",
          language: "javascript",
          code: "export const clientValue = true;",
          vector: createVector(1),
        },
        {
          chunkId: "current-typescript",
          path: "src/server.ts",
          language: "typescript",
          code: "export const serverValue = true;",
          vector: createVector(2),
        },
        {
          chunkId: "current-python",
          path: "src/worker.py",
          language: "python",
          code: "worker_value = True",
          vector: createVector(),
        },
      ]) {
        await ctx.db.insert("repoChunks", {
          repositoryId,
          repositoryIndexKey,
          chunkId: chunk.chunkId,
          path: chunk.path,
          language: chunk.language,
          code: chunk.code,
          startLine: 1,
          endLine: 1,
          symbols: [],
          embedding: chunk.vector,
          embeddingKey: CODE_EMBEDDING_KEY,
          embeddingScopeKey,
          embeddingLanguageScopeKey: `${embeddingScopeKey}:${chunk.language}`,
          searchableText: chunk.code,
          contentHash: `${chunk.chunkId}-hash`,
          indexVersion: 3,
          createdAt: now,
          updatedAt: now,
        });
      }

      for (let index = 0; index < 201; index++) {
        await ctx.db.insert("repoChunks", {
          repositoryId,
          repositoryIndexKey: `${repositoryId}:2`,
          chunkId: `stale-javascript-${index}`,
          path: `stale/client-${index}.js`,
          language: "javascript",
          code: `export const stale${index} = true;`,
          startLine: 1,
          endLine: 1,
          symbols: [],
          embedding: createVector(),
          embeddingKey: CODE_EMBEDDING_KEY,
          embeddingScopeKey: `${repositoryId}:2:${CODE_EMBEDDING_KEY}`,
          embeddingLanguageScopeKey: `${repositoryId}:2:${CODE_EMBEDDING_KEY}:javascript`,
          searchableText: `stale${index}`,
          contentHash: `stale-javascript-${index}-hash`,
          indexVersion: 2,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    globalThis.fetch = vi.fn(async () => createBatchResponse(1, 3));

    const results = await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId,
      indexVersion: 3,
      query: "semantic-vector-query-without-keyword-overlap",
      embeddingDataProvenance: "public_github",
      topK: 5,
      filters: {
        language: [
          "JavaScript",
          "JAVASCRIPT",
          " javascript ",
          "JavaScript ",
          " JAVASCRIPT ",
          "TypeScript",
          "TYPESCRIPT",
          " typescript ",
          "TypeScript ",
        ],
      },
    });

    expect(results.map((result) => result.chunkId).sort()).toEqual([
      "current-javascript",
      "current-typescript",
    ]);
    expect(results.map((result) => result.language).sort()).toEqual([
      "javascript",
      "typescript",
    ]);
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

  it.each([
    {
      name: "explicit public GitHub query",
      embeddingDataProvenance: "public_github" as const,
      expectedKey: "Bearer test-paid-key",
    },
    {
      name: "explicit private query",
      embeddingDataProvenance: "private_user_input" as const,
      expectedKey: "Bearer test-paid-key",
    },
    {
      name: "query with no provenance",
      embeddingDataProvenance: undefined,
      expectedKey: "Bearer test-paid-key",
    },
  ])("routes $name through $expectedKey", async (testCase) => {
    process.env.OPENAI_API_KEY = "test-paid-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "query-provenance",
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        ragStatus: "completed",
        ragEmbeddingMode: "openai",
        ragEmbeddingBillingTier: "paid",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
      });
    });
    const privateMarker = `private-marker-${testCase.name}`;
    const observedKeys: Array<string | null> = [];
    const observedBodies: Array<string> = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url !== EMBEDDING_ENDPOINT) {
          throw new Error(`Unexpected fetch: ${url}`);
        }
        observedKeys.push(new Headers(init?.headers).get("authorization"));
        observedBodies.push(String(init?.body));
        return createBatchResponse(1, 5);
      },
    ) as unknown as typeof fetch;

    await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId,
      indexVersion: 3,
      query: privateMarker,
      embeddingDataProvenance: testCase.embeddingDataProvenance,
      topK: 5,
    });

    expect(observedKeys).toEqual([testCase.expectedKey]);
    expect(observedBodies).toHaveLength(1);
    expect(observedBodies[0]).toContain(privateMarker);
    if (testCase.expectedKey === "Bearer test-paid-key") {
      expect(observedKeys).not.toContain("test-free-key");
    }
  });

  it("uses BM25 for a private query on public OSS when paid usage is blocked", async () => {
    process.env.OPENAI_API_KEY = "test-paid-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, "pending", 3, "paid-search");
    await blockPaidUsage(t, repositoryId);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(repositoryId, {
        ragStatus: "completed",
        ragEmbeddingMode: "openai",
        ragEmbeddingBillingTier: "paid",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:3`,
        chunkId: "paid-search-keyword",
        path: "src/paid-search.ts",
        language: "typescript",
        code: "export const paidSearchNeedle = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["paidSearchNeedle"],
        searchableText: "paidSearchNeedle export const true",
        contentHash: "paid-search-hash",
        indexVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("Paid AI must not be called after the account limit");
    });
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const results = await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId,
      indexVersion: 3,
      query: "paidSearchNeedle",
      embeddingDataProvenance: "private_user_input",
      topK: 5,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      chunkId: "paid-search-keyword",
      path: "src/paid-search.ts",
    });
  });

  it("discards vector results when the post-query policy attestation fails", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "post-query-policy-race",
    );
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(repositoryId, {
        ragStatus: "completed",
        ragEmbeddingMode: "openai",
        ragEmbeddingBillingTier: "paid",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:3`,
        chunkId: "vector-only-result",
        path: "src/vector-only.ts",
        language: "typescript",
        code: "export const unrelatedVector = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["unrelatedVector"],
        embedding: createVector(),
        embeddingKey: CODE_EMBEDDING_KEY,
        embeddingScopeKey: `${repositoryId}:3:${CODE_EMBEDDING_KEY}`,
        searchableText: "unrelated vector content",
        contentHash: "vector-only-hash",
        indexVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:3`,
        chunkId: "keyword-only-result",
        path: "src/keyword-only.ts",
        language: "typescript",
        code: "export const policyRaceNeedle = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["policyRaceNeedle"],
        searchableText: "policyRaceNeedle",
        contentHash: "keyword-only-hash",
        indexVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
    });
    const assertProviderRequestMock =
      embeddingPolicyRuntime.assertRepositoryEmbeddingProviderRequest as unknown as ReturnType<
        typeof vi.fn
      >;
    assertProviderRequestMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new EmbeddingProviderError(
          "policy",
          "repository policy changed after query embedding",
          { route: "free", durableRetrySafe: true },
        ),
      );
    globalThis.fetch = vi.fn(async () => createBatchResponse(1, 3));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const results = await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId,
      indexVersion: 3,
      query: "policyRaceNeedle",
      embeddingDataProvenance: "public_github",
      topK: 5,
    });

    expect(results.map((result) => result.chunkId)).toEqual([
      "keyword-only-result",
    ]);
  });

  it("drops hybrid results when access is revoked after keyword search", async () => {
    process.env.OPENAI_API_KEY = "test-paid-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "revoked-search",
    );
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(repositoryId, {
        ragStatus: "completed",
        ragEmbeddingMode: "openai",
        ragEmbeddingBillingTier: "paid",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:3`,
        chunkId: "revoked-search-result",
        path: "src/revoked.ts",
        language: "typescript",
        code: "export const revokedSearchNeedle = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["revokedSearchNeedle"],
        embedding: createVector(),
        embeddingKey: CODE_EMBEDDING_KEY,
        embeddingScopeKey: `${repositoryId}:3:${CODE_EMBEDDING_KEY}`,
        searchableText: "revokedSearchNeedle export const true",
        contentHash: "revoked-search-hash",
        indexVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
    });
    const fetchMock = vi.fn(async () => {
      await t.run(async (ctx) => {
        await ctx.db.patch(repositoryId, {
          isActive: false,
          githubAccessRevokedAt: Date.now(),
        });
      });
      return createBatchResponse(1, 3);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const results = await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId,
      indexVersion: 3,
      query: "revokedSearchNeedle",
      embeddingDataProvenance: "public_github",
      topK: 5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]);
  });

  it("drops hybrid results when installation reconciliation begins after keyword search", async () => {
    process.env.OPENAI_API_KEY = "test-paid-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(
      t,
      "pending",
      3,
      "reconciling-search",
    );
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(repositoryId, {
        ragStatus: "completed",
        ragEmbeddingMode: "openai",
        ragEmbeddingBillingTier: "paid",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
      });
      await ctx.db.insert("repoChunks", {
        repositoryId,
        repositoryIndexKey: `${repositoryId}:3`,
        chunkId: "reconciling-search-result",
        path: "src/reconciling.ts",
        language: "typescript",
        code: "export const reconciliationNeedle = true;",
        startLine: 1,
        endLine: 1,
        symbols: ["reconciliationNeedle"],
        embedding: createVector(),
        embeddingKey: CODE_EMBEDDING_KEY,
        embeddingScopeKey: `${repositoryId}:3:${CODE_EMBEDDING_KEY}`,
        searchableText: "reconciliationNeedle export const true",
        contentHash: "reconciling-search-hash",
        indexVersion: 3,
        createdAt: now,
        updatedAt: now,
      });
    });
    const fetchMock = vi.fn(async () => {
      await t.run(async (ctx) => {
        const installation = await ctx.db
          .query("githubInstallations")
          .withIndex("by_installation_id", (q) => q.eq("installationId", 101))
          .first();
        if (!installation) throw new Error("installation fixture missing");
        const now = Date.now();
        await ctx.db.patch(installation._id, {
          repositoryRemovalPendingAt: now,
          repositoryAccessReconciliationPhase: "fetching",
          updatedAt: now,
        });
      });
      return createBatchResponse(1, 3);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const results = await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId,
      indexVersion: 3,
      query: "reconciliationNeedle",
      embeddingDataProvenance: "public_github",
      topK: 5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]);
  });
});
