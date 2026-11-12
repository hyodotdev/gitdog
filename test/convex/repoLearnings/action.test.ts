import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PRICING, getFreeIncludedTokens } from "../../../convex/_ai/config";
import * as githubHelpers from "../../../convex/github/helpers";
import { CODE_EMBEDDING_KEY } from "../../../convex/ragV2/action";
import schema from "../../../convex/schema";
import { REPO_LEARNING_EMBEDDING_KEY } from "../../../convex/repoLearnings/action";
import {
  buildLearningContextForProvenance,
  getTrustedLearningRepositoryKey,
} from "../../../convex/repoLearnings/trust";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../../convex/users/legal";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repositories/internalQuery.ts": () =>
    import("../../../convex/repositories/internalQuery"),
  "../../../convex/repositories/internalMutation.ts": () =>
    import("../../../convex/repositories/internalMutation"),
  "../../../convex/repositories/mutation.ts": () =>
    import("../../../convex/repositories/mutation"),
  "../../../convex/github/internalQuery.ts": () =>
    import("../../../convex/github/internalQuery"),
  "../../../convex/repoLearnings/action.ts": () =>
    import("../../../convex/repoLearnings/action"),
  "../../../convex/repoLearnings/internalQuery.ts": () =>
    import("../../../convex/repoLearnings/internalQuery"),
  "../../../convex/repoLearnings/mutation.ts": () =>
    import("../../../convex/repoLearnings/mutation"),
  "../../../convex/ragV2/action.ts": () =>
    import("../../../convex/ragV2/action"),
  "../../../convex/ragV2/internalMutation.ts": () =>
    import("../../../convex/ragV2/internalMutation"),
  "../../../convex/ragV2/internalQuery.ts": () =>
    import("../../../convex/ragV2/internalQuery"),
  "../../../convex/_ai/embeddingBilling.ts": () =>
    import("../../../convex/_ai/embeddingBilling"),
  "../../../convex/tokenUsage/internalMutation.ts": () =>
    import("../../../convex/tokenUsage/internalMutation"),
  "../../../convex/subscriptions/internalQuery.ts": () =>
    import("../../../convex/subscriptions/internalQuery"),
  "../../../convex/users/internalQuery.ts": () =>
    import("../../../convex/users/internalQuery"),
  "../../../convex/users/mutation.ts": () =>
    import("../../../convex/users/mutation"),
};

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalGitHubAppId = process.env.GITHUB_APP_ID;
const originalGitHubAppPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
const originalFetch = globalThis.fetch;

type SettledResult<T> =
  { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

function settlePromise<T>(promise: Promise<T>): Promise<SettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function githubMetadataResponse(
  visibility: "public" | "private" | "internal",
  licenseSpdxId: string | null = "MIT",
): Response {
  return new Response(
    JSON.stringify({
      id: 1001,
      full_name: "owner/repo",
      visibility,
      private: visibility === "private",
      license:
        licenseSpdxId === null
          ? null
          : { key: licenseSpdxId.toLowerCase(), spdx_id: licenseSpdxId },
    }),
    { status: 200 },
  );
}

function osiApprovedResponse(spdxId = "MIT"): Response {
  return new Response(JSON.stringify([{ spdx_id: spdxId }]), { status: 200 });
}

function restoreEnvironmentValue(
  name: "OPENAI_API_KEY",
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  options: {
    githubVisibility: "public" | "private" | "internal";
    licenseSpdxId?: string;
    repositoryMetadataCheckedAt?: number;
  },
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    const verifiedAt = now - 1;
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
      indexProgressAt: Date.now(),
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId: 101,
      githubRepositoryId: 1001,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      githubVisibility: options.githubVisibility,
      licenseSpdxId: options.licenseSpdxId,
      licenseOsiApproved: options.licenseSpdxId ? true : undefined,
      licenseOsiCheckedAt: options.licenseSpdxId ? verifiedAt : undefined,
      repositoryMetadataCheckedAt:
        options.repositoryMetadataCheckedAt ?? verifiedAt,
      isActive: true,
      indexVersion: 1,
      indexStatus: "completed",
      indexSyncPending: false,
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
    await ctx.db.insert("tokenUsage", {
      userId: repository.userId,
      repositoryId,
      usageType: "chat",
      inputTokens: getFreeIncludedTokens(Date.now()),
      outputTokens: 0,
      totalTokens: getFreeIncludedTokens(Date.now()),
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

async function getLearningPolicyPublication(
  t: ReturnType<typeof convexTest>,
  repositoryId: Id<"repositories">,
  expectedPolicyRoute: "free" | "paid",
) {
  const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
  if (!repository?.githubRepositoryId) {
    throw new Error("repository identity missing");
  }
  return {
    expectedUserId: repository.userId,
    expectedIndexVersion: repository.indexVersion,
    expectedInstallationId: repository.installationId,
    expectedGithubRepositoryId: repository.githubRepositoryId,
    expectedGithubRepo: repository.githubRepo,
    expectedPolicyRoute,
    expectedRepositoryMetadataCheckedAt: repository.repositoryMetadataCheckedAt,
    expectedGithubVisibility: repository.githubVisibility,
    expectedLicenseKey: repository.licenseKey,
    expectedLicenseSpdxId: repository.licenseSpdxId,
    expectedLicenseOsiApproved: repository.licenseOsiApproved,
    expectedLicenseOsiCheckedAt: repository.licenseOsiCheckedAt,
    expectedRagEmbeddingBillingTier: repository.ragEmbeddingBillingTier,
    expectedRagEmbeddingKey: repository.ragEmbeddingKey,
  };
}

async function revokeFreePolicyWithPrivateWebhook(
  t: ReturnType<typeof convexTest>,
  repositoryId: Id<"repositories">,
): Promise<void> {
  await t.mutation(
    internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
    {
      repositoryId,
      expectedGithubRepo: "owner/repo",
      githubRepositoryId: 1001,
      installationId: 101,
      githubRepo: "owner/repo",
      githubVisibility: "private",
      licenseKey: null,
      licenseSpdxId: null,
    },
  );
}

describe("repository learning AI routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(githubHelpers, "getRepositoryInstallationToken").mockResolvedValue(
      "installation-token",
    );
    delete process.env.OPENAI_API_KEY;
    process.env.GITHUB_APP_ID = "test-app-id";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  });

  afterEach(() => {
    restoreEnvironmentValue("OPENAI_API_KEY", originalOpenAiApiKey);
    if (originalGitHubAppId === undefined) {
      delete process.env.GITHUB_APP_ID;
    } else {
      process.env.GITHUB_APP_ID = originalGitHubAppId;
    }
    if (originalGitHubAppPrivateKey === undefined) {
      delete process.env.GITHUB_APP_PRIVATE_KEY;
    } else {
      process.env.GITHUB_APP_PRIVATE_KEY = originalGitHubAppPrivateKey;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("deduplicates one learning event without collapsing later feedback from the same source", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "private",
    });
    const firstArgs = {
      repositoryId,
      content: "Prefer a bounded retry for this failure.",
      source: "github.com/owner/repo/issues/42",
      idempotencyKey: "ticket-action:first:learning",
      sourceType: "correction" as const,
      isTrusted: true,
    };

    const firstId = await t.action(
      internal.repoLearnings.action.createLearning,
      firstArgs,
    );
    const retriedId = await t.action(
      internal.repoLearnings.action.createLearning,
      firstArgs,
    );
    const laterId = await t.action(
      internal.repoLearnings.action.createLearning,
      {
        ...firstArgs,
        content: "Do not retry this terminal failure.",
        idempotencyKey: "ticket-action:second:learning",
      },
    );

    const learnings = await t.run(async (ctx) =>
      ctx.db.query("repoLearnings").collect(),
    );
    expect(retriedId).toBe(firstId);
    expect(laterId).not.toBe(firstId);
    expect(learnings).toHaveLength(2);
  });

  // The ticket-action path used to pass `ticket-action:${actionId}:learning`,
  // which is the same key for every round of feedback on one action. The second
  // teaching then hit the identity check and threw instead of being stored.
  it("stores every distinct teaching from one ticket action", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "private",
    });
    const sameAction = {
      repositoryId,
      source: "github.com/owner/repo/issues/42#action-1",
      sourceType: "correction" as const,
      isTrusted: true,
    };

    const first = await t.action(internal.repoLearnings.action.createLearning, {
      ...sameAction,
      content: "Always use bun, never npm.",
    });
    const second = await t.action(
      internal.repoLearnings.action.createLearning,
      {
        ...sameAction,
        content: "Prefer switch over long else-if chains.",
      },
    );
    const retryOfFirst = await t.action(
      internal.repoLearnings.action.createLearning,
      { ...sameAction, content: "Always use bun, never npm." },
    );

    const learnings = await t.run(async (ctx) =>
      ctx.db.query("repoLearnings").collect(),
    );
    expect(second).not.toBe(first);
    expect(retryOfFirst).toBe(first);
    expect(learnings).toHaveLength(2);
    expect(learnings.map((learning) => learning.content).sort()).toEqual([
      "Always use bun, never npm.",
      "Prefer switch over long else-if chains.",
    ]);
  });

  it("uses paid AI for public GitHub interaction-derived learning", async () => {
    process.env.OPENAI_API_KEY = "paid-test-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "public",
      licenseSpdxId: "MIT",
    });
    let embeddingRequests = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.startsWith("https://api.github.com/")) {
          return githubMetadataResponse("public");
        }
        if (url.startsWith("https://opensource.org/")) {
          return osiApprovedResponse();
        }
        embeddingRequests += 1;
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer paid-test-key",
        );
        return new Response(
          JSON.stringify({
            model: "text-embedding-3-small",
            data: [{ index: 0, embedding: Array(1536).fill(0.01) }],
            usage: { prompt_tokens: 12, total_tokens: 12 },
          }),
          { status: 200 },
        );
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const learningId = await t.action(
      internal.repoLearnings.action.createLearning,
      {
        repositoryId,
        content: "Prefer focused integration tests.",
        source: "issue:1",
        sourceType: "correction",
        isTrusted: true,
        embeddingDataProvenance: "public_github",
      },
    );

    const state = await t.run(async (ctx) => ({
      learning: await ctx.db.get(learningId),
      usage: await ctx.db.query("tokenUsage").first(),
    }));
    expect(embeddingRequests).toBe(1);
    expect(state.learning?.embedding).toHaveLength(1536);
    expect(state.learning?.embeddingKey).toBe(REPO_LEARNING_EMBEDDING_KEY);
    expect(state.learning?.embeddingScopeKey).toBe(
      `${getTrustedLearningRepositoryKey(repositoryId)}:${REPO_LEARNING_EMBEDDING_KEY}`,
    );
    expect(state.learning?.publicEmbeddingScopeKey).toBe(
      state.learning?.embeddingScopeKey,
    );
    expect(state.usage).toMatchObject({
      embeddingBillingTier: "paid",
      embeddingTokens: 12,
    });
  });

  it("routes private dashboard-derived learning content through the paid key", async () => {
    process.env.OPENAI_API_KEY = "paid-test-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "public",
      licenseSpdxId: "MIT",
    });
    const secretFeedback = "dashboard-secret-feedback-7d31";
    const providerKeys: string[] = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.startsWith("https://api.github.com/")) {
          return githubMetadataResponse("public");
        }
        if (url.startsWith("https://opensource.org/")) {
          return osiApprovedResponse();
        }
        const providerKey = new Headers(init?.headers).get("authorization");
        if (providerKey) providerKeys.push(providerKey);
        expect(String(init?.body)).toContain(secretFeedback);
        return new Response(
          JSON.stringify({
            model: "text-embedding-3-small",
            data: [{ index: 0, embedding: Array(1536).fill(0.011) }],
            usage: { prompt_tokens: 13, total_tokens: 13 },
          }),
          { status: 200 },
        );
      },
    ) as typeof fetch;

    const learningId = await t.action(
      internal.repoLearnings.action.createLearning,
      {
        repositoryId,
        content: secretFeedback,
        source: "dashboard:request-changes",
        sourceType: "correction",
        isTrusted: true,
      },
    );

    const state = await t.run(async (ctx) => ({
      learning: await ctx.db.get(learningId),
      usage: await ctx.db.query("tokenUsage").collect(),
    }));
    expect(providerKeys).toEqual(["Bearer paid-test-key"]);
    expect(state.learning).toMatchObject({
      embeddingDataProvenance: "private_user_input",
      embeddingKey: REPO_LEARNING_EMBEDDING_KEY,
    });
    expect(state.learning?.publicEmbeddingScopeKey).toBeUndefined();
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      embeddingBillingTier: "paid",
      embeddingTokens: 13,
    });
  });

  it("routes private dashboard search text through the paid key", async () => {
    process.env.OPENAI_API_KEY = "paid-test-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "public",
      licenseSpdxId: "MIT",
    });
    const secretFeedback = "dashboard-search-secret-b82f";
    await t.run(async (ctx) => {
      const repositoryTrustKey = getTrustedLearningRepositoryKey(repositoryId);
      await ctx.db.insert("repoLearnings", {
        repositoryId,
        content: secretFeedback,
        source: "github.com/owner/repo/issues/1",
        sourceType: "correction",
        isTrusted: true,
        repositoryTrustKey,
        embedding: Array(1536).fill(0.012),
        embeddingKey: REPO_LEARNING_EMBEDDING_KEY,
        embeddingScopeKey: `${repositoryTrustKey}:${REPO_LEARNING_EMBEDDING_KEY}`,
        embeddingDataProvenance: "public_github",
        createdAt: Date.now(),
      });
    });
    const providerKeys: string[] = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).startsWith("https://api.github.com/")) {
          return githubMetadataResponse("public");
        }
        const providerKey = new Headers(init?.headers).get("authorization");
        if (providerKey) providerKeys.push(providerKey);
        expect(String(init?.body)).toContain(secretFeedback);
        return new Response("rejected after route assertion", { status: 400 });
      },
    ) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const results = await t.action(
      internal.repoLearnings.action.searchLearnings,
      { repositoryId, query: secretFeedback, topK: 5 },
    );

    expect(providerKeys).toEqual(["Bearer paid-test-key"]);
    expect(results).toHaveLength(1);
  });

  it("keeps private trusted learnings out of public context and routes every search as paid", async () => {
    process.env.OPENAI_API_KEY = "paid-test-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "public",
      licenseSpdxId: "MIT",
    });
    const commonQuery = "followuppreference";
    const publicGuidance = `${commonQuery}: cite the public API docs`;
    const privateGuidance = `${commonQuery}: dashboard-secret-41f2`;
    const secondaryPrivateGuidance = `${commonQuery}: dashboard-secret-93aa`;
    let publicLearningId: Id<"repoLearnings">;
    let privateLearningId: Id<"repoLearnings">;
    let secondaryPrivateLearningId: Id<"repoLearnings">;

    await t.run(async (ctx) => {
      const repositoryTrustKey = getTrustedLearningRepositoryKey(repositoryId);
      const embeddingScopeKey = `${repositoryTrustKey}:${REPO_LEARNING_EMBEDDING_KEY}`;
      await ctx.db.patch(repositoryId, {
        ragStatus: "completed",
        ragEmbeddingMode: "openai",
        ragEmbeddingKey: CODE_EMBEDDING_KEY,
        ragEmbeddingBillingTier: "free",
      });
      publicLearningId = await ctx.db.insert("repoLearnings", {
        repositoryId,
        content: publicGuidance,
        source: "github.com/owner/repo/issues/41",
        sourceType: "correction",
        isTrusted: true,
        repositoryTrustKey,
        embedding: Array(1536).fill(0.021),
        embeddingKey: REPO_LEARNING_EMBEDDING_KEY,
        embeddingScopeKey,
        publicEmbeddingScopeKey: embeddingScopeKey,
        embeddingDataProvenance: "public_github",
        createdAt: Date.now(),
      });
      privateLearningId = await ctx.db.insert("repoLearnings", {
        repositoryId,
        content: privateGuidance,
        source: "dashboard:request-changes",
        sourceType: "correction",
        isTrusted: true,
        repositoryTrustKey,
        embedding: Array(1536).fill(0.022),
        embeddingKey: REPO_LEARNING_EMBEDDING_KEY,
        embeddingScopeKey,
        embeddingDataProvenance: "private_user_input",
        createdAt: Date.now(),
      });
      secondaryPrivateLearningId = await ctx.db.insert("repoLearnings", {
        repositoryId,
        content: secondaryPrivateGuidance,
        source: "dashboard:secondary-request-changes",
        sourceType: "correction",
        isTrusted: true,
        repositoryTrustKey,
        embedding: Array(1536).fill(0.023),
        embeddingKey: REPO_LEARNING_EMBEDDING_KEY,
        embeddingScopeKey,
        embeddingDataProvenance: "private_user_input",
        createdAt: Date.now(),
      });
    });

    const providerRequests: Array<{ key: string | null; body: string }> = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).startsWith("https://api.github.com/")) {
          return githubMetadataResponse("public");
        }
        providerRequests.push({
          key: new Headers(init?.headers).get("authorization"),
          body: String(init?.body),
        });
        return new Response("stop after provenance assertion", { status: 400 });
      },
    ) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const publicResults = await t.action(
      internal.repoLearnings.action.searchLearnings,
      {
        repositoryId,
        query: commonQuery,
        topK: 10,
        embeddingDataProvenance: "public_github",
      },
    );
    const learnedContext = buildLearningContextForProvenance(
      publicResults,
      "public_github",
    );
    expect(publicResults.map((learning) => learning._id)).toEqual([
      publicLearningId!,
    ]);
    expect(learnedContext).toContain(publicGuidance);
    expect(learnedContext).not.toContain(privateGuidance);
    expect(learnedContext).not.toContain(secondaryPrivateGuidance);

    await t.action(internal.ragV2.action.hybridSearch, {
      repositoryId,
      indexVersion: 1,
      query: `Apply this public follow-up context:\n${learnedContext}`,
      topK: 5,
      embeddingDataProvenance: "public_github",
    });

    const paidRequests = providerRequests.filter(
      (request) => request.key === "Bearer paid-test-key",
    );
    expect(paidRequests.length).toBeGreaterThanOrEqual(2);
    expect(
      paidRequests.some((request) => request.body.includes(publicGuidance)),
    ).toBe(true);
    expect(
      paidRequests.some((request) => request.body.includes(privateGuidance)),
    ).toBe(false);
    expect(
      paidRequests.some((request) =>
        request.body.includes(secondaryPrivateGuidance),
      ),
    ).toBe(false);

    const privateResults = await t.action(
      internal.repoLearnings.action.searchLearnings,
      {
        repositoryId,
        query: commonQuery,
        topK: 10,
        embeddingDataProvenance: "private_user_input",
      },
    );
    expect(new Set(privateResults.map((learning) => learning._id))).toEqual(
      new Set([
        publicLearningId!,
        privateLearningId!,
        secondaryPrivateLearningId!,
      ]),
    );
    expect(providerRequests.at(-1)?.key).toBe("Bearer paid-test-key");
  });

  it("never uses the free key for a private repository", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "private",
      licenseSpdxId: "MIT",
    });
    let embeddingRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).startsWith("https://api.github.com/")) {
        return githubMetadataResponse("private");
      }
      embeddingRequests += 1;
      throw new Error("The free key must not be called");
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const learningId = await t.action(
      internal.repoLearnings.action.createLearning,
      {
        repositoryId,
        content: "Keep private repository data on paid services.",
        source: "issue:2",
        sourceType: "correction",
        isTrusted: true,
        embeddingDataProvenance: "public_github",
      },
    );

    const learning = await t.run(async (ctx) => await ctx.db.get(learningId));
    expect(embeddingRequests).toBe(0);
    expect(warning).toHaveBeenCalledOnce();
    expect(learning?.embedding).toBeUndefined();
    expect(learning?.embeddingKey).toBeUndefined();
  });

  it("uses the paid AI project for a private repository", async () => {
    process.env.OPENAI_API_KEY = "paid-test-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "private",
      licenseSpdxId: "MIT",
    });
    let embeddingRequests = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).startsWith("https://api.github.com/")) {
          return githubMetadataResponse("private");
        }
        embeddingRequests += 1;
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer paid-test-key",
        );
        return new Response(
          JSON.stringify({
            model: "text-embedding-3-small",
            data: [{ index: 0, embedding: Array(1536).fill(0.02) }],
            usage: { prompt_tokens: 20, total_tokens: 20 },
          }),
          { status: 200 },
        );
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const learningId = await t.action(
      internal.repoLearnings.action.createLearning,
      {
        repositoryId,
        content: "Keep private repository data on paid services.",
        source: "issue:paid",
        sourceType: "correction",
        isTrusted: true,
      },
    );

    const state = await t.run(async (ctx) => ({
      learning: await ctx.db.get(learningId),
      usage: await ctx.db.query("tokenUsage").first(),
    }));
    expect(embeddingRequests).toBe(1);
    expect(state.learning?.embeddingKey).toBe(REPO_LEARNING_EMBEDDING_KEY);
    expect(state.usage).toMatchObject({
      repositoryId,
      provider: "openai",
      embeddingTokens: 20,
      embeddingBillingTier: "paid",
      totalTokens: 1,
    });
    expect(state.usage?.baseCostCents).toBeCloseTo(0.00004);
    expect(state.usage?.totalCostCents).toBeCloseTo(0.00005);
  });

  it("meters a paid result but rejects its learning after access is revoked in flight", async () => {
    process.env.OPENAI_API_KEY = "paid-test-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "private",
      licenseSpdxId: "MIT",
    });
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request): Promise<Response> => {
        if (requestUrl(input).startsWith("https://api.github.com/")) {
          return githubMetadataResponse("private");
        }
        await t.run(async (ctx) => {
          await ctx.db.patch(repositoryId, {
            isActive: false,
            githubAccessRevokedAt: Date.now(),
          });
        });
        return new Response(
          JSON.stringify({
            model: "text-embedding-3-small",
            data: [{ index: 0, embedding: Array(1536).fill(0.02) }],
            usage: { prompt_tokens: 21, total_tokens: 21 },
          }),
          { status: 200 },
        );
      },
    ) as typeof fetch;

    await expect(
      t.action(internal.repoLearnings.action.createLearning, {
        repositoryId,
        content: "Do not publish this stale learning embedding.",
        source: "issue:revoked-in-flight",
        sourceType: "correction",
        isTrusted: true,
      }),
    ).rejects.toThrow(
      "Repository learning publication lost access or generation ownership",
    );

    const state = await t.run(async (ctx) => ({
      learnings: await ctx.db.query("repoLearnings").collect(),
      usage: await ctx.db.query("tokenUsage").collect(),
      reservations: await ctx.db.query("embeddingUsageReservations").collect(),
    }));
    expect(state.learnings).toEqual([]);
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      repositoryId,
      embeddingBillingTier: "paid",
      embeddingTokens: 21,
    });
    expect(state.reservations).toHaveLength(1);
    expect(state.reservations[0]).toMatchObject({ status: "finalized" });
  });

  it("rejects a paid create result after a policy change and retries from a fresh attestation", async () => {
    process.env.OPENAI_API_KEY = "paid-test-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "public",
      licenseSpdxId: "MIT",
    });
    let liveVisibility: "public" | "private" = "public";
    const providerKeys: string[] = [];
    const staleContent =
      "Do not publish a free result after policy revocation.";
    const retryContent = "Retry under the repository's fresh paid policy.";
    let resolveFirstProviderRequest!: (providerKey: string) => void;
    const firstProviderRequest = new Promise<string>((resolve) => {
      resolveFirstProviderRequest = resolve;
    });
    let releaseFirstProviderResponse!: () => void;
    const firstProviderResponseReleased = new Promise<void>((resolve) => {
      releaseFirstProviderResponse = resolve;
    });
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.startsWith("https://api.github.com/")) {
          return githubMetadataResponse(
            liveVisibility,
            liveVisibility === "public" ? "MIT" : null,
          );
        }
        if (url.startsWith("https://opensource.org/")) {
          return osiApprovedResponse();
        }
        const providerKey = new Headers(init?.headers).get("authorization");
        const body = String(init?.body);
        const requestCount = (() => {
          try {
            const parsed = JSON.parse(body) as { input?: Array<unknown> };
            return parsed.input?.length ?? 1;
          } catch {
            return 1;
          }
        })();
        if (
          !providerKey ||
          (!body.includes(staleContent) && !body.includes(retryContent))
        ) {
          return new Response(
            JSON.stringify({
              model: "text-embedding-3-small",
              data: Array.from({ length: requestCount }, (_, index) => ({
                index,
                embedding: Array(1536).fill(0.03),
              })),
              usage: {
                prompt_tokens: requestCount,
                total_tokens: requestCount,
              },
            }),
            { status: 200 },
          );
        }
        providerKeys.push(providerKey);
        if (providerKeys.length === 1) {
          resolveFirstProviderRequest(providerKey);
          await firstProviderResponseReleased;
        } else {
          expect(providerKey).toBe("Bearer paid-test-key");
        }
        return new Response(
          JSON.stringify({
            model: "text-embedding-3-small",
            data: [{ index: 0, embedding: Array(1536).fill(0.032) }],
            usage: { prompt_tokens: 19, total_tokens: 19 },
          }),
          { status: 200 },
        );
      },
    ) as typeof fetch;

    const staleAttempt = settlePromise(
      t.action(internal.repoLearnings.action.createLearning, {
        repositoryId,
        content: staleContent,
        source: "issue:free-policy-race",
        sourceType: "correction",
        isTrusted: true,
        embeddingDataProvenance: "public_github",
      }),
    );
    const firstProviderKey = await firstProviderRequest;
    try {
      liveVisibility = "private";
      await revokeFreePolicyWithPrivateWebhook(t, repositoryId);
    } finally {
      releaseFirstProviderResponse();
    }
    const staleResult = await staleAttempt;
    expect(firstProviderKey).toBe("Bearer paid-test-key");
    expect(staleResult.status).toBe("rejected");
    if (staleResult.status !== "rejected") {
      throw new Error("Expected the stale learning action to be rejected");
    }
    expect(staleResult.reason).toEqual(
      expect.objectContaining({
        message:
          "Repository learning publication lost access or generation ownership",
      }),
    );

    const staleState = await t.run(async (ctx) => ({
      learnings: await ctx.db.query("repoLearnings").collect(),
      usage: await ctx.db.query("tokenUsage").collect(),
      reservations: await ctx.db.query("embeddingUsageReservations").collect(),
    }));
    expect(staleState.learnings).toEqual([]);
    expect(staleState.usage).toHaveLength(1);
    expect(staleState.usage[0]).toMatchObject({
      embeddingBillingTier: "paid",
      embeddingTokens: 19,
    });
    expect(staleState.reservations).toHaveLength(1);
    expect(staleState.reservations[0]).toMatchObject({ status: "finalized" });

    const learningId = await t.action(
      internal.repoLearnings.action.createLearning,
      {
        repositoryId,
        content: retryContent,
        source: "issue:fresh-paid-retry",
        sourceType: "correction",
        isTrusted: true,
        embeddingDataProvenance: "public_github",
      },
    );

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      learning: await ctx.db.get(learningId),
      usage: await ctx.db.query("tokenUsage").collect(),
      reservations: await ctx.db.query("embeddingUsageReservations").collect(),
    }));
    expect(providerKeys).toEqual([
      "Bearer paid-test-key",
      "Bearer paid-test-key",
    ]);
    expect(state.repository).toMatchObject({ githubVisibility: "private" });
    expect(state.repository?.ragEmbeddingBillingTier).toBeUndefined();
    expect(state.learning).toMatchObject({
      embeddingKey: REPO_LEARNING_EMBEDDING_KEY,
      embeddingDataProvenance: "public_github",
    });
    expect(state.usage).toHaveLength(2);
    expect(state.usage.at(-1)).toMatchObject({
      repositoryId,
      embeddingBillingTier: "paid",
      embeddingTokens: 19,
    });
    expect(state.reservations).toHaveLength(2);
    expect(
      state.reservations.every(
        (reservation) => reservation.status === "finalized",
      ),
    ).toBe(true);
  });

  it.each([
    "disconnect_pending",
    "repository_deleted",
    "installation_reconciling",
  ] as const)(
    "rejects a stale keyword publication after %s wins the provider race",
    async (race) => {
      const t = convexTest(schema, modules);
      const repositoryId = await insertRepository(t, {
        githubVisibility: "public",
        licenseSpdxId: "MIT",
      });
      const publication = await getLearningPolicyPublication(
        t,
        repositoryId,
        "paid",
      );

      await t.run(async (ctx) => {
        if (race === "repository_deleted") {
          await ctx.db.delete(repositoryId);
        } else if (race === "installation_reconciling") {
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
        } else {
          await ctx.db.patch(repositoryId, {
            isActive: false,
            disconnectCleanupPending: true,
          });
        }
      });

      await expect(
        t.mutation(internal.repoLearnings.mutation.create, {
          repositoryId,
          content: "Do not leave an orphaned keyword fallback.",
          source: `issue:${race}`,
          sourceType: "correction",
          isTrusted: true,
          publication,
        }),
      ).resolves.toBeNull();

      const learnings = await t.run(async (ctx) =>
        ctx.db.query("repoLearnings").collect(),
      );
      expect(learnings).toEqual([]);
    },
  );

  it("keeps paid-only learning create and search keyword-only when account usage is blocked", async () => {
    process.env.OPENAI_API_KEY = "paid-test-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "public",
      licenseSpdxId: "MIT",
    });
    await blockPaidUsage(t, repositoryId);
    let embeddingRequests = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).startsWith("https://api.github.com/")) {
        return githubMetadataResponse("public");
      }
      embeddingRequests++;
      throw new Error("Paid AI must not be called after the account limit");
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const learningId = await t.action(
      internal.repoLearnings.action.createLearning,
      {
        repositoryId,
        content: "Keep blocked paid learnings searchable by keyword.",
        source: "issue:blocked",
        sourceType: "correction",
        isTrusted: true,
      },
    );
    const results = await t.action(
      internal.repoLearnings.action.searchLearnings,
      {
        repositoryId,
        query: "blocked",
        topK: 5,
      },
    );

    const learning = await t.run(async (ctx) => ctx.db.get(learningId));
    expect(embeddingRequests).toBe(0);
    expect(learning?.embedding).toBeUndefined();
    expect(learning?.embeddingKey).toBeUndefined();
    expect(learning?.embeddingDataProvenance).toBe("private_user_input");
    expect(results.some((result) => result._id === learningId)).toBe(true);
  });

  it("returns trusted keyword results when paid AI is unavailable", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "private",
      licenseSpdxId: "MIT",
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("repoLearnings", {
        repositoryId,
        content: "Prefer repository integration tests",
        source: "issue:3",
        sourceType: "correction",
        isTrusted: true,
        repositoryTrustKey: getTrustedLearningRepositoryKey(repositoryId),
        embeddingDataProvenance: "private_user_input",
        createdAt: now,
      });
      await ctx.db.insert("repoLearnings", {
        repositoryId,
        content: "Prefer repository integration tests",
        source: "untrusted",
        sourceType: "comment",
        isTrusted: false,
        embeddingDataProvenance: "private_user_input",
        createdAt: now,
      });
    });
    let embeddingRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).startsWith("https://api.github.com/")) {
        return githubMetadataResponse("private");
      }
      embeddingRequests += 1;
      throw new Error("The free key must not be called");
    });
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const results = await t.action(
      internal.repoLearnings.action.searchLearnings,
      {
        repositoryId,
        query: "Prefer",
        topK: 5,
      },
    );

    expect(embeddingRequests).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: "issue:3",
      isTrusted: true,
      score: 0.7,
    });
  });

  it("does not search learnings after repository access is revoked", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "public",
      licenseSpdxId: "MIT",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("repoLearnings", {
        repositoryId,
        content: "Revoked repositories must not return this learning",
        source: "issue:revoked",
        sourceType: "correction",
        isTrusted: true,
        repositoryTrustKey: getTrustedLearningRepositoryKey(repositoryId),
        embeddingDataProvenance: "private_user_input",
        createdAt: Date.now(),
      });
      await ctx.db.patch(repositoryId, {
        isActive: false,
        githubAccessRevokedAt: Date.now(),
      });
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const results = await t.action(
      internal.repoLearnings.action.searchLearnings,
      { repositoryId, query: "Revoked", topK: 5 },
    );

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not search cached learnings while access-restore indexing is pending", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "public",
      licenseSpdxId: "MIT",
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("repoLearnings", {
        repositoryId,
        content: "Pending restore must not return this cached learning",
        source: "issue:restore-pending",
        sourceType: "correction",
        isTrusted: true,
        repositoryTrustKey: getTrustedLearningRepositoryKey(repositoryId),
        embeddingDataProvenance: "private_user_input",
        createdAt: now,
      });
      await ctx.db.patch(repositoryId, {
        githubAccessRestoreIndexPending: true,
        githubAccessRestoreIndexNextAttemptAt: now,
      });
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      t.action(internal.repoLearnings.action.searchLearnings, {
        repositoryId,
        query: "Pending restore",
        topK: 5,
      }),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("atomically publishes paid usage, its reservation, and the learning", async () => {
    process.env.OPENAI_API_KEY = "paid-test-key";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, {
      githubVisibility: "private",
      licenseSpdxId: "MIT",
    });
    let embeddingRequests = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input).startsWith("https://api.github.com/")) {
        return githubMetadataResponse("private");
      }
      embeddingRequests++;
      return new Response(
        JSON.stringify({
          model: "text-embedding-3-small",
          data: [{ index: 0, embedding: Array(1536).fill(0.04) }],
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const learningId = await t.action(
      internal.repoLearnings.action.createLearning,
      {
        repositoryId,
        content: "Reject unmetered paid learning embeddings.",
        source: "issue:paid-metering",
        sourceType: "correction",
        isTrusted: true,
      },
    );

    const state = await t.run(async (ctx) => ({
      learning: await ctx.db.get(learningId),
      usage: await ctx.db.query("tokenUsage").collect(),
      reservations: await ctx.db.query("embeddingUsageReservations").collect(),
    }));
    expect(embeddingRequests).toBe(1);
    expect(state.learning?.embedding).toHaveLength(1536);
    expect(state.learning?.embeddingKey).toBe(REPO_LEARNING_EMBEDDING_KEY);
    expect(state.usage).toHaveLength(1);
    expect(state.reservations).toHaveLength(1);
    expect(state.reservations[0]).toMatchObject({ status: "finalized" });
    expect(state.usage[0]?.embeddingReservationKey).toBe(
      state.reservations[0].reservationKey,
    );
  });
});
