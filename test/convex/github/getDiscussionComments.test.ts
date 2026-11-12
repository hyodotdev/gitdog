import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findDiscussionCommentByExecutionMarker,
  getDiscussionComments,
} from "../../../convex/github/helpers";

type GraphQlComment = {
  id: string;
  body: string;
  author: { __typename: string; login: string } | null;
  authorAssociation: string;
  createdAt: string;
  replies?: { nodes: GraphQlComment[] };
  replyTo?: GraphQlComment | null;
};

const originalFetch = globalThis.fetch;
const originalSlug = process.env.GITHUB_APP_SLUG;

function createComment(
  id: string,
  createdAt: string,
  overrides: Partial<GraphQlComment> = {},
): GraphQlComment {
  return {
    id,
    body: `Comment ${id}`,
    author: { __typename: "User", login: `user-${id}` },
    authorAssociation: "NONE",
    createdAt,
    ...overrides,
  };
}

function createGraphQlResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env.GITHUB_APP_SLUG = "gitdogbot";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSlug === undefined) delete process.env.GITHUB_APP_SLUG;
  else process.env.GITHUB_APP_SLUG = originalSlug;
  vi.restoreAllMocks();
});

describe("getDiscussionComments", () => {
  it("finds a configured-bot marker in the exact discussion reply thread", async () => {
    const marker =
      "<!-- gitdog-execution:00000000-0000-4000-8000-000000000000 -->";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createGraphQlResponse({
          node: { id: "reply-target", replyTo: { id: "root" } },
        }),
      )
      .mockResolvedValueOnce(
        createGraphQlResponse({
          node: {
            replies: {
              nodes: [
                {
                  id: "forged",
                  body: marker,
                  author: { login: "someone" },
                },
                {
                  id: "owned-reply",
                  body: marker,
                  author: { login: "gitdogbot[bot]" },
                },
              ],
              pageInfo: { hasPreviousPage: false, startCursor: null },
            },
          },
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      findDiscussionCommentByExecutionMarker(
        "owner",
        "repo",
        42,
        "reply-target",
        marker,
        "token",
      ),
    ).resolves.toEqual({ commentId: "owned-reply", exhaustive: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses GraphQL variables instead of interpolating repository input", async () => {
    const fetchMock = vi.fn(async () =>
      createGraphQlResponse({
        repository: { discussion: { comments: { nodes: [] } } },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await getDiscussionComments('owner"with-quote', "repo-name", 42, "token", {
      limit: 6,
    });

    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(request.query).toContain("repository(owner: $owner, name: $repo)");
    expect(request.query).not.toContain('owner"with-quote');
    expect(request.variables).toMatchObject({
      owner: 'owner"with-quote',
      repo: "repo-name",
      discussionNumber: 42,
      limit: 6,
    });
  });

  it("returns the focused parent thread for a reply to an old top-level comment", async () => {
    const parent = createComment("parent-old", "2026-01-01T00:00:00.000Z");
    const earlierReply = createComment(
      "reply-earlier",
      "2026-01-02T00:00:00.000Z",
    );
    const currentReply = createComment(
      "reply-current",
      "2026-07-11T00:00:00.000Z",
    );
    parent.replies = { nodes: [earlierReply, currentReply] };

    const recentUnrelated = createComment(
      "recent-unrelated",
      "2026-07-10T00:00:00.000Z",
    );
    const focusedComment = {
      ...currentReply,
      replyTo: parent,
    };

    const fetchMock = vi.fn(async () =>
      createGraphQlResponse({
        repository: {
          discussion: {
            comments: { nodes: [recentUnrelated] },
          },
        },
        focusedComment,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await getDiscussionComments("owner", "repo", 42, "token", {
      limit: 6,
      currentCommentNodeId: "reply-current",
    });

    expect(result.map((comment) => comment.id)).toEqual([
      "parent-old",
      "reply-earlier",
      "reply-current",
    ]);
    expect(result.map((comment) => comment.id)).not.toContain(
      "recent-unrelated",
    );

    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(request.query).toContain("focusedComment: node");
    expect(request.query).toContain("replyTo");
    expect(request.variables.currentCommentNodeId).toBe("reply-current");
  });

  it("keeps the parent plus newest replies when a focused thread exceeds the limit", async () => {
    const parent = createComment("parent", "2026-01-01T00:00:00.000Z");
    const replies = Array.from({ length: 5 }, (_, index) =>
      createComment(
        `reply-${index + 1}`,
        `2026-01-0${index + 2}T00:00:00.000Z`,
      ),
    );
    parent.replies = { nodes: replies };
    const currentReply = replies.at(-1)!;

    const fetchMock = vi.fn(async () =>
      createGraphQlResponse({
        repository: { discussion: { comments: { nodes: [] } } },
        focusedComment: { ...currentReply, replyTo: parent },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await getDiscussionComments("owner", "repo", 42, "token", {
      limit: 3,
      currentCommentNodeId: currentReply.id,
    });

    expect(result.map((comment) => comment.id)).toEqual([
      "parent",
      "reply-4",
      "reply-5",
    ]);
  });

  it("uses recent global context for a focused top-level comment", async () => {
    const previous = createComment("previous", "2026-07-10T00:00:00.000Z");
    const current = createComment("current", "2026-07-11T00:00:00.000Z", {
      replyTo: null,
    });
    const fetchMock = vi.fn(async () =>
      createGraphQlResponse({
        repository: {
          discussion: { comments: { nodes: [previous, current] } },
        },
        focusedComment: current,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await getDiscussionComments("owner", "repo", 42, "token", {
      limit: 2,
      currentCommentNodeId: current.id,
    });

    expect(result.map((comment) => comment.id)).toEqual([
      "previous",
      "current",
    ]);
  });
});
