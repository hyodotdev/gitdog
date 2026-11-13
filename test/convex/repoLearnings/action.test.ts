import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PRICING, getFreeIncludedTokens } from "../../../convex/_ai/config";
import * as githubHelpers from "../../../convex/github/helpers";
import schema from "../../../convex/schema";
import { getTrustedLearningRepositoryKey } from "../../../convex/repoLearnings/trust";
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
});
