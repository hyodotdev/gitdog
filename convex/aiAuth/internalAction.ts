import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { CLAUDE_API_ENDS_AT } from "../_ai/config";
import { createAnthropicFederationAuthorizer } from "../_ai/federation";
import { ChatProviderRequestError } from "../_ai/providerErrors";
import { ClaudeProvider } from "../_ai/providers";

// Deployment-admin diagnostic: authenticate without inference or user content.
export const checkClaudeFederation = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    httpStatus: v.optional(v.number()),
    error: v.optional(v.string()),
  }),
  handler: async () => {
    try {
      const headers = await createAnthropicFederationAuthorizer()();
      if (Date.now() >= CLAUDE_API_ENDS_AT) {
        return { ok: false, error: "Claude API access has ended" };
      }
      const response = await fetch(
        "https://api.anthropic.com/v1/models?limit=1",
        {
          headers: { ...headers, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(15_000),
        },
      );
      await response.body?.cancel().catch(() => undefined);
      return { ok: response.status === 200, httpStatus: response.status };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof ChatProviderRequestError
            ? error.message
            : "Claude authentication check could not complete",
      };
    }
  },
});

// Explicit, bounded deployment QA. Uses a fixed prompt and no user quota/data.
export const checkClaudeGeneration = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  }),
  handler: async () => {
    const provider = new ClaudeProvider(
      "",
      createAnthropicFederationAuthorizer(),
    );
    const result = await provider.chat(
      [{ role: "user", content: "Reply OK." }],
      {
        maxTokens: 512,
      },
    );
    if (!result.usage)
      throw new Error("Claude generation QA did not return usage");
    return {
      ok: result.finishReason === "stop" && result.content.trim().length > 0,
      inputTokens: result.usage.promptTokens,
      outputTokens: result.usage.completionTokens,
    };
  },
});
