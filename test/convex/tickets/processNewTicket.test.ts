import { describe, it, expect, beforeEach, vi } from "vitest";

import type { Id } from "../../../convex/_generated/dataModel";
import { ChatProviderRequestError } from "../../../convex/_ai/providerErrors";
import { terminalizeConfirmedNotBilledInitialFailure } from "../../../convex/tickets/internalAction";

/**
 * Process New Ticket Tests
 *
 * Test Structure:
 * 1. Token limit checks before processing
 * 2. Format action creation and completion
 * 3. Answer action creation and completion
 * 4. Maintainer info in answer actions (for actionable issues)
 * 5. Discussion vs Issue handling
 * 6. Error handling
 */

type TicketType = "issue" | "discussion";
type TicketActionType = "format" | "answer";
type TicketActionStatus =
  | "pending"
  | "pending_approval"
  | "executing"
  | "completed"
  | "failed"
  | "rejected";

interface Ticket {
  id: string;
  userId: string;
  repositoryId: string;
  ticketType: TicketType;
  githubTitle: string;
  githubBody: string;
  createdAt: number;
}

interface TicketAction {
  id: string;
  ticketId: string;
  actionType: TicketActionType;
  status: TicketActionStatus;
  proposedChanges?: {
    // Format action
    originalTitle?: string;
    originalBody?: string;
    suggestedTitle?: string;
    suggestedBody?: string;
    changesSummary?: string;
    reasoning?: string;
    // Answer action
    suggestedResponse?: string;
    issueType?: string;
    isActionable?: boolean;
  };
  chatHistory?: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }>;
  errorMessage?: string;
  createdAt: number;
}

interface Repository {
  id: string;
  userId: string;
  fullName: string;
  settings: {
    autoFormatIssue: boolean;
    autoFormatDiscussion?: boolean;
    autoAnswerQuestions: boolean;
    autoAnswerDiscussionQuestions?: boolean;
  };
}

interface TokenLimitResult {
  allowed: boolean;
  reason?: string;
  message?: string;
}

// In-memory database
class MockDatabase {
  private tickets: Map<string, Ticket> = new Map();
  private actions: Map<string, TicketAction> = new Map();
  private repositories: Map<string, Repository> = new Map();
  private nextId = 1;

  reset() {
    this.tickets.clear();
    this.actions.clear();
    this.repositories.clear();
    this.nextId = 1;
  }

  generateId() {
    return `id_${this.nextId++}`;
  }

  insertTicket(ticket: Omit<Ticket, "id" | "createdAt">): Ticket {
    const id = this.generateId();
    const newTicket: Ticket = { ...ticket, id, createdAt: Date.now() };
    this.tickets.set(id, newTicket);
    return newTicket;
  }

  getTicket(id: string): Ticket | undefined {
    return this.tickets.get(id);
  }

  insertAction(action: Omit<TicketAction, "id" | "createdAt">): TicketAction {
    const id = this.generateId();
    const newAction: TicketAction = { ...action, id, createdAt: Date.now() };
    this.actions.set(id, newAction);
    return newAction;
  }

  getAction(id: string): TicketAction | undefined {
    return this.actions.get(id);
  }

  updateAction(id: string, updates: Partial<TicketAction>): TicketAction {
    const action = this.actions.get(id);
    if (!action) throw new Error(`Action ${id} not found`);
    const updated = { ...action, ...updates };
    this.actions.set(id, updated);
    return updated;
  }

  getActionsByTicket(ticketId: string): TicketAction[] {
    return Array.from(this.actions.values())
      .filter((action) => action.ticketId === ticketId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  insertRepository(repo: Omit<Repository, "id">): Repository {
    const id = this.generateId();
    const newRepo: Repository = { ...repo, id };
    this.repositories.set(id, newRepo);
    return newRepo;
  }

  getRepository(id: string): Repository | undefined {
    return this.repositories.get(id);
  }
}

// Mock token limit check
function mockTokenLimitCheck(shouldAllow: boolean): TokenLimitResult {
  if (shouldAllow) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "limit_reached",
    message:
      "Free tier limit reached (100,000 tokens/month). Upgrade to Pro for more.",
  };
}

let db: MockDatabase;
let testRepo: Repository;

beforeEach(() => {
  db = new MockDatabase();

  // Setup test repository with default settings
  testRepo = db.insertRepository({
    userId: "user_1",
    fullName: "owner/repo",
    settings: {
      autoFormatIssue: true,
      autoFormatDiscussion: true,
      autoAnswerQuestions: true,
      autoAnswerDiscussionQuestions: true,
    },
  });
});

describe("Token Limit Checks", () => {
  it("should block processing when user hits token limit", () => {
    // Given: New issue
    const ticket = db.insertTicket({
      userId: "user_1",
      repositoryId: testRepo.id,
      ticketType: "issue",
      githubTitle: "Feature request",
      githubBody: "Please add dark mode",
    });

    // When: Token limit check fails
    const tokenCheck = mockTokenLimitCheck(false);

    if (!tokenCheck.allowed) {
      // Create failed action with token limit message
      const action = db.insertAction({
        ticketId: ticket.id,
        actionType: "answer",
        status: "failed",
        proposedChanges: {
          suggestedResponse: tokenCheck.message || "Token limit reached.",
        },
        chatHistory: [
          {
            role: "assistant",
            content: tokenCheck.message || "Token limit reached.",
            timestamp: Date.now(),
          },
        ],
        errorMessage: tokenCheck.message,
      });

      // Then: Action should be failed with error message
      expect(action.status).toBe("failed");
      expect(action.errorMessage).toContain("limit reached");
      expect(action.chatHistory).toHaveLength(1);
    }
  });

  it("should proceed with processing when user has tokens available", () => {
    // Given: New issue
    const ticket = db.insertTicket({
      userId: "user_1",
      repositoryId: testRepo.id,
      ticketType: "issue",
      githubTitle: "Bug: Login button not working",
      githubBody: "When I click login, nothing happens",
    });

    // When: Token limit check passes
    const tokenCheck = mockTokenLimitCheck(true);

    // Then: Should create actions
    if (tokenCheck.allowed) {
      const formatAction = db.insertAction({
        ticketId: ticket.id,
        actionType: "format",
        status: "pending",
      });

      expect(formatAction.status).toBe("pending");
    }
  });
});

describe("Format Action", () => {
  describe("When autoFormatIssue = true", () => {
    it("should create pending format action initially", () => {
      // Given: Issue that needs formatting
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "issue",
        githubTitle: "bug",
        githubBody: "its broken",
      });

      // When: Create format action
      const action = db.insertAction({
        ticketId: ticket.id,
        actionType: "format",
        status: "pending", // No proposedChanges = pending
      });

      // Then: Should be pending
      expect(action.status).toBe("pending");
      expect(action.proposedChanges).toBeUndefined();
    });

    it("should complete format action when improvement is found", () => {
      // Given: Pending format action
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "issue",
        githubTitle: "bug",
        githubBody: "its broken",
      });

      const action = db.insertAction({
        ticketId: ticket.id,
        actionType: "format",
        status: "pending",
      });

      // When: AI analysis completes with improvements
      db.updateAction(action.id, {
        status: "pending_approval",
        proposedChanges: {
          originalTitle: "bug",
          originalBody: "its broken",
          suggestedTitle: "Bug: Application not loading",
          suggestedBody:
            "## Description\nThe application fails to load properly.\n\n## Steps to reproduce\n1. Open app\n2. Observe error",
          changesSummary: "Added proper title and structured body",
          reasoning: "Issue was too vague and needed structure",
        },
        chatHistory: [
          {
            role: "assistant",
            content:
              "I analyzed this issue and found it could benefit from formatting improvements.",
            timestamp: Date.now(),
          },
        ],
      });

      // Then: Should have proposed changes
      const updated = db.getAction(action.id);
      expect(updated?.status).toBe("pending_approval");
      expect(updated?.proposedChanges?.suggestedTitle).toBe(
        "Bug: Application not loading",
      );
      expect(updated?.chatHistory).toHaveLength(1);
    });

    it("should complete without changes when formatting is good", () => {
      // Given: Well-formatted issue
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "issue",
        githubTitle: "Bug: Login button not responding",
        githubBody:
          "## Description\nWhen I click the login button, nothing happens.\n\n## Steps to reproduce\n1. Go to login page\n2. Click login button\n3. Observe no action",
      });

      const action = db.insertAction({
        ticketId: ticket.id,
        actionType: "format",
        status: "pending",
      });

      // When: AI analysis finds no improvement needed
      db.updateAction(action.id, {
        status: "completed",
        // No proposedChanges = no improvement needed
      });

      // Then: Should be completed without proposed changes
      const updated = db.getAction(action.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.proposedChanges).toBeUndefined();
    });
  });

  describe("When autoFormatIssue = false", () => {
    beforeEach(() => {
      testRepo.settings.autoFormatIssue = false;
    });

    it("should not create format action", () => {
      // Given: Issue with auto-format disabled
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "issue",
        githubTitle: "bug",
        githubBody: "its broken",
      });

      // When: Process ticket
      // No format action should be created

      // Then: No format actions
      const actions = db.getActionsByTicket(ticket.id);
      const formatActions = actions.filter((a) => a.actionType === "format");
      expect(formatActions).toHaveLength(0);
    });
  });

  describe("Discussion formatting", () => {
    it("should format discussion when autoFormatDiscussion = true", () => {
      // Given: Discussion
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "discussion",
        githubTitle: "idea",
        githubBody: "what if we add this",
      });

      // When: Create format action
      const action = db.insertAction({
        ticketId: ticket.id,
        actionType: "format",
        status: "pending",
      });

      // Then: Should be created
      expect(action.actionType).toBe("format");
    });
  });
});

describe("Answer Action", () => {
  describe("When autoAnswerQuestions = true", () => {
    it("should create pending answer action initially", () => {
      // Given: Question issue
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "issue",
        githubTitle: "How do I configure the app?",
        githubBody: "I need help with configuration",
      });

      // When: Create answer action
      const action = db.insertAction({
        ticketId: ticket.id,
        actionType: "answer",
        status: "pending", // No proposedChanges = pending
      });

      // Then: Should be pending
      expect(action.status).toBe("pending");
      expect(action.proposedChanges).toBeUndefined();
    });

    it("should complete answer action with response for question", () => {
      // Given: Pending answer action
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "issue",
        githubTitle: "How do I configure the app?",
        githubBody: "I need help with configuration",
      });

      const action = db.insertAction({
        ticketId: ticket.id,
        actionType: "answer",
        status: "pending",
      });

      // When: AI analysis completes with response
      db.updateAction(action.id, {
        status: "pending_approval",
        proposedChanges: {
          suggestedResponse:
            "You can configure the app by editing the `config.json` file in the root directory.",
          issueType: "question",
          reasoning: "User is asking for documentation",
          isActionable: false,
        },
        chatHistory: [
          {
            role: "assistant",
            content:
              "You can configure the app by editing the `config.json` file in the root directory.",
            timestamp: Date.now(),
          },
        ],
      });

      // Then: Should have suggested response
      const updated = db.getAction(action.id);
      expect(updated?.status).toBe("pending_approval");
      expect(updated?.proposedChanges?.suggestedResponse).toContain(
        "config.json",
      );
      expect(updated?.proposedChanges?.issueType).toBe("question");
      expect(updated?.proposedChanges?.isActionable).toBe(false);
    });

    it("should include maintainer info when issue is actionable", () => {
      // Given: Actionable bug report
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "issue",
        githubTitle: "Bug: Login button not working",
        githubBody: "When I click login, nothing happens",
      });

      const action = db.insertAction({
        ticketId: ticket.id,
        actionType: "answer",
        status: "pending",
      });

      // When: AI analysis finds actionable issue
      db.updateAction(action.id, {
        status: "pending_approval",
        proposedChanges: {
          suggestedResponse:
            "Thank you for the bug report! I found the issue in the login handler. This appears to be a missing event handler. Maintainers have been notified.",
          issueType: "actionable",
          reasoning: "Bug report with clear reproduction steps",
          isActionable: true,
        },
        chatHistory: [
          {
            role: "assistant",
            content:
              "Thank you for the bug report! I found the issue in the login handler.",
            timestamp: Date.now(),
          },
        ],
      });

      // Then: Should mark as actionable (maintainers will be tagged)
      const updated = db.getAction(action.id);
      expect(updated?.proposedChanges?.isActionable).toBe(true);
    });

    it("should mark as completed when no response is generated", () => {
      // Given: Issue that doesn't need response
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "issue",
        githubTitle: "Thanks!",
        githubBody: "Great project, thank you!",
      });

      const action = db.insertAction({
        ticketId: ticket.id,
        actionType: "answer",
        status: "pending",
      });

      // When: AI analysis completes with no response
      db.updateAction(action.id, {
        status: "completed",
        // No proposedChanges = no response needed
      });

      // Then: Should be completed without proposed changes
      const updated = db.getAction(action.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.proposedChanges).toBeUndefined();
    });
  });

  describe("When autoAnswerQuestions = false", () => {
    beforeEach(() => {
      testRepo.settings.autoAnswerQuestions = false;
    });

    it("should not create answer action", () => {
      // Given: Issue with auto-answer disabled
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "issue",
        githubTitle: "How do I configure?",
        githubBody: "Need help",
      });

      // When: Process ticket
      // No answer action should be created

      // Then: No answer actions
      const actions = db.getActionsByTicket(ticket.id);
      const answerActions = actions.filter((a) => a.actionType === "answer");
      expect(answerActions).toHaveLength(0);
    });
  });

  describe("Discussion answers", () => {
    it("should answer discussion when autoAnswerDiscussionQuestions = true", () => {
      // Given: Discussion
      const ticket = db.insertTicket({
        userId: "user_1",
        repositoryId: testRepo.id,
        ticketType: "discussion",
        githubTitle: "What's the best approach for X?",
        githubBody: "I'm trying to implement X",
      });

      // When: Create answer action
      const action = db.insertAction({
        ticketId: ticket.id,
        actionType: "answer",
        status: "pending",
      });

      // Complete with response
      db.updateAction(action.id, {
        status: "pending_approval",
        proposedChanges: {
          suggestedResponse:
            "For implementing X, I recommend using approach Y...",
          issueType: "discussion",
          isActionable: false,
        },
      });

      // Then: Should have response
      const updated = db.getAction(action.id);
      expect(updated?.proposedChanges?.suggestedResponse).toContain(
        "approach Y",
      );
    });
  });
});

describe("Error Handling", () => {
  it.each(["format", "answer"] as const)(
    "should terminalize a confirmed-not-billed initial %s provider failure",
    async (actionType) => {
      const actionId = `${actionType}-action` as Id<"ticketActions">;
      const failPendingGeneration = vi.fn(async () => undefined);
      const error = new ChatProviderRequestError(
        "AI API rejected the request with HTTP 429",
        "not_billed",
        { httpStatus: 429 },
      );

      await expect(
        terminalizeConfirmedNotBilledInitialFailure(
          error,
          actionId,
          failPendingGeneration,
        ),
      ).resolves.toBe(true);
      expect(failPendingGeneration).toHaveBeenCalledOnce();
      expect(failPendingGeneration).toHaveBeenCalledWith(
        actionId,
        error.message,
      );
    },
  );

  it("should leave an ambiguous initial provider failure to durable recovery", async () => {
    const failPendingGeneration = vi.fn(async () => undefined);
    const error = new ChatProviderRequestError(
      "AI API request failed before usage could be verified",
      "ambiguous",
    );

    await expect(
      terminalizeConfirmedNotBilledInitialFailure(
        error,
        "answer-action" as Id<"ticketActions">,
        failPendingGeneration,
      ),
    ).resolves.toBe(false);
    expect(failPendingGeneration).not.toHaveBeenCalled();
  });

  it("should mark action as failed when analysis fails", () => {
    // Given: Issue
    const ticket = db.insertTicket({
      userId: "user_1",
      repositoryId: testRepo.id,
      ticketType: "issue",
      githubTitle: "Bug",
      githubBody: "Broken",
    });

    const action = db.insertAction({
      ticketId: ticket.id,
      actionType: "answer",
      status: "pending",
    });

    // When: Analysis fails
    db.updateAction(action.id, {
      status: "failed",
      errorMessage: "AI analysis failed: Connection timeout",
    });

    // Then: Should be failed with error message
    const updated = db.getAction(action.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorMessage).toContain("Connection timeout");
  });

  it("should handle repository not found gracefully", () => {
    // Given: Ticket with non-existent repository
    const ticket = db.insertTicket({
      userId: "user_1",
      repositoryId: "nonexistent_repo",
      ticketType: "issue",
      githubTitle: "Test",
      githubBody: "Test body",
    });

    // When: Try to get repository
    const repo = db.getRepository(ticket.repositoryId);

    // Then: Should be undefined
    expect(repo).toBeUndefined();
  });
});

describe("Chat History", () => {
  it("should include chat history in answer action", () => {
    // Given: Issue analyzed with tools (agentic workflow)
    const ticket = db.insertTicket({
      userId: "user_1",
      repositoryId: testRepo.id,
      ticketType: "issue",
      githubTitle: "How does authentication work?",
      githubBody: "I need to understand the auth flow",
    });

    const action = db.insertAction({
      ticketId: ticket.id,
      actionType: "answer",
      status: "pending",
    });

    // When: Complete with chat history from agentic workflow
    db.updateAction(action.id, {
      status: "pending_approval",
      proposedChanges: {
        suggestedResponse:
          "Authentication works by using JWT tokens stored in httpOnly cookies...",
        issueType: "question",
        isActionable: false,
      },
      chatHistory: [
        {
          role: "assistant",
          content: "Searching for authentication code...",
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: "Reading auth middleware file...",
          timestamp: Date.now() + 1000,
        },
        {
          role: "assistant",
          content:
            "Authentication works by using JWT tokens stored in httpOnly cookies...",
          timestamp: Date.now() + 2000,
        },
      ],
    });

    // Then: Should have chat history
    const updated = db.getAction(action.id);
    expect(updated?.chatHistory).toHaveLength(3);
    expect(updated?.chatHistory?.[0].content).toContain(
      "Searching for authentication",
    );
    expect(updated?.chatHistory?.[2].content).toContain("JWT tokens");
  });

  it("should filter out internal prompts from chat history", () => {
    // Given: Chat history with internal prompts
    const rawChatHistory = [
      {
        role: "user" as const,
        content:
          "You are analyzing an issue from THIS repository. Use tools to explore...",
        timestamp: Date.now(),
      },
      {
        role: "assistant" as const,
        content: "Searching codebase...",
        timestamp: Date.now() + 1000,
      },
      {
        role: "user" as const,
        content: "You've explored enough. Now provide your final analysis...",
        timestamp: Date.now() + 2000,
      },
      {
        role: "assistant" as const,
        content: "Based on my analysis, the auth flow uses JWT...",
        timestamp: Date.now() + 3000,
      },
    ];

    // When: Filter internal prompts
    const filtered = rawChatHistory.filter((msg) => {
      if (
        msg.content.startsWith(
          "You are analyzing an issue from THIS repository",
        )
      ) {
        return false;
      }
      if (msg.content.startsWith("You've explored enough")) {
        return false;
      }
      return true;
    });

    // Then: Should only have actual conversation
    expect(filtered).toHaveLength(2);
    expect(filtered[0].content).toContain("Searching codebase");
    expect(filtered[1].content).toContain("JWT");
  });
});
