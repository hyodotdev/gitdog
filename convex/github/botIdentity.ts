const GITHUB_APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Resolve the one GitHub App identity owned by this deployment. */
export function getConfiguredGitHubAppSlug(
  configuredSlug: string | undefined = process.env.GITHUB_APP_SLUG,
): string | null {
  const slug = configuredSlug?.trim().toLowerCase();
  return slug && GITHUB_APP_SLUG_PATTERN.test(slug) ? slug : null;
}

// The production app was renamed from gitdogbot to gitdogai. Both names keep
// reaching it, so existing comments, docs and habits still work. Only the
// configured slug is trusted as Gitdog's own bot account.
const PRODUCTION_APP_NAMES = ["gitdogai", "gitdogbot"];

/**
 * Names a mention can use to address this deployment's app, configured slug
 * first. A development app answers only to its own slug.
 */
export function getGitdogMentionNames(configuredSlug?: string): string[] {
  const slug = getConfiguredGitHubAppSlug(configuredSlug);
  if (!slug) return [];
  return PRODUCTION_APP_NAMES.includes(slug)
    ? [slug, ...PRODUCTION_APP_NAMES.filter((name) => name !== slug)]
    : [slug];
}

export function getConfiguredGitdogMention(
  configuredSlug?: string,
): string | null {
  const slug = getConfiguredGitHubAppSlug(configuredSlug);
  return slug ? `@${slug}` : null;
}

export function getGitdogFollowUpFooter(configuredSlug?: string): string {
  const mention = getConfiguredGitdogMention(configuredSlug);
  return mention
    ? `Have more questions? Tag \`${mention}\` and let me know!`
    : "Have more questions? Reply and let me know!";
}

/** Only Gitdog-authored comments may be replayed as assistant messages. */
export function isGitdogBot(
  login: string | null | undefined,
  configuredSlug?: string,
): boolean {
  const slug = getConfiguredGitHubAppSlug(configuredSlug);
  return Boolean(login && slug && login.toLowerCase() === `${slug}[bot]`);
}
