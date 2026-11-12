import { describe, expect, it } from "vitest";

import { ISSUE_FORMATTING_SYSTEM_PROMPT } from "../../../convex/_ai/issueFormatting/prompts";
import { validateFormattingResult } from "../../../convex/_ai/issueFormatting/workflow";
import { evaluateAutoPublishEligibility } from "../../../convex/ticketActions/internalMutation";

describe("ISSUE_FORMATTING_SYSTEM_PROMPT", () => {
  it("requires the [FR] title prefix for feature requests", () => {
    expect(ISSUE_FORMATTING_SYSTEM_PROMPT).toContain(
      'Feature request titles MUST use "[FR]" exactly.',
    );
    expect(ISSUE_FORMATTING_SYSTEM_PROMPT).toContain(
      'Never use "[Feature]" or "Feature Request:" as the title prefix.',
    );
    expect(ISSUE_FORMATTING_SYSTEM_PROMPT).toContain(
      '"[Bug]", "[FR]", "[Question]"',
    );
  });
});

describe("validateFormattingResult", () => {
  const issue = {
    title: "bug",
    body: "Exact error: E_CONN\n\nSteps: open the app",
  };

  it("accepts a formatted body that embeds the exact original", () => {
    expect(
      validateFormattingResult(issue, {
        needsImprovement: true,
        reasoning: "Needs structure",
        suggestedTitle: "[Bug] Connection fails",
        suggestedBody: `<details>\n${issue.body}\n</details>\n\n## Description\nConnection fails.`,
        changesSummary: "Added structure",
      }),
    ).toEqual([]);
  });

  it("rejects formatting that drops or rewrites original content", () => {
    expect(
      validateFormattingResult(issue, {
        needsImprovement: true,
        reasoning: "Needs structure",
        suggestedTitle: "[Bug] Connection fails",
        suggestedBody: "## Description\nThe connection fails.",
        changesSummary: "Added structure",
      }),
    ).toContain("suggested body does not preserve the exact original body");
  });

  it("rejects malformed output instead of treating it as no improvement", () => {
    expect(validateFormattingResult(issue, {})).toEqual(
      expect.arrayContaining([
        "needsImprovement must be a boolean",
        "reasoning must be a non-empty bounded string",
      ]),
    );
  });

  it("requires an improved suggestion when regenerating from feedback", () => {
    expect(
      validateFormattingResult(
        { ...issue, feedback: "Keep the title shorter" },
        {
          needsImprovement: false,
          reasoning: "No changes needed",
        },
      ),
    ).toContain("feedback regeneration must return an improved suggestion");
  });

  it("enforces the exact feature-request prefix", () => {
    const featureRequest = {
      title: "[Feature] Add BillingClient.showInAppMessages() support",
      body: "Expose BillingClient.showInAppMessages() on Android.",
    };

    expect(
      validateFormattingResult(featureRequest, {
        needsImprovement: true,
        reasoning: "Normalize the feature request",
        suggestedTitle:
          "[Feature] Add BillingClient.showInAppMessages() support",
        suggestedBody: `<details>\n${featureRequest.body}\n</details>`,
        changesSummary: "Added formatting",
      }),
    ).toContain('feature request title must start with "[FR]"');
  });

  it("does not classify an explicitly negated feature request as an FR", () => {
    const bugReport = {
      title: "Wrong issue type",
      body: "This is not a feature request. The current behavior is incorrect.",
    };

    expect(
      validateFormattingResult(bugReport, {
        needsImprovement: true,
        reasoning: "Add structure",
        suggestedTitle: "[Bug] Wrong issue type",
        suggestedBody: `<details>\n${bugReport.body}\n</details>`,
        changesSummary: "Added formatting",
      }),
    ).toEqual([]);
  });

  it("preserves technical identifiers in the title exactly", () => {
    const technicalIssue = {
      title: "E_CONN from BillingClient.showInAppMessages()",
      body: "The call returns E_CONN.",
    };
    const validation = validateFormattingResult(technicalIssue, {
      needsImprovement: true,
      reasoning: "Clarify the title",
      suggestedTitle: "[Bug] Connection fails",
      suggestedBody: `<details>\n${technicalIssue.body}\n</details>`,
      changesSummary: "Added structure",
    });

    expect(validation).toEqual(
      expect.arrayContaining([
        "suggested title drops technical detail: E_CONN",
        "suggested title drops technical detail: BillingClient.showInAppMessages()",
      ]),
    );
  });

  it("rejects new technical facts added outside the preserved original", () => {
    const original = {
      title: "App fails to open",
      body: "The app closes immediately after launch.",
    };
    const validation = validateFormattingResult(original, {
      needsImprovement: true,
      reasoning: "Add structure",
      suggestedTitle: "[Bug] App fails to open",
      suggestedBody: `<details>\n${original.body}\n</details>\n\n## Environment\nAndroid 14`,
      changesSummary: "Added structure",
    });

    const additionIssue = validation.find((item) =>
      item.startsWith(
        "suggested body introduces unverified technical details:",
      ),
    );
    expect(additionIssue).toContain("Android");
    expect(additionIssue).toContain("14");
  });

  it("rejects synthesis when the original body is empty", () => {
    expect(
      validateFormattingResult(
        { title: "bug", body: "" },
        {
          needsImprovement: true,
          reasoning: "Add a description",
          suggestedTitle: "[Bug] Missing description",
          suggestedBody: "## Description\nThe application crashes.",
          changesSummary: "Added a description",
        },
      ),
    ).toContain("cannot safely synthesize a formatted body from an empty body");
  });

  it("keeps a validated title and body behind manual review", () => {
    const result = {
      needsImprovement: true,
      reasoning: "Needs structure",
      suggestedTitle: "[Bug] Connection fails",
      suggestedBody: `<details>\n${issue.body}\n</details>\n\n## Description\nConnection fails.`,
      changesSummary: "Added structure",
    };

    expect(validateFormattingResult(issue, result)).toEqual([]);
    expect(
      evaluateAutoPublishEligibility(
        { ...result, formatValidationPassed: true },
        "format",
      ),
    ).toEqual({
      eligible: false,
      reasons: ["formatting changes require manual approval"],
    });
  });
});
