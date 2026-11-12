import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repositories/internalQuery.ts": () =>
    import("../../../convex/repositories/internalQuery"),
};

const settings = {
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
};

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  overrides: Partial<Doc<"repositories">>,
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
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
      githubRepositoryId: 456,
      githubRepo: "owner/repo",
      githubRepoKey: "owner/repo",
      name: "repo",
      githubUrl: "https://github.com/owner/repo",
      isActive: true,
      settings,
      monthlyActions: 0,
      lastResetAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  });
}

describe("immutable repository identity resolution", () => {
  it("prefers a later active row over an earlier revoked duplicate", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertRepository(t, userId, {
      githubRepo: "owner/stale",
      githubRepoKey: "owner/stale",
      name: "stale",
      githubUrl: "https://github.com/owner/stale",
      isActive: false,
      githubAccessRevokedAt: 1,
      isActiveBeforeAccessRevocation: true,
    });
    const activeRepositoryId = await insertRepository(t, userId, {});

    await expect(
      t.query(
        internal.repositories.internalQuery
          .getByInstallationAndGitHubRepositoryId,
        { installationId: 123, githubRepositoryId: 456 },
      ),
    ).resolves.toMatchObject({ _id: activeRepositoryId, isActive: true });
  });

  it("fails closed when two active rows claim the same immutable identity", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertRepository(t, userId, {});
    await insertRepository(t, userId, {
      githubRepo: "owner/duplicate",
      githubRepoKey: "owner/duplicate",
      name: "duplicate",
      githubUrl: "https://github.com/owner/duplicate",
    });

    await expect(
      t.query(
        internal.repositories.internalQuery
          .getByInstallationAndGitHubRepositoryId,
        { installationId: 123, githubRepositoryId: 456 },
      ),
    ).resolves.toBeNull();
  });
});
