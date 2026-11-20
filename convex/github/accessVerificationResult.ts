// Shared with the web app, so this module imports nothing.

/** The query parameter the return page reads to show how verification ended. */
export const ACCESS_VERIFICATION_RESULT_PARAM = "githubAccess";

/** The outcomes other than success, each with its own message. */
export const ACCESS_VERIFICATION_PROBLEMS = [
  "account_mismatch",
  "cancelled",
  "failed",
] as const;

export type AccessVerificationResult =
  "verified" | (typeof ACCESS_VERIFICATION_PROBLEMS)[number];
