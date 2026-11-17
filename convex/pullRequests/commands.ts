import { getConfiguredGitHubAppSlug } from "../github/botIdentity";

export type ReviewCommand = "review" | "full_review" | "resolve" | "help";

// Commands one commenter may send to one repository before being paused.
export const COMMANDS_PER_HOUR = 10;
export const COMMANDS_PER_DAY = 40;
export const COMMAND_PAUSE_MS = 24 * 60 * 60_000;

// Only people who can already change the PR may spend the owner's tokens.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function canRunCommands(
  association: unknown,
  commenterId: number,
  authorId: number | undefined,
): boolean {
  return (
    (typeof association === "string" &&
      TRUSTED_ASSOCIATIONS.has(association)) ||
    commenterId === authorId
  );
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
    .replace(/```[\s\S]*?(```|$)/g, "")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  const match = new RegExp(
    `(?:^|\\s)@${slug}(?=\\s|[:,]|$)[:,]?[ \\t]*([^\\n]*)`,
    "i",
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
    "Commands are open to the pull request author and repository collaborators.",
  ].join("\n");
}
