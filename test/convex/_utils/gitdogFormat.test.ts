import { describe, expect, it } from "vitest";

import { buildFormattedGitdogBody } from "../../../convex/_utils/gitdogFormat";

describe("buildFormattedGitdogBody", () => {
  it("builds a formatted body with Gitdog metadata", () => {
    expect(buildFormattedGitdogBody("Updated body", "Formatting improvements"))
      .toBe(`<!-- Edited by gitdog.dev -->
<!-- Changes: Formatting improvements -->

Updated body

---
*🤖 Formatted by [gitdog.dev](https://gitdog.dev)*`);
  });

  it("sanitizes HTML comment closers in changes summary", () => {
    expect(
      buildFormattedGitdogBody("Updated body", "Renamed a --> b"),
    ).toContain("<!-- Changes: Renamed a -- > b -->");
  });

  it("returns undefined when there is no suggested body", () => {
    expect(buildFormattedGitdogBody(undefined, "Formatting improvements")).toBe(
      undefined,
    );
  });
});
