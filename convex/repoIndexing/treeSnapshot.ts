import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE = 40;
export const REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_PAGES = 64;
export const REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_BYTES = 2 * 1024 * 1024;
export const REPOSITORY_TREE_SNAPSHOT_CLEANUP_BATCH_SIZE = 50;
export const REPOSITORY_TREE_SNAPSHOT_CLEANUP_STALE_MS = 15 * 60 * 1000;
export const REPOSITORY_TREE_TRAVERSAL_ITEMS_PER_ACTION = 128;
export const REPOSITORY_TREE_TRAVERSAL_MAX_REQUESTS = 25_000;
export const REPOSITORY_TREE_TRAVERSAL_MAX_ITEMS = 500_000;

export type RepositoryTreeSnapshotFile = {
  path: string;
  sha: string;
  size?: number;
};

export type RepositoryTreeSnapshotMetadata = {
  snapshotId: Id<"repoTreeSnapshots">;
  repositoryId: Id<"repositories">;
  indexVersion: number;
  defaultBranch: string;
  commitSha: string;
  treeSha: string;
  totalFiles: number;
  totalPages: number;
};

type RepositoryTreeEntry = {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
};

const EXCLUDED_FILE_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)\.next\//,
  /(^|\/)\.turbo\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)out\//,
  /(^|\/)\.cache\//,
  /(^|\/)\.jest\/cache\//,
  /(^|\/)\.vscode\//,
  /(^|\/)\.idea\//,
  /(^|\/)coverage\//,
  /(^|\/)\.nyc_output\//,
  /(^|\/)\.pytest_cache\//,
  /(^|\/)__pycache__\//,
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.env$/,
  /(^|\/)\.env\.local$/,
  /(^|\/)\.env\.production$/,
  /(^|\/)\.env\.development$/,
  /\.log$/,
  /\.lock$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)Cargo\.lock$/,
  /\.min\.js$/,
  /\.min\.css$/,
  /\.map$/,
  /\.wasm$/,
  /\.dll$/,
  /\.so$/,
  /\.dylib$/,
];

const MAX_INDEXED_FILE_SIZE_BYTES = 1024 * 1024;

export function getIndexableRepositoryFiles(
  tree: ReadonlyArray<RepositoryTreeEntry>,
): Array<RepositoryTreeSnapshotFile> {
  return tree.flatMap((item) => {
    if (
      item.type !== "blob" ||
      (item.size ?? 0) >= MAX_INDEXED_FILE_SIZE_BYTES ||
      EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(item.path))
    ) {
      return [];
    }

    return [{ path: item.path, sha: item.sha, size: item.size }];
  });
}

export function buildRepositoryTreeSnapshotPages(
  files: ReadonlyArray<RepositoryTreeSnapshotFile>,
): Array<Array<RepositoryTreeSnapshotFile>> {
  const pages: Array<Array<RepositoryTreeSnapshotFile>> = [];
  for (
    let offset = 0;
    offset < files.length;
    offset += REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE
  ) {
    pages.push(
      files.slice(offset, offset + REPOSITORY_TREE_SNAPSHOT_PAGE_SIZE),
    );
  }
  return pages;
}

export function getRepositoryTreeSnapshotPagesBytes(
  pages: ReadonlyArray<ReadonlyArray<RepositoryTreeSnapshotFile>>,
): number {
  return new TextEncoder().encode(JSON.stringify(pages)).byteLength;
}

/** Select one append payload that stays far below Convex transaction limits. */
export function getRepositoryTreeSnapshotAppendBatch(
  pages: ReadonlyArray<Array<RepositoryTreeSnapshotFile>>,
  startPageIndex: number,
): Array<Array<RepositoryTreeSnapshotFile>> {
  if (
    !Number.isSafeInteger(startPageIndex) ||
    startPageIndex < 0 ||
    startPageIndex > pages.length
  ) {
    throw new Error("invalid repository tree snapshot append offset");
  }

  const batch: Array<Array<RepositoryTreeSnapshotFile>> = [];
  for (
    let pageIndex = startPageIndex;
    pageIndex < pages.length &&
    batch.length < REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_PAGES;
    pageIndex++
  ) {
    const candidate = [...batch, pages[pageIndex]];
    if (
      getRepositoryTreeSnapshotPagesBytes(candidate) >
      REPOSITORY_TREE_SNAPSHOT_APPEND_MAX_BYTES
    ) {
      if (batch.length === 0) {
        throw new Error("repository tree snapshot page exceeds append budget");
      }
      break;
    }
    batch.push(pages[pageIndex]);
  }

  return batch;
}

/**
 * Mark a detached manifest for bounded deletion and reserve its first cleanup
 * transaction. Scheduling is part of the caller's mutation transaction.
 */
export async function scheduleRepositoryTreeSnapshotCleanup(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  snapshotId?: Id<"repoTreeSnapshots">,
): Promise<void> {
  if (!snapshotId) {
    return;
  }

  const snapshot = await ctx.db.get(snapshotId);
  if (!snapshot) {
    return;
  }

  await ctx.db.patch(snapshotId, {
    status: "deleting",
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(
    0,
    internal.repoIndexing.mutation.continueIndexTreeSnapshotCleanup,
    { snapshotId },
  );
}
