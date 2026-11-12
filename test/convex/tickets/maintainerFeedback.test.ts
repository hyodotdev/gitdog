import { describe, it, expect, beforeEach } from "vitest";

/**
 * Maintainer Feedback Tests
 *
 * Test scenarios from production bug #3134:
 * 1. Maintainer provides corrections - AI should acknowledge without internal field leakage
 * 2. Follow-up conversation context is properly maintained
 * 3. AI responses don't contain internal implementation details
 *
 * Production Bug Context:
 * - Maintainer hyochan provided feedback correcting gitdog's response
 * - gitdog responded with "I don't have any record of a previous conversation or 'suggestedResponse'"
 * - This exposed internal field names and lost conversation context
 */

type TicketType = "issue" | "discussion";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface TicketAction {
  id: string;
  ticketId: string;
  actionType: string;
  chatHistory: ChatMessage[];
  proposedChanges?: {
    suggestedResponse?: string;
    author?: string;
  };
}

interface Ticket {
  id: string;
  ticketType: TicketType;
  githubTitle: string;
  githubBody: string;
  githubAuthor?: string;
  repositoryId: string;
  userId: string;
}

// Internal field names that should NEVER appear in user-facing responses
const INTERNAL_FIELD_NAMES = [
  "suggestedResponse",
  "isActionable",
  "issueType",
  "reasoning",
  "chatHistory",
  "proposedChanges",
  "ticketId",
  "actionId",
  "repositoryId",
];

// Phrases that indicate context loss
const CONTEXT_LOSS_PHRASES = [
  "I don't have any record of",
  "I don't have access to previous",
  "Each conversation with me starts fresh",
  "I would need you to provide",
  "without access to prior interactions",
  "I'm not aware of any previous",
];

/**
 * Validates that a response doesn't contain internal field names
 */
function validateNoInternalFieldLeakage(response: string): {
  valid: boolean;
  leakedFields: string[];
} {
  const leakedFields: string[] = [];

  for (const fieldName of INTERNAL_FIELD_NAMES) {
    // Check for field name mentions (case-insensitive, word boundary)
    const regex = new RegExp(`\\b${fieldName}\\b`, "i");
    if (regex.test(response)) {
      leakedFields.push(fieldName);
    }
  }

  return {
    valid: leakedFields.length === 0,
    leakedFields,
  };
}

/**
 * Detects if response indicates context loss
 */
function detectContextLoss(response: string): {
  hasContextLoss: boolean;
  matchedPhrases: string[];
} {
  const matchedPhrases: string[] = [];

  for (const phrase of CONTEXT_LOSS_PHRASES) {
    if (response.toLowerCase().includes(phrase.toLowerCase())) {
      matchedPhrases.push(phrase);
    }
  }

  return {
    hasContextLoss: matchedPhrases.length > 0,
    matchedPhrases,
  };
}

/**
 * Builds conversation context (mirrors actual implementation in internalAction.ts:566-605)
 */
function buildConversationContext(
  ticket: Ticket,
  chatHistory: ChatMessage[],
  latestComment: { content: string; author: string; isMaintainer: boolean },
): string {
  const isDiscussion = ticket.ticketType === "discussion";

  // Build conversation history from chat history (exclude current message)
  const previousMessages = chatHistory.slice(0, -1);
  const conversationHistory = previousMessages
    .map((msg) => {
      if (msg.role === "assistant") {
        return `[Gitdog (AI)]: ${msg.content}`;
      }
      return msg.content;
    })
    .join("\n\n");

  const fullContext = `Original ${isDiscussion ? "Discussion" : "Issue"} Title: ${ticket.githubTitle}
Original ${isDiscussion ? "Discussion" : "Issue"} Body: ${ticket.githubBody || "(No description)"}

---
${
  conversationHistory
    ? `
**Previous Conversation (IMPORTANT - read carefully for context and user preferences):**
${conversationHistory}

---
`
    : ""
}
**Current Follow-up Comment:** ${latestComment.content}

---
**FOLLOW-UP RESPONSE GUIDELINES:**
This is a follow-up in an ongoing conversation. Before responding:
1. Read the previous conversation carefully - understand what was already discussed
2. Pay attention to ANY feedback from the user about response style, length, or format
3. If user is asking for changes to your previous response (shorter, longer, different format, etc.), adapt accordingly
4. Don't repeat information already provided unless specifically asked
5. If user's request is simple (like asking for shorter version), you may NOT need to use tools - just reformat your previous answer`;

  return fullContext;
}

/**
 * Formats user comment with maintainer label (mirrors webhook.ts implementation)
 */
function formatUserComment(
  author: string,
  content: string,
  isMaintainer: boolean,
): string {
  const label = isMaintainer ? `[${author} [Maintainer]]:` : `[${author}]:`;
  return `${label} ${content}`;
}

// Mock database
class MockDatabase {
  private tickets: Map<string, Ticket> = new Map();
  private actions: Map<string, TicketAction> = new Map();
  private nextId = 1;

  reset() {
    this.tickets.clear();
    this.actions.clear();
    this.nextId = 1;
  }

  generateId() {
    return `id_${this.nextId++}`;
  }

  insertTicket(ticket: Omit<Ticket, "id">): Ticket {
    const id = this.generateId();
    const newTicket: Ticket = { ...ticket, id };
    this.tickets.set(id, newTicket);
    return newTicket;
  }

  getTicket(id: string): Ticket | undefined {
    return this.tickets.get(id);
  }

  insertAction(action: Omit<TicketAction, "id">): TicketAction {
    const id = this.generateId();
    const newAction: TicketAction = { ...action, id };
    this.actions.set(id, newAction);
    return newAction;
  }

  getAction(id: string): TicketAction | undefined {
    return this.actions.get(id);
  }
}

let db: MockDatabase;

beforeEach(() => {
  db = new MockDatabase();
});

describe("Maintainer Feedback Handling", () => {
  describe("Response Validation - No Internal Field Leakage", () => {
    it("should detect internal field name leakage", () => {
      // This is the problematic response from production
      const badResponse = `You're right—thank you for the correction.

The correct API format is:

I appreciate you reaching out, but I don't have any record of a previous conversation or a "suggestedResponse" that was cut off. Each conversation with me starts fresh without access to prior interactions.`;

      const validation = validateNoInternalFieldLeakage(badResponse);

      expect(validation.valid).toBe(false);
      expect(validation.leakedFields).toContain("suggestedResponse");
    });

    it("should pass validation for clean responses", () => {
      const goodResponse = `You're right—thank you for the correction.

The correct API format is:

\`\`\`typescript
await requestPurchase({
  request: {
    apple: { sku: productId },
    google: { skus: [productId] },
  },
  type: 'in-app',
});
\`\`\`

I apologize for the confusion in my earlier response.`;

      const validation = validateNoInternalFieldLeakage(goodResponse);

      expect(validation.valid).toBe(true);
      expect(validation.leakedFields).toHaveLength(0);
    });

    it("should detect multiple leaked fields", () => {
      const veryBadResponse = `I see the isActionable field was set correctly but the suggestedResponse and reasoning fields need to be updated.`;

      const validation = validateNoInternalFieldLeakage(veryBadResponse);

      expect(validation.valid).toBe(false);
      expect(validation.leakedFields).toContain("isActionable");
      expect(validation.leakedFields).toContain("suggestedResponse");
      expect(validation.leakedFields).toContain("reasoning");
    });
  });

  describe("Context Loss Detection", () => {
    it("should detect context loss phrases", () => {
      const badResponse = `I appreciate you reaching out, but I don't have any record of a previous conversation. Each conversation with me starts fresh without access to prior interactions.`;

      const detection = detectContextLoss(badResponse);

      expect(detection.hasContextLoss).toBe(true);
      expect(detection.matchedPhrases.length).toBeGreaterThan(0);
    });

    it("should not flag normal responses as context loss", () => {
      const goodResponse = `You're right, thank you for the correction. The correct API format uses the nested request object structure as you mentioned.`;

      const detection = detectContextLoss(goodResponse);

      expect(detection.hasContextLoss).toBe(false);
      expect(detection.matchedPhrases).toHaveLength(0);
    });

    it("should detect the exact production bug pattern", () => {
      // This is the exact response from the production bug
      const productionBugResponse = `@hyochan You're right—thank you for the correction.

The correct API format is:

I appreciate you reaching out, but I don't have any record of a previous conversation or a "suggestedResponse" that was cut off. Each conversation with me starts fresh without access to prior interactions.

To help you effectively, I would need you to:

Provide the full context of what you were discussing
Share the topic (API format, code snippet, etc.)
Clarify what you need completed
Once you give me those details, I'll be happy to continue the explanation or complete the section you're working on.`;

      const fieldLeakage = validateNoInternalFieldLeakage(
        productionBugResponse,
      );
      const contextLoss = detectContextLoss(productionBugResponse);

      // Should fail both checks
      expect(fieldLeakage.valid).toBe(false);
      expect(contextLoss.hasContextLoss).toBe(true);
    });
  });

  describe("Maintainer Label in Conversation Context", () => {
    it("should include [Maintainer] label for repository owner", () => {
      const ticket = db.insertTicket({
        ticketType: "issue",
        githubTitle: "requestPurchase returns empty array #3134",
        githubBody:
          "On Android calling requestPurchase returns an empty array always.",
        githubAuthor: "renatomserra",
        repositoryId: "repo_1",
        userId: "user_1",
      });

      // Simulate conversation history
      const chatHistory: ChatMessage[] = [
        {
          role: "user",
          content:
            "[renatomserra]: On Android calling requestPurchase returns an empty array always.",
          timestamp: Date.now() - 3000,
        },
        {
          role: "assistant",
          content:
            "Your code is awaiting requestPurchase() expecting it to return purchase data...",
          timestamp: Date.now() - 2000,
        },
      ];

      // Maintainer provides feedback
      const maintainerComment = formatUserComment(
        "hyochan",
        "@GitDog Feedback on your response:\n\nCorrect: Core advice is accurate\n\nIncorrect: Code example format doesn't match current API",
        true,
      );

      chatHistory.push({
        role: "user",
        content: maintainerComment,
        timestamp: Date.now() - 1000,
      });

      const context = buildConversationContext(ticket, chatHistory, {
        content: maintainerComment,
        author: "hyochan",
        isMaintainer: true,
      });

      // Verify maintainer label is present
      expect(context).toContain("[Maintainer]");
      expect(context).toContain("hyochan");
      expect(context).toContain("Previous Conversation");
    });

    it("should NOT include [Maintainer] label for regular users", () => {
      const ticket = db.insertTicket({
        ticketType: "issue",
        githubTitle: "Help with API",
        githubBody: "I need help",
        githubAuthor: "regularuser",
        repositoryId: "repo_1",
        userId: "user_1",
      });

      const chatHistory: ChatMessage[] = [
        {
          role: "user",
          content: "[regularuser]: I need help",
          timestamp: Date.now() - 2000,
        },
        {
          role: "assistant",
          content: "Here's how you can do it...",
          timestamp: Date.now() - 1000,
        },
      ];

      // Regular user provides follow-up (NOT maintainer)
      const userComment = formatUserComment(
        "anotheruser",
        "Can you explain more?",
        false,
      );

      chatHistory.push({
        role: "user",
        content: userComment,
        timestamp: Date.now(),
      });

      const context = buildConversationContext(ticket, chatHistory, {
        content: userComment,
        author: "anotheruser",
        isMaintainer: false,
      });

      // Verify maintainer label is NOT present
      expect(context).not.toContain("[Maintainer]");
      expect(context).toContain("[anotheruser]");
    });
  });

  describe("Follow-up Conversation Context Building", () => {
    it("should include previous AI response in context", () => {
      const ticket = db.insertTicket({
        ticketType: "issue",
        githubTitle: "Test Issue",
        githubBody: "Test body",
        githubAuthor: "testuser",
        repositoryId: "repo_1",
        userId: "user_1",
      });

      const previousAiResponse =
        "This is how the API works: use requestPurchase() with proper callbacks.";

      const chatHistory: ChatMessage[] = [
        {
          role: "user",
          content: "[testuser]: How does the API work?",
          timestamp: Date.now() - 2000,
        },
        {
          role: "assistant",
          content: previousAiResponse,
          timestamp: Date.now() - 1000,
        },
        {
          role: "user",
          content: "[testuser]: Thanks, but can you show the correct format?",
          timestamp: Date.now(),
        },
      ];

      const context = buildConversationContext(ticket, chatHistory, {
        content: "Thanks, but can you show the correct format?",
        author: "testuser",
        isMaintainer: false,
      });

      // Verify previous AI response is included
      expect(context).toContain("[Gitdog (AI)]:");
      expect(context).toContain(previousAiResponse);
      expect(context).toContain("Previous Conversation");
    });

    it("should include guidelines about not repeating information", () => {
      const ticket = db.insertTicket({
        ticketType: "issue",
        githubTitle: "Test",
        githubBody: "Test",
        githubAuthor: "user",
        repositoryId: "repo_1",
        userId: "user_1",
      });

      const chatHistory: ChatMessage[] = [
        {
          role: "user",
          content: "[user]: Question",
          timestamp: Date.now() - 1000,
        },
        {
          role: "assistant",
          content: "Answer",
          timestamp: Date.now(),
        },
      ];

      const context = buildConversationContext(ticket, chatHistory, {
        content: "Follow-up",
        author: "user",
        isMaintainer: false,
      });

      // Verify guidelines are present
      expect(context).toContain("FOLLOW-UP RESPONSE GUIDELINES");
      expect(context).toContain("Don't repeat information already provided");
      expect(context).toContain("Read the previous conversation carefully");
    });
  });

  describe("Production Bug Scenario Simulation", () => {
    it("should properly maintain context for maintainer correction scenario", () => {
      // Simulate the exact production scenario from issue #3134
      const ticket = db.insertTicket({
        ticketType: "issue",
        githubTitle: "[Android] requestPurchase returns empty array #3134",
        githubBody:
          "On Android calling requestPurchase returns an empty array always.",
        githubAuthor: "renatomserra",
        repositoryId: "repo_1",
        userId: "user_1",
      });

      // First: Original issue opened
      const chatHistory: ChatMessage[] = [
        {
          role: "user",
          content:
            "[renatomserra]: On Android calling requestPurchase returns an empty array always.",
          timestamp: Date.now() - 300000,
        },
        {
          role: "assistant",
          content: `@renatomserra Issue Analysis:

Your code is awaiting requestPurchase() expecting it to return purchase data, but this is not how the API works. This is a design pattern issue, not a bug.

Root Cause:

In v14.6+, requestPurchase() returns Promise<void> and is event-driven...`,
          timestamp: Date.now() - 200000,
        },
      ];

      // Maintainer (hyochan) provides correction
      const maintainerCorrection = formatUserComment(
        "hyochan",
        `@GitDog Feedback on your response:

Correct:
- Core advice is accurate - purchase results come through onPurchaseSuccess callback, not the return value

Incorrect:
- Code example format doesn't match current API. Correct format:
await requestPurchase({
  request: {
    apple: { sku: productId },
    google: { skus: [productId] },
  },
  type: 'in-app',
});`,
        true,
      );

      chatHistory.push({
        role: "user",
        content: maintainerCorrection,
        timestamp: Date.now() - 100000,
      });

      const context = buildConversationContext(ticket, chatHistory, {
        content: maintainerCorrection,
        author: "hyochan",
        isMaintainer: true,
      });

      // Verify context contains all necessary information
      expect(context).toContain("[Maintainer]");
      expect(context).toContain("hyochan");
      expect(context).toContain("requestPurchase");
      expect(context).toContain("[Gitdog (AI)]:");
      expect(context).toContain("Issue Analysis");

      // The context should make it clear this is a correction
      expect(context).toContain("Feedback on your response");
      expect(context).toContain("Correct:");
      expect(context).toContain("Incorrect:");
    });

    it("should validate that the ideal response passes all checks", () => {
      // This is what the response SHOULD have been
      const idealResponse = `@hyochan You're right—thank you for the correction.

The correct API format is:

\`\`\`typescript
await requestPurchase({
  request: {
    apple: { sku: productId },
    google: { skus: [productId] },
  },
  type: 'in-app',
});
\`\`\`

I apologize for showing the incorrect format earlier. The \`request\` object should contain platform-specific configurations with \`apple\` and \`google\` keys.

@renatomserra To summarize the correct usage:
1. Use the callback-based approach with \`onPurchaseSuccess\`
2. The \`requestPurchase\` function returns \`Promise<void>\`, not the purchase data
3. Use the corrected request format shown above`;

      const fieldLeakage = validateNoInternalFieldLeakage(idealResponse);
      const contextLoss = detectContextLoss(idealResponse);

      expect(fieldLeakage.valid).toBe(true);
      expect(contextLoss.hasContextLoss).toBe(false);
    });
  });
});

describe("AI Response Quality Guards", () => {
  it("should provide comprehensive validation function for production use", () => {
    /**
     * This function can be used in production to validate AI responses
     * before posting them to GitHub
     */
    function validateAiResponse(response: string): {
      isValid: boolean;
      issues: string[];
    } {
      const issues: string[] = [];

      // Check for internal field leakage
      const fieldCheck = validateNoInternalFieldLeakage(response);
      if (!fieldCheck.valid) {
        issues.push(
          `Internal field names leaked: ${fieldCheck.leakedFields.join(", ")}`,
        );
      }

      // Check for context loss
      const contextCheck = detectContextLoss(response);
      if (contextCheck.hasContextLoss) {
        issues.push(
          `Context loss detected: ${contextCheck.matchedPhrases.join("; ")}`,
        );
      }

      // Check for empty or too short response
      if (!response || response.trim().length < 10) {
        issues.push("Response is empty or too short");
      }

      return {
        isValid: issues.length === 0,
        issues,
      };
    }

    // Test with production bug response
    const buggyResponse = `I don't have any record of a previous conversation or a "suggestedResponse"`;
    const bugValidation = validateAiResponse(buggyResponse);
    expect(bugValidation.isValid).toBe(false);
    expect(bugValidation.issues.length).toBeGreaterThan(0);

    // Test with good response
    const goodResponse = `You're right, thank you for the correction. Here's the updated code example with the proper format.`;
    const goodValidation = validateAiResponse(goodResponse);
    expect(goodValidation.isValid).toBe(true);
    expect(goodValidation.issues).toHaveLength(0);
  });
});
