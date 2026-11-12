import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";

import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import * as githubHelpers from "../../../convex/github/helpers";
import {
  hasVerifiedActiveRepositoryInstallation,
  resolveVerifiedRepositoryAccess,
} from "../../../convex/github/repositoryIdentity";
import schema from "../../../convex/schema";

let mockedFetch: MockedFunction<
  typeof githubHelpers.fetchGitHubAppJsonWithRetry
>;
let mockedToken: MockedFunction<
  typeof githubHelpers.getRepositoryInstallationToken
>;
const originalAppId = process.env.GITHUB_APP_ID;
const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/github/internalQuery.ts": () =>
    import("../../../convex/github/internalQuery"),
  "../../../convex/repositories/internalQuery.ts": () =>
    import("../../../convex/repositories/internalQuery"),
};

async function insertFixture(t: ReturnType<typeof convexTest>): Promise<{
  installationDocId: Id<"githubInstallations">;
  repositoryId: Id<"repositories">;
}> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    const installationDocId = await ctx.db.insert("githubInstallations", {
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
    const repositoryId = await ctx.db.insert("repositories", {
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
      githubRepositoryId: 456,
      githubRepo: "old-owner/reused-name",
      githubRepoKey: "old-owner/reused-name",
      name: "reused-name",
      githubUrl: "https://github.com/old-owner/reused-name",
      isActive: true,
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
    return { installationDocId, repositoryId };
  });
}

function createActionContext(t: ReturnType<typeof convexTest>): ActionCtx {
  return {
    runQuery: async (reference, args) => await t.query(reference, args),
  } as ActionCtx;
}

beforeEach(() => {
  process.env.GITHUB_APP_ID = "app-id";
  process.env.GITHUB_APP_PRIVATE_KEY = "private-key";
  mockedFetch = vi.spyOn(githubHelpers, "fetchGitHubAppJsonWithRetry");
  mockedToken = vi
    .spyOn(githubHelpers, "getRepositoryInstallationToken")
    .mockResolvedValue("installation-token");
});

afterEach(() => {
  if (originalAppId === undefined) delete process.env.GITHUB_APP_ID;
  else process.env.GITHUB_APP_ID = originalAppId;
  if (originalPrivateKey === undefined)
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  else process.env.GITHUB_APP_PRIVATE_KEY = originalPrivateKey;
  vi.restoreAllMocks();
});

describe("verified repository request identity", () => {
  it("resolves the current name only through the immutable numeric ID", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertFixture(t);
    mockedFetch.mockResolvedValue({
      id: 456,
      full_name: "current-owner/current-name",
    });

    const result = await resolveVerifiedRepositoryAccess(
      createActionContext(t),
      repositoryId,
    );

    expect(mockedFetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repositories/456",
    );
    expect(mockedToken).toHaveBeenCalledWith(123, 456, "app-id", "private-key");
    expect(result).toMatchObject({
      githubRepositoryId: 456,
      githubRepo: "current-owner/current-name",
      owner: "current-owner",
      repo: "current-name",
      token: "installation-token",
    });
  });

  it("fails closed after a public repository is removed from the installation selection", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertFixture(t);
    mockedToken.mockRejectedValueOnce(
      new Error("Repository is not selected for this installation"),
    );

    await expect(
      resolveVerifiedRepositoryAccess(createActionContext(t), repositoryId),
    ).rejects.toThrow("Repository is not selected for this installation");

    expect(mockedToken).toHaveBeenCalledWith(123, 456, "app-id", "private-key");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("fails after the network lookup if suspension begins during the request", async () => {
    const t = convexTest(schema, modules);
    const { installationDocId, repositoryId } = await insertFixture(t);
    mockedFetch.mockImplementation(async () => {
      await t.run(async (ctx) => {
        await ctx.db.patch(installationDocId, {
          accessSuspendedAt: Date.now(),
        });
      });
      return { id: 456, full_name: "current-owner/current-name" };
    });

    await expect(
      resolveVerifiedRepositoryAccess(createActionContext(t), repositoryId),
    ).rejects.toThrow("changed during request");
  });

  it("does not request a token while a removal job gates the installation", async () => {
    const t = convexTest(schema, modules);
    const { installationDocId, repositoryId } = await insertFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(installationDocId, {
        repositoryRemovalPendingAt: Date.now(),
      });
    });

    await expect(
      resolveVerifiedRepositoryAccess(createActionContext(t), repositoryId),
    ).rejects.toThrow("not active");
    expect(mockedToken).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("rejects a stale repository snapshot after disconnect starts", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertFixture(t);
    const staleRepository = await t.run(
      async (ctx) => await ctx.db.get(repositoryId),
    );
    if (!staleRepository) throw new Error("repository missing");

    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        isActive: false,
        disconnectCleanupPending: true,
        updatedAt: Date.now(),
      });
    });

    expect(
      await hasVerifiedActiveRepositoryInstallation(
        createActionContext(t),
        staleRepository,
      ),
    ).toBe(false);
    expect(mockedToken).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("rejects a stale repository snapshot after its index generation changes", async () => {
    const t = convexTest(schema, modules);
    const { repositoryId } = await insertFixture(t);
    const staleRepository = await t.run(
      async (ctx) => await ctx.db.get(repositoryId),
    );
    if (!staleRepository) throw new Error("repository missing");

    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        indexVersion: staleRepository.indexVersion + 1,
        updatedAt: Date.now(),
      });
    });

    expect(
      await hasVerifiedActiveRepositoryInstallation(
        createActionContext(t),
        staleRepository,
      ),
    ).toBe(false);
  });
});
