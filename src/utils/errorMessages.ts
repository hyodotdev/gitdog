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
