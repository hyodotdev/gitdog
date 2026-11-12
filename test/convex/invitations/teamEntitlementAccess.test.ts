import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { MutationCtx } from "../../../convex/_generated/server";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/invitations/mutation.ts": () =>
    import("../../../convex/invitations/mutation"),
  "../../../convex/repositories/query.ts": () =>
    import("../../../convex/repositories/query"),
  "../../../convex/repositoryMembers/query.ts": () =>
    import("../../../convex/repositoryMembers/query"),
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

type EntitlementKind =
  | "none"
  | "free"
  | "active"
  | "canceled_current"
  | "active_expired"
  | "canceled_expired"
  | "expired"
  | "forged";

async function insertEntitlement(
  ctx: MutationCtx,
  ownerUserId: Id<"users">,
  kind: EntitlementKind,
  now: number,
) {
  if (kind === "none") {
    return null;
  }
  const isFree = kind === "free";
  const hasTrustedProvenance = !isFree && kind !== "forged";
  const status =
    kind === "expired"
      ? ("expired" as const)
      : kind.startsWith("canceled")
        ? ("canceled" as const)
        : ("active" as const);
  const periodEnd = kind.endsWith("expired") ? now - 1 : now + 60_000;
  return await ctx.db.insert("subscriptions", {
    userId: ownerUserId,
    lemonSqueezySubscriptionId: `subscription-${kind}`,
    lemonSqueezyCustomerId: `customer-${kind}`,
    lemonSqueezyVariantId: `variant-${kind}`,
    ...(hasTrustedProvenance
      ? {
          proEntitlementProvenance: {
            source: "lemon_squeezy_webhook" as const,
            verifiedAt: now - 1_000,
          },
        }
      : {}),
    plan: isFree ? ("free" as const) : ("pro" as const),
    status,
    includedTokens: isFree ? 100_000 : 2_400_000,
    purchasedTokens: 0,
    serviceFeeRate: isFree ? 0.25 : 0.18,
    periodStart: now - 30_000,
    periodEnd,
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
  });
}

async function insertFixture(
  t: ReturnType<typeof convexTest>,
  kind: EntitlementKind,
  options: { deleteOwner?: boolean; deleteRepository?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerUserId = await ctx.db.insert("users", { name: "Owner" });
    const memberUserId = await ctx.db.insert("users", { name: "Member" });
    const subscriptionId = await insertEntitlement(ctx, ownerUserId, kind, now);
    const repositoryId = await ctx.db.insert("repositories", {
      indexSyncPending: false,
      userId: ownerUserId,
      installationId: 812,
      githubRepositoryId: 456,
      githubRepo: "owner/team-repo",
      githubRepoKey: "owner/team-repo",
      name: "team-repo",
      githubUrl: "https://github.com/owner/team-repo",
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
    const invitationId = await ctx.db.insert("invitations", {
      repositoryId,
      invitedByUserId: ownerUserId,
      invitedByUsername: "owner",
      inviteeGithubUsername: "member",
      inviteeUserId: memberUserId,
      role: "viewer",
      status: "pending",
      createdAt: now,
    });
    if (options.deleteOwner) {
      await ctx.db.delete(ownerUserId);
    }
    if (options.deleteRepository) {
      await ctx.db.delete(repositoryId);
    }
    return {
      invitationId,
      memberUserId,
      ownerUserId,
      repositoryId,
      subscriptionId,
    };
  });
}

async function expectDeniedWithoutSideEffects(
  t: ReturnType<typeof convexTest>,
  fixture: Awaited<ReturnType<typeof insertFixture>>,
) {
  await expect(
    t
      .withIdentity({ subject: `${fixture.memberUserId}|member-session` })
      .mutation(api.invitations.mutation.accept, {
        invitationId: fixture.invitationId,
      }),
  ).rejects.toThrow();

  const state = await t.run(async (ctx) => ({
    invitation: await ctx.db.get(fixture.invitationId),
    members: await ctx.db
      .query("repositoryMembers")
      .withIndex("by_repository", (q) =>
        q.eq("repositoryId", fixture.repositoryId),
      )
      .take(2),
    acceptedNotifications: (
      await ctx.db
        .query("notifications")
        .withIndex("by_repository", (q) =>
          q.eq("repositoryId", fixture.repositoryId),
        )
        .take(2)
    ).filter((notification) => notification.type === "invitation_accepted"),
  }));
  expect(state.invitation).toMatchObject({ status: "pending" });
  expect(state.invitation?.respondedAt).toBeUndefined();
  expect(state.members).toEqual([]);
  expect(state.acceptedNotifications).toEqual([]);
}

describe("repository owner team entitlement", () => {
  it.each(["active", "canceled_current"] as const)(
    "accepts an invitation with a trusted %s Pro entitlement",
    async (kind) => {
      const t = convexTest(schema, modules);
      const fixture = await insertFixture(t, kind);

      await expect(
        t
          .withIdentity({ subject: `${fixture.memberUserId}|member-session` })
          .mutation(api.invitations.mutation.accept, {
            invitationId: fixture.invitationId,
          }),
      ).resolves.toBe(fixture.invitationId);

      await expect(
        t.run(async (ctx) =>
          ctx.db
            .query("repositoryMembers")
            .withIndex("by_repository_and_user", (q) =>
              q
                .eq("repositoryId", fixture.repositoryId)
                .eq("userId", fixture.memberUserId),
            )
            .unique(),
        ),
      ).resolves.toMatchObject({ role: "viewer" });
    },
  );

  it.each([
    "none",
    "free",
    "active_expired",
    "canceled_expired",
    "expired",
    "forged",
  ] as const)(
    "rejects acceptance without a trusted live Pro entitlement: %s",
    async (kind) => {
      const t = convexTest(schema, modules);
      await expectDeniedWithoutSideEffects(t, await insertFixture(t, kind));
    },
  );

  it.each([
    ["missing owner", { deleteOwner: true }],
    ["missing repository", { deleteRepository: true }],
  ] as const)("rejects acceptance for a %s", async (_label, options) => {
    const t = convexTest(schema, modules);
    await expectDeniedWithoutSideEffects(
      t,
      await insertFixture(t, "active", options),
    );
  });

  it("revokes every member view after downgrade without affecting owner access", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t, "active");
    await t.run(async (ctx) => {
      await ctx.db.insert("repositoryMembers", {
        repositoryId: fixture.repositoryId,
        userId: fixture.memberUserId,
        githubUsername: "member",
        role: "viewer",
        joinedVia: "invitation",
        invitationId: fixture.invitationId,
        joinedAt: Date.now(),
      });
    });
    const member = t.withIdentity({
      subject: `${fixture.memberUserId}|member-session`,
    });
    const owner = t.withIdentity({
      subject: `${fixture.ownerUserId}|owner-session`,
    });

    await expect(
      member.query(api.repositoryMembers.query.getMyRole, {
        repositoryId: fixture.repositoryId,
      }),
    ).resolves.toMatchObject({ role: "viewer", isOwner: false });
    await expect(
      member.query(api.repositories.query.list, {}),
    ).resolves.toEqual([
      expect.objectContaining({
        _id: fixture.repositoryId,
        userRole: "viewer",
      }),
    ]);

    if (!fixture.subscriptionId) {
      throw new Error("expected subscription fixture");
    }
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.subscriptionId!, { status: "expired" });
      await ctx.db.insert("subscriptions", {
        userId: fixture.ownerUserId,
        lemonSqueezySubscriptionId: "newer-forged-subscription",
        plan: "pro",
        status: "active",
        includedTokens: 2_400_000,
        purchasedTokens: 0,
        serviceFeeRate: 0.18,
        periodStart: Date.now() - 1_000,
        periodEnd: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await expect(
      member.query(api.repositoryMembers.query.getMyRole, {
        repositoryId: fixture.repositoryId,
      }),
    ).resolves.toBeNull();
    await expect(
      member.query(api.repositoryMembers.query.list, {
        repositoryId: fixture.repositoryId,
      }),
    ).resolves.toEqual([]);
    await expect(
      member.query(api.repositories.query.list, {}),
    ).resolves.toEqual([]);
    await expect(
      member.query(api.repositories.query.get, {
        owner: "owner",
        repo: "team-repo",
      }),
    ).resolves.toBeNull();
    await expect(
      member.query(api.repositories.query.getById, {
        repositoryId: fixture.repositoryId,
      }),
    ).rejects.toThrow("unauthorized");

    await expect(
      owner.query(api.repositoryMembers.query.getMyRole, {
        repositoryId: fixture.repositoryId,
      }),
    ).resolves.toMatchObject({ role: "owner", isOwner: true });
    await expect(
      owner.query(api.repositoryMembers.query.list, {
        repositoryId: fixture.repositoryId,
      }),
    ).resolves.toHaveLength(2);
    await expect(owner.query(api.repositories.query.list, {})).resolves.toEqual(
      [
        expect.objectContaining({
          _id: fixture.repositoryId,
          userRole: "owner",
        }),
      ],
    );
    await expect(
      owner.query(api.repositories.query.getById, {
        repositoryId: fixture.repositoryId,
      }),
    ).resolves.toMatchObject({
      _id: fixture.repositoryId,
      userRole: "owner",
    });
  });

  it("keeps member access during a canceled subscription's paid period", async () => {
    const t = convexTest(schema, modules);
    const fixture = await insertFixture(t, "canceled_current");
    await t.run(async (ctx) => {
      await ctx.db.insert("repositoryMembers", {
        repositoryId: fixture.repositoryId,
        userId: fixture.memberUserId,
        githubUsername: "member",
        role: "viewer",
        joinedVia: "invitation",
        invitationId: fixture.invitationId,
        joinedAt: Date.now(),
      });
    });

    const member = t.withIdentity({
      subject: `${fixture.memberUserId}|member-session`,
    });
    await expect(
      member.query(api.repositoryMembers.query.getMyRole, {
        repositoryId: fixture.repositoryId,
      }),
    ).resolves.toMatchObject({ role: "viewer" });
    await expect(
      member.query(api.repositories.query.list, {}),
    ).resolves.toEqual([
      expect.objectContaining({ _id: fixture.repositoryId }),
    ]);
  });
});
