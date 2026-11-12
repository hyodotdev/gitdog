const GITHUB_APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Resolve the one GitHub App identity owned by this deployment. */
export function getConfiguredGitHubAppSlug(
  configuredSlug: string | undefined = process.env.GITHUB_APP_SLUG,
): string | null {
  const slug = configuredSlug?.trim().toLowerCase();
  return slug && GITHUB_APP_SLUG_PATTERN.test(slug) ? slug : null;
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
