/**
 * RAG V2: Chunk-based hybrid search with second-stage ranking
 *
 * Pipeline:
 * 1. Generate embeddings for function/class-level chunks
 * 2. Hybrid search: Vector (cosine) + BM25 (keyword) → RRF fusion
 * 3. Rank top 50 again → final 8
 * 4. MMR diversification
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { normalizeCodeChunksForStorage, parseCodeIntoChunks } from "./parser";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  applyEmbeddingDataPolicy,
  embedCodeDocuments,
  EMBEDDING_PROVIDER,
  EMBEDDING_MODE,
  embedCodeQuery,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_INPUT_TOKEN_LIMIT,
  EMBEDDING_MODEL,
  EmbeddingProviderError,
  getEmbeddingInputTokenLimit,
  getEmbeddingKeys,
  type EmbeddingKeys,
  type EmbeddingDataProvenance,
  type EmbeddingPolicy,
} from "../_ai/retrievalEmbeddings";
import {
  executeEmbeddingRequest,
  PAID_USAGE_LIMIT_MESSAGE,
  resolveEmbeddingBillingDecision,
} from "../_ai/embeddingBilling";
import { requireStrictCurrentAiLegalAttestation } from "../_ai/legalAttestation";
import {
  assertRepositoryEmbeddingProviderRequest,
  RepositoryOwnerLegalEligibilityError,
  resolveFreshRepositoryEmbeddingPolicy,
  resolveStoredRagEmbeddingPolicyWithRefresh,
  type RepositoryEmbeddingPolicyResolution,
} from "../repositories/embeddingPolicyRuntime";
import {
  buildRagChunkPublicationBatches,
  buildRagEmbeddingProviderAttemptKey,
  getUtf8ByteLength,
  MAX_RAG_PROVIDER_BATCH_ITEMS,
  MAX_RAG_SOURCE_BYTES,
  RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS,
  RAG_EMBEDDING_RESERVATION_MAX_WAITS,
  RAG_EMBEDDING_RESERVATION_WAIT_MS,
  RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE,
  truncateUtf8,
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

interface VectorSearchArgs {
  repositoryId: Id<"repositories">;
  indexVersion: number;
  embeddingKey: string;
  queryEmbedding: number[];
  topK: number;
  filters?: ChunkSearchFilters;
}

interface VectorSearchResult {
  chunkId: string;
  path: string;
  similarity: number;
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
}

interface ChunkWithEmbedding {
  chunk: CodeChunk;
  embedding: Array<number>;
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

type RagEmbeddingPublicationExpectation = {
  userId: Id<"users">;
  installationId: number;
  githubRepositoryId: number;
  githubRepo: string;
  githubVisibility?: "public" | "private" | "internal";
  licenseKey?: string;
  licenseSpdxId?: string;
  licenseOsiApproved?: boolean;
  repositoryMetadataCheckedAt?: number;
  licenseOsiCheckedAt?: number;
  embeddingBillingTier: "free" | "paid";
  embeddingKey: string;
  phase: RagIndexPhase;
  cursor?: string;
  fileOffset: number;
  chunkOffset: number;
};

export const CODE_EMBEDDING_KEY = `${EMBEDDING_PROVIDER}:${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}:code_retrieval`;
const MAX_NATIVE_VECTOR_RESULTS = 256;
const MAX_SEARCH_FILTER_LANGUAGES = 8;
const FILE_PAGE_SIZE = 8;
const FILE_FETCH_TIMEOUT_MS = 15000;
const RAG_SOURCE_FETCH_RETRY_BASE_DELAY_MS = 15_000;
const RAG_SOURCE_FETCH_RETRY_MAX_DELAY_MS = 5 * 60_000;
const RAG_SOURCE_FETCH_RETRY_MAX_ATTEMPT = 32;
const RAG_EMBEDDING_RETRY_BASE_DELAY_MS = 10_000;
const RAG_EMBEDDING_RETRY_MAX_DELAY_MS = 2 * 60_000;
const EMBEDDING_FORMAT_TOKEN_ALLOWANCE_BYTES = 128;
const MAX_EMBEDDING_TITLE_BYTES = 1024;
const MAX_EMBEDDING_SYMBOL_BYTES = 512;
const MAX_EMBEDDING_SIGNATURE_BYTES = 512;
const MAX_EMBEDDING_DOCSTRING_BYTES = 768;

const FREE_TIER_CODE_KEYWORDS = new Set([
  "abstract",
  "and",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "defer",
  "do",
  "else",
  "enum",
  "except",
  "export",
  "extends",
  "false",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "go",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "is",
  "let",
  "match",
  "namespace",
  "new",
  "nil",
  "none",
  "not",
  "null",
  "or",
  "package",
  "private",
  "protected",
  "public",
  "raise",
  "return",
  "select",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "use",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);
const FREE_TIER_CODE_TOKEN_PATTERN =
  /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|===|!==|=>|==|!=|<=|>=|&&|\|\||\+\+|--|::|->|[{}()[\];,.?:=+\-*/%<>!&|@#~^]/g;

const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

function appendMaskedSource(
  output: Array<string>,
  source: string,
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index++) {
    const character = source[index];
    output.push(character === "\n" || character === "\r" ? character : " ");
  }
}

function findDelimitedSourceEnd(
  source: string,
  start: number,
  closingDelimiter: string,
): number {
  const closingIndex = source.indexOf(closingDelimiter, start);
  return closingIndex === -1
    ? source.length
    : closingIndex + closingDelimiter.length;
}

function findQuotedSourceEnd(
  source: string,
  start: number,
  delimiter: "'" | '"' | "`" | "'''" | '"""',
): number {
  let index = start + delimiter.length;
  while (index < source.length) {
    if (source[index] === "\\") {
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (source.startsWith(delimiter, index)) {
      return index + delimiter.length;
    }
    index++;
  }
  return source.length;
}

function findRegexSourceEnd(
  source: string,
  start: number,
): { end: number; closed: boolean } {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (character === "\n" || character === "\r") {
      return { end: index, closed: false };
    }
    if (character === "[") {
      inCharacterClass = true;
    } else if (character === "]") {
      inCharacterClass = false;
    } else if (character === "/" && !inCharacterClass) {
      index++;
      while (index < source.length && /[A-Za-z]/.test(source[index])) {
        index++;
      }
      return { end: index, closed: true };
    }
    index++;
  }
  return { end: source.length, closed: false };
}

function findRustRawStringEnd(
  source: string,
  start: number,
): number | undefined {
  const prefix = source.slice(start).match(/^(?:br|r)(#+)"/);
  if (!prefix) {
    return undefined;
  }
  return findDelimitedSourceEnd(
    source,
    start + prefix[0].length,
    `"${prefix[1]}`,
  );
}

function findCppRawStringEnd(
  source: string,
  start: number,
): number | undefined {
  const prefix = source
    .slice(start)
    .match(/^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/);
  if (!prefix) {
    return undefined;
  }
  return findDelimitedSourceEnd(
    source,
    start + prefix[0].length,
    `)${prefix[1]}"`,
  );
}

/**
 * Remove values that can carry prose or secrets before structural tokenizing.
 * This intentionally favors dropping ambiguous syntax over sending literal or
 * comment contents through the unpaid provider route.
 */
function stripFreeTierLiteralAndCommentContents(source: string): string {
  const output: Array<string> = [];
  let index = 0;
  let canStartRegex = true;

  while (index < source.length) {
    const start = index;
    let end: number | undefined;

    if (source.startsWith("<!--", index)) {
      end = findDelimitedSourceEnd(source, index + 4, "-->");
    } else if (source.startsWith("/*", index)) {
      end = findDelimitedSourceEnd(source, index + 2, "*/");
    } else if (source.startsWith("//", index) || source[index] === "#") {
      const newlineIndex = source.slice(index).search(/[\r\n]/);
      end = newlineIndex === -1 ? source.length : index + newlineIndex;
    } else if (source.startsWith("--[[", index)) {
      end = findDelimitedSourceEnd(source, index + 4, "]]");
    } else if (source.startsWith("--", index)) {
      const newlineIndex = source.slice(index).search(/[\r\n]/);
      end = newlineIndex === -1 ? source.length : index + newlineIndex;
    } else {
      const rustRawStringEnd = findRustRawStringEnd(source, index);
      const cppRawStringEnd = findCppRawStringEnd(source, index);
      if (rustRawStringEnd !== undefined) {
        end = rustRawStringEnd;
        canStartRegex = false;
      } else if (cppRawStringEnd !== undefined) {
        end = cppRawStringEnd;
        canStartRegex = false;
      } else if (source.startsWith("'''", index)) {
        end = findQuotedSourceEnd(source, index, "'''");
        canStartRegex = false;
      } else if (source.startsWith('"""', index)) {
        end = findQuotedSourceEnd(source, index, '"""');
        canStartRegex = false;
      } else if (
        source[index] === "'" ||
        source[index] === '"' ||
        source[index] === "`"
      ) {
        end = findQuotedSourceEnd(
          source,
          index,
          source[index] as "'" | '"' | "`",
        );
        canStartRegex = false;
      } else if (source[index] === "/") {
        const regexLiteral = findRegexSourceEnd(source, index);
        if (canStartRegex || regexLiteral.closed) {
          end = regexLiteral.end;
          canStartRegex = false;
        }
      }
    }

    if (end !== undefined) {
      appendMaskedSource(output, source, start, end);
      index = end;
      continue;
    }

    const character = source[index];
    if (/[A-Za-z_$]/.test(character)) {
      let wordEnd = index + 1;
      while (wordEnd < source.length && /[A-Za-z0-9_$]/.test(source[wordEnd])) {
        wordEnd++;
      }
      const word = source.slice(index, wordEnd);
      output.push(word);
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(word.toLowerCase());
      index = wordEnd;
      continue;
    }
    if (/\d/.test(character)) {
      let numberEnd = index + 1;
      while (
        numberEnd < source.length &&
        /[A-Za-z0-9_.]/.test(source[numberEnd])
      ) {
        numberEnd++;
      }
      output.push(source.slice(index, numberEnd));
      canStartRegex = false;
      index = numberEnd;
      continue;
    }

    output.push(character);
    if (!/\s/.test(character)) {
      if (character === ")" || character === "]" || character === ".") {
        canStartRegex = false;
      } else if (character === "}") {
        canStartRegex = true;
      } else {
        canStartRegex = "([{,;:=!?&|+-*%^~<>".includes(character);
      }
    }
    index++;
  }

  return output.join("");
}

type RagEmbeddingMode = "openai" | "keyword_only";
type CodeEmbeddingInputMode = "raw_v1" | "deidentified_v1";

function buildRepositoryIndexKey(
  repositoryId: Id<"repositories">,
  indexVersion: number,
): string {
  return `${repositoryId}:${indexVersion}`;
}

export async function buildRagEmbeddingReservationKey(
  repositoryId: Id<"repositories">,
  documents: ReadonlyArray<{ title?: string; content: string }>,
  chunks: ReadonlyArray<CodeChunk>,
): Promise<string> {
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      embeddingKey: CODE_EMBEDDING_KEY,
      documents,
      sourceChunks: chunks.map((chunk) => ({
        path: chunk.path,
        language: chunk.language,
        code: chunk.code,
        retrievalText: chunk.retrievalText,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbols: chunk.symbols,
        imports: chunk.imports,
        exports: chunk.exports,
        signature: chunk.signature,
        docstring: chunk.docstring,
        searchableText: chunk.searchableText,
      })),
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const digestHex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `rag-index:${repositoryId}:${digestHex}`;
}

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

export function getNextRagEmbeddingProviderRetry(attempt?: number): {
  attempt: number;
  delayMs: number;
} | null {
  const currentAttempt =
    typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 1
      ? Math.min(attempt, RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS)
      : 1;
  if (currentAttempt >= RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS) {
    return null;
  }
  const nextAttempt = currentAttempt + 1;
  return {
    attempt: nextAttempt,
    delayMs: Math.min(
      RAG_EMBEDDING_RETRY_MAX_DELAY_MS,
      RAG_EMBEDDING_RETRY_BASE_DELAY_MS * 2 ** (currentAttempt - 1),
    ),
  };
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

function buildEmbeddingInput(chunk: CodeChunk): string {
  return [
    `Code:\n${chunk.retrievalText ?? chunk.code}`,
    chunk.symbols.length > 0
      ? `Symbols: ${truncateUtf8(
          chunk.symbols.join(", "),
          MAX_EMBEDDING_SYMBOL_BYTES,
        )}`
      : "",
    chunk.signature
      ? `Signature: ${truncateUtf8(
          chunk.signature,
          MAX_EMBEDDING_SIGNATURE_BYTES,
        )}`
      : "",
    chunk.docstring
      ? `Doc: ${truncateUtf8(chunk.docstring, MAX_EMBEDDING_DOCSTRING_BYTES)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildBoundedEmbeddingDocument(
  title: string,
  input: string,
): { title: string; content: string } {
  const encoder = new TextEncoder();
  const boundedTitle =
    truncateUtf8(title.trim(), MAX_EMBEDDING_TITLE_BYTES).trim() || "none";
  const prefix = `title: ${boundedTitle} | text: `;
  const maxFormattedInputBytes =
    EMBEDDING_INPUT_TOKEN_LIMIT - EMBEDDING_FORMAT_TOKEN_ALLOWANCE_BYTES;
  const contentBudget = Math.max(
    1,
    maxFormattedInputBytes - encoder.encode(prefix).byteLength,
  );
  const content = truncateUtf8(input, contentBudget);

  return {
    title: boundedTitle,
    content: content.trim().length > 0 ? content : "Code:",
  };
}

export function buildEmbeddingDocument(chunk: CodeChunk): {
  title: string;
  content: string;
} {
  const title =
    truncateUtf8(chunk.path.trim(), MAX_EMBEDDING_TITLE_BYTES).trim() || "none";
  return buildBoundedEmbeddingDocument(title, buildEmbeddingInput(chunk));
}

/**
 * Produce an irreversible structural representation for unpaid processing.
 * Paths, comments, strings, numbers, and identifier values never leave the
 * deployment through this route; raw source remains available to local BM25.
 */
export function buildFreeTierEmbeddingDocument(chunk: CodeChunk): {
  title: string;
  content: string;
} {
  const source = chunk.retrievalText ?? chunk.code;
  const strippedSource = stripFreeTierLiteralAndCommentContents(source);
  const structuralTokens =
    strippedSource.match(FREE_TIER_CODE_TOKEN_PATTERN) ?? [];
  const structure = structuralTokens
    .map((token) => {
      if (/^[A-Za-z_$]/.test(token)) {
        const normalized = token.toLowerCase();
        return FREE_TIER_CODE_KEYWORDS.has(normalized)
          ? normalized
          : "identifier";
      }
      return /^\d/.test(token) ? "number" : token;
    })
    .join(" ");
  const language = chunk.language.toLowerCase().replace(/[^a-z0-9+#.-]/g, "");

  return buildBoundedEmbeddingDocument(
    `public-open-source-code:${language || "code"}`,
    `Public open-source code structure:\n${structure || "empty"}`,
  );
}

function buildEmbeddingDocumentForMode(
  chunk: CodeChunk,
  mode: CodeEmbeddingInputMode,
): { title: string; content: string } {
  return mode === "deidentified_v1"
    ? buildFreeTierEmbeddingDocument(chunk)
    : buildEmbeddingDocument(chunk);
}

function hasEmbeddingCredentials(keys: EmbeddingKeys): boolean {
  return Boolean(keys.freeApiKey || keys.paidApiKey);
}

function getMissingCredentialReason(policy: EmbeddingPolicy): string {
  return policy.route === "paid"
    ? "Paid Repository embedding credentials are not configured"
    : "Repository embedding credentials are not configured";
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

function resolveEmbeddingKeysForFallback(): {
  keys: EmbeddingKeys;
  configurationError?: string;
} {
  try {
    return { keys: getEmbeddingKeys() };
  } catch (error) {
    return {
      keys: {},
      configurationError: sanitizeEmbeddingError(error),
    };
  }
}

async function performVectorSearch(
  ctx: ActionCtx,
  args: VectorSearchArgs,
): Promise<VectorSearchResult[]> {
  const repositoryIndexKey = buildRepositoryIndexKey(
    args.repositoryId,
    args.indexVersion,
  );
  const embeddingScopeKey = `${repositoryIndexKey}:${args.embeddingKey}`;
  const languages = args.filters?.language;
  const resultPages = await Promise.all(
    (languages?.length ? languages : [undefined]).map(
      async (language) =>
        await ctx.vectorSearch("repoChunks", "by_embedding", {
          vector: args.queryEmbedding,
          limit: Math.min(MAX_NATIVE_VECTOR_RESULTS, args.topK),
          filter: (q) =>
            language
              ? q.eq(
                  "embeddingLanguageScopeKey",
                  `${embeddingScopeKey}:${language}`,
                )
              : q.eq("embeddingScopeKey", embeddingScopeKey),
        }),
    ),
  );
  const resultById = new Map<
    Id<"repoChunks">,
    { _id: Id<"repoChunks">; _score: number }
  >();
  for (const result of resultPages.flat()) {
    const previous = resultById.get(result._id);
    if (!previous || result._score > previous._score) {
      resultById.set(result._id, result);
    }
  }
  const results = Array.from(resultById.values())
    .sort((a, b) => b._score - a._score)
    .slice(0, Math.min(MAX_NATIVE_VECTOR_RESULTS, args.topK));

  const chunks: Array<Doc<"repoChunks">> = await ctx.runQuery(
    internal.ragV2.internalQuery.getChunksByDocIds,
    {
      repositoryId: args.repositoryId,
      indexVersion: args.indexVersion,
      ids: results.map((result) => result._id),
    },
  );
  const scoreById = new Map(
    results.map((result) => [result._id, result._score]),
  );

  return chunks
    .filter(
      (chunk) =>
        chunk.repositoryIndexKey === repositoryIndexKey &&
        chunk.embeddingKey === args.embeddingKey &&
        chunk.embeddingScopeKey === embeddingScopeKey &&
        (!languages?.length ||
          (languages.includes(chunk.language) &&
            chunk.embeddingLanguageScopeKey ===
              `${embeddingScopeKey}:${chunk.language}`)),
    )
    .map((chunk: Doc<"repoChunks">) => ({
      chunkId: chunk.chunkId,
      path: chunk.path,
      similarity: scoreById.get(chunk._id) ?? 0,
    }))
    .sort((a, b) => b.similarity - a.similarity);
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

    const repo = await ctx.runQuery(
      internal.repositories.internalQuery.getById,
      {
        repositoryId: args.repositoryId,
      },
    );

    if (!repo) {
      throw new Error("Repository not found");
    }

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
    const {
      keys: embeddingKeys,
      configurationError: embeddingConfigurationError,
    } = resolveEmbeddingKeysForFallback();
    const embeddingPolicyResolution:
      RepositoryEmbeddingPolicyResolution | undefined = hasEmbeddingCredentials(
      embeddingKeys,
    )
      ? isInitialCall
        ? await resolveFreshRepositoryEmbeddingPolicy(ctx, repo)
        : await resolveStoredRagEmbeddingPolicyWithRefresh(ctx, repo)
      : undefined;
    const requestedEmbeddingPolicy: EmbeddingPolicy =
      embeddingPolicyResolution?.status === "verified_free" ||
      embeddingPolicyResolution?.status === "verified_paid"
        ? embeddingPolicyResolution.policy
        : { route: "paid", allowPaidFallback: false };
    const embeddingBilling =
      embeddingPolicyResolution?.status === "unavailable"
        ? {
            policy: requestedEmbeddingPolicy,
            canEmbed: false,
            paidUsageAllowed: true,
          }
        : await resolveEmbeddingBillingDecision(ctx, {
            provider: EMBEDDING_PROVIDER,
            userId: repo.userId,
            policy: requestedEmbeddingPolicy,
            keys: embeddingKeys,
          });
    const embeddingPolicy = embeddingBilling.policy;
    const hasCurrentLegalAttestation = await ctx.runQuery(
      internal.users.internalQuery.hasCurrentLegalAttestation,
      { userId: repo.userId },
    );
    let legalEligibilityBlocked =
      embeddingBilling.canEmbed && !hasCurrentLegalAttestation;
    let configuredEmbeddingMode: RagEmbeddingMode =
      embeddingBilling.canEmbed && !legalEligibilityBlocked
        ? EMBEDDING_MODE
        : "keyword_only";
    let embeddingMode: RagEmbeddingMode = isInitialCall
      ? configuredEmbeddingMode
      : repo.ragEmbeddingMode === EMBEDDING_MODE &&
          repo.ragEmbeddingKey === CODE_EMBEDDING_KEY &&
          configuredEmbeddingMode === EMBEDDING_MODE
        ? EMBEDDING_MODE
        : "keyword_only";
    let embeddingKey =
      embeddingMode === EMBEDDING_MODE ? CODE_EMBEDDING_KEY : undefined;
    const embeddingPolicyTransition =
      embeddingMode === EMBEDDING_MODE &&
      embeddingPolicyResolution !== undefined &&
      embeddingPolicyResolution.status !== "unavailable"
        ? {
            expectedRepositoryMetadataCheckedAt:
              embeddingPolicyResolution.attestation.repositoryMetadataCheckedAt,
            expectedRagEmbeddingBillingTier:
              embeddingPolicyResolution.attestation.ragEmbeddingBillingTier,
            expectedEmbeddingInputMode:
              embeddingPolicyResolution.attestation.ragEmbeddingBillingTier ===
              "free"
                ? ("deidentified_v1" as const)
                : embeddingPolicyResolution.attestation
                      .ragEmbeddingBillingTier === "paid"
                  ? ("raw_v1" as const)
                  : undefined,
            nextRagEmbeddingBillingTier: embeddingPolicy.route,
            nextEmbeddingInputMode:
              embeddingPolicy.route === "free"
                ? ("deidentified_v1" as const)
                : ("raw_v1" as const),
          }
        : undefined;
    const embeddingUnavailableReason = embeddingConfigurationError
      ? `Repository embedding configuration is invalid: ${embeddingConfigurationError}`
      : legalEligibilityBlocked
        ? "Repository owner must confirm current legal eligibility before embeddings can be processed"
        : embeddingPolicyResolution?.status === "unavailable"
          ? embeddingPolicyResolution.reason
          : !embeddingBilling.paidUsageAllowed && !embeddingBilling.canEmbed
            ? PAID_USAGE_LIMIT_MESSAGE
            : !embeddingBilling.canEmbed
              ? getMissingCredentialReason(embeddingPolicy)
              : "Stored RAG embedding configuration does not match the configured embedding model";
    const embeddingUnavailableMessage = `${embeddingUnavailableReason}; using keyword search only`;
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

    const blockCurrentWorkForLegalEligibility = async (
      error: unknown,
    ): Promise<"blocked" | "legal_current"> => {
      const outcome = await ctx.runMutation(
        internal.ragV2.internalMutation.blockRagForLegalEligibility,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: indexVersion,
          expectedPhase: currentWork.phase,
          expectedCursor: currentWork.cursor,
          expectedFileOffset: currentWork.fileOffset,
          expectedChunkOffset: currentWork.chunkOffset,
          error: sanitizeEmbeddingError(error),
          totalChunks,
          successCount,
          errorCount,
        },
      );
      if (outcome === "stale") {
        throw new Error("Legal eligibility transition lost RAG ownership");
      }
      if (outcome === "legal_current") {
        legalEligibilityBlocked = false;
        configuredEmbeddingMode = EMBEDDING_MODE;
        embeddingMode = EMBEDDING_MODE;
        embeddingKey = CODE_EMBEDDING_KEY;
      } else if (outcome === "blocked") {
        embeddingMode = "keyword_only";
        embeddingKey = undefined;
      }
      return outcome;
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

      let claimed = await ctx.runMutation(
        internal.ragV2.internalMutation.claimRagGeneration,
        {
          repositoryId: args.repositoryId,
          expectedIndexVersion: indexVersion,
          embeddingMode,
          embeddingBillingTier:
            embeddingMode === EMBEDDING_MODE
              ? embeddingPolicy.route
              : undefined,
          embeddingKey,
          embeddingError:
            embeddingMode === "keyword_only"
              ? embeddingUnavailableMessage
              : undefined,
          ...(legalEligibilityBlocked
            ? { legalEligibilityBlocked: true as const }
            : {}),
        },
      );
      if (claimed === "legal_current") {
        embeddingMode = EMBEDDING_MODE;
        embeddingKey = CODE_EMBEDDING_KEY;
        claimed = await ctx.runMutation(
          internal.ragV2.internalMutation.claimRagGeneration,
          {
            repositoryId: args.repositoryId,
            expectedIndexVersion: indexVersion,
            embeddingMode: EMBEDDING_MODE,
            embeddingBillingTier: embeddingPolicy.route,
            embeddingKey,
          },
        );
      }
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

      totalChunks = 0;
      successCount = 0;
      errorCount = 0;
      processedFileMaps = 0;
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
          embeddingPolicyTransition,
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

      if (
        repo.ragEmbeddingMode === "openai" &&
        embeddingMode === "keyword_only"
      ) {
        if (legalEligibilityBlocked) {
          await blockCurrentWorkForLegalEligibility(
            embeddingUnavailableMessage,
          );
        } else {
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

    const getEmbeddingPublicationExpectation =
      (): RagEmbeddingPublicationExpectation => {
        if (
          !embeddingPolicyResolution ||
          embeddingPolicyResolution.status === "unavailable"
        ) {
          throw new EmbeddingProviderError(
            "configuration",
            "Repository embedding publication has no verified policy attestation",
            { route: embeddingPolicy.route, durableRetrySafe: true },
          );
        }

        const { attestation } = embeddingPolicyResolution;
        return {
          userId: attestation.userId,
          installationId: attestation.installationId,
          githubRepositoryId: attestation.githubRepositoryId,
          githubRepo: attestation.githubRepo,
          githubVisibility: attestation.githubVisibility,
          licenseKey: attestation.licenseKey,
          licenseSpdxId: attestation.licenseSpdxId,
          licenseOsiApproved: attestation.licenseOsiApproved,
          repositoryMetadataCheckedAt: attestation.repositoryMetadataCheckedAt,
          licenseOsiCheckedAt: attestation.licenseOsiCheckedAt,
          embeddingBillingTier: embeddingPolicy.route,
          embeddingKey: CODE_EMBEDDING_KEY,
          phase: currentWork.phase,
          cursor: currentWork.cursor,
          fileOffset: currentWork.fileOffset,
          chunkOffset: currentWork.chunkOffset,
        };
      };

    const fetchAndCommitEmbeddingBatch = async (
      chunks: Array<CodeChunk>,
    ): Promise<"cached" | "generated"> => {
      const embeddingInputMode: CodeEmbeddingInputMode =
        embeddingPolicy.route === "free" ? "deidentified_v1" : "raw_v1";
      const chunksWithInputMode = chunks.map((chunk) => ({
        ...chunk,
        embeddingInputMode,
      }));
      const documents = chunksWithInputMode.map((chunk) =>
        buildEmbeddingDocumentForMode(chunk, embeddingInputMode),
      );
      const batchReservationKey = await buildRagEmbeddingReservationKey(
        args.repositoryId,
        documents,
        chunksWithInputMode,
      );
      const providerReservationKey = buildRagEmbeddingProviderAttemptKey(
        batchReservationKey,
        indexVersion,
      );
      const hasCachedBatch = await ctx.runQuery(
        internal.ragV2.internalQuery.hasEmbeddingBatch,
        {
          repositoryId: args.repositoryId,
          reservationKey: batchReservationKey,
          embeddingKey: CODE_EMBEDDING_KEY,
          expectedCount: chunks.length,
        },
      );
      if (hasCachedBatch) {
        const cachedChunkIds = await ctx.runMutation(
          internal.ragV2.internalMutation.commitCachedEmbeddedChunks,
          {
            repositoryId: args.repositoryId,
            indexVersion,
            chunks: chunksWithInputMode,
            batchReservationKey,
            embeddingKey: CODE_EMBEDDING_KEY,
            embeddingPublication: getEmbeddingPublicationExpectation(),
          },
        );
        if (cachedChunkIds !== null && cachedChunkIds.accepted) {
          return "cached";
        }
        if (cachedChunkIds !== null) {
          throw new Error(
            `stale RAG chunk upsert for index version ${indexVersion}`,
          );
        }
      }

      await executeEmbeddingRequest(ctx, {
        provider: EMBEDDING_PROVIDER,
        model: EMBEDDING_MODEL,
        userId: repo.userId,
        repositoryId: args.repositoryId,
        policy: embeddingPolicy,
        keys: embeddingKeys,
        inputCount: documents.length,
        inputTokenLimit: getEmbeddingInputTokenLimit(documents),
        operation: "RAG index",
        reservationKey: providerReservationKey,
        validateProviderRequest: async (route) => {
          if (!embeddingPolicyResolution) {
            throw new EmbeddingProviderError(
              "configuration",
              "Repository embedding policy was not resolved",
              { route, durableRetrySafe: true },
            );
          }
          await assertRepositoryEmbeddingProviderRequest(ctx, {
            resolution: embeddingPolicyResolution,
            route,
            expectedWork: {
              kind: "rag_index",
              indexVersion,
              phase: currentWork.phase,
              cursor: currentWork.cursor,
              fileOffset: currentWork.fileOffset,
              chunkOffset: currentWork.chunkOffset,
              embeddingKey: CODE_EMBEDDING_KEY,
            },
          });
        },
        request: async (policy, client) =>
          await embedCodeDocuments(documents, {
            policy,
            keys: embeddingKeys,
            client,
          }),
        stageProviderOutcome: async ({
          result,
          reservationKey,
          reservationAttemptToken,
        }) => {
          await ctx.runMutation(
            internal.ragV2.internalMutation.stageGeneratedEmbeddingBatch,
            {
              repositoryId: args.repositoryId,
              indexVersion,
              batchReservationKey,
              providerReservationKey: reservationKey,
              providerReservationAttemptToken: reservationAttemptToken,
              embeddingKey: CODE_EMBEDDING_KEY,
              embeddingPublication: getEmbeddingPublicationExpectation(),
              expectedCount: documents.length,
              embeddings: result.embeddings,
              tokens: result.tokens,
              provider: result.provider,
              model: result.model,
            },
          );
        },
        finalize: async ({
          result,
          reservationKey,
          reservationAttemptToken,
        }) => {
          const publication = await ctx.runMutation(
            internal.ragV2.internalMutation.commitEmbeddedChunks,
            {
              repositoryId: args.repositoryId,
              indexVersion,
              batchReservationKey,
              embeddingKey: CODE_EMBEDDING_KEY,
              embeddingPublication: getEmbeddingPublicationExpectation(),
              chunks: chunksWithInputMode.map((chunk, index) => ({
                ...chunk,
                embedding: result.embeddings[index],
                embeddingKey: CODE_EMBEDDING_KEY,
              })),
              usage: {
                tokens: result.tokens,
                model: result.model,
                provider: result.provider,
                billingTier: result.route,
                reservationKey,
                reservationAttemptToken,
              },
            },
          );
          if (!publication.accepted) {
            throw new Error(
              `stale RAG chunk upsert for index version ${indexVersion}`,
            );
          }
        },
      });
      return "generated";
    };

    const upsertProcessedChunkBatch = async (
      processedChunks: Array<{
        chunk: CodeChunk;
        embedding?: Array<number>;
      }>,
    ): Promise<void> => {
      const publishesEmbeddings = processedChunks.some(
        ({ embedding }) => embedding !== undefined,
      );
      const published = await ctx.runMutation(
        internal.ragV2.internalMutation.upsertChunks,
        {
          repositoryId: args.repositoryId,
          chunks: processedChunks.map(({ chunk, embedding }) =>
            embedding
              ? { ...chunk, embedding, embeddingKey: CODE_EMBEDDING_KEY }
              : { ...chunk, embedding: undefined, embeddingKey: undefined },
          ),
          indexVersion,
          embeddingPublication: publishesEmbeddings
            ? getEmbeddingPublicationExpectation()
            : undefined,
        },
      );
      if (published === null) {
        throw new Error(
          `stale RAG chunk upsert for index version ${indexVersion}`,
        );
      }
    };

    const buildProcessedChunkBatches = (
      processedChunks: Array<{
        chunk: CodeChunk;
        embedding?: Array<number>;
      }>,
    ) =>
      buildRagChunkPublicationBatches(
        processedChunks,
        ({ chunk, embedding }) =>
          embedding
            ? { ...chunk, embedding, embeddingKey: CODE_EMBEDDING_KEY }
            : { ...chunk, embedding: undefined, embeddingKey: undefined },
        {
          includeMissingEmbeddings: false,
          cacheEmbeddings: false,
        },
      );

    const processChunks = async (
      chunks: Array<CodeChunk>,
      durablePreWorkCheckpoint: RagWorkCheckpoint,
    ): Promise<"processed" | "yielded"> => {
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

      if (embeddingMode === "keyword_only" || !embeddingKey) {
        await storeWithoutEmbeddings(
          chunks,
          "Error storing keyword-only chunks",
        );
        return "processed";
      }

      const existingChunks = await ctx.runQuery(
        internal.ragV2.internalQuery.getChunksByHashes,
        {
          repositoryId: args.repositoryId,
          contentHashes: chunks.map((chunk) => chunk.contentHash),
          chunkIds: chunks.map((chunk) => chunk.chunkId),
          embeddingKey,
        },
      );

      const chunksNeedingEmbeddings: Array<CodeChunk> = [];
      const chunksWithReusedEmbeddings: Array<ChunkWithEmbedding> = [];
      const embeddingInputMode: CodeEmbeddingInputMode =
        embeddingPolicy.route === "free" ? "deidentified_v1" : "raw_v1";

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const existing = existingChunks[i];

        const currentDocument = buildEmbeddingDocumentForMode(
          chunk,
          embeddingInputMode,
        );
        const existingDocument = existing
          ? buildEmbeddingDocumentForMode(existing, embeddingInputMode)
          : undefined;
        if (
          existing?.embedding &&
          existing.embeddingInputMode === embeddingInputMode &&
          existingDocument?.title === currentDocument.title &&
          existingDocument.content === currentDocument.content
        ) {
          chunksWithReusedEmbeddings.push({
            chunk: { ...chunk, embeddingInputMode },
            embedding: existing.embedding,
          });
        } else {
          chunksNeedingEmbeddings.push(chunk);
        }
      }

      for (const batch of buildProcessedChunkBatches(
        chunksWithReusedEmbeddings,
      )) {
        try {
          await upsertProcessedChunkBatch(batch);
          successCount += batch.length;
          console.log(
            `[RAG V2] Reused embeddings for ${batch.length} chunks from same-repository content hashes`,
          );
        } catch (error) {
          if (isStaleRagChunkUpsertError(error)) {
            throw error;
          }

          errorCount += batch.length;
          console.error(`[RAG V2] Error reusing ${batch.length} embeddings`);
        }
      }

      const embeddingBatches = buildRagChunkPublicationBatches(
        chunksNeedingEmbeddings,
        (chunk) => chunk,
        {
          includeMissingEmbeddings: true,
          cacheEmbeddings: true,
        },
      );
      for (
        let batchIndex = 0;
        batchIndex < embeddingBatches.length;
        batchIndex++
      ) {
        const batch = embeddingBatches[batchIndex];
        try {
          const source = await fetchAndCommitEmbeddingBatch(batch);
          successCount += batch.length;
          console.log(
            `[RAG V2] ${source === "cached" ? "Restored cached" : "Generated and stored"} embeddings for ${batch.length} chunks`,
          );
        } catch (error) {
          if (isStaleRagChunkUpsertError(error)) {
            throw error;
          }

          if (error instanceof RepositoryOwnerLegalEligibilityError) {
            const outcome = await blockCurrentWorkForLegalEligibility(error);
            if (outcome === "legal_current") {
              batchIndex--;
              continue;
            }
            const remainingChunks = embeddingBatches.slice(batchIndex).flat();
            await storeWithoutEmbeddings(
              remainingChunks,
              "Error storing chunks after legal eligibility fallback",
            );
            return "processed";
          }

          if (error instanceof EmbeddingProviderError) {
            if (error.durableRetrySafe) {
              throw error;
            }
            await degradeAndYieldToKeywordOnly(error, durablePreWorkCheckpoint);
            return "yielded";
          }

          errorCount += batch.length;
          console.error("[RAG V2] Error generating embedding batch");
        }
      }
      return "processed";
    };

    console.log(
      `[RAG V2] ${isInitialCall ? "Starting" : "Continuing"} ${currentWork.phase} work`,
    );
    // Repository counters advance only with the work position. A degradation
    // replays this unit, so it must retain the exact durable pre-work counters.
    const durablePreWorkCheckpoint = {
      totalChunks,
      successCount,
      errorCount,
      processedFiles: processedFileMaps,
    };

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
          internal.repoIndexing.mutation.cleanupOldChunks,
          {
            repositoryId: args.repositoryId,
            currentVersion: indexVersion,
            batchSize: RAG_OLD_CHUNK_CLEANUP_BATCH_SIZE,
          },
        );

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

      const filePage = await ctx.runQuery(
        internal.repoIndexing.internalQuery.getRepositoryFilesPage,
        {
          repositoryId: args.repositoryId,
          indexVersion,
          cursor: currentWork.cursor,
          limit: FILE_PAGE_SIZE,
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

      const nextPositionAfterFile = (): RagWorkPosition => {
        const nextFileOffset = currentWork.fileOffset + 1;
        if (nextFileOffset < fileMaps.length) {
          return {
            phase: "files",
            cursor: currentWork.cursor,
            fileOffset: nextFileOffset,
            chunkOffset: 0,
          };
        }

        return nextPositionAfterPage();
      };

      const fileMap = fileMaps[currentWork.fileOffset] as
        RepositoryFileForEmbedding | undefined;
      if (!fileMap) {
        const nextWork = nextPositionAfterPage();
        if (nextWork.phase === "cleanup" && errorCount > 0) {
          await updateRagStatus(
            "failed",
            `RAG embedding completed with ${errorCount} errors`,
          );
        } else {
          await advanceRagWork(nextWork);
        }
        return {
          success: errorCount === 0,
          totalChunks,
          successCount,
          errorCount,
        };
      }

      let nextWork: RagWorkPosition;
      try {
        if (fileMap.isText === false) {
          console.warn(
            `[RAG V2] Skipping non-text source at file offset ${currentWork.fileOffset}`,
          );
          processedFileMaps++;
          nextWork = nextPositionAfterFile();
        } else if (fileMap.size > MAX_RAG_SOURCE_BYTES) {
          console.warn(
            `[RAG V2] Skipping oversized source at file offset ${currentWork.fileOffset} (${fileMap.size} declared bytes)`,
          );
          processedFileMaps++;
          nextWork = nextPositionAfterFile();
        } else {
          if (!fileMap.url) {
            throw new Error("no storage URL");
          }

          const content = await fetchRagSourceContent(fileMap.url);
          const contentBytes = getUtf8ByteLength(content);
          if (contentBytes > MAX_RAG_SOURCE_BYTES) {
            console.warn(
              `[RAG V2] Skipping oversized source at file offset ${currentWork.fileOffset} (${contentBytes} UTF-8 bytes)`,
            );
            processedFileMaps++;
            nextWork = nextPositionAfterFile();
          } else {
            const chunks = normalizeCodeChunksForStorage(
              parseCodeIntoChunks(fileMap.path, content, fileMap.language),
            );
            if (currentWork.chunkOffset === 0) {
              totalChunks += chunks.length;
            }

            if (currentWork.chunkOffset > chunks.length) {
              throw new Error(
                `chunk offset ${currentWork.chunkOffset} exceeds ${chunks.length}`,
              );
            }

            const chunkBatch = chunks.slice(
              currentWork.chunkOffset,
              currentWork.chunkOffset + MAX_RAG_PROVIDER_BATCH_ITEMS,
            );
            if (chunkBatch.length > 0) {
              const chunkOutcome = await processChunks(
                chunkBatch,
                durablePreWorkCheckpoint,
              );
              if (chunkOutcome === "yielded") {
                return {
                  success: true,
                  totalChunks: durablePreWorkCheckpoint.totalChunks,
                  successCount: durablePreWorkCheckpoint.successCount,
                  errorCount: durablePreWorkCheckpoint.errorCount,
                };
              }
            }

            const nextChunkOffset = currentWork.chunkOffset + chunkBatch.length;
            if (nextChunkOffset < chunks.length) {
              nextWork = {
                phase: "files",
                cursor: currentWork.cursor,
                fileOffset: currentWork.fileOffset,
                chunkOffset: nextChunkOffset,
              };
            } else {
              processedFileMaps++;
              nextWork = nextPositionAfterFile();
            }
          }
        }
      } catch (error) {
        if (error instanceof RetryableRagSourceFetchError) {
          const retry = getNextRagSourceFetchRetry(
            args.transientFileFetchAttempt,
          );
          if (!retry) {
            const terminalError = `Repository source fetch at file offset ${currentWork.fileOffset} exhausted ${RAG_SOURCE_FETCH_RETRY_MAX_ATTEMPT} retries; retry repository indexing to resume`;
            await updateRagStatus("failed", terminalError);
            console.error(`[RAG V2] ${terminalError}`);
            return {
              success: false,
              totalChunks,
              successCount,
              errorCount,
            };
          }
          await advanceRagWork(currentWork, {
            kind: "source_fetch",
            ...retry,
          });
          console.warn(
            `[RAG V2] Source fetch at file offset ${currentWork.fileOffset} will retry without advancing its cursor`,
          );
          return {
            success: true,
            totalChunks,
            successCount,
            errorCount,
          };
        }
        if (
          isStaleRagChunkUpsertError(error) ||
          (error instanceof EmbeddingProviderError && error.durableRetrySafe)
        ) {
          throw error;
        }

        errorCount++;
        processedFileMaps++;
        console.error(
          `[RAG V2] Error processing file at offset ${currentWork.fileOffset}`,
        );
        nextWork = nextPositionAfterFile();
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
      if (!(
        error instanceof EmbeddingProviderError &&
        error.durableRetrySafe &&
        error.kind === "reservation_busy"
      )) {
        console.error("[RAG V2] Embedding generation failed");
      }
      if (error instanceof EmbeddingProviderError && error.durableRetrySafe) {
        totalChunks = durablePreWorkCheckpoint.totalChunks;
        successCount = durablePreWorkCheckpoint.successCount;
        errorCount = durablePreWorkCheckpoint.errorCount;
        processedFileMaps = durablePreWorkCheckpoint.processedFiles;
        if (error.kind === "reservation_busy") {
          const waits = args.embeddingQueueAttempt ?? 0;
          if (waits >= RAG_EMBEDDING_RESERVATION_MAX_WAITS) {
            await updateRagStatus(
              "failed",
              "Repository embedding account slot remained busy after 120 waits; the blocked request never entered the provider",
            );
            return { success: false, totalChunks, successCount, errorCount };
          }
          await advanceRagWork(currentWork, {
            kind: "embedding_queue",
            delayMs: RAG_EMBEDDING_RESERVATION_WAIT_MS,
            attempt: waits + 1,
          });
          console.warn(
            "[RAG V2] Waiting for the account embedding slot without consuming a provider attempt",
          );
          return { success: true, totalChunks, successCount, errorCount };
        }
        const retry = getNextRagEmbeddingProviderRetry(
          args.embeddingProviderAttempt,
        );
        if (!retry) {
          const terminalError = `Repository embedding exhausted ${RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS} attempts for the current RAG work unit: ${sanitizeEmbeddingError(error)}`;
          await updateRagStatus("failed", terminalError);
          console.error(`[RAG V2] ${terminalError}`);
          return {
            success: false,
            totalChunks,
            successCount,
            errorCount,
          };
        }
        await advanceRagWork(currentWork, {
          kind: "embedding_provider",
          ...retry,
        });
        console.warn(
          `[RAG V2] Repository embedding attempt ${retry.attempt}/${RAG_EMBEDDING_PROVIDER_MAX_ATTEMPTS} will retry the current work unit after a safe pre-provider failure`,
        );
        return {
          success: true,
          totalChunks,
          successCount,
          errorCount,
        };
      }
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

    // Keyword search is always available, including when Embedding credentials or
    // provider capacity are unavailable.
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

    let vectorResults: Array<VectorSearchResult> = [];
    const {
      keys: embeddingKeys,
      configurationError: embeddingConfigurationError,
    } = resolveEmbeddingKeysForFallback();
    if (embeddingConfigurationError) {
      console.warn(
        `[RAG V2 Hybrid] Repository embedding configuration is invalid; using BM25 only: ${embeddingConfigurationError}`,
      );
    }
    const isVectorSearchCandidate =
      repo.ragStatus === "completed" &&
      repo.ragEmbeddingMode === EMBEDDING_MODE &&
      repo.ragEmbeddingKey === CODE_EMBEDDING_KEY &&
      hasEmbeddingCredentials(embeddingKeys);

    if (isVectorSearchCandidate) {
      try {
        const embeddingPolicyResolution =
          await resolveStoredRagEmbeddingPolicyWithRefresh(ctx, repo);
        if (embeddingPolicyResolution.status === "unavailable") {
          console.warn(
            `[RAG V2 Hybrid] ${embeddingPolicyResolution.reason}; using BM25 only`,
          );
        } else {
          const embeddingDataProvenance: EmbeddingDataProvenance =
            args.embeddingDataProvenance ?? "private_user_input";
          const embeddingBilling = await resolveEmbeddingBillingDecision(ctx, {
            provider: EMBEDDING_PROVIDER,
            userId: repo.userId,
            policy: applyEmbeddingDataPolicy(
              embeddingPolicyResolution.policy,
              embeddingDataProvenance,
            ),
            keys: embeddingKeys,
          });
          const embeddingPolicy = embeddingBilling.policy;
          if (!embeddingBilling.canEmbed) {
            console.warn(
              `[RAG V2 Hybrid] ${
                embeddingBilling.paidUsageAllowed
                  ? "Embedding credentials do not match the repository policy"
                  : PAID_USAGE_LIMIT_MESSAGE
              }; using BM25 only`,
            );
          } else {
            if (args.requestedByUserId) {
              await requireStrictCurrentAiLegalAttestation(
                ctx,
                args.requestedByUserId,
              );
            }
            const embeddingData = await executeEmbeddingRequest(ctx, {
              provider: EMBEDDING_PROVIDER,
              model: EMBEDDING_MODEL,
              userId: repo.userId,
              repositoryId: args.repositoryId,
              policy: embeddingPolicy,
              keys: embeddingKeys,
              inputCount: 1,
              inputTokenLimit: getEmbeddingInputTokenLimit([args.query]),
              operation: "RAG search",
              validateProviderRequest: async (route) => {
                if (args.requestedByUserId) {
                  await requireStrictCurrentAiLegalAttestation(
                    ctx,
                    args.requestedByUserId,
                  );
                }
                return await assertRepositoryEmbeddingProviderRequest(ctx, {
                  resolution: embeddingPolicyResolution,
                  route,
                  expectedWork: {
                    kind: "rag_search",
                    indexVersion,
                    embeddingKey: CODE_EMBEDDING_KEY,
                  },
                });
              },
              request: async (policy, client) =>
                await embedCodeQuery(args.query, {
                  policy,
                  keys: embeddingKeys,
                  client,
                }),
            });

            if (args.requestedByUserId) {
              await requireStrictCurrentAiLegalAttestation(
                ctx,
                args.requestedByUserId,
              );
            }
            vectorResults = await performVectorSearch(ctx, {
              repositoryId: args.repositoryId,
              indexVersion,
              embeddingKey: CODE_EMBEDDING_KEY,
              queryEmbedding: embeddingData.embeddings[0],
              topK: 200,
              filters,
            });
            await assertRepositoryEmbeddingProviderRequest(ctx, {
              resolution: embeddingPolicyResolution,
              route: embeddingData.route,
              expectedWork: {
                kind: "rag_search",
                indexVersion,
                embeddingKey: CODE_EMBEDDING_KEY,
              },
            });
          }
        }
      } catch {
        if (args.requestedByUserId) {
          await requireStrictCurrentAiLegalAttestation(
            ctx,
            args.requestedByUserId,
          );
        }
        vectorResults = [];
        console.warn(
          "[RAG V2 Hybrid] Repository vector search unavailable; using BM25 only",
        );
      }
    }

    console.log(
      `[RAG V2 Hybrid] Vector search found ${vectorResults.length} results`,
    );

    // RRF fusion (get top 30 to avoid 16MB read limit)
    const fusedIds = reciprocalRankFusion([
      vectorResults.map((r: { chunkId: string; similarity: number }) => ({
        id: r.chunkId,
        score: r.similarity,
      })),
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
