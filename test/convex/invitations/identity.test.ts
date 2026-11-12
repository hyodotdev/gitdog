import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/invitations/mutation.ts": () =>
    import("../../../convex/invitations/mutation"),
  "../../../convex/invitations/internalMutation.ts": () =>
    import("../../../convex/invitations/internalMutation"),
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

type UnreadyInstallationState = Partial<
  Pick<
    Doc<"githubInstallations">,
    | "accessSuspendedAt"
    | "repositoryAccessRemovalPhase"
    | "repositoryRemovalPendingAt"
    | "repositoryAccessReconciliationPhase"
  >
>;

async function insertRepositoryFixture(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("subscriptions", {
      userId: ownerUserId,
      lemonSqueezySubscriptionId: "owner-live-pro",
      proEntitlementProvenance: {
        source: "lemon_squeezy_webhook",
        verifiedAt: now,
      },
      plan: "pro",
      status: "active",
      includedTokens: 2_400_000,
      purchasedTokens: 0,
      serviceFeeRate: 0.18,
      periodStart: now,
      periodEnd: now + 60_000,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("userProfiles", {
      userId: ownerUserId,
      githubUsername: "owner",
      createdAt: now,
      updatedAt: now,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      userId: ownerUserId,
      installationId: 812,
      githubRepositoryId: 456,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: now,
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      settings,
      monthlyActions: 0,
      lastResetAt: now,
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
    return { ownerUserId, repositoryId };
  });
}

async function insertProfile(
  t: ReturnType<typeof convexTest>,
  githubUsername: string,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("userProfiles", {
      userId,
      githubUsername,
      createdAt: now,
      updatedAt: now,
    });
    return userId;
  });
}

describe("invitation identity authorization", () => {
  it("uses the immutable invitee ID when a GitHub username is renamed and reused", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertRepositoryFixture(t);
    const inviteeUserId = await insertProfile(t, "renamed-invitee");
    const attackerUserId = await insertProfile(t, "original-invitee");
    const invitationId = await t.run(async (ctx) =>
      ctx.db.insert("invitations", {
        repositoryId,
        invitedByUserId: ownerUserId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "original-invitee",
        inviteeUserId,
        role: "viewer",
        status: "pending",
        createdAt: Date.now(),
      }),
    );
    const invitee = t.withIdentity({
      subject: `${inviteeUserId}|test-session`,
    });
    const attacker = t.withIdentity({
      subject: `${attackerUserId}|test-session`,
    });

    await expect(
      invitee.query(api.invitations.query.listPending, {}),
    ).resolves.toEqual([
      expect.objectContaining({
        _id: invitationId,
        inviteeUserId,
        status: "pending",
      }),
    ]);
    await expect(
      attacker.query(api.invitations.query.listPending, {}),
    ).resolves.toEqual([]);
    await expect(
      attacker.mutation(api.invitations.mutation.accept, { invitationId }),
    ).rejects.toThrow("This invitation is not for you");
    await expect(
      attacker.mutation(api.invitations.mutation.reject, { invitationId }),
    ).rejects.toThrow("This invitation is not for you");

    const unchanged = await t.run(async (ctx) => {
      const notifications = await ctx.db
        .query("notifications")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect();
      return {
        invitation: await ctx.db.get(invitationId),
        members: await ctx.db
          .query("repositoryMembers")
          .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
          .collect(),
        terminalNotifications: notifications.filter(
          (notification) =>
            notification.type === "invitation_accepted" ||
            notification.type === "invitation_rejected",
        ),
      };
    });
    expect(unchanged.invitation).toMatchObject({ status: "pending" });
    expect(unchanged.invitation?.respondedAt).toBeUndefined();
    expect(unchanged.members).toEqual([]);
    expect(unchanged.terminalNotifications).toEqual([]);

    await expect(
      invitee.mutation(api.invitations.mutation.accept, { invitationId }),
    ).resolves.toBe(invitationId);
    const accepted = await t.run(async (ctx) => ({
      invitation: await ctx.db.get(invitationId),
      member: await ctx.db
        .query("repositoryMembers")
        .withIndex("by_repository_and_user", (q) =>
          q.eq("repositoryId", repositoryId).eq("userId", inviteeUserId),
        )
        .first(),
    }));
    expect(accepted.invitation).toMatchObject({ status: "accepted" });
    expect(accepted.member).toMatchObject({
      userId: inviteeUserId,
      githubUsername: "original-invitee",
    });
  });

  it("keeps a pending invitation visible and acceptable during a manual pause", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertRepositoryFixture(t);
    const inviteeUserId = await insertProfile(t, "paused-invitee");
    const invitationId = await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { isActive: false });
      return await ctx.db.insert("invitations", {
        repositoryId,
        invitedByUserId: ownerUserId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "paused-invitee",
        inviteeUserId,
        role: "viewer",
        status: "pending",
        createdAt: Date.now(),
      });
    });
    const invitee = t.withIdentity({
      subject: `${inviteeUserId}|test-session`,
    });

    await expect(
      invitee.query(api.invitations.query.listPending, {}),
    ).resolves.toEqual([
      expect.objectContaining({ _id: invitationId, status: "pending" }),
    ]);
    await expect(
      invitee.mutation(api.invitations.mutation.accept, { invitationId }),
    ).resolves.toBe(invitationId);
  });

  it("hides and rejects invitations while repository reconnect is required", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertRepositoryFixture(t);
    const inviteeUserId = await insertProfile(t, "reconnect-invitee");
    const invitationId = await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        githubInstallationReconnectRequired: true,
      });
      return await ctx.db.insert("invitations", {
        repositoryId,
        invitedByUserId: ownerUserId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "reconnect-invitee",
        inviteeUserId,
        role: "viewer",
        status: "pending",
        createdAt: Date.now(),
      });
    });
    const invitee = t.withIdentity({
      subject: `${inviteeUserId}|test-session`,
    });

    await expect(
      invitee.query(api.invitations.query.listPending, {}),
    ).resolves.toEqual([]);
    await expect(
      invitee.mutation(api.invitations.mutation.accept, { invitationId }),
    ).rejects.toThrow("Repository is no longer available");
  });

  it.each([
    [
      "reconciliation",
      { repositoryAccessReconciliationPhase: "fetching" as const },
    ],
    ["suspension", { accessSuspendedAt: 1 }],
    [
      "installation removal",
      { repositoryAccessRemovalPhase: "pausing" as const },
    ],
    ["repository removal", { repositoryRemovalPendingAt: 1 }],
  ] satisfies Array<[string, UnreadyInstallationState]>)(
    "hides and rejects invitations during installation %s",
    async (_label, installationState) => {
      const t = convexTest(schema, modules);
      const { ownerUserId, repositoryId } = await insertRepositoryFixture(t);
      const inviteeUserId = await insertProfile(t, "unready-invitee");
      const invitationId = await t.run(async (ctx) => {
        const installation = await ctx.db
          .query("githubInstallations")
          .withIndex("by_installation_id", (q) => q.eq("installationId", 812))
          .unique();
        if (!installation) {
          throw new Error("installation fixture missing");
        }
        await ctx.db.patch(installation._id, installationState);
        return await ctx.db.insert("invitations", {
          repositoryId,
          invitedByUserId: ownerUserId,
          invitedByUsername: "owner",
          inviteeGithubUsername: "unready-invitee",
          inviteeUserId,
          role: "viewer",
          status: "pending",
          createdAt: Date.now(),
        });
      });
      const invitee = t.withIdentity({
        subject: `${inviteeUserId}|test-session`,
      });

      await expect(
        invitee.query(api.invitations.query.listPending, {}),
      ).resolves.toEqual([]);
      await expect(
        invitee.mutation(api.invitations.mutation.accept, { invitationId }),
      ).rejects.toThrow("Repository is no longer available");
    },
  );

  it("detects a pending invitation by account ID after the invitee renames", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertRepositoryFixture(t);
    const inviteeUserId = await insertProfile(t, "new-invitee-name");
    await t.run(async (ctx) => {
      const now = Date.now();
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
        periodEnd: now + 30 * 24 * 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("invitations", {
        repositoryId,
        invitedByUserId: ownerUserId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "old-invitee-name",
        inviteeUserId,
        role: "viewer",
        status: "pending",
        createdAt: now,
      });
      await ctx.db.insert("authAccounts", {
        userId: inviteeUserId,
        provider: "github",
        providerAccountId: "777",
      });
    });

    await expect(
      t.mutation(internal.invitations.internalMutation.create, {
        inviterUserId: ownerUserId,
        repositoryId,
        expectedInstallationId: 812,
        githubAccountId: 777,
        canonicalGithubLogin: "new-invitee-name",
        role: "viewer",
      }),
    ).rejects.toThrow("An invitation is already pending for this user");

    const invitations = await t.run(async (ctx) =>
      ctx.db
        .query("invitations")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect(),
    );
    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toMatchObject({
      inviteeGithubUsername: "old-invitee-name",
      inviteeUserId,
      status: "pending",
    });
  });

  it("leaves the invitation pending when membership already exists", async () => {
    const t = convexTest(schema, modules);
    const { ownerUserId, repositoryId } = await insertRepositoryFixture(t);
    const inviteeUserId = await insertProfile(t, "invitee");
    const invitationId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("invitations", {
        repositoryId,
        invitedByUserId: ownerUserId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "invitee",
        inviteeUserId,
        role: "viewer",
        status: "pending",
        createdAt: now,
      });
      await ctx.db.insert("repositoryMembers", {
        repositoryId,
        userId: inviteeUserId,
        githubUsername: "invitee",
        role: "viewer",
        joinedVia: "invitation",
        invitationId: id,
        joinedAt: now,
      });
      return id;
    });
    const invitee = t.withIdentity({
      subject: `${inviteeUserId}|test-session`,
    });

    await expect(
      invitee.mutation(api.invitations.mutation.accept, { invitationId }),
    ).rejects.toThrow("User is already a member of this repository");

    const state = await t.run(async (ctx) => {
      const notifications = await ctx.db
        .query("notifications")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repositoryId))
        .collect();
      return {
        invitation: await ctx.db.get(invitationId),
        members: await ctx.db
          .query("repositoryMembers")
          .withIndex("by_repository_and_user", (q) =>
            q.eq("repositoryId", repositoryId).eq("userId", inviteeUserId),
          )
          .collect(),
        acceptedNotifications: notifications.filter(
          (notification) => notification.type === "invitation_accepted",
        ),
      };
    });
    expect(state.invitation).toMatchObject({ status: "pending" });
    expect(state.invitation?.respondedAt).toBeUndefined();
    expect(state.members).toHaveLength(1);
    expect(state.acceptedNotifications).toEqual([]);
  });
});
