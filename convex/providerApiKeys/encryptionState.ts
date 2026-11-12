import type { QueryCtx } from "../_generated/server";
import { currentEncryptionKeyId } from "./crypto";

export type EncryptionState =
  { ok: true; keyId: string } | { ok: false; reason: "missing" | "mismatch" };

/**
 * Whether this deployment can read provider keys at all. A missing key, or
 * one whose id differs from the key keys were first saved with, is a
 * server misconfiguration and must not be reported as users' keys failing.
 */
export async function readEncryptionState(
  ctx: Pick<QueryCtx, "db">,
): Promise<EncryptionState> {
  const keyId = await currentEncryptionKeyId();
  if (keyId === null) return { ok: false, reason: "missing" };
  const expected = await ctx.db.query("providerKeyEncryptionState").first();
  if (expected && expected.expectedKeyId !== keyId)
    return { ok: false, reason: "mismatch" };
  return { ok: true, keyId };
}
