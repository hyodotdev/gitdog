import type { ChatMessage } from "../../../convex/_ai/model";
import type { ReadEvidence } from "../../../convex/pullRequests/review";

function mergeState(
  context: Record<string, unknown>,
  state: Record<string, unknown>,
) {
  const { addedLineAnchors, ...rest } = state as {
    addedLineAnchors?: Record<string, unknown>;
  };
  return {
    ...context,
    ...rest,
    ...(Array.isArray(context.changedFiles)
      ? {
          changedFiles: context.changedFiles.map(
            (file: Record<string, unknown>) =>
              addedLineAnchors && String(file.filename) in addedLineAnchors
                ? {
                    ...file,
                    addedLineAnchors: addedLineAnchors[String(file.filename)],
                  }
                : file,
          ),
        }
      : {}),
  };
}

export function inspectReviewContext(messages: ChatMessage[]) {
  const parts = messages[1].content;
  if (!Array.isArray(parts) || parts[0]?.type !== "text")
    throw new Error("Expected metadata and source text blocks");
  // A cached review context ends with the state of the current turn.
  const last = parts.at(-1);
  const trailing =
    parts.length > 1 &&
    last?.type === "text" &&
    !last.text.startsWith("SOURCE ")
      ? last.text
      : undefined;
  const metadataText = trailing
    ? JSON.stringify(
        mergeState(JSON.parse(parts[0].text), JSON.parse(trailing)),
      )
    : parts[0].text;
  const sources = parts.slice(1, trailing ? -1 : undefined).map((part) => {
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
