import { describe, expect, it } from "vitest";

import {
  getGitdogFollowUpFooter,
  isGitdogBot,
} from "../../../convex/github/botIdentity";
import {
  hasGitdogMentionBody,
  isGitdogInvocationUnchanged,
  normalizeGitdogMentionBody,
} from "../../../convex/github/helpers";
import { buildFollowUpChatHistory } from "../../../convex/ticketActions/internalMutation";

describe("follow-up bot identity", () => {
  it("recognizes only allowlisted Gitdog bot logins", () => {
    expect(isGitdogBot("gitdogbot[bot]", "gitdogbot")).toBe(true);
    expect(isGitdogBot("GitDogBot[bot]", "gitdogbot")).toBe(true);
    expect(isGitdogBot("gitdogbot-dev[bot]", "gitdogbot")).toBe(false);
    expect(isGitdogBot("gitdogbot-dev[bot]", "gitdogbot-dev")).toBe(true);
    expect(isGitdogBot("gitdogbot[bot]", "gitdogbot-dev")).toBe(false);
    expect(isGitdogBot("dependabot[bot]", "gitdogbot")).toBe(false);
    expect(isGitdogBot("github-actions[bot]", "gitdogbot")).toBe(false);
    expect(isGitdogBot(undefined, "gitdogbot")).toBe(false);
  });

  it("renders follow-up guidance for only the current deployment bot", () => {
    expect(getGitdogFollowUpFooter("gitdogbot")).toContain("`@gitdogbot`");
    expect(getGitdogFollowUpFooter("gitdogbot-dev")).toContain(
      "`@gitdogbot-dev`",
    );
    expect(getGitdogFollowUpFooter("")).toBe(
      "Have more questions? Reply and let me know!",
    );
  });

  it("keeps third-party bot authors in user context", () => {
    const chatHistory = buildFollowUpChatHistory(
      [
        {
          id: 1,
          body: "<!-- gitdog-execution:00000000-0000-4000-8000-000000000000 -->\nGitdog answer",
          author: "gitdogbot[bot]",
          isGitdogBot: true,
          createdAt: "2026-07-11T00:00:00Z",
        },
        {
          id: 2,
          body: "Bump a dependency",
          author: "dependabot[bot]",
          isGitdogBot: false,
          createdAt: "2026-07-11T00:01:00Z",
        },
      ],
      {
        id: 3,
        body: "<!-- gitdog-execution:00000000-0000-4000-8000-000000000000 -->\nPlease re-check",
        author: "maintainer",
      },
      Date.parse("2026-07-11T00:02:00Z"),
    );

    expect(chatHistory).toMatchObject([
      { role: "assistant", content: "Gitdog answer" },
      { role: "user", content: "[dependabot[bot]]: Bump a dependency" },
      { role: "user", content: "[maintainer]: Please re-check" },
    ]);
  });

  it("deduplicates the current discussion comment by GraphQL node ID", () => {
    const chatHistory = buildFollowUpChatHistory(
      [
        {
          id: "DC_kwCurrent",
          body: "Please re-check",
          author: "maintainer",
          isGitdogBot: false,
          createdAt: "2026-07-11T00:02:00Z",
        },
      ],
      {
        id: 123,
        nodeId: "DC_kwCurrent",
        body: "Please re-check",
        author: "maintainer",
      },
      Date.parse("2026-07-11T00:02:00Z"),
    );

    expect(chatHistory).toEqual([
      expect.objectContaining({
        role: "user",
        content: "[maintainer]: Please re-check",
      }),
    ]);
  });

  it("removes only the leading invocation mention", () => {
    expect(
      normalizeGitdogMentionBody(
        "@gitdogbot, Should users mention @gitdogbot in the config?",
        "gitdogbot",
      ),
    ).toBe("Should users mention @gitdogbot in the config?");
    expect(
      normalizeGitdogMentionBody(
        "Should users mention @gitdogbot in the config?",
        "gitdogbot",
      ),
    ).toBe("Should users mention @gitdogbot in the config?");
    expect(normalizeGitdogMentionBody("@gitdogbot: use A", "gitdogbot")).toBe(
      "use A",
    );
    expect(
      normalizeGitdogMentionBody("@gitdogbot-dev: use A", "gitdogbot"),
    ).toBe("@gitdogbot-dev: use A");
    expect(
      normalizeGitdogMentionBody("@gitdogbot-dev: use A", "gitdogbot-dev"),
    ).toBe("use A");
    expect(normalizeGitdogMentionBody("@gitdog use A", "gitdogbot")).toBe(
      "@gitdog use A",
    );
    expect(hasGitdogMentionBody("@gitdog use A", "gitdogbot")).toBe(false);
    expect(hasGitdogMentionBody("@gitdogbot use A", "gitdogbot")).toBe(true);
    expect(hasGitdogMentionBody("@gitdogbot-dev use A", "gitdogbot")).toBe(
      false,
    );
    expect(hasGitdogMentionBody("@gitdogbot-dev use A", "gitdogbot-dev")).toBe(
      true,
    );
    expect(hasGitdogMentionBody("@gitdogbot use A", "gitdogbot-dev")).toBe(
      false,
    );
    expect(hasGitdogMentionBody("use A", "gitdogbot")).toBe(false);
    expect(hasGitdogMentionBody("@gitdoge use A", "gitdogbot")).toBe(false);
  });

  it("detects withdrawal even when a literal mention remains in the body", () => {
    const rawBody = "@gitdogbot Should users mention @gitdogbot in the config?";
    const promptBody = "Should users mention @gitdogbot in the config?";

    expect(isGitdogInvocationUnchanged(rawBody, rawBody, "gitdogbot")).toBe(
      true,
    );
    expect(isGitdogInvocationUnchanged(promptBody, rawBody, "gitdogbot")).toBe(
      false,
    );
  });
});
