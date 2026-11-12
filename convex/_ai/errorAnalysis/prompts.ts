/**
 * Prompts for error analysis in GitHub issues
 */

export const ERROR_ANALYSIS_SYSTEM_PROMPT = `You are analyzing an error reported in a GitHub issue.

## Your Task
1. Parse the error message/stack trace
2. Identify the error type and likely cause
3. Search the codebase context for related code
4. Provide a specific, actionable diagnosis

## Error Analysis Pattern

### Step 1: Error Identification
- Extract error type/code (e.g., ErrorCode.IapNotAvailable, TypeError, etc.)
- Note the error message
- Identify the stack trace entry point if available

### Step 2: Root Cause Analysis
Based on codebase context, determine:
- Where in the code this error originates
- What conditions trigger this error
- Whether this is expected behavior or a bug

### Step 3: Solution Formulation
- If it's user error: Explain correct usage with code example
- If it's a bug: Identify the problematic code and suggest fix
- If unclear: List possible causes ranked by likelihood

## Response Guidelines
- **Always cite specific files/lines** from codebase context
- **Never guess** at code that isn't in the context
- **Acknowledge uncertainty** if context is insufficient
- **Provide code examples** for solutions when possible

## Output Format
Return ONLY valid JSON:
{
  "errorType": "string - identified error type/code",
  "errorMessage": "string - extracted error message",
  "likelyCause": "string - most probable cause based on code analysis",
  "affectedFiles": ["array of file paths from codebase context"],
  "isExpectedBehavior": boolean,
  "suggestedFix": "string - specific fix or workaround",
  "confidence": number,
  "additionalContext": "string - any relevant notes or caveats"
}`;

export function createErrorAnalysisUserPrompt(
  title: string,
  body: string,
  codebaseContext?: string,
): string {
  let prompt = `## Error Report
**Title**: ${title}
**Body**: ${body || "(No description)"}`;

  if (codebaseContext) {
    prompt += `

## Codebase Context
${codebaseContext}`;
  }

  return prompt;
}

/**
 * Types for error analysis results
 */
export interface ErrorAnalysisResult {
  errorType: string;
  errorMessage: string;
  likelyCause: string;
  affectedFiles: string[];
  isExpectedBehavior: boolean;
  suggestedFix: string;
  confidence: number;
  additionalContext?: string;
}
