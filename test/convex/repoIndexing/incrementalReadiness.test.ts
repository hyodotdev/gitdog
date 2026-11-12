import { describe, expect, it } from "vitest";

import {
  getIncrementalIndexEligibility,
  getIncrementalIndexStaleAt,
  hasIncrementalIndexWorkInProgress,
  INDEXING_STALE_THRESHOLD_MS,
} from "../../../convex/repoIndexing/readiness";

describe("incremental index eligibility", () => {
  it("allows a new generation after file and RAG work are stable", () => {
    expect(
      getIncrementalIndexEligibility({
        isActive: true,
        indexStatus: "completed",
        ragStatus: "completed",
        indexProgressAt: 0,
      }),
    ).toEqual({ allowed: true });
  });

  it.each(["pending", "indexing"] as const)(
    "does not replace a %s RAG generation",
    (ragStatus) => {
      expect(
        getIncrementalIndexEligibility({
          isActive: true,
          indexStatus: "completed",
          ragStatus,
          indexProgressAt: 0,
        }),
      ).toEqual({
        allowed: false,
        reason: `RAG indexing already ${ragStatus === "pending" ? "scheduled" : "in progress"}`,
      });
    },
  );

  it("treats an active file-index generation as transient work to coalesce", () => {
    expect(
      getIncrementalIndexEligibility({
        isActive: true,
        indexStatus: "indexing",
        ragStatus: "pending",
        indexProgressAt: 0,
      }),
    ).toEqual({ allowed: false, reason: "indexing already in progress" });
  });

  it("keeps fresh work locked even when manual stale recovery is requested", () => {
    const now = 2_000_000;
    const repository = {
      isActive: true,
      indexStatus: "indexing" as const,
      ragStatus: "pending" as const,
      indexProgressAt: now - INDEXING_STALE_THRESHOLD_MS + 1,
    };

    expect(
      getIncrementalIndexEligibility(repository, {
        allowStaleIndexRecovery: true,
        now,
      }),
    ).toEqual({ allowed: false, reason: "indexing already in progress" });
    expect(getIncrementalIndexStaleAt(repository)).toBe(now + 1);

    expect(
      getIncrementalIndexEligibility(
        {
          ...repository,
          indexStatus: "completed",
          ragStatus: "indexing",
        },
        { allowStaleIndexRecovery: true, now },
      ),
    ).toEqual({
      allowed: false,
      reason: "RAG indexing already in progress",
    });
  });

  it("does not let unrelated repository updates mask a stale heartbeat", () => {
    const now = 4_000_000;
    const repository = {
      isActive: true,
      indexStatus: "indexing" as const,
      ragStatus: "pending" as const,
      indexProgressAt: now - INDEXING_STALE_THRESHOLD_MS,
      updatedAt: now,
    };

    expect(getIncrementalIndexStaleAt(repository)).toBe(now);
    expect(
      getIncrementalIndexEligibility(repository, {
        allowStaleIndexRecovery: true,
        now,
      }),
    ).toEqual({ allowed: true });
  });

  it.each([
    { indexStatus: "indexing" as const, ragStatus: "pending" as const },
    { indexStatus: "completed" as const, ragStatus: "indexing" as const },
  ])(
    "allows explicit recovery when active $indexStatus/$ragStatus work is stale",
    ({ indexStatus, ragStatus }) => {
      const now = 3_000_000;
      const repository = {
        isActive: true,
        indexStatus,
        ragStatus,
        indexProgressAt: now - INDEXING_STALE_THRESHOLD_MS,
      };

      expect(getIncrementalIndexEligibility(repository, { now })).toMatchObject(
        { allowed: false },
      );
      expect(
        getIncrementalIndexEligibility(repository, {
          allowStaleIndexRecovery: true,
          now,
        }),
      ).toEqual({ allowed: true });
    },
  );

  it("still allows a new full pass to recover from a failed RAG generation", () => {
    expect(
      getIncrementalIndexEligibility({
        isActive: true,
        indexStatus: "completed",
        ragStatus: "failed",
      }),
    ).toEqual({ allowed: true });
  });

  it("allows only an explicit recovery to retry a failed file index", () => {
    const failedRepository = {
      isActive: true,
      indexStatus: "failed" as const,
      // Older failed passes can leave the reserved RAG status pending.
      ragStatus: "pending" as const,
      indexProgressAt: 0,
    };

    expect(getIncrementalIndexEligibility(failedRepository)).toEqual({
      allowed: false,
      reason: "initial indexing not completed",
    });
    expect(
      getIncrementalIndexEligibility(failedRepository, {
        allowFailedIndexRecovery: true,
      }),
    ).toEqual({ allowed: true });
    expect(hasIncrementalIndexWorkInProgress(failedRepository)).toBe(false);
  });

  it("does not recover a failed file index over active RAG work", () => {
    expect(
      getIncrementalIndexEligibility(
        {
          isActive: true,
          indexStatus: "failed",
          ragStatus: "indexing",
          indexProgressAt: 0,
        },
        { allowFailedIndexRecovery: true },
      ),
    ).toEqual({
      allowed: false,
      reason: "RAG indexing already in progress",
    });
  });

  it("recognizes file or RAG work that should coalesce another sync", () => {
    expect(
      hasIncrementalIndexWorkInProgress({
        isActive: true,
        indexStatus: "completed",
        ragStatus: "indexing",
        indexProgressAt: 0,
      }),
    ).toBe(true);
    expect(
      hasIncrementalIndexWorkInProgress({
        isActive: true,
        indexStatus: "completed",
        ragStatus: "completed",
        indexProgressAt: 0,
      }),
    ).toBe(false);
  });

  it("blocks paused repositories", () => {
    expect(
      getIncrementalIndexEligibility({
        isActive: false,
        indexStatus: "completed",
        ragStatus: "completed",
        indexProgressAt: 0,
      }),
    ).toEqual({ allowed: false, reason: "repository is paused" });
  });
});
