import { internalMutation } from "../../convex/_generated/server";
import { v } from "convex/values";
import {
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from "../../convex/users/legal";
import { hasOpenUsageReservation } from "../../convex/_ai/chatBilling";
function guard() {
  if (
    process.env.CONVEX_SITE_URL !==
    "https://fortunate-chihuahua-679.convex.site"
  )
    throw new Error("Development E2E only");
}
export const seed = internalMutation({
  args: {
    runId: v.string(),
    installationId: v.number(),
    ownerId: v.string(),
    ownerLogin: v.string(),
  },
  handler: async (ctx, args) => {
    guard();
    if (!/^[a-f0-9-]{36}$/.test(args.runId))
      throw new Error("Invalid test run");
    if (
      await ctx.db
        .query("githubInstallations")
        .withIndex("by_installation_id", (q) =>
          q.eq("installationId", args.installationId),
        )
        .first()
    )
      throw new Error(
        "Existing installation data must be preserved; use an empty development deployment",
      );
    const now = Date.now();
    const userId = await ctx.db.insert("users", { name: "Gitdog E2E fixture" });
    await ctx.db.insert("userProfiles", {
      userId,
      githubUsername: `gitdog-e2e-${args.runId}`,
      minimumAgeAttestedAt: now,
      professionalUseAttestedAt: now,
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedVersion: CURRENT_PRIVACY_POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: args.installationId,
      ownerGithubAccountId: args.ownerId,
      ownershipVerifiedAt: now,
      accountLogin: args.ownerLogin,
      accountType: "User",
      targetType: "User",
      createdAt: now,
      updatedAt: now,
    });
    return { userId };
  },
});
export const cleanup = internalMutation({
  args: {
    runId: v.string(),
    userId: v.id("users"),
    blobIds: v.array(v.id("repoFileBlobs")),
  },
  handler: async (ctx, args) => {
    guard();
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (profile?.githubUsername !== `gitdog-e2e-${args.runId}`)
      throw new Error("Fixture ownership mismatch");
    if (
      await ctx.db
        .query("repositories")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .first()
    )
      throw new Error("Disconnect fixture repositories first");
    if (await hasOpenUsageReservation(ctx, args.userId))
      throw new Error(
        "Unresolved provider usage must remain available for reconciliation",
      );
    let removed = 0;
    const usage = await ctx.db
      .query("tokenUsage")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(501);
    if (usage.length > 500) throw new Error("Fixture cleanup limit exceeded");
    for (const row of usage) {
      await ctx.db.delete(row._id);
      removed++;
    }
    for (const table of [
      "embeddingUsageReservations",
      "chatUsageReservations",
    ] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_user_and_status", (q) => q.eq("userId", args.userId))
        .take(501);
      if (rows.length > 500) throw new Error("Fixture cleanup limit exceeded");
      for (const row of rows) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    for (const row of await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(10)) {
      await ctx.db.delete(row._id);
      removed++;
    }
    for (const row of await ctx.db
      .query("githubInstallations")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(10)) {
      await ctx.db.delete(row._id);
      removed++;
    }
    if (args.blobIds.length > 100)
      throw new Error("Fixture blob cleanup limit exceeded");
    for (const id of args.blobIds) {
      const blob = await ctx.db.get(id);
      if (
        blob &&
        !(await ctx.db
          .query("repoFileMap")
          .withIndex("by_sha256", (q) => q.eq("sha256", blob.sha256))
          .first())
      ) {
        await ctx.storage.delete(blob.storageId);
        await ctx.db.delete(id);
        removed++;
      }
    }
    await ctx.db.delete(profile._id);
    await ctx.db.delete(args.userId);
    return { removed };
  },
});
