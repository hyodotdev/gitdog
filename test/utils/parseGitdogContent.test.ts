import { describe, expect, it } from "vitest";

import { parseGitdogBody } from "../../src/utils/parseGitdogContent";

describe("parseGitdogBody", () => {
  it("parses edited content and removes the formatted footer", () => {
    const parsed = parseGitdogBody(`<!-- Edited by gitdog.dev -->
<!-- Changes: Improved formatting -->

<details>
<summary>Original Content</summary>
Original body
</details>

---
Current body

---
*🤖 Formatted by [gitdog.dev](https://gitdog.dev)*`);

    expect(parsed).toEqual({
      isEdited: true,
      originalContent: "Original body",
      currentContent: "Current body",
      changesSummary: "Improved formatting",
    });
  });

  it("cleans malformed edited content", () => {
    const parsed = parseGitdogBody(`<!-- Edited by gitdog.dev -->
<!-- Changes: Improved formatting -->

Updated body

<sub>🤖 Formatted by [gitdog.dev](https://gitdog.dev)</sub>`);

    expect(parsed).toEqual({
      isEdited: true,
      originalContent: null,
      currentContent: "Updated body",
      changesSummary: "Improved formatting",
    });
  });

  it("parses sanitized changes summaries that originally contained an HTML comment closer", () => {
    const parsed = parseGitdogBody(`<!-- Edited by gitdog.dev -->
<!-- Changes: Renamed a -- > b -->

<details>
<summary>Original Content</summary>
Original body
</details>

Updated body`);

    expect(parsed.changesSummary).toBe("Renamed a -- > b");
  });
});
