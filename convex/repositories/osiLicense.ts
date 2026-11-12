import { isOsiApprovedLicenseApiMatch } from "./embeddingPolicy";

export const OSI_LICENSE_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const OSI_LICENSE_REQUEST_TIMEOUT_MS = 10_000;

/** Verify one SPDX identifier against OSI's canonical license API. */
export async function fetchOsiLicenseApproval(
  spdxId: string,
): Promise<boolean> {
  const response = await fetch(
    `https://opensource.org/api/licenses?spdx=${encodeURIComponent(spdxId)}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "Gitdog",
      },
      signal: AbortSignal.timeout(OSI_LICENSE_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `OSI license verification returned HTTP ${response.status}`,
    );
  }

  const responseBody: unknown = await response.json();
  return isOsiApprovedLicenseApiMatch(responseBody, spdxId);
}
