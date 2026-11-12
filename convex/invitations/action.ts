import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import {
  fetchGitHubAppJsonWithRetry,
  getInstallationToken,
} from "../github/helpers";

const GITHUB_LOGIN_MAX_LENGTH = 39;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

function normalizeGitHubLogin(login: string): string {
  const normalized = login.trim();
  if (
    normalized.length === 0 ||
    normalized.length > GITHUB_LOGIN_MAX_LENGTH ||
    !GITHUB_LOGIN_PATTERN.test(normalized)
  ) {
    throw new Error("Invalid GitHub username");
  }
  return normalized;
}

function parseGitHubUser(value: unknown): {
  githubAccountId: number;
  canonicalGithubLogin: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub user lookup returned invalid data");
  }
  const user = value as Record<string, unknown>;
  if (
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    typeof user.login !== "string" ||
    user.type !== "User"
  ) {
    throw new Error("GitHub user lookup returned invalid data");
  }
  return {
    githubAccountId: user.id,
    canonicalGithubLogin: normalizeGitHubLogin(user.login),
  };
}

async function createVerifiedInvitation(
  ctx: ActionCtx,
  args: {
    inviterUserId: Id<"users">;
    repositoryId: Id<"repositories">;
    inviteeGithubUsername: string;
  },
): Promise<Id<"invitations">> {
  const requestedGithubLogin = normalizeGitHubLogin(args.inviteeGithubUsername);
  const creationContext = await ctx.runQuery(
    internal.invitations.internalQuery.getCreationContext,
    {
      inviterUserId: args.inviterUserId,
      repositoryId: args.repositoryId,
    },
  );

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials not configured");
  }

  let verifiedUser: {
    githubAccountId: number;
    canonicalGithubLogin: string;
  };
  try {
    const installationToken = await getInstallationToken(
      creationContext.installationId,
      appId,
      privateKey,
    );
    const response = await fetchGitHubAppJsonWithRetry<unknown>(
      `https://api.github.com/users/${encodeURIComponent(requestedGithubLogin)}`,
      installationToken,
      "GitHub invitation account lookup",
      { maxAttempts: 2, timeoutMs: 15_000 },
    );
    verifiedUser = parseGitHubUser(response);
  } catch {
    throw new Error("Unable to verify the GitHub user");
  }

  return await ctx.runMutation(internal.invitations.internalMutation.create, {
    inviterUserId: args.inviterUserId,
    repositoryId: args.repositoryId,
    expectedInstallationId: creationContext.installationId,
    githubAccountId: verifiedUser.githubAccountId,
    canonicalGithubLogin: verifiedUser.canonicalGithubLogin,
    role: "viewer",
  });
}

/** Resolve a mutable login to a live immutable GitHub account before inviting. */
export const create = action({
  args: {
    repositoryId: v.id("repositories"),
    inviteeGithubUsername: v.string(),
    role: v.literal("viewer"),
  },
  handler: async (ctx, args): Promise<Id<"invitations">> => {
    const inviterUserId = await getAuthUserId(ctx);
    if (!inviterUserId) {
      throw new Error("Not authenticated");
    }

    return await createVerifiedInvitation(ctx, {
      inviterUserId,
      repositoryId: args.repositoryId,
      inviteeGithubUsername: args.inviteeGithubUsername,
    });
  },
});
