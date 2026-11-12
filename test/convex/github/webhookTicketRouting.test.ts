import { describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../../../convex/_generated/server";
import {
  handleDiscussionEvent,
  handleIssuesEvent,
  handlePushEvent,
} from "../../../convex/github/webhook";

function createActionContext() {
  const runAfter = vi.fn(
    async (
      _delay: number,
      _functionReference: unknown,
      _args: Record<string, unknown>,
    ) => "scheduled_id",
  );

  return {
    ctx: { scheduler: { runAfter } } as unknown as ActionCtx,
    runAfter,
  };
}

describe("GitHub webhook ticket create routing", () => {
  it("forwards the issue revision to the delayed create job", async () => {
    const { ctx, runAfter } = createActionContext();

    await handleIssuesEvent(ctx, {
      action: "opened",
      issue: {
        number: 11,
        title: "Issue title",
        body: "Body",
        html_url: "https://github.com/owner/repo/issues/11",
        user: { login: "octocat" },
        state: "open",
        updated_at: "2026-07-19T09:58:00Z",
      },
      repository: { id: 789, full_name: "owner/repo" },
      installation: { id: 123 },
    });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0][2]).toMatchObject({
      githubRepositoryId: 789,
      issueNumber: 11,
      action: "opened",
      githubState: "open",
      githubStateUpdatedAt: Date.parse("2026-07-19T09:58:00Z"),
    });
  });

  it("forwards the discussion revision to the delayed create job", async () => {
    const { ctx, runAfter } = createActionContext();

    await handleDiscussionEvent(ctx, {
      action: "created",
      discussion: {
        number: 12,
        title: "Discussion title",
        body: "Body",
        html_url: "https://github.com/owner/repo/discussions/12",
        user: { login: "octocat" },
        state: "open",
        updated_at: "2026-07-19T09:59:00Z",
      },
      repository: { id: 789, full_name: "owner/repo" },
      installation: { id: 123 },
    });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0][2]).toMatchObject({
      githubRepositoryId: 789,
      discussionNumber: 12,
      action: "created",
      githubState: "open",
      githubStateUpdatedAt: Date.parse("2026-07-19T09:59:00Z"),
    });
  });

  it("forwards the current closed state for an edited issue", async () => {
    const { ctx, runAfter } = createActionContext();

    await handleIssuesEvent(ctx, {
      action: "edited",
      issue: {
        number: 13,
        title: "Edited issue",
        body: "Body",
        html_url: "https://github.com/owner/repo/issues/13",
        user: { login: "octocat" },
        state: "closed",
        updated_at: "2026-07-19T10:00:00Z",
      },
      repository: { id: 789, full_name: "owner/repo" },
      installation: { id: 123 },
    });

    expect(runAfter.mock.calls[0][2]).toMatchObject({
      issueNumber: 13,
      action: "edited",
      githubState: "closed",
      githubStateUpdatedAt: Date.parse("2026-07-19T10:00:00Z"),
    });
  });

  it("forwards the current closed state for an edited discussion", async () => {
    const { ctx, runAfter } = createActionContext();

    await handleDiscussionEvent(ctx, {
      action: "edited",
      discussion: {
        number: 14,
        title: "Edited discussion",
        body: "Body",
        html_url: "https://github.com/owner/repo/discussions/14",
        user: { login: "octocat" },
        state: "closed",
        updated_at: "2026-07-19T10:01:00Z",
      },
      repository: { id: 789, full_name: "owner/repo" },
      installation: { id: 123 },
    });

    expect(runAfter.mock.calls[0][2]).toMatchObject({
      discussionNumber: 14,
      action: "edited",
      githubState: "closed",
      githubStateUpdatedAt: Date.parse("2026-07-19T10:01:00Z"),
    });
  });
});

describe("GitHub webhook ticket close routing", () => {
  it("routes an issue close to the issue ticket type", async () => {
    const { ctx, runAfter } = createActionContext();

    await handleIssuesEvent(ctx, {
      action: "closed",
      issue: {
        number: 17,
        title: "Issue title",
        body: null,
        html_url: "https://github.com/owner/repo/issues/17",
        user: { login: "octocat" },
        updated_at: "2026-07-19T10:00:00Z",
      },
      repository: { id: 789, full_name: "owner/repo" },
      installation: { id: 123 },
    });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0][2]).toEqual({
      installationId: 123,
      githubRepositoryId: 789,
      repositoryFullName: "owner/repo",
      githubNumber: 17,
      ticketType: "issue",
      githubStateUpdatedAt: Date.parse("2026-07-19T10:00:00Z"),
    });
  });

  it("routes a discussion close to the discussion ticket type", async () => {
    const { ctx, runAfter } = createActionContext();

    await handleDiscussionEvent(ctx, {
      action: "closed",
      discussion: {
        number: 17,
        title: "Discussion title",
        body: null,
        html_url: "https://github.com/owner/repo/discussions/17",
        user: { login: "octocat" },
        updated_at: "2026-07-19T10:01:00Z",
      },
      repository: { id: 789, full_name: "owner/repo" },
      installation: { id: 123 },
    });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0][2]).toEqual({
      installationId: 123,
      githubRepositoryId: 789,
      repositoryFullName: "owner/repo",
      githubNumber: 17,
      ticketType: "discussion",
      githubStateUpdatedAt: Date.parse("2026-07-19T10:01:00Z"),
    });
  });
});

describe("GitHub webhook ticket reopen routing", () => {
  it("routes an issue reopen to the issue ticket type", async () => {
    const { ctx, runAfter } = createActionContext();

    await handleIssuesEvent(ctx, {
      action: "reopened",
      issue: {
        number: 23,
        title: "Issue title",
        body: null,
        html_url: "https://github.com/owner/repo/issues/23",
        user: { login: "octocat" },
        updated_at: "2026-07-19T10:02:00Z",
      },
      repository: { id: 789, full_name: "owner/repo" },
      installation: { id: 456 },
    });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0][2]).toEqual({
      installationId: 456,
      githubRepositoryId: 789,
      repositoryFullName: "owner/repo",
      githubNumber: 23,
      ticketType: "issue",
      githubStateUpdatedAt: Date.parse("2026-07-19T10:02:00Z"),
    });
  });

  it("routes a discussion reopen to the discussion ticket type", async () => {
    const { ctx, runAfter } = createActionContext();

    await handleDiscussionEvent(ctx, {
      action: "reopened",
      discussion: {
        number: 23,
        title: "Discussion title",
        body: null,
        html_url: "https://github.com/owner/repo/discussions/23",
        user: { login: "octocat" },
        updated_at: "2026-07-19T10:03:00Z",
      },
      repository: { id: 789, full_name: "owner/repo" },
      installation: { id: 456 },
    });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0][2]).toEqual({
      installationId: 456,
      githubRepositoryId: 789,
      repositoryFullName: "owner/repo",
      githubNumber: 23,
      ticketType: "discussion",
      githubStateUpdatedAt: Date.parse("2026-07-19T10:03:00Z"),
    });
  });
});

describe("GitHub webhook repository indexing routing", () => {
  it("indexes only pushes to the repository default branch", async () => {
    const { ctx, runAfter } = createActionContext();

    await handlePushEvent(ctx, {
      ref: "refs/heads/main",
      commits: [{ id: "commit-1", message: "Fix indexing" }],
      repository: {
        id: 789,
        full_name: "owner/repo",
        default_branch: "main",
      },
      installation: { id: 456 },
    });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0][2]).toEqual({
      installationId: 456,
      githubRepositoryId: 789,
      repositoryFullName: "owner/repo",
      reason: "push",
    });
  });

  it("ignores pushes to non-default branches", async () => {
    const { ctx, runAfter } = createActionContext();

    await handlePushEvent(ctx, {
      ref: "refs/heads/feature/default-branch-name",
      commits: [{ id: "commit-1", message: "Feature work" }],
      repository: {
        id: 789,
        full_name: "owner/repo",
        default_branch: "main",
      },
      installation: { id: 456 },
    });

    expect(runAfter).not.toHaveBeenCalled();
  });

  it("indexes a force-reset of the default branch with no introduced commits", async () => {
    const { ctx, runAfter } = createActionContext();

    await handlePushEvent(ctx, {
      ref: "refs/heads/main",
      before: "2222222222222222222222222222222222222222",
      after: "1111111111111111111111111111111111111111",
      forced: true,
      deleted: false,
      commits: [],
      repository: {
        id: 789,
        full_name: "owner/repo",
        default_branch: "main",
      },
      installation: { id: 456 },
    });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0][2]).toEqual({
      installationId: 456,
      githubRepositoryId: 789,
      repositoryFullName: "owner/repo",
      reason: "push",
      source: {
        commitSha: "1111111111111111111111111111111111111111",
        defaultBranch: "main",
      },
    });
  });

  it("ignores an all-zero default branch ref deletion", async () => {
    const { ctx, runAfter } = createActionContext();

    await handlePushEvent(ctx, {
      ref: "refs/heads/main",
      after: "0000000000000000000000000000000000000000",
      deleted: false,
      commits: [],
      repository: {
        id: 789,
        full_name: "owner/repo",
        default_branch: "main",
      },
      installation: { id: 456 },
    });

    expect(runAfter).not.toHaveBeenCalled();
  });

  it("ignores an explicitly deleted default branch ref", async () => {
    const { ctx, runAfter } = createActionContext();

    await handlePushEvent(ctx, {
      ref: "refs/heads/main",
      deleted: true,
      commits: [],
      repository: {
        id: 789,
        full_name: "owner/repo",
        default_branch: "main",
      },
      installation: { id: 456 },
    });

    expect(runAfter).not.toHaveBeenCalled();
  });
});
