import { GitHubAppRateLimitError } from "../github/helpers";
import { ChatProviderRequestError } from "../_ai/providerErrors";
import { UserApiKeyError } from "../_ai/providerResolution";
import { AiLegalAttestationRequiredError } from "../_ai/legalAttestation";

type ReviewRequest = {
  operation: string;
  file?: { path: string; commit: string };
};

class ReviewRequestError extends Error {
  constructor(
    readonly request: ReviewRequest,
    cause: unknown,
  ) {
    super("Review request failed", { cause });
  }
}

export async function runReviewRequest<T>(
  request: ReviewRequest,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ReviewRequestError) throw error;
    throw new ReviewRequestError(request, error);
  }
}

export function reviewFailureCause(error: unknown): unknown {
  return error instanceof ReviewRequestError ? error.cause : error;
}

export class ReviewResponseFormatError extends Error {
  constructor() {
    super("Review response did not match the required JSON format");
    this.name = "ReviewResponseFormatError";
  }
}

export type ReviewQuotaRefusal = "insufficient" | "unverified" | "busy";

export class ReviewQuotaError extends Error {
  constructor(
    message: string,
    readonly reason: ReviewQuotaRefusal,
  ) {
    super(message);
    this.name = "ReviewQuotaError";
  }
}

export class ReviewContextLimitError extends Error {
  constructor() {
    super("Review context exceeds the 40 KB file limit");
    this.name = "ReviewContextLimitError";
  }
}

// Failures of the model's own output or of a review limit inside one group.
const REVIEW_GROUP_MODEL_FAILURES = new Set([
  "Commit suggestions are disabled",
  "Duplicate review finding",
  "Finding contains unsupported evidence or mentions",
  "Finding evidence was not present in commit-pinned reads",
  "Finding must anchor to an added line in the reviewed diff",
  "Finding target was not read at the head commit",
  "Invalid or low-confidence review finding",
  "Invalid review result",
  "Overlapping commit suggestions",
  "Review conversation exceeds the context budget",
  "Review did not finish completely",
  "Review file-read budget exhausted",
  "Review final synthesis did not complete",
  "Review requested an unsupported tool",
  "Review source budget exhausted",
  "Review verification did not finish",
  "Suggestion original must match the reviewed commit exactly",
  "Suggestion range must contain only added lines",
  "Suggestions must use the validated suggestion field",
  "Unsafe suggestion range or replacement",
  "Verification introduced an unreviewed finding",
]);

/**
 * Whether one batch group's failure is about the model's own output, so it can
 * be reported as uncovered files instead of discarding every batch already
 * paid for. Provider, billing, quota, credential and lifecycle failures, which
 * would recur in every later batch, still stop the whole review.
 */
export function isReviewGroupModelFailure(error: unknown): boolean {
  const cause = reviewFailureCause(error);
  if (cause instanceof ChatProviderRequestError)
    // A response that was billed but could not be processed.
    return cause.billingOutcome === "billed" && cause.httpStatus === undefined;
  return (
    cause instanceof ReviewEvidenceError ||
    cause instanceof ReviewResponseFormatError ||
    (cause instanceof Error && REVIEW_GROUP_MODEL_FAILURES.has(cause.message))
  );
}

export class ReviewEvidenceError extends Error {
  constructor(
    message: string,
    readonly source: { path: string; ref: "head" | "base" },
  ) {
    super(message);
    this.name = "ReviewEvidenceError";
  }
}

const fixedFailureReasons = new Map([
  [
    "Review source snapshot is missing",
    "The saved review source snapshot is missing or invalid.",
  ],
  [
    "Pull request identity is invalid",
    "The pull request response did not match the expected repository and pull request.",
  ],
  [
    "Pull request diff is incomplete",
    "GitHub's diff did not match the expected changed files and line counts.",
  ],
  [
    "Pull request merge base is unavailable",
    "GitHub did not return a valid merge-base commit.",
  ],
  ["Repository is not connected", "The repository is no longer connected."],
  [
    "Repository installation access is not active",
    "The GitHub App installation is inactive or unverified.",
  ],
  [
    "Repository installation access changed during request",
    "The GitHub App installation changed during the request.",
  ],
  [
    "GitHub App credentials not configured",
    "GitHub App authentication is unavailable.",
  ],
  [
    "GitHub repository identity no longer matches",
    "GitHub returned a different repository identity.",
  ],
  [
    "Pull request changed after the review was generated",
    "The pull request changed after this review was generated.",
  ],
  [
    "Pull request changed before publication",
    "The pull request changed before GitHub publication.",
  ],
  [
    "Review history is unavailable",
    "GitHub returned an invalid review history response.",
  ],
  [
    "Review findings are invalid",
    "The saved review did not contain a valid set of findings.",
  ],
  [
    "Invalid commit-pinned file request",
    "A review file request used an unsafe path or an invalid commit.",
  ],
  [
    "Review history exceeded the reconciliation limit",
    "The review history exceeded the publication verification limit.",
  ],
  [
    "Invalid review result",
    "The AI review result did not match the required review schema.",
  ],
  [
    "Invalid or low-confidence review finding",
    "A finding in the AI review result did not match the required review schema.",
  ],
  [
    "Verification introduced an unreviewed finding",
    "The AI verification response was not a valid selection of the reviewed findings.",
  ],
  [
    "Finding must anchor to an added line in the reviewed diff",
    "A finding did not point to a line added by the pull request.",
  ],
  [
    "Finding contains unsupported evidence or mentions",
    "A finding did not quote its target line, or contained an @mention or an agent instruction file reference.",
  ],
  [
    "Suggestions must use the validated suggestion field",
    "A finding embedded a suggestion block in its text instead of the suggestion field.",
  ],
  [
    "Unsafe suggestion range or replacement",
    "A commit suggestion had an invalid shape, line range or replacement.",
  ],
  [
    "Suggestion original must match the reviewed commit exactly",
    "A commit suggestion did not match the reviewed lines, or did not change them.",
  ],
  [
    "Suggestion range must contain only added lines",
    "A commit suggestion covered lines the pull request did not add.",
  ],
  [
    "Overlapping commit suggestions",
    "Two commit suggestions overlapped in the same file.",
  ],
  [
    "Duplicate review finding",
    "The AI review returned the same finding more than once.",
  ],
  [
    "Commit suggestions are disabled",
    "A finding carried a commit suggestion although suggestions are disabled for this repository.",
  ],
  [
    "Review did not finish completely",
    "The AI review response did not finish normally.",
  ],
  [
    "Review verification did not finish",
    "The AI verification response did not finish normally.",
  ],
  [
    "Review final synthesis did not complete",
    "The final AI review response did not finish normally.",
  ],
  [
    "Reviewer did not inspect the changed implementation",
    "The review finished without inspecting a changed file at the reviewed commit. Files over 40 KB, binary files and diffs without reviewable lines cannot be inspected.",
  ],
  [
    "Review requested an unsupported tool",
    "The AI review requested an unsupported tool.",
  ],
]);

// Fixed internal messages, safe to record so a failure names its limit.
const REVIEW_LIMIT_MESSAGES = [
  "Review context is unavailable, binary or too large",
  "Review context is binary or too large",
  "Review source budget exhausted",
  "Review file-read budget exhausted",
  "Review conversation exceeds the context budget",
  "Review tool budget exhausted",
  "Repository tree exceeds the review context limit",
  "Pull request diff exceeds the review budget; split this PR",
  "Review requires at least one changed file",
  "Review covers at most 300 changed files; split this PR for complete coverage",
];

function reviewFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const knownReason = fixedFailureReasons.get(message);
  if (knownReason) return knownReason;
  let reason = "Review could not establish complete, current code evidence.";
  if (message === "Bot-authored pull requests are not reviewed") {
    reason = "Bot-authored pull requests are excluded from AI reviews.";
  } else if (error instanceof ReviewResponseFormatError) {
    reason =
      "The AI review response was not valid JSON after one format correction.";
  } else if (error instanceof GitHubAppRateLimitError) {
    reason =
      "GitHub rate limited review source reads. Wait for the rate limit to reset.";
  } else if (error instanceof ReviewContextLimitError) {
    reason = "A required source file exceeded the 40 KB review limit.";
  } else if (
    error instanceof ReviewEvidenceError ||
    [
      "Finding target was not read at the head commit",
      "Finding evidence was not present in commit-pinned reads",
    ].includes(message)
  ) {
    reason =
      "A finding could not be verified against the source read during the review.";
  } else if (message === "Review source is not valid UTF-8") {
    reason =
      "GitHub returned a source file that could not be decoded as UTF-8.";
  } else if (message === "GitHub review result could not be verified") {
    reason =
      "GitHub returned a review result that could not be matched to this commit and request.";
  } else if (error instanceof AiLegalAttestationRequiredError) {
    reason = "The account needs to accept the current AI usage terms.";
  } else if (error instanceof UserApiKeyError) {
    reason = error.message;
  } else if (error instanceof ChatProviderRequestError) {
    const status = error.httpStatus;
    if (
      status !== undefined &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      reason = `The model provider returned HTTP ${status}.`;
    } else {
      reason =
        error.billingOutcome === "ambiguous"
          ? "The model provider's response and usage could not be verified."
          : error.billingOutcome === "billed"
            ? "The model provider response could not be processed after usage was recorded."
            : "The model request could not be prepared.";
    }
  } else if (REVIEW_LIMIT_MESSAGES.includes(message)) {
    reason =
      "Review exceeded a source or context limit, or encountered an unsupported file. Large source files are limited to 40 KB; use smaller changes where possible.";
  } else if (
    /^(Read pull request|Read pull request diff(?: \(page \d+\))?|Read merge base|Read review context|Read review source paths) failed \(HTTP (401|403)\)$/.test(
      message,
    )
  ) {
    reason =
      "GitHub denied access to review source. Check the GitHub App installation and its granted permissions.";
  } else if (
    [
      "Pull request changed before review",
      "Pull request changed during review",
      "Pull request changed while reading its diff",
      "Review source, settings or lifecycle changed",
    ].includes(message)
  ) {
    reason =
      "The pull request, repository settings or review lifecycle changed before verification finished.";
  }
  return reason;
}

export function reviewGenerationError(error: unknown, stage: string): string {
  return `${stage}: ${reviewFailureReason(reviewFailureCause(error))} No review was published.`;
}

function reviewRequestReason(cause: unknown): string {
  if (cause instanceof GitHubAppRateLimitError)
    return `GitHub rate limited this request (HTTP ${cause.status}).`;
  if (!(cause instanceof Error)) return reviewFailureReason(cause);

  const failure =
    / failed(?: after \d+ attempts)? \((HTTP [1-5]\d{2}|TimeoutError|AbortError|TypeError|SyntaxError)\)$/.exec(
      cause.message,
    )?.[1] ?? cause.name;
  switch (failure) {
    case "HTTP 404":
      return "GitHub could not find the requested resource (HTTP 404).";
    case "HTTP 401":
    case "HTTP 403":
      return `GitHub denied access to this resource (${failure}).`;
    case "TimeoutError":
    case "AbortError":
      return "The request timed out or was interrupted.";
    case "TypeError":
      return "The request could not be sent or its response could not be read.";
    case "SyntaxError":
      return "The service returned an invalid JSON response.";
    default:
      if (/^HTTP [1-5]\d{2}$/.test(failure))
        return `The request returned ${failure}.`;
      return reviewFailureReason(cause);
  }
}

export function reviewFailureDetails(
  error: unknown,
  stage: string,
  reasonOverride?: string,
): string {
  const request =
    error instanceof ReviewRequestError ? error.request : undefined;
  const cause = reviewFailureCause(error);
  const reason =
    reasonOverride ??
    (request ? reviewRequestReason(cause) : reviewFailureReason(cause));
  const file = request?.file;
  return [
    `Stage · ${stage}`,
    request && `Request · ${request.operation}`,
    file &&
      file.path.length <= 500 &&
      /^[\p{L}\p{N}._@ /()[\]+-]+$/u.test(file.path) &&
      /^[a-f0-9]{40}$/.test(file.commit) &&
      `File · ${file.path} @ ${file.commit.slice(0, 12)}`,
    `Reason · ${reason}`,
    cause instanceof Error &&
      REVIEW_LIMIT_MESSAGES.includes(cause.message) &&
      cause.message !== reason &&
      `Limit · ${cause.message}`,
  ]
    .filter(Boolean)
    .join("\n");
}
