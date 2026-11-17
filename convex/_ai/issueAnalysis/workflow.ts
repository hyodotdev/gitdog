import type { AiProvider } from "../model";
import { Workflow, createChatStep } from "../workflow";
import { parseJsonResponse } from "../utils";
import type { IssueAnalysisResult, IssueInput } from "./types";
import {
  issueAnalysisSystemPrompt,
  createIssueAnalysisUserPrompt,
} from "./prompts";

/**
 * Analyzes a GitHub issue to determine if it's actionable and classify its type
 */
export async function analyzeIssue(
  issue: IssueInput,
  aiProvider: AiProvider,
  metadata?: Record<string, unknown>,
): Promise<{
  success: boolean;
  output?: IssueAnalysisResult;
  errors: Array<string>;
}> {
  const analysisWorkflow = new Workflow<IssueInput, IssueAnalysisResult>()
    .addStep(
      "analyze_issue",
      createChatStep(
        issueAnalysisSystemPrompt(),
        (input: unknown) => {
          const { title, body, codebaseContext } = input as IssueInput;
          return createIssueAnalysisUserPrompt(title, body, codebaseContext);
        },
        { maxTokens: 16000, retries: 3 }, // Large token limit for detailed responses with Korean/Japanese text
      ),
    )
    .addStep("parse_analysis", async (input: unknown) => {
      const response = input as string;
      return parseJsonResponse<IssueAnalysisResult>(response);
    });

  return await analysisWorkflow.execute(issue, {
    aiProvider,
    metadata: metadata || {},
  });
}
