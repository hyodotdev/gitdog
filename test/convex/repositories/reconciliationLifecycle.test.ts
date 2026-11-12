import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repositories/internalMutation.ts": () =>
    import("../../../convex/repositories/internalMutation"),
  "../../../convex/repoIndexing/mutation.ts": () =>
    import("../../../convex/repoIndexing/mutation"),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
  "../../../convex/ragV2/internalMutation.ts": () =>
    import("../../../convex/ragV2/internalMutation"),
  "../../../convex/github/internalMutation.ts": () =>
    import("../../../convex/github/internalMutation"),
  "../../../convex/github/internalQuery.ts": () =>
    import("../../../convex/github/internalQuery"),
};

const settings = {
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
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("repository reconciliation lifecycle", () => {
  it("reconciles the active row after an earlier revoked immutable-ID duplicate", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 238,
        ownerGithubAccountId: "owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const staleRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 238,
        githubRepositoryId: 8_008,
        githubRepo: "owner/stale-copy",
        githubRepoKey: "owner/stale-copy",
        name: "stale-copy",
        githubUrl: "https://github.com/owner/stale-copy",
        isActive: false,
        githubAccessRevokedAt: 1,
        isActiveBeforeAccessRevocation: true,
        indexVersion: 2,
        indexStatus: "failed",
        ragStatus: "failed",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const activeRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 238,
        githubRepositoryId: 8_008,
        githubRepo: "owner/live",
        githubRepoKey: "owner/live",
        name: "live",
        githubUrl: "https://github.com/owner/live",
        githubVisibility: "public",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
        isActive: true,
        indexVersion: 3,
        indexStatus: "completed",
        ragStatus: "completed",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { staleRepositoryId, activeRepositoryId };
    });
    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 238, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 238,
          epoch,
          page: 1,
          hasMore: false,
          repositories: [
            {
              githubRepositoryId: 8_008,
              githubRepo: "owner/live",
              githubVisibility: "public",
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 1, stale: false });
    await t.mutation(
      internal.repositories.internalMutation
        .finalizeRepositoryAccessReconciliation,
      {
        installationId: 238,
        epoch,
        paginationOpts: { numItems: 25, cursor: null },
      },
    );

    const state = await t.run(async (ctx) => ({
      stale: await ctx.db.get(fixture.staleRepositoryId),
      active: await ctx.db.get(fixture.activeRepositoryId),
    }));
    expect(state.active).toMatchObject({
      isActive: true,
      githubAccessReconciliationEpoch: epoch,
    });
    expect(state.active?.githubAccessRevokedAt).toBeUndefined();
    expect(state.stale).toMatchObject({
      isActive: false,
      githubAccessRevokedAt: 1,
    });
    expect(state.stale?.githubAccessReconciliationEpoch).toBeUndefined();
  });

  it("fails closed and pauses every row when an immutable ID has two active owners", async () => {
    const t = convexTest(schema, modules);
    const repositoryIds = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 239,
        ownerGithubAccountId: "owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const repositoryIds = [];
      for (const githubRepo of ["owner/first", "owner/second"]) {
        repositoryIds.push(
          await ctx.db.insert("repositories", {
            indexSyncPending: false,
            indexProgressAt: Date.now(),
            ragTotalChunks: 0,
            ragIndexedChunks: 0,
            ragFailedChunks: 0,
            userId,
            installationId: 239,
            githubRepositoryId: 9_009,
            githubRepo,
            githubRepoKey: githubRepo,
            name: githubRepo.split("/").at(-1) ?? githubRepo,
            githubUrl: `https://github.com/${githubRepo}`,
            isActive: true,
            indexVersion: 1,
            indexStatus: "completed",
            ragStatus: "completed",
            settings,
            monthlyActions: 0,
            lastResetAt: now,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      return repositoryIds;
    });
    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 239, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 239,
          epoch,
          page: 1,
          hasMore: false,
          repositories: [
            {
              githubRepositoryId: 9_009,
              githubRepo: "owner/first",
              githubVisibility: "public",
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 0, stale: false });
    await t.mutation(
      internal.repositories.internalMutation
        .finalizeRepositoryAccessReconciliation,
      {
        installationId: 239,
        epoch,
        paginationOpts: { numItems: 25, cursor: null },
      },
    );

    const repositories = await t.run(
      async (ctx) =>
        await Promise.all(
          repositoryIds.map(async (id) => await ctx.db.get(id)),
        ),
    );
    expect(
      repositories.every(
        (repository) =>
          repository?.isActive === false &&
          repository.githubAccessRevokedAt !== undefined &&
          repository.githubAccessReconciliationEpoch === undefined,
      ),
    ).toBe(true);
  });

  it("lets immutable identities resolve reused names in adverse page order", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 240,
        ownerGithubAccountId: "owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const staleRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 240,
        githubRepositoryId: 1_001,
        githubRepo: "Owner/Reused-Name",
        githubRepoKey: "owner/reused-name",
        name: "reused-name",
        githubUrl: "https://github.com/Owner/Reused-Name",
        isActive: true,
        indexVersion: 2,
        indexStatus: "completed",
        ragStatus: "completed",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const incomingRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 240,
        githubRepositoryId: 2_002,
        githubRepo: "owner/incoming-old-name",
        githubRepoKey: "owner/incoming-old-name",
        name: "incoming-old-name",
        githubUrl: "https://github.com/owner/incoming-old-name",
        isActive: true,
        indexVersion: 3,
        indexStatus: "indexing",
        indexIdentityVerifiedVersion: 3,
        indexIdentityVerifiedInstallationId: 240,
        indexIdentityVerifiedGithubRepositoryId: 2_002,
        indexIdentityVerifiedGithubRepo: "owner/incoming-old-name",
        ragStatus: "pending",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { userId, staleRepositoryId, incomingRepositoryId };
    });

    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 240, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 240,
          epoch,
          page: 1,
          hasMore: true,
          repositories: [
            {
              githubRepositoryId: 2_002,
              githubRepo: "owner/reused-name",
              githubVisibility: "public",
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 1, stale: false });
    await expect(
      t.mutation(internal.repoIndexing.mutation.updateIndexingStatus, {
        repositoryId: fixture.incomingRepositoryId,
        expectedIndexVersion: 3,
        status: "failed",
        error: "late stale generation",
      }),
    ).resolves.toBe(false);

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 240,
          epoch,
          page: 2,
          hasMore: false,
          repositories: [
            {
              githubRepositoryId: 1_001,
              githubRepo: "owner/stale-renamed",
              githubVisibility: "public",
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 1, stale: false });
    await t.mutation(
      internal.repositories.internalMutation
        .finalizeRepositoryAccessReconciliation,
      {
        installationId: 240,
        epoch,
        paginationOpts: { numItems: 25, cursor: null },
      },
    );

    const state = await t.run(async (ctx) => ({
      stale: await ctx.db.get(fixture.staleRepositoryId),
      incoming: await ctx.db.get(fixture.incomingRepositoryId),
      canonicalMatches: await ctx.db
        .query("repositories")
        .withIndex("by_user_and_repo_key", (q) =>
          q
            .eq("userId", fixture.userId)
            .eq("githubRepoKey", "owner/reused-name"),
        )
        .collect(),
    }));
    expect(state.incoming).toMatchObject({
      githubRepositoryId: 2_002,
      githubRepo: "owner/reused-name",
      githubRepoKey: "owner/reused-name",
      isActive: true,
      indexVersion: 4,
      indexStatus: "pending",
      ragStatus: "pending",
    });
    expect(state.incoming?.githubAccessRevokedAt).toBeUndefined();
    expect(state.stale).toMatchObject({
      githubRepositoryId: 1_001,
      githubRepo: "owner/stale-renamed",
      isActive: true,
    });
    expect(state.stale?.githubAccessRevokedAt).toBeUndefined();
    expect(state.canonicalMatches.map((repository) => repository._id)).toEqual([
      fixture.incomingRepositoryId,
    ]);
  });

  it("keeps an active generation when reconciliation metadata is unchanged", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 243,
        ownerGithubAccountId: "owner",
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
        installationId: 243,
        githubRepositoryId: 6_006,
        githubRepo: "owner/unchanged",
        githubRepoKey: "owner/unchanged",
        name: "unchanged",
        githubUrl: "https://github.com/owner/unchanged",
        githubVisibility: "public",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
        licenseOsiApproved: false,
        isActive: true,
        indexVersion: 5,
        indexStatus: "completed",
        indexIdentityVerifiedVersion: 5,
        indexIdentityVerifiedInstallationId: 243,
        indexIdentityVerifiedGithubRepositoryId: 6_006,
        indexIdentityVerifiedGithubRepo: "owner/unchanged",
        ragStatus: "indexing",
        ragIndexPhase: "files",
        ragIndexFileOffset: 0,
        ragIndexChunkOffset: 0,
        ragContinuationToken: "unchanged-policy-continuation",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 243, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 243,
          epoch,
          page: 1,
          hasMore: true,
          repositories: [
            {
              githubRepositoryId: 6_006,
              githubRepo: "owner/unchanged",
              githubVisibility: "public",
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 1, stale: false });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      indexVersion: 5,
      indexStatus: "completed",
      indexIdentityVerifiedVersion: 5,
      indexIdentityVerifiedGithubRepo: "owner/unchanged",
      ragStatus: "indexing",
      ragContinuationToken: "unchanged-policy-continuation",
    });
    expect(
      state.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(0);
  });

  it("restarts active RAG when reconciliation changes embedding policy", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 244,
        ownerGithubAccountId: "owner",
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
        installationId: 244,
        githubRepositoryId: 6_007,
        githubRepo: "owner/reconciled-policy",
        githubRepoKey: "owner/reconciled-policy",
        name: "reconciled-policy",
        githubUrl: "https://github.com/owner/reconciled-policy",
        githubVisibility: "public",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
        licenseOsiApproved: true,
        licenseOsiCheckedAt: now,
        repositoryMetadataCheckedAt: 100,
        isActive: true,
        indexVersion: 6,
        indexStatus: "completed",
        ragStatus: "indexing",
        ragEmbeddingBillingTier: "free",
        ragIndexPhase: "files",
        ragIndexFileOffset: 0,
        ragIndexChunkOffset: 0,
        ragContinuationToken: "old-reconciliation-policy",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 244, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 244,
          epoch,
          page: 1,
          hasMore: true,
          repositories: [
            {
              githubRepositoryId: 6_007,
              githubRepo: "owner/reconciled-policy",
              githubVisibility: "private",
              licenseKey: null,
              licenseSpdxId: null,
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 1, stale: false });
    await expect(
      t.mutation(internal.ragV2.internalMutation.claimRagContinuation, {
        repositoryId,
        expectedIndexVersion: 6,
        phase: "files",
        fileOffset: 0,
        chunkOffset: 0,
        continuationToken: "old-reconciliation-policy",
      }),
    ).resolves.toBeNull();

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      githubVisibility: "private",
      indexVersion: 7,
      indexStatus: "pending",
      ragStatus: "pending",
    });
    expect(state.repository?.ragContinuationToken).toBeUndefined();
    expect(
      state.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      label: "a duplicate immutable ID",
      repositories: [
        { githubRepositoryId: 456, githubRepo: "owner/repo-one" },
        { githubRepositoryId: 456, githubRepo: "owner/repo-two" },
      ],
    },
    {
      label: "a duplicate case-insensitive full name",
      repositories: [
        { githubRepositoryId: 456, githubRepo: "owner/repo" },
        { githubRepositoryId: 789, githubRepo: "OWNER/REPO" },
      ],
    },
    {
      label: "a malformed full name",
      repositories: [
        { githubRepositoryId: 456, githubRepo: "owner/repo/extra" },
      ],
    },
  ])(
    "rejects a mutation page containing $label before applying it",
    async (testCase) => {
      const t = convexTest(schema, modules);
      const fixture = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        const epoch = Date.now();
        await ctx.db.insert("githubInstallations", {
          userId,
          installationId: 99,
          ownerGithubAccountId: "owner",
          ownershipVerifiedAt: epoch,
          accountLogin: "owner",
          accountType: "Organization",
          targetType: "Organization",
          repositoryAccessReconciliationEpoch: epoch,
          repositoryAccessReconciliationNextPage: 1,
          repositoryAccessReconciliationExpectedSuspendedAt: null,
          repositoryAccessReconciliationPhase: "fetching",
          createdAt: epoch,
          updatedAt: epoch,
        });
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
          installationId: 99,
          githubRepositoryId: 456,
          githubRepo: "owner/original",
          githubRepoKey: "owner/original",
          name: "original",
          githubUrl: "https://github.com/owner/original",
          isActive: true,
          settings,
          monthlyActions: 0,
          lastResetAt: epoch,
          createdAt: epoch,
          updatedAt: epoch,
        });
        return { epoch, repositoryId };
      });

      await expect(
        t.mutation(
          internal.repositories.internalMutation
            .applyRepositoryAccessReconciliationPage,
          {
            installationId: 99,
            epoch: fixture.epoch,
            page: 1,
            hasMore: false,
            repositories: testCase.repositories.map((repository) => ({
              ...repository,
              githubVisibility: "public" as const,
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            })),
          },
        ),
      ).rejects.toThrow("invalid repository reconciliation identity");
      expect(
        await t.run(async (ctx) => ctx.db.get(fixture.repositoryId)),
      ).toMatchObject({
        githubRepo: "owner/original",
        isActive: true,
      });
    },
  );

  it("does not let an equal-epoch page from another installation reclaim a transferred repository", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const epoch = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 100,
        ownerGithubAccountId: "owner-a",
        ownershipVerifiedAt: epoch,
        accountLogin: "owner-a",
        accountType: "Organization",
        targetType: "Organization",
        repositoryAccessReconciliationEpoch: epoch,
        repositoryAccessReconciliationRevision: 1,
        repositoryAccessReconciliationNextPage: 1,
        repositoryAccessReconciliationExpectedSuspendedAt: null,
        repositoryAccessReconciliationPhase: "fetching",
        createdAt: epoch,
        updatedAt: epoch,
      });
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 200,
        ownerGithubAccountId: "owner-b",
        ownershipVerifiedAt: epoch,
        accountLogin: "owner-b",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: epoch,
        updatedAt: epoch,
      });
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
        installationId: 200,
        githubRepositoryId: 456,
        githubRepo: "owner-b/repo",
        githubRepoKey: "owner-b/repo",
        name: "repo",
        githubUrl: "https://github.com/owner-b/repo",
        githubAccessReconciliationEpoch: epoch,
        githubAccessReconciliationRevision: 1,
        isActive: true,
        settings,
        monthlyActions: 0,
        lastResetAt: epoch,
        createdAt: epoch,
        updatedAt: epoch,
      });
      return { epoch, repositoryId };
    });

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 100,
          epoch: fixture.epoch,
          page: 1,
          hasMore: true,
          repositories: [
            {
              githubRepositoryId: 456,
              githubRepo: "owner-a/repo",
              githubVisibility: "public",
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 0, stale: false });
    expect(
      await t.run(async (ctx) => ctx.db.get(fixture.repositoryId)),
    ).toMatchObject({
      installationId: 200,
      githubRepo: "owner-b/repo",
      githubAccessReconciliationEpoch: fixture.epoch,
    });
  });

  it("uses a global revision to order cross-installation transfers in one millisecond", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const installationIds = [];
      for (const installationId of [100, 200]) {
        installationIds.push(
          await ctx.db.insert("githubInstallations", {
            userId,
            installationId,
            ownerGithubAccountId: `owner-${installationId}`,
            ownershipVerifiedAt: now,
            accountLogin: `owner-${installationId}`,
            accountType: "Organization",
            targetType: "Organization",
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
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
        installationId: 100,
        githubRepositoryId: 456,
        githubRepo: "owner-a/repo",
        githubRepoKey: "owner-a/repo",
        name: "repo",
        githubUrl: "https://github.com/owner-a/repo",
        isActive: true,
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return {
        repositoryId,
        oldInstallationId: installationIds[0],
        currentInstallationId: installationIds[1],
      };
    });

    const oldEpoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 100, expectedAccessSuspendedAt: null },
    );
    if (oldEpoch === null) throw new Error("old reconciliation did not start");
    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 100,
          epoch: oldEpoch,
          page: 1,
          hasMore: true,
          repositories: [
            {
              githubRepositoryId: 456,
              githubRepo: "owner-a/repo",
              githubVisibility: "public",
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 1, stale: false });

    const currentEpoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 200, expectedAccessSuspendedAt: null },
    );
    if (currentEpoch === null) {
      throw new Error("current reconciliation did not start");
    }
    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 200,
          epoch: currentEpoch,
          page: 1,
          hasMore: true,
          repositories: [
            {
              githubRepositoryId: 456,
              githubRepo: "owner-b/repo",
              githubVisibility: "public",
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 1, stale: false });
    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 100,
          epoch: oldEpoch,
          page: 2,
          hasMore: true,
          repositories: [
            {
              githubRepositoryId: 456,
              githubRepo: "owner-a/repo",
              githubVisibility: "public",
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 0, stale: false });

    const state = await t.run(async (ctx) => {
      return {
        repository: await ctx.db.get(fixture.repositoryId),
        oldInstallation: await ctx.db.get(fixture.oldInstallationId),
        currentInstallation: await ctx.db.get(fixture.currentInstallationId),
      };
    });
    expect(currentEpoch).toBe(oldEpoch);
    expect(
      state.currentInstallation?.repositoryAccessReconciliationRevision,
    ).toBeGreaterThan(
      state.oldInstallation?.repositoryAccessReconciliationRevision ?? 0,
    );
    expect(state.repository).toMatchObject({
      installationId: 200,
      githubRepo: "owner-b/repo",
      githubAccessReconciliationEpoch: currentEpoch,
      githubAccessReconciliationRevision:
        state.currentInstallation?.repositoryAccessReconciliationRevision,
    });
  });

  it("does not let stale reconciliation metadata overwrite a newer signed webhook", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const installationDocId = await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 225,
        ownerGithubAccountId: "owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
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
        installationId: 225,
        githubRepositoryId: 456,
        githubRepo: "owner/old-name",
        githubRepoKey: "owner/old-name",
        name: "old-name",
        githubUrl: "https://github.com/owner/old-name",
        githubVisibility: "public",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
        licenseOsiApproved: true,
        licenseOsiCheckedAt: now,
        repositoryMetadataCheckedAt: 100,
        isActive: true,
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { installationDocId, repositoryId };
    });

    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 225, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");
    const reconciliationRevision = await t.run(async (ctx) => {
      const installation = await ctx.db.get(fixture.installationDocId);
      return installation?.repositoryAccessReconciliationRevision;
    });
    if (reconciliationRevision === undefined) {
      throw new Error("reconciliation revision missing");
    }

    await expect(
      t.mutation(
        internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
        {
          repositoryId: fixture.repositoryId,
          expectedGithubRepo: "owner/old-name",
          githubRepositoryId: 456,
          installationId: 225,
          githubRepo: "owner/new-name",
          previousGithubRepo: "owner/old-name",
          liveIdentityVerified: true,
          githubVisibility: "private",
          licenseKey: "apache-2.0",
          licenseSpdxId: "Apache-2.0",
        },
      ),
    ).resolves.toMatchObject({ persisted: true, identityUpdated: true });

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .applyRepositoryAccessReconciliationPage,
        {
          installationId: 225,
          epoch,
          page: 1,
          hasMore: true,
          repositories: [
            {
              githubRepositoryId: 456,
              githubRepo: "owner/old-name",
              githubVisibility: "public",
              licenseKey: "mit",
              licenseSpdxId: "MIT",
            },
          ],
        },
      ),
    ).resolves.toEqual({ applied: 1, stale: false });

    const repository = await t.run(async (ctx) =>
      ctx.db.get(fixture.repositoryId),
    );
    expect(repository).toMatchObject({
      githubRepo: "owner/new-name",
      githubVisibility: "private",
      licenseKey: "apache-2.0",
      licenseSpdxId: "Apache-2.0",
      githubAccessReconciliationEpoch: epoch,
      githubAccessReconciliationRevision: reconciliationRevision,
    });
    expect(repository?.githubMetadataRevision).toBeGreaterThan(
      reconciliationRevision,
    );
  });

  it("lets a signed rename webhook quarantine a stale name owner", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 241,
        ownerGithubAccountId: "owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const staleRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 241,
        githubRepositoryId: 3_003,
        githubRepo: "Owner/Reused-Webhook-Name",
        githubRepoKey: "owner/reused-webhook-name",
        name: "reused-webhook-name",
        githubUrl: "https://github.com/Owner/Reused-Webhook-Name",
        isActive: true,
        indexVersion: 1,
        indexStatus: "completed",
        ragStatus: "completed",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const incomingRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 241,
        githubRepositoryId: 4_004,
        githubRepo: "owner/webhook-old-name",
        githubRepoKey: "owner/webhook-old-name",
        name: "webhook-old-name",
        githubUrl: "https://github.com/owner/webhook-old-name",
        isActive: true,
        indexVersion: 1,
        indexStatus: "completed",
        ragStatus: "completed",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { userId, staleRepositoryId, incomingRepositoryId };
    });

    await expect(
      t.mutation(
        internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
        {
          repositoryId: fixture.incomingRepositoryId,
          expectedGithubRepo: "owner/webhook-old-name",
          githubRepositoryId: 4_004,
          installationId: 241,
          githubRepo: "owner/reused-webhook-name",
          previousGithubRepo: "owner/webhook-old-name",
          liveIdentityVerified: true,
          githubVisibility: "public",
          licenseKey: "mit",
          licenseSpdxId: "MIT",
        },
      ),
    ).resolves.toEqual({
      persisted: true,
      identityUpdated: true,
      paused: false,
    });

    const state = await t.run(async (ctx) => ({
      stale: await ctx.db.get(fixture.staleRepositoryId),
      incoming: await ctx.db.get(fixture.incomingRepositoryId),
      canonicalMatches: await ctx.db
        .query("repositories")
        .withIndex("by_user_and_repo_key", (q) =>
          q
            .eq("userId", fixture.userId)
            .eq("githubRepoKey", "owner/reused-webhook-name"),
        )
        .collect(),
    }));
    expect(state.incoming).toMatchObject({
      githubRepositoryId: 4_004,
      githubRepo: "owner/reused-webhook-name",
      githubRepoKey: "owner/reused-webhook-name",
      isActive: true,
    });
    expect(state.incoming?.githubAccessRevokedAt).toBeUndefined();
    expect(state.stale).toMatchObject({
      githubRepositoryId: 3_003,
      githubRepo: "__gitdog_quarantine__/3003",
      githubRepoKey: "__gitdog_quarantine__/3003",
      isActive: false,
      indexStatus: "failed",
      ragStatus: "failed",
    });
    expect(state.stale?.githubAccessRevokedAt).toBeDefined();
    expect(state.canonicalMatches.map((repository) => repository._id)).toEqual([
      fixture.incomingRepositoryId,
    ]);
  });

  it("restarts indexing when a rename webhook invalidates an active page", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 242,
        ownerGithubAccountId: "owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 242,
        githubRepositoryId: 5_005,
        githubRepo: "owner/before-rename",
        githubRepoKey: "owner/before-rename",
        name: "before-rename",
        githubUrl: "https://github.com/owner/before-rename",
        isActive: true,
        indexVersion: 7,
        indexStatus: "indexing",
        indexIdentityVerifiedVersion: 7,
        indexIdentityVerifiedInstallationId: 242,
        indexIdentityVerifiedGithubRepositoryId: 5_005,
        indexIdentityVerifiedGithubRepo: "owner/before-rename",
        ragStatus: "indexing",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { userId, repositoryId };
    });

    await expect(
      t.mutation(
        internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
        {
          repositoryId: fixture.repositoryId,
          expectedGithubRepo: "owner/before-rename",
          githubRepositoryId: 5_005,
          installationId: 242,
          githubRepo: "owner/after-rename",
          previousGithubRepo: "owner/before-rename",
          liveIdentityVerified: true,
          githubVisibility: "public",
          licenseKey: "mit",
          licenseSpdxId: "MIT",
        },
      ),
    ).resolves.toMatchObject({ persisted: true, identityUpdated: true });
    await expect(
      t.mutation(internal.repoIndexing.mutation.reuseFileBlob, {
        repositoryId: fixture.repositoryId,
        expectedUserId: fixture.userId,
        expectedInstallationId: 242,
        expectedGithubRepositoryId: 5_005,
        expectedGithubRepo: "owner/before-rename",
        expectedIndexVersion: 7,
        filePath: "README.md",
        sha256: "old-page-sha",
        size: 10,
        isText: true,
      }),
    ).resolves.toBe("stale");
    await expect(
      t.mutation(internal.repoIndexing.mutation.updateIndexingStatus, {
        repositoryId: fixture.repositoryId,
        expectedIndexVersion: 7,
        status: "failed",
        error: "stale repository indexing generation",
      }),
    ).resolves.toBe(false);

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(fixture.repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      githubRepo: "owner/after-rename",
      indexVersion: 8,
      indexStatus: "pending",
      ragStatus: "pending",
      indexWatchdogRetryCount: 0,
    });
    expect(state.repository?.indexError).toBeUndefined();
    expect(state.repository?.ragError).toBeUndefined();
    expect(state.repository?.indexIdentityVerifiedVersion).toBeUndefined();
    expect(
      state.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(1);
  });

  it("restarts active RAG when a webhook changes embedding policy", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 245,
        ownerGithubAccountId: "owner",
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
        installationId: 245,
        githubRepositoryId: 7_007,
        githubRepo: "owner/policy-change",
        githubRepoKey: "owner/policy-change",
        name: "policy-change",
        githubUrl: "https://github.com/owner/policy-change",
        githubVisibility: "public",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
        licenseOsiApproved: true,
        licenseOsiCheckedAt: now,
        repositoryMetadataCheckedAt: 100,
        isActive: true,
        indexVersion: 9,
        indexStatus: "completed",
        ragStatus: "indexing",
        ragEmbeddingBillingTier: "free",
        ragIndexPhase: "files",
        ragIndexFileOffset: 0,
        ragIndexChunkOffset: 0,
        ragContinuationToken: "old-policy-continuation",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(
        internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
        {
          repositoryId,
          expectedGithubRepo: "owner/policy-change",
          githubRepositoryId: 7_007,
          installationId: 245,
          githubRepo: "owner/policy-change",
          githubVisibility: "private",
          licenseKey: null,
          licenseSpdxId: null,
        },
      ),
    ).resolves.toMatchObject({ persisted: true, identityUpdated: true });
    await expect(
      t.mutation(internal.ragV2.internalMutation.claimRagContinuation, {
        repositoryId,
        expectedIndexVersion: 9,
        phase: "files",
        fileOffset: 0,
        chunkOffset: 0,
        continuationToken: "old-policy-continuation",
      }),
    ).resolves.toBeNull();

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      githubVisibility: "private",
      indexVersion: 10,
      indexStatus: "pending",
      ragStatus: "pending",
      indexWatchdogRetryCount: 0,
    });
    expect(state.repository?.ragContinuationToken).toBeUndefined();
    expect(
      state.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(1);
  });

  it.each([
    { label: "duplicate rows", revisions: [1, 2] },
    { label: "counter overflow", revisions: [Number.MAX_SAFE_INTEGER] },
  ])(
    "fails closed for an invalid global revision clock: $label",
    async ({ revisions }) => {
      const t = convexTest(schema, modules);
      const installationDocId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        const now = Date.now();
        for (const revision of revisions) {
          await ctx.db.insert("githubRepositoryAccessReconciliationClock", {
            key: "global",
            revision,
            updatedAt: now,
          });
        }
        return await ctx.db.insert("githubInstallations", {
          userId,
          installationId: 250,
          ownerGithubAccountId: "owner",
          ownershipVerifiedAt: now,
          accountLogin: "owner",
          accountType: "Organization",
          targetType: "Organization",
          createdAt: now,
          updatedAt: now,
        });
      });

      await expect(
        t.mutation(
          internal.github.internalMutation.startRepositoryAccessReconciliation,
          { installationId: 250, expectedAccessSuspendedAt: null },
        ),
      ).rejects.toThrow(/reconciliation clock/i);
      const state = await t.run(async (ctx) => ({
        installation: await ctx.db.get(installationDocId),
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      }));
      expect(
        state.installation?.repositoryAccessReconciliationPhase,
      ).toBeUndefined();
      expect(state.scheduled).toHaveLength(0);
    },
  );

  it.each([
    {
      label: "a reconciliation phase only",
      installationPatch: {
        repositoryAccessReconciliationPhase: "fetching" as const,
      },
    },
    {
      label: "a removal marker only",
      installationPatch: { repositoryRemovalPendingAt: 1 },
    },
  ])(
    "does not restore revoked access while the installation has $label",
    async ({ installationPatch }) => {
      const t = convexTest(schema, modules);
      const repositoryId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        const now = Date.now();
        await ctx.db.insert("githubInstallations", {
          userId,
          installationId: 811,
          ownerGithubAccountId: "owner",
          ownershipVerifiedAt: now,
          accountLogin: "owner",
          accountType: "Organization",
          targetType: "Organization",
          createdAt: now,
          updatedAt: now,
          ...installationPatch,
        });
        return await ctx.db.insert("repositories", {
          indexSyncPending: false,
          indexProgressAt: Date.now(),
          ragTotalChunks: 0,
          ragIndexedChunks: 0,
          ragFailedChunks: 0,
          userId,
          installationId: 811,
          githubRepositoryId: 456,
          githubRepo: "owner/repo",
          githubRepoKey: "owner/repo",
          name: "repo",
          githubUrl: "https://github.com/owner/repo",
          isActive: false,
          githubAccessRevokedAt: 10,
          isActiveBeforeAccessRevocation: true,
          indexVersion: 3,
          indexStatus: "failed",
          ragStatus: "failed",
          settings,
          monthlyActions: 0,
          lastResetAt: now,
          createdAt: now,
          updatedAt: now,
        });
      });

      await expect(
        t.mutation(
          internal.repositories.internalMutation
            .restoreRepositoryAfterAccessAdded,
          {
            installationId: 811,
            githubRepositoryId: 456,
            githubRepo: "owner/repo",
          },
        ),
      ).resolves.toEqual([]);
      expect(
        await t.run(async (ctx) => ctx.db.get(repositoryId)),
      ).toMatchObject({
        isActive: false,
        githubAccessRevokedAt: 10,
        isActiveBeforeAccessRevocation: true,
      });
    },
  );

  it.each([
    { label: "inactive", repositoryPatch: { isActive: false } },
    {
      label: "revoked",
      repositoryPatch: { githubAccessRevokedAt: 1 },
    },
    {
      label: "disconnecting",
      repositoryPatch: { disconnectCleanupPending: true },
    },
    {
      label: "installation removal pending",
      installationPatch: { repositoryRemovalPendingAt: 1 },
    },
  ])("rejects a metadata webhook while $label", async (testCase) => {
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 812,
        ownerGithubAccountId: "owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
        ...testCase.installationPatch,
      });
      return await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexStatus: "completed",
        indexProgressAt: Date.now(),
        ragStatus: "completed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 812,
        githubRepositoryId: 456,
        githubRepo: "owner/repo",
        githubRepoKey: "owner/repo",
        name: "repo",
        githubUrl: "https://github.com/owner/repo",
        githubVisibility: "public",
        licenseKey: "mit",
        licenseSpdxId: "MIT",
        licenseOsiApproved: true,
        repositoryMetadataCheckedAt: 100,
        isActive: true,
        indexVersion: 3,
        indexIdentityVerifiedVersion: 3,
        indexIdentityVerifiedInstallationId: 812,
        indexIdentityVerifiedGithubRepositoryId: 456,
        indexIdentityVerifiedGithubRepo: "owner/repo",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
        ...testCase.repositoryPatch,
      });
    });

    await expect(
      t.mutation(
        internal.repositories.internalMutation.applyRepositoryWebhookUpdate,
        {
          repositoryId,
          expectedGithubRepo: "owner/repo",
          githubRepositoryId: 456,
          installationId: 812,
          githubRepo: "owner/repo",
          githubVisibility: "private",
          licenseKey: "apache-2.0",
          licenseSpdxId: "Apache-2.0",
        },
      ),
    ).resolves.toEqual({
      persisted: false,
      identityUpdated: false,
      paused: false,
    });
    expect(await t.run(async (ctx) => ctx.db.get(repositoryId))).toMatchObject({
      githubVisibility: "public",
      licenseKey: "mit",
      licenseSpdxId: "MIT",
      repositoryMetadataCheckedAt: 100,
    });
  });

  it("cleans tree snapshot storage when access is revoked", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 812,
        ownerGithubAccountId: "owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const queueStorageId = await ctx.storage.store(new Blob(["queue"]));
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 812,
        githubRepositoryId: 456,
        githubRepo: "owner/repo",
        githubRepoKey: "owner/repo",
        name: "repo",
        githubUrl: "https://github.com/owner/repo",
        isActive: true,
        indexVersion: 3,
        indexStatus: "indexing",
        ragStatus: "indexing",
        ragIndexPhase: "files",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const snapshotId = await ctx.db.insert("repoTreeSnapshots", {
        repositoryId,
        indexVersion: 3,
        defaultBranch: "main",
        commitSha: "commit",
        treeSha: "tree",
        totalFiles: 0,
        totalPages: 0,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("repoTreeTraversalQueue", {
        snapshotId,
        identityKey: "tree:",
        sha: "tree",
        prefix: "",
        responseStorageId: queueStorageId,
        itemOffset: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(repositoryId, { indexTreeSnapshotId: snapshotId });
      return {
        queueStorageId,
        repositoryId,
        snapshotId,
      };
    });

    await expect(
      t.mutation(
        internal.repositories.internalMutation
          .pauseRepositoryAfterAccessRemoval,
        {
          installationId: 812,
          githubRepositoryId: 456,
        },
      ),
    ).resolves.toBe(1);
    const paused = await t.run(async (ctx) => ({
      repository: await ctx.db.get(fixture.repositoryId),
      snapshot: await ctx.db.get(fixture.snapshotId),
    }));
    expect(paused.repository).toMatchObject({
      isActive: false,
      indexVersion: 4,
      indexStatus: "failed",
      ragStatus: "failed",
    });
    expect(paused.repository?.indexTreeSnapshotId).toBeUndefined();
    expect(paused.snapshot?.status).toBe("deleting");

    await t.mutation(
      internal.repoIndexing.mutation.continueIndexTreeSnapshotCleanup,
      { snapshotId: fixture.snapshotId },
    );
    expect(
      await t.run(async (ctx) => ctx.storage.getUrl(fixture.queueStorageId)),
    ).toBeNull();
  });

  it("keeps the installation sealed until the final access sweep completes", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const installationDocId = await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 913,
        ownerGithubAccountId: "owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 913,
        githubRepositoryId: 914,
        githubRepo: "owner/removed-during-finalization",
        githubRepoKey: "owner/removed-during-finalization",
        name: "removed-during-finalization",
        githubUrl: "https://github.com/owner/removed-during-finalization",
        isActive: true,
        indexVersion: 2,
        indexStatus: "completed",
        ragStatus: "completed",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { installationDocId, repositoryId };
    });

    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 913, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");

    expect(
      await t.query(
        internal.github.internalQuery.getVerifiedInstallationByInstallationId,
        { installationId: 913 },
      ),
    ).toBeNull();

    await t.mutation(
      internal.repositories.internalMutation
        .applyRepositoryAccessReconciliationPage,
      {
        installationId: 913,
        epoch,
        page: 1,
        hasMore: false,
        repositories: [],
      },
    );

    const beforeFinalSweep = await t.run(async (ctx) => ({
      installation: await ctx.db.get(fixture.installationDocId),
      repository: await ctx.db.get(fixture.repositoryId),
    }));
    expect(beforeFinalSweep.installation).toMatchObject({
      repositoryRemovalPendingAt: expect.any(Number),
      repositoryAccessReconciliationPhase: "finalizing",
    });
    expect(beforeFinalSweep.repository?.isActive).toBe(true);
    expect(
      await t.query(
        internal.github.internalQuery.getVerifiedInstallationByInstallationId,
        { installationId: 913 },
      ),
    ).toBeNull();

    await t.mutation(
      internal.repositories.internalMutation
        .finalizeRepositoryAccessReconciliation,
      {
        installationId: 913,
        epoch,
        paginationOpts: { numItems: 25, cursor: null },
      },
    );

    const finalState = await t.run(async (ctx) => ({
      installation: await ctx.db.get(fixture.installationDocId),
      repository: await ctx.db.get(fixture.repositoryId),
    }));
    expect(finalState.installation?.repositoryRemovalPendingAt).toBeUndefined();
    expect(
      finalState.installation?.repositoryAccessReconciliationPhase,
    ).toBeUndefined();
    expect(finalState.repository).toMatchObject({
      isActive: false,
      githubAccessRevokedAt: expect.any(Number),
    });
    expect(
      await t.query(
        internal.github.internalQuery.getVerifiedInstallationByInstallationId,
        { installationId: 913 },
      ),
    ).not.toBeNull();
  });

  it("does not restore a revoked repository after owner disconnect starts", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 915,
        ownerGithubAccountId: "owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: now,
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 915,
        githubRepositoryId: 916,
        githubRepo: "owner/disconnecting-restore",
        githubRepoKey: "owner/disconnecting-restore",
        name: "disconnecting-restore",
        githubUrl: "https://github.com/owner/disconnecting-restore",
        isActive: false,
        githubAccessRevokedAt: 1,
        isActiveBeforeAccessRevocation: true,
        indexVersion: 2,
        indexStatus: "failed",
        ragStatus: "failed",
        settings,
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { repositoryId };
    });

    const epoch = await t.mutation(
      internal.github.internalMutation.startRepositoryAccessReconciliation,
      { installationId: 915, expectedAccessSuspendedAt: null },
    );
    if (epoch === null) throw new Error("reconciliation did not start");
    await t.mutation(
      internal.repositories.internalMutation
        .applyRepositoryAccessReconciliationPage,
      {
        installationId: 915,
        epoch,
        page: 1,
        hasMore: false,
        repositories: [
          {
            githubRepositoryId: 916,
            githubRepo: "owner/disconnecting-restore",
            githubVisibility: "public",
            licenseKey: "mit",
            licenseSpdxId: "MIT",
          },
        ],
      },
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.repositoryId, {
        disconnectCleanupPending: true,
        disconnectCleanupPhase: "tree",
        isActive: false,
        indexStatus: "failed",
        ragStatus: "failed",
        updatedAt: Date.now(),
      });
    });

    await t.mutation(
      internal.repositories.internalMutation
        .finalizeRepositoryAccessReconciliation,
      {
        installationId: 915,
        epoch,
        paginationOpts: { numItems: 25, cursor: null },
      },
    );

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(fixture.repositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      disconnectCleanupPending: true,
      disconnectCleanupPhase: "tree",
      isActive: false,
      githubAccessRevokedAt: 1,
      isActiveBeforeAccessRevocation: true,
    });
    expect(state.repository?.githubAccessRestoreIndexPending).toBeUndefined();
    expect(
      state.scheduled.filter(
        (scheduled) =>
          scheduled.name === "github/action:prepareRestoredRepositoryIndex",
      ),
    ).toHaveLength(0);
  });
});
