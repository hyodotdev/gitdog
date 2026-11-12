import { describe, expect, it } from "vitest";

import {
  calculateReadinessRetryDelay,
  getRepositoryAiReadiness,
  getReadinessRetryWindow,
  READINESS_ABSOLUTE_TIMEOUT_MS,
  READINESS_STALL_TIMEOUT_MS,
} from "../../../convex/repositories/aiReadiness";

const currentRepositoryState = {
  isActive: true,
  indexSyncPending: false,
  ragTotalChunks: 0,
  ragIndexedChunks: 0,
  ragFailedChunks: 0,
} as const;

describe("repository AI readiness", () => {
  it("is ready only when file and RAG indexes match a completed version", () => {
    expect(
      getRepositoryAiReadiness({
        ...currentRepositoryState,
        indexStatus: "completed",
        ragStatus: "completed",
        indexVersion: 7,
      }),
    ).toEqual({ state: "ready", indexVersion: 7 });
  });

  it.each([
    { indexStatus: "pending" as const, ragStatus: "pending" as const },
    { indexStatus: "indexing" as const, ragStatus: "pending" as const },
    { indexStatus: "completed" as const, ragStatus: "pending" as const },
    { indexStatus: "completed" as const, ragStatus: "indexing" as const },
  ])("marks transient index state as waiting: %o", (statuses) => {
    expect(
      getRepositoryAiReadiness({
        ...currentRepositoryState,
        indexVersion: 3,
        ...statuses,
      }),
    ).toMatchObject({ state: "waiting", indexVersion: 3 });
  });

  it("waits while a coalesced push is queued behind completed indexes", () => {
    expect(
      getRepositoryAiReadiness({
        ...currentRepositoryState,
        indexStatus: "completed",
        ragStatus: "completed",
        indexVersion: 3,
        indexSyncPending: true,
      }),
    ).toMatchObject({ state: "waiting", indexVersion: 3 });
  });

  it.each([
    { githubAccessRestoreIndexPending: true },
    { githubAccessRestoreIndexNextAttemptAt: 123_456 },
  ])("waits for access-restore indexing markers: %o", (restoreState) => {
    expect(
      getRepositoryAiReadiness({
        ...currentRepositoryState,
        indexStatus: "failed",
        ragStatus: "failed",
        indexVersion: 3,
        ...restoreState,
      }),
    ).toEqual({
      state: "waiting",
      reason: "repository access restore indexing is pending",
      indexVersion: 3,
    });
  });

  it.each([
    {
      ...currentRepositoryState,
      isActive: false,
      indexStatus: "completed" as const,
      ragStatus: "completed" as const,
    },
    {
      ...currentRepositoryState,
      indexStatus: "failed" as const,
      ragStatus: "pending" as const,
    },
    {
      ...currentRepositoryState,
      indexStatus: "completed" as const,
      ragStatus: "failed" as const,
    },
  ])("marks state requiring intervention as blocked: %o", (repository) => {
    expect(getRepositoryAiReadiness(repository).state).toBe("blocked");
  });

  it("backs off transient retries without exceeding five minutes", () => {
    expect(calculateReadinessRetryDelay(0)).toBe(15_000);
    expect(calculateReadinessRetryDelay(1)).toBe(30_000);
    expect(calculateReadinessRetryDelay(4)).toBe(240_000);
    expect(calculateReadinessRetryDelay(5)).toBe(300_000);
    expect(calculateReadinessRetryDelay(50)).toBe(300_000);
  });

  it("times out only after a full inactivity window", () => {
    const repository = {
      ...currentRepositoryState,
      indexVersion: 7,
      indexStatus: "indexing" as const,
      ragStatus: "pending" as const,
      updatedAt: 100,
    };
    const initial = getReadinessRetryWindow(repository, {}, 1_000);
    const beforeTimeout = getReadinessRetryWindow(
      repository,
      initial,
      1_000 + READINESS_STALL_TIMEOUT_MS - 1,
    );
    const timedOut = getReadinessRetryWindow(
      repository,
      initial,
      1_000 + READINESS_STALL_TIMEOUT_MS,
    );

    expect(beforeTimeout.timeoutReason).toBeUndefined();
    expect(timedOut.timeoutReason).toContain("no observable progress");
  });

  it("resets inactivity when indexing progress changes", () => {
    const initial = getReadinessRetryWindow(
      {
        ...currentRepositoryState,
        indexVersion: 7,
        indexStatus: "completed",
        ragStatus: "indexing",
        ragIndexedChunks: 5,
      },
      {},
      1_000,
    );
    const progressed = getReadinessRetryWindow(
      {
        ...currentRepositoryState,
        indexVersion: 7,
        indexStatus: "completed",
        ragStatus: "indexing",
        ragIndexedChunks: 10,
      },
      initial,
      1_000 + READINESS_STALL_TIMEOUT_MS,
    );

    expect(progressed.progressAt).toBe(1_000 + READINESS_STALL_TIMEOUT_MS);
    expect(progressed.timeoutReason).toBeUndefined();
  });

  it("keeps an absolute deadline during continuous progress", () => {
    const initial = getReadinessRetryWindow(
      {
        ...currentRepositoryState,
        indexVersion: 1,
        indexStatus: "pending",
        ragStatus: "pending",
      },
      {},
      1_000,
    );
    const timedOut = getReadinessRetryWindow(
      {
        ...currentRepositoryState,
        indexVersion: 2,
        indexStatus: "pending",
        ragStatus: "pending",
      },
      initial,
      1_000 + READINESS_ABSOLUTE_TIMEOUT_MS,
    );

    expect(timedOut.timeoutReason).toContain("within seven days");
  });
});
