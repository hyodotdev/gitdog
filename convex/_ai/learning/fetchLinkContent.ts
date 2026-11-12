/**
 * Fetch content from links (GitHub issue comments)
 *
 * Note: Discussion comments are not supported because GitHub's GraphQL API
 * doesn't provide a straightforward way to fetch a comment by its numeric ID.
 * The node ID format is not documented and cannot be constructed from the URL.
 */

export interface GitHubCommentInfo {
  type: "issue_comment" | "unknown";
  owner?: string;
  repo?: string;
  issueNumber?: number;
  commentId?: string;
}

const GITHUB_COMMENT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Parse a GitHub URL to extract comment information
 */
export function parseGitHubUrl(url: string): GitHubCommentInfo {
  // GitHub issue comment: https://github.com/{owner}/{repo}/issues/{num}#issuecomment-{id}
  const issueCommentMatch = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)#issuecomment-(\d+)/,
  );
  if (issueCommentMatch) {
    return {
      type: "issue_comment",
      owner: issueCommentMatch[1],
      repo: issueCommentMatch[2],
      issueNumber: parseInt(issueCommentMatch[3]),
      commentId: issueCommentMatch[4],
    };
  }

  // Discussion comments are not supported - would require pagination through
  // all comments to find by databaseId, which is inefficient
  return { type: "unknown" };
}

/**
 * Fetch GitHub issue comment content
 */
export async function fetchIssueComment(
  owner: string,
  repo: string,
  commentId: string,
  accessToken: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github.v3+json",
        },
        signal: AbortSignal.timeout(GITHUB_COMMENT_REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      console.error(
        `[fetchIssueComment] Failed to fetch: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const data = (await response.json()) as { body?: string };
    return data.body || null;
  } catch {
    console.error("[fetchIssueComment] Failed");
    return null;
  }
}

/**
 * Extract URLs from text
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  return text.match(urlRegex) || [];
}

/**
 * Check if URL is a GitHub comment URL that we can fetch
 */
export function isGitHubCommentUrl(url: string): boolean {
  const info = parseGitHubUrl(url);
  return info.type === "issue_comment";
}

/**
 * Fetch content from a URL (supports GitHub issue comments)
 */
export async function fetchLinkContent(
  url: string,
  accessToken: string,
): Promise<{ content: string | null; type: GitHubCommentInfo["type"] }> {
  const info = parseGitHubUrl(url);

  if (
    info.type === "issue_comment" &&
    info.owner &&
    info.repo &&
    info.commentId
  ) {
    const content = await fetchIssueComment(
      info.owner,
      info.repo,
      info.commentId,
      accessToken,
    );
    return { content, type: "issue_comment" };
  }

  // For unknown URLs, we don't fetch (to avoid security issues)
  return { content: null, type: "unknown" };
}
