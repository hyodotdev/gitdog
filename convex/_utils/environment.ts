const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

/** Treat only an absolute URL with an exact loopback hostname as development. */
export function isDevelopmentSiteUrl(
  siteUrl: string | undefined = process.env.SITE_URL,
): boolean {
  if (!siteUrl) {
    return false;
  }

  try {
    return LOOPBACK_HOSTNAMES.has(normalizeHostname(new URL(siteUrl).hostname));
  } catch {
    return false;
  }
}
