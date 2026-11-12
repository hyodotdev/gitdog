import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v } from "convex/values";

import { internal } from "../../../convex/_generated/api";
import { internalAction } from "../../../convex/_generated/server";
import schema from "../../../convex/schema";

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
  "../../../convex/repositories/mutation.ts": () =>
    import("../../../convex/repositories/mutation"),
  "../../../convex/invitations/mutation.ts": () =>
    import("../../../convex/invitations/mutation"),
  "../../../convex/invitations/query.ts": () =>
    import("../../../convex/invitations/query"),
  "../../../convex/repositoryMembers/query.ts": () =>
    import("../../../convex/repositoryMembers/query"),
  "../../../convex/repoIndexing/watchdog.ts": () =>
    import("../../../convex/repoIndexing/watchdog"),
  "../../../convex/repoIndexing/action.ts": async () => ({
    indexRepository: noopIndexRepository,
  }),
};

const discussionSettings = {
  discussionAssistantEnabled: true,
  autoFormatDiscussion: true,
  autoAnswerDiscussionQuestions: true,
  tagMaintainersForDiscussionCodeChanges: true,
  requireApprovalForDiscussions: true,
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("repository creation", () => {
  it("creates initial logs and schedules indexing in the same mutation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 123,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      return userId;
    });

    const repositoryId = await t
      .withIdentity({ subject: `${userId}|test-session` })
      .mutation(internal.repositories.mutation.create, {
        installationId: 123,
        githubRepositoryId: 456,
        githubRepo: "owner/repo",
        name: "repo",
        githubUrl: "https://github.com/owner/repo",
      });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      logs: await ctx.db
        .query("repoIndexingLogs")
        .withIndex("by_repository_and_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 0),
        )
        .collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));

    expect(state.repository).toMatchObject({
      githubRepoKey: "owner/repo",
      indexStatus: "pending",
      indexVersion: 0,
      ragStatus: "pending",
    });
    expect(state.logs.map((log) => log.message)).toEqual(
      expect.arrayContaining([
        "Repository connected: owner/repo",
        "Preparing to index repository structure",
        "Indexing job scheduled, starting soon...",
      ]),
    );
    expect(state.logs).toHaveLength(3);
    expect(
      state.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(1);
  });

  it("reactivates an exact reconnect that was active before access removal", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 888,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        userId,
        installationId: 777,
        githubRepositoryId: 9_001,
        githubRepo: "owner/orphaned",
        githubRepoKey: "owner/orphaned",
        name: "orphaned",
        githubUrl: "https://github.com/owner/orphaned",
        isActive: false,
        githubAccessRevokedAt: now,
        isActiveBeforeAccessRevocation: true,
        githubInstallationReconnectRequired: true,
        indexVersion: 5,
        indexStatus: "failed",
        indexProgressAt: now,
        ragStatus: "failed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        settings: {
          ...discussionSettings,
          issueAssistantEnabled: false,
          autoFormatIssue: false,
          autoAnswerQuestions: false,
          tagMaintainersForCodeChanges: false,
          requireApproval: true,
          issueResponseStyle: "Preserve this reconnect policy.",
        },
        monthlyActions: 17,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const invitationId = await ctx.db.insert("invitations", {
        repositoryId,
        invitedByUserId: userId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "member",
        inviteeUserId: memberId,
        role: "viewer",
        status: "accepted",
        createdAt: now,
        respondedAt: now,
      });
      await ctx.db.insert("repositoryMembers", {
        repositoryId,
        userId: memberId,
        githubUsername: "member",
        role: "viewer",
        joinedVia: "invitation",
        invitationId,
        joinedAt: now,
      });
      return { userId, memberId, repositoryId };
    });
    const identity = t.withIdentity({
      subject: `${fixture.userId}|test-session`,
    });

    await expect(
      identity.mutation(internal.repositories.mutation.create, {
        installationId: 888,
        githubRepositoryId: 9_002,
        githubRepo: "owner/different",
        name: "different",
        githubUrl: "https://github.com/owner/different",
        reconnectRepositoryId: fixture.repositoryId,
      }),
    ).rejects.toThrow("invalid repository reconnect target");

    const repositoryId = await identity.mutation(
      internal.repositories.mutation.create,
      {
        installationId: 888,
        githubRepositoryId: 9_001,
        githubRepo: "owner/renamed-after-reinstall",
        name: "renamed-after-reinstall",
        githubUrl: "https://github.com/owner/renamed-after-reinstall",
        reconnectRepositoryId: fixture.repositoryId,
      },
    );

    expect(repositoryId).toBe(fixture.repositoryId);
    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      members: await ctx.db
        .query("repositoryMembers")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repository).toMatchObject({
      installationId: 888,
      githubRepositoryId: 9_001,
      githubRepo: "owner/renamed-after-reinstall",
      isActive: true,
      indexVersion: 6,
      indexStatus: "pending",
      ragStatus: "pending",
      indexWatchdogToken: expect.any(String),
      indexWatchdogScheduleId: expect.any(String),
      monthlyActions: 17,
      settings: {
        issueAssistantEnabled: false,
        issueResponseStyle: "Preserve this reconnect policy.",
      },
    });
    expect(state.repository?.githubAccessRevokedAt).toBeUndefined();
    expect(
      state.repository?.githubInstallationReconnectRequired,
    ).toBeUndefined();
    expect(state.members).toHaveLength(1);
    expect(state.members[0]?.userId).toBe(fixture.memberId);
    expect(
      state.scheduled.filter(
        (scheduled) => scheduled.name === "repoIndexing/action:indexRepository",
      ),
    ).toHaveLength(1);
  });

  it("rejects an explicit reconnect when another numeric ID owns a case alias", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 889,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const reconnectRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        userId,
        installationId: 700,
        githubRepositoryId: 4_700,
        githubRepo: "owner/reused-name",
        githubRepoKey: "owner/reused-name",
        name: "reused-name",
        githubUrl: "https://github.com/owner/reused-name",
        isActive: false,
        githubAccessRevokedAt: now,
        isActiveBeforeAccessRevocation: true,
        githubInstallationReconnectRequired: true,
        indexVersion: 2,
        indexStatus: "failed",
        indexProgressAt: now,
        ragStatus: "failed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        settings: {
          ...discussionSettings,
          issueAssistantEnabled: true,
          autoFormatIssue: true,
          autoAnswerQuestions: true,
          tagMaintainersForCodeChanges: true,
          requireApproval: false,
        },
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const conflictRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        userId,
        installationId: 889,
        githubRepositoryId: 4_701,
        githubRepo: "OWNER/REUSED-NAME",
        githubRepoKey: "owner/reused-name",
        name: "REUSED-NAME",
        githubUrl: "https://github.com/OWNER/REUSED-NAME",
        isActive: true,
        indexVersion: 1,
        indexStatus: "completed",
        indexProgressAt: now,
        ragStatus: "completed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        settings: {
          ...discussionSettings,
          issueAssistantEnabled: true,
          autoFormatIssue: true,
          autoAnswerQuestions: true,
          tagMaintainersForCodeChanges: true,
          requireApproval: false,
        },
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { userId, reconnectRepositoryId, conflictRepositoryId };
    });

    await expect(
      t
        .withIdentity({ subject: `${fixture.userId}|test-session` })
        .mutation(internal.repositories.mutation.create, {
          installationId: 889,
          githubRepositoryId: 4_700,
          githubRepo: "owner/reused-name",
          name: "reused-name",
          githubUrl: "https://github.com/owner/reused-name",
          reconnectRepositoryId: fixture.reconnectRepositoryId,
        }),
    ).rejects.toThrow("repository already connected");

    const state = await t.run(async (ctx) => ({
      reconnect: await ctx.db.get(fixture.reconnectRepositoryId),
      conflict: await ctx.db.get(fixture.conflictRepositoryId),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.reconnect).toMatchObject({
      installationId: 700,
      githubInstallationReconnectRequired: true,
      isActive: false,
    });
    expect(state.conflict).toMatchObject({
      githubRepositoryId: 4_701,
      isActive: true,
    });
    expect(state.scheduled).toHaveLength(0);
  });

  it("keeps an exact reconnect paused when it was paused before access removal", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 889,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        userId,
        installationId: 778,
        githubRepositoryId: 9_003,
        githubRepo: "owner/paused-before-delete",
        githubRepoKey: "owner/paused-before-delete",
        name: "paused-before-delete",
        githubUrl: "https://github.com/owner/paused-before-delete",
        isActive: false,
        githubAccessRevokedAt: now,
        isActiveBeforeAccessRevocation: false,
        githubInstallationReconnectRequired: true,
        indexVersion: 5,
        indexStatus: "failed",
        indexProgressAt: now,
        indexError: "GitHub App repository access was removed",
        lastIndexedAt: now - 20_000,
        ragStatus: "failed",
        ragError: "GitHub App repository access was removed",
        ragLastIndexedAt: now - 10_000,
        ragTotalChunks: 12,
        ragIndexedChunks: 12,
        ragFailedChunks: 0,
        indexWatchdogSequence: 4,
        settings: {
          ...discussionSettings,
          issueAssistantEnabled: true,
          autoFormatIssue: true,
          autoAnswerQuestions: true,
          tagMaintainersForCodeChanges: true,
          requireApproval: true,
        },
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { userId, repositoryId, now };
    });

    const repositoryId = await t
      .withIdentity({ subject: `${fixture.userId}|test-session` })
      .mutation(internal.repositories.mutation.create, {
        installationId: 889,
        githubRepositoryId: 9_003,
        githubRepo: "owner/paused-after-reinstall",
        name: "paused-after-reinstall",
        githubUrl: "https://github.com/owner/paused-after-reinstall",
        reconnectRepositoryId: fixture.repositoryId,
      });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      logs: await ctx.db
        .query("repoIndexingLogs")
        .withIndex("by_repository_and_version", (q) =>
          q.eq("repositoryId", repositoryId).eq("indexVersion", 6),
        )
        .collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));

    expect(repositoryId).toBe(fixture.repositoryId);
    expect(state.repository).toMatchObject({
      installationId: 889,
      githubRepositoryId: 9_003,
      githubRepo: "owner/paused-after-reinstall",
      isActive: false,
      indexVersion: 6,
      indexStatus: "failed",
      indexError: "Repository indexing was paused by its owner",
      lastIndexedAt: fixture.now - 20_000,
      ragStatus: "failed",
      ragError: "Repository indexing was paused by its owner",
      ragLastIndexedAt: fixture.now - 10_000,
      ragTotalChunks: 12,
      ragIndexedChunks: 12,
      ragFailedChunks: 0,
      indexWatchdogSequence: 4,
    });
    expect(state.repository?.githubAccessRevokedAt).toBeUndefined();
    expect(state.repository?.isActiveBeforeAccessRevocation).toBeUndefined();
    expect(
      state.repository?.githubInstallationReconnectRequired,
    ).toBeUndefined();
    expect(state.repository?.indexWatchdogToken).toBeUndefined();
    expect(state.repository?.indexWatchdogScheduleId).toBeUndefined();
    expect(state.logs.map((log) => log.message)).toEqual([
      "Repository reconnected: owner/paused-after-reinstall",
    ]);
    expect(state.scheduled).toHaveLength(0);
  });

  it("quarantines a stale case alias when a verified new ID owns the name", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 125,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      const staleRepositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        userId,
        installationId: 125,
        githubRepositoryId: 458,
        githubRepo: "OWNER/PINNED",
        githubRepoKey: "owner/pinned",
        name: "pinned",
        githubUrl: "https://github.com/OWNER/PINNED",
        isActive: true,
        indexVersion: 1,
        indexStatus: "completed",
        indexProgressAt: now,
        ragStatus: "completed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        settings: {
          ...discussionSettings,
          issueAssistantEnabled: true,
          autoFormatIssue: true,
          autoAnswerQuestions: true,
          tagMaintainersForCodeChanges: true,
          requireApproval: false,
        },
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { userId, staleRepositoryId };
    });

    const repositoryId = await t
      .withIdentity({ subject: `${fixture.userId}|test-session` })
      .mutation(internal.repositories.mutation.create, {
        installationId: 125,
        githubRepositoryId: 459,
        githubRepo: "owner/pinned",
        name: "pinned",
        githubUrl: "https://github.com/owner/pinned",
      });

    const state = await t.run(async (ctx) => ({
      stale: await ctx.db.get(fixture.staleRepositoryId),
      repository: await ctx.db.get(repositoryId),
      repositories: await ctx.db.query("repositories").collect(),
    }));
    expect(state.stale).toMatchObject({
      githubRepositoryId: 458,
      githubRepo: "__gitdog_quarantine__/458",
      githubRepoKey: "__gitdog_quarantine__/458",
      isActive: false,
      isActiveBeforeAccessRevocation: true,
      indexVersion: 2,
      indexStatus: "failed",
      ragStatus: "failed",
    });
    expect(state.stale?.githubAccessRevokedAt).toBeDefined();
    expect(state.stale?.disconnectCleanupPending).toBeUndefined();
    expect(state.repository).toMatchObject({
      githubRepositoryId: 459,
      githubRepo: "owner/pinned",
      githubRepoKey: "owner/pinned",
      isActive: true,
      indexStatus: "pending",
    });
    expect(state.repositories).toHaveLength(2);
  });

  it("rejects an installation owned by another user", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { callerId } = await t.run(async (ctx) => {
      const callerId = await ctx.db.insert("users", {});
      const ownerId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId: ownerId,
        installationId: 456,
        ownerGithubAccountId: "other-verified-owner",
        ownershipVerifiedAt: now,
        accountLogin: "other-owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      return { callerId };
    });

    await expect(
      t
        .withIdentity({ subject: `${callerId}|test-session` })
        .mutation(internal.repositories.mutation.create, {
          installationId: 456,
          githubRepositoryId: 789,
          githubRepo: "other-owner/private-repo",
          name: "private-repo",
          githubUrl: "https://github.com/other-owner/private-repo",
        }),
    ).rejects.toThrow("unauthorized installation");

    const state = await t.run(async (ctx) => ({
      repositories: await ctx.db.query("repositories").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.repositories).toHaveLength(0);
    expect(state.scheduled).toHaveLength(0);
  });

  it("rechecks suspended installation access inside the create transaction", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("githubInstallations", {
        userId,
        installationId: 789,
        ownerGithubAccountId: "verified-owner",
        ownershipVerifiedAt: now,
        accessSuspendedAt: now,
        accountLogin: "owner",
        accountType: "Organization",
        targetType: "Organization",
        createdAt: now,
        updatedAt: now,
      });
      return userId;
    });

    await expect(
      t
        .withIdentity({ subject: `${userId}|test-session` })
        .mutation(internal.repositories.mutation.create, {
          installationId: 789,
          githubRepositoryId: 790,
          githubRepo: "owner/repo",
          name: "repo",
          githubUrl: "https://github.com/owner/repo",
        }),
    ).rejects.toThrow("unauthorized installation");
    expect(
      await t.run(async (ctx) => ctx.db.query("repositories").collect()),
    ).toHaveLength(0);
  });

  it.each(["fetching", "finalizing"] as const)(
    "rejects repository creation while access reconciliation is %s",
    async (repositoryAccessReconciliationPhase) => {
      vi.useFakeTimers();
      const t = convexTest(schema, modules);
      const userId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        const now = Date.now();
        await ctx.db.insert("githubInstallations", {
          userId,
          installationId: 890,
          ownerGithubAccountId: "verified-owner",
          ownershipVerifiedAt: now,
          accountLogin: "owner",
          accountType: "Organization",
          targetType: "Organization",
          repositoryAccessReconciliationEpoch: now,
          repositoryAccessReconciliationPhase,
          ...(repositoryAccessReconciliationPhase === "fetching"
            ? {
                repositoryAccessReconciliationNextPage: 1,
                repositoryAccessReconciliationExpectedSuspendedAt: null,
              }
            : {}),
          createdAt: now,
          updatedAt: now,
        });
        return userId;
      });

      await expect(
        t
          .withIdentity({ subject: `${userId}|test-session` })
          .mutation(internal.repositories.mutation.create, {
            installationId: 890,
            githubRepositoryId: 891,
            githubRepo: "owner/reconciliation-race",
            name: "reconciliation-race",
            githubUrl: "https://github.com/owner/reconciliation-race",
          }),
      ).rejects.toThrow("unauthorized installation");

      expect(
        await t.run(async (ctx) => ctx.db.query("repositories").collect()),
      ).toHaveLength(0);
    },
  );
});
