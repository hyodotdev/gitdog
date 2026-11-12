import { fetchGitHubAppJsonWithRetry } from "../github/helpers";
import type { VerifiedRepositoryAccess } from "../github/repositoryIdentity";
import type { ChangedFile } from "./review";
import { addedLines, safePath } from "./review";
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
// Every group is a full model review, so bound the total before any spend.
const MAX_REVIEW_FILES = 300;
export const BATCH_REVIEW_THRESHOLD = 60;
const REVIEW_BATCH_FILES = 16;
const REVIEW_DIFF_BUDGET = 100_000;
// A batch's diff shares the review conversation with the source the reviewer
// reads, so several diffs are grouped only up to this size.
const REVIEW_GROUP_DIFF_BUDGET = 40_000;
const DIFF_LIMIT_MESSAGE =
  "Pull request diff exceeds the review budget; split this PR";

export async function snapshot(
  access: VerifiedRepositoryAccess,
  pr: PullRequest,
  verificationOnly = false,
  options?: { page: number } | { findingPaths: ReadonlySet<string> },
): Promise<{ files: ChangedFile[]; baseSha: string; headSha: string }> {
  if (!Number.isSafeInteger(pr.changed_files) || pr.changed_files < 1)
    throw new PullRequestSizeLimitError(
      "Review requires at least one changed file",
    );
  if (pr.changed_files > MAX_REVIEW_FILES)
    throw new PullRequestSizeLimitError(
      "Review covers at most 300 changed files; split this PR for complete coverage",
    );
  const batchPage = options && "page" in options ? options.page : undefined;
  const batched =
    batchPage !== undefined || pr.changed_files > BATCH_REVIEW_THRESHOLD;
  const findingPaths =
    options && "findingPaths" in options ? options.findingPaths : undefined;
  const pageSize = batchPage === undefined ? 100 : REVIEW_BATCH_FILES;
  if (
    batchPage !== undefined &&
    (!Number.isSafeInteger(batchPage) ||
      batchPage < 1 ||
      batchPage > Math.ceil(pr.changed_files / pageSize))
  )
    throw new Error("Pull request diff is incomplete");
  const first = batchPage ?? 1;
  const last = batchPage ?? Math.ceil(pr.changed_files / pageSize);
  const files: ChangedFile[] = [];
  const seen = new Set<string>();
  for (let page = first; page <= last; page++) {
    const rows = await readReviewJson<ChangedFile[]>(
      access,
      `/pulls/${pr.number}/files?per_page=${pageSize}${batched ? `&page=${page}` : ""}`,
      batched
        ? `Read pull request diff (page ${page})`
        : "Read pull request diff",
    );
    if (
      !Array.isArray(rows) ||
      rows.length !==
        Math.min(pageSize, pr.changed_files - (page - 1) * pageSize)
    )
      throw new Error("Pull request diff is incomplete");
    if (
      !batched &&
      !findingPaths &&
      JSON.stringify(rows).length > REVIEW_DIFF_BUDGET
    )
      throw new PullRequestDiffBudgetError(DIFF_LIMIT_MESSAGE);
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
      if (findingPaths && !findingPaths.has(file.filename)) continue;
      files.push({
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
  }
  const comparison = await readReviewJson<{
    merge_base_commit: { sha: string };
  }>(
    access,
    `/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`,
    "Read merge base",
  );
  if (!sha(comparison.merge_base_commit?.sha))
    throw new Error("Pull request merge base is unavailable");
  const after = await getPullRequest(access, pr.number);
  if (
    after.state !== (verificationOnly ? pr.state : "open") ||
    after.draft ||
    after.head.sha !== pr.head.sha ||
    after.base.sha !== pr.base.sha ||
    after.changed_files !== pr.changed_files
  )
    throw new Error("Pull request changed while reading its diff");
  return {
    files,
    headSha: pr.head.sha,
    baseSha: comparison.merge_base_commit.sha,
  };
}

// Production reviews of up to 60 files used a median of about 90k tokens.
export const REVIEW_BATCH_TOKEN_ESTIMATE = 100_000;

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

export async function readFile(
  access: VerifiedRepositoryAccess,
  path: string,
  ref: string,
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
  if (value.size > 40_000 || value.content.length > 60_000)
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
  if (content.includes("\0") || content.length > 40_000)
    throw new Error("Review context is binary or too large");
  return content;
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
