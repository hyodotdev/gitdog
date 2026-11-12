import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";
import { getTrustedLearningRepositoryKey } from "../../../convex/repoLearnings/trust";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/repoLearnings/query.ts": () =>
    import("../../../convex/repoLearnings/query"),
};

describe("repository learning trusted count", () => {
  it("counts only learnings visible to trusted vector search", async () => {
    const t = convexTest(schema, modules);
    const { userId, repositoryId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
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
        githubRepo: "owner/repo",
        githubRepoKey: "owner/repo",
        name: "repo",
        githubUrl: "https://github.com/owner/repo",
        isActive: true,
        settings: {
          issueAssistantEnabled: true,
          autoFormatIssue: true,
          autoAnswerQuestions: true,
          tagMaintainersForCodeChanges: true,
          discussionAssistantEnabled: true,
          autoFormatDiscussion: true,
          autoAnswerDiscussionQuestions: true,
          tagMaintainersForDiscussionCodeChanges: true,
          requireApproval: false,
          requireApprovalForDiscussions: false,
        },
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const baseLearning = {
        repositoryId,
        content: "Use the repository convention",
        source: "issue:1",
        sourceType: "correction" as const,
        embedding: [],
        embeddingDataProvenance: "private_user_input" as const,
        createdAt: now,
      };

      await ctx.db.insert("repoLearnings", {
        ...baseLearning,
        isTrusted: true,
        repositoryTrustKey: getTrustedLearningRepositoryKey(repositoryId),
      });
      await ctx.db.insert("repoLearnings", {
        ...baseLearning,
        source: "untrusted",
        isTrusted: false,
      });

      return { userId, repositoryId };
    });

    const count = await t
      .withIdentity({ subject: `${userId}|test-session` })
      .query(api.repoLearnings.query.countByRepository, { repositoryId });

    expect(count).toBe(1);
  });
});
