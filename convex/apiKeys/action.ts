"use node";
import { randomBytes } from "node:crypto";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { apiError, hashApiKey } from "./security";

export const create = action({
  args: {
    repositoryId: v.id("repositories"),
    name: v.string(),
    scopes: v.array(v.union(v.literal("read"), v.literal("write"))),
    expiresInDays: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    keyId: Id<"projectApiKeys">;
    key: string;
    prefix: string;
    expiresAt: number;
    scopes: Array<"read" | "write">;
  }> => {
    if (!(await getAuthUserId(ctx)))
      apiError("UNAUTHORIZED", "Sign in to create an API key.");
    const key = `gdk_${randomBytes(32).toString("hex")}`;
    const result = await ctx.runMutation(
      internal.apiKeys.internalMutation.create,
      { ...args, tokenHash: await hashApiKey(key), prefix: key.slice(0, 12) },
    );
    return { ...result, key };
  },
});
