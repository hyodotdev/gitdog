import { describe, expect, it } from "vitest";
import { summarizeReviewTrace } from "../../../convex/pullRequests/records";
import type { ReviewTraceEvent } from "../../../convex/pullRequests/workflow";

const proposed = (step: string, count = 1): ReviewTraceEvent => ({
  stage: "proposed",
  step,
  candidates: Array.from({ length: count }, (_, i) => ({
    path: `src/${i}.ts`,
    priority: "P2",
    confidence: 0.9,
    title: `Finding ${i}`,
  })),
});

describe("review trace summary", () => {
  it("counts every step and keeps the first and last of a long trace", () => {
    const events = [
      ...Array.from({ length: 20 }, (_, i) => proposed(`main/${i}`, 2)),
      {
        stage: "verified",
        step: "pr-review/critique",
        kept: ["Finding 0"],
        discarded: ["Finding 1"],
      } as const,
    ];
    const summary = summarizeReviewTrace(events);
    expect(summary).toMatchObject({ steps: 20, candidates: 40, discarded: 1 });
    expect(summary.trace).toHaveLength(16);
    expect(summary.trace[0].step).toBe("main/0");
    expect(summary.trace.at(-1)).toEqual({
      step: "pr-review/critique",
      kept: ["Finding 0"],
      discarded: ["Finding 1"],
    });
  });

  it("bounds entries and text, and never stores non-text values", () => {
    const [step] = summarizeReviewTrace([
      {
        stage: "proposed",
        step: "main/0",
        candidates: [
          ...Array.from({ length: 30 }, () => ({
            path: { nested: true },
            priority: "P1-and-much-more",
            confidence: Number.NaN,
            title: `${"x".repeat(159)}😀tail`,
          })),
        ],
      },
    ]).trace;
    expect(step.proposed).toHaveLength(15);
    expect(step.proposed?.[0]).toEqual({
      path: "",
      priority: "P1-and-m",
      confidence: 0,
      title: `${"x".repeat(159)}😀`,
    });
  });
});
