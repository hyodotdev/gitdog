---
name: loop-review
description: "Run Gitdog's complete latest-main-to-production loop: review-self, PR review until the exact head is clean, squash merge, and verification of the production Convex and web deployment."
---

# Loop Review (Claude Code)

The canonical workflow lives in `.codex/skills/loop-review/SKILL.md`. Read that
file first and follow it fully.

Use Claude Code's matching skills and commands for each phase:

- `$review-self` (`.codex/skills/review-self/SKILL.md`) for stabilization, with
  independent read-only subagents for each review round.
- `/verify` before every commit.
- `/commit --pr` for commit, push, PR and labels, after the commit
  confirmation that root `CLAUDE.md` requires.
- `/review-pr <PR>` for review threads, replies and CI state, run once per
  round without its own polling step. Request Copilot and Gemini reviews only
  after a head change.
- Auto-fix events or `ScheduleWakeup` for waiting; never a shell sleep loop.

Do not merge until the canonical exact-head clean gate and the
production-impact gate are satisfied. After merge, switch to `main`,
fast-forward with no tag fetch, verify exact clean `main`, and verify the
production deployment before ending the loop.
