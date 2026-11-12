import { httpAction, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { GenericActionCtx } from "convex/server";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import { v } from "convex/values";

export type LemonSqueezyEvent =
  | "subscription_created"
  | "subscription_updated"
  | "subscription_cancelled"
  | "subscription_resumed"
  | "subscription_expired"
  | "subscription_paused"
  | "subscription_unpaused"
  | "subscription_payment_success"
  | "subscription_payment_failed"
  | "subscription_payment_recovered"
  | "subscription_payment_refunded"
  | "order_created"
  | "order_refunded";

type SubscriptionStateEvent = Extract<
  LemonSqueezyEvent,
  | "subscription_created"
  | "subscription_updated"
  | "subscription_cancelled"
  | "subscription_resumed"
  | "subscription_expired"
  | "subscription_paused"
  | "subscription_unpaused"
>;
type SubscriptionPaymentEvent = Extract<
  LemonSqueezyEvent,
  "subscription_payment_success" | "subscription_payment_recovered"
>;
type SubscriptionStatus = "active" | "canceled" | "expired";
type BillingReason = "initial" | "renewal" | "updated";

export type WebhookEnvelope = {
  eventName: LemonSqueezyEvent;
  userId?: string;
  dataId: string;
  dataType: string;
  storeId: string;
  testMode: boolean;
  attributes: Record<string, unknown>;
};

export type ParsedSubscriptionState = {
  eventName: SubscriptionStateEvent;
  userId?: string;
  subscriptionId: string;
  customerId: string;
  variantId: string;
  status: SubscriptionStatus;
  providerCreatedAt: number;
  providerUpdatedAt: number;
  periodEnd: number;
};

export type ParsedPaidSubscriptionInvoice = {
  eventName: SubscriptionPaymentEvent;
  invoiceId: string;
  subscriptionId: string;
  customerId: string;
  billingReason: BillingReason;
  invoiceCreatedAt: number;
  invoiceUpdatedAt: number;
  amountCents: number;
  currency: string;
};

export type ParsedTokenPackOrder = {
  userId: string;
  orderId: string;
  orderCreatedAt: number;
  customerId: string;
  variantId: string;
  quantity: number;
  amountCents: number;
  currency: string;
};

export type ParsedTokenPackRefund = ParsedTokenPackOrder & {
  orderUpdatedAt: number;
  refundedAmountCents: number;
  refundStatus: "refunded" | "partial_refund";
};

export type ParsedSubscriptionInvoiceRefund = {
  invoiceId: string;
  subscriptionId: string;
  customerId: string;
  billingReason: BillingReason;
  invoiceCreatedAt: number;
  invoiceUpdatedAt: number;
  amountCents: number;
  refundedAmountCents: number;
  currency: string;
  refundStatus: "refunded" | "partial_refund";
};

const KNOWN_EVENTS = new Set<LemonSqueezyEvent>([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
  "subscription_payment_success",
  "subscription_payment_failed",
  "subscription_payment_recovered",
  "subscription_payment_refunded",
  "order_created",
  "order_refunded",
]);
const PAYMENT_ID_PATTERN = /^[1-9]\d*$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

type ConfiguredProductVariants = {
  pro: string;
  tokenPackSmall: string;
  tokenPackLarge: string;
};

function requirePositiveIdEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !PAYMENT_ID_PATTERN.test(value)) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function getConfiguredProductVariants(): ConfiguredProductVariants {
  const variants = {
    pro: requirePositiveIdEnvironment("LS_PRO_VARIANT_ID"),
    tokenPackSmall: requirePositiveIdEnvironment(
      "LS_TOKEN_PACK_SMALL_VARIANT_ID",
    ),
    tokenPackLarge: requirePositiveIdEnvironment(
      "LS_TOKEN_PACK_LARGE_VARIANT_ID",
    ),
  };
  if (new Set(Object.values(variants)).size !== 3) {
    throw new Error("Lemon Squeezy product variant IDs must be distinct");
  }
  return variants;
}

export function assertConfiguredProductVariants(): void {
  getConfiguredProductVariants();
}

function getSettlementFingerprintSecret(): string {
  const secret = process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1?.trim();
  if (!secret) {
    throw new Error("LS_SETTLEMENT_FINGERPRINT_SECRET_V1 is not configured");
  }
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error(
      "LS_SETTLEMENT_FINGERPRINT_SECRET_V1 must be at least 32 bytes",
    );
  }
  return secret;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function parsePositiveId(value: unknown, label: string): string {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value)
      ? value.toString()
      : typeof value === "string"
        ? value
        : "";
  if (!PAYMENT_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error(`Invalid ${label}`);
  }
  return timestamp;
}

function parseOptionalTimestamp(
  value: unknown,
  label: string,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  return parseTimestamp(value, label);
}

function parseSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function parseSingleTokenPackQuantity(value: unknown): 1 {
  if (value === undefined) return 1;
  const quantity = parseSafeInteger(value, "order quantity", 1);
  if (quantity !== 1) {
    throw new Error("Token-pack orders must contain exactly one item");
  }
  return 1;
}

function parseCurrency(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid payment currency");
  }
  const currency = value.toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new Error("Invalid payment currency");
  }
  return currency;
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
  return value;
}

function isSubscriptionStateEvent(
  eventName: LemonSqueezyEvent,
): eventName is SubscriptionStateEvent {
  return (
    eventName === "subscription_created" ||
    eventName === "subscription_updated" ||
    eventName === "subscription_cancelled" ||
    eventName === "subscription_resumed" ||
    eventName === "subscription_expired" ||
    eventName === "subscription_paused" ||
    eventName === "subscription_unpaused"
  );
}

export function parseLemonSqueezyWebhookEnvelope(
  value: unknown,
): WebhookEnvelope {
  const payload = asRecord(value, "webhook payload");
  const meta = asRecord(payload.meta, "webhook metadata");
  const eventNameValue = meta.event_name;
  if (
    typeof eventNameValue !== "string" ||
    !KNOWN_EVENTS.has(eventNameValue as LemonSqueezyEvent)
  ) {
    throw new Error("Unsupported webhook event");
  }
  const data = asRecord(payload.data, "webhook data");
  const dataType = data.type;
  if (typeof dataType !== "string" || dataType.length === 0) {
    throw new Error("Invalid webhook resource type");
  }
  const customData =
    meta.custom_data === undefined
      ? undefined
      : asRecord(meta.custom_data, "webhook custom data");
  const userIdValue = customData?.user_id;
  if (
    userIdValue !== undefined &&
    (typeof userIdValue !== "string" || userIdValue.trim().length === 0)
  ) {
    throw new Error("Invalid webhook user binding");
  }
  const attributes = asRecord(data.attributes, "webhook attributes");
  return {
    eventName: eventNameValue as LemonSqueezyEvent,
    ...(typeof userIdValue === "string" ? { userId: userIdValue } : {}),
    dataId: parsePositiveId(data.id, "webhook resource ID"),
    dataType,
    storeId: parsePositiveId(attributes.store_id, "Lemon Squeezy store ID"),
    testMode: parseBoolean(attributes.test_mode, "Lemon Squeezy test mode"),
    attributes,
  };
}

/** Reject signed events from another store or billing environment. */
export function assertConfiguredWebhookResource(
  envelope: Pick<WebhookEnvelope, "storeId" | "testMode">,
): void {
  const configuredStoreId = process.env.LS_STORE_ID?.trim();
  if (!configuredStoreId || !PAYMENT_ID_PATTERN.test(configuredStoreId)) {
    throw new Error("LS_STORE_ID is not configured");
  }
  const configuredTestMode = process.env.LS_TEST_MODE?.trim();
  if (configuredTestMode !== "true" && configuredTestMode !== "false") {
    throw new Error("LS_TEST_MODE is not configured");
  }
  if (envelope.storeId !== configuredStoreId) {
    throw new Error("Webhook belongs to another Lemon Squeezy store");
  }
  if (envelope.testMode !== (configuredTestMode === "true")) {
    throw new Error("Webhook Lemon Squeezy mode does not match deployment");
  }
}

function mapSubscriptionStatus(
  eventName: SubscriptionStateEvent,
  providerStatus: unknown,
): SubscriptionStatus {
  if (typeof providerStatus !== "string") {
    throw new Error("Invalid subscription status");
  }
  const mappedStatus: SubscriptionStatus =
    providerStatus === "active" || providerStatus === "on_trial"
      ? "active"
      : providerStatus === "expired"
        ? "expired"
        : providerStatus === "cancelled" ||
            providerStatus === "paused" ||
            providerStatus === "past_due" ||
            providerStatus === "unpaid"
          ? "canceled"
          : (() => {
              throw new Error("Unsupported subscription status");
            })();

  const eventMatches =
    eventName === "subscription_updated" ||
    (eventName === "subscription_created" && mappedStatus === "active") ||
    (eventName === "subscription_cancelled" &&
      providerStatus === "cancelled") ||
    (eventName === "subscription_resumed" && mappedStatus === "active") ||
    (eventName === "subscription_expired" && mappedStatus === "expired") ||
    (eventName === "subscription_paused" && providerStatus === "paused") ||
    (eventName === "subscription_unpaused" && mappedStatus === "active");
  if (!eventMatches) {
    throw new Error("Subscription status does not match webhook event");
  }
  return mappedStatus;
}

export function parseSubscriptionState(
  envelope: WebhookEnvelope,
): ParsedSubscriptionState {
  if (!isSubscriptionStateEvent(envelope.eventName)) {
    throw new Error("Webhook is not a subscription state event");
  }
  if (envelope.dataType !== "subscriptions") {
    throw new Error("Subscription event has the wrong resource type");
  }
  const providerCreatedAt = parseTimestamp(
    envelope.attributes.created_at,
    "subscription creation timestamp",
  );
  const providerUpdatedAt = parseTimestamp(
    envelope.attributes.updated_at,
    "subscription update timestamp",
  );
  if (providerUpdatedAt < providerCreatedAt) {
    throw new Error("Subscription update predates creation");
  }
  const status = mapSubscriptionStatus(
    envelope.eventName,
    envelope.attributes.status,
  );
  const renewsAt = parseOptionalTimestamp(
    envelope.attributes.renews_at,
    "subscription renewal timestamp",
  );
  const endsAt = parseOptionalTimestamp(
    envelope.attributes.ends_at,
    "subscription end timestamp",
  );
  const providerStatus = envelope.attributes.status;
  const revokeAtUpdate = Math.max(providerUpdatedAt, providerCreatedAt + 1);
  const periodEnd =
    status === "active"
      ? (endsAt ?? renewsAt)
      : providerStatus === "cancelled"
        ? (endsAt ?? revokeAtUpdate)
        : revokeAtUpdate;
  if (periodEnd === undefined || periodEnd <= providerCreatedAt) {
    throw new Error("Subscription has no authoritative period end");
  }
  if (status === "active" && periodEnd <= providerUpdatedAt) {
    throw new Error("Active subscription has no future period end");
  }

  return {
    eventName: envelope.eventName,
    ...(envelope.userId ? { userId: envelope.userId } : {}),
    subscriptionId: envelope.dataId,
    customerId: parsePositiveId(
      envelope.attributes.customer_id,
      "Lemon Squeezy customer ID",
    ),
    variantId: parsePositiveId(
      envelope.attributes.variant_id,
      "Lemon Squeezy variant ID",
    ),
    status,
    providerCreatedAt,
    providerUpdatedAt,
    periodEnd,
  };
}

function parseBillingReason(value: unknown): BillingReason {
  if (value === "initial" || value === "renewal" || value === "updated") {
    return value;
  }
  throw new Error("Unsupported subscription invoice billing reason");
}

export function parsePaidSubscriptionInvoice(
  envelope: WebhookEnvelope,
): ParsedPaidSubscriptionInvoice {
  if (
    envelope.eventName !== "subscription_payment_success" &&
    envelope.eventName !== "subscription_payment_recovered"
  ) {
    throw new Error("Webhook is not a paid subscription invoice event");
  }
  if (envelope.dataType !== "subscription-invoices") {
    throw new Error("Subscription invoice has the wrong resource type");
  }
  if (envelope.attributes.status !== "paid") {
    throw new Error("Subscription invoice is not paid");
  }
  const invoiceCreatedAt = parseTimestamp(
    envelope.attributes.created_at,
    "invoice creation timestamp",
  );
  const invoiceUpdatedAt = parseTimestamp(
    envelope.attributes.updated_at,
    "invoice update timestamp",
  );
  if (invoiceUpdatedAt < invoiceCreatedAt) {
    throw new Error("Invoice update predates creation");
  }
  return {
    eventName: envelope.eventName,
    invoiceId: envelope.dataId,
    subscriptionId: parsePositiveId(
      envelope.attributes.subscription_id,
      "Lemon Squeezy subscription ID",
    ),
    customerId: parsePositiveId(
      envelope.attributes.customer_id,
      "Lemon Squeezy customer ID",
    ),
    billingReason: parseBillingReason(envelope.attributes.billing_reason),
    invoiceCreatedAt,
    invoiceUpdatedAt,
    amountCents: parseSafeInteger(
      envelope.attributes.total,
      "invoice total",
      0,
    ),
    currency: parseCurrency(envelope.attributes.currency),
  };
}

export function parseTokenPackOrder(
  envelope: WebhookEnvelope,
): ParsedTokenPackOrder {
  if (envelope.eventName !== "order_created") {
    throw new Error("Webhook is not an order event");
  }
  if (envelope.dataType !== "orders") {
    throw new Error("Order event has the wrong resource type");
  }
  if (envelope.attributes.status !== "paid") {
    throw new Error("Order is not paid");
  }
  if (!envelope.userId) {
    throw new Error("Order is missing its bound user");
  }
  const firstOrderItem = asRecord(
    envelope.attributes.first_order_item,
    "first order item",
  );
  return {
    userId: envelope.userId,
    orderId: envelope.dataId,
    orderCreatedAt: parseTimestamp(
      envelope.attributes.created_at,
      "order creation timestamp",
    ),
    customerId: parsePositiveId(
      envelope.attributes.customer_id,
      "Lemon Squeezy customer ID",
    ),
    variantId: parsePositiveId(
      firstOrderItem.variant_id,
      "Lemon Squeezy variant ID",
    ),
    quantity: parseSingleTokenPackQuantity(firstOrderItem.quantity),
    amountCents: parseSafeInteger(envelope.attributes.total, "order total", 0),
    currency: parseCurrency(envelope.attributes.currency),
  };
}

function parseRefundStatus(value: unknown): "refunded" | "partial_refund" {
  if (value === "refunded" || value === "partial_refund") return value;
  throw new Error("Invalid refund status");
}

export function parseTokenPackRefund(
  envelope: WebhookEnvelope,
): ParsedTokenPackRefund {
  if (envelope.eventName !== "order_refunded") {
    throw new Error("Webhook is not an order refund event");
  }
  const order = parseTokenPackOrder({
    ...envelope,
    eventName: "order_created",
    attributes: { ...envelope.attributes, status: "paid" },
  });
  const refund: ParsedTokenPackRefund = {
    ...order,
    orderUpdatedAt: parseTimestamp(
      envelope.attributes.updated_at,
      "order update timestamp",
    ),
    refundedAmountCents: parseSafeInteger(
      envelope.attributes.refunded_amount,
      "order refunded amount",
      1,
    ),
    refundStatus: parseRefundStatus(envelope.attributes.status),
  };
  if (refund.orderUpdatedAt < refund.orderCreatedAt) {
    throw new Error("Order refund update predates order creation");
  }
  if (refund.refundedAmountCents > refund.amountCents) {
    throw new Error("Order refunded amount exceeds order total");
  }
  return refund;
}

export function parseSubscriptionInvoiceRefund(
  envelope: WebhookEnvelope,
): ParsedSubscriptionInvoiceRefund {
  if (envelope.eventName !== "subscription_payment_refunded") {
    throw new Error("Webhook is not a subscription invoice refund event");
  }
  if (envelope.dataType !== "subscription-invoices") {
    throw new Error("Subscription invoice refund has the wrong resource type");
  }
  const refund: ParsedSubscriptionInvoiceRefund = {
    invoiceId: envelope.dataId,
    subscriptionId: parsePositiveId(
      envelope.attributes.subscription_id,
      "Lemon Squeezy subscription ID",
    ),
    customerId: parsePositiveId(
      envelope.attributes.customer_id,
      "Lemon Squeezy customer ID",
    ),
    billingReason: parseBillingReason(envelope.attributes.billing_reason),
    invoiceCreatedAt: parseTimestamp(
      envelope.attributes.created_at,
      "invoice creation timestamp",
    ),
    invoiceUpdatedAt: parseTimestamp(
      envelope.attributes.updated_at,
      "invoice update timestamp",
    ),
    amountCents: parseSafeInteger(
      envelope.attributes.total,
      "invoice total",
      0,
    ),
    refundedAmountCents: parseSafeInteger(
      envelope.attributes.refunded_amount,
      "invoice refunded amount",
      1,
    ),
    currency: parseCurrency(envelope.attributes.currency),
    refundStatus: parseRefundStatus(envelope.attributes.status),
  };
  if (refund.invoiceUpdatedAt < refund.invoiceCreatedAt) {
    throw new Error("Invoice refund update predates invoice creation");
  }
  if (refund.refundedAmountCents > refund.amountCents) {
    throw new Error("Invoice refunded amount exceeds invoice total");
  }
  return refund;
}

export const SETTLEMENT_FINGERPRINT_VERSION = 1 as const;
export const SETTLEMENT_FINGERPRINT_KEY_ATTESTATION_DOMAIN =
  "settlement-fingerprint-key-attestation-v1";

async function hmacSha256Hex(value: string): Promise<string> {
  const secret = getSettlementFingerprintSecret();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Hash exact settlement identity before crossing into the durable mutation. */
export async function createSettlementIdentityFingerprint(
  identity: readonly (string | number)[],
): Promise<string> {
  return await hmacSha256Hex(
    JSON.stringify(["settlement-identity-v1", ...identity]),
  );
}

/** Hash the provider identifier before retaining an idempotency tombstone. */
export async function createSettlementKeyFingerprint(
  settlementType: "order" | "invoice" | "order_refund" | "invoice_refund",
  providerId: string,
): Promise<string> {
  return await hmacSha256Hex(
    JSON.stringify(["settlement-key-v1", settlementType, providerId]),
  );
}

/** Non-secret proof used to detect accidental settlement-key rotation. */
export async function createSettlementFingerprintKeyAttestation(): Promise<string> {
  return await hmacSha256Hex(
    JSON.stringify([SETTLEMENT_FINGERPRINT_KEY_ATTESTATION_DOMAIN]),
  );
}

/** Fail closed on deployment configuration before interpreting a signed event. */
export function assertLemonSqueezyRuntimeConfiguration(): void {
  requirePositiveIdEnvironment("LS_STORE_ID");
  const testMode = process.env.LS_TEST_MODE?.trim();
  if (testMode !== "true" && testMode !== "false") {
    throw new Error("LS_TEST_MODE is not configured");
  }
  getSettlementFingerprintSecret();
  assertConfiguredProductVariants();
}

export async function verifyLemonSqueezySignature(
  signature: string,
  body: string,
  secret: string,
): Promise<boolean> {
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureBytes = Uint8Array.from(
      signature.match(/.{2}/g) ?? [],
      (byte) => Number.parseInt(byte, 16),
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      encoder.encode(body),
    );
  } catch (error) {
    void error;
    console.error("Lemon Squeezy signature verification failed");
    return false;
  }
}

function getConfiguredProductType(
  variantId: string,
): "pro" | "token_pack_small" | "token_pack_large" | null {
  const variants = getConfiguredProductVariants();
  if (variantId === variants.pro) return "pro";
  if (variantId === variants.tokenPackSmall) {
    return "token_pack_small";
  }
  if (variantId === variants.tokenPackLarge) {
    return "token_pack_large";
  }
  return null;
}

export function resolveConfiguredOrderProductType(
  variantId: string,
): "pro" | "token_pack_small" | "token_pack_large" {
  const productType = getConfiguredProductType(variantId);
  if (productType === null) {
    throw new Error("Order variant is not configured for this deployment");
  }
  return productType;
}

async function handleSubscriptionStateEvent(
  ctx: GenericActionCtx<DataModel>,
  envelope: WebhookEnvelope,
): Promise<void> {
  const state = parseSubscriptionState(envelope);
  if (state.eventName === "subscription_created" && !state.userId) {
    throw new Error("Subscription creation is missing its bound user");
  }
  const result = await ctx.runMutation(
    internal.subscriptions.internalMutation.syncLemonSqueezySubscription,
    {
      eventName: state.eventName,
      ...(state.userId ? { userId: state.userId } : {}),
      lemonSqueezySubscriptionId: state.subscriptionId,
      lemonSqueezyCustomerId: state.customerId,
      lemonSqueezyVariantId: state.variantId,
      status: state.status,
      providerCreatedAt: state.providerCreatedAt,
      providerUpdatedAt: state.providerUpdatedAt,
      periodEnd: state.periodEnd,
    },
  );
  if (result.outcome === "manual_review") {
    throw new Error("Subscription state requires manual billing review");
  }
  console.log("Subscription state synchronized:", {
    eventName: state.eventName,
    outcome: result.outcome,
  });
}

async function handlePaidSubscriptionInvoice(
  ctx: GenericActionCtx<DataModel>,
  envelope: WebhookEnvelope,
): Promise<void> {
  const invoice = parsePaidSubscriptionInvoice(envelope);
  const identityFingerprint = await createSettlementIdentityFingerprint([
    "invoice",
    invoice.invoiceId,
    invoice.subscriptionId,
    invoice.customerId,
    invoice.billingReason,
    invoice.invoiceCreatedAt,
    invoice.amountCents,
    invoice.currency,
  ]);
  const settlementKeyFingerprint = await createSettlementKeyFingerprint(
    "invoice",
    invoice.invoiceId,
  );
  const fingerprintKeyAttestation =
    await createSettlementFingerprintKeyAttestation();
  const result = await ctx.runMutation(
    internal.subscriptions.internalMutation.enqueueSubscriptionInvoice,
    {
      eventName: invoice.eventName,
      invoiceId: invoice.invoiceId,
      subscriptionId: invoice.subscriptionId,
      customerId: invoice.customerId,
      billingReason: invoice.billingReason,
      invoiceCreatedAt: invoice.invoiceCreatedAt,
      invoiceUpdatedAt: invoice.invoiceUpdatedAt,
      amountCents: invoice.amountCents,
      currency: invoice.currency,
      fingerprintKeyAttestation,
      settlementKeyFingerprint,
      identityFingerprint,
    },
  );
  console.log("Subscription invoice queued:", {
    outcome: result.outcome,
  });
}

async function handleSubscriptionPaymentFailed(
  ctx: GenericActionCtx<DataModel>,
  envelope: WebhookEnvelope,
): Promise<void> {
  if (envelope.dataType !== "subscription-invoices") {
    throw new Error("Failed subscription payment has the wrong resource type");
  }
  const invoiceCreatedAt = parseTimestamp(
    envelope.attributes.created_at,
    "invoice creation timestamp",
  );
  await ctx.runMutation(internal.paymentLogs.internalMutation.createLog, {
    lemonSqueezyEventId: envelope.dataId,
    lemonSqueezyInvoiceId: envelope.dataId,
    lemonSqueezySubscriptionId: parsePositiveId(
      envelope.attributes.subscription_id,
      "Lemon Squeezy subscription ID",
    ),
    lemonSqueezyCustomerId: parsePositiveId(
      envelope.attributes.customer_id,
      "Lemon Squeezy customer ID",
    ),
    lemonSqueezyBillingReason: parseBillingReason(
      envelope.attributes.billing_reason,
    ),
    lemonSqueezyInvoiceCreatedAt: invoiceCreatedAt,
    eventType: "subscription_payment_failed",
    productType: "pro",
    amountCents: parseSafeInteger(
      envelope.attributes.total,
      "invoice total",
      0,
    ),
    currency: parseCurrency(envelope.attributes.currency),
    status: "failed",
    errorMessage: "Payment failed",
  });
  console.log("Subscription payment failure recorded");
}

async function handleOrderCreated(
  ctx: GenericActionCtx<DataModel>,
  envelope: WebhookEnvelope,
): Promise<void> {
  let order: ParsedTokenPackOrder;
  try {
    order = parseTokenPackOrder(envelope);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Invalid Lemon Squeezy variant ID"
    ) {
      console.warn("Order is missing a valid variant ID");
    }
    throw error;
  }
  const productType = resolveConfiguredOrderProductType(order.variantId);
  if (productType === "pro") {
    console.log("Order does not require token-pack fulfillment:", {
      productType,
    });
    return;
  }
  const identityFingerprint = await createSettlementIdentityFingerprint([
    "order",
    order.userId,
    order.orderId,
    order.orderCreatedAt,
    order.customerId,
    order.variantId,
    order.quantity,
    order.amountCents,
    order.currency,
  ]);
  const settlementKeyFingerprint = await createSettlementKeyFingerprint(
    "order",
    order.orderId,
  );
  const fingerprintKeyAttestation =
    await createSettlementFingerprintKeyAttestation();
  const result = await ctx.runMutation(
    internal.subscriptions.internalMutation.fulfillTokenPackOrder,
    {
      ...order,
      fingerprintKeyAttestation,
      settlementKeyFingerprint,
      identityFingerprint,
    },
  );
  console.log("Token-pack order fulfilled:", {
    productType,
    outcome: result.outcome,
  });
}

async function handleOrderRefunded(
  ctx: GenericActionCtx<DataModel>,
  envelope: WebhookEnvelope,
): Promise<void> {
  const refund = parseTokenPackRefund(envelope);
  const originalSettlementKeyFingerprint = await createSettlementKeyFingerprint(
    "order",
    refund.orderId,
  );
  const originalIdentityFingerprint = await createSettlementIdentityFingerprint(
    [
      "order",
      refund.userId,
      refund.orderId,
      refund.orderCreatedAt,
      refund.customerId,
      refund.variantId,
      refund.quantity,
      refund.amountCents,
      refund.currency,
    ],
  );
  const settlementKeyFingerprint = await createSettlementKeyFingerprint(
    "order_refund",
    `${refund.orderId}:${refund.refundedAmountCents}`,
  );
  const identityFingerprint = await createSettlementIdentityFingerprint([
    "order_refund",
    refund.userId,
    refund.orderId,
    refund.orderCreatedAt,
    refund.customerId,
    refund.variantId,
    refund.quantity,
    refund.amountCents,
    refund.refundedAmountCents,
    refund.currency,
    refund.refundStatus,
  ]);
  const fingerprintKeyAttestation =
    await createSettlementFingerprintKeyAttestation();
  const result = await ctx.runMutation(
    internal.subscriptions.internalMutation.processTokenPackRefund,
    {
      ...refund,
      fingerprintKeyAttestation,
      originalSettlementKeyFingerprint,
      originalIdentityFingerprint,
      settlementKeyFingerprint,
      identityFingerprint,
    },
  );
  console.log("Token-pack refund recorded:", {
    outcome: result.outcome,
  });
}

async function handleSubscriptionInvoiceRefunded(
  ctx: GenericActionCtx<DataModel>,
  envelope: WebhookEnvelope,
): Promise<void> {
  const refund = parseSubscriptionInvoiceRefund(envelope);
  const settlementKeyFingerprint = await createSettlementKeyFingerprint(
    "invoice_refund",
    `${refund.invoiceId}:${refund.refundedAmountCents}`,
  );
  const identityFingerprint = await createSettlementIdentityFingerprint([
    "invoice_refund",
    refund.invoiceId,
    refund.subscriptionId,
    refund.customerId,
    refund.billingReason,
    refund.invoiceCreatedAt,
    refund.amountCents,
    refund.refundedAmountCents,
    refund.currency,
    refund.refundStatus,
  ]);
  const fingerprintKeyAttestation =
    await createSettlementFingerprintKeyAttestation();
  const result = await ctx.runMutation(
    internal.subscriptions.internalMutation
      .recordSubscriptionInvoiceRefundManualReview,
    {
      ...refund,
      fingerprintKeyAttestation,
      settlementKeyFingerprint,
      identityFingerprint,
    },
  );
  console.log("Subscription invoice refund queued for review:", {
    outcome: result.outcome,
  });
}

export const handleLemonSqueezyWebhook = httpAction(async (ctx, request) => {
  const signature = request.headers.get("x-signature");
  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const secret = process.env.LS_WEBHOOK_SECRET;
  if (!secret) {
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  const body = await request.text();
  if (!(await verifyLemonSqueezySignature(signature, body, secret))) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    assertLemonSqueezyRuntimeConfiguration();
  } catch (error) {
    void error;
    console.error("Lemon Squeezy runtime configuration is invalid");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let envelope: WebhookEnvelope;
  try {
    envelope = parseLemonSqueezyWebhookEnvelope(JSON.parse(body) as unknown);
    assertConfiguredWebhookResource(envelope);
  } catch (error) {
    void error;
    console.error("Invalid Lemon Squeezy webhook envelope");
    return new Response(JSON.stringify({ error: "Invalid payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (isSubscriptionStateEvent(envelope.eventName)) {
      await handleSubscriptionStateEvent(ctx, envelope);
    } else if (
      envelope.eventName === "subscription_payment_success" ||
      envelope.eventName === "subscription_payment_recovered"
    ) {
      await handlePaidSubscriptionInvoice(ctx, envelope);
    } else if (envelope.eventName === "subscription_payment_failed") {
      await handleSubscriptionPaymentFailed(ctx, envelope);
    } else if (envelope.eventName === "order_created") {
      await handleOrderCreated(ctx, envelope);
    } else if (envelope.eventName === "order_refunded") {
      await handleOrderRefunded(ctx, envelope);
    } else if (envelope.eventName === "subscription_payment_refunded") {
      await handleSubscriptionInvoiceRefunded(ctx, envelope);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    void error;
    console.error("Error processing Lemon Squeezy webhook");
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

/** Process a durable invoice work item; failures are persisted and retried. */
export const processSubscriptionInvoiceInbox = internalAction({
  args: { inboxId: v.id("lemonSqueezyInvoiceInbox") },
  handler: async (
    ctx: GenericActionCtx<DataModel>,
    args: { inboxId: Id<"lemonSqueezyInvoiceInbox"> },
  ): Promise<{ outcome: string }> => {
    const fingerprintKeyAttestation =
      await createSettlementFingerprintKeyAttestation();
    const settlementConfiguration = { fingerprintKeyAttestation };
    const inbox = (await ctx.runMutation(
      internal.subscriptions.internalMutation.claimSubscriptionInvoiceInbox,
      { ...args, ...settlementConfiguration },
    )) as (Doc<"lemonSqueezyInvoiceInbox"> & { leaseToken: string }) | null;
    if (!inbox) return { outcome: "ignored" as const };

    try {
      const result = (await ctx.runMutation(
        internal.subscriptions.internalMutation.settleSubscriptionInvoice,
        {
          eventName: inbox.eventName,
          invoiceId: inbox.invoiceId,
          invoiceStatus: "paid",
          subscriptionId: inbox.subscriptionId,
          customerId: inbox.customerId,
          billingReason: inbox.billingReason,
          invoiceCreatedAt: inbox.invoiceCreatedAt,
          invoiceUpdatedAt: inbox.invoiceUpdatedAt,
          amountCents: inbox.amountCents,
          currency: inbox.currency,
          ...settlementConfiguration,
          settlementKeyFingerprint: inbox.settlementKeyFingerprint,
          identityFingerprint: inbox.identityFingerprint,
        },
      )) as {
        outcome:
          "applied" | "duplicate" | "stale" | "manual_review" | "deferred";
        retryReason?: string;
      };
      if (result.outcome === "deferred") {
        await ctx.runMutation(
          internal.subscriptions.internalMutation.deferSubscriptionInvoiceInbox,
          {
            inboxId: inbox._id,
            leaseToken: inbox.leaseToken,
            error:
              result.retryReason ??
              "Subscription invoice settlement is not ready",
            ...settlementConfiguration,
          },
        );
        return { outcome: "deferred" as const };
      }
      await ctx.runMutation(
        internal.subscriptions.internalMutation
          .completeSubscriptionInvoiceInbox,
        {
          inboxId: inbox._id,
          leaseToken: inbox.leaseToken,
          settlementOutcome: result.outcome,
          ...settlementConfiguration,
        },
      );
      return { outcome: result.outcome };
    } catch (error) {
      await ctx.runMutation(
        internal.subscriptions.internalMutation.deferSubscriptionInvoiceInbox,
        {
          inboxId: inbox._id,
          leaseToken: inbox.leaseToken,
          error:
            error instanceof Error
              ? error.message
              : "Unknown subscription invoice processing error",
          ...settlementConfiguration,
        },
      );
      return { outcome: "deferred" as const };
    }
  },
});
