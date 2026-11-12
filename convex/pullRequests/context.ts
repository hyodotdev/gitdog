import type { ChatMessage } from "../_ai/model";
import type { ReadEvidence } from "./review";

type ReviewSource = ReadEvidence & { truncated?: boolean };

export function reviewContextMessage(
  metadata: Record<string, unknown>,
  sources: ReviewSource[],
): ChatMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: JSON.stringify(metadata) },
      ...sources.map((source) => ({
        type: "text" as const,
        text:
          `SOURCE ${JSON.stringify({
            path: source.path,
            ref: source.ref,
            startLine: 1,
            truncated: source.truncated ?? false,
          })}\n` + source.content,
      })),
    ],
  };
}
