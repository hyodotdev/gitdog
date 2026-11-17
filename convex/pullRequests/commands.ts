import { getConfiguredGitHubAppSlug } from "../github/botIdentity";

export type ReviewCommand = "review" | "full_review" | "resolve" | "help";

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
  // Only a mention that starts a line is a command, so "@gitdogbot review"
  // quoted in a sentence does not run one.
  const match = new RegExp(
    `^[ \\t]*@${slug}(?=\\s|[:,]|$)[:,]?[ \\t]*([^\\n]*)`,
    "im",
  ).exec(text);
  if (!match) return null;
  const words = match[1]
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  switch (true) {
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
    "Collaborators can run every command; the pull request author can run all but a full review.",
  ].join("\n");
}
