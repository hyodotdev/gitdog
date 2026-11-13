import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { v } from "convex/values";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { internalMutation } from "../../../convex/_generated/server";
import * as githubHelpers from "../../../convex/github/helpers";
import schema from "../../../convex/schema";

let mockedFetchGitHubAppJsonWithRetry: MockedFunction<
  typeof githubHelpers.fetchGitHubAppJsonWithRetry
>;

const prepareIncrementalIndex = internalMutation({
  args: {
    repositoryId: v.optional(v.id("repositories")),
    installationId: v.optional(v.number()),
    githubRepo: v.optional(v.string()),
    allowFailedIndexRecovery: v.optional(v.boolean()),
    allowStaleIndexRecovery: v.optional(v.boolean()),
    queueIfBusy: v.optional(v.boolean()),
    fullRebuild: v.optional(v.boolean()),
    scheduleDelayMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!args.repositoryId) {
      return {
        success: false as const,
        error: "repository identifier required",
      };
    }
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository) {
      return { success: false as const, error: "repository not found" };
    }
    const newVersion = repository.indexVersion + 1;
    await ctx.db.patch(args.repositoryId, {
      indexVersion: newVersion,
      indexStatus: "pending",
    });
    return {
      success: true as const,
      repositoryId: args.repositoryId,
      newVersion,
    };
  },
});

const addIndexingLog = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    level: v.union(
      v.literal("info"),
      v.literal("success"),
      v.literal("warning"),
      v.literal("error"),
    ),
    message: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async () => undefined,
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/github/query.ts": () =>
    import("../../../convex/github/query"),
  "../../../convex/github/internalQuery.ts": () =>
    import("../../../convex/github/internalQuery"),
  "../../../convex/repositories/action.ts": () =>
    import("../../../convex/repositories/action"),
  "../../../convex/repositories/query.ts": () =>
    import("../../../convex/repositories/query"),
  "../../../convex/repositories/internalMutation.ts": () =>
    import("../../../convex/repositories/internalMutation"),
  "../../../convex/repositories/mutation.ts": () =>
    import("../../../convex/repositories/mutation"),
  "../../../convex/repoIndexing/mutation.ts": async () => ({
    prepareIncrementalIndex,
    addIndexingLog,
  }),
};

const originalAppId = process.env.GITHUB_APP_ID;
const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;

async function insertInstallation(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  installationId: number,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId,
      ownerGithubAccountId: `github-${userId}`,
      ownershipVerifiedAt: now,
      accountLogin: `owner-${installationId}`,
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  installationId: number,
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexProgressAt: Date.now(),
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      installationId,
      githubRepositoryId: 456,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      indexVersion: 0,
      indexStatus: "completed",
      ragStatus: "completed",
      settings: {
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
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

beforeEach(() => {
  process.env.GITHUB_APP_ID = "test-app-id";
  process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
  vi.spyOn(githubHelpers, "getRepositoryInstallationToken").mockResolvedValue(
    "installation-token",
  );
  mockedFetchGitHubAppJsonWithRetry = vi.spyOn(
    githubHelpers,
    "fetchGitHubAppJsonWithRetry",
  ) as MockedFunction<typeof githubHelpers.fetchGitHubAppJsonWithRetry>;
  mockedFetchGitHubAppJsonWithRetry.mockResolvedValue({
    id: 456,
    full_name: "owner/repo",
    name: "repo",
    description: null,
    html_url: "https://github.com/owner/repo",
    language: "TypeScript",
    stargazers_count: 10,
  });
});

afterEach(() => {
  if (originalAppId === undefined) {
    delete process.env.GITHUB_APP_ID;
  } else {
    process.env.GITHUB_APP_ID = originalAppId;
  }
  if (originalPrivateKey === undefined) {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  } else {
    process.env.GITHUB_APP_PRIVATE_KEY = originalPrivateKey;
  }
  vi.restoreAllMocks();
});

describe("repository installation recovery", () => {
  it("does not attempt to sync after GitHub repository access is removed", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const repositoryId = await insertRepository(t, ownerId, 999);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        isActive: false,
        githubAccessRevokedAt: Date.now(),
        isActiveBeforeAccessRevocation: true,
      });
    });

    const result = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.repositories.action.syncRepository, { repositoryId });

    await expect(
      t
        .withIdentity({ subject: `${ownerId}|test-session` })
        .mutation(api.repositories.mutation.toggleActive, { repositoryId }),
    ).rejects.toThrow("GitHub App repository access has been removed");

    expect(result).toEqual({
      success: false,
      message:
        "GitHub App repository access has been removed. Reconnect the repository before syncing.",
    });
  });

  it("syncs only the pinned numeric identity and accepts its current name", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 222);
    const repositoryId = await insertRepository(t, ownerId, 222);
    mockedFetchGitHubAppJsonWithRetry.mockResolvedValue({
      id: 456,
      full_name: "owner/current-name",
      name: "current-name",
      description: null,
      html_url: "https://github.com/owner/current-name",
      language: "TypeScript",
      stargazers_count: 10,
    });

    const result = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.repositories.action.syncRepository, { repositoryId });

    expect(result).toEqual({ success: true, message: "Sync started" });
    expect(mockedFetchGitHubAppJsonWithRetry.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repositories/456",
    );
    expect(githubHelpers.getRepositoryInstallationToken).toHaveBeenCalledWith(
      222,
      456,
      "test-app-id",
      "test-private-key",
    );
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(repository).toMatchObject({
      installationId: 222,
      githubRepositoryId: 456,
      githubRepo: "owner/current-name",
      githubRepoKey: "owner/current-name",
      indexVersion: 1,
      indexStatus: "pending",
    });
  });

  it("cleans a mixed-case alias before canonicalizing an unchanged live name", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 222);
    const repositoryId = await insertRepository(t, ownerId, 222);
    const conflictingRepositoryId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexProgressAt: Date.now(),
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId: ownerId,
        installationId: 222,
        githubRepositoryId: 789,
        githubRepo: "Owner/Repo",
        githubRepoKey: "owner/repo",
        name: "Repo",
        githubUrl: "https://github.com/Owner/Repo",
        isActive: true,
        indexVersion: 4,
        indexStatus: "completed",
        ragStatus: "completed",
        settings: {
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
        },
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t
        .withIdentity({ subject: `${ownerId}|test-session` })
        .action(api.repositories.action.syncRepository, { repositoryId }),
    ).resolves.toEqual({ success: true, message: "Sync started" });

    const state = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      conflict: await ctx.db.get(conflictingRepositoryId),
    }));
    expect(state.repository).toMatchObject({
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      isActive: true,
    });
    expect(state.conflict).toMatchObject({
      githubRepo: "__gitdog_quarantine__/789",
      githubRepoKey: "__gitdog_quarantine__/789",
      isActive: false,
      indexVersion: 5,
      indexStatus: "failed",
      ragStatus: "failed",
    });
  });

  it("rejects an installation that is not stored for the repository owner", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, otherUserId } = await t.run(async (ctx) => ({
      ownerId: await ctx.db.insert("users", {}),
      otherUserId: await ctx.db.insert("users", {}),
    }));
    await insertInstallation(t, ownerId, 111);
    await insertInstallation(t, otherUserId, 222);
    const repositoryId = await insertRepository(t, ownerId, 222);

    const result = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.repositories.action.syncRepository, { repositoryId });

    expect(result).toEqual({
      success: false,
      message:
        "Unable to verify the GitHub App installation for this repository. Please reinstall the GitHub App and try again.",
    });
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));
    expect(repository).toMatchObject({
      installationId: 222,
      indexVersion: 0,
      indexStatus: "completed",
    });
  });

  it("refuses to sync when live metadata has a different immutable repository ID", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 222);
    const repositoryId = await insertRepository(t, ownerId, 222);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { githubRepositoryId: 999 });
    });
    const result = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.repositories.action.syncRepository, { repositoryId });
    const repository = await t.run(async (ctx) => ctx.db.get(repositoryId));

    expect(result).toEqual({
      success: false,
      message:
        "Unable to verify the GitHub App installation for this repository. Please reinstall the GitHub App and try again.",
    });
    expect(repository).toMatchObject({
      githubRepositoryId: 999,
      indexVersion: 0,
      indexStatus: "completed",
    });
  });

  it("does not expose lookup errors in logs or user-visible messages", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertInstallation(t, ownerId, 999);
    const repositoryId = await insertRepository(t, ownerId, 999);
    mockedFetchGitHubAppJsonWithRetry.mockRejectedValue(
      new Error("sensitive-jwt-or-token"),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await t
      .withIdentity({ subject: `${ownerId}|test-session` })
      .action(api.repositories.action.syncRepository, { repositoryId });

    expect(result.success).toBe(false);
    expect(result.message).not.toContain("sensitive");
    expect(warning.mock.calls.flat().join(" ")).not.toContain("sensitive");
  });
});
