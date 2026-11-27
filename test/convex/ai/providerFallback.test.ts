import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_API_ENDS_AT } from "../../../convex/_ai/config";
import {
  ClaudeProvider,
  OpenAIProvider,
  CreditFallbackProvider,
} from "../../../convex/_ai/providers";
import { ChatProviderRequestError } from "../../../convex/_ai/providerErrors";
import type { ChatMessage } from "../../../convex/_ai/model";
import { reviewContextMessage } from "../../../convex/pullRequests/context";
import { declineFallback } from "../../../convex/_ai/providerResolution";

const messages: ChatMessage[] = [
  { role: "system", content: "Be precise" },
  { role: "user", content: "Question" },
];
function claude(body: Record<string, unknown> = {}) {
  return Response.json(
    {
      content: [{ type: "text", text: "Claude answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 4 },
      ...body,
    },
    { headers: { "request-id": "claude-1" } },
  );
}
function openai(body: Record<string, unknown> = {}) {
  return Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "OpenAI answer" }],
      },
    ],
    usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
    ...body,
  });
}
function router() {
  return new CreditFallbackProvider(
    new ClaudeProvider("claude-test-key"),
    new OpenAIProvider("openai-test-key"),
  );
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(CLAUDE_API_ENDS_AT - 1000);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("credit fallback and exclusive Claude deadline", () => {
  it("forwards exact review source text blocks to both providers", async () => {
    const source = 'function read() {\r\n\treturn "quoted \\\\ path 😀";\r\n}';
    const context = reviewContextMessage({ repository: "owner/repo" }, [
      { path: "src/service.ts", ref: "head", content: source },
    ]);
    const reviewMessages: ChatMessage[] = [messages[0], context];
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(claude())
      .mockResolvedValueOnce(openai());
    await new ClaudeProvider("fixture-key").chat(reviewMessages);
    await new OpenAIProvider("fixture-key").chat(reviewMessages);
    const claudeBody = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    const openaiBody = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(claudeBody.messages[0].content).toEqual(context.content);
    expect(
      openaiBody.input.map((item: { content: string }) => item.content),
    ).toEqual(
      (context.content as Array<{ type: "text"; text: string }>).map(
        ({ text }) => text,
      ),
    );
    expect(claudeBody.messages[0].content[1].text.endsWith(source)).toBe(true);
    expect(openaiBody.input[1].content.endsWith(source)).toBe(true);
  });
  it("requests schema-constrained JSON for both providers at the configured review effort", async () => {
    const responseFormat = {
      name: "review_result",
      schema: {
        type: "object",
        properties: { findings: { type: "array", items: { type: "string" } } },
        required: ["findings"],
        additionalProperties: false,
      },
    };
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(claude())
      .mockResolvedValueOnce(openai());
    await new ClaudeProvider("fixture-key").chat(messages, { responseFormat });
    await new OpenAIProvider("fixture-key").chat(messages, { responseFormat });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: responseFormat.schema },
      },
    });
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toMatchObject({
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "review_result",
          strict: true,
          schema: responseFormat.schema,
        },
      },
    });
  });
  it("uses Claude first and returns exact provider usage", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(claude());
    const provider = router();
    expect(await provider.chat(messages)).toMatchObject({
      content: "Claude answer",
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(provider.providerId).toBe("anthropic");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      model: "claude-opus-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
  });

  it.each([
    [
      400,
      {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API.",
      },
    ],
    [402, { type: "billing_error", message: "Credit balance exhausted" }],
    [
      400,
      {
        type: "invalid_request_error",
        message: "You have reached your specified API usage limits",
      },
    ],
    [
      400,
      {
        type: "invalid_request_error",
        message: "You have reached your specified workspace API usage limits",
      },
    ],
    [
      429,
      {
        type: "rate_limit_error",
        details: { error_code: "enforced_spend_limit_reached" },
      },
    ],
    [429, { type: "rate_limit_error", message: "Monthly spend cap reached" }],
    [
      400,
      {
        type: "invalid_request_error",
        message: "Organization spend limit reached",
      },
    ],
  ])(
    "falls back on confirmed non-billed credit rejection %i",
    async (status, error) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json({ error }, { status: status as number }),
        )
        .mockResolvedValueOnce(openai());
      const provider = router();
      expect((await provider.chat(messages)).content).toBe("OpenAI answer");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(provider.providerId).toBe("openai");
      const body = JSON.parse(fetch.mock.calls[1][1]!.body as string);
      expect(body).toMatchObject({
        model: "gpt-6.2-sol",
        store: false,
        reasoning: { effort: "high" },
        include: ["reasoning.encrypted_content"],
        instructions: "Be precise",
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
      });
    },
  );

  it("checks the deadline again immediately before dispatch", async () => {
    vi.mocked(Date.now)
      .mockReturnValueOnce(CLAUDE_API_ENDS_AT - 1)
      .mockReturnValue(CLAUDE_API_ENDS_AT);
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      new ClaudeProvider("test").chat(messages),
    ).rejects.toMatchObject({
      billingOutcome: "not_billed",
      canFallback: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([-1, 0, 1])(
    "enforces the deadline at offset %i milliseconds",
    async (offset) => {
      vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT + offset);
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url) =>
          String(url).includes("anthropic") ? claude() : openai(),
        );
      await router().chat(messages);
      expect(fetch.mock.calls[0][0]).toBe(
        offset < 0
          ? "https://api.anthropic.com/v1/messages"
          : "https://api.openai.com/v1/responses",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("rechecks the deadline on an already-created provider and direct Claude calls", async () => {
    const provider = router();
    vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(openai());
    await expect(
      new ClaudeProvider("test").chat(messages),
    ).rejects.toMatchObject({ billingOutcome: "not_billed" });
    await provider.chat(messages);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("api.openai.com");
    expect(new Date(CLAUDE_API_ENDS_AT).toISOString()).toBe(
      "2027-01-17T15:00:00.000Z",
    );
  });

  it.each([400, 401, 403, 429, 503])(
    "does not hide ordinary errors or ambiguous billing (HTTP %i)",
    async (status) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          Response.json(
            { error: { type: "rate_limit_error", message: "Retry later" } },
            { status },
          ),
        );
      await expect(router().chat(messages)).rejects.toBeInstanceOf(
        ChatProviderRequestError,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("never falls back after a network failure or missing usage metadata", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network failure"));
    await expect(router().chat(messages)).rejects.toMatchObject({
      billingOutcome: "ambiguous",
    });
    fetch.mockResolvedValueOnce(claude({ usage: null }));
    await expect(router().chat(messages)).rejects.toMatchObject({
      billingOutcome: "ambiguous",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses OpenAI when no Claude key is configured and retries Claude on a later request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(openai());
    await new CreditFallbackProvider(
      new ClaudeProvider(""),
      new OpenAIProvider("test"),
    ).chat(messages);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch
      .mockClear()
      .mockResolvedValueOnce(
        Response.json({ error: { type: "billing_error" } }, { status: 402 }),
      )
      .mockResolvedValueOnce(openai())
      .mockResolvedValueOnce(claude());
    const provider = router();
    await provider.chat(messages);
    await provider.chat(messages);
    expect(provider.providerId).toBe("anthropic");
    expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://api.anthropic.com/v1/messages",
      "https://api.openai.com/v1/responses",
      "https://api.anthropic.com/v1/messages",
    ]);
  });

  it("stops when OpenAI credit is exhausted", async () => {
    vi.mocked(Date.now).mockReturnValue(CLAUDE_API_ENDS_AT);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { error: { code: "credit_balance_exhausted" } },
          { status: 429 },
        ),
      );
    await expect(router().chat(messages)).rejects.toMatchObject({
      billingOutcome: "not_billed",
      canFallback: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("replays Sol encrypted reasoning across tool turns and excludes it from Claude", async () => {
  const reasoning = {
    type: "reasoning",
    id: "rs_test",
    encrypted_content: "opaque-state",
    summary: [],
  };
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      openai({
        output: [
          reasoning,
          {
            type: "message",
            phase: "commentary",
            content: [{ type: "output_text", text: "Checking the file." }],
          },
          {
            type: "function_call",
            call_id: "call_test",
            name: "read_file",
            arguments: '{"path":"a"}',
          },
        ],
      }),
    )
    .mockResolvedValueOnce(openai())
    .mockResolvedValueOnce(claude());
  const provider = new OpenAIProvider("test");
  const first = await provider.chat(messages);
  expect(first.finishReason).toBe("tool_use");
  const continuation: ChatMessage[] = [
    ...messages,
    { role: "assistant", content: first.historyContent! },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_test",
          content: "file contents",
        },
      ],
    },
  ];
  await provider.chat(continuation);
  const secondBody = JSON.parse(fetch.mock.calls[1][1]!.body as string);
  expect(secondBody.input.slice(-4)).toEqual([
    reasoning,
    { role: "assistant", phase: "commentary", content: "Checking the file." },
    {
      type: "function_call",
      call_id: "call_test",
      name: "read_file",
      arguments: '{"path":"a"}',
    },
    {
      type: "function_call_output",
      call_id: "call_test",
      output: "file contents",
    },
  ]);
  await new ClaudeProvider("test").chat(continuation);
  expect(fetch.mock.calls[2][1]!.body).not.toContain("opaque-state");
  expect(fetch.mock.calls[2][1]!.body).not.toContain('"phase"');
});

it("retains verified billed usage when encrypted reasoning is malformed", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    openai({
      output: [{ type: "reasoning", id: "rs_test", summary: [] }],
    }),
  );
  await expect(new OpenAIProvider("test").chat(messages)).rejects.toMatchObject(
    {
      billingOutcome: "billed",
      usage: { totalTokens: 14 },
    },
  );
});

describe("provider tool protocols and usage validation", () => {
  it("preserves Claude signed thinking and tools in subsequent turns", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        claude({
          content: [
            {
              type: "thinking",
              thinking: "private reasoning",
              signature: "signed",
            },
            {
              type: "tool_use",
              id: "tool_1",
              name: "read_file",
              input: { path: "a.ts" },
            },
          ],
          stop_reason: "tool_use",
        }),
      )
      .mockResolvedValueOnce(claude());
    const provider = new ClaudeProvider("test");
    const response = await provider.chat(messages);
    expect(response.content).toBe("");
    expect(response.toolUse?.[0].name).toBe("read_file");
    await provider.chat([
      ...messages,
      { role: "assistant", content: response.historyContent! },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool_1", content: "source" },
        ],
      },
    ]);
    const body = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(body.messages[1].content[0]).toEqual({
      type: "thinking",
      thinking: "private reasoning",
      signature: "signed",
    });
    expect(body.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tool_1",
    });
  });

  it("translates Claude tool history for OpenAI without sending signed thinking", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      openai({
        output: [
          {
            type: "function_call",
            call_id: "next_call",
            name: "search",
            arguments: '{"query":"a"}',
          },
        ],
      }),
    );
    const result = await new OpenAIProvider("test").chat([
      ...messages,
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "private",
            signature: "secret-signature",
          },
          {
            type: "tool_use",
            id: "tool_1",
            name: "read_file",
            input: { path: "a" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool_1", content: "source" },
        ],
      },
    ]);
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.input.slice(-2)).toEqual([
      {
        type: "function_call",
        call_id: "tool_1",
        name: "read_file",
        arguments: '{"path":"a"}',
      },
      { type: "function_call_output", call_id: "tool_1", output: "source" },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret-signature");
    expect(result).toMatchObject({
      finishReason: "tool_use",
      toolUse: [{ id: "next_call", name: "search", input: { query: "a" } }],
    });
  });

  it("preserves billed usage on malformed tools but fails closed on inconsistent counts", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      openai({
        output: [
          {
            type: "function_call",
            call_id: "call",
            name: "search",
            arguments: "invalid json",
          },
        ],
      }),
    );
    await expect(
      new OpenAIProvider("test").chat(messages),
    ).rejects.toMatchObject({
      billingOutcome: "billed",
      usage: { totalTokens: 14 },
    });
    fetch.mockResolvedValueOnce(
      openai({
        usage: { input_tokens: 11, output_tokens: -1, total_tokens: 10 },
      }),
    );
    await expect(
      new OpenAIProvider("test").chat(messages),
    ).rejects.toMatchObject({ billingOutcome: "ambiguous" });
  });
});

it.each([
  { input_tokens: 11, output_tokens: 3, total_tokens: 99 },
  {
    input_tokens: 11,
    output_tokens: 3,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 8, cache_write_tokens: 4 },
  },
  {
    input_tokens: 11,
    output_tokens: 3,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: -1 },
  },
])(
  "holds inconsistent cached usage instead of charging the wrong amount",
  async (counts) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(openai({ usage: counts }));
    await expect(
      new OpenAIProvider("test").chat(messages),
    ).rejects.toMatchObject({ billingOutcome: "ambiguous" });
  },
);

it("waits as long as a request asks before giving up", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(openai())
    .mockResolvedValueOnce(openai())
    .mockResolvedValueOnce(claude());
  await new OpenAIProvider("test").chat(messages);
  await new OpenAIProvider("test").chat(messages, { timeoutMs: 240_000 });
  await new ClaudeProvider("fixture-key").chat(messages, {
    timeoutMs: 240_000,
  });
  expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([
    120_000, 240_000, 240_000,
  ]);
  // An end time shortens the wait, and too little time sends nothing.
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(openai());
  await new OpenAIProvider("test").chat(messages, {
    timeoutMs: 240_000,
    endBy: Date.now() + 100_000,
  });
  expect(timeout.mock.calls.at(-1)?.[0]).toBeLessThanOrEqual(100_000);
  const sent = vi.mocked(globalThis.fetch).mock.calls.length;
  await expect(
    new OpenAIProvider("test").chat(messages, { endBy: Date.now() + 10_000 }),
  ).rejects.toMatchObject({ billingOutcome: "not_billed" });
  // A slow request asks for more time to be left.
  await expect(
    new OpenAIProvider("test").chat(messages, {
      endBy: Date.now() + 60_000,
      minTimeMs: 90_000,
    }),
  ).rejects.toMatchObject({ billingOutcome: "not_billed" });
  expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(sent);
});

it("bills OpenAI cache usage as the input it costs", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    openai({
      usage: {
        input_tokens: 3_000,
        output_tokens: 10,
        total_tokens: 3_010,
        input_tokens_details: {
          cache_write_tokens: 1_000,
          cached_tokens: 1_000,
        },
      },
    }),
  );
  // 1,000 uncached, 1,000 written at 1.25x and 1,000 read at 0.05x.
  expect(await new OpenAIProvider("test").chat(messages)).toMatchObject({
    usage: { promptTokens: 2_300, completionTokens: 10, totalTokens: 2_310 },
  });
  // A prompt that is all cache writes and reads, with null details elsewhere.
  vi.mocked(globalThis.fetch).mockResolvedValue(
    openai({
      usage: {
        input_tokens: 2_000,
        output_tokens: 1,
        total_tokens: 2_001,
        input_tokens_details: {
          cache_write_tokens: 1_000,
          cached_tokens: 1_000,
        },
        output_tokens_details: null,
      },
    }),
  );
  expect(await new OpenAIProvider("test").chat(messages)).toMatchObject({
    usage: { promptTokens: 1_300 },
  });
});

it("counts reasoning-effort reasoning inside output usage exactly once", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    openai({
      usage: {
        input_tokens: 100,
        output_tokens: 3000,
        total_tokens: 3100,
        output_tokens_details: { reasoning_tokens: 2800 },
      },
    }),
  );
  const result = await new OpenAIProvider("fixture-key").chat(messages, {
    maxTokens: 16384,
  });
  expect(result.usage).toEqual({
    promptTokens: 100,
    completionTokens: 3000,
    totalTokens: 3100,
  });
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
    reasoning: { effort: "high" },
    max_output_tokens: 16384,
  });
});

describe("Claude safety refusals", () => {
  it("asks for Anthropic's recommended fallback on a policy decline", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(claude());
    await new ClaudeProvider("fixture-key").chat(messages);
    const init = fetch.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)["anthropic-beta"]).toBe(
      "server-side-fallback-2026-07-01",
    );
    expect(JSON.parse(init.body as string).fallbacks).toBe("default");
  });
  it("reads the fallback model's answer and bills the attempt that produced it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      claude({
        model: "claude-opus-4-8",
        content: [
          {
            type: "fallback",
            from: { model: "claude-opus-5-5" },
            to: { model: "claude-opus-4-8" },
          },
          { type: "text", text: "Fallback answer" },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          iterations: [
            { type: "message", input_tokens: 10, output_tokens: 0 },
            { type: "fallback_message", input_tokens: 10, output_tokens: 4 },
          ],
        },
      }),
    );
    const result = await new ClaudeProvider("fixture-key").chat(messages);
    expect(result.content).toBe("Fallback answer");
    expect(result).toMatchObject({
      modelId: "claude-opus-5-5",
      servedModelId: "claude-opus-4-8",
    });
    expect(result.historyContent).toEqual([
      { type: "text", text: "Fallback answer" },
    ]);
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    });
  });
  it("runs an owner's own key on the model and effort they chose", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(
      claude({ content: [{ type: "text", text: "ok" }] }),
    );
    const provider = new ClaudeProvider("fixture-key", undefined, {
      enforceAccessDeadline: false,
      model: {
        modelId: "claude-haiku-5-5",
        name: "Claude Haiku 5.5",
        effort: "low",
      },
    });
    expect(provider.modelId).toBe("claude-haiku-5-5");
    await provider.chat(messages);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      model: "claude-haiku-5-5",
      output_config: { effort: "low" },
    });
  });
  it("reports the serving model of a sticky fallback turn", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(
      claude({
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "Sticky answer" }],
      }),
    );
    expect(
      await new ClaudeProvider("fixture-key").chat(messages),
    ).toMatchObject({ servedModelId: "claude-opus-4-8" });
    fetch.mockResolvedValueOnce(
      claude({
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Primary answer" }],
      }),
    );
    expect(
      await new ClaudeProvider("fixture-key").chat(messages),
    ).not.toHaveProperty("servedModelId");
  });
  it("caches the prompt and bills cached tokens as the input they cost", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      claude({
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_creation_input_tokens: 1_000,
          cache_read_input_tokens: 20_000,
        },
      }),
    );
    // Writes count 1.25x and Opus 5.5 reads 0.05x: 10 + 1,250 + 1,000.
    expect(
      await new ClaudeProvider("fixture-key").chat(messages),
    ).toMatchObject({
      usage: { promptTokens: 2_260, completionTokens: 4, totalTokens: 2_264 },
    });
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty("cache_control");
    expect(body.system).toEqual([
      {
        type: "text",
        text: "Be precise",
        cache_control: { type: "ephemeral" },
      },
    ]);
    // A block the caller marks ends a cached prefix.
    fetch.mockResolvedValueOnce(claude());
    await new ClaudeProvider("fixture-key").chat([
      messages[0],
      {
        role: "user",
        content: [
          { type: "text", text: "Repository context", cache: true },
          { type: "text", text: "Turn state" },
        ],
      },
    ]);
    expect(
      JSON.parse(fetch.mock.calls[1][1]!.body as string).messages[0].content,
    ).toEqual([
      {
        type: "text",
        text: "Repository context",
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: "Turn state" },
    ]);
    // A fallback model reads at the default 0.1x and rounds up.
    fetch.mockResolvedValueOnce(
      claude({
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 15,
        },
      }),
    );
    expect(
      await new ClaudeProvider("fixture-key").chat(messages),
    ).toMatchObject({ usage: { promptTokens: 3 } });
    fetch.mockResolvedValueOnce(
      claude({
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: -1,
        },
      }),
    );
    await expect(
      new ClaudeProvider("fixture-key").chat(messages),
    ).rejects.toMatchObject({ billingOutcome: "ambiguous" });
  });
  it("reports a decline with its category instead of a processing failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      claude({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber" },
        usage: { input_tokens: 18550, output_tokens: 0 },
      }),
    );
    const error = await new ClaudeProvider("fixture-key")
      .chat(messages)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatProviderRequestError);
    // A cyber decline before any output is not billed.
    expect(error).toMatchObject({
      message: "Claude declined the request",
      billingOutcome: "not_billed",
      refusal: "cyber",
    });
    expect((error as ChatProviderRequestError).usage).toBeUndefined();
  });
  it("keeps only a short identifier as a decline category", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      claude({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber\n\n@someone" },
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    );
    await expect(
      new ClaudeProvider("fixture-key").chat(messages),
    ).rejects.toMatchObject({ refusal: "unknown" });
  });
  it("bills a decline in a billed category or after output", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const [category, output, outcome] of [
      ["reasoning_extraction", 0, "billed"],
      [null, 0, "not_billed"],
      ["general_harms", 7, "billed"],
    ] as const) {
      fetch.mockResolvedValueOnce(
        claude({
          content: [],
          stop_reason: "refusal",
          stop_details: category === null ? null : { category },
          usage: { input_tokens: 100, output_tokens: output },
        }),
      );
      await expect(
        new ClaudeProvider("fixture-key").chat(messages),
      ).rejects.toMatchObject({
        billingOutcome: outcome,
        refusal: category ?? "unknown",
      });
    }
  });
  it("keeps only the served attempt's content after a fallback boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      claude({
        content: [
          { type: "thinking", thinking: "", signature: "declined" },
          { type: "text", text: "partial" },
          {
            type: "fallback",
            from: { model: "claude-opus-5-5" },
            to: { model: "claude-opus-4-8" },
          },
          { type: "text", text: "Served" },
        ],
      }),
    );
    const result = await new ClaudeProvider("fixture-key").chat(messages);
    expect(result.historyContent).toEqual([{ type: "text", text: "Served" }]);
  });
  it("offers OpenAI for a declined request only after Claude", () => {
    const claudeFirst = new ClaudeProvider("fixture-key");
    const openaiSecond = new OpenAIProvider("fixture-key");
    expect(
      declineFallback(new CreditFallbackProvider(claudeFirst, openaiSecond)),
    ).toBe(openaiSecond);
    // One key runs alone, and an OpenAI-first owner reached Claude only
    // because their OpenAI key already failed.
    expect(declineFallback(claudeFirst)).toBeUndefined();
    expect(
      declineFallback(new CreditFallbackProvider(openaiSecond, claudeFirst)),
    ).toBeUndefined();
  });
});
