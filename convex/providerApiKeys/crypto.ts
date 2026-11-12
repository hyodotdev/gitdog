import type { Doc } from "../_generated/dataModel";

export type KeyProvider = "anthropic" | "openai";

export const PROVIDER_KEY_PATTERNS: Record<KeyProvider, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,500}$/,
  openai: /^sk-(?!ant-)[A-Za-z0-9_-]{20,500}$/,
};

/** The provider whose key format matches, or null for neither. */
export function detectKeyProvider(apiKey: string): KeyProvider | null {
  if (PROVIDER_KEY_PATTERNS.anthropic.test(apiKey)) return "anthropic";
  if (PROVIDER_KEY_PATTERNS.openai.test(apiKey)) return "openai";
  return null;
}

export class ProviderKeyEncryptionError extends Error {}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Binds a ciphertext to its owner and provider so a copied row cannot decrypt.
function additionalData(userId: string, provider: KeyProvider) {
  return new TextEncoder().encode(`gitdog-byok:v1:${userId}:${provider}`);
}

async function loadEncryptionKey(): Promise<{ key: CryptoKey; keyId: string }> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(process.env.BYOK_ENCRYPTION_KEY?.trim() ?? "");
  } catch {
    throw new ProviderKeyEncryptionError(
      "Provider key encryption is not configured",
    );
  }
  if (raw.byteLength !== 32)
    throw new ProviderKeyEncryptionError(
      "Provider key encryption is not configured",
    );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return {
    key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]),
    keyId: Array.from(digest.subarray(0, 8), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

/** Identifies the configured encryption key, or null when none is usable. */
export async function currentEncryptionKeyId(): Promise<string | null> {
  try {
    return (await loadEncryptionKey()).keyId;
  } catch (error) {
    if (error instanceof ProviderKeyEncryptionError) return null;
    throw error;
  }
}

export async function encryptProviderKey(
  userId: string,
  provider: KeyProvider,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string; encryptionKeyId: string }> {
  const { key, keyId } = await loadEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(userId, provider) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iv: toBase64(iv),
    encryptionKeyId: keyId,
  };
}

export async function decryptProviderKey(
  row: Pick<
    Doc<"providerApiKeys">,
    "userId" | "provider" | "ciphertext" | "iv" | "encryptionKeyId"
  >,
): Promise<string> {
  const { key, keyId } = await loadEncryptionKey();
  if (row.encryptionKeyId !== keyId)
    throw new ProviderKeyEncryptionError(
      "Provider key was encrypted with a different key",
    );
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(row.iv),
        additionalData: additionalData(row.userId, row.provider),
      },
      key,
      fromBase64(row.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new ProviderKeyEncryptionError("Provider key could not be decrypted");
  }
}
