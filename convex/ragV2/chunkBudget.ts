/**
 * Conservative byte budgets for RAG source ingestion and Convex writes.
 *
 * Convex documents are limited to 1 MiB and transactions to 16 MiB of
 * reads/writes. The lower limits here leave room for indexes, validators,
 * repository reads, existing chunk reads, and serialization overhead.
 */
export const MAX_RAG_SOURCE_BYTES = 1024 * 1024;
// Retrieval units keep their complete code inside both BM25 searchable text
// and the embedding document. Metadata/title formatting still has ample room in
// the provider's 8 KiB formatted-input ceiling.
export const MAX_RAG_CHUNK_CODE_BYTES = 4 * 1024;
export const RAG_RETRIEVAL_OVERLAP_BYTES = 512;
export const MAX_RAG_RETRIEVAL_TEXT_BYTES =
  MAX_RAG_CHUNK_CODE_BYTES + RAG_RETRIEVAL_OVERLAP_BYTES * 2;
export const MAX_RAG_SEARCHABLE_TEXT_BYTES = 48 * 1024;
export const MAX_RAG_PATH_BYTES = 4 * 1024;
export const MAX_RAG_LANGUAGE_BYTES = 128;
export const MAX_RAG_SYMBOLS_BYTES = 4 * 1024;
export const MAX_RAG_IMPORTS_BYTES = 8 * 1024;
export const MAX_RAG_EXPORTS_BYTES = 4 * 1024;
export const MAX_RAG_SIGNATURE_BYTES = 4 * 1024;
export const MAX_RAG_DOCSTRING_BYTES = 8 * 1024;
export const MAX_RAG_METADATA_ITEM_BYTES = 2 * 1024;

export const MAX_RAG_PROVIDER_BATCH_ITEMS = 32;
export const MAX_RAG_PUBLICATION_BYTES = 8 * 1024 * 1024;
export const RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS = 6;
export const RAG_EMBEDDING_RESERVATION_MAX_WAITS = 120;
export const RAG_EMBEDDING_RESERVATION_WAIT_MS = 30_000;

// 1536 float64 values occupy 12 KiB before array/document overhead. Keeping
// cache batches under 768 KiB leaves at least 256 KiB below Convex's 1 MiB
// document limit even after conservative per-vector and document overhead.
export const RAG_EMBEDDING_DIMENSIONS = 1536;
export const RAG_EMBEDDING_VECTOR_STORAGE_BYTES =
  RAG_EMBEDDING_DIMENSIONS * Float64Array.BYTES_PER_ELEMENT + 512;
export const MAX_RAG_EMBEDDING_CACHE_BYTES = 768 * 1024;
// A trim transaction reads at most one document beyond this cap. At the
// per-document ceiling that remains below Convex's 16 MiB transaction limit,
// while bounding each repository's durable vector cache to roughly 12 MiB.
export const MAX_RAG_EMBEDDING_CACHE_BATCHES_PER_REPOSITORY = 16;
const RAG_EMBEDDING_CACHE_DOCUMENT_OVERHEAD_BYTES = 4 * 1024;

// Provider vectors can have long decimal JSON representations while crossing
// an action/mutation boundary. This estimate is intentionally larger than the
// eventual float64 storage footprint.
const RAG_EMBEDDING_VECTOR_TRANSPORT_BYTES = 48 * 1024;
const RAG_PUBLICATION_ITEM_OVERHEAD_BYTES = 1024;

export const MAX_RAG_STORED_CHUNK_ESTIMATED_BYTES =
  MAX_RAG_CHUNK_CODE_BYTES +
  MAX_RAG_RETRIEVAL_TEXT_BYTES +
  MAX_RAG_SEARCHABLE_TEXT_BYTES +
  MAX_RAG_PATH_BYTES +
  MAX_RAG_SYMBOLS_BYTES +
  MAX_RAG_IMPORTS_BYTES +
  MAX_RAG_EXPORTS_BYTES +
  MAX_RAG_SIGNATURE_BYTES +
  MAX_RAG_DOCSTRING_BYTES +
  RAG_EMBEDDING_VECTOR_TRANSPORT_BYTES +
  8 * 1024;

export const RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE = Math.max(
  1,
  Math.floor(MAX_RAG_PUBLICATION_BYTES / MAX_RAG_STORED_CHUNK_ESTIMATED_BYTES),
);

const textEncoder = new TextEncoder();

export function buildRagEmbeddingProviderAttemptKey(
  batchReservationKey: string,
  indexVersion: number,
): string {
  return `${batchReservationKey}:generation:${indexVersion}`;
}

export function getUtf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function getJsonUtf8ByteLength(value: unknown): number {
  return getUtf8ByteLength(JSON.stringify(value));
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes < 1) {
    return "";
  }
  if (getUtf8ByteLength(value) <= maxBytes) {
    return value;
  }

  let byteLength = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = getUtf8ByteLength(character);
    if (byteLength + characterBytes > maxBytes) {
      break;
    }
    byteLength += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

export function truncateUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes < 1) {
    return "";
  }
  if (getUtf8ByteLength(value) <= maxBytes) {
    return value;
  }

  const characters = Array.from(value);
  let byteLength = 0;
  let start = characters.length;
  for (let index = characters.length - 1; index >= 0; index--) {
    const characterBytes = getUtf8ByteLength(characters[index]);
    if (byteLength + characterBytes > maxBytes) {
      break;
    }
    byteLength += characterBytes;
    start = index;
  }
  return characters.slice(start).join("");
}

/** Split without breaking a Unicode code point or dropping source text. */
export function splitUtf8(value: string, maxBytes: number): Array<string> {
  if (maxBytes < 1) {
    throw new Error("UTF-8 split budget must be positive");
  }
  if (getUtf8ByteLength(value) <= maxBytes) {
    return [value];
  }

  const parts: Array<string> = [];
  let partStart = 0;
  let partEnd = 0;
  let partBytes = 0;

  for (const character of value) {
    const characterBytes = getUtf8ByteLength(character);
    if (characterBytes > maxBytes) {
      throw new Error("UTF-8 split budget cannot hold one code point");
    }
    if (partBytes + characterBytes > maxBytes && partEnd > partStart) {
      parts.push(value.slice(partStart, partEnd));
      partStart = partEnd;
      partBytes = 0;
    }
    partBytes += characterBytes;
    partEnd += character.length;
  }

  if (partEnd > partStart) {
    parts.push(value.slice(partStart, partEnd));
  }
  return parts;
}

export type RagChunkBudgetInput = {
  code: string;
  retrievalText?: string;
  searchableText: string;
  embedding?: ReadonlyArray<number>;
};

export function estimateRagEmbeddingCacheBytes(vectorCount: number): number {
  if (!Number.isInteger(vectorCount) || vectorCount < 0) {
    throw new Error("RAG embedding cache vector count must be non-negative");
  }
  return (
    RAG_EMBEDDING_CACHE_DOCUMENT_OVERHEAD_BYTES +
    vectorCount * RAG_EMBEDDING_VECTOR_STORAGE_BYTES
  );
}

export function estimateRagChunkPublicationBytes(
  chunk: RagChunkBudgetInput,
  includeMissingEmbedding: boolean,
): number {
  return (
    getJsonUtf8ByteLength(chunk) +
    RAG_PUBLICATION_ITEM_OVERHEAD_BYTES +
    (includeMissingEmbedding && !chunk.embedding
      ? RAG_EMBEDDING_VECTOR_TRANSPORT_BYTES
      : 0)
  );
}

export function assertRagChunkStorageBounds(chunk: RagChunkBudgetInput): void {
  if (getUtf8ByteLength(chunk.code) > MAX_RAG_CHUNK_CODE_BYTES) {
    throw new Error("RAG chunk code exceeds the storage byte budget");
  }
  if (
    chunk.retrievalText !== undefined &&
    getUtf8ByteLength(chunk.retrievalText) > MAX_RAG_RETRIEVAL_TEXT_BYTES
  ) {
    throw new Error("RAG retrieval text exceeds the storage byte budget");
  }
  if (getUtf8ByteLength(chunk.searchableText) > MAX_RAG_SEARCHABLE_TEXT_BYTES) {
    throw new Error("RAG searchable text exceeds the storage byte budget");
  }
  if (
    estimateRagChunkPublicationBytes(chunk, false) >
    MAX_RAG_STORED_CHUNK_ESTIMATED_BYTES
  ) {
    throw new Error("RAG chunk metadata exceeds the storage byte budget");
  }
}

export function assertRagChunkBatchWithinBudget(
  chunks: ReadonlyArray<RagChunkBudgetInput>,
  includeMissingEmbeddings: boolean,
): void {
  const byteLength = chunks.reduce(
    (total, chunk) =>
      total + estimateRagChunkPublicationBytes(chunk, includeMissingEmbeddings),
    0,
  );
  if (byteLength > MAX_RAG_PUBLICATION_BYTES) {
    throw new Error("RAG chunk batch exceeds the publication byte budget");
  }
}

export function buildRagChunkPublicationBatches<T>(
  items: ReadonlyArray<T>,
  getChunk: (item: T) => RagChunkBudgetInput,
  options: {
    includeMissingEmbeddings: boolean;
    cacheEmbeddings: boolean;
  },
): Array<Array<T>> {
  const batches: Array<Array<T>> = [];
  let batch: Array<T> = [];
  let batchBytes = 0;

  const flush = (): void => {
    if (batch.length > 0) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
  };

  for (const item of items) {
    const chunk = getChunk(item);
    assertRagChunkStorageBounds(chunk);
    const itemBytes = estimateRagChunkPublicationBytes(
      chunk,
      options.includeMissingEmbeddings,
    );
    if (itemBytes > MAX_RAG_PUBLICATION_BYTES) {
      throw new Error("One RAG chunk exceeds the publication byte budget");
    }

    const exceedsItemLimit = batch.length >= MAX_RAG_PROVIDER_BATCH_ITEMS;
    const exceedsPublicationBudget =
      batch.length > 0 && batchBytes + itemBytes > MAX_RAG_PUBLICATION_BYTES;
    const exceedsCacheBudget =
      options.cacheEmbeddings &&
      batch.length > 0 &&
      estimateRagEmbeddingCacheBytes(batch.length + 1) >
        MAX_RAG_EMBEDDING_CACHE_BYTES;

    if (exceedsItemLimit || exceedsPublicationBudget || exceedsCacheBudget) {
      flush();
    }

    if (
      options.cacheEmbeddings &&
      estimateRagEmbeddingCacheBytes(1) > MAX_RAG_EMBEDDING_CACHE_BYTES
    ) {
      throw new Error("One RAG embedding exceeds the cache byte budget");
    }

    batch.push(item);
    batchBytes += itemBytes;
  }

  flush();
  return batches;
}
