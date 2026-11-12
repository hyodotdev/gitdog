export type GitHubRepositoryVisibility = "public" | "private" | "internal";

export type RepositoryEmbeddingMetadata = {
  githubVisibility?: GitHubRepositoryVisibility;
  licenseKey?: string;
  licenseSpdxId?: string;
  licenseOsiApproved?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readVisibility(
  value: unknown,
): GitHubRepositoryVisibility | undefined {
  return value === "public" || value === "private" || value === "internal"
    ? value
    : undefined;
}

/** Normalize the relevant fields from GitHub's repository REST response. */
export function normalizeGitHubRepositoryEmbeddingMetadata(
  value: unknown,
): RepositoryEmbeddingMetadata {
  if (!isRecord(value)) {
    return {};
  }

  const githubVisibility = readVisibility(value.visibility);
  const license = isRecord(value.license) ? value.license : undefined;
  const licenseKey = readNonEmptyString(license?.key);
  const licenseSpdxId = readNonEmptyString(license?.spdx_id);

  return {
    ...(githubVisibility === undefined ? {} : { githubVisibility }),
    ...(licenseKey === undefined ? {} : { licenseKey }),
    ...(licenseSpdxId === undefined ? {} : { licenseSpdxId }),
  };
}

/**
 * Match one exact SPDX identifier in OSI's canonical approved-license list.
 * The API's `approved` field is not authoritative, so malformed, non-exact,
 * empty, or ambiguous collections fail closed instead.
 */
export function isOsiApprovedLicenseApiMatch(
  value: unknown,
  spdxId: string,
): boolean {
  if (!Array.isArray(value) || value.length !== 1) {
    return false;
  }

  const expectedSpdxId = spdxId.trim().toUpperCase();
  if (!expectedSpdxId) {
    return false;
  }

  const [license] = value;
  return (
    isRecord(license) &&
    typeof license.spdx_id === "string" &&
    license.spdx_id.trim().toUpperCase() === expectedSpdxId
  );
}
