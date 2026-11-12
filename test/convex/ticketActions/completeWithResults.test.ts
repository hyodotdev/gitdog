import { describe, expect, it } from "vitest";
import {
  AUTO_PUBLISH_CONFIDENCE_THRESHOLD,
  evaluateAutoPublishEligibility,
} from "../../../convex/ticketActions/internalMutation";

const groundedAnswer = {
  groundedIndexVersion: 7,
  suggestedResponse:
    "The implementation in src/config.ts answers this question directly.",
  issueType: "question",
  isActionable: false,
  confidence: AUTO_PUBLISH_CONFIDENCE_THRESHOLD,
  toolsUsed: 2,
  filesRead: 1,
  filesReadPaths: ["src/config.ts"],
  toolErrors: 0,
  validationPassed: true,
};

describe("evaluateAutoPublishEligibility", () => {
  it("allows a low-risk grounded answer at the confidence boundary", () => {
    expect(evaluateAutoPublishEligibility(groundedAnswer)).toEqual({
      eligible: true,
      reasons: [],
    });
  });

  it("always requires manual review for formatting actions", () => {
    expect(
      evaluateAutoPublishEligibility({ suggestedTitle: "[Bug] Clear title" }),
    ).toEqual({
      eligible: false,
      reasons: ["missing suggested response"],
    });

    const validatedFormat = evaluateAutoPublishEligibility(
      {
        suggestedTitle: "[Bug] Clear title",
        suggestedBody: "Original body",
        formatValidationPassed: true,
      },
      "format",
    );
    expect(validatedFormat.eligible).toBe(false);
    expect(validatedFormat.reasons).toContain(
      "formatting changes require manual approval",
    );

    expect(
      evaluateAutoPublishEligibility(
        {
          ...groundedAnswer,
          suggestedTitle: "[Bug] Clear title",
          suggestedBody: "Original body",
          formatValidationPassed: true,
        },
        "format",
      ).eligible,
    ).toBe(false);
  });

  it.each([
    {
      name: "missing confidence",
      changes: { confidence: undefined },
      reason: "confidence below auto-publish threshold",
    },
    {
      name: "low confidence",
      changes: { confidence: AUTO_PUBLISH_CONFIDENCE_THRESHOLD - 0.01 },
      reason: "confidence below auto-publish threshold",
    },
    {
      name: "no tool calls",
      changes: { toolsUsed: 0 },
      reason: "no successful grounding workflow recorded",
    },
    {
      name: "no files read",
      changes: { filesRead: 0 },
      reason: "no repository file was read",
    },
    {
      name: "tool failure",
      changes: { toolErrors: 1 },
      reason: "repository tool errors occurred",
    },
    {
      name: "missing deterministic validation",
      changes: { validationPassed: false },
      reason: "deterministic response validation did not pass",
    },
    {
      name: "uncited repository evidence",
      changes: { filesReadPaths: ["src/unrelated.ts"] },
      reason: "response does not cite a repository file that was read",
    },
    {
      name: "validation repair",
      changes: { wasRepaired: true },
      reason: "response required validation repair",
    },
    {
      name: "actionable analysis",
      changes: { issueType: "actionable", isActionable: true },
      reason: "actionable code-change analysis requires review",
    },
  ])("blocks $name", ({ changes, reason }) => {
    const decision = evaluateAutoPublishEligibility({
      ...groundedAnswer,
      ...changes,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain(reason);
  });

  it.each([
    "Root cause: the listener is never reset.",
    "Use this code:\n```ts\nreset();\n```",
    "See https://example.com for the exact endpoint.",
    "I recommend closing this issue as not reproducible.",
    "Change src/index.ts:42 to return early.",
  ])("requires review for high-risk guidance: %s", (suggestedResponse) => {
    const decision = evaluateAutoPublishEligibility({
      ...groundedAnswer,
      suggestedResponse,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain(
      "response contains high-risk technical guidance",
    );
  });

  it("requires review for speculative guidance even at high confidence", () => {
    const decision = evaluateAutoPublishEligibility({
      ...groundedAnswer,
      suggestedResponse:
        "src/config.ts shows this could be a timing issue caused by bridge initialization.",
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain(
      "response contains speculative technical guidance",
    );
  });

  it.each([
    "In src/config.ts, replace `false` with `true` to enable this.",
    "To fix this, set `enabled` to `true` in src/config.ts.",
    "You should call `reset()` after reading src/config.ts.",
  ])("requires review for imperative code-change guidance: %s", (response) => {
    const decision = evaluateAutoPublishEligibility({
      ...groundedAnswer,
      suggestedResponse: response,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain(
      "response contains actionable change instructions",
    );
  });

  it("requires review for non-English responses", () => {
    const decision = evaluateAutoPublishEligibility({
      ...groundedAnswer,
      suggestedResponse: "src/config.ts를 보면 iOS에서는 항상 실패합니다.",
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain(
      "non-English responses require manual review",
    );
  });

  it("fails closed for malformed proposed changes", () => {
    expect(evaluateAutoPublishEligibility(null)).toEqual({
      eligible: false,
      reasons: ["missing proposed changes"],
    });
    expect(evaluateAutoPublishEligibility([])).toEqual({
      eligible: false,
      reasons: ["missing proposed changes"],
    });
  });

  it("fails closed for unvalidated formatting changes", () => {
    const decision = evaluateAutoPublishEligibility(
      {
        suggestedTitle: "[Bug] Clear title",
        suggestedBody: "Original body",
      },
      "format",
    );

    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain("format validation did not pass");
  });
});
