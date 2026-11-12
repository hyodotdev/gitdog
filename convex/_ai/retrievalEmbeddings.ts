import {
  EmbeddingProviderError,
  type EmbeddingClientOptions,
  type EmbeddingDocument,
  type EmbeddingKeys,
  type EmbeddingPolicy,
} from "./embeddings";

export { EmbeddingProviderError };
export type {
  EmbeddingClientOptions,
  EmbeddingDataProvenance,
  EmbeddingDocument,
  EmbeddingKeys,
  EmbeddingPolicy,
  EmbeddingRoute,
} from "./embeddings";

export const EMBEDDING_PROVIDER = "openai" as const;
export const EMBEDDING_MODE = "openai" as const;
export const EMBEDDING_MODEL = "text-embedding-3-small" as const;
export const EMBEDDING_DIMENSIONS = 1536 as const;
export const EMBEDDING_BATCH_SIZE = 32;
export const EMBEDDING_INPUT_TOKEN_LIMIT = 8192;
export const EMBEDDING_PRICE_PER_1M = 0.02;

export type EmbeddingBatchResult = {
  embeddings: number[][];
  tokens: number;
  provider: "google" | "openai";
  model: string;
  dimensions: number;
  route: "free" | "paid";
};
type Config = {
  policy: EmbeddingPolicy;
  keys?: EmbeddingKeys;
  client?: EmbeddingClientOptions;
};

export function getEmbeddingKeys(): EmbeddingKeys {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? { paidApiKey: key } : {};
}

export function applyEmbeddingDataPolicy(
  _policy?: EmbeddingPolicy,
  _provenance?: string,
): EmbeddingPolicy {
  return { route: "paid", allowPaidFallback: false };
}

function fail(
  kind: ConstructorParameters<typeof EmbeddingProviderError>[0],
  message: string,
  options: ConstructorParameters<typeof EmbeddingProviderError>[2] = {},
): never {
  throw new EmbeddingProviderError(kind, message, {
    route: "paid",
    provider: "openai",
    ...options,
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength <= maxBytes
    ? value
    : new TextDecoder().decode(bytes.slice(0, maxBytes), { stream: true });
}

function formatInputs(inputs: Array<EmbeddingDocument | string>): string[] {
  if (
    !Array.isArray(inputs) ||
    inputs.length < 1 ||
    inputs.length > EMBEDDING_BATCH_SIZE
  )
    fail("invalid_input", "Embedding input count is invalid");
  return inputs.map((input) => {
    const content = typeof input === "string" ? input : input.content;
    if (!content.trim()) fail("invalid_input", "Embedding input is empty");
    const title =
      typeof input === "string"
        ? ""
        : truncateUtf8(input.title?.trim() ?? "", 512);
    return truncateUtf8(
      title ? `${title}\n${content}` : content,
      EMBEDDING_INPUT_TOKEN_LIMIT,
    );
  });
}

export function getEmbeddingInputTokenLimit(
  inputs: Array<EmbeddingDocument | string>,
): number {
  return formatInputs(inputs).reduce(
    (total, input) => total + new TextEncoder().encode(input).byteLength,
    0,
  );
}

export async function embedCodeDocuments(
  inputs: EmbeddingDocument[],
  config: Config,
): Promise<EmbeddingBatchResult> {
  const input = formatInputs(inputs);
  const key = (config.keys ?? getEmbeddingKeys()).paidApiKey?.trim();
  if (!key || config.policy.route !== "paid")
    fail("configuration", "OpenAI embedding credentials are not configured");
  const body = JSON.stringify({
    model: EMBEDDING_MODEL,
    input,
    dimensions: EMBEDDING_DIMENSIONS,
    encoding_format: "float",
  });
  await config.client?.beforeProviderRequest?.("paid");
  let response: Response;
  try {
    response = await (config.client?.fetch ?? globalThis.fetch)(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(config.client?.timeoutMs ?? 30_000),
      },
    );
  } catch {
    fail("network", "OpenAI embedding usage could not be verified");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const kind =
      response.status === 429
        ? "rate_limit"
        : response.status === 401 || response.status === 403
          ? "authentication"
          : response.status >= 500 || response.status === 408
            ? "provider"
            : "request";
    fail(kind, `OpenAI embedding request returned HTTP ${response.status}`, {
      httpStatus: response.status,
      retryable: false,
    });
  }
  let data: {
    model?: string;
    usage?: { prompt_tokens?: number; total_tokens?: number };
    data?: Array<{ index?: number; embedding?: number[] }>;
  };
  try {
    data = await response.json();
  } catch {
    fail("invalid_response", "OpenAI embedding response is not JSON");
  }
  const tokens = data.usage?.total_tokens;
  if (
    !Number.isSafeInteger(tokens) ||
    (tokens ?? 0) <= 0 ||
    data.usage?.prompt_tokens !== tokens ||
    (tokens ?? 0) > getEmbeddingInputTokenLimit(inputs)
  )
    fail("invalid_response", "OpenAI embedding usage is invalid");
  const knownBilledTokens = tokens!;
  if (data.model !== EMBEDDING_MODEL)
    fail(
      "invalid_response",
      "OpenAI embedding model does not match the reserved model",
    );
  if (!Array.isArray(data.data) || data.data.length !== input.length)
    fail("invalid_response", "OpenAI embedding response identity is invalid", {
      knownBilledTokens,
    });
  const vectors: number[][] = new Array(input.length);
  for (const row of data.data) {
    if (!row || typeof row !== "object")
      fail("invalid_response", "OpenAI embedding row is invalid", {
        knownBilledTokens,
      });
    const index = row.index;
    if (
      !Number.isInteger(index) ||
      index! < 0 ||
      index! >= input.length ||
      vectors[index!] ||
      !Array.isArray(row.embedding) ||
      row.embedding.length !== EMBEDDING_DIMENSIONS ||
      row.embedding.some((x) => !Number.isFinite(x)) ||
      !row.embedding.some((x) => x !== 0)
    )
      fail("invalid_response", "OpenAI embedding vector is invalid", {
        knownBilledTokens,
      });
    vectors[index!] = row.embedding;
  }
  return {
    embeddings: vectors,
    tokens: knownBilledTokens,
    provider: EMBEDDING_PROVIDER,
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    route: "paid",
  };
}

export async function embedCodeQuery(
  query: string,
  config: Config,
): Promise<EmbeddingBatchResult> {
  return await embedCodeDocuments([{ content: query }], config);
}
export const embedSearchDocuments = embedCodeDocuments;
export const embedSearchQuery = embedCodeQuery;
