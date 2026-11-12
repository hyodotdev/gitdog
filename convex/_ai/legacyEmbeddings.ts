/**
 * Gitdog no longer creates embeddings. These identities remain so stored
 * vectors, embedding reservations and historical tokenUsage rows still
 * validate, price and render.
 */
export {
  EmbeddingProviderError,
  type EmbeddingDataProvenance,
  type EmbeddingPolicy,
  type EmbeddingRoute,
} from "./embeddings";

export const EMBEDDING_PROVIDER = "openai" as const;
export const EMBEDDING_MODEL = "text-embedding-3-small" as const;
export const EMBEDDING_DIMENSIONS = 1536 as const;
export const EMBEDDING_BATCH_SIZE = 32;
export const EMBEDDING_INPUT_TOKEN_LIMIT = 8192;
