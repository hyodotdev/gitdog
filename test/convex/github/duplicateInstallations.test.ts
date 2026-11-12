import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/github/internalMutation.ts": () =>
    import("../../../convex/github/internalMutation"),
  "../../../convex/github/query.ts": () =>
    import("../../../convex/github/query"),
  "../../../convex/repositories/internalMutation.ts": () =>
    import("../../../convex/repositories/internalMutation"),
  "../../../convex/repositories/internalQuery.ts": () =>
    import("../../../convex/repositories/internalQuery"),
  "../../../convex/repoIndexing/mutation.ts": () =>
    import("../../../convex/repoIndexing/mutation"),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
  "../../../convex/ragV2/internalMutation.ts": () =>
    import("../../../convex/ragV2/internalMutation"),
};

type DuplicateFixture = {
  ownerId: Id<"users">;
  repositoryId: Id<"repositories">;
  installationId: number;
  githubRepositoryId: number;
  now: number;
};

async function insertDuplicateFixture(
  t: ReturnType<typeof convexTest>,
  installationId: number,
): Promise<DuplicateFixture> {
  return await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", {});
    const conflictingOwnerId = await ctx.db.insert("users", {});
    const now = Date.now();
    for (const [userId, accountId] of [
      [ownerId, "1001"],
      [conflictingOwnerId, "2002"],
    ] as const) {
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId,
        ownerGithubAccountId: accountId,
        ownershipVerifiedAt: now,
        accountLogin: `owner-${accountId}`,
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
    }

    const githubRepositoryId = installationId * 10;
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexProgressAt: Date.now(),
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId: ownerId,
      installationId,
      githubRepositoryId,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      githubVisibility: "public",
      licenseKey: "mit",
      licenseSpdxId: "MIT",
      licenseOsiApproved: true,
      licenseOsiCheckedAt: now,
      repositoryMetadataCheckedAt: now,
      isActive: true,
      indexVersion: 3,
      indexStatus: "completed",
      ragStatus: "indexing",
      ragEmbeddingMode: "openai",
      ragEmbeddingBillingTier: "free",
      ragEmbeddingKey: "embedding-key",
      ragIndexPhase: "files",
      ragIndexFileOffset: 0,
      ragIndexChunkOffset: 0,
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        requireApproval: false,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApprovalForDiscussions: false,
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return {
      ownerId,
      repositoryId,
      installationId,
      githubRepositoryId,
      now,
    };
  });
}

describe("duplicate GitHub installation fail-closed behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("hides cross-owner duplicates and rejects cached AI readiness", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertDuplicateFixture(t, 901);

    const installations = await t
      .withIdentity({ subject: `${fixture.ownerId}|session` })
      .query(api.github.query.getUserInstallations, {});
    const access = await t.query(
      internal.repositories.internalQuery.getAiAccessSnapshot,
      { repositoryId: fixture.repositoryId, expectedIndexVersion: 3 },
    );

    expect(installations).toEqual([]);
    expect(access).toBeNull();
  });

  it("quarantines initialize attempts and rejects index publication", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertDuplicateFixture(t, 902);

    const verified = await t.mutation(
      internal.repoIndexing.mutation.recordIndexIdentityVerification,
      {
        repositoryId: fixture.repositoryId,
        expectedIndexVersion: 3,
        installationId: fixture.installationId,
        githubRepositoryId: fixture.githubRepositoryId,
        githubRepo: "owner/repo",
      },
    );
    await t
      .withIdentity({ subject: `${fixture.ownerId}|session` })
      .mutation(api.repoIndexing.mutation.initializeIndexing, {
        repositoryId: fixture.repositoryId,
      });
    const repository = await t.run(async (ctx) =>
      ctx.db.get(fixture.repositoryId),
    );

    expect(verified).toBe(false);
    expect(repository).toMatchObject({
      isActive: false,
      githubInstallationReconnectRequired: true,
      indexStatus: "failed",
      ragStatus: "failed",
    });
    expect(repository?.indexIdentityVerifiedVersion).toBeUndefined();
  });

  it("rejects RAG vector publication from a duplicated installation", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertDuplicateFixture(t, 903);

    const result = await t.mutation(
      internal.ragV2.internalMutation.upsertChunks,
      {
        repositoryId: fixture.repositoryId,
        indexVersion: 3,
        chunks: [
          {
            chunkId: "duplicate-installation",
            path: "index.ts",
            language: "typescript",
            code: "export const denied = true;",
            startLine: 1,
            endLine: 1,
            symbols: ["denied"],
            contentHash: "duplicate-installation",
            searchableText: "denied",
            embedding: [0.1],
            embeddingKey: "embedding-key",
          },
        ],
        embeddingPublication: {
          userId: fixture.ownerId,
          installationId: fixture.installationId,
          githubRepositoryId: fixture.githubRepositoryId,
          githubRepo: "owner/repo",
          githubVisibility: "public",
          licenseKey: "mit",
          licenseSpdxId: "MIT",
          licenseOsiApproved: true,
          repositoryMetadataCheckedAt: fixture.now,
          licenseOsiCheckedAt: fixture.now,
          embeddingBillingTier: "free",
          embeddingKey: "embedding-key",
          phase: "files",
          fileOffset: 0,
          chunkOffset: 0,
        },
      },
    );
    const chunks = await t.run(async (ctx) =>
      ctx.db
        .query("repoChunks")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", fixture.repositoryId),
        )
        .take(2),
    );

    expect(result).toBeNull();
    expect(chunks).toEqual([]);
  });

  it.each([
    { deleteInstallationAfterPause: false, installationId: 904 },
    { deleteInstallationAfterPause: true, installationId: 905 },
  ])(
    "fences every repository during duplicate suspend/delete cleanup: %o",
    async ({ deleteInstallationAfterPause, installationId }) => {
      const t = convexTest(schema, modules);
      const fixture = await insertDuplicateFixture(t, installationId);

      await t.mutation(
        internal.github.internalMutation.beginInstallationAccessRemoval,
        { installationId, deleteInstallationAfterPause },
      );
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());

      const state = await t.run(async (ctx) => ({
        repository: await ctx.db.get(fixture.repositoryId),
        installations: await ctx.db
          .query("githubInstallations")
          .withIndex("by_installation_id", (q) =>
            q.eq("installationId", installationId),
          )
          .take(3),
      }));
      expect(state.repository).toMatchObject({
        isActive: false,
        githubAccessRevokedAt: expect.any(Number),
        indexStatus: "failed",
        ragStatus: "failed",
      });
      expect(state.installations).toHaveLength(2);
      expect(
        state.installations.every(
          (installation) => installation.accessSuspendedAt !== undefined,
        ),
      ).toBe(true);
    },
  );

  it("turns a duplicate repository-removal delivery into an installation-wide fence", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertDuplicateFixture(t, 906);
    const payloadStorageId = await t.run(async (ctx) =>
      ctx.storage.store(
        new Blob([
          JSON.stringify([
            {
              githubRepositoryId: fixture.githubRepositoryId,
              githubRepo: "owner/repo",
            },
          ]),
        ]),
      ),
    );

    const result = await t.mutation(
      internal.github.internalMutation.createRepositoryRemovalJob,
      {
        deliveryId: "duplicate-installation-removal",
        installationId: fixture.installationId,
        payloadStorageId,
        totalRepositories: 1,
      },
    );
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(fixture.repositoryId),
      payloadUrl: await ctx.storage.getUrl(payloadStorageId),
      jobs: await ctx.db
        .query("githubRepositoryRemovalJobs")
        .withIndex("by_delivery_id", (q) =>
          q.eq("deliveryId", "duplicate-installation-removal"),
        )
        .take(2),
    }));

    expect(result).toEqual({ jobId: null, created: false });
    expect(state.repository).toMatchObject({
      isActive: false,
      githubAccessRevokedAt: expect.any(Number),
    });
    expect(state.payloadUrl).toBeNull();
    expect(state.jobs).toEqual([]);
  });
});
