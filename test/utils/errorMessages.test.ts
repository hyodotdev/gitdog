import { beforeAll, describe, expect, it } from "vitest";
import i18next from "i18next";
import { translateErrorMessage } from "../../src/utils/errorMessages";

describe("ticket error translation", () => {
  const instance = i18next.createInstance();
  const t = instance.getFixedT("en");
  beforeAll(async () => {
    await instance.init({ lng: "en", resources: {} });
  });
  it("does not turn permission advice into a confirmed permission denial", () => {
    const message =
      "AI generation and evidence validation: Review could not establish complete, current code evidence. Inspect its context and GitHub permissions before requesting another commit review.";
    expect(translateErrorMessage(message, t)).toBe(message);
  });
  it.each([
    "Permission denied",
    "Insufficient permissions",
    "Resource not accessible by integration",
    "GitHub denied access to review source. Check the GitHub App installation and its granted permissions.",
  ])("recognizes confirmed access errors: %s", (message) => {
    expect(translateErrorMessage(message, t)).toBe(
      "errors.generic.permissionDenied",
    );
  });
  it("preserves actionable non-permission review failures", () => {
    for (const message of [
      "AI generation and evidence validation: The AI review response was not valid JSON after one format correction. No review was published.",
      "AI generation and evidence validation: Review exceeded a source or context limit. No review was published.",
    ])
      expect(translateErrorMessage(message, t)).toBe(message);
  });
});
