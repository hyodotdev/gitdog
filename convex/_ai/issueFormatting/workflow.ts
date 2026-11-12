import type { AiProvider } from "../model";
import { Workflow, createChatStep } from "../workflow";
import { parseJsonResponse } from "../utils";
import type { IssueFormattingResult, IssueFormattingInput } from "./types";
import {
  ISSUE_FORMATTING_SYSTEM_PROMPT,
  createIssueFormattingUserPrompt,
} from "./prompts";

const MAX_GITHUB_ISSUE_TITLE_LENGTH = 256;
const MAX_GITHUB_ISSUE_BODY_LENGTH = 65_536;
const MAX_FORMATTING_METADATA_LENGTH = 4_000;
const SAFE_ADDED_FACTS = new Set([
  "api",
  "bug",
  "fr",
  "github",
  "http",
  "https",
  "id",
  "json",
  "os",
  "question",
  "sdk",
  "ui",
  "url",
  "xml",
  "yaml",
]);

const PROTECTED_FACT_PATTERNS = [
  /https?:\/\/[^\s<>)\]]+/gi,
  /@[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*/g,
  /\b(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+\b/g,
  /\b[A-Za-z_$][\w$]*(?:\(\))?(?:\.[A-Za-z_$][\w$]*(?:\(\))?)+/g,
  /\b[A-Za-z_$][\w$]*\(\)/g,
  /\b(?:[a-z][\w$]*[A-Z][\w$]*|[A-Z][a-z0-9]+[A-Z][\w$]*)\b/g,
  /\b[A-Z][A-Z0-9_]{1,}\b/g,
  /\bv?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?\b/gi,
  /\b\d+\b/g,
  /\b(?:Android|iOS|iPadOS|macOS|tvOS|watchOS|visionOS|Windows|Linux|React\s+Native|Flutter|Kotlin|Swift|TypeScript|JavaScript|StoreKit|Firebase|Stripe)\b/g,
];

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifiesFeatureRequest(issue: IssueFormattingInput): boolean {
  const bodyIdentifiesFeatureRequest =
    /\b(?:feature\s+(?:request|proposal)|request(?:ed|ing)?\s+(?:a\s+)?(?:new\s+)?(?:api|feature|integration|support)|describe\s+the\s+(?:feature|solution)\s+(?:you|you'd|you\s+would)\s+(?:like|want))\b/i.test(
      issue.body,
    ) &&
    !/\b(?:is\s+not|isn'?t|not)\s+(?:an?\s+)?feature\s+request\b/i.test(
      issue.body,
    );

  return (
    /^\s*\[(?:fr|feature(?:\s+request)?)\]/i.test(issue.title) ||
    /^\s*(?:feat|feature)(?:\([^\n)]*\))?!?\s*:/i.test(issue.title) ||
    /^\s*(?:feature\s+(?:request|proposal)|(?:add|implement|introduce|expose)\b|(?:missing\s+)?support\s+for\b)/i.test(
      issue.title,
    ) ||
    bodyIdentifiesFeatureRequest
  );
}

function extractProtectedFacts(value: string): Map<string, string> {
  const facts = new Map<string, string>();
  const withoutListMarkers = value.replace(/^\s*\d+[.)]\s+/gm, "");

  for (const pattern of PROTECTED_FACT_PATTERNS) {
    for (const match of withoutListMarkers.matchAll(pattern)) {
      const fact = match[0].trim();
      const normalized = fact.toLowerCase();
      if (!SAFE_ADDED_FACTS.has(normalized)) {
        facts.set(normalized, fact);
      }
    }
  }

  return facts;
}

export function validateFormattingResult(
  issue: IssueFormattingInput,
  result: unknown,
): string[] {
  const issues: string[] = [];
  if (!isRecord(result)) {
    return ["formatting result must be a JSON object"];
  }
  if (typeof result.needsImprovement !== "boolean") {
    issues.push("needsImprovement must be a boolean");
  }
  if (
    typeof result.reasoning !== "string" ||
    result.reasoning.trim().length === 0 ||
    result.reasoning.length > MAX_FORMATTING_METADATA_LENGTH
  ) {
    issues.push("reasoning must be a non-empty bounded string");
  }

  const hasFeedback = Boolean(issue.feedback?.trim());
  if (hasFeedback && result.needsImprovement !== true) {
    issues.push("feedback regeneration must return an improved suggestion");
  }

  if (result.needsImprovement !== true) return issues;

  if (
    typeof result.suggestedTitle !== "string" ||
    !result.suggestedTitle.trim()
  ) {
    issues.push("missing suggested title");
  }
  if (
    typeof result.suggestedBody !== "string" ||
    !result.suggestedBody.trim()
  ) {
    issues.push("missing suggested body");
  }
  if (
    typeof result.changesSummary !== "string" ||
    !result.changesSummary.trim() ||
    result.changesSummary.length > MAX_FORMATTING_METADATA_LENGTH
  ) {
    issues.push("changesSummary must be a non-empty bounded string");
  }

  const suggestedTitle =
    typeof result.suggestedTitle === "string" ? result.suggestedTitle : "";
  if (
    suggestedTitle.length > MAX_GITHUB_ISSUE_TITLE_LENGTH ||
    /[\r\n]/.test(suggestedTitle)
  ) {
    issues.push("suggested title exceeds GitHub title constraints");
  }
  if (
    identifiesFeatureRequest(issue) &&
    !/^\s*\[FR\](?:\s|$)/.test(suggestedTitle)
  ) {
    issues.push('feature request title must start with "[FR]"');
  }

  const originalTitleFacts = extractProtectedFacts(issue.title);
  const titleFacts = [...originalTitleFacts.values()].filter(
    (fact, index, allFacts) =>
      !allFacts.some(
        (otherFact, otherIndex) =>
          otherIndex !== index &&
          otherFact.length > fact.length &&
          otherFact.includes(fact),
      ),
  );
  for (const fact of titleFacts) {
    if (!suggestedTitle.includes(fact)) {
      issues.push(`suggested title drops technical detail: ${fact}`);
    }
  }

  const originalBody = normalizeLineEndings(issue.body);
  const suggestedBody = normalizeLineEndings(
    typeof result.suggestedBody === "string" ? result.suggestedBody : "",
  );
  if (!originalBody.trim()) {
    issues.push("cannot safely synthesize a formatted body from an empty body");
  } else if (!suggestedBody.includes(originalBody)) {
    issues.push("suggested body does not preserve the exact original body");
  }
  if (suggestedBody.length > MAX_GITHUB_ISSUE_BODY_LENGTH) {
    issues.push("suggested body exceeds GitHub body constraints");
  }

  if (originalBody && suggestedBody.includes(originalBody)) {
    const originalIndex = suggestedBody.indexOf(originalBody);
    const additions =
      suggestedBody.slice(0, originalIndex) +
      suggestedBody.slice(originalIndex + originalBody.length);
    const allowedFacts = extractProtectedFacts(`${issue.title}\n${issue.body}`);
    const addedFacts = extractProtectedFacts(additions);
    const unexpectedFacts = [...addedFacts.entries()]
      .filter(([normalized]) => !allowedFacts.has(normalized))
      .map(([, fact]) => fact);

    if (unexpectedFacts.length > 0) {
      issues.push(
        `suggested body introduces unverified technical details: ${unexpectedFacts.slice(0, 5).join(", ")}`,
      );
    }
  }

  return issues;
}

/**
 * Analyzes a GitHub issue to determine if it needs formatting improvements
 */
export async function analyzeIssueFormatting(
  issue: IssueFormattingInput,
  aiProvider: AiProvider,
  metadata?: Record<string, unknown>,
): Promise<{
  success: boolean;
  output?: IssueFormattingResult;
  errors: Array<string>;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    provider: string;
  };
}> {
  const formattingWorkflow = new Workflow<
    IssueFormattingInput,
    IssueFormattingResult
  >()
    .addStep(
      "analyze_formatting",
      createChatStep(
        ISSUE_FORMATTING_SYSTEM_PROMPT,
        (input: unknown) => {
          const { title, body, feedback } = input as IssueFormattingInput;
          return createIssueFormattingUserPrompt(title, body, feedback);
        },
        {
          maxTokens: 4000,
          temperature: 0.2,
          billingLabel: "format-json",
        },
      ),
    )
    .addStep("parse_formatting", async (input: unknown) => {
      const response = input as string;
      const parsed = parseJsonResponse<unknown>(response);
      const validationIssues = validateFormattingResult(issue, parsed);
      if (validationIssues.length > 0) {
        throw new Error(
          `Formatting validation failed: ${validationIssues.join(", ")}`,
        );
      }
      return parsed as IssueFormattingResult;
    });

  const result = await formattingWorkflow.execute(issue, {
    aiProvider,
    metadata: metadata || {},
  });

  return {
    ...result,
    tokenUsage: result.tokenUsage
      ? {
          ...result.tokenUsage,
          model: aiProvider.modelId,
          provider: aiProvider.providerId,
        }
      : undefined,
  };
}
