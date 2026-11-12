import { internal } from "../_generated/api";
import { chatRequestBytes } from "./requestSize";
import { ChatProviderRequestError } from "./providerErrors";
import { CreditFallbackProvider } from "./providers";
import { UserApiKeyError } from "./providerResolution";
import { isUsableProviderKey } from "../providerApiKeys/usability";
import { grantTrialCreditOnce } from "../subscriptions/credit";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { isDevelopmentSiteUrl } from "../_utils/environment";
import { MAX_COLLECT_LIMIT } from "../_utils/pagination";
import {
  getSafeQuotaTokenLimit,
  hasValidPurchasedTokenDebitCoverage,
  readQuotaTokenUsage,
} from "../tokenUsage/quota";
import {
  settleAllEndedTrustedProQuotas,
  TerminalProQuotaUnavailableError,
} from "../subscriptions/billingBoundaries";
import { getSubscriptionForEntitlement } from "../subscriptions/entitlement";
import { readEffectiveSubscriptionQuota } from "../subscriptions/quotaEntitlement";
import { recordChatUsageInTransaction } from "../tokenUsage/internalMutation";
import {
  getGenerationOutputReservationLimit,
  type AiProvider,
  type ChatCompletionOptions,
  type ChatCompletionResult,
  type ChatMessage,
} from "./model";
import {
  PENDING_GENERATION_LEASE_MS,
  PENDING_GENERATION_TTL_MS,
  PENDING_GENERATION_WATCHDOG_DELAY_MS,
  chatRecoveryTargetValidator,
  type ChatRecoveryTarget,
} from "./chatRecovery";

export const CHAT_RESERVATION_TTL_MS = 15 * 60 * 1_000;
const CHAT_RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
const CHAT_RESERVATION_CLEANUP_LIMIT = 100;
const CHAT_USAGE_MUTATION_MAX_ATTEMPTS = 3;
const CHAT_USAGE_MUTATION_RETRY_BASE_DELAY_MS = 100;
const ACTIVE_PROVIDER_POLL_MS = 2_000;
const CHAT_SETTLEMENT_RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;
const CHAT_SETTLEMENT_RECOVERY_LIMIT = 100;
const CHAT_SETTLEMENT_INITIAL_DELAY_MS = 1_000;
const CHAT_RESULT_CHECKPOINT_MAX_BYTES = 512 * 1_024;
const CHAT_RESULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1_000;
const CHAT_RESULT_RECOVERY_LEASE_MS = 10 * 60 * 1_000;
const CHAT_RESULT_RECOVERY_LIMIT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recoveryTargetsMatch(
  left: ChatRecoveryTarget | undefined,
  right: ChatRecoveryTarget | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (
    left.expectedAiInputVersion !== right.expectedAiInputVersion ||
    left.expectedIndexVersion !== right.expectedIndexVersion
  ) {
    return false;
  }

  switch (left.kind) {
    case "initial_ticket":
      return right.kind === "initial_ticket" && left.stage === right.stage;
    case "regenerate":
      return right.kind === "regenerate";
    case "follow_up":
      return (
        right.kind === "follow_up" && left.forceApproval === right.forceApproval
      );
    default: {
      const exhaustiveTarget: never = left;
      return exhaustiveTarget;
    }
  }
}

function hasValidThoughtMetadata(value: Record<string, unknown>): boolean {
  return (
    (value.openAIPhase === undefined ||
      value.openAIPhase === "commentary" ||
      value.openAIPhase === "final_answer") &&
    (value.thought === undefined || typeof value.thought === "boolean") &&
    (value.thoughtSignature === undefined ||
      (typeof value.thoughtSignature === "string" &&
        value.thoughtSignature.length > 0))
  );
}

function hasValidCheckpointHistory(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((part) => {
    if (!isRecord(part) || !hasValidThoughtMetadata(part)) return false;
    if (part.type === "text") return typeof part.text === "string";
    if (part.type === "thinking")
      return (
        typeof part.thinking === "string" && typeof part.signature === "string"
      );
    if (part.type === "redacted_thinking") return typeof part.data === "string";
    if (part.type === "openai_reasoning")
      return (
        typeof part.id === "string" &&
        part.id.length > 0 &&
        typeof part.encryptedContent === "string" &&
        part.encryptedContent.length > 0 &&
        Array.isArray(part.summary) &&
        part.summary.every(
          (item) =>
            isRecord(item) &&
            item.type === "summary_text" &&
            typeof item.text === "string",
        )
      );
    return (
      part.type === "tool_use" &&
      typeof part.id === "string" &&
      part.id.length > 0 &&
      typeof part.name === "string" &&
      part.name.length > 0 &&
      isRecord(part.input)
    );
  });
}

function hasValidCheckpointToolUse(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every(
    (tool) =>
      isRecord(tool) &&
      typeof tool.id === "string" &&
      tool.id.length > 0 &&
      typeof tool.name === "string" &&
      tool.name.length > 0 &&
      isRecord(tool.input),
  );
}

function parseChatResultCheckpoint(
  serialized: string,
  expectedOutcome?: Extract<ChatSettlementOutcome, { kind: "known_billed" }>,
): ChatCompletionResult {
  if (
    !serialized ||
    new TextEncoder().encode(serialized).byteLength >
      CHAT_RESULT_CHECKPOINT_MAX_BYTES
  ) {
    throw new Error("AI chat result checkpoint is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("AI chat result checkpoint is invalid");
  }
  if (
    !isRecord(value) ||
    typeof value.content !== "string" ||
    ![
      "stop",
      "length",
      "content_filter",
      "tool_use",
      "invalid_tool_call",
      "provider_error",
    ].includes(value.finishReason as string) ||
    !isRecord(value.usage) ||
    !Number.isSafeInteger(value.usage.promptTokens) ||
    (value.usage.promptTokens as number) < 0 ||
    !Number.isSafeInteger(value.usage.completionTokens) ||
    (value.usage.completionTokens as number) < 0 ||
    !Number.isSafeInteger(value.usage.totalTokens) ||
    value.usage.totalTokens !==
      (value.usage.promptTokens as number) +
        (value.usage.completionTokens as number) ||
    (value.provider !== undefined &&
      (typeof value.provider !== "string" ||
        !value.provider ||
        value.provider.length > 128)) ||
    (value.providerRequestId !== undefined &&
      (typeof value.providerRequestId !== "string" ||
        !value.providerRequestId ||
        value.providerRequestId.length > 512)) ||
    (value.historyContent !== undefined &&
      !hasValidCheckpointHistory(value.historyContent)) ||
    (value.toolUse !== undefined && !hasValidCheckpointToolUse(value.toolUse))
  ) {
    throw new Error("AI chat result checkpoint is invalid");
  }
  if (
    expectedOutcome &&
    (value.usage.promptTokens !== expectedOutcome.inputTokens ||
      value.usage.completionTokens !== expectedOutcome.outputTokens ||
      value.providerRequestId !== expectedOutcome.providerRequestId)
  ) {
    throw new Error("AI chat result checkpoint usage mismatch");
  }
  return value as ChatCompletionResult;
}

function serializeChatResultCheckpoint(
  result: ChatCompletionResult,
  outcome: Extract<ChatSettlementOutcome, { kind: "known_billed" }>,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new Error("AI chat result could not be checkpointed");
  }
  parseChatResultCheckpoint(serialized, outcome);
  return serialized;
}

/** Hash private workflow identity so deterministic reservation keys contain no content. */
export async function createBillingGenerationKey(
  scope: string,
  privateIdentityParts: string[],
): Promise<string> {
  if (!scope.trim() || scope.length > 256) {
    throw new Error("AI billing generation scope is invalid");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(privateIdentityParts)),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${scope}/${fingerprint}`;
}

async function createChatRequestFingerprint(
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        messages,
        maxTokens: options?.maxTokens ?? null,
        temperature: options?.temperature ?? null,
        topP: options?.topP ?? null,
        tools: options?.tools ?? [],
        ...(options?.responseFormat
          ? { responseFormat: options.responseFormat }
          : {}),
      }),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

type ReservationFailureReason =
  | "attempt_in_progress"
  | "invalid_subscription_balance"
  | "limit_reached"
  | "provider_attempt_in_progress"
  | "reservation_closed"
  | "reservation_finalized"
  | "reservation_history_too_large"
  | "terminal_settlement_pending"
  | "unresolved_provider_usage"
  | "usage_history_too_large"
  | "user_key_required"
  | "user_key_unavailable";

type ChatQuotaSnapshot = {
  subscriptionId?: Id<"subscriptions">;
  entitlementPlan: "free" | "pro";
  includedTokens: number;
  serviceFeeRate: number;
  quotaPeriodStart: number;
  quotaPeriodEnd: number;
};

type ChatQuotaDecision =
  | { allowed: true; snapshot: ChatQuotaSnapshot }
  | { allowed: false; reason: ReservationFailureReason };

type ChatSettlementOutcome =
  | {
      kind: "known_billed";
      inputTokens: number;
      outputTokens: number;
      providerRequestId?: string;
    }
  | { kind: "known_not_billed"; providerRequestId?: string };

const chatSettlementOutcomeValidator = v.union(
  v.object({
    kind: v.literal("known_billed"),
    inputTokens: v.number(),
    outputTokens: v.number(),
    providerRequestId: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("known_not_billed"),
    providerRequestId: v.optional(v.string()),
  }),
);

function settlementOutcomesMatch(
  left: ChatSettlementOutcome,
  right: ChatSettlementOutcome,
): boolean {
  return (
    left.kind === right.kind &&
    left.providerRequestId === right.providerRequestId &&
    (left.kind === "known_not_billed" ||
      (right.kind === "known_billed" &&
        left.inputTokens === right.inputTokens &&
        left.outputTokens === right.outputTokens))
  );
}

export class ChatBillingError extends Error {
  constructor(
    message: string,
    readonly reason:
      | ReservationFailureReason
      | "provider_attempt_ambiguous"
      | "provider_start_failed",
  ) {
    super(message);
    this.name = "ChatBillingError";
  }

  get durableRetrySafe(): boolean {
    return (
      this.reason === "attempt_in_progress" ||
      this.reason === "provider_attempt_in_progress" ||
      this.reason === "provider_start_failed"
    );
  }
}

function checkedReservationTokens(
  inputTokenLimit: number,
  outputTokenLimit: number,
): number {
  if (
    !Number.isSafeInteger(inputTokenLimit) ||
    inputTokenLimit < 1 ||
    !Number.isSafeInteger(outputTokenLimit) ||
    outputTokenLimit < 1
  ) {
    throw new Error("AI chat reservation limits are invalid");
  }
  const total = inputTokenLimit + outputTokenLimit;
  if (!Number.isSafeInteger(total)) {
    throw new Error("AI chat reservation exceeds the supported range");
  }
  return total;
}

export function getChatReservationLimits(
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): { inputTokenLimit: number; outputTokenLimit: number } {
  const inputTokenLimit = chatRequestBytes(messages, options);
  const outputTokenLimit = getGenerationOutputReservationLimit(
    options?.maxTokens,
  );
  checkedReservationTokens(inputTokenLimit, outputTokenLimit);
  return { inputTokenLimit, outputTokenLimit };
}

function blocksActiveProvider(reservation: { provider?: string }): boolean {
  return (reservation.provider ?? "google") !== "google";
}

async function expireChatReservations(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number,
): Promise<ChatQuotaDecision | null> {
  const ambiguous = await ctx.db
    .query("chatUsageReservations")
    .withIndex("by_user_key_source_and_status", (q) =>
      q
        .eq("userId", userId)
        .eq("keySource", undefined)
        .eq("status", "ambiguous"),
    )
    .take(CHAT_RESERVATION_CLEANUP_LIMIT + 1);
  if (ambiguous.length > CHAT_RESERVATION_CLEANUP_LIMIT) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }
  if (ambiguous.some(blocksActiveProvider)) {
    return { allowed: false, reason: "unresolved_provider_usage" };
  }

  const expired = await ctx.db
    .query("chatUsageReservations")
    .withIndex("by_user_key_source_status_settlement_and_expiration", (q) =>
      q
        .eq("userId", userId)
        .eq("keySource", undefined)
        .eq("status", "pending")
        .eq("settlementState", undefined)
        .lte("expiresAt", now),
    )
    .take(CHAT_RESERVATION_CLEANUP_LIMIT + 1);
  if (expired.length > CHAT_RESERVATION_CLEANUP_LIMIT) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }
  for (const reservation of expired) {
    const providerStarted = reservation.providerStartedAt !== undefined;
    await ctx.db.patch(reservation._id, {
      status: providerStarted ? "ambiguous" : "released",
      releaseReason: providerStarted ? "ambiguous_provider_attempt" : "expired",
      updatedAt: now,
    });
    if (providerStarted && blocksActiveProvider(reservation)) {
      return { allowed: false, reason: "unresolved_provider_usage" };
    }
  }

  const activeProviderAttempt = await ctx.db
    .query("chatUsageReservations")
    .withIndex("by_user_key_source_status_and_provider_started_at", (q) =>
      q
        .eq("userId", userId)
        .eq("keySource", undefined)
        .eq("status", "pending")
        .gte("providerStartedAt", 0),
    )
    .take(CHAT_RESERVATION_CLEANUP_LIMIT + 1);
  if (activeProviderAttempt.length > CHAT_RESERVATION_CLEANUP_LIMIT) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }
  if (activeProviderAttempt.some(blocksActiveProvider)) {
    return { allowed: false, reason: "provider_attempt_in_progress" };
  }
  return null;
}

async function checkChatQuota(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    newReservationTokens: number;
    now: number;
  },
): Promise<ChatQuotaDecision> {
  // Retired embedding reservations never block or hold quota; the cleanup
  // cron releases them and settles any known-billed outcome.
  const chatState = await expireChatReservations(ctx, args.userId, args.now);
  if (chatState) return chatState;
  // Accounts that never opened the web app still get their one-time trial.
  // Skipped without writes when Pro history or the wallet needs attention;
  // the checks below then refuse as usual.
  await grantTrialCreditOnce(ctx, args.userId, args.now);

  try {
    await settleAllEndedTrustedProQuotas(ctx, args.userId, args.now);
  } catch (error) {
    if (error instanceof TerminalProQuotaUnavailableError) {
      return {
        allowed: false,
        reason:
          error.reason === "in_progress"
            ? "terminal_settlement_pending"
            : "invalid_subscription_balance",
      };
    }
    throw error;
  }

  const subscription = await getSubscriptionForEntitlement(
    ctx,
    args.userId,
    args.now,
  );
  const quota = await readEffectiveSubscriptionQuota(
    ctx,
    subscription,
    args.now,
  );
  if (!quota.verified) return { allowed: false, reason: quota.reason };
  const entitlement = quota.entitlement;
  const snapshot: ChatQuotaSnapshot = {
    ...(subscription ? { subscriptionId: subscription._id } : {}),
    entitlementPlan: entitlement.plan,
    includedTokens: entitlement.includedTokens,
    serviceFeeRate: entitlement.serviceFeeRate,
    quotaPeriodStart: entitlement.periodStart,
    quotaPeriodEnd: entitlement.periodEnd,
  };
  if (isDevelopmentSiteUrl()) {
    return { allowed: true, snapshot };
  }

  const usage = await readQuotaTokenUsage(ctx, {
    userId: args.userId,
    periodStart: entitlement.periodStart,
    periodEndExclusive: entitlement.periodEnd,
  });
  if (!usage.verified) {
    return { allowed: false, reason: "usage_history_too_large" };
  }
  if (
    !hasValidPurchasedTokenDebitCoverage(
      usage.tokensUsed,
      entitlement.includedTokens,
      usage.purchasedTokensDebited,
    )
  ) {
    return { allowed: false, reason: "invalid_subscription_balance" };
  }
  const tokenLimit = getSafeQuotaTokenLimit(
    entitlement.includedTokens,
    entitlement.purchasedTokens,
    usage.purchasedTokensDebited,
  );
  if (tokenLimit === null) {
    return { allowed: false, reason: "invalid_subscription_balance" };
  }

  const [chatPending, chatAmbiguous] = await Promise.all([
    ctx.db
      .query("chatUsageReservations")
      .withIndex("by_user_key_source_and_status", (q) =>
        q
          .eq("userId", args.userId)
          .eq("keySource", undefined)
          .eq("status", "pending"),
      )
      .take(MAX_COLLECT_LIMIT + 1),
    ctx.db
      .query("chatUsageReservations")
      .withIndex("by_user_key_source_and_status", (q) =>
        q
          .eq("userId", args.userId)
          .eq("keySource", undefined)
          .eq("status", "ambiguous"),
      )
      .take(CHAT_RESERVATION_CLEANUP_LIMIT + 1),
  ]);
  if (
    chatAmbiguous.length > CHAT_RESERVATION_CLEANUP_LIMIT ||
    chatPending.length > MAX_COLLECT_LIMIT
  ) {
    return { allowed: false, reason: "reservation_history_too_large" };
  }
  let reservedTokens = 0;
  for (const reservation of [...chatPending, ...chatAmbiguous]) {
    reservedTokens += reservation.reservedTokens;
    if (!Number.isSafeInteger(reservedTokens)) {
      return { allowed: false, reason: "invalid_subscription_balance" };
    }
  }
  if (
    usage.tokensUsed + reservedTokens + args.newReservationTokens >
    tokenLimit
  ) {
    return { allowed: false, reason: "limit_reached" };
  }
  return { allowed: true, snapshot };
}

// An action that ran on the owner's key must never finish on Gitdog's key.
async function checkKeySource(
  ctx: MutationCtx,
  args: { userId: Id<"users">; provider?: string; keySource?: "user" },
  action: Doc<"ticketActions">,
): Promise<{ allowed: false; reason: ReservationFailureReason } | null> {
  if (args.keySource !== "user") {
    return action.aiKeySource === "user"
      ? { allowed: false, reason: "user_key_required" }
      : null;
  }
  return (await hasUsableUserKey(ctx, args.userId, args.provider))
    ? null
    : { allowed: false, reason: "user_key_unavailable" };
}

// Calls on the user's own provider key hold no Gitdog quota. The snapshot has
// no subscription, so Pro boundary settlement never sees these reservations.
function userKeyQuotaSnapshot(now: number): ChatQuotaSnapshot {
  return {
    entitlementPlan: "free",
    includedTokens: 0,
    serviceFeeRate: 0,
    quotaPeriodStart: now,
    quotaPeriodEnd: now + CHAT_RESERVATION_TTL_MS,
  };
}

async function hasUsableUserKey(
  ctx: MutationCtx,
  userId: Id<"users">,
  provider: string | undefined,
): Promise<boolean> {
  if (provider !== "anthropic" && provider !== "openai") return false;
  const key = await ctx.db
    .query("providerApiKeys")
    .withIndex("by_user_and_provider", (q) =>
      q.eq("userId", userId).eq("provider", provider),
    )
    .unique();
  return key !== null && isUsableProviderKey(key, Date.now());
}

async function checkReservationQuota(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    keySource?: "user";
    newReservationTokens: number;
    now: number;
  },
): Promise<ChatQuotaDecision> {
  if (args.keySource === "user")
    return { allowed: true, snapshot: userKeyQuotaSnapshot(args.now) };
  return await checkChatQuota(ctx, args);
}

export const reserveChatUsage = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    ticketActionId: v.id("ticketActions"),
    requirePendingTicketAction: v.boolean(),
    generationKey: v.string(),
    operation: v.string(),
    model: v.string(),
    provider: v.optional(
      v.union(v.literal("google"), v.literal("anthropic"), v.literal("openai")),
    ),
    requestFingerprint: v.string(),
    keySource: v.optional(v.literal("user")),
    inputTokenLimit: v.number(),
    outputTokenLimit: v.number(),
    recoveryTarget: v.optional(chatRecoveryTargetValidator),
  },
  handler: async (ctx, args) => {
    if (
      !args.reservationKey.trim() ||
      args.reservationKey.length > 512 ||
      !args.attemptToken.trim() ||
      args.attemptToken.length > 128 ||
      !args.generationKey.trim() ||
      args.generationKey.length > 384 ||
      !args.operation.trim() ||
      args.operation.length > 512 ||
      !/^[a-f0-9]{64}$/.test(args.requestFingerprint)
    ) {
      throw new Error("AI chat reservation identity is invalid");
    }
    // The repository is not read here: indexing patches it several times a
    // second, which would conflict with this quota check. Ownership comes
    // from the ticket, and markChatProviderStarted rejects a
    // disconnected repository before any provider request.
    const [user, action] = await Promise.all([
      ctx.db.get(args.userId),
      ctx.db.get(args.ticketActionId),
    ]);
    const ticket = action ? await ctx.db.get(action.ticketId) : null;
    if (
      !user ||
      !action ||
      !ticket ||
      ticket.userId !== args.userId ||
      ticket.repositoryId !== args.repositoryId
    ) {
      throw new Error("AI chat reservation scope is invalid");
    }
    const reservedTokens = checkedReservationTokens(
      args.inputTokenLimit,
      args.outputTokenLimit,
    );
    const [recordedUsage, existing] = await Promise.all([
      ctx.db
        .query("tokenUsage")
        .withIndex("by_chat_reservation", (q) =>
          q.eq("chatReservationKey", args.reservationKey),
        )
        .first(),
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", args.reservationKey),
        )
        .first(),
    ]);
    if (existing) {
      const sameProvider =
        existing.model === args.model &&
        (existing.provider ?? "google") === (args.provider ?? "google") &&
        existing.keySource === args.keySource;
      const routeCanChange =
        existing.status === "released" &&
        (existing.releaseReason === "request_finished_without_provider_usage" ||
          ((existing.releaseReason === "expired" ||
            existing.releaseReason === "entitlement_period_ended") &&
            existing.providerStartedAt === undefined));
      const canReplayOtherRoute =
        existing.status === "finalized" &&
        existing.resultCheckpointJson !== undefined;
      const matches =
        existing.userId === args.userId &&
        existing.repositoryId === args.repositoryId &&
        existing.ticketActionId === args.ticketActionId &&
        existing.requirePendingTicketAction ===
          args.requirePendingTicketAction &&
        existing.generationKey === args.generationKey &&
        existing.operation === args.operation &&
        (sameProvider ||
          routeCanChange ||
          canReplayOtherRoute ||
          existing.status === "pending" ||
          existing.status === "ambiguous") &&
        existing.requestFingerprint === args.requestFingerprint &&
        existing.inputTokenLimit === args.inputTokenLimit &&
        existing.outputTokenLimit === args.outputTokenLimit &&
        existing.reservedTokens === reservedTokens &&
        recoveryTargetsMatch(existing.recoveryTarget, args.recoveryTarget);
      if (!matches) {
        throw new Error("AI chat reservation identity mismatch");
      }
      if (recordedUsage) {
        if (
          existing.status !== "finalized" ||
          existing.usageId !== recordedUsage._id ||
          recordedUsage.userId !== args.userId ||
          recordedUsage.repositoryId !== args.repositoryId ||
          recordedUsage.ticketActionId !== args.ticketActionId
        ) {
          throw new Error("AI chat finalized reservation mismatch");
        }
        if (existing.resultCheckpointJson) {
          if (
            existing.requirePendingTicketAction &&
            (action.status !== "pending" ||
              action.proposalVersion !== existing.ticketActionProposalVersion)
          ) {
            return {
              allowed: false as const,
              reason: "reservation_closed" as const,
            };
          }
          const result = parseChatResultCheckpoint(
            existing.resultCheckpointJson,
          );
          if (
            result.usage?.promptTokens !== recordedUsage.inputTokens ||
            result.usage.completionTokens !== recordedUsage.outputTokens ||
            result.providerRequestId !== recordedUsage.providerRequestId
          ) {
            throw new Error("AI chat result checkpoint usage mismatch");
          }
          return {
            allowed: false as const,
            reason: "reservation_finalized" as const,
            resultCheckpointJson: existing.resultCheckpointJson,
          };
        }
        return {
          allowed: false as const,
          reason: "reservation_finalized" as const,
        };
      }
      const keyDecision = await checkKeySource(ctx, args, action);
      if (keyDecision) return keyDecision;
      const now = Date.now();
      if (
        !sameProvider &&
        existing.status === "pending" &&
        existing.expiresAt > now
      ) {
        return {
          allowed: false as const,
          reason: "provider_attempt_in_progress" as const,
        };
      }
      if (
        existing.status === "pending" &&
        existing.settlementState === "staged"
      ) {
        return {
          allowed: false as const,
          reason: "provider_attempt_in_progress" as const,
        };
      }
      // Gitdog has no billing exposure for an unresolved call on the user's
      // own key, so a retry may take the reservation over instead of
      // waiting for a reconciliation that never happens.
      const abandonedUserKeyAttempt =
        existing.keySource === "user" &&
        (existing.status === "ambiguous" ||
          (existing.status === "pending" &&
            existing.expiresAt <= now &&
            existing.providerStartedAt !== undefined));
      if (
        !abandonedUserKeyAttempt &&
        existing.status === "pending" &&
        existing.expiresAt <= now &&
        existing.providerStartedAt !== undefined
      ) {
        await ctx.db.patch(existing._id, {
          status: "ambiguous",
          releaseReason: "ambiguous_provider_attempt",
          updatedAt: now,
        });
        return {
          allowed: false as const,
          reason: "reservation_closed" as const,
        };
      }
      const safelyReleased =
        existing.status === "released" &&
        (existing.releaseReason === "request_finished_without_provider_usage" ||
          (existing.releaseReason === "entitlement_period_ended" &&
            existing.providerStartedAt === undefined) ||
          (existing.releaseReason === "expired" &&
            existing.providerStartedAt === undefined));
      const safelyExpired =
        existing.status === "pending" &&
        existing.expiresAt <= now &&
        existing.providerStartedAt === undefined;
      if (safelyReleased || safelyExpired || abandonedUserKeyAttempt) {
        const quota = await checkReservationQuota(ctx, {
          userId: args.userId,
          keySource: args.keySource,
          newReservationTokens: reservedTokens,
          now,
        });
        if (!quota.allowed) return quota;
        await ctx.db.patch(existing._id, {
          attemptToken: args.attemptToken,
          model: args.model,
          provider: args.provider,
          keySource: args.keySource,
          subscriptionId: undefined,
          requirePendingTicketAction: args.requirePendingTicketAction,
          ticketActionProposalVersion: action.proposalVersion,
          ...quota.snapshot,
          status: "pending",
          releaseReason: undefined,
          providerStartedAt: undefined,
          providerRequestId: undefined,
          settlementState: undefined,
          settlementOutcome: undefined,
          settlementStagedAt: undefined,
          settlementNextRecoveryAt: undefined,
          settlementScheduleId: undefined,
          resultCheckpointJson: undefined,
          resultCheckpointedAt: undefined,
          recoveryTarget: args.recoveryTarget,
          createdAt: now,
          expiresAt: now + CHAT_RESERVATION_TTL_MS,
          updatedAt: now,
        });
        return { allowed: true as const, reservationKey: args.reservationKey };
      }
      if (existing.status === "pending" && existing.providerStartedAt) {
        return {
          allowed: false as const,
          reason: "provider_attempt_in_progress" as const,
        };
      }
      if (existing.status === "pending") {
        if (existing.attemptToken !== args.attemptToken) {
          await ctx.db.patch(existing._id, {
            attemptToken: args.attemptToken,
            updatedAt: now,
          });
        }
        return { allowed: true as const, reservationKey: args.reservationKey };
      }
      return { allowed: false as const, reason: "reservation_closed" as const };
    }
    if (recordedUsage) {
      throw new Error("AI chat finalized reservation is missing");
    }

    const keyDecision = await checkKeySource(ctx, args, action);
    if (keyDecision) return keyDecision;
    const now = Date.now();
    const quota = await checkReservationQuota(ctx, {
      userId: args.userId,
      keySource: args.keySource,
      newReservationTokens: reservedTokens,
      now,
    });
    if (!quota.allowed) return quota;

    await ctx.db.insert("chatUsageReservations", {
      ...args,
      requirePendingTicketAction: args.requirePendingTicketAction,
      ticketActionProposalVersion: action.proposalVersion,
      ...quota.snapshot,
      reservedTokens,
      status: "pending",
      expiresAt: now + CHAT_RESERVATION_TTL_MS,
      createdAt: now,
      updatedAt: now,
    });
    return { allowed: true as const, reservationKey: args.reservationKey };
  },
});

export const markChatProviderStarted = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    ticketActionId: v.id("ticketActions"),
  },
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("chatUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .first();
    const now = Date.now();
    if (!reservation) {
      return { started: false as const, reason: "reservation_closed" as const };
    }
    if (
      reservation.userId !== args.userId ||
      reservation.repositoryId !== args.repositoryId ||
      reservation.ticketActionId !== args.ticketActionId ||
      reservation.attemptToken !== args.attemptToken
    ) {
      throw new Error("AI chat provider-start identity mismatch");
    }
    if (
      reservation.status !== "pending" ||
      reservation.settlementState === "staged" ||
      reservation.expiresAt <= now ||
      reservation.quotaPeriodEnd <= now
    ) {
      return { started: false as const, reason: "reservation_closed" as const };
    }
    if (reservation.requirePendingTicketAction) {
      const action = await ctx.db.get(reservation.ticketActionId);
      if (
        !action ||
        action.status !== "pending" ||
        action.proposalVersion !== reservation.ticketActionProposalVersion
      ) {
        return {
          started: false as const,
          reason: "reservation_closed" as const,
        };
      }
    }
    if (reservation.providerStartedAt !== undefined) {
      return { started: true as const, alreadyStarted: true as const };
    }
    const repository = await ctx.db.get(reservation.repositoryId);
    if (
      !repository ||
      repository.userId !== args.userId ||
      repository.disconnectCleanupPending === true
    ) {
      return { started: false as const, reason: "reservation_closed" as const };
    }
    // Calls on the user's own key spend nothing of Gitdog's, so they neither
    // wait for nor block Gitdog-paid work on the account.
    if (reservation.keySource === "user") {
      if (!(await hasUsableUserKey(ctx, args.userId, reservation.provider))) {
        return {
          started: false as const,
          reason: "user_key_unavailable" as const,
        };
      }
      // Pin only once a request really goes out on the user's key, so a
      // retry can never finish this action on Gitdog's key.
      const action = await ctx.db.get(reservation.ticketActionId);
      if (action && action.aiKeySource !== "user")
        await ctx.db.patch(action._id, { aiKeySource: "user" });
      await ctx.db.patch(reservation._id, {
        providerStartedAt: now,
        updatedAt: now,
      });
      return { started: true as const, alreadyStarted: false as const };
    }
    const [ambiguousChat, activeChat] = await Promise.all([
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_user_key_source_and_status", (q) =>
          q
            .eq("userId", args.userId)
            .eq("keySource", undefined)
            .eq("status", "ambiguous"),
        )
        .take(CHAT_RESERVATION_CLEANUP_LIMIT + 1),
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_user_key_source_status_and_provider_started_at", (q) =>
          q
            .eq("userId", args.userId)
            .eq("keySource", undefined)
            .eq("status", "pending")
            .gte("providerStartedAt", 0),
        )
        .take(CHAT_RESERVATION_CLEANUP_LIMIT + 1),
    ]);
    if (
      [ambiguousChat, activeChat].some(
        (rows) => rows.length > CHAT_RESERVATION_CLEANUP_LIMIT,
      )
    ) {
      return {
        started: false as const,
        reason: "reservation_history_too_large" as const,
      };
    }
    if (ambiguousChat.some(blocksActiveProvider)) {
      return {
        started: false as const,
        reason: "unresolved_provider_usage" as const,
      };
    }
    if (activeChat.some(blocksActiveProvider)) {
      return {
        started: false as const,
        reason: "provider_attempt_in_progress" as const,
      };
    }
    await ctx.db.patch(reservation._id, {
      providerStartedAt: now,
      updatedAt: now,
    });
    return { started: true as const, alreadyStarted: false as const };
  },
});

export const markChatUsageAmbiguous = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    ticketActionId: v.id("ticketActions"),
    providerRequestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("chatUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .first();
    if (!reservation) return false;
    if (
      reservation.userId !== args.userId ||
      reservation.repositoryId !== args.repositoryId ||
      reservation.ticketActionId !== args.ticketActionId ||
      reservation.attemptToken !== args.attemptToken
    ) {
      throw new Error("AI chat reservation identity mismatch");
    }
    if (reservation.status === "ambiguous") return true;
    if (
      reservation.status !== "pending" ||
      reservation.providerStartedAt === undefined ||
      reservation.settlementState === "staged"
    ) {
      return false;
    }
    await ctx.db.patch(reservation._id, {
      status: "ambiguous",
      releaseReason: "ambiguous_provider_attempt",
      providerRequestId: args.providerRequestId,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const releaseChatUsage = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    ticketActionId: v.id("ticketActions"),
    confirmedNotBilled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("chatUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .first();
    if (!reservation) return false;
    if (
      reservation.userId !== args.userId ||
      reservation.repositoryId !== args.repositoryId ||
      reservation.ticketActionId !== args.ticketActionId
    ) {
      throw new Error("AI chat reservation identity mismatch");
    }
    if (
      reservation.status !== "pending" ||
      reservation.attemptToken !== args.attemptToken ||
      reservation.settlementState === "staged" ||
      (reservation.providerStartedAt !== undefined && !args.confirmedNotBilled)
    ) {
      return false;
    }
    await ctx.db.patch(reservation._id, {
      status: "released",
      releaseReason: "request_finished_without_provider_usage",
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const settleStagedChatOutcome = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    fromScheduler: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("chatUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .first();
    if (!reservation) return { status: "missing" as const };
    if (reservation.attemptToken !== args.attemptToken) {
      throw new Error("AI chat settlement ownership mismatch");
    }
    if (reservation.status === "finalized") {
      return { status: "finalized" as const, usageId: reservation.usageId };
    }
    if (reservation.status === "released") {
      return { status: "released" as const };
    }
    if (
      reservation.status !== "pending" ||
      reservation.settlementState !== "staged" ||
      !reservation.settlementOutcome
    ) {
      return { status: "not_staged" as const };
    }
    if (!args.fromScheduler && reservation.settlementScheduleId) {
      const scheduled = await ctx.db.system.get(
        reservation.settlementScheduleId,
      );
      if (scheduled?.state.kind === "pending") {
        await ctx.scheduler.cancel(reservation.settlementScheduleId);
      }
    }

    const outcome = reservation.settlementOutcome;
    if (outcome.kind === "known_billed") {
      const usageId = await recordChatUsageInTransaction(ctx, {
        userId: reservation.userId,
        ticketActionId: reservation.ticketActionId,
        repositoryId: reservation.repositoryId,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        model: reservation.model,
        provider: reservation.provider ?? "google",
        reservationKey: reservation.reservationKey,
        reservationAttemptToken: reservation.attemptToken,
        providerRequestId: outcome.providerRequestId,
      });
      return { status: "finalized" as const, usageId };
    }

    await ctx.db.patch(reservation._id, {
      status: "released",
      releaseReason: "request_finished_without_provider_usage",
      providerRequestId: outcome.providerRequestId,
      settlementState: undefined,
      settlementOutcome: undefined,
      settlementStagedAt: undefined,
      settlementNextRecoveryAt: undefined,
      settlementScheduleId: undefined,
      updatedAt: Date.now(),
    });
    return { status: "released" as const };
  },
});

export const stageChatProviderOutcome = internalMutation({
  args: {
    reservationKey: v.string(),
    attemptToken: v.string(),
    userId: v.id("users"),
    repositoryId: v.id("repositories"),
    ticketActionId: v.id("ticketActions"),
    outcome: chatSettlementOutcomeValidator,
    resultCheckpointJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const reservation = await ctx.db
      .query("chatUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .first();
    if (!reservation) {
      throw new Error("AI chat reservation is missing");
    }
    if (
      reservation.userId !== args.userId ||
      reservation.repositoryId !== args.repositoryId ||
      reservation.ticketActionId !== args.ticketActionId ||
      reservation.attemptToken !== args.attemptToken
    ) {
      throw new Error("AI chat settlement identity mismatch");
    }

    if (reservation.status === "finalized") {
      if (args.outcome.kind !== "known_billed" || !reservation.usageId) {
        throw new Error("AI chat settlement outcome mismatch");
      }
      const usage = await ctx.db.get(reservation.usageId);
      if (
        !usage ||
        usage.chatReservationKey !== reservation.reservationKey ||
        usage.chatReservationAttemptToken !== reservation.attemptToken ||
        usage.inputTokens !== args.outcome.inputTokens ||
        usage.outputTokens !== args.outcome.outputTokens ||
        usage.providerRequestId !== args.outcome.providerRequestId
      ) {
        throw new Error("AI chat settlement outcome mismatch");
      }
      if (
        args.resultCheckpointJson !== undefined &&
        reservation.resultCheckpointJson !== args.resultCheckpointJson
      ) {
        throw new Error("AI chat result checkpoint mismatch");
      }
      return { staged: false as const, alreadySettled: true as const };
    }
    if (reservation.status === "released") {
      if (
        args.outcome.kind !== "known_not_billed" ||
        reservation.releaseReason !==
          "request_finished_without_provider_usage" ||
        reservation.providerRequestId !== args.outcome.providerRequestId
      ) {
        throw new Error("AI chat settlement outcome mismatch");
      }
      return { staged: false as const, alreadySettled: true as const };
    }
    if (
      reservation.settlementState === "staged" &&
      reservation.settlementOutcome
    ) {
      if (
        !settlementOutcomesMatch(reservation.settlementOutcome, args.outcome) ||
        reservation.resultCheckpointJson !== args.resultCheckpointJson
      ) {
        throw new Error("AI chat settlement outcome mismatch");
      }
      return { staged: true as const, alreadySettled: false as const };
    }
    if (
      (reservation.status !== "pending" &&
        reservation.status !== "ambiguous") ||
      reservation.providerStartedAt === undefined
    ) {
      throw new Error("AI chat reservation cannot stage provider usage");
    }
    if (args.outcome.kind === "known_billed") {
      if (
        !Number.isSafeInteger(args.outcome.inputTokens) ||
        args.outcome.inputTokens < 0 ||
        !Number.isSafeInteger(args.outcome.outputTokens) ||
        args.outcome.outputTokens < 0
      ) {
        throw new Error("AI chat settlement token counts are invalid");
      }
      const totalTokens = args.outcome.inputTokens + args.outcome.outputTokens;
      if (
        !Number.isSafeInteger(totalTokens) ||
        args.outcome.inputTokens > reservation.inputTokenLimit ||
        args.outcome.outputTokens > reservation.outputTokenLimit ||
        totalTokens > reservation.reservedTokens
      ) {
        throw new Error("AI chat settlement exceeds its reservation");
      }
      if (args.resultCheckpointJson !== undefined) {
        parseChatResultCheckpoint(args.resultCheckpointJson, args.outcome);
      }
    } else if (args.resultCheckpointJson !== undefined) {
      throw new Error("A non-billed AI outcome cannot checkpoint a result");
    }

    const now = Date.now();
    const settlementScheduleId = await ctx.scheduler.runAfter(
      CHAT_SETTLEMENT_INITIAL_DELAY_MS,
      internal._ai.chatBilling.settleStagedChatOutcome,
      {
        reservationKey: reservation.reservationKey,
        attemptToken: reservation.attemptToken,
        fromScheduler: true,
      },
    );
    if (
      args.resultCheckpointJson !== undefined &&
      reservation.requirePendingTicketAction &&
      reservation.recoveryTarget
    ) {
      const action = await ctx.db.get(reservation.ticketActionId);
      if (action?.status === "pending") {
        if (action.pendingGenerationScheduleId) {
          const pendingGenerationSchedule = await ctx.db.system.get(
            action.pendingGenerationScheduleId,
          );
          if (pendingGenerationSchedule?.state.kind === "pending") {
            await ctx.scheduler.cancel(action.pendingGenerationScheduleId);
          }
        }
        const recoveryScheduleId = await ctx.scheduler.runAfter(
          CHAT_RESULT_RECOVERY_LEASE_MS,
          internal._ai.chatBilling.resumeCheckpointedChatAction,
          {
            ticketActionId: reservation.ticketActionId,
            reservationKey: reservation.reservationKey,
          },
        );
        await ctx.db.patch(action._id, {
          resultCheckpointKey: reservation.reservationKey,
          resultCheckpointExpiresAt: now + CHAT_RESULT_REPLAY_TTL_MS,
          resultRecoveryLeaseUntil: now + CHAT_RESULT_RECOVERY_LEASE_MS,
          resultRecoveryScheduleId: recoveryScheduleId,
          pendingGenerationTarget: undefined,
          pendingGenerationExpiresAt: undefined,
          pendingGenerationScheduleId: undefined,
          pendingGenerationLeaseUntil: undefined,
          providerRetryStartedAt: undefined,
        });
      }
    }
    await ctx.db.patch(reservation._id, {
      status: "pending",
      releaseReason: undefined,
      providerRequestId: args.outcome.providerRequestId,
      settlementState: "staged",
      settlementOutcome: args.outcome,
      settlementStagedAt: now,
      settlementNextRecoveryAt: now + CHAT_SETTLEMENT_RECOVERY_INTERVAL_MS,
      settlementScheduleId,
      resultCheckpointJson: args.resultCheckpointJson,
      resultCheckpointedAt:
        args.resultCheckpointJson === undefined ? undefined : now,
      updatedAt: now,
    });
    return { staged: true as const, alreadySettled: false as const };
  },
});

export const recoverStagedChatOutcomes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const staged = await ctx.db
      .query("chatUsageReservations")
      .withIndex("by_settlement_state_and_recovery", (q) =>
        q.eq("settlementState", "staged").lte("settlementNextRecoveryAt", now),
      )
      .take(CHAT_SETTLEMENT_RECOVERY_LIMIT);
    for (const reservation of staged) {
      const settlementScheduleId = await ctx.scheduler.runAfter(
        0,
        internal._ai.chatBilling.settleStagedChatOutcome,
        {
          reservationKey: reservation.reservationKey,
          attemptToken: reservation.attemptToken,
          fromScheduler: true,
        },
      );
      await ctx.db.patch(reservation._id, {
        settlementNextRecoveryAt: now + CHAT_SETTLEMENT_RECOVERY_INTERVAL_MS,
        settlementScheduleId,
        updatedAt: now,
      });
    }
    return { scheduled: staged.length };
  },
});

async function failCheckpointedChatAction(
  ctx: MutationCtx,
  action: Doc<"ticketActions">,
  errorMessage: string,
): Promise<void> {
  for (const scheduleId of [
    action.resultRecoveryScheduleId,
    action.pendingGenerationScheduleId,
  ]) {
    if (!scheduleId) continue;
    const scheduled = await ctx.db.system.get(scheduleId);
    if (scheduled?.state.kind === "pending") {
      await ctx.scheduler.cancel(scheduleId);
    }
  }
  await ctx.db.patch(action._id, {
    status: "failed",
    errorMessage,
    completedAt: Date.now(),
    resultCheckpointKey: undefined,
    resultCheckpointExpiresAt: undefined,
    resultRecoveryLeaseUntil: undefined,
    resultRecoveryScheduleId: undefined,
    pendingGenerationTarget: undefined,
    pendingGenerationExpiresAt: undefined,
    pendingGenerationScheduleId: undefined,
    pendingGenerationLeaseUntil: undefined,
    providerRetryStartedAt: undefined,
  });
}

async function failPendingChatGeneration(
  ctx: MutationCtx,
  action: Doc<"ticketActions">,
  errorMessage: string,
): Promise<void> {
  if (action.pendingGenerationScheduleId) {
    const scheduled = await ctx.db.system.get(
      action.pendingGenerationScheduleId,
    );
    if (scheduled?.state.kind === "pending") {
      await ctx.scheduler.cancel(action.pendingGenerationScheduleId);
    }
  }
  await ctx.db.patch(action._id, {
    status: "failed",
    errorMessage,
    completedAt: Date.now(),
    pendingGenerationTarget: undefined,
    pendingGenerationExpiresAt: undefined,
    pendingGenerationScheduleId: undefined,
    pendingGenerationLeaseUntil: undefined,
    providerRetryStartedAt: undefined,
  });
}

function recoveryTargetNeedsIndexEpoch(
  target: ChatRecoveryTarget,
  action: Doc<"ticketActions">,
): boolean {
  return (
    target.kind === "follow_up" ||
    (target.kind === "initial_ticket" && target.stage === "answer") ||
    (target.kind === "regenerate" && action.actionType === "answer")
  );
}

function recoveryTargetMatchesAction(
  target: ChatRecoveryTarget,
  action: Doc<"ticketActions">,
): boolean {
  return (
    (target.kind === "initial_ticket" &&
      ((target.stage === "start" && action.actionType === "format") ||
        (target.stage === "answer" && action.actionType === "answer"))) ||
    (target.kind === "regenerate" &&
      (action.actionType === "format" || action.actionType === "answer")) ||
    (target.kind === "follow_up" && action.actionType === "follow_up")
  );
}

async function replaceStaleGenerationInTransaction(
  ctx: MutationCtx,
  action: Doc<"ticketActions">,
  ticket: Doc<"tickets">,
  repository: Doc<"repositories">,
  target: ChatRecoveryTarget,
  reason: string,
): Promise<void> {
  for (const scheduleId of [
    action.resultRecoveryScheduleId,
    action.pendingGenerationScheduleId,
  ]) {
    if (!scheduleId) continue;
    const scheduled = await ctx.db.system.get(scheduleId);
    if (scheduled?.state.kind === "pending") {
      await ctx.scheduler.cancel(scheduleId);
    }
  }
  if (!recoveryTargetMatchesAction(target, action)) {
    await failCheckpointedChatAction(
      ctx,
      action,
      "AI generation recovery target is invalid",
    );
    return;
  }
  const now = Date.now();
  await ctx.db.patch(action._id, {
    status: "failed",
    errorMessage: reason,
    completedAt: now,
    ...(target.kind === "follow_up" ? { sourceCommentId: undefined } : {}),
    resultCheckpointKey: undefined,
    resultCheckpointExpiresAt: undefined,
    resultRecoveryLeaseUntil: undefined,
    resultRecoveryScheduleId: undefined,
    pendingGenerationTarget: undefined,
    pendingGenerationExpiresAt: undefined,
    pendingGenerationScheduleId: undefined,
    pendingGenerationLeaseUntil: undefined,
    providerRetryStartedAt: undefined,
  });

  if (target.kind === "initial_ticket") {
    const replacementTarget: ChatRecoveryTarget = {
      kind: "initial_ticket",
      stage: target.stage,
      expectedAiInputVersion: ticket.aiInputVersion,
      expectedIndexVersion: repository.indexVersion,
    };
    const replacementActionId = await ctx.db.insert("ticketActions", {
      ticketId: ticket._id,
      actionType: target.stage === "start" ? "format" : "answer",
      chatHistory: [],
      proposalVersion: 0,
      status: "pending",
      publicationRefreshCount: action.publicationRefreshCount,
      createdAt: now,
    });
    const watchdogScheduleId = await ctx.scheduler.runAfter(
      PENDING_GENERATION_WATCHDOG_DELAY_MS,
      internal._ai.chatBilling.resumePendingChatGeneration,
      { ticketActionId: replacementActionId },
    );
    await ctx.db.patch(replacementActionId, {
      pendingGenerationTarget: replacementTarget,
      pendingGenerationExpiresAt: now + PENDING_GENERATION_TTL_MS,
      pendingGenerationScheduleId: watchdogScheduleId,
      pendingGenerationLeaseUntil: now + PENDING_GENERATION_LEASE_MS,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.tickets.internalAction.processNewTicket,
      {
        ticketId: ticket._id,
        repositoryId: repository._id,
        issueTitle: ticket.githubTitle,
        issueBody: ticket.githubBody ?? "",
        expectedAiInputVersion: ticket.aiInputVersion,
        expectedIndexVersion: repository.indexVersion,
        processingStage: target.stage,
        ...(target.stage === "start"
          ? { formatActionId: replacementActionId }
          : { answerActionId: replacementActionId }),
      },
    );
    return;
  }

  // A regeneration or follow-up carries user-authored feedback and conversation
  // context that an initial-ticket restart cannot reconstruct. Retire the stale
  // action for auditability, clone its semantic input into a fresh action, and
  // arm the replacement generation in this same transaction.
  const replacementTarget: ChatRecoveryTarget =
    target.kind === "regenerate"
      ? {
          kind: "regenerate",
          expectedAiInputVersion: ticket.aiInputVersion,
          expectedIndexVersion: repository.indexVersion,
        }
      : {
          kind: "follow_up",
          ...(target.forceApproval === undefined
            ? {}
            : { forceApproval: target.forceApproval }),
          expectedAiInputVersion: ticket.aiInputVersion,
          expectedIndexVersion: repository.indexVersion,
        };
  const replacementActionId = await ctx.db.insert("ticketActions", {
    ticketId: ticket._id,
    sourceCommentId:
      target.kind === "follow_up" ? action.sourceCommentId : undefined,
    requestedByUserId: action.requestedByUserId,
    actionType: action.actionType,
    chatHistory: action.chatHistory,
    proposedChanges: action.proposedChanges,
    proposalVersion: 0,
    status: "pending",
    publicationRefreshCount: action.publicationRefreshCount,
    userFeedback: action.userFeedback,
    createdAt: now,
  });
  const watchdogScheduleId = await ctx.scheduler.runAfter(
    PENDING_GENERATION_WATCHDOG_DELAY_MS,
    internal._ai.chatBilling.resumePendingChatGeneration,
    { ticketActionId: replacementActionId },
  );
  await ctx.db.patch(replacementActionId, {
    pendingGenerationTarget: replacementTarget,
    pendingGenerationExpiresAt: now + PENDING_GENERATION_TTL_MS,
    pendingGenerationScheduleId: watchdogScheduleId,
    pendingGenerationLeaseUntil: now + PENDING_GENERATION_LEASE_MS,
  });

  if (replacementTarget.kind === "regenerate") {
    await ctx.scheduler.runAfter(
      0,
      internal.ticketActions.internalAction.regenerateWithFeedback,
      {
        actionId: replacementActionId,
        expectedIndexVersion: repository.indexVersion,
      },
    );
    return;
  }
  await ctx.scheduler.runAfter(
    0,
    internal.ticketActions.internalAction.processFollowUp,
    {
      actionId: replacementActionId,
      expectedIndexVersion: repository.indexVersion,
      ...(replacementTarget.forceApproval === undefined
        ? {}
        : { forceApproval: replacementTarget.forceApproval }),
    },
  );
}

/** Retire a stale generation and enqueue the current ticket/index epoch once. */
export const replaceStalePendingGeneration = internalMutation({
  args: {
    ticketActionId: v.id("ticketActions"),
    expectedProposalVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.ticketActionId);
    if (
      !action ||
      action.status !== "pending" ||
      (args.expectedProposalVersion !== undefined &&
        action.proposalVersion !== args.expectedProposalVersion)
    ) {
      return false;
    }

    let target = action.pendingGenerationTarget;
    if (!target && action.resultCheckpointKey) {
      const reservation = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", action.resultCheckpointKey!),
        )
        .unique();
      target = reservation?.recoveryTarget;
    }
    if (!target) return false;

    const ticket = await ctx.db.get(action.ticketId);
    const repository = ticket?.repositoryId
      ? await ctx.db.get(ticket.repositoryId)
      : null;
    if (
      !ticket ||
      ticket.status !== "open" ||
      !repository ||
      repository.isActive !== true ||
      repository.disconnectCleanupPending === true
    ) {
      return false;
    }
    const inputEpochChanged =
      target.expectedAiInputVersion !== ticket.aiInputVersion;
    const indexEpochChanged =
      recoveryTargetNeedsIndexEpoch(target, action) &&
      target.expectedIndexVersion !== repository.indexVersion;
    if (!inputEpochChanged && !indexEpochChanged) return false;

    await replaceStaleGenerationInTransaction(
      ctx,
      action,
      ticket,
      repository,
      target,
      inputEpochChanged
        ? "Ticket content changed before AI generation completed"
        : "Repository index changed before AI generation completed",
    );
    return true;
  },
});

/** Recover an action that disappeared before a billable result checkpoint. */
export const resumePendingChatGeneration = internalMutation({
  args: { ticketActionId: v.id("ticketActions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.ticketActionId);
    if (!action?.pendingGenerationTarget) {
      return { scheduled: false as const };
    }
    if (action.status !== "pending") {
      await ctx.db.patch(action._id, {
        pendingGenerationTarget: undefined,
        pendingGenerationExpiresAt: undefined,
        pendingGenerationScheduleId: undefined,
        pendingGenerationLeaseUntil: undefined,
        providerRetryStartedAt: undefined,
      });
      return { scheduled: false as const };
    }
    if (action.resultCheckpointKey) {
      await ctx.db.patch(action._id, {
        pendingGenerationTarget: undefined,
        pendingGenerationExpiresAt: undefined,
        pendingGenerationScheduleId: undefined,
        pendingGenerationLeaseUntil: undefined,
        providerRetryStartedAt: undefined,
      });
      return { scheduled: false as const };
    }

    const now = Date.now();
    if (
      !action.pendingGenerationExpiresAt ||
      action.pendingGenerationExpiresAt <= now
    ) {
      await failPendingChatGeneration(
        ctx,
        action,
        "AI generation did not complete within seven days",
      );
      return { scheduled: false as const };
    }

    const ticket = await ctx.db.get(action.ticketId);
    if (!ticket || ticket.status !== "open") {
      await failPendingChatGeneration(
        ctx,
        action,
        "Ticket closed before AI generation completed",
      );
      return { scheduled: false as const };
    }
    const repository = ticket.repositoryId
      ? await ctx.db.get(ticket.repositoryId)
      : null;
    if (!repository || repository.disconnectCleanupPending === true) {
      await failPendingChatGeneration(
        ctx,
        action,
        "Repository was removed before AI generation completed",
      );
      return { scheduled: false as const };
    }

    const target = action.pendingGenerationTarget;
    if (!recoveryTargetMatchesAction(target, action)) {
      await failPendingChatGeneration(
        ctx,
        action,
        "AI generation recovery target is invalid",
      );
      return { scheduled: false as const };
    }

    const inputEpochChanged =
      target.expectedAiInputVersion !== ticket.aiInputVersion;
    const indexEpochChanged =
      recoveryTargetNeedsIndexEpoch(target, action) &&
      target.expectedIndexVersion !== repository.indexVersion;
    if (inputEpochChanged || indexEpochChanged) {
      await replaceStaleGenerationInTransaction(
        ctx,
        action,
        ticket,
        repository,
        target,
        inputEpochChanged
          ? "Ticket content changed before AI generation completed"
          : "Repository index changed before AI generation completed",
      );
      return { scheduled: false as const };
    }

    const nextWatchdogScheduleId = await ctx.scheduler.runAfter(
      PENDING_GENERATION_WATCHDOG_DELAY_MS,
      internal._ai.chatBilling.resumePendingChatGeneration,
      { ticketActionId: action._id },
    );
    await ctx.db.patch(action._id, {
      pendingGenerationScheduleId: nextWatchdogScheduleId,
    });

    if ((action.pendingGenerationLeaseUntil ?? 0) > now) {
      return { scheduled: false as const };
    }

    if (
      repository.isActive !== true ||
      repository.githubAccessRevokedAt !== undefined
    ) {
      return { scheduled: false as const };
    }

    let workScheduleId: Id<"_scheduled_functions">;
    switch (target.kind) {
      case "initial_ticket":
        workScheduleId = await ctx.scheduler.runAfter(
          0,
          internal.tickets.internalAction.processNewTicket,
          {
            ticketId: ticket._id,
            repositoryId: repository._id,
            issueTitle: ticket.githubTitle,
            issueBody: ticket.githubBody ?? "",
            expectedAiInputVersion: target.expectedAiInputVersion,
            expectedIndexVersion: target.expectedIndexVersion,
            processingStage: target.stage,
            providerRetryStartedAt: action.providerRetryStartedAt,
            ...(target.stage === "start"
              ? { formatActionId: action._id }
              : { answerActionId: action._id }),
          },
        );
        break;
      case "regenerate":
        workScheduleId = await ctx.scheduler.runAfter(
          0,
          internal.ticketActions.internalAction.regenerateWithFeedback,
          {
            actionId: action._id,
            expectedIndexVersion: target.expectedIndexVersion,
            providerRetryStartedAt: action.providerRetryStartedAt,
          },
        );
        break;
      case "follow_up":
        workScheduleId = await ctx.scheduler.runAfter(
          0,
          internal.ticketActions.internalAction.processFollowUp,
          {
            actionId: action._id,
            expectedIndexVersion: target.expectedIndexVersion,
            providerRetryStartedAt: action.providerRetryStartedAt,
            ...(target.forceApproval === undefined
              ? {}
              : { forceApproval: target.forceApproval }),
          },
        );
        break;
    }
    await ctx.db.patch(action._id, {
      pendingGenerationLeaseUntil: now + PENDING_GENERATION_LEASE_MS,
    });
    return { scheduled: true as const, workScheduleId };
  },
});

/**
 * Fail-safe for a pending-generation watchdog mutation that itself failed,
 * was canceled, or disappeared before it could schedule its successor.
 */
export const recoverPendingChatGenerations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expiredActions = await ctx.db
      .query("ticketActions")
      .withIndex("by_status_and_pending_expiration", (q) =>
        q
          .eq("status", "pending")
          .gt("pendingGenerationExpiresAt", 0)
          .lte("pendingGenerationExpiresAt", now),
      )
      .take(CHAT_RESULT_RECOVERY_LIMIT);
    let expired = 0;
    for (const action of expiredActions) {
      if (!action.pendingGenerationTarget || action.resultCheckpointKey) {
        continue;
      }
      await failPendingChatGeneration(
        ctx,
        action,
        "AI generation did not complete within seven days",
      );
      expired++;
    }

    const dueActions = await ctx.db
      .query("ticketActions")
      .withIndex("by_status_and_pending_lease", (q) =>
        q
          .eq("status", "pending")
          .gt("pendingGenerationLeaseUntil", 0)
          .lte("pendingGenerationLeaseUntil", now),
      )
      .take(CHAT_RESULT_RECOVERY_LIMIT);
    let scheduled = 0;
    let failed = 0;
    for (const action of dueActions) {
      if (!action.pendingGenerationTarget || action.resultCheckpointKey) {
        continue;
      }
      if (
        !action.pendingGenerationExpiresAt ||
        action.pendingGenerationExpiresAt <= now
      ) {
        await failPendingChatGeneration(
          ctx,
          action,
          "AI generation did not complete within seven days",
        );
        expired++;
        continue;
      }

      const ticket = await ctx.db.get(action.ticketId);
      if (!ticket || ticket.status !== "open") {
        await failPendingChatGeneration(
          ctx,
          action,
          "Ticket closed before AI generation completed",
        );
        failed++;
        continue;
      }
      const repository = ticket.repositoryId
        ? await ctx.db.get(ticket.repositoryId)
        : null;
      if (!repository || repository.disconnectCleanupPending === true) {
        await failPendingChatGeneration(
          ctx,
          action,
          "Repository was removed before AI generation completed",
        );
        failed++;
        continue;
      }

      const existingSchedule = action.pendingGenerationScheduleId
        ? await ctx.db.system.get(action.pendingGenerationScheduleId)
        : null;
      if (
        existingSchedule?.state.kind === "pending" ||
        existingSchedule?.state.kind === "inProgress"
      ) {
        continue;
      }

      const scheduleId = await ctx.scheduler.runAfter(
        0,
        internal._ai.chatBilling.resumePendingChatGeneration,
        { ticketActionId: action._id },
      );
      // Keep the expired lease until resumePending runs. Advancing it here
      // would make that mutation suppress the actual provider work.
      await ctx.db.patch(action._id, {
        pendingGenerationScheduleId: scheduleId,
      });
      scheduled++;
    }
    return { expired, failed, scheduled };
  },
});

export const resumeCheckpointedChatAction = internalMutation({
  args: {
    ticketActionId: v.id("ticketActions"),
    reservationKey: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { scheduled: false }
    | { scheduled: true; scheduleId: Id<"_scheduled_functions"> }
  > => {
    const [action, reservation] = await Promise.all([
      ctx.db.get(args.ticketActionId),
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", args.reservationKey),
        )
        .unique(),
    ]);
    const now = Date.now();
    if (!action) return { scheduled: false as const };
    if (action.resultCheckpointKey !== args.reservationKey) {
      return { scheduled: false as const };
    }
    if (action.status !== "pending") {
      await ctx.db.patch(action._id, {
        resultCheckpointKey: undefined,
        resultCheckpointExpiresAt: undefined,
        resultRecoveryLeaseUntil: undefined,
        resultRecoveryScheduleId: undefined,
      });
      return { scheduled: false as const };
    }
    if (
      !action.resultCheckpointExpiresAt ||
      action.resultCheckpointExpiresAt <= now
    ) {
      await failCheckpointedChatAction(
        ctx,
        action,
        "AI result recovery expired before publication",
      );
      return { scheduled: false as const };
    }
    if (
      !reservation ||
      reservation.ticketActionId !== args.ticketActionId ||
      !reservation.resultCheckpointJson ||
      !reservation.recoveryTarget
    ) {
      await failCheckpointedChatAction(
        ctx,
        action,
        "AI result recovery checkpoint is unavailable",
      );
      return { scheduled: false as const };
    }
    const recoveryTarget = reservation.recoveryTarget;
    if (
      reservation.requirePendingTicketAction &&
      action.proposalVersion !== reservation.ticketActionProposalVersion
    ) {
      await ctx.db.patch(action._id, {
        resultCheckpointKey: undefined,
        resultCheckpointExpiresAt: undefined,
        resultRecoveryLeaseUntil: undefined,
        resultRecoveryScheduleId: undefined,
      });
      return { scheduled: false as const };
    }
    try {
      parseChatResultCheckpoint(reservation.resultCheckpointJson);
    } catch {
      await failCheckpointedChatAction(
        ctx,
        action,
        "AI result recovery checkpoint is malformed",
      );
      return { scheduled: false as const };
    }

    const ticket = await ctx.db.get(action.ticketId);
    if (!ticket || ticket.status !== "open") {
      await failCheckpointedChatAction(
        ctx,
        action,
        "Ticket closed before AI result publication",
      );
      return { scheduled: false as const };
    }
    const repository = ticket.repositoryId
      ? await ctx.db.get(ticket.repositoryId)
      : null;
    if (!repository || repository.disconnectCleanupPending === true) {
      await failCheckpointedChatAction(
        ctx,
        action,
        "Repository was removed before AI result publication",
      );
      return { scheduled: false as const };
    }
    const inputEpochChanged =
      recoveryTarget.expectedAiInputVersion !== ticket.aiInputVersion;
    const indexEpochChanged =
      recoveryTargetNeedsIndexEpoch(recoveryTarget, action) &&
      recoveryTarget.expectedIndexVersion !== repository.indexVersion;
    if (inputEpochChanged || indexEpochChanged) {
      await replaceStaleGenerationInTransaction(
        ctx,
        action,
        ticket,
        repository,
        recoveryTarget,
        inputEpochChanged
          ? "Ticket content changed after the AI result was generated"
          : "Repository index changed after the AI result was generated",
      );
      return { scheduled: false as const };
    }
    if (
      repository.isActive !== true ||
      repository.githubAccessRevokedAt !== undefined
    ) {
      // Access can be restored. Retain the checkpoint and let the lease/cron
      // retry until the bounded replay TTL expires.
      await ctx.db.patch(action._id, {
        resultRecoveryLeaseUntil: now + CHAT_RESULT_RECOVERY_LEASE_MS,
        resultRecoveryScheduleId: undefined,
      });
      return { scheduled: false as const };
    }

    let scheduleId: Id<"_scheduled_functions"> | undefined;
    switch (recoveryTarget.kind) {
      case "initial_ticket":
        scheduleId = await ctx.scheduler.runAfter(
          0,
          internal.tickets.internalAction.processNewTicket,
          {
            ticketId: ticket._id,
            repositoryId: repository._id,
            issueTitle: ticket.githubTitle,
            issueBody: ticket.githubBody ?? "",
            expectedAiInputVersion: recoveryTarget.expectedAiInputVersion,
            expectedIndexVersion: recoveryTarget.expectedIndexVersion,
            processingStage: recoveryTarget.stage,
            replayReservationKey: reservation.reservationKey,
            ...(recoveryTarget.stage === "start"
              ? { formatActionId: action._id }
              : { answerActionId: action._id }),
          },
        );
        break;
      case "regenerate":
        scheduleId = await ctx.scheduler.runAfter(
          0,
          internal.ticketActions.internalAction.regenerateWithFeedback,
          {
            actionId: action._id,
            expectedIndexVersion: recoveryTarget.expectedIndexVersion,
            replayReservationKey: reservation.reservationKey,
          },
        );
        break;
      case "follow_up":
        scheduleId = await ctx.scheduler.runAfter(
          0,
          internal.ticketActions.internalAction.processFollowUp,
          {
            actionId: action._id,
            expectedIndexVersion: recoveryTarget.expectedIndexVersion,
            replayReservationKey: reservation.reservationKey,
            ...(recoveryTarget.forceApproval === undefined
              ? {}
              : { forceApproval: recoveryTarget.forceApproval }),
          },
        );
        break;
    }
    if (!scheduleId) {
      throw new Error("AI chat recovery target is invalid");
    }
    await ctx.db.patch(action._id, {
      resultRecoveryLeaseUntil: now + CHAT_RESULT_RECOVERY_LEASE_MS,
      resultRecoveryScheduleId: scheduleId,
    });
    return { scheduled: true as const, scheduleId };
  },
});

export const recoverCheckpointedChatActions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expiredActions = await ctx.db
      .query("ticketActions")
      .withIndex("by_status_and_checkpoint_expiration", (q) =>
        q
          .eq("status", "pending")
          .gt("resultCheckpointExpiresAt", 0)
          .lt("resultCheckpointExpiresAt", now),
      )
      .take(CHAT_RESULT_RECOVERY_LIMIT);
    for (const action of expiredActions) {
      if (action.resultCheckpointKey) {
        await failCheckpointedChatAction(
          ctx,
          action,
          "AI result recovery expired before publication",
        );
      }
    }
    const actions = await ctx.db
      .query("ticketActions")
      .withIndex("by_status_and_checkpoint_expiration", (q) =>
        q.eq("status", "pending").gte("resultCheckpointExpiresAt", now),
      )
      .take(CHAT_RESULT_RECOVERY_LIMIT);
    let scheduled = 0;
    for (const action of actions) {
      if (
        !action.resultCheckpointKey ||
        (action.resultRecoveryLeaseUntil ?? 0) > now
      ) {
        continue;
      }
      const existingSchedule = action.resultRecoveryScheduleId
        ? await ctx.db.system.get(action.resultRecoveryScheduleId)
        : null;
      if (
        existingSchedule?.state.kind === "pending" ||
        existingSchedule?.state.kind === "inProgress"
      ) {
        continue;
      }
      const scheduleId = await ctx.scheduler.runAfter(
        0,
        internal._ai.chatBilling.resumeCheckpointedChatAction,
        {
          ticketActionId: action._id,
          reservationKey: action.resultCheckpointKey,
        },
      );
      await ctx.db.patch(action._id, {
        resultRecoveryLeaseUntil: now + CHAT_RESULT_RECOVERY_LEASE_MS,
        resultRecoveryScheduleId: scheduleId,
      });
      scheduled++;
    }
    return { scheduled };
  },
});

export const keepCheckpointedChatActionPending = internalMutation({
  args: { ticketActionId: v.id("ticketActions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.ticketActionId);
    if (
      !action ||
      action.status !== "pending" ||
      !action.resultCheckpointKey ||
      !action.resultCheckpointExpiresAt ||
      action.resultCheckpointExpiresAt <= Date.now()
    ) {
      return false;
    }
    const checkpointKey = action.resultCheckpointKey;
    const reservation = await ctx.db
      .query("chatUsageReservations")
      .withIndex("by_reservation_key", (q) =>
        q.eq("reservationKey", checkpointKey),
      )
      .unique();
    if (
      !reservation?.resultCheckpointJson ||
      reservation.ticketActionId !== action._id ||
      (reservation.requirePendingTicketAction &&
        reservation.ticketActionProposalVersion !== action.proposalVersion)
    ) {
      return false;
    }
    await ctx.db.patch(action._id, { errorMessage: undefined });
    return true;
  },
});

export const canReplayCheckpointedChatResult = internalQuery({
  args: {
    ticketActionId: v.id("ticketActions"),
    reservationKey: v.string(),
  },
  handler: async (ctx, args) => {
    const [action, reservation] = await Promise.all([
      ctx.db.get(args.ticketActionId),
      ctx.db
        .query("chatUsageReservations")
        .withIndex("by_reservation_key", (q) =>
          q.eq("reservationKey", args.reservationKey),
        )
        .unique(),
    ]);
    if (
      !action ||
      action.status !== "pending" ||
      action.resultCheckpointKey !== args.reservationKey ||
      !action.resultCheckpointExpiresAt ||
      action.resultCheckpointExpiresAt <= Date.now() ||
      !reservation?.resultCheckpointJson ||
      reservation.ticketActionId !== action._id ||
      (reservation.requirePendingTicketAction &&
        reservation.ticketActionProposalVersion !== action.proposalVersion) ||
      (reservation.status !== "finalized" &&
        !(
          reservation.status === "pending" &&
          reservation.settlementState === "staged"
        ))
    ) {
      return false;
    }
    try {
      parseChatResultCheckpoint(reservation.resultCheckpointJson);
      return true;
    } catch {
      return false;
    }
  },
});

export const cleanupChatReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("chatUsageReservations")
      .withIndex("by_status_settlement_and_expiration", (q) =>
        q
          .eq("status", "pending")
          .eq("settlementState", undefined)
          .lte("expiresAt", now),
      )
      .take(CHAT_RESERVATION_CLEANUP_LIMIT);
    for (const reservation of expired) {
      const ambiguous = reservation.providerStartedAt !== undefined;
      await ctx.db.patch(reservation._id, {
        status: ambiguous ? "ambiguous" : "released",
        releaseReason: ambiguous ? "ambiguous_provider_attempt" : "expired",
        updatedAt: now,
      });
    }
    const retentionCutoff = now - CHAT_RESERVATION_RETENTION_MS;
    let deleted = 0;
    for (const status of ["finalized", "released"] as const) {
      const rows = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_status_and_expiration", (q) =>
          q.eq("status", status).lte("expiresAt", retentionCutoff),
        )
        .take(CHAT_RESERVATION_CLEANUP_LIMIT - deleted);
      for (const row of rows) {
        await ctx.db.delete(row._id);
        deleted++;
      }
      if (deleted === CHAT_RESERVATION_CLEANUP_LIMIT) break;
    }
    // Ambiguous user-key calls cost Gitdog nothing and are never
    // reconciled, so they are dropped after the same retention period.
    if (deleted < CHAT_RESERVATION_CLEANUP_LIMIT) {
      const rows = await ctx.db
        .query("chatUsageReservations")
        .withIndex("by_key_source_status_and_expiration", (q) =>
          q
            .eq("keySource", "user")
            .eq("status", "ambiguous")
            .lte("expiresAt", retentionCutoff),
        )
        .take(CHAT_RESERVATION_CLEANUP_LIMIT - deleted);
      for (const row of rows) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    return { expired: expired.length, deleted };
  },
});

function reservationErrorMessage(reason: ReservationFailureReason): string {
  switch (reason) {
    case "limit_reached":
      return "The account token limit cannot cover this AI request";
    case "attempt_in_progress":
    case "provider_attempt_in_progress":
      return "AI work for this account is already in progress";
    case "terminal_settlement_pending":
      return "The ended Pro period is still settling provider usage";
    case "unresolved_provider_usage":
      return "AI usage must be reconciled before more AI work can run";
    case "user_key_unavailable":
      return "Your AI provider API key is no longer available. Add it again in Gitdog settings";
    case "user_key_required":
      return "This request started on your own API key. Add the key again in Gitdog settings to continue";
    default:
      return "AI usage could not be reserved safely";
  }
}

async function releaseReservationBestEffort(
  ctx: ActionCtx,
  args: {
    reservationKey: string;
    attemptToken: string;
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    ticketActionId: Id<"ticketActions">;
    confirmedNotBilled: boolean;
  },
): Promise<void> {
  for (let attempt = 0; attempt < CHAT_USAGE_MUTATION_MAX_ATTEMPTS; attempt++) {
    try {
      await ctx.runMutation(internal._ai.chatBilling.releaseChatUsage, args);
      return;
    } catch {
      if (attempt + 1 < CHAT_USAGE_MUTATION_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            CHAT_USAGE_MUTATION_RETRY_BASE_DELAY_MS * 2 ** attempt,
          ),
        );
      }
    }
  }
  console.warn("AI chat reservation could not be released safely");
}

async function stageProviderOutcomeWithRetry(
  ctx: ActionCtx,
  args: {
    reservationKey: string;
    attemptToken: string;
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    ticketActionId: Id<"ticketActions">;
    outcome: ChatSettlementOutcome;
    resultCheckpointJson?: string;
  },
): Promise<void> {
  let stagingError: unknown;
  for (let attempt = 0; attempt < CHAT_USAGE_MUTATION_MAX_ATTEMPTS; attempt++) {
    try {
      await ctx.runMutation(
        internal._ai.chatBilling.stageChatProviderOutcome,
        args,
      );
      return;
    } catch (error) {
      stagingError = error;
      if (attempt + 1 < CHAT_USAGE_MUTATION_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            CHAT_USAGE_MUTATION_RETRY_BASE_DELAY_MS * 2 ** attempt,
          ),
        );
      }
    }
  }
  throw stagingError ?? new Error("AI provider outcome could not be staged");
}

async function settleProviderOutcomeWithRetry(
  ctx: ActionCtx,
  args: { reservationKey: string; attemptToken: string },
): Promise<boolean> {
  for (let attempt = 0; attempt < CHAT_USAGE_MUTATION_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await ctx.runMutation(
        internal._ai.chatBilling.settleStagedChatOutcome,
        { ...args, fromScheduler: false },
      );
      if (result.status !== "finalized" && result.status !== "released") {
        throw new Error("AI provider outcome is no longer staged");
      }
      return true;
    } catch {
      if (attempt + 1 < CHAT_USAGE_MUTATION_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            CHAT_USAGE_MUTATION_RETRY_BASE_DELAY_MS * 2 ** attempt,
          ),
        );
      }
    }
  }
  console.error("AI usage settlement deferred to durable recovery");
  return false;
}

async function markAmbiguousBestEffort(
  ctx: ActionCtx,
  args: {
    reservationKey: string;
    attemptToken: string;
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    ticketActionId: Id<"ticketActions">;
    providerRequestId?: string;
  },
): Promise<void> {
  try {
    await ctx.runMutation(
      internal._ai.chatBilling.markChatUsageAmbiguous,
      args,
    );
  } catch {
    console.error("AI provider usage remains held for reconciliation");
  }
}

type ChatReservationResult =
  | { allowed: true; reservationKey: string }
  | {
      allowed: false;
      reason: ReservationFailureReason;
      resultCheckpointJson?: string;
    };

async function reserveChatUsageOnce(
  ctx: ActionCtx,
  args: {
    reservationKey: string;
    attemptToken: string;
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    ticketActionId: Id<"ticketActions">;
    requirePendingTicketAction: boolean;
    generationKey: string;
    operation: string;
    model: string;
    provider?: "google" | "anthropic" | "openai";
    requestFingerprint: string;
    keySource?: "user";
    inputTokenLimit: number;
    outputTokenLimit: number;
    recoveryTarget?: ChatRecoveryTarget;
  },
): Promise<ChatReservationResult> {
  return await ctx.runMutation(internal._ai.chatBilling.reserveChatUsage, args);
}

type ChatProviderStartResult =
  | { started: true; alreadyStarted: boolean }
  | {
      started: false;
      reason:
        | "provider_attempt_in_progress"
        | "reservation_history_too_large"
        | "reservation_closed"
        | "unresolved_provider_usage"
        | "user_key_unavailable";
    };

// A user-key refusal is the user's to fix, so it surfaces as the same
// actionable not-billed error the provider itself would raise.
function reservationRefusal(
  reason: ReservationFailureReason,
  providerId: string,
): Error {
  const keyProvider = providerId === "openai" ? "openai" : "anthropic";
  switch (reason) {
    case "user_key_unavailable":
      return new UserApiKeyError("unavailable", keyProvider);
    case "user_key_required":
      return new UserApiKeyError("removed", keyProvider);
    default:
      return new ChatBillingError(reservationErrorMessage(reason), reason);
  }
}

async function markChatProviderStartedWithMutationRetry(
  ctx: ActionCtx,
  identity: {
    reservationKey: string;
    attemptToken: string;
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    ticketActionId: Id<"ticketActions">;
  },
  beforeProviderStart?: () => Promise<void>,
): Promise<ChatProviderStartResult> {
  for (
    let mutationFailureCount = 0;
    mutationFailureCount < CHAT_USAGE_MUTATION_MAX_ATTEMPTS;
    mutationFailureCount++
  ) {
    await beforeProviderStart?.();
    try {
      return await ctx.runMutation(
        internal._ai.chatBilling.markChatProviderStarted,
        identity,
      );
    } catch (error) {
      if (mutationFailureCount + 1 >= CHAT_USAGE_MUTATION_MAX_ATTEMPTS) {
        throw new ChatBillingError(
          error instanceof Error
            ? `AI provider request could not be started durably: ${error.message}`
            : "AI provider request could not be started durably",
          "provider_start_failed",
        );
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          CHAT_USAGE_MUTATION_RETRY_BASE_DELAY_MS * 2 ** mutationFailureCount,
        ),
      );
    }
  }

  throw new ChatBillingError(
    "AI provider request could not be started durably",
    "provider_start_failed",
  );
}

export function createMeteredProvider(
  ctx: ActionCtx,
  args: {
    userId: Id<"users">;
    repositoryId: Id<"repositories">;
    ticketActionId: Id<"ticketActions">;
    generationKey: string;
    operation: string;
    provider: AiProvider;
    beforeProviderStart?: () => Promise<void>;
    requirePendingTicketAction: boolean;
    recoveryTarget?: ChatRecoveryTarget;
    // Total time this provider may wait for other work on the account
    // instead of failing a request that found a provider attempt in flight.
    activeProviderWaitMs?: number;
  },
): AiProvider {
  if (args.provider instanceof CreditFallbackProvider) {
    const wrap = (provider: AiProvider) =>
      createMeteredProvider(ctx, {
        ...args,
        provider,
      });
    return new CreditFallbackProvider(
      wrap(args.provider.primary),
      wrap(args.provider.fallback),
      args.provider.options,
    );
  }
  let fallbackCallIndex = 0;
  let activeProviderWaitMs = args.activeProviderWaitMs ?? 0;
  const waitForActiveProvider = async (): Promise<boolean> => {
    if (activeProviderWaitMs <= 0) return false;
    const delay = Math.min(ACTIVE_PROVIDER_POLL_MS, activeProviderWaitMs);
    activeProviderWaitMs -= delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return true;
  };
  const keySource = args.provider.keySource === "user" ? "user" : undefined;
  return {
    name: args.provider.name,
    modelId: args.provider.modelId,
    providerId: args.provider.providerId,
    keySource,
    chat: async (messages, options) => {
      const provider = args.provider.providerId;
      if (
        provider !== "google" &&
        provider !== "anthropic" &&
        provider !== "openai"
      ) {
        throw new Error("Chat billing wrapper requires a supported provider");
      }
      const label = options?.billingLabel ?? `call/${fallbackCallIndex++}`;
      const reservationKey = `chat:v1:${args.generationKey}:${label}`;
      const attemptToken = crypto.randomUUID();
      const limits = getChatReservationLimits(messages, options);
      const requestFingerprint = await createChatRequestFingerprint(
        messages,
        options,
      );
      const reserve = () =>
        reserveChatUsageOnce(ctx, {
          reservationKey,
          attemptToken,
          userId: args.userId,
          repositoryId: args.repositoryId,
          ticketActionId: args.ticketActionId,
          requirePendingTicketAction: args.requirePendingTicketAction,
          generationKey: args.generationKey,
          operation: `${args.operation}:${label}`,
          model: args.provider.modelId,
          provider,
          requestFingerprint,
          keySource,
          recoveryTarget: args.recoveryTarget,
          ...limits,
        });
      let reservation = await reserve();
      while (
        !reservation.allowed &&
        reservation.reason === "provider_attempt_in_progress" &&
        (await waitForActiveProvider())
      ) {
        reservation = await reserve();
      }
      if (!reservation.allowed) {
        if (reservation.resultCheckpointJson) {
          return parseChatResultCheckpoint(reservation.resultCheckpointJson);
        }
        throw reservationRefusal(reservation.reason, provider);
      }

      const identity = {
        reservationKey,
        attemptToken,
        userId: args.userId,
        repositoryId: args.repositoryId,
        ticketActionId: args.ticketActionId,
      };
      let providerStarted = false;
      let outcomeStaged = false;
      let settled = false;
      let providerRequestId: string | undefined;
      try {
        const startProvider = () =>
          markChatProviderStartedWithMutationRetry(
            ctx,
            identity,
            args.beforeProviderStart,
          );
        let providerStart = await startProvider();
        while (
          !providerStart.started &&
          providerStart.reason === "provider_attempt_in_progress" &&
          (await waitForActiveProvider())
        ) {
          providerStart = await startProvider();
        }
        providerStarted = providerStart.started;
        if (!providerStart.started) {
          await releaseReservationBestEffort(ctx, {
            ...identity,
            confirmedNotBilled: true,
          });
          throw reservationRefusal(providerStart.reason, provider);
        }

        const result = await args.provider.chat(messages, options);
        providerRequestId = result.providerRequestId;
        if (
          !result.usage ||
          !Number.isSafeInteger(result.usage.promptTokens) ||
          result.usage.promptTokens < 0 ||
          !Number.isSafeInteger(result.usage.completionTokens) ||
          result.usage.completionTokens < 0
        ) {
          throw new ChatBillingError(
            "AI provider usage is ambiguous",
            "provider_attempt_ambiguous",
          );
        }
        const outcome = {
          kind: "known_billed" as const,
          inputTokens: result.usage.promptTokens,
          outputTokens: result.usage.completionTokens,
          providerRequestId,
        };
        const resultCheckpointJson = serializeChatResultCheckpoint(
          result,
          outcome,
        );
        await stageProviderOutcomeWithRetry(ctx, {
          ...identity,
          outcome,
          resultCheckpointJson,
        });
        outcomeStaged = true;
        settled = await settleProviderOutcomeWithRetry(ctx, {
          reservationKey,
          attemptToken,
        });
        return result;
      } catch (error) {
        const providerError =
          error instanceof ChatProviderRequestError ? error : undefined;
        const confirmedNotBilled =
          providerError?.billingOutcome === "not_billed";
        const knownBilledUsage =
          providerError?.billingOutcome === "billed" &&
          providerError.usage &&
          Number.isSafeInteger(providerError.usage.promptTokens) &&
          providerError.usage.promptTokens >= 0 &&
          Number.isSafeInteger(providerError.usage.completionTokens) &&
          providerError.usage.completionTokens >= 0
            ? providerError.usage
            : undefined;
        if (providerStarted && !settled) {
          if (knownBilledUsage && !outcomeStaged) {
            try {
              await stageProviderOutcomeWithRetry(ctx, {
                ...identity,
                outcome: {
                  kind: "known_billed",
                  inputTokens: knownBilledUsage.promptTokens,
                  outputTokens: knownBilledUsage.completionTokens,
                  providerRequestId: providerError?.providerRequestId,
                },
              });
              outcomeStaged = true;
              settled = await settleProviderOutcomeWithRetry(ctx, {
                reservationKey,
                attemptToken,
              });
            } catch {
              if (!outcomeStaged) {
                await markAmbiguousBestEffort(ctx, {
                  ...identity,
                  providerRequestId: providerError?.providerRequestId,
                });
              }
            }
          } else if (confirmedNotBilled && !outcomeStaged) {
            try {
              await stageProviderOutcomeWithRetry(ctx, {
                ...identity,
                outcome: {
                  kind: "known_not_billed",
                  providerRequestId: providerError?.providerRequestId,
                },
              });
              outcomeStaged = true;
              settled = await settleProviderOutcomeWithRetry(ctx, {
                reservationKey,
                attemptToken,
              });
            } catch {
              if (!outcomeStaged) {
                await markAmbiguousBestEffort(ctx, {
                  ...identity,
                  providerRequestId: providerError?.providerRequestId,
                });
              }
            }
          } else if (!outcomeStaged) {
            await markAmbiguousBestEffort(ctx, {
              ...identity,
              providerRequestId:
                providerError?.providerRequestId ?? providerRequestId,
            });
          }
        } else if (!providerStarted) {
          await releaseReservationBestEffort(ctx, {
            ...identity,
            confirmedNotBilled: true,
          });
        }
        throw error;
      }
    },
  };
}

export async function hasOpenUsageReservation(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  // Retired embedding reservations are released by their cleanup cron and
  // no longer hold plan operations.
  const [chatPending, chatAmbiguous] = await Promise.all([
    ctx.db
      .query("chatUsageReservations")
      .withIndex("by_user_key_source_and_status", (q) =>
        q
          .eq("userId", userId)
          .eq("keySource", undefined)
          .eq("status", "pending"),
      )
      .first(),
    ctx.db
      .query("chatUsageReservations")
      .withIndex("by_user_key_source_and_status", (q) =>
        q
          .eq("userId", userId)
          .eq("keySource", undefined)
          .eq("status", "ambiguous"),
      )
      .first(),
  ]);
  return Boolean(chatPending || chatAmbiguous);
}
