import { action, type ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  fetchGitHubAppJsonWithRetry,
  getRepositoryInstallationToken,
} from "../github/helpers";
import { parseCanonicalGitHubRepositoryFullName } from "../github/repositoryIdentity";
import { isGitHubInstallationReady } from "../github/installationAccess";

type VerifiedGitHubRepository = {
  githubRepositoryId: number;
  githubRepo: string;
  name: string;
  description?: string;
  githubUrl: string;
  language?: string;
  stars: number;
};

async function fetchVerifiedGitHubRepositoryById(
  installationId: number,
  expectedGithubRepositoryId: number,
  appId: string,
  privateKey: string,
): Promise<VerifiedGitHubRepository> {
  if (
    !Number.isSafeInteger(expectedGithubRepositoryId) ||
    expectedGithubRepositoryId <= 0
  ) {
    throw new Error("Invalid GitHub repository ID");
  }

  const token = await getRepositoryInstallationToken(
    installationId,
    expectedGithubRepositoryId,
    appId,
    privateKey,
  );
  const metadata = await fetchGitHubAppJsonWithRetry<{
    id?: unknown;
    full_name?: unknown;
    description?: unknown;
    language?: unknown;
    stargazers_count?: unknown;
  }>(
    `https://api.github.com/repositories/${expectedGithubRepositoryId}`,
    token,
    "GitHub repository identity lookup",
  );

  if (
    metadata.id !== expectedGithubRepositoryId ||
    typeof metadata.full_name !== "string" ||
    typeof metadata.stargazers_count !== "number"
  ) {
    throw new Error("GitHub repository identity lookup returned invalid data");
  }
  let canonicalIdentity: { owner: string; repo: string };
  try {
    canonicalIdentity = parseCanonicalGitHubRepositoryFullName(
      metadata.full_name,
    );
  } catch {
    throw new Error("GitHub repository identity lookup returned invalid data");
  }

  return {
    githubRepositoryId: expectedGithubRepositoryId,
    githubRepo: metadata.full_name,
    name: canonicalIdentity.repo,
    description:
      typeof metadata.description === "string"
        ? metadata.description
        : undefined,
    githubUrl: `https://github.com/${canonicalIdentity.owner}/${canonicalIdentity.repo}`,
    language:
      typeof metadata.language === "string" ? metadata.language : undefined,
    stars: metadata.stargazers_count,
  };
}

async function createVerifiedRepositoryAndIndex(
  ctx: ActionCtx,
  args: {
    installationId: number;
    githubRepositoryId: number;
    reconnectRepositoryId?: string;
  },
): Promise<Id<"repositories">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new Error("Not authenticated");
  }

  const reconnectTarget =
    args.reconnectRepositoryId === undefined
      ? null
      : await ctx.runQuery(api.repositories.query.getReconnectTarget, {
          reconnectRepositoryId: args.reconnectRepositoryId,
        });
  if (args.reconnectRepositoryId !== undefined && !reconnectTarget) {
    throw new Error("Repository reconnect target is not available");
  }

  const installation = await ctx.runQuery(
    internal.github.internalQuery.getInstallationByInstallationId,
    { installationId: args.installationId },
  );
  if (
    !isGitHubInstallationReady(installation) ||
    installation.userId !== userId ||
    installation.installationId !== args.installationId
  ) {
    throw new Error("Unauthorized for this installation");
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials are not configured");
  }

  let repository: VerifiedGitHubRepository;
  try {
    repository = await fetchVerifiedGitHubRepositoryById(
      args.installationId,
      args.githubRepositoryId,
      appId,
      privateKey,
    );
  } catch {
    throw new Error(
      "Unable to verify repository access through the GitHub App installation",
    );
  }

  const repoId = await ctx.runMutation(internal.repositories.mutation.create, {
    installationId: args.installationId,
    ...repository,
    ...(reconnectTarget
      ? { reconnectRepositoryId: reconnectTarget.repositoryId }
      : {}),
  });

  console.log(
    `[createAndIndex] Repository created and indexing scheduled: ${repoId}`,
  );
  return repoId;
}

export const createAndIndex = action({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
    reconnectRepositoryId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"repositories">> =>
    await createVerifiedRepositoryAndIndex(ctx, args),
});

/**
 * Sync repository - manually trigger re-indexing
 * User can call this to refresh the AI's understanding of the codebase
 */
export const syncRepository = action({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ success: boolean; message: string }> => {
    // Verify authentication
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    // Get repository and verify ownership
    const repo = await ctx.runQuery(api.repositories.query.getById, {
      repositoryId: args.repositoryId,
    });

    if (!repo) {
      throw new Error("Repository not found");
    }

    if (repo.userId !== userId) {
      throw new Error("Unauthorized");
    }

    if (repo.githubAccessRevokedAt !== undefined) {
      return {
        success: false,
        message:
          "GitHub App repository access has been removed. Reconnect the repository before syncing.",
      };
    }

    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) {
      return {
        success: false,
        message:
          "GitHub App credentials are not configured. Please contact support.",
      };
    }

    const repositoryInstallationId = repo.installationId;
    let verifiedRepository: VerifiedGitHubRepository | undefined;
    try {
      const installation = await ctx.runQuery(
        internal.github.internalQuery.getVerifiedInstallationByInstallationId,
        { installationId: repositoryInstallationId },
      );
      if (!installation || installation.userId !== userId) {
        throw new Error("Installation is not active");
      }
      verifiedRepository = await fetchVerifiedGitHubRepositoryById(
        repositoryInstallationId,
        repo.githubRepositoryId,
        appId,
        privateKey,
      );
    } catch {
      console.warn(
        "[syncRepository] GitHub App installation verification failed",
      );
      return {
        success: false,
        message:
          "Unable to verify the GitHub App installation for this repository. Please reinstall the GitHub App and try again.",
      };
    }

    if (verifiedRepository !== undefined) {
      const installationVerification = await ctx.runMutation(
        internal.repositories.internalMutation.updateInstallationId,
        {
          repositoryId: args.repositoryId,
          installationId: repositoryInstallationId,
          ...verifiedRepository,
          userId,
        },
      );
      if (installationVerification.status === "identity_mismatch") {
        return {
          success: false,
          message:
            "The GitHub repository identity no longer matches this connection. Disconnect it and reconnect the intended repository.",
        };
      }
      if (installationVerification.status !== "updated") {
        return {
          success: false,
          message:
            "The GitHub App installation for this repository is not connected to your account. Please reconnect the GitHub App.",
        };
      }
    }

    if (repo.installationId !== repositoryInstallationId) {
      console.log(
        `[syncRepository] Updated repository installationId to ${repositoryInstallationId}`,
      );
    }

    // Atomically advance the version only when both the file index and its RAG
    // generation are stable. Manual sync must obey the same lock as webhooks.
    const prepareResult = await ctx.runMutation(
      internal.repoIndexing.mutation.prepareIncrementalIndex,
      {
        repositoryId: args.repositoryId,
        allowFailedIndexRecovery: true,
        allowStaleIndexRecovery: true,
        queueIfBusy: false,
        fullRebuild: true,
      },
    );
    if (!prepareResult.success) {
      return {
        success: false,
        message: `Sync unavailable: ${prepareResult.error}`,
      };
    }

    const { newVersion } = prepareResult;

    // Reservation and scheduling already succeeded; logging must not turn the
    // user-visible result into a false failure.
    try {
      await ctx.runMutation(internal.repoIndexing.mutation.addIndexingLog, {
        repositoryId: args.repositoryId,
        indexVersion: newVersion,
        level: "info",
        message: `Manual sync initiated for ${repo.githubRepo}`,
      });
    } catch {
      console.error("[syncRepository] Failed to add sync log");
    }

    console.log(
      `[syncRepository] Manual sync scheduled for: ${args.repositoryId}`,
    );

    return {
      success: true,
      message: "Sync started",
    };
  },
});
