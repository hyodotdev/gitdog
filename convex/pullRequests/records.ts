import { v } from "convex/values";
import type { ReviewTraceEvent } from "./workflow";

// How long a review run's per-step trace is kept for quality checks.
export const REVIEW_TRACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TRACE_STEPS = 24;
const MAX_STEP_ENTRIES = 30;
const MAX_TITLE_LENGTH = 200;
const MAX_PATH_LENGTH = 300;

export const reviewTraceStepValidator = v.object({
  step: v.string(),
  proposed: v.optional(
    v.array(
      v.object({
        path: v.string(),
        priority: v.string(),
        confidence: v.number(),
        title: v.string(),
      }),
    ),
  ),
  kept: v.optional(v.array(v.string())),
  discarded: v.optional(v.array(v.string())),
});

export type ReviewTraceStep = typeof reviewTraceStepValidator.type;

const text = (value: unknown, limit: number) =>
  (typeof value === "string" ? value : "").slice(0, limit);

/** A bounded copy of what each review step proposed and kept. */
export function summarizeReviewTrace(events: ReviewTraceEvent[]): {
  trace: ReviewTraceStep[];
  steps: number;
  candidates: number;
  discarded: number;
} {
  let candidates = 0;
  let discarded = 0;
  const trace: ReviewTraceStep[] = [];
  for (const event of events) {
    if (event.stage === "proposed") {
      candidates += event.candidates.length;
      trace.push({
        step: text(event.step, MAX_PATH_LENGTH),
        proposed: event.candidates.slice(0, MAX_STEP_ENTRIES).map((c) => ({
          path: text(c.path, MAX_PATH_LENGTH),
          priority: text(c.priority, 8),
          confidence:
            typeof c.confidence === "number" && Number.isFinite(c.confidence)
              ? c.confidence
              : 0,
          title: text(c.title, MAX_TITLE_LENGTH),
        })),
      });
    } else {
      discarded += event.discarded.length;
      trace.push({
        step: text(event.step, MAX_PATH_LENGTH),
        kept: event.kept
          .slice(0, MAX_STEP_ENTRIES)
          .map((t) => text(t, MAX_TITLE_LENGTH)),
        discarded: event.discarded
          .slice(0, MAX_STEP_ENTRIES)
          .map((t) => text(t, MAX_TITLE_LENGTH)),
      });
    }
  }
  return {
    trace: trace.slice(0, MAX_TRACE_STEPS),
    steps: events.filter((e) => e.stage === "proposed").length,
    candidates,
    discarded,
  };
}
