import type { Doc } from "../_generated/dataModel";

// An out-of-credit key is retried after this long, or at once after the user
// checks it again in settings.
export const OUT_OF_CREDIT_RETRY_MS = 60 * 60 * 1_000;

export function isUsableProviderKey(
  key: Pick<Doc<"providerApiKeys">, "status" | "lastError" | "updatedAt">,
  now: number,
): boolean {
  switch (key.status) {
    case "active":
      return true;
    case "out_of_credit":
      return (
        (key.lastError?.at ?? key.updatedAt) + OUT_OF_CREDIT_RETRY_MS <= now
      );
    default:
      return false;
  }
}
