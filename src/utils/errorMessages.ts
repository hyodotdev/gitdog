import { TFunction } from "i18next";

/**
 * Translate error messages from backend to user-friendly localized messages
 */
export function translateErrorMessage(
  error: Error | string,
  t: TFunction,
): string {
  const message = typeof error === "string" ? error : error.message;
  const lowerMessage = message.toLowerCase();

  const keyFailure = getProviderKeyFailure(message);
  if (keyFailure) {
    return t(`errors.providerKey.${keyFailure.kind}`, {
      provider: keyFailure.provider ?? t("errors.providerKey.yourProvider"),
    });
  }

  // Discussion errors
  if (lowerMessage.includes("failed to find discussion")) {
    return t("errors.discussion.notFound");
  }
  if (lowerMessage.includes("failed to update discussion")) {
    return t("errors.discussion.updateFailed");
  }
  if (lowerMessage.includes("failed to add comment to discussion")) {
    return t("errors.discussion.commentFailed");
  }
  if (lowerMessage.includes("unable to access discussion")) {
    return t("errors.discussion.accessDenied");
  }
  if (
    lowerMessage.includes("discussion") &&
    lowerMessage.includes("not found")
  ) {
    return t("errors.discussion.notFound");
  }

  // Issue errors
  if (lowerMessage.includes("failed to update issue")) {
    return t("errors.issue.updateFailed");
  }
  if (lowerMessage.includes("failed to add issue comment")) {
    return t("errors.issue.commentFailed");
  }

  // Token limit errors
  if (
    lowerMessage.includes("token limit") ||
    lowerMessage.includes("limit reached")
  ) {
    return t("errors.tokenLimit.limitReached");
  }

  // Generic errors
  if (
    lowerMessage.includes("permission denied") ||
    lowerMessage.includes("insufficient permissions") ||
    lowerMessage.includes("resource not accessible by integration") ||
    lowerMessage.includes("github denied access to review source")
  ) {
    return t("errors.generic.permissionDenied");
  }
  if (lowerMessage.includes("not found")) {
    return t("errors.generic.notFound");
  }
  if (lowerMessage.includes("network") || lowerMessage.includes("fetch")) {
    return t("errors.generic.networkError");
  }

  // Return original message if no match
  return message;
}

export type ProviderKeyFailure =
  | "invalid"
  | "outOfCredit"
  | "rateLimited"
  | "unavailable"
  | "unreadable"
  | "removed"
  | "serviceUnavailable";

const PROVIDER_KEY_FAILURES: Array<[RegExp, ProviderKeyFailure]> = [
  [/^Your (Anthropic|OpenAI) API key was rejected/, "invalid"],
  [/^Your (Anthropic|OpenAI) API key is out of credit/, "outOfCredit"],
  [/^Your (Anthropic|OpenAI) API key hit its rate limit/, "rateLimited"],
  [/^Your (Anthropic|OpenAI) API key can no longer be read/, "unreadable"],
  [/^Your (Anthropic|OpenAI) API key is no longer available/, "unavailable"],
  [/^Your AI provider API key is no longer available/, "unavailable"],
  [/^This request started on your own API key/, "removed"],
  [/^Gitdog can't use saved API keys right now/, "serviceUnavailable"],
];

/**
 * Recognize a failure caused by the user's own provider key, using the
 * fixed messages the backend writes for those failures.
 */
export function getProviderKeyFailure(
  message: string,
): { kind: ProviderKeyFailure; provider?: string } | null {
  for (const [pattern, kind] of PROVIDER_KEY_FAILURES) {
    const match = pattern.exec(message);
    if (match) return { kind, provider: match[1] };
  }
  return null;
}
