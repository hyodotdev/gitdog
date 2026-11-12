import { describe, it, expect } from "vitest";
import { isGitdogBot } from "../../../convex/github/botIdentity";

/**
 * Discussion Bot Detection and Maintainer Context Tests
 *
 * Test Gitdog bot identity for GitHub Discussion comments. Only Gitdog's own
 * comments should be marked as "assistant"; third-party bots remain attributed
 * user context.
 *
 * GitHub API author_association values:
 * - "OWNER" - Repository owner
 * - "MEMBER" - Organization member
 * - "COLLABORATOR" - Direct collaborator
 * - "CONTRIBUTOR" - Has contributed to the repo
 * - "NONE" - No special association
 */

// Type matching the actual getDiscussionComments return type
interface DiscussionComment {
  id: string;
  body: string;
  author: { __typename: string; login: string } | null;
  createdAt: string;
}

// Type for raw GraphQL response with nested replies
interface DiscussionCommentWithReplies {
  id: string;
  body: string;
  author: { __typename: string; login: string } | null;
  authorAssociation?: string; // OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE
  createdAt: string;
  replies?: {
    nodes: Array<{
      id: string;
      body: string;
      author: { __typename: string; login: string } | null;
      authorAssociation?: string;
      createdAt: string;
    }>;
  };
}

// Type for previous comments passed to createFollowUp
interface PreviousComment {
  id: number | string;
  body: string;
  author: string;
  authorRole?: string; // OWNER, MEMBER, COLLABORATOR, etc.
  isBot: boolean;
  createdAt: string;
}

// Function that formats author with maintainer label (matching internalMutation.ts logic)
function formatAuthor(author: string, authorRole?: string): string {
  const isMaintainer =
    authorRole === "OWNER" ||
    authorRole === "MEMBER" ||
    authorRole === "COLLABORATOR";
  return isMaintainer ? `${author} [Maintainer]` : author;
}

// Function that builds chat history for follow-up (matching internalMutation.ts logic)
function buildFollowUpChatHistory(
  previousComments: PreviousComment[],
  currentComment: {
    id: number;
    body: string;
    author: string;
    authorRole?: string;
  },
): Array<{ role: "user" | "assistant"; content: string; timestamp: number }> {
  const chatHistory: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }> = [];

  // Add previous comments as chat history
  for (const comment of previousComments) {
    // Skip the current comment being processed
    if (comment.id === currentComment.id) continue;

    const role = comment.isBot ? "assistant" : "user";
    const timestamp = new Date(comment.createdAt).getTime();

    // Include author info with role in content for context
    const authorInfo = formatAuthor(comment.author, comment.authorRole);
    const content =
      role === "user" ? `[${authorInfo}]: ${comment.body}` : comment.body;

    chatHistory.push({ role, content, timestamp });
  }

  // Add the current comment as the latest user message with author role
  const currentAuthorInfo = formatAuthor(
    currentComment.author,
    currentComment.authorRole,
  );
  chatHistory.push({
    role: "user",
    content: `[${currentAuthorInfo}]: ${currentComment.body}`,
    timestamp: Date.now(),
  });

  return chatHistory;
}

// Function that flattens comments and replies (matching helpers.ts logic)
function flattenDiscussionComments(
  topLevelComments: DiscussionCommentWithReplies[],
): DiscussionComment[] {
  const allComments: DiscussionComment[] = [];

  for (const comment of topLevelComments) {
    // Add top-level comment
    allComments.push({
      id: comment.id,
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt,
    });

    // Add replies to the top-level comment
    if (comment.replies?.nodes) {
      for (const reply of comment.replies.nodes) {
        allComments.push({
          id: reply.id,
          body: reply.body,
          author: reply.author,
          createdAt: reply.createdAt,
        });
      }
    }
  }

  // Sort by createdAt to maintain chronological order
  allComments.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return allComments;
}

// Function that matches the webhook.ts Gitdog identity logic
function detectIsBot(comment: DiscussionComment): boolean {
  return isGitdogBot(comment.author?.login);
}

// Function that builds chat history from comments (matching internalMutation.ts logic)
function buildChatHistory(
  comments: DiscussionComment[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return comments.map((comment) => ({
    role: detectIsBot(comment) ? "assistant" : "user",
    content: comment.body,
  }));
}

describe("Discussion Bot Detection", () => {
  describe("detectIsBot", () => {
    it("should detect an allowlisted Gitdog bot", () => {
      const botComment: DiscussionComment = {
        id: "DC_1",
        body: "I am a bot response",
        author: { __typename: "Bot", login: "gitdogbot[bot]" },
        createdAt: new Date().toISOString(),
      };

      expect(detectIsBot(botComment)).toBe(true);
    });

    it("should not treat an arbitrary [bot] login as Gitdog", () => {
      const botComment: DiscussionComment = {
        id: "DC_2",
        body: "Bot response",
        author: { __typename: "User", login: "some-app[bot]" },
        createdAt: new Date().toISOString(),
      };

      expect(detectIsBot(botComment)).toBe(false);
    });

    it("should detect gitdogbot[bot] as bot", () => {
      const gitdogComment: DiscussionComment = {
        id: "DC_3",
        body: "Gitdog AI response",
        author: { __typename: "Bot", login: "gitdogbot[bot]" },
        createdAt: new Date().toISOString(),
      };

      expect(detectIsBot(gitdogComment)).toBe(true);
    });

    it("should NOT detect regular user as bot", () => {
      const userComment: DiscussionComment = {
        id: "DC_4",
        body: "Human comment",
        author: { __typename: "User", login: "hyochan" },
        createdAt: new Date().toISOString(),
      };

      expect(detectIsBot(userComment)).toBe(false);
    });

    it("should NOT detect user with 'bot' in name (but not [bot] suffix)", () => {
      const userComment: DiscussionComment = {
        id: "DC_5",
        body: "I have bot in my name",
        author: { __typename: "User", login: "robotics_developer" },
        createdAt: new Date().toISOString(),
      };

      expect(detectIsBot(userComment)).toBe(false);
    });

    it("should handle null author gracefully", () => {
      const deletedAuthorComment: DiscussionComment = {
        id: "DC_6",
        body: "Comment from deleted user",
        author: null,
        createdAt: new Date().toISOString(),
      };

      expect(detectIsBot(deletedAuthorComment)).toBe(false);
    });

    it("should keep dependabot in attributed user context", () => {
      const dependabotComment: DiscussionComment = {
        id: "DC_7",
        body: "Dependabot security update",
        author: { __typename: "Bot", login: "dependabot[bot]" },
        createdAt: new Date().toISOString(),
      };

      expect(detectIsBot(dependabotComment)).toBe(false);
    });

    it("should keep github-actions in attributed user context", () => {
      const actionsComment: DiscussionComment = {
        id: "DC_8",
        body: "CI/CD notification",
        author: { __typename: "Bot", login: "github-actions[bot]" },
        createdAt: new Date().toISOString(),
      };

      expect(detectIsBot(actionsComment)).toBe(false);
    });
  });

  describe("buildChatHistory", () => {
    it("should assign assistant role to bot comments", () => {
      const comments: DiscussionComment[] = [
        {
          id: "DC_1",
          body: "User question",
          author: { __typename: "User", login: "user1" },
          createdAt: "2024-01-01T10:00:00Z",
        },
        {
          id: "DC_2",
          body: "Bot response",
          author: { __typename: "Bot", login: "gitdogbot[bot]" },
          createdAt: "2024-01-01T10:01:00Z",
        },
      ];

      const history = buildChatHistory(comments);

      expect(history).toEqual([
        { role: "user", content: "User question" },
        { role: "assistant", content: "Bot response" },
      ]);
    });

    it("should handle conversation with multiple exchanges", () => {
      const comments: DiscussionComment[] = [
        {
          id: "DC_1",
          body: "Initial question",
          author: { __typename: "User", login: "hyochan" },
          createdAt: "2024-01-01T10:00:00Z",
        },
        {
          id: "DC_2",
          body: "First AI response",
          author: { __typename: "Bot", login: "gitdogbot[bot]" },
          createdAt: "2024-01-01T10:01:00Z",
        },
        {
          id: "DC_3",
          body: "Follow-up question",
          author: { __typename: "User", login: "hyochan" },
          createdAt: "2024-01-01T10:02:00Z",
        },
        {
          id: "DC_4",
          body: "Second AI response",
          author: { __typename: "Bot", login: "gitdogbot[bot]" },
          createdAt: "2024-01-01T10:03:00Z",
        },
      ];

      const history = buildChatHistory(comments);

      expect(history).toHaveLength(4);
      expect(history[0].role).toBe("user");
      expect(history[1].role).toBe("assistant");
      expect(history[2].role).toBe("user");
      expect(history[3].role).toBe("assistant");
    });

    it("should handle conversation with multiple users", () => {
      const comments: DiscussionComment[] = [
        {
          id: "DC_1",
          body: "Question from user 1",
          author: { __typename: "User", login: "user1" },
          createdAt: "2024-01-01T10:00:00Z",
        },
        {
          id: "DC_2",
          body: "AI response",
          author: { __typename: "Bot", login: "gitdogbot[bot]" },
          createdAt: "2024-01-01T10:01:00Z",
        },
        {
          id: "DC_3",
          body: "Comment from user 2",
          author: { __typename: "User", login: "user2" },
          createdAt: "2024-01-01T10:02:00Z",
        },
      ];

      const history = buildChatHistory(comments);

      expect(history).toEqual([
        { role: "user", content: "Question from user 1" },
        { role: "assistant", content: "AI response" },
        { role: "user", content: "Comment from user 2" },
      ]);
    });

    it("should handle empty comments array", () => {
      const history = buildChatHistory([]);
      expect(history).toEqual([]);
    });

    it("should treat comments with null author as user", () => {
      const comments: DiscussionComment[] = [
        {
          id: "DC_1",
          body: "Comment from deleted user",
          author: null,
          createdAt: "2024-01-01T10:00:00Z",
        },
      ];

      const history = buildChatHistory(comments);

      expect(history).toEqual([
        { role: "user", content: "Comment from deleted user" },
      ]);
    });
  });

  describe("Real-world Scenarios", () => {
    it("should correctly identify gitdog's previous response in follow-up", () => {
      // This is the exact scenario from the bug report:
      // User asks question -> gitdog responds -> maintainer replies
      // gitdog should recognize its previous response as "assistant"
      const comments: DiscussionComment[] = [
        {
          id: "DC_1",
          body: "what a different here: validatePurchaseOnServer vs isAlreadyProcessed",
          author: { __typename: "User", login: "iim-norse" },
          createdAt: "2024-01-01T10:00:00Z",
        },
        {
          id: "DC_2",
          body: "Key Difference:\n\nBoth approaches call your backend...",
          author: { __typename: "Bot", login: "gitdogbot[bot]" },
          createdAt: "2024-01-01T10:01:00Z",
        },
        {
          id: "DC_3",
          body: "@GitDog Good explanation! One small addition...",
          author: { __typename: "User", login: "hyochan" },
          createdAt: "2024-01-01T10:02:00Z",
        },
      ];

      const history = buildChatHistory(comments);

      // Critical: gitdog's response should be "assistant", not "user"
      expect(history[1].role).toBe("assistant");
      expect(history[1].content).toContain("Key Difference");

      // Maintainer's reply should be "user"
      expect(history[2].role).toBe("user");
    });

    it("should handle the scenario where gitdog loses context", () => {
      // Bug scenario: gitdog responding "I don't have any record of a previous response"
      // This happens when previous gitdog comments are marked as "user" instead of "assistant"
      const commentsWithCorrectDetection: DiscussionComment[] = [
        {
          id: "DC_1",
          body: "Initial question",
          author: { __typename: "User", login: "user1" },
          createdAt: "2024-01-01T10:00:00Z",
        },
        {
          id: "DC_2",
          body: "Current (incomplete) code:\n\n```js\nif (await isAlreadyProcessed...",
          author: { __typename: "Bot", login: "gitdogbot[bot]" },
          createdAt: "2024-01-01T10:01:00Z",
        },
      ];

      const history = buildChatHistory(commentsWithCorrectDetection);

      // With correct bot detection, AI knows it wrote the previous response
      expect(history[1].role).toBe("assistant");

      // This allows AI to continue from where it left off
      // instead of saying "I don't have any record of a previous response"
    });
  });

  describe("flattenDiscussionComments (nested replies)", () => {
    it("should flatten top-level comments with their replies", () => {
      // Simulating the actual GitHub Discussion structure:
      // - User asks question (top-level comment)
      // - Gitdog responds (top-level comment)
      // - Maintainer replies to gitdog's comment (nested reply)
      const topLevelComments: DiscussionCommentWithReplies[] = [
        {
          id: "DC_1",
          body: "User question",
          author: { __typename: "User", login: "iim-norse" },
          createdAt: "2024-01-01T10:00:00Z",
          replies: { nodes: [] },
        },
        {
          id: "DC_2",
          body: "Gitdog's detailed response",
          author: { __typename: "Bot", login: "gitdogbot[bot]" },
          createdAt: "2024-01-01T10:01:00Z",
          replies: {
            nodes: [
              {
                id: "DC_3",
                body: "@GitDog Good explanation! One addition...",
                author: { __typename: "User", login: "hyochan" },
                createdAt: "2024-01-01T10:02:00Z",
              },
            ],
          },
        },
      ];

      const flattened = flattenDiscussionComments(topLevelComments);

      expect(flattened).toHaveLength(3);
      // Should be sorted by createdAt
      expect(flattened[0].body).toBe("User question");
      expect(flattened[1].body).toBe("Gitdog's detailed response");
      expect(flattened[2].body).toBe(
        "@GitDog Good explanation! One addition...",
      );
    });

    it("should include replies even when top-level has no replies", () => {
      const topLevelComments: DiscussionCommentWithReplies[] = [
        {
          id: "DC_1",
          body: "Question",
          author: { __typename: "User", login: "user1" },
          createdAt: "2024-01-01T10:00:00Z",
          // No replies field
        },
      ];

      const flattened = flattenDiscussionComments(topLevelComments);

      expect(flattened).toHaveLength(1);
      expect(flattened[0].body).toBe("Question");
    });

    it("should handle multiple replies to same comment", () => {
      const topLevelComments: DiscussionCommentWithReplies[] = [
        {
          id: "DC_1",
          body: "Bot response",
          author: { __typename: "Bot", login: "gitdogbot[bot]" },
          createdAt: "2024-01-01T10:00:00Z",
          replies: {
            nodes: [
              {
                id: "DC_2",
                body: "First reply",
                author: { __typename: "User", login: "user1" },
                createdAt: "2024-01-01T10:01:00Z",
              },
              {
                id: "DC_3",
                body: "Second reply",
                author: { __typename: "User", login: "user2" },
                createdAt: "2024-01-01T10:02:00Z",
              },
            ],
          },
        },
      ];

      const flattened = flattenDiscussionComments(topLevelComments);

      expect(flattened).toHaveLength(3);
      expect(flattened[0].body).toBe("Bot response");
      expect(flattened[1].body).toBe("First reply");
      expect(flattened[2].body).toBe("Second reply");
    });

    it("should sort by createdAt even when replies come before parent in time", () => {
      // Edge case: GraphQL might return in different order
      const topLevelComments: DiscussionCommentWithReplies[] = [
        {
          id: "DC_2",
          body: "Later comment",
          author: { __typename: "User", login: "user1" },
          createdAt: "2024-01-01T12:00:00Z",
          replies: { nodes: [] },
        },
        {
          id: "DC_1",
          body: "Earlier comment",
          author: { __typename: "User", login: "user2" },
          createdAt: "2024-01-01T10:00:00Z",
          replies: {
            nodes: [
              {
                id: "DC_3",
                body: "Reply at 11am",
                author: { __typename: "User", login: "user3" },
                createdAt: "2024-01-01T11:00:00Z",
              },
            ],
          },
        },
      ];

      const flattened = flattenDiscussionComments(topLevelComments);

      // Should be sorted chronologically
      expect(flattened[0].body).toBe("Earlier comment");
      expect(flattened[1].body).toBe("Reply at 11am");
      expect(flattened[2].body).toBe("Later comment");
    });

    it("should work with the expo-iap bug scenario", () => {
      // Exact reproduction of the bug: hyochan's reply was in nested replies
      const topLevelComments: DiscussionCommentWithReplies[] = [
        {
          id: "DC_kwDOMRlcG84A7UKG",
          body: "**Key Difference:**\n\nBoth approaches call your backend...",
          author: { __typename: "Bot", login: "gitdogbot[bot]" },
          createdAt: "2024-01-20T10:00:00Z",
          replies: {
            nodes: [
              {
                id: "DC_kwDOMRlcG84A7UNF",
                body: "@GitDog Good explanation! One small addition for the isAlreadyProcessed case...",
                author: { __typename: "User", login: "hyochan" },
                createdAt: "2024-01-20T10:05:00Z",
              },
            ],
          },
        },
      ];

      const flattened = flattenDiscussionComments(topLevelComments);

      // Should include both the bot's response AND the nested reply
      expect(flattened).toHaveLength(2);
      expect(flattened[0].author?.login).toBe("gitdogbot[bot]");
      expect(flattened[1].author?.login).toBe("hyochan");

      // Now build chat history
      const history = buildChatHistory(flattened);
      expect(history[0].role).toBe("assistant"); // Bot response
      expect(history[1].role).toBe("user"); // hyochan's reply

      // This is the key: now AI has context of its previous response!
      expect(history[0].content).toContain("Key Difference");
    });
  });

  describe("Maintainer Detection and Labeling", () => {
    describe("formatAuthor", () => {
      it("should add [Maintainer] label for OWNER", () => {
        expect(formatAuthor("hyochan", "OWNER")).toBe("hyochan [Maintainer]");
      });

      it("should add [Maintainer] label for MEMBER", () => {
        expect(formatAuthor("teammate", "MEMBER")).toBe(
          "teammate [Maintainer]",
        );
      });

      it("should add [Maintainer] label for COLLABORATOR", () => {
        expect(formatAuthor("contributor", "COLLABORATOR")).toBe(
          "contributor [Maintainer]",
        );
      });

      it("should NOT add [Maintainer] label for CONTRIBUTOR", () => {
        expect(formatAuthor("external", "CONTRIBUTOR")).toBe("external");
      });

      it("should NOT add [Maintainer] label for NONE", () => {
        expect(formatAuthor("random-user", "NONE")).toBe("random-user");
      });

      it("should handle undefined authorRole", () => {
        expect(formatAuthor("user", undefined)).toBe("user");
      });

      it("should handle empty string authorRole", () => {
        expect(formatAuthor("user", "")).toBe("user");
      });
    });

    describe("buildFollowUpChatHistory", () => {
      it("should include [Maintainer] label in user messages", () => {
        const previousComments: PreviousComment[] = [
          {
            id: 1,
            body: "Initial question about the API",
            author: "user1",
            authorRole: "NONE",
            isBot: false,
            createdAt: "2024-01-01T10:00:00Z",
          },
          {
            id: 2,
            body: "Here is the answer...",
            author: "gitdogbot[bot]",
            isBot: true,
            createdAt: "2024-01-01T10:01:00Z",
          },
        ];

        const currentComment = {
          id: 3,
          body: "Good explanation! One addition...",
          author: "hyochan",
          authorRole: "OWNER",
        };

        const history = buildFollowUpChatHistory(
          previousComments,
          currentComment,
        );

        // Verify maintainer label in current comment
        expect(history[2].content).toContain("[hyochan [Maintainer]]:");
        expect(history[2].content).toContain("Good explanation!");
        expect(history[2].role).toBe("user");

        // Verify regular user has no label
        expect(history[0].content).toBe(
          "[user1]: Initial question about the API",
        );

        // Verify bot message doesn't have author prefix
        expect(history[1].content).toBe("Here is the answer...");
        expect(history[1].role).toBe("assistant");
      });

      it("should handle conversation with multiple maintainers", () => {
        const previousComments: PreviousComment[] = [
          {
            id: 1,
            body: "User question",
            author: "external-user",
            authorRole: "NONE",
            isBot: false,
            createdAt: "2024-01-01T10:00:00Z",
          },
          {
            id: 2,
            body: "First maintainer response",
            author: "maintainer1",
            authorRole: "MEMBER",
            isBot: false,
            createdAt: "2024-01-01T10:01:00Z",
          },
        ];

        const currentComment = {
          id: 3,
          body: "Second maintainer agrees",
          author: "maintainer2",
          authorRole: "COLLABORATOR",
        };

        const history = buildFollowUpChatHistory(
          previousComments,
          currentComment,
        );

        expect(history[0].content).toBe("[external-user]: User question");
        expect(history[1].content).toBe(
          "[maintainer1 [Maintainer]]: First maintainer response",
        );
        expect(history[2].content).toContain("[maintainer2 [Maintainer]]:");
      });

      it("should skip current comment when building history", () => {
        const previousComments: PreviousComment[] = [
          {
            id: 1,
            body: "Question",
            author: "user",
            isBot: false,
            createdAt: "2024-01-01T10:00:00Z",
          },
          {
            id: 2,
            body: "Current comment that should be excluded from loop",
            author: "maintainer",
            authorRole: "OWNER",
            isBot: false,
            createdAt: "2024-01-01T10:01:00Z",
          },
        ];

        const currentComment = {
          id: 2,
          body: "Current comment that should be excluded from loop",
          author: "maintainer",
          authorRole: "OWNER",
        };

        const history = buildFollowUpChatHistory(
          previousComments,
          currentComment,
        );

        // Should have 2 messages: previous user + current (not duplicate)
        expect(history).toHaveLength(2);
        expect(history[0].content).toBe("[user]: Question");
        expect(history[1].content).toContain("[maintainer [Maintainer]]:");
      });
    });

    describe("Real-world expo-iap scenario", () => {
      it("should correctly build context for maintainer correction", () => {
        // This is the exact scenario from the bug report
        const previousComments: PreviousComment[] = [
          {
            id: "DC_1",
            body: "what a different here: validatePurchaseOnServer vs isAlreadyProcessed",
            author: "iim-norse",
            authorRole: "NONE",
            isBot: false,
            createdAt: "2024-01-20T09:00:00Z",
          },
          {
            id: "DC_2",
            body: "**Key Difference:**\n\nBoth approaches call your backend, but they serve different purposes...",
            author: "gitdogbot[bot]",
            isBot: true,
            createdAt: "2024-01-20T09:01:00Z",
          },
        ];

        const currentComment = {
          id: 3,
          body: "@GitDog Good explanation! One small addition for the isAlreadyProcessed case:\n\n```js\nif (await isAlreadyProcessed(purchase)) {\n  await finishTransaction({purchase});\n} else {\n  const isValid = await validatePurchaseOnServer(purchase);\n  if (isValid) await processPurchase(purchase);\n  await finishTransaction({purchase});\n}\n```\nThe docs example only shows the true case - make sure to handle unprocessed pending purchases too.",
          author: "hyochan",
          authorRole: "OWNER",
        };

        const history = buildFollowUpChatHistory(
          previousComments,
          currentComment,
        );

        // Verify structure
        expect(history).toHaveLength(3);

        // First message: user question
        expect(history[0].role).toBe("user");
        expect(history[0].content).toContain("[iim-norse]:");
        expect(history[0].content).not.toContain("[Maintainer]");

        // Second message: gitdog's response (assistant)
        expect(history[1].role).toBe("assistant");
        expect(history[1].content).toContain("Key Difference");
        expect(history[1].content).not.toContain("[gitdogbot"); // No prefix for assistant

        // Third message: maintainer's correction
        expect(history[2].role).toBe("user");
        expect(history[2].content).toContain("[hyochan [Maintainer]]:");
        expect(history[2].content).toContain("Good explanation!");
        expect(history[2].content).toContain("isAlreadyProcessed");
      });

      it("should preserve bot responses as assistant without author prefix", () => {
        // Ensure bot responses don't get double-prefixed
        const previousComments: PreviousComment[] = [
          {
            id: 1,
            body: "Bot response with code",
            author: "gitdogbot[bot]",
            isBot: true,
            createdAt: "2024-01-01T10:00:00Z",
          },
        ];

        const currentComment = {
          id: 2,
          body: "Follow-up",
          author: "user",
        };

        const history = buildFollowUpChatHistory(
          previousComments,
          currentComment,
        );

        // Bot response should NOT have [author]: prefix
        expect(history[0].content).toBe("Bot response with code");
        expect(history[0].content).not.toContain("[gitdogbot");
        expect(history[0].role).toBe("assistant");
      });
    });

    describe("Edge cases for maintainer context", () => {
      it("should handle missing authorRole in previousComments", () => {
        const previousComments: PreviousComment[] = [
          {
            id: 1,
            body: "Comment without role",
            author: "unknown-user",
            // authorRole is missing
            isBot: false,
            createdAt: "2024-01-01T10:00:00Z",
          },
        ];

        const currentComment = {
          id: 2,
          body: "Current message",
          author: "currentUser",
        };

        const history = buildFollowUpChatHistory(
          previousComments,
          currentComment,
        );

        // Should work without errors, no [Maintainer] label
        expect(history[0].content).toBe("[unknown-user]: Comment without role");
        expect(history[0].content).not.toContain("[Maintainer]");
      });

      it("should handle empty previousComments array", () => {
        const currentComment = {
          id: 1,
          body: "First comment",
          author: "owner",
          authorRole: "OWNER",
        };

        const history = buildFollowUpChatHistory([], currentComment);

        expect(history).toHaveLength(1);
        expect(history[0].content).toContain("[owner [Maintainer]]:");
      });

      it("should correctly identify all maintainer types", () => {
        const testCases = [
          { role: "OWNER", shouldBeMaintainer: true },
          { role: "MEMBER", shouldBeMaintainer: true },
          { role: "COLLABORATOR", shouldBeMaintainer: true },
          { role: "CONTRIBUTOR", shouldBeMaintainer: false },
          { role: "NONE", shouldBeMaintainer: false },
          { role: "FIRST_TIMER", shouldBeMaintainer: false },
          { role: "FIRST_TIME_CONTRIBUTOR", shouldBeMaintainer: false },
          { role: undefined, shouldBeMaintainer: false },
        ];

        for (const { role, shouldBeMaintainer } of testCases) {
          const result = formatAuthor("testuser", role);
          if (shouldBeMaintainer) {
            expect(result).toBe("testuser [Maintainer]");
          } else {
            expect(result).toBe("testuser");
          }
        }
      });
    });
  });
});
