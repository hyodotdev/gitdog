import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

const modules = {
  "../../../convex/_generated/api.ts": () =>
    import("../../../convex/_generated/api"),
  "../../../convex/tickets/internalMutation.ts": () =>
    import("../../../convex/tickets/internalMutation"),
};

describe("reopenByGithubNumber", () => {
  it("reopens only the requested type and ignores older close replays", async () => {
    const t = convexTest(schema, modules);
    const { issueId, discussionId } = await t.run(async (ctx) => {
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
          requireApproval: true,
          requireApprovalForDiscussions: true,
        },
        monthlyActions: 0,
        lastResetAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const sharedTicket = {
        repositoryId,
        userId,
        githubRepo: "owner/repo",
        githubNumber: 42,
        githubTitle: "Closed ticket",
        githubBody: "Body",
        status: "closed" as const,
        closedAt: now,
        createdAt: now,
      };
      const issueId = await ctx.db.insert("tickets", {
        aiInputVersion: 1,
        ...sharedTicket,
        ticketType: "issue",
      });
      const discussionId = await ctx.db.insert("tickets", {
        aiInputVersion: 1,
        ...sharedTicket,
        ticketType: "discussion",
      });
      return { issueId, discussionId };
    });

    const reopenedIssueId = await t.mutation(
      internal.tickets.internalMutation.reopenByGithubNumber,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        githubNumber: 42,
        ticketType: "issue",
        githubStateUpdatedAt: 100,
      },
    );
    const afterIssueReopen = await t.run(async (ctx) => ({
      issue: await ctx.db.get(issueId),
      discussion: await ctx.db.get(discussionId),
    }));

    expect(reopenedIssueId).toBe(issueId);
    expect(afterIssueReopen.issue).toMatchObject({ status: "open" });
    expect(afterIssueReopen.issue?.closedAt).toBeUndefined();
    expect(afterIssueReopen.discussion).toMatchObject({ status: "closed" });

    const reopenedDiscussionId = await t.mutation(
      internal.tickets.internalMutation.reopenByGithubNumber,
      {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        githubNumber: 42,
        ticketType: "discussion",
        githubStateUpdatedAt: 100,
      },
    );
    const afterDiscussionReopen = await t.run(async (ctx) => ({
      issue: await ctx.db.get(issueId),
      discussion: await ctx.db.get(discussionId),
    }));

    expect(reopenedDiscussionId).toBe(discussionId);
    expect(afterDiscussionReopen.issue).toMatchObject({ status: "open" });
    expect(afterDiscussionReopen.discussion).toMatchObject({ status: "open" });
    expect(afterDiscussionReopen.discussion?.closedAt).toBeUndefined();

    for (const ticketType of ["issue", "discussion"] as const) {
      await t.mutation(internal.tickets.internalMutation.reopenByGithubNumber, {
        installationId: 123,
        githubRepositoryId: 456,
        repositoryFullName: "owner/repo",
        githubNumber: 42,
        ticketType,
        githubStateUpdatedAt: 300,
      });
      for (let delivery = 0; delivery < 2; delivery++) {
        await t.mutation(
          internal.tickets.internalMutation.closeByGithubNumber,
          {
            installationId: 123,
            githubRepositoryId: 456,
            repositoryFullName: "owner/repo",
            githubNumber: 42,
            ticketType,
            githubStateUpdatedAt: 200,
          },
        );
      }
    }

    const afterReverseExecution = await t.run(async (ctx) => ({
      issue: await ctx.db.get(issueId),
      discussion: await ctx.db.get(discussionId),
    }));
    expect(afterReverseExecution.issue).toMatchObject({
      status: "open",
      githubStateUpdatedAt: 300,
    });
    expect(afterReverseExecution.discussion).toMatchObject({
      status: "open",
      githubStateUpdatedAt: 300,
    });
  });
});
