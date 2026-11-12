import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { internalMutation } from "../../../convex/_generated/server";
import * as githubHelpers from "../../../convex/github/helpers";
import schema from "../../../convex/schema";

let mockedFetch: MockedFunction<
  typeof githubHelpers.fetchGitHubAppJsonWithRetry
>;
let mockedToken: MockedFunction<
  typeof githubHelpers.getRepositoryInstallationToken
>;

const originalAppId = process.env.GITHUB_APP_ID;
const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;

const createRepository = internalMutation({
  args: {
    installationId: v.number(),
    githubRepositoryId: v.number(),
    githubRepo: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    githubUrl: v.string(),
    language: v.optional(v.string()),
    stars: v.optional(v.number()),
    reconnectRepositoryId: v.optional(v.id("repositories")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not authenticated");
    const now = Date.now();
    const { reconnectRepositoryId: _reconnectRepositoryId, ...repository } =
      args;
    return await ctx.db.insert("repositories", {
      indexSyncPending: false,
      indexVersion: 1,
      indexStatus: "completed",
      indexProgressAt: Date.now(),
      ragStatus: "completed",
      ragTotalChunks: 0,
      ragIndexedChunks: 0,
      ragFailedChunks: 0,
      userId,
      ...repository,
      githubRepoKey: repository.githubRepo.toLowerCase(),
      isActive: true,
      settings: {
        issueAssistantEnabled: true,
        autoFormatIssue: true,
        autoAnswerQuestions: true,
        tagMaintainersForCodeChanges: true,
        requireApproval: true,
        discussionAssistantEnabled: true,
        autoFormatDiscussion: true,
        autoAnswerDiscussionQuestions: true,
        tagMaintainersForDiscussionCodeChanges: true,
        requireApprovalForDiscussions: true,
      },
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/github/internalQuery.ts": () =>
    import("../../../convex/github/internalQuery"),
  "../../../convex/repositories/action.ts": () =>
    import("../../../convex/repositories/action"),
  "../../../convex/repositories/query.ts": () =>
    import("../../../convex/repositories/query"),
  "../../../convex/repositories/mutation.ts": async () => ({
    create: createRepository,
  }),
};

async function insertVerifiedInstallation(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    await ctx.db.insert("githubInstallations", {
      userId,
      installationId: 123,
      ownerGithubAccountId: "verified-owner",
      ownershipVerifiedAt: now,
      accountLogin: "owner",
      accountType: "Organization",
      targetType: "Organization",
      createdAt: now,
      updatedAt: now,
    });
    return userId;
  });
}

beforeEach(() => {
  process.env.GITHUB_APP_ID = "app-id";
  process.env.GITHUB_APP_PRIVATE_KEY = "private-key";
  mockedToken = vi.spyOn(
    githubHelpers,
    "getRepositoryInstallationToken",
  ) as MockedFunction<typeof githubHelpers.getRepositoryInstallationToken>;
  mockedToken.mockResolvedValue("installation-token");
  mockedFetch = vi.spyOn(
    githubHelpers,
    "fetchGitHubAppJsonWithRetry",
  ) as MockedFunction<typeof githubHelpers.fetchGitHubAppJsonWithRetry>;
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

describe("repository connection identity", () => {
  it("connects the expected numeric ID even when the displayed name is stale and reused", async () => {
    const t = convexTest(schema, modules);
    const userId = await insertVerifiedInstallation(t);
    mockedFetch.mockResolvedValue({
      id: 456,
      full_name: "owner/current-name",
      name: "contradictory-name",
      description: "Current repository",
      html_url: "https://example.com/untrusted-path",
      language: "TypeScript",
      stargazers_count: 5,
    });

    const repositoryId = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.repositories.action.createAndIndex, {
        installationId: 123,
        githubRepositoryId: 456,
      });
    const repository = await t.run(
      async (ctx) => await ctx.db.get(repositoryId),
    );

    expect(mockedFetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repositories/456",
    );
    expect(mockedToken).toHaveBeenCalledWith(123, 456, "app-id", "private-key");
    expect(repository).toMatchObject({
      githubRepositoryId: 456,
      githubRepo: "owner/current-name",
      name: "current-name",
      githubUrl: "https://github.com/owner/current-name",
      description: "Current repository",
      stars: 5,
    });
  });

  it("rejects a forged public repository ID that is not selected for the installation", async () => {
    const t = convexTest(schema, modules);
    const userId = await insertVerifiedInstallation(t);
    mockedToken.mockRejectedValueOnce(
      new Error("Repository is not selected for this installation"),
    );

    await expect(
      t
        .withIdentity({ subject: `${userId}|session` })
        .action(api.repositories.action.createAndIndex, {
          installationId: 123,
          githubRepositoryId: 999,
        }),
    ).rejects.toThrow(
      "Unable to verify repository access through the GitHub App installation",
    );

    expect(mockedToken).toHaveBeenCalledWith(123, 999, "app-id", "private-key");
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(
      await t.run(async (ctx) => ctx.db.query("repositories").collect()),
    ).toEqual([]);
  });

  it("rejects a numeric identity mismatch without creating a repository", async () => {
    const t = convexTest(schema, modules);
    const userId = await insertVerifiedInstallation(t);
    mockedFetch.mockResolvedValue({
      id: 999,
      full_name: "other/reused-name",
      name: "reused-name",
      html_url: "https://github.com/other/reused-name",
      stargazers_count: 0,
    });

    await expect(
      t
        .withIdentity({ subject: `${userId}|session` })
        .action(api.repositories.action.createAndIndex, {
          installationId: 123,
          githubRepositoryId: 456,
        }),
    ).rejects.toThrow(
      "Unable to verify repository access through the GitHub App installation",
    );
    const repositories = await t.run(
      async (ctx) => await ctx.db.query("repositories").collect(),
    );
    expect(repositories).toEqual([]);
  });

  it.each([
    " owner/repo",
    "owner/repo ",
    "owner/repo/extra",
    "owner/repo\u0000",
  ])("rejects a malformed live full name %j", async (fullName) => {
    const t = convexTest(schema, modules);
    const userId = await insertVerifiedInstallation(t);
    mockedFetch.mockResolvedValue({
      id: 456,
      full_name: fullName,
      name: "repo",
      html_url: "https://github.com/owner/repo",
      stargazers_count: 0,
    });

    await expect(
      t
        .withIdentity({ subject: `${userId}|session` })
        .action(api.repositories.action.createAndIndex, {
          installationId: 123,
          githubRepositoryId: 456,
        }),
    ).rejects.toThrow(
      "Unable to verify repository access through the GitHub App installation",
    );
    expect(
      await t.run(async (ctx) => ctx.db.query("repositories").collect()),
    ).toEqual([]);
  });

  it("accepts an owned installation reconnect target before the live identity lookup", async () => {
    const t = convexTest(schema, modules);
    const userId = await insertVerifiedInstallation(t);
    const reconnectRepositoryId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexVersion: 1,
        indexStatus: "completed",
        indexProgressAt: Date.now(),
        ragStatus: "completed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId,
        installationId: 123,
        githubRepositoryId: 457,
        githubRepo: "owner/old-name",
        githubRepoKey: "owner/old-name",
        name: "old-name",
        githubUrl: "https://github.com/owner/old-name",
        isActive: false,
        githubAccessRevokedAt: now,
        isActiveBeforeAccessRevocation: true,
        githubInstallationReconnectRequired: true,
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
    mockedFetch.mockResolvedValue({
      id: 457,
      full_name: "owner/new-name",
      name: "new-name",
      html_url: "https://github.com/owner/new-name",
      stargazers_count: 0,
    });

    await expect(
      t
        .withIdentity({ subject: `${userId}|session` })
        .action(api.repositories.action.createAndIndex, {
          installationId: 123,
          githubRepositoryId: 457,
          reconnectRepositoryId,
        }),
    ).resolves.toEqual(expect.any(String));
    expect(mockedToken).toHaveBeenCalledOnce();
  });

  it("rejects another user's reconnect target before requesting a token", async () => {
    const t = convexTest(schema, modules);
    const userId = await insertVerifiedInstallation(t);
    const reconnectRepositoryId = await t.run(async (ctx) => {
      const otherUserId = await ctx.db.insert("users", {});
      const now = Date.now();
      return await ctx.db.insert("repositories", {
        indexSyncPending: false,
        indexVersion: 1,
        indexStatus: "completed",
        indexProgressAt: Date.now(),
        ragStatus: "completed",
        ragTotalChunks: 0,
        ragIndexedChunks: 0,
        ragFailedChunks: 0,
        userId: otherUserId,
        installationId: 999,
        githubRepositoryId: 457,
        githubRepo: "other/reconnect",
        githubRepoKey: "other/reconnect",
        name: "reconnect",
        githubUrl: "https://github.com/other/reconnect",
        isActive: false,
        githubAccessRevokedAt: now,
        isActiveBeforeAccessRevocation: true,
        githubInstallationReconnectRequired: true,
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
        .withIdentity({ subject: `${userId}|session` })
        .action(api.repositories.action.createAndIndex, {
          installationId: 123,
          githubRepositoryId: 457,
          reconnectRepositoryId,
        }),
    ).rejects.toThrow("Repository reconnect target is not available");
    expect(mockedToken).not.toHaveBeenCalled();
  });
});
