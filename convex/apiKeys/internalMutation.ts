import { internalMutation } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  apiError,
  ownedRepository,
  requireConnectedRepository,
} from "./security";

export const create = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    name: v.string(),
    tokenHash: v.string(),
    prefix: v.string(),
    scopes: v.array(v.union(v.literal("read"), v.literal("write"))),
    expiresInDays: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const repository = await ownedRepository(ctx, userId, args.repositoryId);
    await requireConnectedRepository(ctx, repository);
    const name = args.name.trim();
    if (
      name.length < 1 ||
      name.length > 80 ||
      Array.from(name).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      apiError(
        "BAD_REQUEST",
        "Key name must contain 1–80 printable characters.",
      );
    if (
      !Number.isInteger(args.expiresInDays) ||
      args.expiresInDays < 1 ||
      args.expiresInDays > 365
    )
      apiError("BAD_REQUEST", "Expiry must be between 1 and 365 days.");
    const scopes = [...new Set(args.scopes)];
    if (!scopes.includes("read") || scopes.length > 2)
      apiError("BAD_REQUEST", "Keys require read scope; write is optional.");
    if (
      !/^[a-f0-9]{64}$/.test(args.tokenHash) ||
      !/^gdk_[a-f0-9]{8}$/.test(args.prefix)
    )
      apiError("BAD_REQUEST", "Invalid API key material.");
    const active = await ctx.db
      .query("projectApiKeys")
      .withIndex("by_repository_and_revoked", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("revokedAt", undefined),
      )
      .take(50);
    if (active.length >= 50)
      apiError(
        "BAD_REQUEST",
        "Revoke an existing key before creating another (maximum 50 unrevoked keys).",
      );
    const now = Date.now();
    const expiresAt = now + args.expiresInDays * 86_400_000;
    const keyId = await ctx.db.insert("projectApiKeys", {
      repositoryId: args.repositoryId,
      userId: userId!,
      name,
      tokenHash: args.tokenHash,
      prefix: args.prefix,
      scopes,
      createdAt: now,
      expiresAt,
    });
    return { keyId, prefix: args.prefix, expiresAt, scopes };
  },
});
