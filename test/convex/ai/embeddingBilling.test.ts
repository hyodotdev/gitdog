import { afterEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import {
  executeEmbeddingRequest,
  recordEmbeddingUsage,
  resolveEmbeddingBillingDecision,
} from "../../../convex/_ai/embeddingBilling";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EmbeddingProviderError,
  type EmbeddingBatchResult,
  type EmbeddingClientOptions,
  type EmbeddingPolicy,
} from "../../../convex/_ai/retrievalEmbeddings";

const userId = "users:test" as Id<"users">;
const repositoryId = "repositories:test" as Id<"repositories">;

type ProviderRequestClient = Required<
  Pick<EmbeddingClientOptions, "beforeProviderRequest">
>;

async function enterProviderRequest(
  policy: EmbeddingPolicy,
  client: ProviderRequestClient,
): Promise<void> {
  await client.beforeProviderRequest(policy.route);
}

function createResult(
  route: "free" | "paid",
  tokens = 12,
): EmbeddingBatchResult {
  return {
    embeddings: [Array(EMBEDDING_DIMENSIONS).fill(0.01)],
    tokens,
    provider: "openai",
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    route,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI embedding billing guard", () => {
  it("blocks paid-only embeddings before the provider call when quota is denied", async () => {
    const runQuery = vi.fn(async () => ({
      allowed: false as const,
      reason: "limit_reached" as const,
    }));
    const ctx = { runQuery } as unknown as ActionCtx;

    await expect(
      resolveEmbeddingBillingDecision(ctx, {
        userId,
        provider: "openai",
        policy: { route: "paid", allowPaidFallback: false },
        keys: { freeApiKey: "free-key", paidApiKey: "paid-key" },
      }),
    ).resolves.toEqual({
      policy: { route: "paid", allowPaidFallback: false },
      canEmbed: false,
      paidUsageAllowed: false,
    });
    expect(runQuery).toHaveBeenCalledOnce();
  });
});

describe("AI embedding usage metering", () => {
  it("records a paid result after its finalizer fails without retrying AI", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "paid-finalizer-failure",
      })
      .mockResolvedValueOnce({ started: true, alreadyStarted: false })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: "finalized" });
    const result = createResult("paid", 19);
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        return result;
      },
    );
    const finalize = vi.fn(async () => {
      throw new Error("stale paid publication");
    });
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG index",
        reservationKey: "paid-finalizer-failure",
        request,
        finalize,
      }),
    ).rejects.toThrow("stale paid publication");
    expect(request).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(runMutation).toHaveBeenCalledTimes(4);
    expect(runMutation).toHaveBeenNthCalledWith(3, expect.anything(), {
      reservationKey: "paid-finalizer-failure",
      attemptToken: expect.any(String),
      userId,
      repositoryId,
      tokens: 19,
      provider: "openai",
      model: EMBEDDING_MODEL,
    });
  });

  it("rejects a mismatched paid result route without releasing its started reservation", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "paid-route-mismatch",
      })
      .mockResolvedValueOnce({ started: true, alreadyStarted: false });
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        return createResult("free", 19);
      },
    );
    const finalize = vi.fn(async () => undefined);
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG index",
        reservationKey: "paid-route-mismatch",
        request,
        finalize,
      }),
    ).rejects.toMatchObject({
      kind: "invalid_response",
      retryable: false,
      route: "paid",
      durableRetrySafe: false,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
    expect(runMutation).toHaveBeenCalledTimes(3);
    expect(runMutation.mock.calls[2]?.[1]).toMatchObject({
      reservationKey: "paid-route-mismatch",
      userId,
      repositoryId,
    });
  });

  it("rejects paid embeddings with missing token usage before metering", async () => {
    const runMutation = vi.fn();
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      recordEmbeddingUsage(ctx, {
        userId,
        repositoryId,
        result: createResult("paid", 0),
        operation: "RAG search",
      }),
    ).rejects.toMatchObject({
      name: "EmbeddingProviderError",
      kind: "invalid_response",
      retryable: false,
      route: "paid",
    });
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("throws one sanitized non-retryable error when paid metering fails", async () => {
    const runMutation = vi.fn(async () => {
      throw new Error("sensitive-paid-metering-error");
    });
    const ctx = { runMutation } as unknown as ActionCtx;

    let thrown: unknown;
    try {
      await recordEmbeddingUsage(ctx, {
        userId,
        repositoryId,
        result: createResult("paid"),
        operation: "repository learning create",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EmbeddingProviderError);
    expect(thrown).toMatchObject({
      kind: "provider",
      retryable: false,
      route: "paid",
    });
    expect(String(thrown)).not.toContain("sensitive-paid-metering-error");
    expect(runMutation).toHaveBeenCalledOnce();
  });

  it("marks a transient reservation failure retryable before calling AI", async () => {
    const runMutation = vi.fn(async () => {
      throw new Error("transient Convex mutation failure");
    });
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        return createResult("paid");
      },
    );
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG search",
        request,
      }),
    ).rejects.toMatchObject({
      name: "EmbeddingProviderError",
      kind: "request",
      retryable: true,
      route: "paid",
    });
    expect(runMutation).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("retries a competing owner without entering the paid provider", async () => {
    const runMutation = vi.fn(async () => ({
      allowed: false as const,
      reason: "attempt_in_progress" as const,
    }));
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        return createResult("paid");
      },
    );
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG search",
        reservationKey: "competing-owner",
        request,
      }),
    ).rejects.toMatchObject({
      kind: "reservation_busy",
      retryable: true,
      route: "paid",
      durableRetrySafe: true,
    });
    expect(runMutation).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("retries after another account-level paid provider attempt finishes", async () => {
    const runMutation = vi.fn(async () => ({
      allowed: false as const,
      reason: "provider_attempt_in_progress" as const,
    }));
    const request = vi.fn();
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG search",
        request,
      }),
    ).rejects.toMatchObject({
      kind: "reservation_busy",
      retryable: true,
      route: "paid",
      durableRetrySafe: true,
      message: expect.stringContaining("already in progress"),
    });
    expect(runMutation).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "reservation_finalized",
    "provider_already_started",
    "reservation_closed",
  ] as const)(
    "propagates terminal paid reservation reason %s without entering the provider",
    async (paidReservationReason) => {
      const runMutation = vi.fn(async () => ({
        allowed: false as const,
        reason: paidReservationReason,
      }));
      const request = vi.fn(
        async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
          await enterProviderRequest(policy, client);
          return createResult("paid");
        },
      );
      const ctx = { runMutation } as unknown as ActionCtx;

      await expect(
        executeEmbeddingRequest(ctx, {
          userId,
          repositoryId,
          provider: "openai",
          model: EMBEDDING_MODEL,
          policy: { route: "paid", allowPaidFallback: false },
          keys: { paidApiKey: "paid-key" },
          inputCount: 1,
          inputTokenLimit: 128,
          operation: "RAG index",
          reservationKey: "terminal-reservation",
          request,
        }),
      ).rejects.toMatchObject({
        kind: "request",
        retryable: false,
        route: "paid",
        durableRetrySafe: false,
        paidReservationReason,
        message: expect.stringContaining("cannot be retried safely"),
      });
      expect(runMutation).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("queues a slot lost after reservation and releases it before provider fetch", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "reservation-key",
      })
      .mockResolvedValueOnce({
        started: false,
        reason: "provider_attempt_in_progress",
      })
      .mockResolvedValue(undefined);
    const providerFetch = vi.fn();
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        providerFetch();
        return createResult("paid");
      },
    );
    await expect(
      executeEmbeddingRequest({ runMutation } as unknown as ActionCtx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG index",
        reservationKey: "reservation-key",
        request,
      }),
    ).rejects.toMatchObject({
      kind: "reservation_busy",
      durableRetrySafe: true,
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(runMutation).toHaveBeenCalledTimes(3);
    expect(runMutation.mock.calls[2][1]).toMatchObject({
      confirmedNotBilled: true,
    });
  });

  it("reuses a committed provider-start marker after its response is lost", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "reservation-key",
      })
      .mockRejectedValueOnce(new Error("provider-start response was lost"))
      .mockResolvedValueOnce({ started: true, alreadyStarted: true })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: "finalized" });
    const providerFetch = vi.fn();
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        providerFetch();
        return createResult("paid");
      },
    );
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG search",
        reservationKey: "reservation-key",
        request,
      }),
    ).resolves.toMatchObject({ route: "paid" });
    expect(runMutation).toHaveBeenCalledTimes(6);
    expect(request).toHaveBeenCalledOnce();
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("safely releases a start marker when every pre-fetch response is lost", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "start-response-unavailable",
      })
      .mockRejectedValueOnce(new Error("first response was lost"))
      .mockRejectedValueOnce(new Error("second response was lost"))
      .mockRejectedValueOnce(new Error("third response was lost"))
      .mockResolvedValueOnce(true);
    const providerFetch = vi.fn();
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        providerFetch();
        return createResult("paid");
      },
    );
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG search",
        reservationKey: "start-response-unavailable",
        request,
      }),
    ).rejects.toMatchObject({
      name: "EmbeddingProviderError",
      kind: "request",
      durableRetrySafe: true,
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(runMutation).toHaveBeenCalledTimes(5);
    expect(runMutation.mock.calls[4]?.[1]).toMatchObject({
      reservationKey: "start-response-unavailable",
      confirmedNotBilled: true,
    });
  });

  it("releases paid quota when local validation fails before the provider boundary", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "local-validation",
      })
      .mockResolvedValueOnce(true);
    const request = vi.fn(async () => {
      throw new EmbeddingProviderError(
        "invalid_input",
        "local validation failed",
        { retryable: false, route: "paid", durableRetrySafe: true },
      );
    });
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG index",
        reservationKey: "local-validation",
        request,
      }),
    ).rejects.toMatchObject({
      kind: "invalid_input",
      durableRetrySafe: true,
      route: "paid",
    });
    expect(request).toHaveBeenCalledOnce();
    expect(runMutation).toHaveBeenCalledTimes(2);
  });

  it("retries a transient release mutation failure", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "release-retry",
      })
      .mockRejectedValueOnce(new Error("transient release failure"))
      .mockResolvedValueOnce(true);
    const request = vi.fn(async () => {
      throw new EmbeddingProviderError(
        "invalid_input",
        "local validation failed",
        { retryable: false, route: "paid", durableRetrySafe: true },
      );
    });
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG index",
        reservationKey: "release-retry",
        request,
      }),
    ).rejects.toMatchObject({ kind: "invalid_input", route: "paid" });
    expect(runMutation).toHaveBeenCalledTimes(3);
    expect(runMutation).toHaveBeenNthCalledWith(2, expect.anything(), {
      reservationKey: "release-retry",
      attemptToken: expect.any(String),
      userId,
      repositoryId,
      confirmedNotBilled: true,
    });
    expect(runMutation).toHaveBeenNthCalledWith(3, expect.anything(), {
      reservationKey: "release-retry",
      attemptToken: expect.any(String),
      userId,
      repositoryId,
      confirmedNotBilled: true,
    });
  });

  it("immediately marks an ambiguous paid provider attempt", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "ambiguous-reservation",
      })
      .mockResolvedValueOnce({ started: true, alreadyStarted: false });
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        throw new EmbeddingProviderError(
          "network",
          "ambiguous network failure",
          { retryable: true, route: "paid" },
        );
      },
    );
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG index",
        reservationKey: "ambiguous-reservation",
        request,
      }),
    ).rejects.toMatchObject({ kind: "network", route: "paid" });
    expect(runMutation).toHaveBeenCalledTimes(3);
    expect(runMutation.mock.calls[2]?.[1]).toMatchObject({
      reservationKey: "ambiguous-reservation",
      userId,
      repositoryId,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps HTTP 499 paid usage ambiguous instead of releasing it", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "http-499-ambiguous",
      })
      .mockResolvedValueOnce({ started: true, alreadyStarted: false })
      .mockResolvedValueOnce(true);
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        throw new EmbeddingProviderError(
          "request",
          "provider cancelled after request start",
          {
            retryable: false,
            route: "paid",
            httpStatus: 499,
          },
        );
      },
    );
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG index",
        reservationKey: "http-499-ambiguous",
        request,
      }),
    ).rejects.toMatchObject({
      kind: "request",
      route: "paid",
      httpStatus: 499,
    });
    expect(runMutation).toHaveBeenCalledTimes(3);
    expect(runMutation).toHaveBeenNthCalledWith(3, expect.anything(), {
      reservationKey: "http-499-ambiguous",
      attemptToken: expect.any(String),
      userId,
      repositoryId,
    });
  });

  it("settles exact usage when paid vector parsing fails", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "known-billed-invalid-vector",
      })
      .mockResolvedValueOnce({ started: true, alreadyStarted: false })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: "finalized" });
    const providerError = new EmbeddingProviderError(
      "invalid_response",
      "AI embedding response has invalid vector data",
      {
        provider: "openai",
        retryable: true,
        route: "paid",
        knownBilledTokens: 17,
      },
    );
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        throw providerError;
      },
    );
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG index",
        reservationKey: "known-billed-invalid-vector",
        request,
      }),
    ).rejects.toBe(providerError);
    expect(runMutation).toHaveBeenCalledTimes(4);
    expect(runMutation).toHaveBeenNthCalledWith(3, expect.anything(), {
      reservationKey: "known-billed-invalid-vector",
      attemptToken: expect.any(String),
      userId,
      repositoryId,
      tokens: 17,
      provider: "openai",
      model: EMBEDDING_MODEL,
    });
    expect(runMutation).toHaveBeenNthCalledWith(4, expect.anything(), {
      reservationKey: "known-billed-invalid-vector",
      attemptToken: expect.any(String),
      fromScheduler: false,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("releases an explicitly rejected paid provider attempt", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        reservationKey: "rejected-reservation",
      })
      .mockResolvedValueOnce({ started: true, alreadyStarted: false })
      .mockResolvedValueOnce(true);
    const request = vi.fn(
      async (policy: EmbeddingPolicy, client: ProviderRequestClient) => {
        await enterProviderRequest(policy, client);
        throw new EmbeddingProviderError(
          "rate_limit",
          "explicit provider rejection",
          {
            retryable: true,
            route: "paid",
            httpStatus: 429,
          },
        );
      },
    );
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      executeEmbeddingRequest(ctx, {
        userId,
        repositoryId,
        provider: "openai",
        model: EMBEDDING_MODEL,
        policy: { route: "paid", allowPaidFallback: false },
        keys: { paidApiKey: "paid-key" },
        inputCount: 1,
        inputTokenLimit: 128,
        operation: "RAG index",
        reservationKey: "rejected-reservation",
        request,
      }),
    ).rejects.toMatchObject({ kind: "rate_limit", route: "paid" });
    expect(runMutation).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledOnce();
  });
});
