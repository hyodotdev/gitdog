import { getConfiguredGitHubAppSlug } from "../github/botIdentity";

export type ReviewCommand = "review" | "full_review" | "resolve" | "help";

// Review bots whose commands another may follow on the same line. Any
// GitHub App account, named "...[bot]", counts too.
const REVIEW_BOTS = [
  "coderabbitai",
  "copilot",
  "gemini-code-assist",
  "sourcery-ai",
  "greptile-apps",
  "greptileai",
  "codeant-ai",
  "qodo-merge",
  "[\\w-]+\\[bot\\]",
].join("|");

// Commands one commenter may send to one repository before being paused.
export const COMMANDS_PER_HOUR = 10;
export const COMMANDS_PER_DAY = 40;
export const COMMAND_PAUSE_MS = 24 * 60 * 60_000;

// GitHub's association for repository owners, organization members and
// collaborators; others cannot spend the owner's tokens on full reviews.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Who may run commands: collaborators run all of them; the pull request
 * author, who may be a fork contributor, cannot ask for a full review.
 */
export function commandAccess(
  association: unknown,
  commenterId: number,
  authorId: number | undefined,
): "collaborator" | "author" | null {
  if (typeof association === "string" && TRUSTED_ASSOCIATIONS.has(association))
    return "collaborator";
  return commenterId === authorId ? "author" : null;
}

/**
 * The command a comment gives Gitdog, or null when it gives none. Quoted
 * replies and code blocks never run a command.
 */
export function parseReviewCommand(
  body: string,
  configuredSlug?: string,
): ReviewCommand | "unknown" | null {
  const slug = getConfiguredGitHubAppSlug(configuredSlug);
  if (!slug) return null;
  const text = body
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, "")
    .split(/\r?\n/)
    .filter(
      (line) => !line.trimStart().startsWith(">") && !/^( {4}|\t)/.test(line),
    )
    .join("\n");
  // A command starts a line, or follows another review bot's command on it,
  // as in "@coderabbitai review @gitdogbot review". "@gitdog" is shorthand
  // for the production app only, so a development app never answers it.
  const names = slug === "gitdogbot" ? `${slug}|gitdog` : slug;
  const match = new RegExp(
    `^[ \\t]*((?:@(?:${REVIEW_BOTS})(?:[ \\t]+[a-z-]+){0,2}[ \\t]+){0,3})@(?:${names})(?=\\s|[:,]|$)[:,]?[ \\t]*([^@\\n]*)`,
    "im",
  ).exec(text);
  if (!match) return null;
  const chained = match[1].length > 0;
  const words = match[2]
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  switch (true) {
    // A chained mention without a command is a thank-you, not a request.
    case chained &&
      !["help", "review", "full", "resolve"].includes(words[0] ?? ""):
      return null;
    case words.length === 0 || words[0] === "help":
      return "help";
    case words[0] === "full" && words[1] === "review":
      return "full_review";
    case words[0] === "review":
      return "review";
    case words[0] === "resolve":
      return "resolve";
    default:
      return "unknown";
  }
}

export function helpText(slug: string): string {
  const mention = `@${slug}`;
  return [
    "**Gitdog commands**",
    "Gitdog reviews a pull request once when it is opened or marked ready for review. After that, comment:",
    `- \`${mention} review\`: review the commits pushed since the last review`,
    `- \`${mention} full review\`: review the whole pull request again`,
    `- \`${mention} resolve\`: resolve every Gitdog review thread`,
    `- \`${mention} help\`: show this list`,
    "Collaborators can run every command; the pull request author can run all but a full review. `@gitdog` works as shorthand.",
  ].join("\n");
}

type StatusAction = {
  status: string;
  errorMessage?: string;
  executionResult?: {
    published?: boolean;
    reason?: string;
    reviewUrl?: string;
  };
  proposedChanges?: {
    source?: { headSha?: string };
    changedFiles?: number;
    reviewedSince?: string;
  };
};

// A review cancelled because the pull request moved on, not one to retry.
export function isCancelledReview(message: string | undefined): boolean {
  return (
    message !== undefined &&
    (message.includes("superseded") ||
      /^Pull request changed (before|during|after)/.test(message))
  );
}

// Failures safe to show on a public pull request, in the owner's words. The
// second value says whether asking again can help.
function failureReason(message: string | undefined): [string, boolean] {
  switch (true) {
    case !message:
      return ["Gitdog could not complete the review.", true];
    case message!.startsWith("Not enough tokens remain") ||
      message!.startsWith("Token limit reached"):
      return [
        "The token limit of the account that connected this repository has been reached.",
        true,
      ];
    // A user's own provider key is the owner's business, not the public's.
    case message!.startsWith("Your "):
      return [
        "The AI provider settings of the account that connected this repository need attention.",
        true,
      ];
    case message!.startsWith("GitHub publication outcome requires inspection"):
      return [
        "Gitdog could not confirm that the review was posted. Check the reviews above before asking again.",
        false,
      ];
    case /split this PR/.test(message!):
      return [
        "This pull request is too large to review completely. Split it into smaller pull requests.",
        false,
      ];
    default:
      return ["Gitdog could not complete the review.", true];
  }
}

/**
 * The status comment for a review in its current state, or null when the
 * state needs no comment (a successful review is the review itself, but an
 * existing status comment is still updated to point at it).
 */
export function reviewStatusBody(
  action: StatusAction,
  slug: string,
): string | null {
  const sha = action.proposedChanges?.source?.headSha ?? "this pull request";
  const files = action.proposedChanges?.changedFiles;
  switch (action.status) {
    case "pending":
      return `**Reviewing** ${sha}${
        typeof files === "number"
          ? ` · ${files} changed ${files === 1 ? "file" : "files"}`
          : ""
      }\n\nThe review will be posted here when it is done.`;
    case "pending_approval":
      return `**Review ready for approval** for ${sha}\n\nThe repository owner can post it from Gitdog.`;
    case "approved":
      return `**Posting the review** for ${sha}`;
    case "rejected":
      return `**Review not posted** for ${sha}\n\nThe repository owner chose not to post this review.`;
    case "completed":
      if (action.executionResult?.published)
        return `**Reviewed** ${sha}${
          action.executionResult.reviewUrl
            ? ` · [see the review](${action.executionResult.reviewUrl})`
            : ""
        }`;
      if (action.executionResult?.reason === "no_new_changes")
        return `**No new changes to review** in ${sha}${
          action.proposedChanges?.reviewedSince
            ? ` since ${action.proposedChanges.reviewedSince}`
            : ""
        }\n\nNothing in the pull request diff changed, so no review was posted. Comment \`@${slug} full review\` to review the whole pull request again.`;
      return null;
    case "failed": {
      if (isCancelledReview(action.errorMessage))
        return `**Review cancelled** for ${sha}\n\nThe pull request changed before the review finished.`;
      const [reason, retry] = failureReason(action.errorMessage);
      return `**Review not completed** for ${sha}\n\n${reason}${
        retry ? ` Comment \`@${slug} review\` to try again.` : ""
      }`;
    }
    default:
      return null;
  }
}
