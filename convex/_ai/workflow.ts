import type { AiProvider, ChatMessage } from "./model";
import { ChatBillingError } from "./chatBilling";

// Workflow types
export type WorkflowStep<TInput, TOutput> = (
  input: TInput,
  context: WorkflowContext,
) => Promise<TOutput>;

export type WorkflowContext = {
  aiProvider: AiProvider;
  metadata: Record<string, unknown>;
  // Token usage tracking
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
};

export type WorkflowState = {
  data: Record<string, unknown>;
  errors: Array<{ step: string; error: string }>;
  completed: boolean;
};

// Workflow builder - similar to LangGraph's StateGraph
export class Workflow<TInput, TOutput> {
  private steps: Array<{
    name: string;
    fn: (input: unknown, context: WorkflowContext) => Promise<unknown>;
  }> = [];

  addStep<TStepInput, TStepOutput>(
    name: string,
    fn: WorkflowStep<TStepInput, TStepOutput>,
  ): this {
    this.steps.push({
      name,
      fn: fn as (input: unknown, context: WorkflowContext) => Promise<unknown>,
    });
    return this;
  }

  async execute(
    input: TInput,
    context: WorkflowContext,
  ): Promise<{
    success: boolean;
    output?: TOutput;
    errors: Array<string>;
    tokenUsage?: { inputTokens: number; outputTokens: number };
  }> {
    const state: WorkflowState = {
      data: { input },
      errors: [],
      completed: false,
    };

    // Initialize token tracking in context
    context.tokenUsage = { inputTokens: 0, outputTokens: 0 };

    let currentData: unknown = input;

    for (const step of this.steps) {
      try {
        console.log(`executing workflow step: ${step.name}`);
        currentData = await step.fn(currentData, context);
        state.data[step.name] = currentData;
      } catch (error) {
        if (error instanceof ChatBillingError && error.durableRetrySafe) {
          throw error;
        }
        const errorMessage =
          error instanceof Error ? error.message : "unknown error";
        console.error(`workflow step ${step.name} failed`);
        state.errors.push({ step: step.name, error: errorMessage });
        return {
          success: false,
          errors: state.errors.map((e) => `${e.step}: ${e.error}`),
          tokenUsage: context.tokenUsage,
        };
      }
    }

    state.completed = true;
    return {
      success: true,
      output: currentData as TOutput,
      errors: [],
      tokenUsage: context.tokenUsage,
    };
  }
}

// Extract JSON from content (handles markdown code blocks)
function extractJson(content: string): string {
  let trimmed = content.trim();

  // Handle markdown code blocks: ```json ... ``` or ``` ... ```
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    trimmed = codeBlockMatch[1].trim();
  }

  // Find the JSON object boundaries
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.substring(start, end + 1);
  }

  return trimmed;
}

// Check if JSON response appears complete
function isJsonComplete(content: string): boolean {
  const json = extractJson(content);

  // Check if it starts with { and ends with }
  if (!json.startsWith("{")) return false;
  if (!json.endsWith("}")) return false;

  // Check balanced braces
  let depth = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '"' && (i === 0 || json[i - 1] !== "\\")) {
      inString = !inString;
    }
    if (!inString) {
      if (char === "{") depth++;
      if (char === "}") depth--;
    }
  }
  return depth === 0;
}

// Helper function to create AI chat step with retry logic
export function createChatStep(
  systemPrompt: string,
  userPromptTemplate: (input: unknown) => string,
  options?: {
    maxTokens?: number;
    temperature?: number;
    retries?: number;
    billingLabel?: string;
  },
) {
  return async (input: unknown, context: WorkflowContext): Promise<string> => {
    const maxRetries = options?.retries ?? 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const messages: Array<ChatMessage> = [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPromptTemplate(input),
        },
      ];

      // Increase maxTokens on retry if response was truncated
      const currentMaxTokens = (options?.maxTokens ?? 2000) + attempt * 4000;

      console.log(
        `[createChatStep] Attempt ${attempt + 1}/${maxRetries + 1}, maxTokens: ${currentMaxTokens}`,
      );

      const result = await context.aiProvider.chat(messages, {
        temperature: options?.temperature ?? 0.7,
        maxTokens: currentMaxTokens,
        billingLabel: `${options?.billingLabel ?? "workflow-chat"}/${attempt}`,
      });

      // Accumulate token usage
      if (result.usage && context.tokenUsage) {
        context.tokenUsage.inputTokens += result.usage.promptTokens;
        context.tokenUsage.outputTokens += result.usage.completionTokens;
      }

      console.log(
        `[createChatStep] Response finishReason: ${result.finishReason}, contentLength: ${result.content?.length}, usage: ${JSON.stringify(result.usage)}`,
      );

      if (!result.content) {
        lastError = new Error("AI chat failed - no response");
        console.warn(
          `[createChatStep] Attempt ${attempt + 1} failed - no response, retrying...`,
        );
        continue;
      }

      if (result.finishReason === "length") {
        lastError = new Error("AI response was truncated due to token limit");
        console.warn(
          `[createChatStep] Attempt ${attempt + 1} truncated (finishReason=length), retrying with more tokens...`,
        );
        continue;
      }

      // Check if JSON is complete even if finishReason is "stop"
      if (!isJsonComplete(result.content)) {
        lastError = new Error("AI response JSON appears incomplete");
        console.warn(
          `[createChatStep] Attempt ${attempt + 1} JSON incomplete despite finishReason=${result.finishReason}, retrying...`,
        );
        continue;
      }

      // Success
      console.log(`[createChatStep] Success on attempt ${attempt + 1}`);
      return result.content;
    }

    throw lastError || new Error("AI chat failed after retries");
  };
}
