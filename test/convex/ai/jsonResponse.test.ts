import { describe, expect, it, vi } from "vitest";
import { parseJsonResponse, readJsonObject } from "../../../convex/_ai/utils";
import { createChatStep } from "../../../convex/_ai/workflow";
import { extractLearning } from "../../../convex/_ai/learning/extractLearning";
import type { AiProvider } from "../../../convex/_ai/model";

const fence = "```";
// A formatted issue body is Markdown, so it often carries its own fences.
const formatted = {
  title: "Calendar crashes on swipe",
  body: `## Steps\n\n${fence}dart\nCalendarCarousel(onDayPressed: (d, _) {});\n${fence}\n\nPath C:\\\\Users\\\\me and a "quote" }`,
};
const formattedJson = JSON.stringify(formatted, null, 2);

describe("readJsonObject", () => {
  it.each([
    ["plain JSON", formattedJson],
    ["a json fence around it", `${fence}json\n${formattedJson}\n${fence}`],
    ["a bare fence around it", `${fence}\n${formattedJson}\n${fence}`],
    ["prose around it", `Here is the result:\n${formattedJson}\nDone.`],
    [
      "prose with braces before its fence",
      `Formatted for {title}:\n${fence}json\n${formattedJson}\n${fence}`,
    ],
    [
      "CRLF line endings",
      `${fence}json\r\n${formattedJson.replace(/\n/g, "\r\n")}\r\n${fence}`,
    ],
  ])("reads %s without cutting at inner code fences", (_, response) => {
    expect(readJsonObject(response)).toEqual(formatted);
  });

  it("ignores prose, quotes and other fences after the object", () => {
    expect(
      readJsonObject(
        `${fence}json\n{"a": 1}\n${fence}\nSay "hi\n${fence}bash\necho \${X}\n${fence}`,
      ),
    ).toEqual({ a: 1 });
    expect(readJsonObject(`{"a": 1}\nNote: use "x {y}`)).toEqual({ a: 1 });
    expect(
      readJsonObject(`{"a": 1}\n\nExample:\n${fence}json\n{"x": 2}\n${fence}`),
    ).toEqual({ a: 1 });
  });

  it("accepts escaped single quotes and refuses anything but an object", () => {
    expect(readJsonObject(`{"a": "it\\'s"}`)).toEqual({ a: "it's" });
    expect(readJsonObject("[1, 2]")).toBeUndefined();
    expect(readJsonObject("no json here")).toBeUndefined();
    expect(readJsonObject(`${fence}json\n{"a": "cut`)).toBeUndefined();
  });
});

describe("parseJsonResponse", () => {
  it("parses fenced JSON whose strings contain fences", () => {
    expect(
      parseJsonResponse(`${fence}json\n${formattedJson}\n${fence}`),
    ).toEqual(formatted);
  });

  it("closes a cut-off object innermost first, ignoring braces in strings", () => {
    expect(
      parseJsonResponse(`${fence}json\n{"items": [{"text": "a } b \\" c`),
    ).toEqual({ items: [{ text: 'a } b " c' }] });
    expect(parseJsonResponse(`{"text": "ends in an escape \\`)).toEqual({
      text: "ends in an escape ",
    });
  });

  it("drops a dangling entry, never text inside a string", () => {
    expect(parseJsonResponse(`{"a": {"b": 1}, "c": `)).toEqual({ a: { b: 1 } });
    expect(parseJsonResponse(`{"a": 1, "ke`)).toEqual({ a: 1 });
    expect(
      parseJsonResponse(
        `{"title": "T", "body": "text } more", "labels": ["a",`,
      ),
    ).toEqual({ title: "T", body: "text } more", labels: ["a"] });
  });

  it("refuses complete but invalid JSON instead of dropping its fields", () => {
    for (const response of [
      `{"a": 1,}`,
      `{"issueType": "question", "confidence": 0.8 "relatedFiles": []}`,
      `{"labels": ["bug", "ui"}`,
      `${fence}json\n{"a": 1, "b": "x" "c": 2}\n${fence}\nSay "hi\n${fence}bash\nls\n${fence}`,
      `{"issueType": "question", "confidence": 0.8, "suggestedResponse": "Set "mode to strict.", "relatedFiles": ["a.ts"]}`,
    ])
      expect(() => parseJsonResponse(response)).toThrow(
        /Invalid JSON response from AI/,
      );
  });

  it("still refuses a response without an object", () => {
    expect(() => parseJsonResponse("I cannot help with that.")).toThrow(
      /Invalid JSON response from AI/,
    );
  });
});

describe("createChatStep", () => {
  // Every attempt is a billed request with its own Convex bookkeeping, so
  // only a response that another attempt could fix is retried.
  const run = async (content: string) => {
    const chat = vi.fn(async () => ({
      content,
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      provider: "test",
    }));
    const step = createChatStep("system", () => "user", { maxTokens: 100 });
    const result = await step(
      {},
      { aiProvider: { chat } as unknown as AiProvider, metadata: {} },
    ).catch((error: unknown) => error);
    return { result, calls: chat.mock.calls.length };
  };

  it("accepts fenced JSON with inner fences on the first attempt", async () => {
    const { result, calls } = await run(
      `${fence}json\n${formattedJson}\n${fence}`,
    );
    expect(calls).toBe(1);
    expect(parseJsonResponse(result as string)).toEqual(formatted);
  });

  it.each([
    `{"a": 1,}`,
    `{"labels": ["bug", "ui"}`,
    `${fence}json\n{"a": 1,}\n${fence}\nSee "docs [here`,
    `${fence}json\n{"a": 1,}\n${fence}\nSay "hi\n${fence}bash\nls\n${fence}`,
    `{"a": 1 "b": 2}\nNote: use "x {y}`,
  ])("does not retry complete but invalid JSON: %s", async (content) => {
    expect(await run(content)).toEqual({ result: content, calls: 1 });
  });

  it("retries a cut-off object or a response without one", async () => {
    for (const content of [`{"a": "cut`, "Sorry, I can't."]) {
      const { result, calls } = await run(content);
      expect(calls).toBe(3);
      expect(result).toMatchObject({
        message: "AI response JSON appears incomplete",
      });
    }
  });
});

describe("extractLearning", () => {
  it("reads a learning whose text holds a code fence", async () => {
    const learning = `Prefer ${fence}ts\nawait ctx.runQuery(...)\n${fence} over direct reads.`;
    const chat = vi.fn(async () => ({
      content: `${fence}json\n${JSON.stringify({ hasLearning: true, learning, confidence: 0.9 })}\n${fence}`,
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      provider: "test",
    }));
    const { result } = await extractLearning({
      userMessage: "Use runQuery here.",
      provider: { chat } as unknown as AiProvider,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ hasLearning: true, learning });
  });
});
