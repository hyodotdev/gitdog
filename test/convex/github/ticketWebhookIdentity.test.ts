import { afterEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import * as githubHelpers from "../../../convex/github/helpers";
import * as repositoryIdentity from "../../../convex/github/repositoryIdentity";
import {
  handleDiscussionCommentEvent,
  handleDiscussionEvent,
  handleIssueCommentEvent,
  handleIssuesEvent,
} from "../../../convex/github/webhook";

const originalAppId = process.env.GITHUB_APP_ID;
const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
const originalAppSlug = process.env.GITHUB_APP_SLUG;

afterEach(() => {
  if (originalAppId === undefined) delete process.env.GITHUB_APP_ID;
  else process.env.GITHUB_APP_ID = originalAppId;
  if (originalPrivateKey === undefined)
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  else process.env.GITHUB_APP_PRIVATE_KEY = originalPrivateKey;
  if (originalAppSlug === undefined) delete process.env.GITHUB_APP_SLUG;
  else process.env.GITHUB_APP_SLUG = originalAppSlug;
  vi.restoreAllMocks();
});

function createContext() {
  const runAfter = vi.fn(async () => "scheduled-function-id");
  return {
    ctx: { scheduler: { runAfter } } as unknown as ActionCtx,
    runAfter,
  };
}

const repositoryId = "repository-id" as Id<"repositories">;
const ticketId = "ticket-id" as Id<"tickets">;
const requestedByUserId = "requester-id" as Id<"users">;

function createCommentContext() {
  const runQuery = vi.fn().mockResolvedValue(requestedByUserId);
  const runMutation = vi
    .fn()
    .mockResolvedValueOnce({ _id: ticketId, repositoryId })
    .mockResolvedValueOnce("action-id");
  return {
    ctx: { runQuery, runMutation } as unknown as ActionCtx,
    runQuery,
    runMutation,
  };
}

function mockVerifiedRepositoryAccess(
  overrides: {
    installationId?: number;
    githubRepositoryId?: number;
  } = {},
) {
  return vi
    .spyOn(repositoryIdentity, "resolveVerifiedRepositoryAccess")
    .mockResolvedValue({
      repository: { _id: repositoryId },
      installation: { installationId: overrides.installationId ?? 123 },
      githubRepositoryId: overrides.githubRepositoryId ?? 456,
      githubRepo: "live-owner/live-repo",
      owner: "live-owner",
      repo: "live-repo",
      token: "verified-installation-token",
    } as Awaited<
      ReturnType<typeof repositoryIdentity.resolveVerifiedRepositoryAccess>
    >);
}

function createIssueCommentPayload() {
  return {
    action: "created",
    installation: { id: 123 },
    repository: { id: 456, full_name: "stale-owner/reused-name" },
    issue: {
      number: 42,
      title: "Issue",
      body: "Body",
      html_url: "https://github.com/stale-owner/reused-name/issues/42",
    },
    comment: {
      id: 900,
      body: "@gitdogbot please help",
      user: { id: 77, login: "author", type: "User" },
      author_association: "MEMBER",
    },
    sender: { id: 77, login: "author", type: "User" },
  };
}

function createDiscussionCommentPayload() {
  return {
    action: "created",
    installation: { id: 123 },
    repository: { id: 456, full_name: "stale-owner/reused-name" },
    discussion: {
      number: 7,
      title: "Discussion",
      body: "Body",
      html_url: "https://github.com/stale-owner/reused-name/discussions/7",
    },
    comment: {
      id: 901,
      node_id: "discussion-comment-node",
      body: "@gitdogbot please help",
      user: { id: 77, login: "author", type: "User" },
      author_association: "MEMBER",
    },
    sender: { id: 77, login: "author", type: "User" },
  };
}

describe("ticket webhook immutable repository identity", () => {
  it("passes the signed repository ID into issue ticket creation", async () => {
    const { ctx, runAfter } = createContext();

    await handleIssuesEvent(ctx, {
      action: "opened",
      installation: { id: 123 },
      repository: { id: 456, full_name: "owner/repo" },
      issue: {
        number: 42,
        title: "Issue",
        body: "Body",
        html_url: "https://github.com/owner/repo/issues/42",
        user: { login: "author" },
      },
    });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0][2]).toMatchObject({
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      issueNumber: 42,
    });
  });

  it("passes the signed repository ID into discussion ticket creation", async () => {
    const { ctx, runAfter } = createContext();

    await handleDiscussionEvent(ctx, {
      action: "created",
      installation: { id: 123 },
      repository: { id: 456, full_name: "owner/repo" },
      discussion: {
        number: 7,
        title: "Discussion",
        body: "Body",
        html_url: "https://github.com/owner/repo/discussions/7",
        user: { login: "author" },
      },
    });

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0][2]).toMatchObject({
      installationId: 123,
      githubRepositoryId: 456,
      repositoryFullName: "owner/repo",
      discussionNumber: 7,
    });
  });

  it("uses the live immutable identity for issue comment history", async () => {
    const { ctx, runMutation } = createCommentContext();
    const resolveAccess = mockVerifiedRepositoryAccess();
    const getIssueComments = vi
      .spyOn(githubHelpers, "getIssueComments")
      .mockResolvedValue([]);

    await handleIssueCommentEvent(ctx, createIssueCommentPayload());

    expect(resolveAccess).toHaveBeenCalledWith(ctx, repositoryId);
    expect(getIssueComments).toHaveBeenCalledWith(
      "live-owner",
      "live-repo",
      42,
      "verified-installation-token",
      { limit: 6 },
    );
    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(runMutation.mock.calls[1][1]).toMatchObject({
      ticketId,
      requestedByUserId,
      previousComments: [],
    });
  });

  it("uses the live immutable identity for discussion comment history", async () => {
    const { ctx, runMutation } = createCommentContext();
    const resolveAccess = mockVerifiedRepositoryAccess();
    const getDiscussionComments = vi
      .spyOn(githubHelpers, "getDiscussionComments")
      .mockResolvedValue([]);

    await handleDiscussionCommentEvent(ctx, createDiscussionCommentPayload());

    expect(resolveAccess).toHaveBeenCalledWith(ctx, repositoryId);
    expect(getDiscussionComments).toHaveBeenCalledWith(
      "live-owner",
      "live-repo",
      7,
      "verified-installation-token",
      { limit: 6, currentCommentNodeId: "discussion-comment-node" },
    );
    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(runMutation.mock.calls[1][1]).toMatchObject({
      ticketId,
      requestedByUserId,
      previousComments: [],
    });
  });

  it.each([
    {
      label: "production",
      configuredSlug: "gitdogbot",
      foreignMention: "@gitdogbot-dev please help",
    },
    {
      label: "development",
      configuredSlug: "gitdogbot-dev",
      foreignMention: "@gitdogbot please help",
    },
  ])(
    "ignores the other Gitdog App mention in $label",
    async ({ configuredSlug, foreignMention }) => {
      process.env.GITHUB_APP_SLUG = configuredSlug;
      const payload = createIssueCommentPayload();
      payload.comment.body = foreignMention;
      const runQuery = vi.fn();
      const runMutation = vi.fn();
      const ctx = { runQuery, runMutation } as unknown as ActionCtx;

      await handleIssueCommentEvent(ctx, payload);

      expect(runQuery).not.toHaveBeenCalled();
      expect(runMutation).not.toHaveBeenCalled();
    },
  );

  it.each([
    { installationId: 999, githubRepositoryId: 456 },
    { installationId: 123, githubRepositoryId: 999 },
  ])(
    "fails closed when live comment identity is $installationId/$githubRepositoryId",
    async (identity) => {
      const { ctx, runMutation } = createCommentContext();
      mockVerifiedRepositoryAccess(identity);
      const getIssueComments = vi.spyOn(githubHelpers, "getIssueComments");

      await expect(
        handleIssueCommentEvent(ctx, createIssueCommentPayload()),
      ).rejects.toThrow("Webhook repository identity no longer matches");
      expect(getIssueComments).not.toHaveBeenCalled();
      expect(runMutation).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      label: "a missing signed sender",
      mutate: (payload: ReturnType<typeof createIssueCommentPayload>) => {
        delete (payload as { sender?: unknown }).sender;
      },
    },
    {
      label: "a non-user signed sender",
      mutate: (payload: ReturnType<typeof createIssueCommentPayload>) => {
        payload.sender.type = "Bot";
      },
    },
    {
      label: "a mismatched comment author ID",
      mutate: (payload: ReturnType<typeof createIssueCommentPayload>) => {
        payload.comment.user.id = 88;
      },
    },
  ])(
    "rejects issue mentions from $label before any history or action write",
    async ({ mutate }) => {
      const payload = createIssueCommentPayload();
      mutate(payload);
      const runQuery = vi.fn();
      const runMutation = vi.fn();
      const getIssueComments = vi.spyOn(githubHelpers, "getIssueComments");
      const ctx = { runQuery, runMutation } as unknown as ActionCtx;

      await handleIssueCommentEvent(ctx, payload);

      expect(runQuery).not.toHaveBeenCalled();
      expect(runMutation).not.toHaveBeenCalled();
      expect(getIssueComments).not.toHaveBeenCalled();
    },
  );

  it("rejects an unattested issue requester before ticket or history work", async () => {
    const runQuery = vi.fn().mockResolvedValue(null);
    const runMutation = vi.fn();
    const getIssueComments = vi.spyOn(githubHelpers, "getIssueComments");
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleIssueCommentEvent(ctx, createIssueCommentPayload());

    expect(runQuery).toHaveBeenCalledOnce();
    expect(runMutation).not.toHaveBeenCalled();
    expect(getIssueComments).not.toHaveBeenCalled();
  });

  it("does not trust a deleted-comment maintainer check after repository selection is removed", async () => {
    process.env.GITHUB_APP_ID = "test-app-id";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
    const scopedToken = vi
      .spyOn(githubHelpers, "getRepositoryInstallationToken")
      .mockRejectedValue(
        new Error("Repository is not selected for this installation"),
      );
    const genericToken = vi.spyOn(githubHelpers, "getInstallationToken");
    const getMaintainers = vi.spyOn(githubHelpers, "getRepositoryMaintainers");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runQuery = vi.fn().mockResolvedValue(requestedByUserId);
    const runMutation = vi.fn();
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    await handleIssueCommentEvent(ctx, {
      action: "deleted",
      installation: { id: 123 },
      repository: { id: 456, full_name: "owner/public-repo" },
      issue: { number: 42, title: "Issue" },
      comment: {
        id: 900,
        user: { login: "gitdogbot[bot]", type: "Bot" },
      },
      sender: { id: 77, login: "maintainer", type: "User" },
    });

    expect(scopedToken).toHaveBeenCalledWith(
      123,
      456,
      "test-app-id",
      "test-private-key",
    );
    expect(genericToken).not.toHaveBeenCalled();
    expect(getMaintainers).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("rejects an unattested bot-comment deleter before maintainer or learning work", async () => {
    process.env.GITHUB_APP_ID = "test-app-id";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
    const scopedToken = vi.spyOn(
      githubHelpers,
      "getRepositoryInstallationToken",
    );
    const getMaintainers = vi.spyOn(githubHelpers, "getRepositoryMaintainers");
    const runQuery = vi.fn().mockResolvedValue(null);
    const runMutation = vi.fn();
    const runAction = vi.fn();
    const ctx = { runQuery, runMutation, runAction } as unknown as ActionCtx;

    await handleIssueCommentEvent(ctx, {
      action: "deleted",
      installation: { id: 123 },
      repository: { id: 456, full_name: "owner/public-repo" },
      issue: { number: 42, title: "Issue" },
      comment: {
        id: 900,
        user: { login: "gitdogbot[bot]", type: "Bot" },
      },
      sender: { id: 77, login: "maintainer", type: "User" },
    });

    expect(runQuery).toHaveBeenCalledOnce();
    expect(scopedToken).not.toHaveBeenCalled();
    expect(getMaintainers).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });

  it("persists the verified bot-comment deleter on negative learning work", async () => {
    process.env.GITHUB_APP_ID = "test-app-id";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
    vi.spyOn(githubHelpers, "getRepositoryInstallationToken").mockResolvedValue(
      "scoped-token",
    );
    vi.spyOn(githubHelpers, "getRepositoryMaintainers").mockResolvedValue([
      "maintainer",
    ]);
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(requestedByUserId)
      .mockResolvedValueOnce({
        _id: "action-id",
        proposedChanges: { suggestedResponse: "bad response" },
      });
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({ _id: ticketId, repositoryId });
    const runAction = vi.fn().mockResolvedValue("learning-id");
    const ctx = { runQuery, runMutation, runAction } as unknown as ActionCtx;

    await handleIssueCommentEvent(ctx, {
      action: "deleted",
      installation: { id: 123 },
      repository: { id: 456, full_name: "owner/public-repo" },
      issue: { number: 42, title: "Issue" },
      comment: {
        id: 900,
        user: { login: "gitdogbot[bot]", type: "Bot" },
      },
      sender: { id: 77, login: "maintainer", type: "User" },
    });

    expect(runAction).toHaveBeenCalledOnce();
    expect(runAction.mock.calls[0][1]).toMatchObject({
      repositoryId,
      ticketId,
      requestedByUserId,
      sourceType: "correction",
    });
  });
});
