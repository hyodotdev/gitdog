import { afterEach, describe, expect, it, vi } from "vitest";
import {
  embedCodeDocuments,
  embedCodeQuery,
  embedSearchDocuments,
  embedSearchQuery,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  getEmbeddingInputTokenLimit,
} from "../../../convex/_ai/retrievalEmbeddings";
const policy = { route: "paid" as const, allowPaidFallback: false };
const keys = { paidApiKey: "test-key" };
const vector = (x = 1) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => x);
const response = (
  data: unknown = [{ index: 0, embedding: vector() }],
  usage: unknown = { prompt_tokens: 2, total_tokens: 2 },
  model = EMBEDDING_MODEL,
) => Response.json({ model, data, usage });
afterEach(() => vi.restoreAllMocks());
describe("OpenAI retrieval embeddings", () => {
  it("orders vectors by index and uses the same model for document and query", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          { index: 1, embedding: vector(2) },
          { index: 0, embedding: vector(1) },
        ]),
      )
      .mockImplementation(async () => response());
    const result = await embedCodeDocuments(
      [
        { title: "src/a.ts", content: "First document" },
        { content: "Second document" },
      ],
      { policy, keys, client: { fetch } },
    );
    expect(result).toMatchObject({
      provider: "openai",
      model: EMBEDDING_MODEL,
      route: "paid",
      tokens: 2,
    });
    expect(result.embeddings.map((v) => v[0])).toEqual([1, 2]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toEqual({
      model: EMBEDDING_MODEL,
      input: ["src/a.ts\nFirst document", "Second document"],
      dimensions: 1536,
      encoding_format: "float",
    });
    for (const call of [
      () => embedCodeQuery("query", { policy, keys, client: { fetch } }),
      () => embedSearchQuery("query", { policy, keys, client: { fetch } }),
      () =>
        embedSearchDocuments([{ content: "learning" }], {
          policy,
          keys,
          client: { fetch },
        }),
    ])
      expect((await call()).model).toBe(EMBEDDING_MODEL);
    expect(
      fetch.mock.calls.every(
        (c) => c[0] === "https://api.openai.com/v1/embeddings",
      ),
    ).toBe(true);
  });
  it("bounds long multilingual input without corrupting UTF-8 or reserving more than sent", async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    const docs = [
      { title: "경로".repeat(2000), content: "한글🙂".repeat(5000) },
    ];
    await embedCodeDocuments(docs, { policy, keys, client: { fetch } });
    const text = JSON.parse(fetch.mock.calls[0][1].body).input[0];
    expect(text).not.toContain("�");
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8192);
    expect(getEmbeddingInputTokenLimit(docs)).toBe(
      new TextEncoder().encode(text).length,
    );
  });
  it.each(
    [
      [],
      [{ content: "" }],
      [{ content: "   " }],
      Array.from({ length: 33 }, () => ({ content: "x" })),
    ].map((documents) => ({ documents })),
  )("rejects invalid input before paid admission", async ({ documents }) => {
    const beforeProviderRequest = vi.fn();
    const fetch = vi.fn();
    await expect(
      embedCodeDocuments(documents, {
        policy,
        keys,
        client: { fetch, beforeProviderRequest },
      }),
    ).rejects.toMatchObject({ kind: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
    expect(beforeProviderRequest).not.toHaveBeenCalled();
  });
  it("keeps the durable admission hook ahead of dispatch", async () => {
    const fetch = vi.fn();
    await expect(
      embedCodeQuery("query", {
        policy,
        keys,
        client: {
          fetch,
          beforeProviderRequest: async () => {
            throw new Error("Access revoked");
          },
        },
      }),
    ).rejects.toThrow("Access revoked");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([400, 401, 402, 403, 408, 429, 500, 503])(
    "does not retry HTTP %i",
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response("error", { status }));
      await expect(
        embedCodeQuery("query", {
          policy,
          keys,
          client: { fetch, maxAttempts: 3 },
        }),
      ).rejects.toMatchObject({
        provider: "openai",
        httpStatus: status,
        retryable: false,
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([
    null,
    {},
    [{ index: 0, embedding: [1] }],
    [{ index: 1, embedding: vector() }],
    [{ index: 0, embedding: vector(0) }],
  ])("retains exact known spend when vector data is invalid", async (data) => {
    const fetch = vi.fn().mockResolvedValue(response(data));
    await expect(
      embedCodeQuery("query", { policy, keys, client: { fetch } }),
    ).rejects.toMatchObject({ kind: "invalid_response", knownBilledTokens: 2 });
  });
  it.each([
    undefined,
    { prompt_tokens: 2, total_tokens: 3 },
    { prompt_tokens: 0, total_tokens: 0 },
    { prompt_tokens: 100, total_tokens: 100 },
  ])("does not invent usage for an invalid token report", async (usage) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        response([{ index: 0, embedding: vector() }], usage ?? null),
      );
    await expect(
      embedCodeQuery("query", { policy, keys, client: { fetch } }),
    ).rejects.toMatchObject({
      kind: "invalid_response",
      knownBilledTokens: undefined,
    });
  });
  it("does not price an unexpected model as the reserved model", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        response(
          [{ index: 0, embedding: vector() }],
          { prompt_tokens: 2, total_tokens: 2 },
          "text-embedding-3-large" as typeof EMBEDDING_MODEL,
        ),
      );
    await expect(
      embedCodeQuery("query", { policy, keys, client: { fetch } }),
    ).rejects.toMatchObject({ knownBilledTokens: undefined });
  });
});
