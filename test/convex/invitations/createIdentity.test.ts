import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import * as githubHelpers from "../../../convex/github/helpers";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/invitations/action.ts": () =>
    import("../../../convex/invitations/action"),
  "../../../convex/invitations/internalMutation.ts": () =>
    import("../../../convex/invitations/internalMutation"),
  "../../../convex/invitations/internalQuery.ts": () =>
    import("../../../convex/invitations/internalQuery"),
  "../../../convex/invitations/mutation.ts": () =>
    import("../../../convex/invitations/mutation"),
  "../../../convex/invitations/query.ts": () =>
    import("../../../convex/invitations/query"),
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

const originalAppId = process.env.GITHUB_APP_ID;
const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
let mockedGetInstallationToken: MockedFunction<
  typeof githubHelpers.getInstallationToken
>;
let mockedFetchGitHubAppJson: MockedFunction<
  typeof githubHelpers.fetchGitHubAppJsonWithRetry
>;

beforeEach(() => {
  process.env.GITHUB_APP_ID = "test-app-id";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  mockedGetInstallationToken = vi
    .spyOn(githubHelpers, "getInstallationToken")
    .mockResolvedValue("installation-token");
  mockedFetchGitHubAppJson = vi
    .spyOn(githubHelpers, "fetchGitHubAppJsonWithRetry")
    .mockResolvedValue({ id: 700, login: "canonical-user", type: "User" });
});

afterEach(() => {
  if (originalAppId === undefined) {
    delete process.env.GITHUB_APP_ID;
  } else {
    process.env.GITHUB_APP_ID = originalAppId;
  }
  if (originalPrivateKey === undefined) {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  } else {
    process.env.GITHUB_APP_PRIVATE_KEY = originalPrivateKey;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function insertOwnerFixture(t: ReturnType<typeof convexTest>): Promise<{
  ownerUserId: Id<"users">;
  repositoryId: Id<"repositories">;
}> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerUserId = await ctx.db.insert("users", { name: "owner" });
    await ctx.db.insert("subscriptions", {
      userId: ownerUserId,
      plan: "pro",
      status: "active",
      proEntitlementProvenance: {
        source: "lemon_squeezy_webhook",
        verifiedAt: now,
      },
      includedTokens: 2_400_000,
      purchasedTokens: 0,
      serviceFeeRate: 0.18,
      periodStart: now,
      periodEnd: now + 30 * 24 * 60 * 60 * 1_000,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("githubInstallations", {
      userId: ownerUserId,
      installationId: 812,
      ownerGithubAccountId: "owner-github-id",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "User",
      targetType: "User",
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
      userId: ownerUserId,
      installationId: 812,
      githubRepositoryId: 456,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      settings,
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { ownerUserId, repositoryId };
  });
}

async function insertGitHubUser(
  t: ReturnType<typeof convexTest>,
  githubAccountId: number,
  profileNames: string[] = [],
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "github",
      providerAccountId: githubAccountId.toString(),
    });
    for (const githubUsername of profileNames) {
      await ctx.db.insert("userProfiles", {
        userId,
        githubUsername,
        createdAt: now,
        updatedAt: now,
      });
    }
    return userId;
  });
}

async function getInvitationWrites(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    invitations: await ctx.db.query("invitations").collect(),
    notifications: await ctx.db.query("notifications").collect(),
  }));
}

describe("verified invitation creation", () => {
  it("ignores a malicious mutable profile that claims the requested login", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
    const victimUserId = await insertGitHubUser(t, 700, ["victim-old-name"]);
    const attackerUserId = await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("userProfiles", {
        userId,
        githubUsername: "victim-login",
        createdAt: now,
        updatedAt: now,
      });
      return userId;
    });
    mockedFetchGitHubAppJson.mockResolvedValue({
      id: 700,
      login: "Victim-Login",
      type: "User",
    });

    const invitationId = await t
      .withIdentity({ subject: `${ownerUserId}|owner-session` })
      .action(api.invitations.action.create, {
        repositoryId,
        inviteeGithubUsername: "victim-login",
        role: "viewer",
      });

    const writes = await getInvitationWrites(t);
    expect(writes.invitations).toEqual([
      expect.objectContaining({
        _id: invitationId,
        inviteeUserId: victimUserId,
        inviteeGithubUsername: "Victim-Login",
      }),
    ]);
    expect(writes.notifications).toEqual([
      expect.objectContaining({ userId: victimUserId, invitationId }),
    ]);
    await expect(
      t
        .withIdentity({ subject: `${attackerUserId}|attacker-session` })
        .query(api.invitations.query.listPending, {}),
    ).resolves.toEqual([]);
  });

  it("does not use duplicate profile rows to select the invitee", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
    const mappedUserId = await insertGitHubUser(t, 701, ["duplicate-login"]);
    await t.run(async (ctx) => {
      const now = Date.now();
      const otherUserId = await ctx.db.insert("users", {});
      await ctx.db.insert("userProfiles", {
        userId: otherUserId,
        githubUsername: "duplicate-login",
        createdAt: now,
        updatedAt: now,
      });
    });
    mockedFetchGitHubAppJson.mockResolvedValue({
      id: 701,
      login: "duplicate-login",
      type: "User",
    });

    await t
      .withIdentity({ subject: `${ownerUserId}|owner-session` })
      .action(api.invitations.action.create, {
        repositoryId,
        inviteeGithubUsername: "duplicate-login",
        role: "viewer",
      });

    expect((await getInvitationWrites(t)).invitations[0]).toMatchObject({
      inviteeUserId: mappedUserId,
    });
  });

  it("stores the canonical live login and maps the immutable GitHub ID", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
    const inviteeUserId = await insertGitHubUser(t, 702);
    mockedFetchGitHubAppJson.mockResolvedValue({
      id: 702,
      login: "Canonical-Login",
      type: "User",
    });

    const invitationId = await t
      .withIdentity({ subject: `${ownerUserId}|owner-session` })
      .action(api.invitations.action.create, {
        repositoryId,
        inviteeGithubUsername: "old-login",
        role: "viewer",
      });

    expect(mockedGetInstallationToken).toHaveBeenCalledWith(
      812,
      "test-app-id",
      "test-private-key",
    );
    expect(mockedFetchGitHubAppJson).toHaveBeenCalledWith(
      "https://api.github.com/users/old-login",
      "installation-token",
      "GitHub invitation account lookup",
      { maxAttempts: 2, timeoutMs: 15_000 },
    );
    expect((await getInvitationWrites(t)).invitations[0]).toMatchObject({
      _id: invitationId,
      inviteeUserId,
      inviteeGithubUsername: "Canonical-Login",
    });
  });

  it("fails without writes when the live GitHub account is not mapped", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
    mockedFetchGitHubAppJson.mockResolvedValue({
      id: 703,
      login: "unmapped-user",
      type: "User",
    });

    await expect(
      t
        .withIdentity({ subject: `${ownerUserId}|owner-session` })
        .action(api.invitations.action.create, {
          repositoryId,
          inviteeGithubUsername: "unmapped-user",
          role: "viewer",
        }),
    ).rejects.toThrow("User not found");
    expect(await getInvitationWrites(t)).toEqual({
      invitations: [],
      notifications: [],
    });
  });

  it("fails closed when the OAuth account mapping is corrupt", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
    await insertGitHubUser(t, 704);
    await insertGitHubUser(t, 704);
    mockedFetchGitHubAppJson.mockResolvedValue({
      id: 704,
      login: "duplicate-account",
      type: "User",
    });

    await expect(
      t
        .withIdentity({ subject: `${ownerUserId}|owner-session` })
        .action(api.invitations.action.create, {
          repositoryId,
          inviteeGithubUsername: "duplicate-account",
          role: "viewer",
        }),
    ).rejects.toThrow();
    expect(await getInvitationWrites(t)).toEqual({
      invitations: [],
      notifications: [],
    });
  });

  it("does not fetch GitHub when repository preflight access is denied", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        isActive: false,
        githubAccessRevokedAt: Date.now(),
      });
    });

    await expect(
      t
        .withIdentity({ subject: `${ownerUserId}|owner-session` })
        .action(api.invitations.action.create, {
          repositoryId,
          inviteeGithubUsername: "canonical-user",
          role: "viewer",
        }),
    ).rejects.toThrow("Repository is no longer available");
    expect(mockedGetInstallationToken).not.toHaveBeenCalled();
    expect(mockedFetchGitHubAppJson).not.toHaveBeenCalled();
    expect(await getInvitationWrites(t)).toEqual({
      invitations: [],
      notifications: [],
    });
  });

  it("allows invitations while repository automation is manually paused", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
    const inviteeUserId = await insertGitHubUser(t, 708);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { isActive: false });
    });
    mockedFetchGitHubAppJson.mockResolvedValue({
      id: 708,
      login: "paused-repository-invitee",
      type: "User",
    });

    const invitationId = await t
      .withIdentity({ subject: `${ownerUserId}|owner-session` })
      .action(api.invitations.action.create, {
        repositoryId,
        inviteeGithubUsername: "paused-repository-invitee",
        role: "viewer",
      });

    expect((await getInvitationWrites(t)).invitations).toEqual([
      expect.objectContaining({
        _id: invitationId,
        inviteeUserId,
        status: "pending",
      }),
    ]);
  });

  it.each(["credentials", "api"] as const)(
    "fails without writes on GitHub %s failure",
    async (failure) => {
      const t = convexTest(schema, modules);
      const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
      if (failure === "credentials") {
        delete process.env.GITHUB_APP_ID;
      } else {
        mockedFetchGitHubAppJson.mockRejectedValue(new Error("network"));
      }

      await expect(
        t
          .withIdentity({ subject: `${ownerUserId}|owner-session` })
          .action(api.invitations.action.create, {
            repositoryId,
            inviteeGithubUsername: "canonical-user",
            role: "viewer",
          }),
      ).rejects.toThrow();
      expect(await getInvitationWrites(t)).toEqual({
        invitations: [],
        notifications: [],
      });
    },
  );

  it("re-attests repository state before the final write", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
    await insertGitHubUser(t, 705);
    await t.query(internal.invitations.internalQuery.getCreationContext, {
      inviterUserId: ownerUserId,
      repositoryId,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        isActive: false,
        githubAccessRevokedAt: Date.now(),
      });
    });

    await expect(
      t.mutation(internal.invitations.internalMutation.create, {
        inviterUserId: ownerUserId,
        repositoryId,
        expectedInstallationId: 812,
        githubAccountId: 705,
        canonicalGithubLogin: "race-user",
        role: "viewer",
      }),
    ).rejects.toThrow("Repository is no longer available");
    expect(await getInvitationWrites(t)).toEqual({
      invitations: [],
      notifications: [],
    });
  });

  it("detects an existing pending invitation by immutable account ID", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
    const inviteeUserId = await insertGitHubUser(t, 706, ["mutable-name"]);
    mockedFetchGitHubAppJson.mockResolvedValue({
      id: 706,
      login: "canonical-name",
      type: "User",
    });
    const owner = t.withIdentity({ subject: `${ownerUserId}|owner-session` });
    await owner.action(api.invitations.action.create, {
      repositoryId,
      inviteeGithubUsername: "canonical-name",
      role: "viewer",
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", inviteeUserId))
        .first();
      if (profile) {
        await ctx.db.patch(profile._id, { githubUsername: "spoofed-name" });
      }
    });

    await expect(
      owner.action(api.invitations.action.create, {
        repositoryId,
        inviteeGithubUsername: "renamed-canonical-name",
        role: "viewer",
      }),
    ).rejects.toThrow("already pending");
    const writes = await getInvitationWrites(t);
    expect(writes.invitations).toHaveLength(1);
    expect(writes.notifications).toHaveLength(1);
  });

  it("accepts without a mutable profile and preserves the verified login", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertOwnerFixture(t);
    const inviteeUserId = await insertGitHubUser(t, 707);
    mockedFetchGitHubAppJson.mockResolvedValue({
      id: 707,
      login: "verified-member",
      type: "User",
    });
    const invitationId = await t
      .withIdentity({ subject: `${ownerUserId}|owner-session` })
      .action(api.invitations.action.create, {
        repositoryId,
        inviteeGithubUsername: "verified-member",
        role: "viewer",
      });

    await expect(
      t
        .withIdentity({ subject: `${inviteeUserId}|invitee-session` })
        .mutation(api.invitations.mutation.accept, { invitationId }),
    ).resolves.toBe(invitationId);
    const member = await t.run(async (ctx) =>
      ctx.db
        .query("repositoryMembers")
        .withIndex("by_repository_and_user", (q) =>
          q.eq("repositoryId", repositoryId).eq("userId", inviteeUserId),
        )
        .unique(),
    );
    expect(member?.githubUsername).toBe("verified-member");
  });
});
