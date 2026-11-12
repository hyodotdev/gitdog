import { v } from "convex/values";

import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
} from "../_generated/server";
import { SETTLEMENT_FINGERPRINT_KEY_ATTESTATION_DOMAIN } from "../lemonSqueezy/webhook";
import { assertAndPinSettlementConfiguration } from "./settlementConfiguration";

export const PAYMENT_LOG_MAINTENANCE_BATCH_SIZE = 100;
export const PAYMENT_LOG_RETENTION_YEARS = 5;

export function getPaymentLogRetentionCutoff(now: number): number {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - PAYMENT_LOG_RETENTION_YEARS);
  return cutoff.getTime();
}

async function createFingerprintKeyAttestation(
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      JSON.stringify([SETTLEMENT_FINGERPRINT_KEY_ATTESTATION_DOMAIN]),
    ),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify that the active HMAC key matches the identity pinned in Convex. */
export const verifySettlementConfiguration = internalAction({
  args: {},
  handler: async (ctx): Promise<{ verified: true }> => {
    const secret = process.env.LS_SETTLEMENT_FINGERPRINT_SECRET_V1?.trim();
    if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
      throw new Error("Settlement fingerprint key is not configured");
    }
    const fingerprintKeyAttestation =
      await createFingerprintKeyAttestation(secret);
    await ctx.runMutation(
      internal.paymentLogs.privacy.pinOrAssertSettlementConfiguration,
      { fingerprintKeyAttestation },
    );
    return { verified: true };
  },
});

export const pinOrAssertSettlementConfiguration = internalMutation({
  args: { fingerprintKeyAttestation: v.string() },
  handler: async (ctx, args): Promise<void> => {
    await assertAndPinSettlementConfiguration(ctx, args);
  },
});

async function deleteExpiredManualReviews(
  ctx: MutationCtx,
  now: number,
): Promise<number> {
  const open = await ctx.db
    .query("paymentSettlementManualReviews")
    .withIndex("by_status_and_expiration", (q) =>
      q.eq("status", "open").lt("expiresAt", now),
    )
    .take(PAYMENT_LOG_MAINTENANCE_BATCH_SIZE);
  const remaining = PAYMENT_LOG_MAINTENANCE_BATCH_SIZE - open.length;
  const resolved =
    remaining > 0
      ? await ctx.db
          .query("paymentSettlementManualReviews")
          .withIndex("by_status_and_expiration", (q) =>
            q.eq("status", "resolved").lt("expiresAt", now),
          )
          .take(remaining)
      : [];
  for (const review of [...open, ...resolved]) {
    await ctx.db.delete(review._id);
  }
  return open.length + resolved.length;
}

async function deleteExpiredInvoiceInbox(
  ctx: MutationCtx,
  now: number,
  limit: number,
): Promise<number> {
  let remaining = limit;
  let deleted = 0;
  for (const status of ["manual_review", "pending", "processing"] as const) {
    if (remaining === 0) break;
    const rows = await ctx.db
      .query("lemonSqueezyInvoiceInbox")
      .withIndex("by_status_and_expiration", (q) =>
        q.eq("status", status).lt("expiresAt", now),
      )
      .take(remaining);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    deleted += rows.length;
    remaining -= rows.length;
  }
  return deleted;
}

export const deleteExpiredPaymentLogs = internalMutation({
  args: {
    cutoff: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    deleted: number;
    manualReviewsDeleted: number;
    invoiceInboxDeleted: number;
    cutoff: number;
    continuationScheduled: boolean;
  }> => {
    const now = Date.now();
    const cutoff = args.cutoff ?? getPaymentLogRetentionCutoff(now);
    const manualReviewsDeleted = await deleteExpiredManualReviews(ctx, now);
    const invoiceInboxDeleted = await deleteExpiredInvoiceInbox(
      ctx,
      now,
      PAYMENT_LOG_MAINTENANCE_BATCH_SIZE - manualReviewsDeleted,
    );
    const expiredLogs = await ctx.db
      .query("paymentLogs")
      .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
      .order("asc")
      .take(PAYMENT_LOG_MAINTENANCE_BATCH_SIZE);
    for (const log of expiredLogs) {
      await ctx.db.delete(log._id);
    }

    const continuationScheduled =
      expiredLogs.length === PAYMENT_LOG_MAINTENANCE_BATCH_SIZE ||
      manualReviewsDeleted + invoiceInboxDeleted ===
        PAYMENT_LOG_MAINTENANCE_BATCH_SIZE;
    if (continuationScheduled) {
      await ctx.scheduler.runAfter(
        0,
        internal.paymentLogs.privacy.deleteExpiredPaymentLogs,
        { cutoff },
      );
    }
    return {
      deleted: expiredLogs.length,
      manualReviewsDeleted,
      invoiceInboxDeleted,
      cutoff,
      continuationScheduled,
    };
  },
});
