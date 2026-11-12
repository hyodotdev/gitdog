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
