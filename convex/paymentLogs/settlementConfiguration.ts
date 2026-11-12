import type { MutationCtx } from "../_generated/server";

const SETTLEMENT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export type SettlementConfiguration = {
  fingerprintKeyAttestation: string;
};

/** Pin the settlement fingerprint key identity and reject accidental rotation. */
export async function assertAndPinSettlementConfiguration(
  ctx: MutationCtx,
  configuration: SettlementConfiguration,
): Promise<void> {
  if (
    !SETTLEMENT_FINGERPRINT_PATTERN.test(
      configuration.fingerprintKeyAttestation,
    )
  ) {
    throw new Error("Invalid settlement fingerprint key attestation");
  }

  const rows = await ctx.db
    .query("paymentSettlementConfiguration")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .take(2);
  if (rows.length > 1) {
    throw new Error("Duplicate payment settlement configurations");
  }

  const existing = rows[0];
  if (existing) {
    if (
      existing.fingerprintKeyAttestation !==
      configuration.fingerprintKeyAttestation
    ) {
      throw new Error("Settlement fingerprint key attestation mismatch");
    }
    return;
  }

  await ctx.db.insert("paymentSettlementConfiguration", {
    key: "global",
    fingerprintKeyAttestation: configuration.fingerprintKeyAttestation,
    updatedAt: Date.now(),
  });
}
