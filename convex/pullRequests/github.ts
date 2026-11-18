import { RESERVATION_QUOTA_WEIGHT } from "../_ai/config";
import { fetchGitHubAppJsonWithRetry } from "../github/helpers";
import type { VerifiedRepositoryAccess } from "../github/repositoryIdentity";
import type { ChangedFile } from "./review";
import {
  addedLines,
  hasReviewablePatch,
  safePath,
  windowChangedSource,
} from "./review";
import { ReviewContextLimitError, runReviewRequest } from "./errors";

export type PullRequest = {
  id: number;
  number: number;
  state: string;
  draft: boolean;
  title: string;
  body: string | null;
  user: { login: string; type?: string };
  head: { sha: string };
  base: { sha: string; repo: { id: number } };
  changed_files: number;
};
export class PullRequestSizeLimitError extends Error {}
/** The whole diff is too large for one review; batches may still cover it. */
export class PullRequestDiffBudgetError extends PullRequestSizeLimitError {}
export function isBotPullRequestAuthor(author: PullRequest["user"]): boolean {
  return author.type?.toLowerCase() === "bot" || /\[bot\]$/i.test(author.login);
}
const sha = (s: unknown): s is string =>
  typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
export function validPullRequest(
  pr: PullRequest,
  access: VerifiedRepositoryAccess,
  number: number,
): boolean {
  return (
    Number.isSafeInteger(pr.id) &&
    pr.id > 0 &&
    pr.number === number &&
    pr.base?.repo?.id === access.githubRepositoryId &&
    sha(pr.head?.sha) &&
    sha(pr.base?.sha) &&
    typeof pr.title === "string" &&
    (pr.body === null || typeof pr.body === "string") &&
    typeof pr.user?.login === "string" &&
    typeof pr.draft === "boolean"
  );
}
// A review read that fails discards the batches already paid for, so a brief
// GitHub outage gets more attempts than the default of two.
const REVIEW_READ_ATTEMPTS = 4;
export function root(access: VerifiedRepositoryAccess): string {
  return `https://api.github.com/repos/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.repo)}`;
}
export function readReviewJson<T>(
  access: VerifiedRepositoryAccess,
  path: string,
  operation: string,
): Promise<T> {
  return runReviewRequest({ operation }, () =>
    fetchGitHubAppJsonWithRetry<T>(
      `${root(access)}${path}`,
      access.token,
      operation,
      { maxAttempts: REVIEW_READ_ATTEMPTS },
    ),
  );
}
export async function getPullRequest(
  access: VerifiedRepositoryAccess,
  number: number,
): Promise<PullRequest> {
  const pr = await readReviewJson<PullRequest>(
    access,
    `/pulls/${number}`,
    "Read pull request",
  );
  if (!validPullRequest(pr, access, number))
    throw new Error("Pull request identity is invalid");
  return pr;
}
/** Open pull requests, the most recently updated first. */
export async function listOpenPullRequests(
  access: VerifiedRepositoryAccess,
): Promise<Array<PullRequest & { updated_at: string }>> {
  const pulls = await readReviewJson<
    Array<PullRequest & { updated_at: string }>
  >(
    access,
    "/pulls?state=open&sort=updated&direction=desc&per_page=30",
    "List open pull requests",
  );
  if (!Array.isArray(pulls)) throw new Error("Open pull requests are invalid");
  return pulls;
}
// Every group is a full model review, so bound the total before any spend.
const MAX_REVIEW_FILES = 300;
export const BATCH_REVIEW_THRESHOLD = 60;
const REVIEW_BATCH_FILES = 16;
export const REVIEW_DIFF_BUDGET = 100_000;
// A batch's diff shares the review conversation with the source the reviewer
// reads, so several diffs are grouped only up to this size.
const REVIEW_GROUP_DIFF_BUDGET = 40_000;
const DIFF_LIMIT_MESSAGE =
  "Pull request diff exceeds the review budget; split this PR";

/**
 * The diff of one pinned commit pair, read from the compare API so a review
 * keeps reviewing the commit it started on even after newer pushes.
 * `pr.head.sha` and `pr.base.sha` are that pair, not the live PR.
 */
export async function snapshot(
  access: VerifiedRepositoryAccess,
  pr: Pick<PullRequest, "head" | "base">,
  _verificationOnly = false,
  options?: { page: number } | { findingPaths: ReadonlySet<string> },
): Promise<{
  files: ChangedFile[];
  baseSha: string;
  headSha: string;
  changedFiles: number;
}> {
  if (!sha(pr.head.sha) || !sha(pr.base.sha))
    throw new Error("Pull request diff is incomplete");
  const comparison = await readReviewJson<{
    merge_base_commit?: { sha: string };
    files?: ChangedFile[];
  }>(
    access,
    `/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`,
    "Read pull request diff",
  );
  const rows = comparison.files;
  const mergeBase = comparison.merge_base_commit?.sha;
  if (!sha(mergeBase))
    throw new Error("Pull request merge base is unavailable");
  if (!Array.isArray(rows)) throw new Error("Pull request diff is incomplete");
  if (rows.length < 1)
    throw new PullRequestSizeLimitError(
      "Review requires at least one changed file",
    );
  // The compare API lists at most 300 files.
  if (rows.length >= MAX_REVIEW_FILES)
    throw new PullRequestSizeLimitError(
      "Review covers at most 300 changed files; split this PR for complete coverage",
    );
  const all: ChangedFile[] = [];
  const seen = new Set<string>();
  for (const file of rows) {
    if (
      !file ||
      typeof file.filename !== "string" ||
      !safePath(file.filename) ||
      seen.has(file.filename) ||
      (file.previous_filename !== undefined &&
        (typeof file.previous_filename !== "string" ||
          !safePath(file.previous_filename))) ||
      typeof file.status !== "string" ||
      !Number.isSafeInteger(file.additions) ||
      file.additions < 0 ||
      !Number.isSafeInteger(file.deletions) ||
      file.deletions < 0 ||
      (file.patch !== undefined &&
        (typeof file.patch !== "string" ||
          addedLines(file.patch).size !== file.additions))
    )
      throw new Error("Pull request diff is incomplete");
    seen.add(file.filename);
    all.push({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      ...(file.previous_filename !== undefined
        ? { previous_filename: file.previous_filename }
        : {}),
      ...(file.patch !== undefined ? { patch: file.patch } : {}),
    });
  }
  const batchPage = options && "page" in options ? options.page : undefined;
  const findingPaths =
    options && "findingPaths" in options ? options.findingPaths : undefined;
  let files = all;
  if (batchPage !== undefined) {
    if (
      !Number.isSafeInteger(batchPage) ||
      batchPage < 1 ||
      batchPage > Math.ceil(all.length / REVIEW_BATCH_FILES)
    )
      throw new Error("Pull request diff is incomplete");
    files = all.slice(
      (batchPage - 1) * REVIEW_BATCH_FILES,
      batchPage * REVIEW_BATCH_FILES,
    );
  } else if (findingPaths)
    files = all.filter((file) => findingPaths.has(file.filename));
  else if (
    all.length > BATCH_REVIEW_THRESHOLD ||
    // Measured as GitHub returned it, before transport metadata is dropped.
    JSON.stringify(rows).length > REVIEW_DIFF_BUDGET
  )
    throw new PullRequestDiffBudgetError(DIFF_LIMIT_MESSAGE);
  return {
    files,
    headSha: pr.head.sha,
    baseSha: mergeBase,
    changedFiles: all.length,
  };
}

/**
 * Paths whose PR diff may differ from an earlier review: files changed on the
 * head since then, plus files the base changed when a merge of the base branch
 * moved the merge base forward. Returns null when the whole PR must be
 * reviewed again: after a force push, a retargeted or rewound base, a
 * truncated comparison, or any failure to compare.
 */
export async function changedSince(
  access: VerifiedRepositoryAccess,
  since: { headSha: string; mergeBaseSha: string },
  pr: PullRequest,
): Promise<{
  paths: Set<string>;
  mergeBaseSha: string;
  // Files of the PR diff the earlier review saw, or null if unknown.
  previous: Set<string> | null;
} | null> {
  if (!sha(since.headSha) || !sha(since.mergeBaseSha)) return null;
  const compare = (from: string, to: string) =>
    readReviewJson<{
      status: string;
      merge_base_commit?: { sha: string };
      files?: Array<{ filename: string; previous_filename?: string }>;
    }>(
      access,
      `/compare/${from}...${to}?per_page=1`,
      "Read changes since the last review",
    );
  const changedFiles = (comparison: Awaited<ReturnType<typeof compare>>) => {
    if (
      (comparison.status !== "ahead" && comparison.status !== "identical") ||
      !Array.isArray(comparison.files) ||
      comparison.files.length >= MAX_REVIEW_FILES
    )
      return null;
    const paths: string[] = [];
    for (const file of comparison.files) {
      if (typeof file?.filename !== "string") return null;
      paths.push(file.filename);
      if (typeof file.previous_filename === "string")
        paths.push(file.previous_filename);
    }
    return paths;
  };
  try {
    const head = changedFiles(await compare(since.headSha, pr.head.sha));
    if (!head) return null;
    const mergeBase = (await compare(pr.base.sha, pr.head.sha))
      .merge_base_commit?.sha;
    if (!sha(mergeBase)) return null;
    const base =
      mergeBase === since.mergeBaseSha
        ? []
        : changedFiles(await compare(since.mergeBaseSha, mergeBase));
    if (!base) return null;
    const earlier = await compare(since.mergeBaseSha, since.headSha)
      .then(changedFiles)
      .catch(() => null);
    return {
      paths: new Set([...head, ...base]),
      mergeBaseSha: mergeBase,
      previous: earlier ? new Set(earlier) : null,
    };
  } catch {
    return null;
  }
}

// Production reviews of up to 60 files used a median of about 90k provider
// tokens. The hold is in quota tokens, so it scales with the model's weight.
export const REVIEW_BATCH_TOKEN_ESTIMATE = 100_000 * RESERVATION_QUOTA_WEIGHT;

export function minimumReviewBatches(changedFiles: number): number {
  return Math.ceil(changedFiles / REVIEW_BATCH_FILES);
}

export function splitReviewDiff(files: ChangedFile[]): ChangedFile[][] {
  const groups: ChangedFile[][] = [];
  let group: ChangedFile[] = [];
  let size = 2;
  let patched = false;
  for (const changed of files) {
    // One oversized diff, usually a lockfile or generated file, is reported as
    // uncovered instead of failing the review of every other file.
    const { patch, ...rest } = changed;
    const file =
      patch !== undefined &&
      JSON.stringify(changed).length + 2 > REVIEW_DIFF_BUDGET
        ? rest
        : changed;
    const fileSize = JSON.stringify(file).length;
    if (fileSize + 2 > REVIEW_DIFF_BUDGET)
      throw new PullRequestSizeLimitError(DIFF_LIMIT_MESSAGE);
    const hasPatch = "patch" in file && file.patch !== undefined;
    // Files without a diff never open a batch of their own.
    if (patched && hasPatch && size + 1 + fileSize > REVIEW_GROUP_DIFF_BUDGET) {
      groups.push(group);
      group = [];
      size = 2;
      patched = false;
    }
    size += fileSize + (group.length ? 1 : 0);
    patched ||= hasPatch;
    group.push(file);
  }
  if (group.length) groups.push(group);
  return groups;
}

// A changed file over the 40 KB limit is fetched up to this size, then shown
// to the reviewer only around its diff.
const LARGE_CHANGED_FILE_BYTES = 400_000;
const WINDOWED_CHANGED_FILE_BYTES = 24_000;

export async function readFile(
  access: VerifiedRepositoryAccess,
  path: string,
  ref: string,
  maxBytes = 40_000,
): Promise<string> {
  if (!safePath(path) || !sha(ref))
    throw new Error("Invalid commit-pinned file request");
  const value = await fetchGitHubAppJsonWithRetry<{
    type: string;
    encoding: string;
    content: string;
    size: number;
  }>(
    `${root(access)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
    access.token,
    "Read review context",
    { maxAttempts: REVIEW_READ_ATTEMPTS },
  );
  if (
    value.type !== "file" ||
    value.encoding !== "base64" ||
    typeof value.content !== "string" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  )
    throw new Error("Review context is unavailable, binary or too large");
  if (value.size > maxBytes || value.content.length > maxBytes * 1.5)
    throw new ReviewContextLimitError();
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(value.content.replace(/\s/g, "")), (c) =>
        c.charCodeAt(0),
      ),
    );
  } catch {
    throw new Error("Review source is not valid UTF-8");
  }
  if (content.includes("\0") || content.length > maxBytes)
    throw new Error("Review context is binary or too large");
  return content;
}
/**
 * Reads commit-pinned review source. A changed file over the 40 KB limit, read
 * at head with its diff, is shown around that diff instead of being skipped.
 * Files of roughly 20,000 lines or more cannot be windowed within the limit
 * and stay unreviewed.
 */
export async function readReviewFile(
  access: VerifiedRepositoryAccess,
  path: string,
  ref: string,
  changed?: ChangedFile,
  onWindowed?: () => void,
  // Evidence saved before 24 KB windowing keeps the earlier 40 KB rule.
  windowFrom = WINDOWED_CHANGED_FILE_BYTES,
): Promise<string> {
  if (!changed?.patch || !hasReviewablePatch(changed))
    return await readFile(access, path, ref);
  const content = await readFile(access, path, ref, LARGE_CHANGED_FILE_BYTES);
  const bytes = new TextEncoder().encode(content).length;
  // Medium files are also shown around their diff, so one review can afford
  // the source of every changed file instead of a few whole ones.
  if (bytes <= windowFrom) return content;
  const windowed = windowChangedSource(content, changed.patch);
  if (windowed !== null) {
    onWindowed?.();
    return windowed;
  }
  if (bytes <= 40_000) return content;
  throw new ReviewContextLimitError();
}

export async function treePaths(
  access: VerifiedRepositoryAccess,
  ref: string,
): Promise<string[]> {
  const value = await readReviewJson<{
    truncated: boolean;
    tree: Array<{ type: string; path: string }>;
  }>(access, `/git/trees/${ref}?recursive=1`, "Read review source paths");
  if (
    value.truncated ||
    !Array.isArray(value.tree) ||
    value.tree.length > 30_000
  )
    throw new Error("Repository tree exceeds the review context limit");
  return value.tree
    .filter((x) => x.type === "blob" && safePath(x.path))
    .map((x) => x.path);
}

type ReviewThreadPage = {
  errors?: unknown[];
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: { hasNextPage?: boolean };
          nodes?: Array<{
            isResolved?: boolean;
            comments?: {
              nodes?: Array<{ author?: { login?: string } | null }>;
            };
          }>;
        };
      };
    };
  };
};

/**
 * Whether a review thread Gitdog started is still unresolved. An answer that
 * cannot be read completely counts as unresolved, so it never approves.
 */
export type DiscussionEntry = {
  author: string;
  kind: "comment" | "review" | "thread";
  text: string;
  path?: string;
};

// The conversation shown to a reviewer is bounded: newest first, each entry
// trimmed, and the whole within this many characters.
const DISCUSSION_ENTRY_CHARS = 1_200;
const DISCUSSION_CHARS = 8_000;

function discussionText(body: unknown): string {
  return typeof body === "string"
    ? body
        .replace(/<!--[\s\S]*?(-->|$)/g, " ")
        .replace(/<details[\s\S]*?(<\/details>|$)/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

/**
 * What people and other reviewers said on the pull request: its comments,
 * review summaries and unresolved review threads, without Gitdog's own posts
 * or commands to it. A reviewer checks whether the change does what they
 * asked; the text is untrusted data.
 */
export async function readDiscussion(
  access: VerifiedRepositoryAccess,
  number: number,
  isGitdog: (login: string) => boolean,
): Promise<DiscussionEntry[]> {
  type Item = { at: string; entry: DiscussionEntry };
  const items: Item[] = [];
  const add = (
    at: unknown,
    login: unknown,
    kind: DiscussionEntry["kind"],
    body: unknown,
    path?: unknown,
  ) => {
    if (typeof login !== "string" || isGitdog(login)) return;
    const text = discussionText(body);
    if (text.length < 20 || /^@gitdog/i.test(text)) return;
    items.push({
      at: typeof at === "string" ? at : "",
      entry: {
        author: login.replace(/\[bot\]$/i, ""),
        kind,
        text: text.slice(0, DISCUSSION_ENTRY_CHARS),
        ...(typeof path === "string" ? { path } : {}),
      },
    });
  };
  const [comments, reviews, threads] = await Promise.all([
    readReviewJson<
      Array<{ created_at?: string; user?: { login?: string }; body?: string }>
    >(
      access,
      `/issues/${number}/comments?per_page=100`,
      "Read pull request comments",
    ),
    readReviewJson<
      Array<{ submitted_at?: string; user?: { login?: string }; body?: string }>
    >(
      access,
      `/pulls/${number}/reviews?per_page=100`,
      "Read pull request reviews",
    ),
    runReviewRequest({ operation: "Read review threads" }, () =>
      fetchGitHubAppJsonWithRetry<{
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                nodes?: Array<{
                  isResolved?: boolean;
                  path?: string;
                  comments?: {
                    nodes?: Array<{
                      createdAt?: string;
                      body?: string;
                      author?: { login?: string };
                    }>;
                  };
                }>;
              };
            };
          };
        };
      }>(
        "https://api.github.com/graphql",
        access.token,
        "Read review threads",
        {
          method: "POST",
          maxAttempts: REVIEW_READ_ATTEMPTS,
          jsonBody: {
            query:
              "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved path comments(first:1){nodes{createdAt body author{login}}}}}}}}",
            variables: { owner: access.owner, repo: access.repo, number },
          },
        },
      ),
    ),
  ]);
  for (const c of Array.isArray(comments) ? comments : [])
    add(c?.created_at, c?.user?.login, "comment", c?.body);
  for (const r of Array.isArray(reviews) ? reviews : [])
    add(r?.submitted_at, r?.user?.login, "review", r?.body);
  for (const t of threads.data?.repository?.pullRequest?.reviewThreads?.nodes ??
    []) {
    if (t?.isResolved !== false) continue;
    const first = t.comments?.nodes?.[0];
    add(first?.createdAt, first?.author?.login, "thread", first?.body, t.path);
  }
  const result: DiscussionEntry[] = [];
  let size = 0;
  for (const { entry } of items.sort((a, b) => b.at.localeCompare(a.at))) {
    size += entry.text.length;
    if (size > DISCUSSION_CHARS) break;
    result.push(entry);
  }
  return result;
}

/**
 * Whether any review thread on the pull request is unresolved, whoever opened
 * it: an approval must not talk over a reviewer's open request.
 */
export async function hasUnresolvedThreads(
  access: VerifiedRepositoryAccess,
  number: number,
): Promise<boolean> {
  const page = await runReviewRequest(
    { operation: "Read review threads" },
    () =>
      fetchGitHubAppJsonWithRetry<ReviewThreadPage>(
        "https://api.github.com/graphql",
        access.token,
        "Read review threads",
        {
          method: "POST",
          maxAttempts: REVIEW_READ_ATTEMPTS,
          jsonBody: {
            query:
              "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:1){nodes{author{login}}}}}}}}",
            variables: { owner: access.owner, repo: access.repo, number },
          },
        },
      ),
  );
  const threads = page.data?.repository?.pullRequest?.reviewThreads;
  if (
    page.errors?.length ||
    !threads?.nodes ||
    threads.pageInfo?.hasNextPage !== false
  )
    return true;
  return threads.nodes.some((thread) => thread.isResolved !== true);
}

/**
 * Resolve every unresolved review thread Gitdog started on a PR, up to one
 * page, and return how many were resolved. Resolving twice is harmless.
 */
export async function resolveOwnThreads(
  access: VerifiedRepositoryAccess,
  number: number,
  botLogin: string,
): Promise<{ open: number; resolved: number }> {
  const page = await fetchGitHubAppJsonWithRetry<{
    errors?: unknown[];
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: Array<{
              id?: string;
              isResolved?: boolean;
              comments?: {
                nodes?: Array<{ author?: { login?: string } | null }>;
              };
            }>;
          };
        };
      };
    };
  }>("https://api.github.com/graphql", access.token, "Read review threads", {
    method: "POST",
    maxAttempts: REVIEW_READ_ATTEMPTS,
    jsonBody: {
      query:
        "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{author{login}}}}}}}}",
      variables: { owner: access.owner, repo: access.repo, number },
    },
  });
  if (page.errors?.length || !page.data?.repository?.pullRequest)
    throw new Error("Review threads could not be read");
  const login = (value: string) => value.toLowerCase().replace(/\[bot\]$/, "");
  const own = login(botLogin);
  if (!own) return { open: 0, resolved: 0 };
  const open = (page.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [])
    .filter(
      (thread) =>
        thread.isResolved !== true &&
        typeof thread.id === "string" &&
        login(thread.comments?.nodes?.[0]?.author?.login ?? "") === own,
    )
    .map((thread) => thread.id as string);
  // GraphQL reports a refused mutation in the body, so count confirmed ones.
  let resolved = 0;
  for (const id of open) {
    const result = await fetchGitHubAppJsonWithRetry<{
      data?: { resolveReviewThread?: { thread?: { isResolved?: boolean } } };
    }>(
      "https://api.github.com/graphql",
      access.token,
      "Resolve review thread",
      {
        method: "POST",
        jsonBody: {
          query:
            "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}",
          variables: { id },
        },
      },
    );
    if (result.data?.resolveReviewThread?.thread?.isResolved === true)
      resolved++;
  }
  return { open: open.length, resolved };
}
