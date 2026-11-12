import { describe, expect, it } from "vitest";
import type { ActionCtx } from "../../../convex/_generated/server";
import type {
  AiProvider,
  ChatCompletionResult,
  ChatMessage,
} from "../../../convex/_ai/model";
import {
  analyzeIssueWithTools,
  cleanValidationTopicFocus,
  getSuccessfulReadPath,
  validateIssueAnalysisResultShape,
} from "../../../convex/_ai/issueAnalysis/agenticWorkflow";

function createReadyContext(): ActionCtx {
  return {
    runQuery: async (_query, args: Record<string, unknown>) =>
      "expectedIndexVersion" in args
        ? { indexVersion: args.expectedIndexVersion ?? 1 }
        : [],
  } as unknown as ActionCtx;
}

describe("agentic response repair", () => {
  it.each([true, false])(
    "preserves native truncated reasoning without adding empty assistant text (history=%s)",
    async (nativeHistory) => {
      const history = [
        {
          type: "openai_reasoning" as const,
          id: "rs_test",
          encryptedContent: "encrypted-state",
          summary: [],
        },
      ];
      const calls: ChatMessage[][] = [];
      const provider: AiProvider = {
        name: "Sol",
        modelId: "gpt-6.1-sol",
        providerId: "openai",
        chat: async (messages) => {
          calls.push(structuredClone(messages));
          return calls.length === 1
            ? {
                content: "",
                finishReason: "length",
                historyContent: nativeHistory ? history : undefined,
              }
            : {
                content: JSON.stringify({
                  isActionable: false,
                  issueType: "discussion",
                  reasoning: "Repository policy question",
                  suggestedResponse:
                    "The repository does not establish this policy; maintainers need to decide it.",
                  confidence: 0.6,
                }),
                finishReason: "stop",
              };
        },
      };
      const result = await analyzeIssueWithTools(
        createReadyContext(),
        "repository-id" as never,
        { title: "Roadmap question", body: "Is this planned?" },
        provider,
      );
      expect(result.success).toBe(true);
      expect(calls).toHaveLength(2);
      const assistant = calls[1].filter(
        (message) => message.role === "assistant",
      );
      expect(assistant).toEqual(
        nativeHistory ? [{ role: "assistant", content: history }] : [],
      );
    },
  );

  it("removes GitHub author metadata and leading mentions from topic focus", () => {
    expect(
      cleanValidationTopicFocus(
        "[camelCaseUser [Maintainer]]: @gitdogbot Can you verify BillingClient.showInAppMessages()?",
      ),
    ).toBe("Can you verify BillingClient.showInAppMessages()?");
    expect(
      cleanValidationTopicFocus(
        "[camelCaseUser]: @scope/package fails during initialization",
      ),
    ).toBe("@scope/package fails during initialization");
    expect(
      cleanValidationTopicFocus(
        "[camelCaseUser]: [SomeAPI]: preserve this bracketed topic",
      ),
    ).toBe("[SomeAPI]: preserve this bracketed topic");
  });

  it("rejects invalid runtime result fields and confidence ranges", () => {
    expect(
      validateIssueAnalysisResultShape({
        isActionable: "yes",
        issueType: "bug",
        reasoning: "",
        confidence: 4,
      }),
    ).toEqual(
      expect.arrayContaining([
        "isActionable must be a boolean",
        "issueType is invalid",
        "reasoning must be a non-empty bounded string",
        "confidence must be a number between 0 and 1",
      ]),
    );
  });

  it("records only paths from successful read_file results", () => {
    expect(
      getSuccessfulReadPath(
        "read_file",
        { path: "src/index.ts" },
        "File: src/index.ts\nLines: 1-5",
      ),
    ).toBe("src/index.ts");
    expect(
      getSuccessfulReadPath(
        "read_file",
        { path: "missing.ts" },
        "File not found: missing.ts",
      ),
    ).toBeUndefined();
    expect(
      getSuccessfulReadPath(
        "search_code",
        { path: "src/index.ts" },
        "File: src/index.ts:1-5",
      ),
    ).toBeUndefined();
  });

  it("repairs a deterministic validation failure once and marks it for review", async () => {
    const responses: ChatCompletionResult[] = [
      {
        content: JSON.stringify({
          isActionable: true,
          issueType: "actionable",
          reasoning: "Missing support",
          suggestedResponse:
            "This API is not implemented. File a GitHub issue for this feature request, then wait for maintainer review before proceeding.",
          confidence: 0.9,
        }),
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
      {
        content: JSON.stringify({
          isActionable: true,
          issueType: "actionable",
          reasoning: "Missing support",
          suggestedResponse:
            "This is already the feature request. The next step is maintainer review of the public API contract; no additional issue is needed.",
          confidence: 0.7,
        }),
        finishReason: "stop",
        usage: { promptTokens: 40, completionTokens: 15, totalTokens: 55 },
      },
    ];
    let callCount = 0;
    const provider: AiProvider = {
      name: "Test provider",
      modelId: "test-model",
      providerId: "test-provider",
      chat: async () => responses[callCount++],
    };
    const ctx = createReadyContext();

    const result = await analyzeIssueWithTools(
      ctx,
      "repository-id" as never,
      {
        title: "[Feature] Add SomeAPI support",
        body: "Please expose SomeAPI through the wrapper.",
      },
      provider,
    );

    expect(callCount).toBe(2);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      wasRepaired: true,
      toolsUsed: 0,
      filesRead: 0,
      filesReadPaths: [],
      toolErrors: 0,
      validationPassed: true,
    });
    expect(result.output?.suggestedResponse).toContain(
      "no additional issue is needed",
    );
    expect(result.tokenUsage).toMatchObject({
      inputTokens: 140,
      outputTokens: 35,
      model: "test-model",
      provider: "test-provider",
    });
  });

  it("retains original feature-request context while focusing a follow-up API", async () => {
    const responses: ChatCompletionResult[] = [
      {
        content: JSON.stringify({
          isActionable: true,
          issueType: "actionable",
          reasoning: "Missing support",
          suggestedResponse:
            "BillingClient.showInAppMessages() is missing. File a GitHub issue for this feature request.",
          confidence: 0.9,
        }),
        finishReason: "stop",
      },
      {
        content: JSON.stringify({
          isActionable: true,
          issueType: "actionable",
          reasoning: "Missing support",
          suggestedResponse:
            "BillingClient.showInAppMessages() is already being tracked by this feature request; maintainer review is the next step.",
          confidence: 0.7,
        }),
        finishReason: "stop",
      },
    ];
    let callCount = 0;
    const provider: AiProvider = {
      name: "Test provider",
      modelId: "test-model",
      providerId: "test-provider",
      chat: async () => responses[callCount++],
    };
    const ctx = createReadyContext();

    const result = await analyzeIssueWithTools(
      ctx,
      "repository-id" as never,
      {
        title: "[Feature] Add BillingClient.showInAppMessages() support",
        body: "Expose the native API through the wrapper.",
      },
      provider,
      {
        validationFocus:
          "[camelCaseUser [Maintainer]]: @gitdogbot Can you verify BillingClient.showInAppMessages()?",
      },
    );

    expect(callCount).toBe(2);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      wasRepaired: true,
      validationPassed: true,
    });
    expect(result.output?.suggestedResponse).not.toContain(
      "File a GitHub issue",
    );
  });

  it("repairs an out-of-range confidence before accepting the result", async () => {
    const responses: ChatCompletionResult[] = [
      {
        content: JSON.stringify({
          isActionable: false,
          issueType: "discussion",
          reasoning: "Repository policy question",
          suggestedResponse:
            "The repository does not establish this policy; maintainers need to decide it.",
          confidence: 9,
        }),
        finishReason: "stop",
      },
      {
        content: JSON.stringify({
          isActionable: false,
          issueType: "discussion",
          reasoning: "Repository policy question",
          suggestedResponse:
            "The repository does not establish this policy; maintainers need to decide it.",
          confidence: 0.6,
        }),
        finishReason: "stop",
      },
    ];
    let callCount = 0;
    const provider: AiProvider = {
      name: "Test provider",
      modelId: "test-model",
      providerId: "test-provider",
      chat: async () => responses[callCount++],
    };
    const ctx = createReadyContext();

    const result = await analyzeIssueWithTools(
      ctx,
      "repository-id" as never,
      { title: "Roadmap question", body: "Is this planned?" },
      provider,
    );

    expect(callCount).toBe(2);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      confidence: 0.6,
      wasRepaired: true,
      validationPassed: true,
    });
  });
});
