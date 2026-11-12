import type { ChatMessage } from "../../../convex/_ai/model";
import type { ReadEvidence } from "../../../convex/pullRequests/review";

export function inspectReviewContext(messages: ChatMessage[]) {
  const parts = messages[1].content;
  if (!Array.isArray(parts) || parts[0]?.type !== "text")
    throw new Error("Expected metadata and source text blocks");
  const metadataText = parts[0].text;
  const sources = parts.slice(1).map((part) => {
    if (part.type !== "text" || !part.text.startsWith("SOURCE "))
      throw new Error("Expected an exact source text block");
    const newline = part.text.indexOf("\n");
    const header = JSON.parse(part.text.slice(7, newline)) as {
      path: string;
      ref: "head" | "base";
      startLine: number;
      truncated: boolean;
    };
    if (header.startLine !== 1) throw new Error("Unexpected source offset");
    return {
      path: header.path,
      ref: header.ref,
      truncated: header.truncated,
      content: part.text.slice(newline + 1),
    };
  });
  return { metadataText, sources };
}

export function reviewState(messages: ChatMessage[]) {
  const { metadataText, sources } = inspectReviewContext(messages);
  const metadata = JSON.parse(metadataText);
  return {
    ...metadata,
    baseRepositoryContext: sources.filter((source) => source.ref === "base"),
    headImplementationContext: sources
      .filter((source) => source.ref === "head")
      .map(({ path, ref, content }): ReadEvidence => ({ path, ref, content })),
    inspectedSource: sources,
  };
}
