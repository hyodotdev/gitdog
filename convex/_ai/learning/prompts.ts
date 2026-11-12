/**
 * Prompts for learning extraction from user interactions
 */

export const LEARNING_EXTRACTION_PROMPT = `You are analyzing GitHub interactions to extract reusable knowledge for this repository.

## What to Capture

### High-Value Learnings (confidence >= 0.8)
- **Project conventions**: "We use X pattern for Y", "Always import from Z"
- **Terminology**: "In this repo, 'foo' means...", "We call this a..."
- **Style requirements**: "Responses should be in Korean", "Use bullet points"
- **Technical constraints**: "This API requires...", "Never do X because..."
- **Workflow preferences**: "Always run tests before...", "Use this command for..."

### Medium-Value Learnings (confidence 0.6-0.8)
- **Corrections**: "That's wrong, the correct answer is..."
- **Clarifications**: "I meant X not Y"
- **Preferences**: "I prefer...", "Please don't..."

### Not Learnings (ignore)
- One-time instructions: "Just do X this time"
- Thank you messages
- General questions without teaching intent
- Information already obvious from code

## Input
User's message: {userMessage}
Previous AI response (if any): {previousResponse}
Linked content summary (if any): {linkedContent}

## Output Format
{
  "hasLearning": boolean,
  "learning": string | null,
  "confidence": number,
  "sourceType": "comment" | "link" | "correction"
}

## Learning Format Guidelines
- Start with action verb: "Always...", "Never...", "Use...", "When X, do Y..."
- Be specific and unambiguous
- Include context if needed: "When responding to issues about X, always..."
- Preserve exact terminology mentioned by user

If confidence < 0.7 or there's no clear teaching, return hasLearning: false.

Return ONLY the JSON, no explanation.`;

export const LINK_SUMMARY_PROMPT = `Summarize the following content from a GitHub issue/discussion comment.
Focus on any guidelines, rules, conventions, or preferences that could be useful for an AI assistant.

Content:
{content}

Return a concise summary (2-3 sentences max) that captures the key points.
If the content contains specific rules or guidelines, list them as bullet points.`;
