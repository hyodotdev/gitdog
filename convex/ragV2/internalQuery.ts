import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { readRepositoryAiAccessSnapshot } from "../repositories/aiReadiness";
import { usesPathChunkLayout } from "./chunkPaths";

interface ChunkSearchFilters {
  language?: string[];
}

interface KeywordSearchResult {
  chunkId: string;
  path: string;
  score: number;
}

interface SearchableChunkPage {
  chunks: Array<{
    path: string;
    language: string;
    symbols: string[];
    code: string;
    startLine: number;
    endLine: number;
  }>;
  cursor: string | null;
  hasMore: boolean;
}

const MAX_KEYWORD_SEARCH_RESULTS = 128;
const MAX_CHUNK_COPIES = 4;

function newestChunk(
  copies: Array<Doc<"repoChunks">>,
): Doc<"repoChunks"> | null {
  return copies.reduce<Doc<"repoChunks"> | null>(
    (newest, chunk) =>
      newest === null || chunk.indexVersion > newest.indexVersion
        ? chunk
        : newest,
    null,
  );
}

/**
 * Keep one chunk per chunk ID, in first-seen order, preferring the newest
 * generation, so a leftover older copy is never served.
 */
function dedupeNewestChunks(
  chunks: Array<Doc<"repoChunks">>,
): Array<Doc<"repoChunks">> {
  const byId = new Map<string, Doc<"repoChunks">>();
  for (const chunk of chunks) {
    const seen = byId.get(chunk.chunkId);
    if (!seen || chunk.indexVersion > seen.indexVersion) {
      byId.set(chunk.chunkId, chunk);
    }
  }
  const emitted = new Set<string>();
  return chunks.flatMap((chunk) => {
    if (emitted.has(chunk.chunkId)) return [];
    emitted.add(chunk.chunkId);
    return [byId.get(chunk.chunkId)!];
  });
}
const MAX_KEYWORD_SEARCH_LANGUAGES = 8;

function clampFiniteInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), 1), maximum);
}

function matchesChunkFilters(
  chunk: { language: string },
  filters?: ChunkSearchFilters,
): boolean {
  return !(
    filters?.language?.length && !filters.language.includes(chunk.language)
  );
}

/**
 * BM25 keyword search using Convex search index
 */
export const keywordSearch = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    query: v.string(),
    topK: v.number(),
    filters: v.optional(
      v.object({
        language: v.optional(v.array(v.string())),
      }),
    ),
  },
  handler: async (ctx, args): Promise<Array<KeywordSearchResult>> => {
    const access = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.indexVersion,
    );
    if (!access) {
      return [];
    }
    const topK = clampFiniteInteger(args.topK, 8, MAX_KEYWORD_SEARCH_RESULTS);
    const languages = Array.from(
      new Set(
        (args.filters?.language ?? [])
          .map((language) => language.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    if (languages.length > MAX_KEYWORD_SEARCH_LANGUAGES) {
      throw new Error(
        `Language filters are limited to ${MAX_KEYWORD_SEARCH_LANGUAGES} values`,
      );
    }
    const normalizedFilters =
      languages.length > 0 ? { language: languages } : undefined;

    // Per-path chunks belong to whichever generation last changed their path.
    // Before that layout exists, only the pinned generation's chunks count.
    const pathLayout = usesPathChunkLayout(access.repository);
    const repositoryIndexKey = `${args.repositoryId}:${args.indexVersion}`;

    const searchWithLanguage = async (
      language: string | undefined,
      limit: number,
    ): Promise<Array<Doc<"repoChunks">>> => {
      return await ctx.db
        .query("repoChunks")
        .withSearchIndex("search_text", (q) => {
          const scopedQuery = q
            .search("searchableText", args.query)
            .eq("repositoryId", args.repositoryId);
          const versionedQuery = pathLayout
            ? scopedQuery
            : scopedQuery.eq("repositoryIndexKey", repositoryIndexKey);

          return language
            ? versionedQuery.eq("language", language)
            : versionedQuery;
        })
        .take(limit);
    };

    const searchPlan =
      languages.length > 0
        ? languages.map((language, index) => ({
            language,
            limit:
              Math.floor(topK / languages.length) +
              (index < topK % languages.length ? 1 : 0),
          }))
        : [{ language: undefined, limit: topK }];
    const rawSearchResults = (
      await Promise.all(
        searchPlan
          .filter(({ limit }) => limit > 0)
          .map(({ language, limit }) => searchWithLanguage(language, limit)),
      )
    ).flat();
    const searchResults = dedupeNewestChunks(
      rawSearchResults.filter(
        (chunk) =>
          chunk.repositoryId === args.repositoryId &&
          (pathLayout || chunk.indexVersion === args.indexVersion),
      ),
    );

    const filteredResults = searchResults
      .filter((chunk) => matchesChunkFilters(chunk, normalizedFilters))
      .slice(0, topK);

    return filteredResults.map((chunk, idx) => ({
      chunkId: chunk.chunkId,
      path: chunk.path,
      score: 1 - idx / filteredResults.length, // Simple score based on rank
    }));
  },
});

/**
 * Get chunks by IDs using indexed queries
 * Requires repositoryId for efficient index lookup
 */
export const getChunksByIds = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    chunkIds: v.array(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Array<Doc<"repoChunks">>> => {
    const access = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.indexVersion,
    );
    if (!access) {
      return [];
    }

    const pathLayout = usesPathChunkLayout(access.repository);
    const batchSize = args.batchSize ?? 10; // Default: 10 chunks per batch
    const allChunks: Array<Doc<"repoChunks"> | null> = [];

    // Process in batches to avoid hitting 16MB read limit
    // Use indexed query for efficient lookup
    for (let i = 0; i < args.chunkIds.length; i += batchSize) {
      const batchIds = args.chunkIds.slice(i, i + batchSize);
      const batchChunks = await Promise.all(
        batchIds.map(async (chunkId) => {
          if (!pathLayout) {
            return await ctx.db
              .query("repoChunks")
              .withIndex("by_index_version_and_chunk", (q) =>
                q
                  .eq("repositoryId", args.repositoryId)
                  .eq("indexVersion", args.indexVersion)
                  .eq("chunkId", chunkId),
              )
              .first();
          }
          // Chunk IDs hash path and line range, so one ID names one current
          // chunk; a leftover older copy loses to the newest generation.
          const copies = await ctx.db
            .query("repoChunks")
            .withIndex("by_repository_and_chunk", (q) =>
              q.eq("repositoryId", args.repositoryId).eq("chunkId", chunkId),
            )
            .take(MAX_CHUNK_COPIES);
          return newestChunk(copies);
        }),
      );
      allChunks.push(...batchChunks);
    }

    return allChunks.filter((c): c is NonNullable<typeof c> => c !== null);
  },
});

/**
 * Page through current-version code using a compact projection. Exact code
 * search uses this instead of materializing embeddings and search metadata for
 * hundreds of candidate documents in one query.
 */
export const getSearchableChunksPage = internalQuery({
  args: {
    repositoryId: v.id("repositories"),
    indexVersion: v.number(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchableChunkPage> => {
    const access = await readRepositoryAiAccessSnapshot(
      ctx,
      args.repositoryId,
      args.indexVersion,
    );
    if (!access) {
      return { chunks: [], cursor: null, hasMore: false };
    }

    const pageQuery = usesPathChunkLayout(access.repository)
      ? ctx.db
          .query("repoChunks")
          .withIndex("by_repository_and_path", (q) =>
            q.eq("repositoryId", args.repositoryId),
          )
      : ctx.db
          .query("repoChunks")
          .withIndex("by_index_version", (q) =>
            q
              .eq("repositoryId", args.repositoryId)
              .eq("indexVersion", args.indexVersion),
          );
    const page = await pageQuery.paginate({
      numItems: Math.min(Math.max(args.limit ?? 64, 1), 100),
      cursor: args.cursor ?? null,
    });

    return {
      chunks: dedupeNewestChunks(page.page).map((chunk) => ({
        path: chunk.path,
        language: chunk.language,
        symbols: chunk.symbols,
        code: chunk.code,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      })),
      cursor: page.isDone ? null : page.continueCursor,
      hasMore: !page.isDone,
    };
  },
});
