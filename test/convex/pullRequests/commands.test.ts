import { describe, expect, it } from "vitest";
import {
  canRunCommands,
  helpText,
  parseReviewCommand,
} from "../../../convex/pullRequests/commands";

describe("pull request commands", () => {
  it.each([
    ["@gitdogbot review", "review"],
    ["@gitdogbot: Review please", "review"],
    ["Thanks! @gitdogbot full review", "full_review"],
    ["@GitdogBot FULL REVIEW", "full_review"],
    ["@gitdogbot resolve", "resolve"],
    ["@gitdogbot help", "help"],
    ["@gitdogbot", "help"],
    ["@gitdogbot summarize this", "unknown"],
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
      expect(canRunCommands(association, 1, 2)).toBe(true);
    expect(canRunCommands("CONTRIBUTOR", 1, 2)).toBe(false);
    expect(canRunCommands("NONE", 1, 2)).toBe(false);
    expect(canRunCommands("NONE", 2, 2)).toBe(true);
    expect(canRunCommands(undefined, 1, undefined)).toBe(false);
  });
  it("lists every command with the app mention", () => {
    const help = helpText("gitdogbot");
    for (const command of ["review", "full review", "resolve", "help"])
      expect(help).toContain(`\`@gitdogbot ${command}\``);
  });
});
