import { describe, it, expect } from "vitest";

/**
 * Maintainer Prompt Injection Tests
 *
 * Mirrors the maintainer block in `analyzeIssueWithTools` (the user message in
 * convex/_ai/issueAnalysis/agenticWorkflow.ts). If you change that template,
 * update `buildMaintainerSection` here too.
 *
 * The goal is to lock in:
 *   - org owner names never leak into @-mentions
 *   - empty maintainer lists explicitly forbid fabricated mentions
 *   - non-empty lists render as `@user1, @user2, ...`
 */
function buildMaintainerSection(maintainers?: string[]): string {
  if (maintainers && maintainers.length > 0) {
    return `\n## Repository Maintainers (verified GitHub users)\nThe following users are the actual mentionable maintainers of this repository: ${maintainers
      .map((m) => `@${m}`)
      .join(
        ", ",
      )}.\n- Only @ mention these users when a maintainer reference is appropriate.\n- If the question requires a maintainer's judgment (roadmap, priority, design decisions), you MAY @ mention one of them, but keep it to a single mention and only when truly needed.\n- Do NOT @ mention any other handle as a "maintainer".\n`;
  }
  return `\n## Repository Maintainers\nNo verified maintainer logins are available for this repository. Refer to maintainers generically (e.g., "the maintainer would need to weigh in") — do NOT @ mention anyone as the maintainer.\n`;
}

describe("buildMaintainerSection", () => {
  describe("With verified maintainers", () => {
    it("renders single maintainer as @login", () => {
      const out = buildMaintainerSection(["hyochan"]);
      expect(out).toContain("@hyochan");
      expect(out).toContain("verified GitHub users");
      expect(out).toContain("Only @ mention these users");
    });

    it("renders multiple maintainers comma-separated", () => {
      const out = buildMaintainerSection(["hyochan", "alice", "bob"]);
      expect(out).toContain("@hyochan, @alice, @bob");
    });

    it("instructs the model to keep mentions to a single user", () => {
      const out = buildMaintainerSection(["hyochan", "alice"]);
      expect(out).toContain("single mention");
    });

    it("forbids mentioning any handle outside the verified list", () => {
      const out = buildMaintainerSection(["hyochan"]);
      expect(out).toContain(
        'Do NOT @ mention any other handle as a "maintainer"',
      );
    });
  });

  describe("Without verified maintainers", () => {
    it("renders the no-maintainer fallback for undefined", () => {
      const out = buildMaintainerSection(undefined);
      expect(out).toContain("No verified maintainer logins are available");
      expect(out).toContain("do NOT @ mention anyone as the maintainer");
    });

    it("renders the no-maintainer fallback for empty array", () => {
      const out = buildMaintainerSection([]);
      expect(out).toContain("No verified maintainer logins are available");
      expect(out).toContain("Refer to maintainers generically");
    });

    it("does NOT mention any specific user in fallback text", () => {
      const out = buildMaintainerSection([]);
      expect(out).not.toMatch(/@\w+/);
    });
  });

  describe("Regression: openiap/issue-129", () => {
    it("with org admins resolved, only the user is @-mentioned", () => {
      // hyodotdev (org) → resolved to @hyochan via getRepositoryMaintainers
      const out = buildMaintainerSection(["hyochan"]);
      expect(out).toContain("@hyochan");
      expect(out).not.toContain("@hyodotdev");
    });

    it("when org admin lookup yields nothing, falls back to no-mention rule", () => {
      // hyodotdev (org) → no admins resolvable → empty list passed
      const out = buildMaintainerSection([]);
      expect(out).not.toContain("@hyodotdev");
      expect(out).not.toMatch(/@\w+/);
      expect(out).toContain("do NOT @ mention anyone");
    });
  });
});
