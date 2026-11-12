import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  getExactGitHubInstallation,
  isGitHubInstallationReady,
} from "../github/installationAccess";

export type ApiScope = "read" | "write";
export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "UNSUPPORTED_OPERATION";
export function apiError(code: ApiErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

export async function hashApiKey(key: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export function publicKey(key: Doc<"projectApiKeys">) {
  const { tokenHash, userId, ...metadata } = key;
  void tokenHash;
  void userId;
  return metadata;
}

export async function ownedRepository(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users"> | null,
  repositoryId: Id<"repositories">,
) {
  if (!userId) apiError("UNAUTHORIZED", "Sign in to manage project API keys.");
  const repository = await ctx.db.get(repositoryId);
  if (!repository || repository.userId !== userId)
    apiError("FORBIDDEN", "Only the project owner can manage API keys.");
  return repository;
}

export async function requireConnectedRepository(
  ctx: Pick<QueryCtx, "db">,
  repository: Doc<"repositories">,
) {
  if (
    repository.disconnectCleanupPending ||
    repository.githubAccessRevokedAt !== undefined ||
    repository.githubInstallationReconnectRequired
  ) {
    apiError("UNAUTHORIZED", "The project is not connected.");
  }
  const installation = await getExactGitHubInstallation(
    ctx,
    repository.installationId,
  );
  if (
    !isGitHubInstallationReady(installation) ||
    installation.userId !== repository.userId
  ) {
    apiError("UNAUTHORIZED", "The project installation is unavailable.");
  }
}

export async function authorizeKey(
  ctx: MutationCtx,
  tokenHash: string,
  scope: ApiScope,
) {
  const key = await ctx.db
    .query("projectApiKeys")
    .withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!key || key.revokedAt !== undefined || key.expiresAt <= Date.now())
    apiError("UNAUTHORIZED", "Invalid, expired or revoked API key.");
  const repository = await ctx.db.get(key.repositoryId);
  if (
    !repository ||
    repository.userId !== key.userId ||
    !(await ctx.db.get(key.userId))
  )
    apiError("UNAUTHORIZED", "Invalid, expired or revoked API key.");
  await requireConnectedRepository(ctx, repository);
  if (!key.scopes.includes(scope))
    apiError("FORBIDDEN", "This API key does not grant the required scope.");
  if (key.lastUsedAt === undefined || key.lastUsedAt < Date.now() - 60_000)
    await ctx.db.patch(key._id, { lastUsedAt: Date.now() });
  return { key, repository };
}
