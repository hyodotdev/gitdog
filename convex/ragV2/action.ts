/**
 * RAG V2: chunk-based keyword search with second-stage ranking
 *
 * Pipeline:
 * 1. Parse files into function/class-level chunks and store them
 * 2. BM25 keyword search over the stored chunks
 * 3. Rank the top results by query match, then MMR diversification
 *
 * Gitdog no longer creates embeddings. Function names and continuation
 * arguments that mention embeddings stay unchanged so scheduled work that
 * predates the change still validates.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { normalizeCodeChunksForStorage, parseCodeIntoChunks } from "./parser";
import { isChangedPathsPass } from "./chunkPaths";
import { requireStrictCurrentAiLegalAttestation } from "../_ai/legalAttestation";
import {
  buildRagChunkPublicationBatches,
  getUtf8ByteLength,
  MAX_RAG_PROVIDER_BATCH_ITEMS,
  MAX_RAG_SOURCE_BYTES,
} from "./chunkBudget";

// Type for code chunks
interface CodeChunk {
  chunkId: string;
  path: string;
  language: string;
  code: string;
  retrievalText?: string;
  startLine: number;
  endLine: number;
  symbols: string[];
  imports?: string[];
  exports?: string[];
  signature?: string;
  docstring?: string;
  contentHash: string;
  searchableText: string;
  embedding?: number[];
  embeddingKey?: string;
  embeddingInputMode?: CodeEmbeddingInputMode;
}

interface ChunkSearchFilters {
  language?: string[];
}

interface EmbeddingGenerationResult {
  success: boolean;
  totalChunks: number;
  successCount: number;
  errorCount: number;
}

interface RepositoryFileForEmbedding {
  path: string;
  url: string | null;
  language: string | undefined;
  size: number;
  isText: boolean;
  hasBlob?: boolean;
}

type RagIndexPhase = "files" | "cleanup";

type RagWorkPosition = {
  phase: RagIndexPhase;
  cursor?: string;
  fileOffset: number;
  chunkOffset: number;
};

type RagRetrySchedule =
  | { kind: "source_fetch"; delayMs: number; attempt: number }
  | { kind: "embedding_provider"; delayMs: number; attempt: number }
  | { kind: "embedding_queue"; delayMs: number; attempt: number };

type RagWorkCheckpoint = {
  totalChunks: number;
  successCount: number;
  errorCount: number;
  processedFiles: number;
};

const MAX_SEARCH_FILTER_LANGUAGES = 8;
const FILE_PAGE_SIZE = 8;
// One run covers at most the rest of one file page, bounded by chunk batches
// and wall time, before it checkpoints and schedules its successor.
const RAG_MAX_WORK_UNITS_PER_RUN = 16;
const RAG_RUN_TIME_BUDGET_MS = 60_000;
const RAG_MAX_PATH_DELETE_BATCHES = 64;
const FILE_FETCH_TIMEOUT_MS = 15000;
const RAG_SOURCE_FETCH_RETRY_BASE_DELAY_MS = 15_000;
const RAG_SOURCE_FETCH_RETRY_MAX_DELAY_MS = 5 * 60_000;
const RAG_SOURCE_FETCH_RETRY_MAX_ATTEMPT = 32;

type CodeEmbeddingInputMode = "raw_v1" | "deidentified_v1";

function isStaleRagChunkUpsertError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("stale RAG chunk upsert") ||
      error.message.includes("RAG embedding degradation lost ownership"))
  );
}

class RetryableRagSourceFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableRagSourceFetchError";
  }
}

function isRetryableRagSourceStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function getNextRagSourceFetchRetry(attempt?: number): {
  attempt: number;
  delayMs: number;
} | null {
  const currentAttempt =
    typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 0
      ? Math.min(attempt, RAG_SOURCE_FETCH_RETRY_MAX_ATTEMPT)
      : 0;
  if (currentAttempt >= RAG_SOURCE_FETCH_RETRY_MAX_ATTEMPT) {
    return null;
  }
  const nextAttempt = currentAttempt + 1;
  const delayMs = Math.min(
    RAG_SOURCE_FETCH_RETRY_MAX_DELAY_MS,
    RAG_SOURCE_FETCH_RETRY_BASE_DELAY_MS * 2 ** Math.min(nextAttempt - 1, 5),
  );
  return { attempt: nextAttempt, delayMs };
}

async function fetchRagSourceContent(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(FILE_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new RetryableRagSourceFetchError(
      "repository source fetch failed before receiving a response",
    );
  }

  if (!response.ok) {
    const status = response.status;
    const statusText = response.statusText;
    await response.body?.cancel().catch(() => undefined);
    if (isRetryableRagSourceStatus(status)) {
      throw new RetryableRagSourceFetchError(
        `repository source fetch returned ${status} ${statusText}`.trim(),
      );
    }
    throw new Error(`${status} ${statusText}`.trim());
  }

  try {
    return await response.text();
  } catch {
    throw new RetryableRagSourceFetchError(
      "repository source response ended before it could be read",
    );
  }
}

function normalizeChunkSearchFilters(
  filters?: ChunkSearchFilters,
): ChunkSearchFilters | undefined {
  if (!filters?.language?.length) {
    return undefined;
  }

  const language = Array.from(
    new Set(
      filters.language
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  if (language.length > MAX_SEARCH_FILTER_LANGUAGES) {
    throw new Error(
      `Language filters are limited to ${MAX_SEARCH_FILTER_LANGUAGES} values`,
    );
  }

  return language.length > 0 ? { language } : undefined;
}

function sanitizeEmbeddingError(error: unknown): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "Repository embedding request failed";
  return message.slice(0, 500);
}

/**
 * Generate embeddings for all chunks in a repository
 */
export const generateChunkEmbeddings = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.optional(v.number()),
    phase: v.optional(v.union(v.literal("files"), v.literal("cleanup"))),
    cursor: v.optional(v.string()),
    fileOffset: v.optional(v.number()),
    chunkOffset: v.optional(v.number()),
    claimToken: v.optional(v.string()),
    transientFileFetchAttempt: v.optional(v.number()),
    embeddingProviderAttempt: v.optional(v.number()),
    embeddingQueueAttempt: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
    totalChunks: v.number(),
    successCount: v.number(),
    errorCount: v.number(),
  }),
  handler: async (ctx, args): Promise<EmbeddingGenerationResult> => {
    let totalChunks = 0;
    let successCount = 0;
    let errorCount = 0;
    let processedFileMaps = 0;
    let claimedInitialCall = false;

    const repo = await ctx.runQuery(
      internal.repositories.internalQuery.getById,
      {
        repositoryId: args.repositoryId,
      },
    );

    if (!repo) {
      throw new Error("Repository not found");
    }

    // The repository as read after this run's claim; its pinned pass mode
    // decides which files the pass visits.
    let passRepo: typeof repo = repo;
    const isInitialCall =
      args.phase === undefined &&
      args.cursor === undefined &&
      args.fileOffset === undefined &&
      args.chunkOffset === undefined &&
      args.claimToken === undefined &&
      args.transientFileFetchAttempt === undefined &&
      args.embeddingProviderAttempt === undefined &&
      args.embeddingQueueAttempt === undefined;
    const indexVersion = args.indexVersion ?? repo.indexVersion;
    if (!isInitialCall) {
      if (repo.ragProcessedFiles === undefined) {
        throw new Error("RAG continuation checkpoint is incomplete");
      }
      totalChunks = repo.ragTotalChunks;
      successCount = repo.ragIndexedChunks;
      errorCount = repo.ragFailedChunks;
      processedFileMaps = repo.ragProcessedFiles;
    }
    // Gitdog no longer creates embeddings: every index is keyword-only.
    const embeddingMode = "keyword_only" as const;
    const embeddingUnavailableMessage =
      "Repository embeddings are retired; using keyword search only";
    let currentWork: RagWorkPosition;

    const degradeAndYieldToKeywordOnly = async (
      error: unknown,
      durablePreWorkCheckpoint: RagWorkCheckpoint,
    ): Promise<void> => {
      const errorMessage = sanitizeEmbeddingError(error);
      const continuationToken = crypto.randomUUID();
      const yielded = await ctx.runMutation(
        internal.ragV2.internalMutation.degradeRagEmbeddingAndContinue,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: indexVersion,
          expectedPhase: currentWork.phase,
          expectedCursor: currentWork.cursor,
          expectedFileOffset: currentWork.fileOffset,
          expectedChunkOffset: currentWork.chunkOffset,
          error: errorMessage,
          continuationToken,
          totalChunks: durablePreWorkCheckpoint.totalChunks,
          successCount: durablePreWorkCheckpoint.successCount,
          errorCount: durablePreWorkCheckpoint.errorCount,
          processedFiles: durablePreWorkCheckpoint.processedFiles,
        },
      );
      if (!yielded) {
        throw new Error("RAG embedding degradation lost ownership");
      }

      console.warn(
        `[RAG V2] Repository embeddings unavailable; yielded the current work unit to keyword-only indexing: ${errorMessage}`,
      );
    };

    if (isInitialCall) {
      if (
        repo.indexVersion !== indexVersion ||
        repo.indexStatus !== "completed" ||
        repo.ragStatus !== "pending"
      ) {
        console.warn(
          `[RAG V2] Skipping stale generation ${indexVersion}; current version/status is ${repo.indexVersion}/${repo.ragStatus}`,
        );
        return {
          success: false,
          totalChunks,
          successCount,
          errorCount,
        };
      }

      const claimed = await ctx.runMutation(
        internal.ragV2.internalMutation.claimRagGeneration,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: indexVersion,
          embeddingMode,
        },
      );
      if (claimed !== true) {
        console.warn(
          `[RAG V2] Generation ${indexVersion} was already claimed or became stale`,
        );
        return {
          success: false,
          totalChunks,
          successCount,
          errorCount,
        };
      }

      // The claim pinned the pass mode and its starting chunk count.
      totalChunks = 0;
      successCount = 0;
      errorCount = 0;
      processedFileMaps = 0;
      claimedInitialCall = true;
      currentWork = {
        phase: "files",
        cursor: undefined,
        fileOffset: 0,
        chunkOffset: 0,
      };
    } else {
      if (
        args.indexVersion === undefined ||
        args.phase === undefined ||
        args.claimToken === undefined ||
        repo.indexVersion !== args.indexVersion ||
        repo.indexStatus !== "completed" ||
        repo.ragStatus !== "indexing"
      ) {
        console.warn(
          `[RAG V2] Skipping malformed or stale continuation ${indexVersion}`,
        );
        return {
          success: false,
          totalChunks,
          successCount,
          errorCount,
        };
      }

      currentWork = {
        phase: args.phase,
        cursor: args.cursor,
        fileOffset: args.fileOffset ?? 0,
        chunkOffset: args.chunkOffset ?? 0,
      };

      const claimed = await ctx.runMutation(
        internal.ragV2.internalMutation.claimRagContinuation,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: indexVersion,
          phase: currentWork.phase,
          cursor: currentWork.cursor,
          fileOffset: currentWork.fileOffset,
          chunkOffset: currentWork.chunkOffset,
          continuationToken: args.claimToken,
        },
      );
      if (!claimed) {
        console.warn(
          `[RAG V2] Continuation ${indexVersion}/${currentWork.phase}/${currentWork.cursor ?? "start"}/${currentWork.fileOffset}/${currentWork.chunkOffset} was already claimed or became stale`,
        );
        return {
          success: false,
          totalChunks,
          successCount,
          errorCount,
        };
      }

      totalChunks = claimed.totalChunks;
      successCount = claimed.successCount;
      errorCount = claimed.errorCount;
      processedFileMaps = claimed.processedFiles;

      // An index that was still embedding when embeddings were retired
      // continues as keyword-only.
      if (repo.ragEmbeddingMode === "openai") {
        await degradeAndYieldToKeywordOnly(embeddingUnavailableMessage, {
          totalChunks,
          successCount,
          errorCount,
          processedFiles: processedFileMaps,
        });
        return {
          success: true,
          totalChunks,
          successCount,
          errorCount,
        };
      }
    }

    const updateRagStatus = async (
      status: "completed" | "failed",
      error?: string,
    ): Promise<void> => {
      await ctx.runMutation(internal.ragV2.internalMutation.updateRagStatus, {
        repositoryId: args.repositoryId,
        status,
        error,
        totalChunks,
        indexedChunks: successCount,
        failedChunks: errorCount,
        expectedIndexVersion: indexVersion,
        expectedCurrentStatus: "indexing",
        expectedPhase: currentWork.phase,
        expectedCursor: currentWork.cursor,
        expectedFileOffset: currentWork.fileOffset,
        expectedChunkOffset: currentWork.chunkOffset,
      });
    };

    const ensureCurrentGeneration = async (): Promise<boolean> => {
      const currentRepo = await ctx.runQuery(
        internal.repositories.internalQuery.getById,
        {
          repositoryId: args.repositoryId,
        },
      );
      passRepo = currentRepo ?? passRepo;
      if (claimedInitialCall && currentRepo) {
        totalChunks = currentRepo.ragTotalChunks;
        successCount = currentRepo.ragIndexedChunks;
        claimedInitialCall = false;
      }
      const isCurrent =
        currentRepo?.indexVersion === indexVersion &&
        currentRepo.indexStatus === "completed" &&
        currentRepo.ragStatus === "indexing" &&
        currentRepo.ragIndexPhase === currentWork.phase &&
        currentRepo.ragIndexCursor === currentWork.cursor &&
        (currentRepo.ragIndexFileOffset ?? 0) === currentWork.fileOffset &&
        (currentRepo.ragIndexChunkOffset ?? 0) === currentWork.chunkOffset &&
        currentRepo.ragContinuationToken === undefined;

      if (!isCurrent) {
        console.warn(
          `[RAG V2] Stopping stale embedding generation: expected ${indexVersion}/${currentWork.phase}/${currentWork.cursor ?? "start"}/${currentWork.fileOffset}/${currentWork.chunkOffset}`,
        );
      }

      return isCurrent;
    };

    const advanceRagWork = async (
      nextWork: RagWorkPosition,
      retry?: RagRetrySchedule,
    ): Promise<void> => {
      const continuationToken = crypto.randomUUID();
      const advanced = await ctx.runMutation(
        internal.ragV2.internalMutation.advanceRagGeneration,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: indexVersion,
          currentPhase: currentWork.phase,
          currentCursor: currentWork.cursor,
          currentFileOffset: currentWork.fileOffset,
          currentChunkOffset: currentWork.chunkOffset,
          nextPhase: nextWork.phase,
          nextCursor: nextWork.cursor,
          nextFileOffset: nextWork.fileOffset,
          nextChunkOffset: nextWork.chunkOffset,
          continuationToken,
          totalChunks,
          successCount,
          errorCount,
          processedFiles: processedFileMaps,
          ...(retry
            ? {
                retryDelayMs: retry.delayMs,
                transientFileFetchAttempt:
                  retry.kind === "source_fetch"
                    ? retry.attempt
                    : args.transientFileFetchAttempt,
                embeddingProviderAttempt:
                  retry.kind === "embedding_provider"
                    ? retry.attempt
                    : args.embeddingProviderAttempt,
                embeddingQueueAttempt:
                  retry.kind === "embedding_queue"
                    ? retry.attempt
                    : args.embeddingQueueAttempt,
              }
            : {}),
        },
      );

      if (!advanced) {
        throw new Error("RAG continuation lost ownership before checkpoint");
      }
    };

    const upsertProcessedChunkBatch = async (
      processedChunks: Array<{ chunk: CodeChunk }>,
    ): Promise<void> => {
      const published = await ctx.runMutation(
        internal.ragV2.internalMutation.upsertChunks,
        {
          repositoryId: args.repositoryId,
          chunks: processedChunks.map(({ chunk }) => ({
            ...chunk,
            embedding: undefined,
            embeddingKey: undefined,
          })),
          indexVersion,
        },
      );
      if (published === null) {
        throw new Error(
          `stale RAG chunk upsert for index version ${indexVersion}`,
        );
      }
    };

    const buildProcessedChunkBatches = (
      processedChunks: Array<{ chunk: CodeChunk }>,
    ) =>
      buildRagChunkPublicationBatches(
        processedChunks,
        ({ chunk }) => ({
          ...chunk,
          embedding: undefined,
          embeddingKey: undefined,
        }),
        {
          includeMissingEmbeddings: false,
          cacheEmbeddings: false,
        },
      );

    const processChunks = async (chunks: Array<CodeChunk>): Promise<void> => {
      const storeWithoutEmbeddings = async (
        chunksToStore: Array<CodeChunk>,
        errorContext: string,
      ): Promise<void> => {
        const batches = buildProcessedChunkBatches(
          chunksToStore.map((chunk) => ({ chunk })),
        );
        for (const batch of batches) {
          try {
            await upsertProcessedChunkBatch(batch);
            successCount += batch.length;
          } catch (error) {
            if (isStaleRagChunkUpsertError(error)) {
              throw error;
            }
            errorCount += batch.length;
            console.error(`[RAG V2] ${errorContext}`);
          }
        }
      };

      await storeWithoutEmbeddings(chunks, "Error storing keyword-only chunks");
    };

    console.log(
      `[RAG V2] ${isInitialCall ? "Starting" : "Continuing"} ${currentWork.phase} work`,
    );
    try {
      if (!(await ensureCurrentGeneration())) {
        return {
          success: false,
          totalChunks,
          successCount,
          errorCount,
        };
      }

      if (currentWork.phase === "cleanup") {
        if (errorCount > 0) {
          await updateRagStatus(
            "failed",
            `RAG embedding completed with ${errorCount} errors`,
          );
          return {
            success: false,
            totalChunks,
            successCount,
            errorCount,
          };
        }

        const cleanupResult = await ctx.runMutation(
          internal.ragV2.internalMutation.cleanupRagGeneration,
          { repositoryId: args.repositoryId, indexVersion },
        );
        if (!cleanupResult) {
          console.warn(
            `[RAG V2] Cleanup for generation ${indexVersion} lost ownership`,
          );
          return {
            success: false,
            totalChunks,
            successCount,
            errorCount,
          };
        }

        if (cleanupResult.hasMore) {
          await advanceRagWork({
            phase: "cleanup",
            cursor: undefined,
            fileOffset: 0,
            chunkOffset: 0,
          });
          console.log(
            `[RAG V2] Removed ${cleanupResult.deleted} old chunks; scheduled the next cleanup batch`,
          );
        } else {
          console.log(
            `[RAG V2] Embedding generation completed: ${successCount}/${totalChunks} chunks from ${processedFileMaps} files, ${errorCount} errors, ${cleanupResult.deleted} old chunks removed in the final batch`,
          );

          await updateRagStatus("completed");
        }

        return {
          success: errorCount === 0,
          totalChunks,
          successCount,
          errorCount,
        };
      }

      // Once a repository has per-path chunks, only paths whose content
      // changed are visited; unchanged files cost no chunk reads or writes.
      const pendingOnly = isChangedPathsPass(passRepo);
      const filePage = await ctx.runQuery(
        internal.repoIndexing.internalQuery.getRepositoryFilesPage,
        {
          repositoryId: args.repositoryId,
          indexVersion,
          cursor: currentWork.cursor,
          limit: FILE_PAGE_SIZE,
          ...(pendingOnly ? { pendingOnly: true } : {}),
        },
      );
      const fileMaps = filePage.files;

      const nextPositionAfterPage = (): RagWorkPosition => {
        if (filePage.hasMore) {
          if (!filePage.cursor) {
            throw new Error(
              "RAG file pagination returned no continuation cursor",
            );
          }

          return {
            phase: "files",
            cursor: filePage.cursor,
            fileOffset: 0,
            chunkOffset: 0,
          };
        }

        return {
          phase: "cleanup",
          cursor: undefined,
          fileOffset: 0,
          chunkOffset: 0,
        };
      };

      const nextPositionAfterFile = (
        position: RagWorkPosition,
      ): RagWorkPosition => {
        const nextFileOffset = position.fileOffset + 1;
        if (nextFileOffset < fileMaps.length) {
          return {
            phase: "files",
            cursor: position.cursor,
            fileOffset: nextFileOffset,
            chunkOffset: 0,
          };
        }

        return nextPositionAfterPage();
      };

      const deletePathChunks = async (path: string): Promise<void> => {
        for (let batch = 0; batch < RAG_MAX_PATH_DELETE_BATCHES; batch++) {
          const deleted = await ctx.runMutation(
            internal.ragV2.internalMutation.deleteChunksForPathInGeneration,
            { repositoryId: args.repositoryId, indexVersion, path },
          );
          // A changed-paths pass carries the stored count, so replaced
          // chunks leave it; a full pass counts only what it writes.
          if (pendingOnly) {
            totalChunks = Math.max(0, totalChunks - deleted.deleted);
            successCount = Math.max(0, successCount - deleted.deleted);
          }
          if (deleted.done) return;
        }
        throw new Error("Repository path has too many stale chunks");
      };

      // Parsed chunks of the file being worked on, so later chunk batches of
      // the same file in this run do not fetch and parse it again.
      let parsedFile: { path: string; chunks: Array<CodeChunk> } | undefined;

      const processFileUnit = async (
        fileMap: RepositoryFileForEmbedding,
        position: RagWorkPosition,
      ): Promise<RagWorkPosition> => {
        const skipFile = async (reason: string): Promise<RagWorkPosition> => {
          console.warn(
            `[RAG V2] Skipping ${reason} at file offset ${position.fileOffset}`,
          );
          await deletePathChunks(fileMap.path);
          processedFileMaps++;
          return nextPositionAfterFile(position);
        };
        if (fileMap.isText === false) return await skipFile("non-text source");
        if (fileMap.hasBlob === false) {
          // Keep the old chunks and the flag; the pass fails and a later
          // generation retries this path.
          throw new Error("no cached source");
        }
        if (fileMap.size > MAX_RAG_SOURCE_BYTES) {
          return await skipFile(
            `oversized source (${fileMap.size} declared bytes)`,
          );
        }

        let chunks = parsedFile?.path === fileMap.path ? parsedFile.chunks : [];
        if (parsedFile?.path !== fileMap.path) {
          if (!fileMap.url) {
            throw new Error("no storage URL");
          }
          const content = await fetchRagSourceContent(fileMap.url);
          const contentBytes = getUtf8ByteLength(content);
          if (contentBytes > MAX_RAG_SOURCE_BYTES) {
            return await skipFile(
              `oversized source (${contentBytes} UTF-8 bytes)`,
            );
          }
          chunks = normalizeCodeChunksForStorage(
            parseCodeIntoChunks(fileMap.path, content, fileMap.language),
          );
          parsedFile = { path: fileMap.path, chunks };
        }

        if (position.chunkOffset === 0) {
          totalChunks += chunks.length;
          await deletePathChunks(fileMap.path);
        }

        if (position.chunkOffset > chunks.length) {
          throw new Error(
            `chunk offset ${position.chunkOffset} exceeds ${chunks.length}`,
          );
        }

        const chunkBatch = chunks.slice(
          position.chunkOffset,
          position.chunkOffset + MAX_RAG_PROVIDER_BATCH_ITEMS,
        );
        if (chunkBatch.length > 0) await processChunks(chunkBatch);

        const nextChunkOffset = position.chunkOffset + chunkBatch.length;
        if (nextChunkOffset < chunks.length) {
          return {
            phase: "files",
            cursor: position.cursor,
            fileOffset: position.fileOffset,
            chunkOffset: nextChunkOffset,
          };
        }
        processedFileMaps++;
        parsedFile = undefined;
        return nextPositionAfterFile(position);
      };

      // Work through the rest of this page in one run, so the repository
      // checkpoint is written once per page instead of once per file.
      const runStartedAt = Date.now();
      let position: RagWorkPosition = currentWork;
      let nextWork: RagWorkPosition = currentWork;
      for (let unit = 0; ; unit++) {
        const fileMap = fileMaps[position.fileOffset] as
          RepositoryFileForEmbedding | undefined;
        if (!fileMap) {
          nextWork = nextPositionAfterPage();
          break;
        }

        try {
          nextWork = await processFileUnit(fileMap, position);
        } catch (error) {
          if (error instanceof RetryableRagSourceFetchError) {
            const isClaimedPosition = unit === 0;
            const retry = getNextRagSourceFetchRetry(
              isClaimedPosition ? args.transientFileFetchAttempt : undefined,
            );
            if (!retry) {
              const terminalError = `Repository source fetch at file offset ${position.fileOffset} exhausted ${RAG_SOURCE_FETCH_RETRY_MAX_ATTEMPT} retries; retry repository indexing to resume`;
              await updateRagStatus("failed", terminalError);
              console.error(`[RAG V2] ${terminalError}`);
              return {
                success: false,
                totalChunks,
                successCount,
                errorCount,
              };
            }
            await advanceRagWork(position, {
              kind: "source_fetch",
              ...retry,
            });
            console.warn(
              `[RAG V2] Source fetch at file offset ${position.fileOffset} will retry without advancing its cursor`,
            );
            return {
              success: true,
              totalChunks,
              successCount,
              errorCount,
            };
          }
          if (isStaleRagChunkUpsertError(error)) throw error;

          errorCount++;
          processedFileMaps++;
          parsedFile = undefined;
          console.error(
            `[RAG V2] Error processing file at offset ${position.fileOffset}`,
          );
          nextWork = nextPositionAfterFile(position);
        }

        const leavesPage =
          nextWork.phase !== "files" || nextWork.cursor !== currentWork.cursor;
        if (
          leavesPage ||
          unit + 1 >= RAG_MAX_WORK_UNITS_PER_RUN ||
          Date.now() - runStartedAt >= RAG_RUN_TIME_BUDGET_MS
        ) {
          break;
        }
        position = nextWork;
      }

      if (nextWork.phase === "cleanup" && errorCount > 0) {
        await updateRagStatus(
          "failed",
          `RAG embedding completed with ${errorCount} errors`,
        );
      } else {
        await advanceRagWork(nextWork);
      }

      console.log(
        `[RAG V2] Checkpointed ${processedFileMaps} files (${successCount}/${totalChunks} chunks, ${errorCount} errors)`,
      );

      return {
        success: errorCount === 0,
        totalChunks,
        successCount,
        errorCount,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown RAG indexing error";
      console.error("[RAG V2] Keyword indexing failed");
      await updateRagStatus("failed", errorMessage);
      throw error;
    }
  },
});

/**
 * Reciprocal Rank Fusion (RRF)
 * Combines results from multiple rankers
 */
function reciprocalRankFusion(
  results: Array<Array<{ id: string; score: number }>>,
  k = 60,
): Array<{ id: string; score: number }> {
  const scoreMap = new Map<string, number>();

  for (const rankList of results) {
    rankList.forEach((item, rank) => {
      const rrf = 1 / (k + rank + 1);
      scoreMap.set(item.id, (scoreMap.get(item.id) || 0) + rrf);
    });
  }

  return Array.from(scoreMap.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

function docTypeBoost(path: string): number {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? lower;

  switch (true) {
    case /^(claude|agents|gemini|convention|ai|copilot)\.md$/i.test(base):
    case /^llm(s)?(-full)?\.txt$/i.test(base):
      return 6;
    // Match at repo root OR inside any sub-package (monorepo support).
    // Anchored to directory components so a path like `not.claude/foo` won't match.
    case /(^|\/)\.claude\//i.test(lower):
    case /(^|\/)\.cursor\/rules\//i.test(lower):
      return 5;
    case /^(readme|contributing)(\.md)?$/i.test(base):
      return 4;
    default:
      return 0;
  }
}

/**
 * Simple second-stage ranking based on query-code similarity
 * Future: Replace with cross-encoder model
 */
function rankChunksByQueryMatch(
  query: string,
  chunks: Array<{
    chunkId: string;
    path: string;
    code: string;
    symbols: string[];
    signature?: string;
  }>,
  topK: number,
): string[] {
  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.trim().split(/\s+/).filter(Boolean);

  // Calculate relevance score
  const scored = chunks.map((chunk) => {
    let score = 0;

    // Symbol match (high weight)
    for (const symbol of chunk.symbols) {
      if (queryTokens.includes(symbol.toLowerCase())) {
        score += 10;
      }
    }

    // Signature match (medium weight)
    if (chunk.signature) {
      const sigLower = chunk.signature.toLowerCase();
      for (const token of queryTokens) {
        if (sigLower.includes(token)) {
          score += 5;
        }
      }
    }

    // Code match (low weight)
    const codeLower = chunk.code.toLowerCase();
    for (const token of queryTokens) {
      if (codeLower.includes(token)) {
        score += 1;
      }
    }

    // AI context doc boost — these explain repo structure (monorepo layout,
    // conventions). Surface them early so answers reflect actual project shape.
    score += docTypeBoost(chunk.path);

    return { chunkId: chunk.chunkId, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.chunkId);
}

/**
 * Maximal Marginal Relevance (MMR) for diversification
 */
function mmrDiversify(
  chunks: Array<{ chunkId: string; embedding?: number[]; path: string }>,
  lambda = 0.7,
  topK = 8,
): string[] {
  if (chunks.length === 0) return [];

  const selected: string[] = [];
  const remaining = [...chunks];

  // Select first chunk (highest score)
  selected.push(remaining[0].chunkId);
  remaining.shift();

  // Select subsequent chunks balancing relevance and diversity
  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];

      // Relevance score (position-based)
      const relevance = 1 / (i + 1);

      // Diversity score (path-based for simplicity)
      let maxSimilarity = 0;
      for (const selectedId of selected) {
        const selectedChunk = chunks.find((c) => c.chunkId === selectedId);
        if (selectedChunk && selectedChunk.path === candidate.path) {
          maxSimilarity = 0.8; // Same file = high similarity
        }
      }

      // MMR score
      const mmr = lambda * relevance - (1 - lambda) * maxSimilarity;

      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx].chunkId);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

/**
 * Hybrid search: Vector + BM25 + RRF + query ranking + MMR
 */
export const hybridSearch = internalAction({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.optional(v.number()),
    query: v.string(),
    requestedByUserId: v.optional(v.id("users")),
    // Accepted from older callers; search no longer sends queries anywhere.
    embeddingDataProvenance: v.optional(
      v.union(v.literal("public_github"), v.literal("private_user_input")),
    ),
    topK: v.optional(v.number()),
    filters: v.optional(
      v.object({
        language: v.optional(v.array(v.string())),
      }),
    ),
  },
  returns: v.array(
    v.object({
      chunkId: v.string(),
      path: v.string(),
      startLine: v.number(),
      endLine: v.number(),
      code: v.string(),
      symbols: v.array(v.string()),
      signature: v.optional(v.string()),
      score: v.number(),
      language: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    if (args.requestedByUserId) {
      await requireStrictCurrentAiLegalAttestation(ctx, args.requestedByUserId);
    }
    const topK = args.topK ?? 8;
    const filters = normalizeChunkSearchFilters(args.filters);
    const access = await ctx.runQuery(
      internal.repositories.internalQuery.getAiAccessSnapshot,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: args.indexVersion,
      },
    );
    if (!access) {
      return [];
    }

    const repo = await ctx.runQuery(
      internal.repositories.internalQuery.getById,
      {
        repositoryId: args.repositoryId,
      },
    );

    if (!repo) {
      return [];
    }

    const indexVersion = access.indexVersion;
    console.log("[RAG V2 Hybrid] Starting repository search");

    // Retrieval is keyword search; the model reads files with its tools.
    const bm25Results = await ctx.runQuery(
      internal.ragV2.internalQuery.keywordSearch,
      {
        repositoryId: args.repositoryId,
        indexVersion,
        query: args.query,
        topK: 200,
        filters,
      },
    );

    console.log(
      `[RAG V2 Hybrid] BM25 search found ${bm25Results.length} results`,
    );

    // RRF fusion (get top 30 to avoid 16MB read limit)
    const fusedIds = reciprocalRankFusion([
      bm25Results.map((r: { chunkId: string; score: number }) => ({
        id: r.chunkId,
        score: r.score,
      })),
    ]);

    const top30Ids = fusedIds.slice(0, 30).map((x) => x.id);
    console.log(
      `[RAG V2 Hybrid] RRF fusion selected ${top30Ids.length} chunks`,
    );

    // Get full chunk data for top 30 (batched to avoid 16MB limit)
    const top30Chunks: CodeChunk[] = await ctx.runQuery(
      internal.ragV2.internalQuery.getChunksByIds,
      {
        repositoryId: args.repositoryId,
        indexVersion,
        chunkIds: top30Ids,
        batchSize: 10,
      },
    );

    // Step 5: Query match ranking (top 30 → top 15)
    const rankedIds = rankChunksByQueryMatch(args.query, top30Chunks, 15);
    console.log(
      `[RAG V2 Hybrid] Query ranking selected ${rankedIds.length} chunks`,
    );

    // Preserve query ranking order so docTypeBoost actually influences MMR.
    // mmrDiversify treats rankedChunks[0] as highest relevance, so we must
    // build the array in rankedIds order (not top30 fusion order).
    const rankedChunkMap = new Map(
      top30Chunks.map((c: CodeChunk) => [c.chunkId, c]),
    );
    const rankedChunks: CodeChunk[] = rankedIds
      .map((id) => rankedChunkMap.get(id))
      .filter((c): c is CodeChunk => c !== undefined);

    // Step 6: MMR diversification (top 15 → final topK)
    const diversifiedIds = mmrDiversify(rankedChunks, 0.7, topK);
    console.log(
      `[RAG V2 Hybrid] MMR diversification selected ${diversifiedIds.length} chunks`,
    );

    // Get final chunks in order
    const finalChunks: CodeChunk[] = diversifiedIds
      .map((id: string) =>
        rankedChunks.find((c: CodeChunk) => c.chunkId === id),
      )
      .filter((c): c is CodeChunk => c !== null && c !== undefined);

    console.log(
      `[RAG V2 Hybrid] Final results: ${finalChunks.length} chunks from ${new Set(finalChunks.map((c: CodeChunk) => c.path)).size} files`,
    );

    const currentAccess = await ctx.runQuery(
      internal.repositories.internalQuery.getAiAccessSnapshot,
      {
        repositoryId: args.repositoryId,
        expectedIndexVersion: indexVersion,
      },
    );
    if (!currentAccess) {
      return [];
    }

    if (args.requestedByUserId) {
      await requireStrictCurrentAiLegalAttestation(ctx, args.requestedByUserId);
    }

    return finalChunks.map((chunk: CodeChunk, idx: number) => ({
      chunkId: chunk.chunkId,
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      code: chunk.code,
      symbols: chunk.symbols,
      signature: chunk.signature,
      score: 1 - idx / finalChunks.length, // Normalized score
      language: chunk.language,
    }));
  },
});
