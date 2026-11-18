import { v } from "convex/values";
import type { ReviewTraceEvent } from "./workflow";

// How long a review run's per-step trace is kept for quality checks.
export const REVIEW_TRACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
// Bounds one record to a few hundred KB even for multibyte text, so a trim
// batch stays well inside a transaction's read limit.
const MAX_TRACE_STEPS = 16;
const MAX_STEP_ENTRIES = 15;
const MAX_TITLE_LENGTH = 160;
const MAX_PATH_LENGTH = 200;

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

// Cut by code point so a surrogate pair is never split.
const text = (value: unknown, limit: number) =>
  typeof value === "string" ? Array.from(value).slice(0, limit).join("") : "";

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
  const half = MAX_TRACE_STEPS / 2;
  return {
    // The first steps, with the main review's verification, and the last.
    trace:
      trace.length > MAX_TRACE_STEPS
        ? [...trace.slice(0, half), ...trace.slice(-half)]
        : trace,
    steps: events.filter((e) => e.stage === "proposed").length,
    candidates,
    discarded,
  };
}
