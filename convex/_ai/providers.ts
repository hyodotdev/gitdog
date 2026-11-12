import { CLAUDE_API_ENDS_AT, GENERATION_MODELS } from "./config";
import { createAnthropicFederationAuthorizer } from "./federation";
import type {
  AiProvider,
  ChatMessage,
  ChatCompletionOptions,
  ChatCompletionResult,
  TextContent,
  ToolUseContent,
  ThinkingContent,
  OpenAIReasoningContent,
} from "./model";
import { ChatProviderRequestError, type ProviderUsage } from "./providerErrors";

const REQUEST_TIMEOUT_MS = 120_000;
type RecordValue = Record<string, unknown>;
type HistoryContent = TextContent | ToolUseContent | ThinkingContent;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokens(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function unavailable(message: string): ChatProviderRequestError {
  return new ChatProviderRequestError(message, "not_billed", {
    unavailable: true,
  });
}

function parts(message: ChatMessage) {
  return typeof message.content === "string"
    ? [{ type: "text" as const, text: message.content }]
    : message.content;
}

function systemPrompt(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "system")
    .flatMap((m) =>
      parts(m).flatMap((p) => (p.type === "text" ? [p.text] : [])),
    )
    .join("\n\n");
}

async function request(
  url: string,
  headers: Record<string, string>,
  body: RecordValue,
  deadline?: number,
): Promise<{ data: RecordValue; requestId?: string }> {
  let started = false;
  let requestId: string | undefined;
  try {
    const serialized = JSON.stringify(body);
    if (deadline !== undefined && Date.now() >= deadline)
      throw unavailable("Claude API access has ended");
    started = true;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: serialized,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    requestId =
      response.headers.get("request-id") ??
      response.headers.get("x-request-id") ??
      undefined;
    if (!response.ok) {
      // Read only bounded error metadata; never surface provider bodies or keys.
      const reader = response.body?.getReader();
      let text = "";
      if (reader) {
        while (text.length < 16_384) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += new TextDecoder().decode(
            chunk.value.subarray(0, 16_384 - text.length),
          );
        }
        await reader.cancel().catch(() => undefined);
      }
      let error: RecordValue | undefined;
      try {
        const value: unknown = JSON.parse(text);
        if (record(value) && record(value.error)) error = value.error;
      } catch {
        /* Non-JSON rejection. */
      }
      const code =
        error?.code ??
        (record(error?.details) ? error.details.error_code : undefined);
      const creditExhausted =
        (response.status === 429 &&
          (code === "insufficient_quota" ||
            code === "credit_balance_exhausted" ||
            code === "enforced_spend_limit_reached")) ||
        (response.status === 402 && error?.type === "billing_error") ||
        ((response.status === 400 || response.status === 429) &&
          (error?.type === "invalid_request_error" ||
            error?.type === "rate_limit_error") &&
          typeof error.message === "string" &&
          /credit balance is too low|you have reached your specified (?:workspace )?API usage limits|(?:monthly|organization|workspace|account).*spend(?:ing)? (?:limit|cap)|spend limit.*(?:organization|workspace)/i.test(
            error.message,
          ));
      const notBilled = [400, 401, 402, 403, 404, 409, 413, 422, 429].includes(
        response.status,
      );
      throw new ChatProviderRequestError(
        `AI provider rejected the request with HTTP ${response.status}`,
        notBilled ? "not_billed" : "ambiguous",
        {
          httpStatus: response.status,
          providerRequestId: requestId,
          creditExhausted,
        },
      );
    }
    const data: unknown = await response.json();
    if (!record(data)) throw new Error("Invalid provider response");
    return { data, requestId };
  } catch (error) {
    if (error instanceof ChatProviderRequestError) throw error;
    throw new ChatProviderRequestError(
      "AI provider usage could not be verified",
      started ? "ambiguous" : "not_billed",
      { providerRequestId: requestId },
    );
  }
}

function usage(
  input: unknown,
  output: unknown,
  requestId?: string,
): ProviderUsage {
  if (
    !tokens(input) ||
    !tokens(output) ||
    !Number.isSafeInteger(input + output)
  ) {
    throw new ChatProviderRequestError(
      "AI provider returned invalid usage metadata",
      "ambiguous",
      { providerRequestId: requestId },
    );
  }
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input + output,
  };
}

function parseTool(value: RecordValue, input: unknown): ToolUseContent {
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !record(input)
  ) {
    throw new Error("Invalid function call");
  }
  return { type: "tool_use", id: value.id, name: value.name, input };
}

export class ClaudeProvider implements AiProvider {
  readonly name = GENERATION_MODELS.anthropic.name;
  readonly modelId = GENERATION_MODELS.anthropic.modelId;
  readonly providerId = "anthropic";
  constructor(
    private readonly apiKey: string,
    private readonly authorize?: () => Promise<Record<string, string>>,
  ) {}

  async chat(
    messages: ChatMessage[],
    options?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    if (Date.now() >= CLAUDE_API_ENDS_AT)
      throw unavailable("Claude API access has ended");
    if (!this.authorize && !this.apiKey.trim())
      throw unavailable("Anthropic API key is not configured");
    const { data, requestId } = await request(
      "https://api.anthropic.com/v1/messages",
      {
        ...(this.authorize
          ? await this.authorize()
          : { "x-api-key": this.apiKey }),
        "anthropic-version": "2023-06-01",
      },
      {
        model: this.modelId,
        system: systemPrompt(messages),
        messages: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role,
            content: parts(m).flatMap((p) => {
              switch (p.type) {
                case "text":
                  return { type: "text", text: p.text };
                case "tool_use":
                  return {
                    type: p.type,
                    id: p.id,
                    name: p.name,
                    input: p.input,
                  };
                case "tool_result":
                  return p;
                case "thinking":
                case "redacted_thinking":
                  return p;
                case "openai_reasoning":
                  return [];
              }
            }),
          }))
          .filter((m) => m.content.length > 0),
        max_tokens: options?.maxTokens ?? 4096,
        thinking: { type: "adaptive" },
        output_config: {
          effort: GENERATION_MODELS.anthropic.effort,
          ...(options?.responseFormat
            ? {
                format: {
                  type: "json_schema",
                  schema: options.responseFormat.schema,
                },
              }
            : {}),
        },
        ...(options?.tools?.length ? { tools: options.tools } : {}),
      },
      CLAUDE_API_ENDS_AT,
    );
    const counts = record(data.usage) ? data.usage : {};
    // No prompt caching is requested. Reject unexpected cache billing rather
    // than recording an incorrect price or incomplete token count.
    const billed = usage(counts.input_tokens, counts.output_tokens, requestId);
    try {
      if (
        (counts.cache_creation_input_tokens ?? 0) !== 0 ||
        (counts.cache_read_input_tokens ?? 0) !== 0
      ) {
        throw new ChatProviderRequestError(
          "Claude returned unsupported cache usage",
          "ambiguous",
          { providerRequestId: requestId },
        );
      }
      if (!Array.isArray(data.content) || data.content.length === 0)
        throw new Error("Missing content");
      const history: HistoryContent[] = data.content.map((p: unknown) => {
        if (!record(p)) throw new Error("Invalid content block");
        if (p.type === "text" && typeof p.text === "string")
          return { type: "text", text: p.text };
        if (p.type === "tool_use") return parseTool(p, p.input);
        if (
          p.type === "thinking" &&
          typeof p.thinking === "string" &&
          typeof p.signature === "string"
        ) {
          return {
            type: "thinking",
            thinking: p.thinking,
            signature: p.signature,
          };
        }
        if (p.type === "redacted_thinking" && typeof p.data === "string")
          return { type: "redacted_thinking", data: p.data };
        throw new Error("Unsupported content block");
      });
      const toolUse = history.filter(
        (p): p is ToolUseContent => p.type === "tool_use",
      );
      const finishReason =
        data.stop_reason === "tool_use"
          ? "tool_use"
          : data.stop_reason === "max_tokens"
            ? "length"
            : ["end_turn", "stop_sequence"].includes(String(data.stop_reason))
              ? "stop"
              : "provider_error";
      if (finishReason === "tool_use" && toolUse.length === 0)
        throw new Error("Missing tool call");
      return {
        content: history
          .flatMap((p) => (p.type === "text" ? [p.text] : []))
          .join("\n"),
        finishReason,
        toolUse: toolUse.length ? toolUse : undefined,
        historyContent: history,
        usage: billed,
        provider: this.name,
        modelId: this.modelId,
        providerId: this.providerId,
        providerRequestId: requestId,
      };
    } catch (error) {
      if (error instanceof ChatProviderRequestError) throw error;
      throw new ChatProviderRequestError(
        "Claude response could not be processed",
        "billed",
        { usage: billed, providerRequestId: requestId },
      );
    }
  }
}

export class OpenAIProvider implements AiProvider {
  readonly name = GENERATION_MODELS.openai.name;
  readonly modelId = GENERATION_MODELS.openai.modelId;
  readonly providerId = "openai";
  constructor(private readonly apiKey: string) {}

  async chat(
    messages: ChatMessage[],
    options?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    if (!this.apiKey.trim())
      throw unavailable("OpenAI API key is not configured");
    const input: RecordValue[] = [];
    for (const message of messages) {
      if (message.role === "system") continue;
      for (const p of parts(message)) {
        switch (p.type) {
          case "text":
            input.push({
              role: message.role,
              content: p.text,
              ...(message.role === "assistant" && p.openAIPhase
                ? { phase: p.openAIPhase }
                : {}),
            });
            break;
          case "tool_use":
            input.push({
              type: "function_call",
              call_id: p.id,
              name: p.name,
              arguments: JSON.stringify(p.input),
            });
            break;
          case "tool_result":
            input.push({
              type: "function_call_output",
              call_id: p.tool_use_id,
              output: p.content,
            });
            break;
          // Claude's signed thinking is meaningful only to Anthropic.
          case "thinking":
          case "redacted_thinking":
            break;
          case "openai_reasoning":
            input.push({
              type: "reasoning",
              id: p.id,
              encrypted_content: p.encryptedContent,
              summary: p.summary,
            });
            break;
        }
      }
    }
    const { data, requestId } = await request(
      "https://api.openai.com/v1/responses",
      {
        Authorization: `Bearer ${this.apiKey}`,
      },
      {
        model: this.modelId,
        instructions: systemPrompt(messages),
        input,
        store: false,
        reasoning: { effort: GENERATION_MODELS.openai.effort },
        include: ["reasoning.encrypted_content"],
        max_output_tokens: options?.maxTokens ?? 4096,
        ...(options?.responseFormat
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: options.responseFormat.name,
                  strict: true,
                  schema: options.responseFormat.schema,
                },
              },
            }
          : {}),
        // Explicit mode with no breakpoint disables cache reads and writes.
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
        ...(options?.tools?.length
          ? {
              tools: options.tools.map((t) => ({
                type: "function",
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
                strict: false,
              })),
            }
          : {}),
      },
    );
    const counts = record(data.usage) ? data.usage : {};
    const billed = usage(counts.input_tokens, counts.output_tokens, requestId);
    const details = record(counts.input_tokens_details)
      ? counts.input_tokens_details
      : {};
    if (
      (details.cached_tokens ?? 0) !== 0 ||
      (details.cache_write_tokens ?? 0) !== 0
    ) {
      throw new ChatProviderRequestError(
        "OpenAI returned unexpected prompt cache usage",
        "ambiguous",
        { providerRequestId: requestId },
      );
    }
    if (counts.total_tokens !== billed.totalTokens)
      throw new ChatProviderRequestError(
        "OpenAI returned inconsistent usage metadata",
        "ambiguous",
        { providerRequestId: requestId },
      );
    try {
      if (!Array.isArray(data.output)) throw new Error("Invalid output");
      const history: Array<
        TextContent | ToolUseContent | OpenAIReasoningContent
      > = [];
      let refused = false;
      for (const item of data.output as unknown[]) {
        if (!record(item)) throw new Error("Invalid output item");
        if (item.type === "reasoning") {
          if (
            typeof item.id !== "string" ||
            !item.id ||
            typeof item.encrypted_content !== "string" ||
            !item.encrypted_content ||
            !Array.isArray(item.summary)
          )
            throw new Error("Invalid encrypted reasoning item");
          const summary = item.summary.map((part: unknown) => {
            if (
              !record(part) ||
              part.type !== "summary_text" ||
              typeof part.text !== "string"
            )
              throw new Error("Invalid reasoning summary");
            return { type: "summary_text" as const, text: part.text };
          });
          history.push({
            type: "openai_reasoning",
            id: item.id,
            encryptedContent: item.encrypted_content,
            summary,
          });
        } else if (item.type === "function_call") {
          if (typeof item.arguments !== "string")
            throw new Error("Invalid tool arguments");
          history.push(
            parseTool(
              { ...item, id: item.call_id },
              JSON.parse(item.arguments),
            ),
          );
        } else if (item.type === "message" && Array.isArray(item.content)) {
          if (
            item.phase !== undefined &&
            item.phase !== "commentary" &&
            item.phase !== "final_answer"
          ) {
            throw new Error("Invalid assistant message phase");
          }
          for (const p of item.content as unknown[]) {
            if (!record(p)) throw new Error("Invalid content block");
            if (p.type === "output_text" && typeof p.text === "string")
              history.push({
                type: "text",
                text: p.text,
                ...(item.phase ? { openAIPhase: item.phase } : {}),
              });
            else if (p.type === "refusal") refused = true;
            else throw new Error("Unsupported content block");
          }
        } else throw new Error("Unsupported output item");
      }
      const toolUse = history.filter(
        (p): p is ToolUseContent => p.type === "tool_use",
      );
      const finishReason = refused
        ? "content_filter"
        : data.status === "incomplete"
          ? "length"
          : data.status !== "completed"
            ? "provider_error"
            : toolUse.length
              ? "tool_use"
              : "stop";
      return {
        content: history
          .flatMap((p) => (p.type === "text" ? [p.text] : []))
          .join("\n"),
        finishReason,
        historyContent: history,
        toolUse: toolUse.length ? toolUse : undefined,
        usage: billed,
        provider: this.name,
        modelId: this.modelId,
        providerId: this.providerId,
        providerRequestId: requestId,
      };
    } catch {
      throw new ChatProviderRequestError(
        "OpenAI response could not be processed",
        "billed",
        { usage: billed, providerRequestId: requestId },
      );
    }
  }
}

export class CreditFallbackProvider implements AiProvider {
  private active: AiProvider;
  private callIndex = 0;
  constructor(
    readonly primary: AiProvider,
    readonly fallback: AiProvider,
  ) {
    this.active = Date.now() < CLAUDE_API_ENDS_AT ? primary : fallback;
  }
  get name() {
    return this.active.name;
  }
  get modelId() {
    return this.active.modelId;
  }
  get providerId() {
    return this.active.providerId;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const callOptions = {
      ...options,
      billingLabel: options?.billingLabel ?? `route/${this.callIndex++}`,
    };
    if (Date.now() < CLAUDE_API_ENDS_AT) {
      try {
        this.active = this.primary;
        const result = await this.primary.chat(messages, callOptions);
        if (result.providerId === this.fallback.providerId)
          this.active = this.fallback;
        return result;
      } catch (error) {
        if (!(error instanceof ChatProviderRequestError) || !error.canFallback)
          throw error;
      }
    }
    this.active = this.fallback;
    const result = await this.fallback.chat(messages, callOptions);
    if (result.providerId === this.primary.providerId)
      this.active = this.primary;
    return result;
  }
}

export function getCreditFallbackProvider(): AiProvider {
  const mode = process.env.ANTHROPIC_AUTH_MODE ?? "api-key";
  if (mode !== "api-key" && mode !== "federation")
    throw new Error("Unsupported ANTHROPIC_AUTH_MODE");
  return new CreditFallbackProvider(
    new ClaudeProvider(
      mode === "api-key" ? (process.env.ANTHROPIC_API_KEY ?? "") : "",
      mode === "federation" ? createAnthropicFederationAuthorizer() : undefined,
    ),
    new OpenAIProvider(process.env.OPENAI_API_KEY ?? ""),
  );
}
