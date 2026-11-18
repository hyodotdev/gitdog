import type { ChatMessage, TextContent } from "../_ai/model";
import type { ReadEvidence } from "./review";

type ReviewSource = ReadEvidence & { truncated?: boolean };

// Review state that changes between the turns of one review.
const TURN_STATE_KEYS = new Set([
  "uninspectedChangedPaths",
  "incompleteGuidePaths",
  "additionalGuideCount",
  "unavailableContextPaths",
  "excludedPaths",
  "recentToolResults",
  "omittedToolResultCount",
  "validationFeedback",
]);

function sourceBlock(source: ReviewSource) {
  return {
    type: "text" as const,
    text:
      `SOURCE ${JSON.stringify({
        path: source.path,
        ref: source.ref,
        startLine: 1,
        truncated: source.truncated ?? false,
      })}\n` + source.content,
  };
}

/**
 * The review context as one user message. With `cached`, the repository
 * context and the sources come first and end at a prompt cache breakpoint,
 * and the state that changes from turn to turn comes last, so each turn of a
 * review reads everything shown on earlier turns from the cache.
 */
export function reviewContextMessage(
  metadata: Record<string, unknown>,
  sources: ReviewSource[],
  options: { cached?: boolean } = {},
): ChatMessage {
  if (!options.cached)
    return {
      role: "user",
      content: [
        { type: "text", text: JSON.stringify(metadata) },
        ...sources.map(sourceBlock),
      ],
    };
  const context: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (TURN_STATE_KEYS.has(key)) state[key] = value;
    else if (key === "changedFiles" && Array.isArray(value)) {
      // Line anchors follow the head sources shown so far.
      const anchors: Record<string, unknown> = {};
      context.changedFiles = value.map((file: Record<string, unknown>) => {
        const { addedLineAnchors, ...rest } = file;
        if (addedLineAnchors !== undefined && typeof rest.filename === "string")
          anchors[rest.filename] = addedLineAnchors;
        return rest;
      });
      state.addedLineAnchors = anchors;
    } else context[key] = value;
  }
  const blocks: TextContent[] = [
    { type: "text", text: JSON.stringify(context) },
    ...sources.map(sourceBlock),
  ];
  // A cache read looks back at most 20 blocks for an earlier entry, so a turn
  // that shows many sources at once gets a second breakpoint before them.
  const marks =
    blocks.length > 20
      ? [blocks.length - 20, blocks.length - 1]
      : [blocks.length - 1];
  for (const index of marks) blocks[index] = { ...blocks[index], cache: true };
  return {
    role: "user",
    content: [...blocks, { type: "text", text: JSON.stringify(state) }],
  };
}
