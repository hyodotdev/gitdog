import { describe, expect, it } from "vitest";

import {
  isOsiApprovedLicenseApiMatch,
  normalizeGitHubRepositoryEmbeddingMetadata,
} from "../../../convex/repositories/embeddingPolicy";

describe("normalizeGitHubRepositoryEmbeddingMetadata", () => {
  it("normalizes exact GitHub visibility and detected license fields", () => {
    expect(
      normalizeGitHubRepositoryEmbeddingMetadata({
        visibility: "public",
        private: false,
        license: {
          key: " mit ",
          spdx_id: " MIT ",
          name: "MIT License",
        },
      }),
    ).toEqual({
      githubVisibility: "public",
      licenseKey: "mit",
      licenseSpdxId: "MIT",
    });
  });

  it.each(["private", "internal"] as const)(
    "preserves the %s visibility",
    (visibility) => {
      expect(
        normalizeGitHubRepositoryEmbeddingMetadata({ visibility }),
      ).toEqual({ githubVisibility: visibility });
    },
  );

  it("does not infer public visibility from the private flag", () => {
    expect(
      normalizeGitHubRepositoryEmbeddingMetadata({
        private: false,
        license: { key: "mit", spdx_id: "MIT" },
      }),
    ).toEqual({ licenseKey: "mit", licenseSpdxId: "MIT" });
  });

  it.each([
    { value: null },
    { value: undefined },
    { value: [] },
    { value: "public" },
    { value: { visibility: "PUBLIC", license: null } },
    { value: { visibility: true, license: [] } },
  ])("conservatively ignores malformed metadata %#", ({ value }) => {
    expect(normalizeGitHubRepositoryEmbeddingMetadata(value)).toEqual({});
  });

  it("omits blank and non-string license fields", () => {
    expect(
      normalizeGitHubRepositoryEmbeddingMetadata({
        visibility: "public",
        license: { key: "  ", spdx_id: 123 },
      }),
    ).toEqual({ githubVisibility: "public" });
  });
});

describe("OSI approved-license API matching", () => {
  it.each([true, false])(
    "matches a singleton exact SPDX result when approved is %s",
    (approved) => {
      expect(
        isOsiApprovedLicenseApiMatch([{ spdx_id: " MIT ", approved }], "mit"),
      ).toBe(true);
    },
  );

  it("matches exact canonical membership without relying on approved", () => {
    expect(isOsiApprovedLicenseApiMatch([{ spdx_id: "MIT" }], "MIT")).toBe(
      true,
    );
  });

  it.each([
    { response: [], spdxId: "BUSL-1.1" },
    {
      response: [{ spdx_id: "MIT-CMU", approved: false }],
      spdxId: "MIT",
    },
    { response: { spdx_id: "MIT" }, spdxId: "MIT" },
    { response: [{ spdx_id: 123 }], spdxId: "MIT" },
    { response: [{ spdx_id: "   " }], spdxId: "MIT" },
    { response: [{ spdx_id: "MIT" }], spdxId: "   " },
    {
      response: [{ spdx_id: "MIT" }, { spdx_id: "Apache-2.0" }],
      spdxId: "MIT",
    },
    {
      response: [{ spdx_id: "MIT" }, { spdx_id: "MIT" }],
      spdxId: "MIT",
    },
  ])(
    "rejects non-matching, malformed, or ambiguous responses %#",
    ({ response, spdxId }) => {
      expect(isOsiApprovedLicenseApiMatch(response, spdxId)).toBe(false);
    },
  );
});
