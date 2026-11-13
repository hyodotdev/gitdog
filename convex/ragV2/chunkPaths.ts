import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE } from "./chunkBudget";

/**
 * Bump whenever parsing, normalization, chunk IDs or searchable text change,
 * so the next pass of every repository rebuilds all paths.
 */
export const RAG_CHUNKER_VERSION = 1;

type ChunkLayoutState = Pick<
  Doc<"repositories">,
  "ragChunkLayout" | "ragChunkerVersion" | "ragFullRebuildRequested"
>;

/** Whether chunks are kept per path, so readers ignore generation numbers. */
export function usesPathChunkLayout(repository: ChunkLayoutState): boolean {
  return repository.ragChunkLayout === "path_v1";
}

/**
 * Whether a pass about to be claimed may visit only the paths flagged as
 * changed. Decided once per pass; the pass then follows ragPassMode.
 */
export function canRechunkChangedPathsOnly(
  repository: ChunkLayoutState,
): boolean {
  return (
    usesPathChunkLayout(repository) &&
    repository.ragChunkerVersion === RAG_CHUNKER_VERSION &&
    repository.ragFullRebuildRequested !== true
  );
}

/** The pinned mode of the claimed pass; passes from before pinning are full. */
export function isChangedPathsPass(
  repository: Pick<Doc<"repositories">, "ragPassMode">,
): boolean {
  return repository.ragPassMode === "changed";
}

/**
 * Delete up to `budget` chunks of one repository path. Chunks are replaced
 * per path, so a path either keeps the chunks of its previous content or
 * gets a complete new set; `done` is false while older chunks remain.
 */
export async function deleteChunksForPath(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
  path: string,
  budget: number = RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE,
): Promise<{ deleted: number; done: boolean }> {
  const limit = Math.max(0, Math.floor(budget));
  const chunks = await ctx.db
    .query("repoChunks")
    .withIndex("by_repository_and_path", (q) =>
      q.eq("repositoryId", repositoryId).eq("path", path),
    )
    .take(limit + 1);
  const toDelete = chunks.slice(0, limit);
  for (const chunk of toDelete) {
    await ctx.db.delete(chunk._id);
  }
  return { deleted: toDelete.length, done: chunks.length <= limit };
}
