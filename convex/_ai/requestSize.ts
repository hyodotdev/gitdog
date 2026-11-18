import type { ChatCompletionOptions, ChatMessage } from "./model";

export function chatRequestBytes(
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): number {
  const serialized = JSON.stringify({
    messages,
    tools: options?.tools ?? [],
    ...(options?.responseFormat
      ? { responseFormat: options.responseFormat }
      : {}),
  });
  return new TextEncoder().encode(serialized).byteLength + 1024;
}

/**
 * The size of the longest prefix a request can write to the prompt cache: the
 * tools and system prompt, which are always a breakpoint, through the last
 * text part a caller marked.
 */
export function cachedPrefixBytes(
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): number {
  let end: { message: number; part: number } | undefined;
  messages.forEach((message, index) => {
    if (typeof message.content === "string") return;
    message.content.forEach((part, partIndex) => {
      if (part.type === "text" && part.cache)
        end = { message: index, part: partIndex };
    });
  });
  const prefix = end
    ? [
        ...messages.slice(0, end.message),
        {
          ...messages[end.message],
          content: (
            messages[end.message].content as Exclude<
              ChatMessage["content"],
              string
            >
          ).slice(0, end.part + 1),
        },
      ]
    : messages.filter((m) => m.role === "system");
  return new TextEncoder().encode(
    JSON.stringify({ messages: prefix, tools: options?.tools ?? [] }),
  ).byteLength;
}
