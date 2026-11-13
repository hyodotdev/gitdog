import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE } from "./chunkBudget";

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
