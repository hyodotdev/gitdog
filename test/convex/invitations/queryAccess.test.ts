import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/invitations/query.ts": () =>
    import("../../../convex/invitations/query"),
  "../../../convex/repositoryMembers/query.ts": () =>
    import("../../../convex/repositoryMembers/query"),
};

describe("repository invitation query access", () => {
  it("keeps pending invitee data owner-only", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", {});
      const viewerId = await ctx.db.insert("users", {});
      const inviteeId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("subscriptions", {
        userId: ownerId,
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
      const repositoryId = await ctx.db.insert("repositories", {
        indexSyncPending: false,
        userId: ownerId,
        installationId: 123,
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
        settings: {
          issueAssistantEnabled: true,
          autoFormatIssue: true,
          autoAnswerQuestions: true,
          tagMaintainersForCodeChanges: true,
          requireApproval: true,
          discussionAssistantEnabled: true,
          autoFormatDiscussion: true,
          autoAnswerDiscussionQuestions: true,
          tagMaintainersForDiscussionCodeChanges: true,
          requireApprovalForDiscussions: true,
        },
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const viewerInvitationId = await ctx.db.insert("invitations", {
        repositoryId,
        invitedByUserId: ownerId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "viewer",
        inviteeUserId: viewerId,
        role: "viewer",
        status: "accepted",
        createdAt: now,
        respondedAt: now,
      });
      await ctx.db.insert("repositoryMembers", {
        repositoryId,
        userId: viewerId,
        githubUsername: "viewer",
        role: "viewer",
        joinedVia: "invitation",
        invitationId: viewerInvitationId,
        joinedAt: now,
      });
      await ctx.db.insert("invitations", {
        repositoryId,
        invitedByUserId: ownerId,
        invitedByUsername: "owner",
        inviteeGithubUsername: "invitee",
        inviteeUserId: inviteeId,
        role: "viewer",
        status: "pending",
        createdAt: now,
      });
      return { ownerId, repositoryId, viewerId };
    });

    const viewerResult = await t
      .withIdentity({ subject: `${fixture.viewerId}|test-session` })
      .query(api.invitations.query.getPendingForRepository, {
        repositoryId: fixture.repositoryId,
      });
    expect(viewerResult).toEqual([]);
    const viewerRole = await t
      .withIdentity({ subject: `${fixture.viewerId}|test-session` })
      .query(api.repositoryMembers.query.getMyRole, {
        repositoryId: fixture.repositoryId,
      });
    expect(viewerRole).toEqual({
      role: "viewer",
      isOwner: false,
      canEdit: false,
      canManageMembers: false,
    });

    const ownerResult = await t
      .withIdentity({ subject: `${fixture.ownerId}|test-session` })
      .query(api.invitations.query.getPendingForRepository, {
        repositoryId: fixture.repositoryId,
      });
    expect(ownerResult).toEqual([
      expect.objectContaining({
        inviteeGithubUsername: "invitee",
        role: "viewer",
      }),
    ]);
  });
});
