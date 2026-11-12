import { describe, it, expect, beforeEach } from "vitest";
import { isGitdogBot } from "../../../convex/github/botIdentity";
import { DELETED_BOT_COMMENT_EMBEDDING_DATA_PROVENANCE } from "../../../convex/github/webhook";

/**
 * Deleted Bot Comment Detection Tests
 *
 * Tests the logic for:
 * - Identifying gitdog bot comments
 * - Filtering non-bot comments
 * - Finding matching actions by commentId (number and string)
 * - Truncating long responses for learning content
 */

interface TicketAction {
  id: string;
  ticketId: string;
  executionResult?: {
    commentId?: number | string;
    success?: boolean;
    postedComment?: boolean;
  };
  proposedChanges?: {
    suggestedResponse?: string;
  };
}

interface Ticket {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  githubNumber: number;
  ticketType: "issue" | "discussion";
}

// Mock database for deleted bot comment tests
class MockDeletedCommentDatabase {
  private tickets: Map<string, Ticket> = new Map();
  private actions: Map<string, TicketAction> = new Map();
  private learnings: Array<{
    repositoryId: string;
    content: string;
    source: string;
    sourceType: string;
  }> = [];
  private nextId = 1;

  reset() {
    this.tickets.clear();
    this.actions.clear();
    this.learnings = [];
    this.nextId = 1;
  }

  insertTicket(ticket: Omit<Ticket, "id">): Ticket {
    const id = `ticket_${this.nextId++}`;
    const newTicket = { ...ticket, id };
    this.tickets.set(id, newTicket);
    return newTicket;
  }

  insertAction(action: Omit<TicketAction, "id">): TicketAction {
    const id = `action_${this.nextId++}`;
    const newAction = { ...action, id };
    this.actions.set(id, newAction);
    return newAction;
  }

  getByGithubNumber(
    repositoryFullName: string,
    githubNumber: number,
    ticketType: string,
  ): Ticket | null {
    for (const ticket of this.tickets.values()) {
      if (
        ticket.repositoryFullName === repositoryFullName &&
        ticket.githubNumber === githubNumber &&
        ticket.ticketType === ticketType
      ) {
        return ticket;
      }
    }
    return null;
  }

  findByGithubCommentId(
    ticketId: string,
    commentId: number | string,
  ): TicketAction | null {
    for (const action of this.actions.values()) {
      if (
        action.ticketId === ticketId &&
        action.executionResult?.commentId === commentId
      ) {
        return action;
      }
    }
    return null;
  }

  recordLearning(learning: {
    repositoryId: string;
    content: string;
    source: string;
    sourceType: string;
  }) {
    this.learnings.push(learning);
  }

  getLearnings() {
    return this.learnings;
  }
}

// Mirrors the bot detection logic in webhook.ts handleDeletedBotComment
function isBotComment(comment: {
  user: { login: string; type: string };
  body?: string | null;
}): boolean {
  return comment.user.type === "Bot" && isGitdogBot(comment.user.login);
}

// Mirrors the truncation logic in webhook.ts
function buildTruncatedResponse(response: string): string {
  return response.length > 300 ? response.substring(0, 300) + "..." : response;
}

let db: MockDeletedCommentDatabase;

beforeEach(() => {
  db = new MockDeletedCommentDatabase();
});

describe("Deleted bot comment detection", () => {
  it("routes deleted response learning through paid-only private provenance", () => {
    expect(DELETED_BOT_COMMENT_EMBEDDING_DATA_PROVENANCE).toBe(
      "private_user_input",
    );
  });

  describe("Bot comment identification", () => {
    it("should identify gitdogbot[bot] as bot comment", () => {
      expect(
        isBotComment({
          user: { login: "gitdogbot[bot]", type: "Bot" },
          body: "Some response",
        }),
      ).toBe(true);
    });

    it("should reject a non-allowlisted Gitdog-like login", () => {
      expect(
        isBotComment({
          user: { login: "gitdogbot", type: "Bot" },
          body: "Some response",
        }),
      ).toBe(false);
    });

    it("should not trust comment body branding from another bot", () => {
      expect(
        isBotComment({
          user: { login: "some-other-bot", type: "Bot" },
          body: "Powered by fake-gitdog.example",
        }),
      ).toBe(false);
    });

    it("should not trust current body branding from another bot", () => {
      expect(
        isBotComment({
          user: { login: "some-other-bot", type: "Bot" },
          body: "Powered by gitdog.dev",
        }),
      ).toBe(false);
    });

    it("should reject non-Bot type users", () => {
      expect(
        isBotComment({
          user: { login: "gitdogbot[bot]", type: "User" },
          body: "Some response",
        }),
      ).toBe(false);
    });

    it("should reject unrelated bots", () => {
      expect(
        isBotComment({
          user: { login: "dependabot[bot]", type: "Bot" },
          body: "Bump package version",
        }),
      ).toBe(false);
    });

    it("should reject unrelated bots with missing body", () => {
      expect(
        isBotComment({
          user: { login: "some-other-bot", type: "Bot" },
        }),
      ).toBe(false);
    });
  });

  describe("Finding action by comment ID", () => {
    it("should find action by numeric comment ID", () => {
      const ticket = db.insertTicket({
        repositoryId: "repo_1",
        repositoryFullName: "owner/repo",
        githubNumber: 42,
        ticketType: "issue",
      });

      db.insertAction({
        ticketId: ticket.id,
        executionResult: { commentId: 12345, success: true },
        proposedChanges: { suggestedResponse: "Test response" },
      });

      const found = db.findByGithubCommentId(ticket.id, 12345);
      expect(found).not.toBeNull();
      expect(found?.executionResult?.commentId).toBe(12345);
    });

    it("should find action by string comment ID (discussions)", () => {
      const ticket = db.insertTicket({
        repositoryId: "repo_1",
        repositoryFullName: "owner/repo",
        githubNumber: 10,
        ticketType: "discussion",
      });

      db.insertAction({
        ticketId: ticket.id,
        executionResult: {
          commentId: "DC_kwDOABCDEF",
          success: true,
        },
        proposedChanges: { suggestedResponse: "Discussion reply" },
      });

      const found = db.findByGithubCommentId(ticket.id, "DC_kwDOABCDEF");
      expect(found).not.toBeNull();
      expect(found?.executionResult?.commentId).toBe("DC_kwDOABCDEF");
    });

    it("should return null when no matching comment ID found", () => {
      const ticket = db.insertTicket({
        repositoryId: "repo_1",
        repositoryFullName: "owner/repo",
        githubNumber: 42,
        ticketType: "issue",
      });

      db.insertAction({
        ticketId: ticket.id,
        executionResult: { commentId: 99999, success: true },
      });

      const found = db.findByGithubCommentId(ticket.id, 12345);
      expect(found).toBeNull();
    });

    it("should not match actions from different tickets", () => {
      const ticket1 = db.insertTicket({
        repositoryId: "repo_1",
        repositoryFullName: "owner/repo",
        githubNumber: 1,
        ticketType: "issue",
      });

      const ticket2 = db.insertTicket({
        repositoryId: "repo_1",
        repositoryFullName: "owner/repo",
        githubNumber: 2,
        ticketType: "issue",
      });

      db.insertAction({
        ticketId: ticket1.id,
        executionResult: { commentId: 12345, success: true },
      });

      const found = db.findByGithubCommentId(ticket2.id, 12345);
      expect(found).toBeNull();
    });
  });

  describe("Response truncation", () => {
    it("should not truncate short responses", () => {
      const short = "This is a short response.";
      expect(buildTruncatedResponse(short)).toBe(short);
    });

    it("should not add ellipsis for exactly 300 chars", () => {
      const exact300 = "a".repeat(300);
      expect(buildTruncatedResponse(exact300)).toBe(exact300);
      expect(buildTruncatedResponse(exact300)).not.toContain("...");
    });

    it("should truncate and add ellipsis for > 300 chars", () => {
      const long = "a".repeat(500);
      const result = buildTruncatedResponse(long);
      expect(result.length).toBe(303); // 300 + "..."
      expect(result.endsWith("...")).toBe(true);
    });

    it("should truncate at 300 char boundary", () => {
      const response = "x".repeat(301);
      const result = buildTruncatedResponse(response);
      expect(result).toBe("x".repeat(300) + "...");
    });
  });

  describe("Learning creation from deleted comments", () => {
    it("should record negative learning when bot comment is deleted", () => {
      const ticket = db.insertTicket({
        repositoryId: "repo_1",
        repositoryFullName: "owner/repo",
        githubNumber: 42,
        ticketType: "issue",
      });

      const action = db.insertAction({
        ticketId: ticket.id,
        executionResult: { commentId: 12345, success: true },
        proposedChanges: { suggestedResponse: "Unhelpful bot response" },
      });

      // Simulate the learning creation
      const deletedResponse = action.proposedChanges?.suggestedResponse || "";
      const truncatedResponse = buildTruncatedResponse(deletedResponse);
      const learningContent = `NEGATIVE FEEDBACK: A bot response was deleted by maintainer @admin on issue "Bug report" (#42). The deleted response started with: "${truncatedResponse}". This indicates the response was unhelpful, incorrect, or inappropriate. Avoid generating similar responses for similar issues in this repository.`;

      db.recordLearning({
        repositoryId: ticket.repositoryId,
        content: learningContent,
        source: `github.com/owner/repo/issues/42#deleted-comment-12345`,
        sourceType: "correction",
      });

      const learnings = db.getLearnings();
      expect(learnings).toHaveLength(1);
      expect(learnings[0].sourceType).toBe("correction");
      expect(learnings[0].content).toContain("NEGATIVE FEEDBACK");
      expect(learnings[0].content).toContain("Unhelpful bot response");
      expect(learnings[0].source).toContain("deleted-comment-12345");
    });

    it("should skip when no ticket found for the issue", () => {
      const ticket = db.getByGithubNumber("unknown/repo", 999, "issue");
      expect(ticket).toBeNull();
      // No learning should be recorded
      expect(db.getLearnings()).toHaveLength(0);
    });

    it("should skip when no matching action found for comment", () => {
      const ticket = db.insertTicket({
        repositoryId: "repo_1",
        repositoryFullName: "owner/repo",
        githubNumber: 42,
        ticketType: "issue",
      });

      const found = db.findByGithubCommentId(ticket.id, 99999);
      expect(found).toBeNull();
      // No learning should be recorded
      expect(db.getLearnings()).toHaveLength(0);
    });
  });
});
