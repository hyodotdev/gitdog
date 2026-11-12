import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findIssueCommentByExecutionMarker,
  getIssueComments,
} from "../../../convex/github/helpers";

type IssueComment = {
  id: number;
  body: string;
  user: { login: string; type: string };
  author_association: string;
  created_at: string;
};

function createComment(id: number): IssueComment {
  return {
    id,
    body: `Comment ${id}`,
    user: { login: `user-${id}`, type: "User" },
    author_association: "NONE",
    created_at: new Date(Date.UTC(2026, 0, id)).toISOString(),
  };
}

function createResponse(comments: IssueComment[], link?: string): Response {
  return new Response(JSON.stringify(comments), {
    status: 200,
    headers: link ? { Link: link } : undefined,
  });
}

describe("getIssueComments", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalSlug: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSlug = process.env.GITHUB_APP_SLUG;
    process.env.GITHUB_APP_SLUG = "gitdogbot";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSlug === undefined) delete process.env.GITHUB_APP_SLUG;
    else process.env.GITHUB_APP_SLUG = originalSlug;
    vi.restoreAllMocks();
  });

  it("returns the latest comments oldest-to-newest on a single page", async () => {
    const comments = Array.from({ length: 10 }, (_, index) =>
      createComment(index + 1),
    );
    const fetchMock = vi.fn(async () => createResponse(comments));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await getIssueComments("owner", "repo", 42, "token", {
      limit: 6,
    });

    expect(result.map((comment) => comment.id)).toEqual([5, 6, 7, 8, 9, 10]);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toContain("per_page=100");
    expect(requestedUrl).not.toContain("sort=");
    expect(requestedUrl).not.toContain("direction=");
  });

  it("follows the last-page link instead of using the oldest page", async () => {
    const lastPageUrl =
      "https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=3";
    const link = `<https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=2>; rel="next", <${lastPageUrl}>; rel="last"`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createResponse([createComment(1), createComment(2)], link),
      )
      .mockResolvedValueOnce(
        createResponse([
          createComment(201),
          createComment(202),
          createComment(203),
        ]),
      );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await getIssueComments("owner", "repo", 42, "token", {
      limit: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(lastPageUrl);
    expect(result.map((comment) => comment.id)).toEqual([201, 202, 203]);
  });

  it("fills a partial last page from the preceding page", async () => {
    const lastPageUrl =
      "https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=2";
    const link = `<${lastPageUrl}>; rel="next", <${lastPageUrl}>; rel="last"`;
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      createComment(index + 1),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createResponse(firstPage, link))
      .mockResolvedValueOnce(createResponse([createComment(101)]));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await getIssueComments("owner", "repo", 42, "token", {
      limit: 6,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.map((comment) => comment.id)).toEqual([
      96, 97, 98, 99, 100, 101,
    ]);
  });

  it("fetches page before last when the partial last page is beyond page two", async () => {
    const lastPageUrl =
      "https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=3";
    const link = `<https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=2>; rel="next", <${lastPageUrl}>; rel="last"`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createResponse([createComment(1), createComment(2)], link),
      )
      .mockResolvedValueOnce(createResponse([createComment(201)]))
      .mockResolvedValueOnce(
        createResponse([197, 198, 199, 200].map(createComment)),
      );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await getIssueComments("owner", "repo", 42, "token", {
      limit: 5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("page=2");
    expect(result.map((comment) => comment.id)).toEqual([
      197, 198, 199, 200, 201,
    ]);
  });

  it("leaves the five previous comments oldest-to-newest after filtering the current comment", async () => {
    const comments = [95, 96, 97, 98, 99, 100].map(createComment);
    const fetchMock = vi.fn(async () => createResponse(comments));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const fetched = await getIssueComments("owner", "repo", 42, "token", {
      limit: 6,
    });
    const previousComments = fetched
      .filter((comment) => comment.id !== 100)
      .slice(-5);

    expect(previousComments.map((comment) => comment.id)).toEqual([
      95, 96, 97, 98, 99,
    ]);
  });

  it("accepts an execution marker only from the configured GitHub App bot", async () => {
    const marker =
      "<!-- gitdog-execution:00000000-0000-4000-8000-000000000000 -->";
    const forged = createComment(1);
    forged.body = marker;
    const owned = createComment(2);
    owned.body = marker;
    owned.user = { login: "gitdogbot[bot]", type: "Bot" };
    globalThis.fetch = vi.fn(async () =>
      createResponse([forged, owned]),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      findIssueCommentByExecutionMarker("owner", "repo", 42, marker, "token"),
    ).resolves.toEqual({ commentId: 2, exhaustive: true });
  });

  it("reports a bounded marker scan as indeterminate instead of absent", async () => {
    const lastPageUrl =
      "https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=51";
    const link = `<${lastPageUrl}>; rel="last"`;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return createResponse(
        [createComment(page * 100)],
        page === 1 ? link : undefined,
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      findIssueCommentByExecutionMarker(
        "owner",
        "repo",
        42,
        "<!-- gitdog-execution:00000000-0000-4000-8000-000000000000 -->",
        "token",
      ),
    ).resolves.toEqual({ commentId: null, exhaustive: false });
    expect(fetchMock).toHaveBeenCalledTimes(51);
  });

  it("fails marker reconciliation closed without a configured bot identity", async () => {
    delete process.env.GITHUB_APP_SLUG;
    await expect(
      findIssueCommentByExecutionMarker(
        "owner",
        "repo",
        42,
        "<!-- gitdog-execution:00000000-0000-4000-8000-000000000000 -->",
        "token",
      ),
    ).rejects.toThrow("GitHub App identity is not configured");
  });
});
