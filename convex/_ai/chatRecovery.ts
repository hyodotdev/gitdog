import { v } from "convex/values";

export type ChatRecoveryTarget =
  | {
      kind: "initial_ticket";
      stage: "start" | "answer";
      expectedAiInputVersion: number;
      expectedIndexVersion: number;
    }
  | {
      kind: "regenerate";
      expectedAiInputVersion: number;
      expectedIndexVersion: number;
    }
  | {
      kind: "follow_up";
      forceApproval?: boolean;
      expectedAiInputVersion: number;
      expectedIndexVersion: number;
    };

export const chatRecoveryTargetValidator = v.union(
  v.object({
    kind: v.literal("initial_ticket"),
    stage: v.union(v.literal("start"), v.literal("answer")),
    expectedAiInputVersion: v.number(),
    expectedIndexVersion: v.number(),
  }),
  v.object({
    kind: v.literal("regenerate"),
    expectedAiInputVersion: v.number(),
    expectedIndexVersion: v.number(),
  }),
  v.object({
    kind: v.literal("follow_up"),
    forceApproval: v.optional(v.boolean()),
    expectedAiInputVersion: v.number(),
    expectedIndexVersion: v.number(),
  }),
);

export const PENDING_GENERATION_WATCHDOG_DELAY_MS = 10 * 60 * 1_000;
export const PENDING_GENERATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const PENDING_GENERATION_LEASE_MS = 20 * 60 * 1_000;
export const PROVIDER_START_RETRY_TIMEOUT_MS = 60 * 60 * 1_000;

export function getProviderStartRetryWindow(
  previousStartedAt: number | undefined,
  now: number = Date.now(),
): { startedAt: number; timeoutReason?: string } {
  const startedAt = previousStartedAt ?? now;
  return now - startedAt >= PROVIDER_START_RETRY_TIMEOUT_MS
    ? {
        startedAt,
        timeoutReason: "AI provider could not start durably within one hour",
      }
    : { startedAt };
}
