const GITDOG_SITE_URL = "https://gitdog.dev";
const GITDOG_DOMAIN = "gitdog.dev";

export function buildFormattedGitdogBody(
  suggestedBody: string | undefined,
  changesSummary: string,
): string | undefined {
  if (!suggestedBody) {
    return undefined;
  }

  const safeChangesSummary = changesSummary.replace(/-->/g, "-- >");

  return `<!-- Edited by ${GITDOG_DOMAIN} -->\n<!-- Changes: ${safeChangesSummary} -->\n\n${suggestedBody}\n\n---\n*🤖 Formatted by [${GITDOG_DOMAIN}](${GITDOG_SITE_URL})*`;
}
