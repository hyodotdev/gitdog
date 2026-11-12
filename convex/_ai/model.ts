import { getCreditFallbackProvider } from "./providers";

export const DEFAULT_OUTPUT_TOKEN_LIMIT = 4_096;

export function getGenerationOutputReservationLimit(
  outputTokenLimit: number = DEFAULT_OUTPUT_TOKEN_LIMIT,
): number {
  if (!Number.isSafeInteger(outputTokenLimit) || outputTokenLimit < 1) {
    throw new Error("Output token limit is invalid");
  }
  return outputTokenLimit;
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | TextContent
        | ToolUseContent
        | ToolResultContent
        | ThinkingContent
        | OpenAIReasoningContent
      >;
};

export type TextContent = {
  type: "text";
  text: string;
  openAIPhase?: "commentary" | "final_answer";
  thought?: boolean;
  thoughtSignature?: string;
};

export type ThinkingContent =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export type OpenAIReasoningContent = {
  type: "openai_reasoning";
  id: string;
  encryptedContent: string;
  summary: Array<{ type: "summary_text"; text: string }>;
};

export type ToolUseContent = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  thought?: boolean;
  thoughtSignature?: string;
};

export type ToolResultContent = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
};

export type ChatCompletionOptions = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  tools?: ToolDefinition[];
  billingLabel?: string;
  responseFormat?: {
    name: string;
    schema: Record<string, unknown>;
  };
};

export type ChatCompletionResult = {
  content: string;
  finishReason:
    | "stop"
    | "length"
    | "content_filter"
    | "tool_use"
    | "invalid_tool_call"
    | "provider_error";
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider?: string;
  modelId?: string;
  providerId?: string;
  providerRequestId?: string;
  /** Provider-native parts needed to replay stateless tool conversations. */
  historyContent?: Array<
    TextContent | ToolUseContent | ThinkingContent | OpenAIReasoningContent
  >;
  toolUse?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
};

export interface AiProvider {
  chat(
    messages: Array<ChatMessage>,
    options?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult>;
  name: string;
  modelId: string;
  providerId: string;
}

export function getDefaultAiModel(): AiProvider {
  if (
    process.env.AI_GENERATION_ROUTE &&
    process.env.AI_GENERATION_ROUTE !== "claude-openai"
  ) {
    throw new Error("Unsupported AI_GENERATION_ROUTE");
  }
  return getCreditFallbackProvider();
}
