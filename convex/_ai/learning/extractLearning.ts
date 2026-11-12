/**
 * Learning extraction from user interactions
 */

import type { AiProvider } from "../model";
import { LEARNING_EXTRACTION_PROMPT, LINK_SUMMARY_PROMPT } from "./prompts";
import {
  extractUrls,
  fetchLinkContent,
  isGitHubCommentUrl,
} from "./fetchLinkContent";

export interface LearningExtractionResult {
  hasLearning: boolean;
  learning: string | null;
  confidence: number;
  sourceType: "comment" | "link" | "correction";
}

export interface ExtractLearningOptions {
  userMessage: string;
  previousResponse?: string;
  githubToken?: string;
  beforeProviderCall?: () => Promise<void>;
  provider: AiProvider;
}

/**
 * Summarize linked content using AI
 */
async function summarizeLinkContent(
  content: string,
  provider: AiProvider,
  billingLabel: string,
  beforeProviderCall?: () => Promise<void>,
): Promise<{
  summary: string;
  usage?: { promptTokens: number; completionTokens: number };
}> {
  const prompt = LINK_SUMMARY_PROMPT.replace("{content}", content);

  await beforeProviderCall?.();
  const result = await provider.chat([{ role: "user", content: prompt }], {
    maxTokens: 500,
    temperature: 0.3,
    billingLabel,
  });

  return {
    summary: result.content || content.substring(0, 500),
    usage: result.usage
      ? {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
        }
      : undefined,
  };
}

/**
 * Extract JSON from AI response, handling markdown code blocks
 */
function extractJsonFromResponse(content: string): string {
  // Use regex to find JSON block regardless of position in response
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  return (jsonMatch ? jsonMatch[1] : content).trim();
}

/**
 * Extract learning from a user message
 */
export async function extractLearning(
  options: ExtractLearningOptions,
): Promise<{
  result: LearningExtractionResult;
  usage?: { promptTokens: number; completionTokens: number };
  linkSummaryUsage?: { promptTokens: number; completionTokens: number };
}> {
  const provider = options.provider;

  // Check for links in the message
  const urls = extractUrls(options.userMessage);
  const githubUrls = urls.filter(isGitHubCommentUrl);

  let linkedContentSummary = "";
  const linkSummaryUsage = { promptTokens: 0, completionTokens: 0 };

  // Fetch and summarize linked content
  if (githubUrls.length > 0 && options.githubToken) {
    const linkContents: string[] = [];

    for (const [index, url] of githubUrls.slice(0, 3).entries()) {
      // Limit to 3 links
      const { content } = await fetchLinkContent(url, options.githubToken);
      if (content) {
        const { summary, usage } = await summarizeLinkContent(
          content,
          provider,
          `learning-link/${index}`,
          options.beforeProviderCall,
        );
        linkContents.push(`[From ${url}]: ${summary}`);
        if (usage) {
          linkSummaryUsage.promptTokens += usage.promptTokens;
          linkSummaryUsage.completionTokens += usage.completionTokens;
        }
      }
    }

    if (linkContents.length > 0) {
      linkedContentSummary = linkContents.join("\n\n");
    }
  }

  // Build the prompt
  const prompt = LEARNING_EXTRACTION_PROMPT.replace(
    "{userMessage}",
    options.userMessage,
  )
    .replace("{previousResponse}", options.previousResponse || "(none)")
    .replace("{linkedContent}", linkedContentSummary || "(none)");

  await options.beforeProviderCall?.();
  const result = await provider.chat([{ role: "user", content: prompt }], {
    maxTokens: 500,
    temperature: 0.3,
    billingLabel: "learning-extract",
  });

  // Parse the JSON response
  try {
    const jsonStr = extractJsonFromResponse(result.content);
    const parsed = JSON.parse(jsonStr) as LearningExtractionResult;

    return {
      result: {
        hasLearning: parsed.hasLearning && parsed.confidence >= 0.7,
        learning: parsed.learning,
        confidence: parsed.confidence,
        sourceType: linkedContentSummary
          ? "link"
          : parsed.sourceType || "comment",
      },
      usage: result.usage
        ? {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
          }
        : undefined,
      linkSummaryUsage:
        linkSummaryUsage.promptTokens > 0 ? linkSummaryUsage : undefined,
    };
  } catch {
    console.error("[extractLearning] Failed to parse response");
    return {
      result: {
        hasLearning: false,
        learning: null,
        confidence: 0,
        sourceType: "comment",
      },
      usage: result.usage
        ? {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
          }
        : undefined,
      linkSummaryUsage:
        linkSummaryUsage.promptTokens > 0 ? linkSummaryUsage : undefined,
    };
  }
}

/**
 * Check if a message might contain a teaching (quick heuristic check)
 * Used to avoid unnecessary AI calls
 */
export function mightContainTeaching(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  // Teaching indicators
  const teachingPatterns = [
    // English
    "always",
    "never",
    "don't",
    "do not",
    "should",
    "must",
    "prefer",
    "instead",
    "correct",
    "wrong",
    "actually",
    "in this repo",
    "in this project",
    "we use",
    "we call",
    "convention",
    "guideline",
    "remember",
    "note that",
    "fyi",
    "for future",
    // Korean
    "항상",
    "절대",
    "하지마",
    "하지 마",
    "해줘",
    "해 줘",
    "이렇게",
    "저렇게",
    "틀렸",
    "아니야",
    "아니",
    "맞아",
    "우리는",
    "이 프로젝트",
    "이 레포",
    "규칙",
    "컨벤션",
    "참고",
    "기억",
    // Links (high signal for teaching)
    "github.com",
    "http",
  ];

  return teachingPatterns.some((pattern) => lowerMessage.includes(pattern));
}
