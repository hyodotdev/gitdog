import { query } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { apiError, ownedRepository, publicKey } from "./security";

export const list = query({
  args: {
    repositoryId: v.id("repositories"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await ownedRepository(ctx, await getAuthUserId(ctx), args.repositoryId);
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 100
    )
      apiError("BAD_REQUEST", "Page size must be between 1 and 100.");
    const page = await ctx.db
      .query("projectApiKeys")
      .withIndex("by_repository", (q) =>
        q.eq("repositoryId", args.repositoryId),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      items: page.page.map(publicKey),
      nextCursor: page.isDone ? null : page.continueCursor,
      hasMore: !page.isDone,
    };
  },
});
