import type { QueryCtx } from "../_generated/server";
import { currentEncryptionKeyId } from "./crypto";

export type EncryptionState =
  | { ok: true; keyId: string }
  | { ok: false; reason: "missing" | "mismatch" | "inconsistent" };

const KEY_ID_SAMPLE = 50;

/**
 * The encryption key id saved provider keys are expected to use: the
 * recorded one, or, before anything was recorded, the id the existing keys
 * share. Null when no key was saved yet; "inconsistent" when existing keys
 * disagree and an operator must pick one.
 */
export async function readExpectedEncryptionKeyId(
  ctx: Pick<QueryCtx, "db">,
): Promise<string | null | "inconsistent"> {
  const recorded = await ctx.db.query("providerKeyEncryptionState").first();
  if (recorded) return recorded.expectedKeyId;
  const keys = await ctx.db.query("providerApiKeys").take(KEY_ID_SAMPLE);
  const ids = new Set(keys.map((key) => key.encryptionKeyId));
  if (ids.size === 0) return null;
  return ids.size === 1 ? [...ids][0] : "inconsistent";
}

/**
 * Whether this deployment can read provider keys at all. A missing key, or
 * one whose id differs from the key saved keys use, is a server
 * misconfiguration and must not be reported as users' keys failing.
 */
export async function readEncryptionState(
  ctx: Pick<QueryCtx, "db">,
): Promise<EncryptionState> {
  const keyId = await currentEncryptionKeyId();
  if (keyId === null) return { ok: false, reason: "missing" };
  const expected = await readExpectedEncryptionKeyId(ctx);
  if (expected === "inconsistent") return { ok: false, reason: "inconsistent" };
  if (expected !== null && expected !== keyId)
    return { ok: false, reason: "mismatch" };
  return { ok: true, keyId };
}
