import { describe, it, expect } from "vitest";
import { getRepositoryAiReadiness } from "../../../convex/repositories/aiReadiness";

/**
 * Unit Tests for tickets module changes
 *
 * Tests verify the logic changes made to:
 * - tickets/internalMutation.ts (query optimization + ticketType filtering)
 * - tickets/internalQuery.ts (query optimization + ticketType parameter)
 *
 * These are logic-based unit tests that verify the filtering behavior
 * without requiring a full Convex test environment.
 */

// Type definitions matching the schema
type TicketType = "issue" | "discussion";
type TicketStatus = "open" | "closed";
type IndexStatus = "pending" | "indexing" | "completed" | "failed";
type ClosableTicketType = "issue" | "discussion";

interface Repository {
  _id: string;
  githubRepo: string;
  installationId: number;
  userId: string;
  isActive: boolean;
  indexStatus: IndexStatus;
  ragStatus: IndexStatus;
  indexVersion: number;
  indexSyncPending: boolean;
  ragTotalChunks: number;
  ragIndexedChunks: number;
  ragFailedChunks: number;
  settings: {
    issueAssistantEnabled: boolean;
    discussionAssistantEnabled: boolean;
  };
}

interface GithubInstallation {
  _id: string;
  installationId: number;
  userId: string;
  accountLogin: string;
}

interface Ticket {
  _id: string;
  repositoryId: string;
  userId: string;
  githubRepo: string;
  ticketType: TicketType;
  githubNumber: number;
  githubTitle: string;
  githubBody?: string;
  status: TicketStatus;
  createdAt: number;
  closedAt?: number;
}

/**
 * Simulates the ticketType filtering logic used in createFromGithubIssue
 */
function findIssueTicket(tickets: Ticket[]): Ticket | undefined {
  return tickets.find((t) => t.ticketType === "issue");
}

/**
 * Simulates the ticketType filtering logic used in createFromGithubDiscussion
 */
function findDiscussionTicket(tickets: Ticket[]): Ticket | undefined {
  return tickets.find((t) => t.ticketType === "discussion");
}

/**
 * Simulates the type-safe open ticket filtering used in closeByGithubNumber
 */
function findOpenTicket(
  tickets: Ticket[],
  ticketType: ClosableTicketType,
): Ticket | undefined {
  return tickets.find(
    (ticket) => ticket.ticketType === ticketType && ticket.status === "open",
  );
}

/**
 * Simulates the repository safety gate used before new ticket AI work.
 */
function canStartNewTicketAiWork(repository: Repository): boolean {
  return getRepositoryAiReadiness(repository).state === "ready";
}

/**
 * Simulates the getByGithubNumber query logic with optional ticketType
 */
function getByGithubNumber(
  tickets: Ticket[],
  ticketType?: TicketType,
): Ticket | null {
  if (ticketType) {
    return tickets.find((t) => t.ticketType === ticketType) ?? null;
  }
  return tickets[0] ?? null;
}

// Test data factory
function createTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    _id: `ticket_${Math.random().toString(36).substr(2, 9)}`,
    repositoryId: "repo_123",
    userId: "user_123",
    githubRepo: "owner/test-repo",
    ticketType: "issue",
    githubNumber: 1,
    githubTitle: "Test Issue",
    githubBody: "Test body",
    status: "open",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("tickets module - mutation and query changes", () => {
  describe("new AI work readiness gate", () => {
    it("allows work only when the repository and both indexes are ready", () => {
      const repository = createRepository();

      expect(canStartNewTicketAiWork(repository)).toBe(true);
    });

    it("blocks work for an inactive repository", () => {
      const repository = createRepository({ isActive: false });

      expect(canStartNewTicketAiWork(repository)).toBe(false);
    });

    it.each<IndexStatus>(["pending", "indexing", "failed"])(
      "blocks work while the file index status is %s",
      (indexStatus) => {
        const repository = createRepository({ indexStatus });

        expect(canStartNewTicketAiWork(repository)).toBe(false);
      },
    );

    it.each<IndexStatus>(["pending", "indexing", "failed"])(
      "blocks work while the RAG index status is %s",
      (ragStatus) => {
        const repository = createRepository({ ragStatus });

        expect(canStartNewTicketAiWork(repository)).toBe(false);
      },
    );
  });

  describe("Issue and Discussion number collision handling", () => {
    it("should correctly identify issue ticket when both exist with same number", () => {
      const issueTicket = createTicket({
        ticketType: "issue",
        githubNumber: 1,
        githubTitle: "Issue #1",
      });
      const discussionTicket = createTicket({
        ticketType: "discussion",
        githubNumber: 1,
        githubTitle: "Discussion #1",
      });

      const tickets = [issueTicket, discussionTicket];

      const foundIssue = findIssueTicket(tickets);
      const foundDiscussion = findDiscussionTicket(tickets);

      expect(foundIssue).toBe(issueTicket);
      expect(foundIssue?.githubTitle).toBe("Issue #1");
      expect(foundDiscussion).toBe(discussionTicket);
      expect(foundDiscussion?.githubTitle).toBe("Discussion #1");
    });

    it("should return undefined when looking for issue but only discussion exists", () => {
      const discussionTicket = createTicket({
        ticketType: "discussion",
        githubNumber: 1,
      });

      const tickets = [discussionTicket];

      const foundIssue = findIssueTicket(tickets);
      expect(foundIssue).toBeUndefined();
    });

    it("should return undefined when looking for discussion but only issue exists", () => {
      const issueTicket = createTicket({
        ticketType: "issue",
        githubNumber: 1,
      });

      const tickets = [issueTicket];

      const foundDiscussion = findDiscussionTicket(tickets);
      expect(foundDiscussion).toBeUndefined();
    });
  });

  describe("createFromGithubIssue - ticketType filtering", () => {
    it("should not modify discussion ticket when creating/updating issue with same number", () => {
      // Simulates: existingTickets.find((t) => t.ticketType === "issue")
      const discussionTicket = createTicket({
        ticketType: "discussion",
        githubNumber: 5,
        githubTitle: "Discussion #5",
        githubBody: "Discussion body",
      });

      const tickets = [discussionTicket];
      const existingIssue = findIssueTicket(tickets);

      // Should NOT find any issue ticket
      expect(existingIssue).toBeUndefined();

      // This means a NEW issue ticket would be created, not updating the discussion
    });

    it("should find and update existing issue ticket", () => {
      const issueTicket = createTicket({
        ticketType: "issue",
        githubNumber: 10,
        githubTitle: "Original Title",
      });

      const tickets = [issueTicket];
      const existingIssue = findIssueTicket(tickets);

      expect(existingIssue).toBeDefined();
      expect(existingIssue?._id).toBe(issueTicket._id);
    });

    it("should find issue even when discussion exists with same number", () => {
      const issueTicket = createTicket({
        ticketType: "issue",
        githubNumber: 7,
        githubTitle: "Issue #7",
      });
      const discussionTicket = createTicket({
        ticketType: "discussion",
        githubNumber: 7,
        githubTitle: "Discussion #7",
      });

      const tickets = [issueTicket, discussionTicket];
      const existingIssue = findIssueTicket(tickets);

      expect(existingIssue).toBe(issueTicket);
      expect(existingIssue?.githubTitle).toBe("Issue #7");
    });
  });

  describe("createFromGithubDiscussion - ticketType filtering", () => {
    it("should not modify issue ticket when creating/updating discussion with same number", () => {
      const issueTicket = createTicket({
        ticketType: "issue",
        githubNumber: 7,
        githubTitle: "Issue #7",
        githubBody: "Issue body",
      });

      const tickets = [issueTicket];
      const existingDiscussion = findDiscussionTicket(tickets);

      // Should NOT find any discussion ticket
      expect(existingDiscussion).toBeUndefined();
    });

    it("should find and update existing discussion ticket", () => {
      const discussionTicket = createTicket({
        ticketType: "discussion",
        githubNumber: 20,
        githubTitle: "Original Discussion",
      });

      const tickets = [discussionTicket];
      const existingDiscussion = findDiscussionTicket(tickets);

      expect(existingDiscussion).toBeDefined();
      expect(existingDiscussion?._id).toBe(discussionTicket._id);
    });
  });

  describe("closeByGithubNumber - open ticket filtering", () => {
    it("should close the open ticket when multiple tickets exist", () => {
      const closedIssue = createTicket({
        ticketType: "issue",
        githubNumber: 3,
        status: "closed",
        closedAt: Date.now() - 10000,
      });
      const openDiscussion = createTicket({
        ticketType: "discussion",
        githubNumber: 3,
        status: "open",
      });

      const tickets = [closedIssue, openDiscussion];
      const ticketToClose = findOpenTicket(tickets, "discussion");

      expect(ticketToClose).toBe(openDiscussion);
      expect(ticketToClose?.status).toBe("open");
    });

    it("should return undefined when no open ticket exists", () => {
      const closedIssue = createTicket({
        ticketType: "issue",
        githubNumber: 999,
        status: "closed",
      });

      const tickets = [closedIssue];
      const ticketToClose = findOpenTicket(tickets, "issue");

      expect(ticketToClose).toBeUndefined();
    });

    it("should close only the requested type when both are open", () => {
      const openIssue = createTicket({
        ticketType: "issue",
        githubNumber: 15,
        status: "open",
      });
      const openDiscussion = createTicket({
        ticketType: "discussion",
        githubNumber: 15,
        status: "open",
      });

      const tickets = [openIssue, openDiscussion];
      expect(findOpenTicket(tickets, "issue")).toBe(openIssue);
      expect(findOpenTicket(tickets, "discussion")).toBe(openDiscussion);
    });

    it("should not close another type when the requested type has no open ticket", () => {
      const closedIssue = createTicket({
        ticketType: "issue",
        githubNumber: 15,
        status: "closed",
      });
      const openDiscussion = createTicket({
        ticketType: "discussion",
        githubNumber: 15,
        status: "open",
      });

      expect(
        findOpenTicket([closedIssue, openDiscussion], "issue"),
      ).toBeUndefined();
    });
  });

  describe("getByGithubNumber - ticketType parameter", () => {
    it("should return issue ticket when ticketType is 'issue'", () => {
      const issueTicket = createTicket({
        ticketType: "issue",
        githubNumber: 42,
        githubTitle: "Issue #42",
      });
      const discussionTicket = createTicket({
        ticketType: "discussion",
        githubNumber: 42,
        githubTitle: "Discussion #42",
      });

      const tickets = [issueTicket, discussionTicket];
      const result = getByGithubNumber(tickets, "issue");

      expect(result).toBe(issueTicket);
      expect(result?.ticketType).toBe("issue");
      expect(result?.githubTitle).toBe("Issue #42");
    });

    it("should return discussion ticket when ticketType is 'discussion'", () => {
      const issueTicket = createTicket({
        ticketType: "issue",
        githubNumber: 42,
        githubTitle: "Issue #42",
      });
      const discussionTicket = createTicket({
        ticketType: "discussion",
        githubNumber: 42,
        githubTitle: "Discussion #42",
      });

      const tickets = [issueTicket, discussionTicket];
      const result = getByGithubNumber(tickets, "discussion");

      expect(result).toBe(discussionTicket);
      expect(result?.ticketType).toBe("discussion");
      expect(result?.githubTitle).toBe("Discussion #42");
    });

    it("should return first ticket when ticketType is not specified", () => {
      const issueTicket = createTicket({
        ticketType: "issue",
        githubNumber: 100,
        githubTitle: "Issue #100",
      });

      const tickets = [issueTicket];
      const result = getByGithubNumber(tickets);

      expect(result).toBeDefined();
      expect(result?.githubTitle).toBe("Issue #100");
    });

    it("should return null when ticket not found with specified ticketType", () => {
      const issueTicket = createTicket({
        ticketType: "issue",
        githubNumber: 50,
        githubTitle: "Issue #50",
      });

      const tickets = [issueTicket];
      const result = getByGithubNumber(tickets, "discussion");

      expect(result).toBeNull();
    });

    it("should return null for empty ticket array", () => {
      const tickets: Ticket[] = [];
      const result = getByGithubNumber(tickets);

      expect(result).toBeNull();
    });

    it("should return null for empty array with ticketType specified", () => {
      const tickets: Ticket[] = [];
      const result = getByGithubNumber(tickets, "issue");

      expect(result).toBeNull();
    });
  });

  describe("Regression prevention - edge cases", () => {
    it("should handle multiple tickets of same type correctly", () => {
      const issue1 = createTicket({
        _id: "issue_1",
        ticketType: "issue",
        githubNumber: 1,
        githubTitle: "First Issue",
      });
      const issue2 = createTicket({
        _id: "issue_2",
        ticketType: "issue",
        githubNumber: 1,
        githubTitle: "Second Issue",
      });

      const tickets = [issue1, issue2];

      // Should return first match
      const found = findIssueTicket(tickets);
      expect(found).toBe(issue1);
    });

    it("should correctly filter by status for closing", () => {
      const closedTicket1 = createTicket({
        _id: "closed_1",
        status: "closed",
        closedAt: Date.now() - 20000,
      });
      const closedTicket2 = createTicket({
        _id: "closed_2",
        status: "closed",
        closedAt: Date.now() - 10000,
      });

      const tickets = [closedTicket1, closedTicket2];

      // No open ticket should be found
      expect(findOpenTicket(tickets, "issue")).toBeUndefined();
    });

    it("should preserve data integrity when filtering", () => {
      const originalTicket = createTicket({
        ticketType: "issue",
        githubNumber: 999,
        githubTitle: "Original Title",
        githubBody: "Original Body",
        status: "open",
        createdAt: 1234567890,
      });

      const tickets = [originalTicket];
      const found = findIssueTicket(tickets);

      // All properties should be preserved
      expect(found?._id).toBe(originalTicket._id);
      expect(found?.ticketType).toBe("issue");
      expect(found?.githubNumber).toBe(999);
      expect(found?.githubTitle).toBe("Original Title");
      expect(found?.githubBody).toBe("Original Body");
      expect(found?.status).toBe("open");
      expect(found?.createdAt).toBe(1234567890);
    });
  });
});

/**
 * Pure model tests for the fail-closed webhook installation boundary. A
 * reinstall must reconcile the repository row before a webhook from the new
 * installation can route tickets.
 */

// Factory functions for test data
function createRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    _id: `repo_${Math.random().toString(36).substr(2, 9)}`,
    githubRepo: "owner/test-repo",
    installationId: 12345,
    userId: "user_123",
    isActive: true,
    indexStatus: "completed",
    ragStatus: "completed",
    indexVersion: 1,
    indexSyncPending: false,
    ragTotalChunks: 0,
    ragIndexedChunks: 0,
    ragFailedChunks: 0,
    settings: {
      issueAssistantEnabled: true,
      discussionAssistantEnabled: true,
    },
    ...overrides,
  };
}

function createGithubInstallation(
  overrides: Partial<GithubInstallation> = {},
): GithubInstallation {
  return {
    _id: `install_${Math.random().toString(36).substr(2, 9)}`,
    installationId: 12345,
    userId: "user_123",
    accountLogin: "owner",
    ...overrides,
  };
}

/**
 * Simulates the findRepositoryWithAutoUpdate logic
 * This is a pure function version for testing the decision logic
 */
function findRepositoryWithAutoUpdateLogic(
  repositories: Repository[],
  installations: GithubInstallation[],
  webhookInstallationId: number,
  repositoryFullName: string,
): {
  repository: Repository | null;
  shouldAutoUpdate: boolean;
  newInstallationId?: number;
} {
  void installations;
  // Step 1: Try to find by installationId + githubRepo (fast path)
  const directMatch = repositories.find(
    (r) =>
      r.installationId === webhookInstallationId &&
      r.githubRepo === repositoryFullName,
  );

  if (directMatch) {
    return { repository: directMatch, shouldAutoUpdate: false };
  }

  return { repository: null, shouldAutoUpdate: false };
}

describe("ticket webhook repository installation boundary", () => {
  describe("Fast path - direct match by installationId + githubRepo", () => {
    it("should return repository directly when installationId matches", () => {
      const repo = createRepository({
        installationId: 12345,
        githubRepo: "hyochan/expo-iap",
      });

      const result = findRepositoryWithAutoUpdateLogic(
        [repo],
        [],
        12345, // same installationId
        "hyochan/expo-iap",
      );

      expect(result.repository).toBe(repo);
      expect(result.shouldAutoUpdate).toBe(false);
    });

    it("should not auto-update when installationId already matches", () => {
      const repo = createRepository({
        installationId: 99999,
        githubRepo: "owner/repo",
      });
      const installation = createGithubInstallation({
        installationId: 99999,
        userId: repo.userId,
      });

      const result = findRepositoryWithAutoUpdateLogic(
        [repo],
        [installation],
        99999,
        "owner/repo",
      );

      expect(result.shouldAutoUpdate).toBe(false);
      expect(result.newInstallationId).toBeUndefined();
    });
  });

  describe("Stale installation fail-closed path", () => {
    it("does not route by mutable name under a different installation", () => {
      const repo = createRepository({
        installationId: 11111, // old installationId
        githubRepo: "hyochan/expo-iap",
        userId: "user_abc",
      });
      const installation = createGithubInstallation({
        installationId: 22222, // new installationId
        userId: "user_abc", // same user
      });

      const result = findRepositoryWithAutoUpdateLogic(
        [repo],
        [installation],
        22222, // webhook comes with new installationId
        "hyochan/expo-iap",
      );

      expect(result.repository).toBeNull();
      expect(result.shouldAutoUpdate).toBe(false);
      expect(result.newInstallationId).toBeUndefined();
    });

    it("waits for reconciliation after a GitHub App reinstall", () => {
      // User had installationId 104575964, then reinstalled and got 104576047
      const repo = createRepository({
        installationId: 104575964, // old (org) installation
        githubRepo: "hyochan/expo-iap",
        userId: "user_hyochan",
      });
      const newInstallation = createGithubInstallation({
        installationId: 104576047, // new (user) installation
        userId: "user_hyochan",
        accountLogin: "hyochan",
      });

      const result = findRepositoryWithAutoUpdateLogic(
        [repo],
        [newInstallation],
        104576047, // webhook from new installation
        "hyochan/expo-iap",
      );

      expect(result.repository).toBeNull();
      expect(result.shouldAutoUpdate).toBe(false);
      expect(result.newInstallationId).toBeUndefined();
    });
  });

  describe("Security - user mismatch prevention", () => {
    it("should NOT auto-update when installation belongs to different user", () => {
      const repo = createRepository({
        installationId: 11111,
        githubRepo: "owner/private-repo",
        userId: "user_alice",
      });
      const maliciousInstallation = createGithubInstallation({
        installationId: 99999,
        userId: "user_bob", // different user!
      });

      const result = findRepositoryWithAutoUpdateLogic(
        [repo],
        [maliciousInstallation],
        99999, // attacker's installationId
        "owner/private-repo",
      );

      expect(result.repository).toBeNull();
      expect(result.shouldAutoUpdate).toBe(false);
    });

    it("should NOT auto-update when installation not found", () => {
      const repo = createRepository({
        installationId: 11111,
        githubRepo: "owner/repo",
        userId: "user_alice",
      });

      const result = findRepositoryWithAutoUpdateLogic(
        [repo],
        [], // no installations
        99999,
        "owner/repo",
      );

      expect(result.repository).toBeNull();
      expect(result.shouldAutoUpdate).toBe(false);
    });
  });

  describe("Repository not found scenarios", () => {
    it("should return null when repository does not exist", () => {
      const result = findRepositoryWithAutoUpdateLogic(
        [], // no repositories
        [],
        12345,
        "nonexistent/repo",
      );

      expect(result.repository).toBeNull();
      expect(result.shouldAutoUpdate).toBe(false);
    });

    it("should return null when githubRepo does not match", () => {
      const repo = createRepository({
        githubRepo: "owner/different-repo",
      });

      const result = findRepositoryWithAutoUpdateLogic(
        [repo],
        [],
        12345,
        "owner/target-repo",
      );

      expect(result.repository).toBeNull();
    });
  });

  describe("Multiple repositories scenarios", () => {
    it("should find correct repository among multiple", () => {
      const repo1 = createRepository({
        installationId: 11111,
        githubRepo: "hyochan/repo-a",
        userId: "user_1",
      });
      const repo2 = createRepository({
        installationId: 22222,
        githubRepo: "hyochan/repo-b",
        userId: "user_1",
      });
      const repo3 = createRepository({
        installationId: 33333,
        githubRepo: "other/repo-c",
        userId: "user_2",
      });

      const result = findRepositoryWithAutoUpdateLogic(
        [repo1, repo2, repo3],
        [],
        22222,
        "hyochan/repo-b",
      );

      expect(result.repository).toBe(repo2);
      expect(result.shouldAutoUpdate).toBe(false);
    });

    it("does not transfer any repository by mutable name", () => {
      const targetRepo = createRepository({
        installationId: 11111, // stale
        githubRepo: "hyochan/expo-iap",
        userId: "user_hyochan",
      });
      const otherRepo = createRepository({
        installationId: 22222,
        githubRepo: "hyochan/other-repo",
        userId: "user_hyochan",
      });
      const newInstallation = createGithubInstallation({
        installationId: 99999, // new
        userId: "user_hyochan",
      });

      const result = findRepositoryWithAutoUpdateLogic(
        [targetRepo, otherRepo],
        [newInstallation],
        99999,
        "hyochan/expo-iap",
      );

      expect(result.repository).toBeNull();
      expect(result.shouldAutoUpdate).toBe(false);
      expect(result.newInstallationId).toBeUndefined();
    });
  });

  describe("Edge cases", () => {
    it("should handle repository with same name but different installation", () => {
      // Edge case: same repo name exists with matching installationId for different user
      const repo = createRepository({
        installationId: 12345,
        githubRepo: "common/repo-name",
        userId: "user_alice",
      });

      // Direct match should work
      const result = findRepositoryWithAutoUpdateLogic(
        [repo],
        [],
        12345,
        "common/repo-name",
      );

      expect(result.repository).toBe(repo);
      expect(result.shouldAutoUpdate).toBe(false);
    });

    it("returns no repository for a stale installation decision", () => {
      const repo = createRepository({
        _id: "repo_specific_id",
        installationId: 11111,
        githubRepo: "owner/repo",
        userId: "user_123",
        settings: {
          issueAssistantEnabled: true,
          discussionAssistantEnabled: false,
        },
      });
      const installation = createGithubInstallation({
        installationId: 22222,
        userId: "user_123",
      });

      const result = findRepositoryWithAutoUpdateLogic(
        [repo],
        [installation],
        22222,
        "owner/repo",
      );

      expect(result.repository).toBeNull();
      expect(result.shouldAutoUpdate).toBe(false);
    });
  });
});
