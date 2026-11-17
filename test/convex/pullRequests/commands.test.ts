import { describe, expect, it } from "vitest";
import {
  commandAccess,
  helpText,
  parseReviewCommand,
} from "../../../convex/pullRequests/commands";

describe("pull request commands", () => {
  it.each([
    ["@gitdogbot review", "review"],
    ["@gitdogbot: Review please", "review"],
    ["Thanks!\n@gitdogbot full review", "full_review"],
    ["  @gitdogbot review", "review"],
    // A mention inside a sentence is not a command.
    ["Thanks! @gitdogbot full review", null],
    ["I think @gitdogbot review is broken", null],
    ["~~~\n@gitdogbot review\n~~~", null],
    ["    @gitdogbot review", null],
    ["<!-- @gitdogbot review -->", null],
    ["@GitdogBot FULL REVIEW", "full_review"],
    ["@gitdogbot resolve", "resolve"],
    ["@gitdogbot help", "help"],
    ["@gitdogbot", "help"],
    ["@gitdogbot summarize this", "unknown"],
    ["@gitdog review", "review"],
    ["@coderabbitai review @gitdogbot review", "review"],
    ["@coderabbitai full review @gitdog full review", "full_review"],
    ["@gitdogbot review @coderabbitai review", "review"],
    ["@alice I think @gitdogbot review is broken", null],
    ["@gitdoghouse review", null],
    ["no mention here", null],
    ["@gitdogbot-dev review", null],
    ["email@gitdogbot review", null],
    ["> @gitdogbot review\n\nquoted only", null],
    ["```\n@gitdogbot review\n```", null],
  ])("reads %j as %s", (body, expected) => {
    expect(parseReviewCommand(body, "gitdogbot")).toBe(expected);
  });
  it("uses the configured app slug", () => {
    expect(parseReviewCommand("@gitdogbot-dev review", "gitdogbot-dev")).toBe(
      "review",
    );
    expect(parseReviewCommand("@gitdogbot review", "")).toBeNull();
  });
  it("lets only the author and collaborators run commands", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"])
      expect(commandAccess(association, 1, 2)).toBe("collaborator");
    expect(commandAccess("CONTRIBUTOR", 1, 2)).toBeNull();
    expect(commandAccess("NONE", 1, 2)).toBeNull();
    // A fork author runs commands, but not a full review.
    expect(commandAccess("NONE", 2, 2)).toBe("author");
    expect(commandAccess(undefined, 1, undefined)).toBeNull();
  });
  it("lists every command with the app mention", () => {
    const help = helpText("gitdogbot");
    for (const command of ["review", "full review", "resolve", "help"])
      expect(help).toContain(`\`@gitdogbot ${command}\``);
  });
});
