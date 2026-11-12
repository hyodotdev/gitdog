import { internalQuery } from "../../convex/_generated/server";
import { v } from "convex/values";
export const findFixture = internalQuery({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    if (
      process.env.CONVEX_SITE_URL !==
      "https://fortunate-chihuahua-679.convex.site"
    )
      throw new Error("Development E2E only");
    return (
      (
        await ctx.db
          .query("userProfiles")
          .withIndex("by_github", (q) =>
            q.eq("githubUsername", `gitdog-e2e-${args.runId}`),
          )
          .unique()
      )?.userId ?? null
    );
  },
});
export const progress = internalQuery({
  args: {
    runId: v.string(),
    userId: v.id("users"),
    repositoryId: v.optional(v.id("repositories")),
  },
  handler: async (ctx, args) => {
    if (
      process.env.CONVEX_SITE_URL !==
      "https://fortunate-chihuahua-679.convex.site"
    )
      throw new Error("Development E2E only");
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (profile?.githubUsername !== `gitdog-e2e-${args.runId}`)
      throw new Error("Fixture ownership mismatch");
    const repositories = await ctx.db
      .query("repositories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(5);
    const repo =
      repositories.find((r) => r._id === args.repositoryId) ?? repositories[0];
    const usage = await ctx.db
      .query("tokenUsage")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(500);
    const chunks = repo
      ? await ctx.db
          .query("repoChunks")
          .withIndex("by_index_version", (q) =>
            q
              .eq("repositoryId", repo._id)
              .eq("indexVersion", repo.indexVersion),
          )
          .take(500)
      : [];
    const blobs = [];
    if (repo) {
      const files = await ctx.db
        .query("repoFileMap")
        .withIndex("by_repository", (q) => q.eq("repositoryId", repo._id))
        .take(101);
      if (files.length > 100)
        throw new Error("E2E repository exceeds the 100-file fixture limit");
      for (const file of files) {
        const blob = await ctx.db
          .query("repoFileBlobs")
          .withIndex("by_sha256", (q) => q.eq("sha256", file.sha256))
          .unique();
        if (blob) blobs.push(blob._id);
      }
    }
    const foreignActive = (
      await ctx.db
        .query("repositories")
        .withIndex("by_active", (q) => q.eq("isActive", true))
        .take(20)
    ).some((r) => r.userId !== args.userId);
    return {
      repositoryId: repo?._id ?? null,
      indexStatus: repo?.indexStatus ?? null,
      ragStatus: repo?.ragStatus ?? null,
      indexVersion: repo?.indexVersion ?? null,
      mode: repo?.ragEmbeddingMode ?? null,
      error: repo?.ragEmbeddingError ?? null,
      chunks: chunks.length,
      vectors: chunks.filter((c) => c.embeddingKey?.startsWith("openai:"))
        .length,
      embeddingUsageRows: usage.filter((u) => u.usageType === "embedding")
        .length,
      usageProviders: [...new Set(usage.map((u) => u.provider))],
      blobIds: [...new Set(blobs)],
      foreignActive,
    };
  },
});
export const verifyCleanup = internalQuery({
  args: {
    userId: v.id("users"),
    repositoryId: v.optional(v.id("repositories")),
    blobIds: v.array(v.id("repoFileBlobs")),
  },
  handler: async (ctx, args) => {
    if (
      process.env.CONVEX_SITE_URL !==
      "https://fortunate-chihuahua-679.convex.site"
    )
      throw new Error("Development E2E only");
    return {
      userExists: !!(await ctx.db.get(args.userId)),
      profileExists: !!(await ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .first()),
      repositoryExists: !!(await ctx.db
        .query("repositories")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .first()),
      usageExists: !!(await ctx.db
        .query("tokenUsage")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .first()),
      installationExists: !!(await ctx.db
        .query("githubInstallations")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .first()),
      subscriptionExists: !!(await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .first()),
      chatReservationExists: !!(await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_user_and_status", (q) => q.eq("userId", args.userId))
        .first()),
      embeddingReservationExists: !!(await ctx.db
        .query("embeddingUsageReservations")
        .withIndex("by_user_and_status", (q) => q.eq("userId", args.userId))
        .first()),
      chunksExist: args.repositoryId
        ? !!(await ctx.db
            .query("repoChunks")
            .withIndex("by_repository", (q) =>
              q.eq("repositoryId", args.repositoryId!),
            )
            .first())
        : false,
      fileMapsExist: args.repositoryId
        ? !!(await ctx.db
            .query("repoFileMap")
            .withIndex("by_repository", (q) =>
              q.eq("repositoryId", args.repositoryId!),
            )
            .first())
        : false,
      embeddingCacheExists: args.repositoryId
        ? !!(await ctx.db
            .query("ragEmbeddingBatches")
            .withIndex("by_repository", (q) =>
              q.eq("repositoryId", args.repositoryId!),
            )
            .first())
        : false,
      unsharedBlobsExist: (
        await Promise.all(
          args.blobIds.map(async (id) => {
            const blob = await ctx.db.get(id);
            return (
              !!blob &&
              !(await ctx.db
                .query("repoFileMap")
                .withIndex("by_sha256", (q) => q.eq("sha256", blob.sha256))
                .first())
            );
          }),
        )
      ).some(Boolean),
    };
  },
});
