---
name: gitdog-workflows
description: Use for Gitdog repo work that should follow the repository's Claude slash-command workflows, including review-pr, review comments, verify, test, commit/push/PR, Convex helper workflows, GitHub review threads, and project conventions from CLAUDE.md/docs.
---

# Gitdog Workflows

Use this skill when the user asks Codex to perform a Gitdog repo workflow that
previously lived under `.claude/commands`, such as reviewing a PR, addressing PR
review feedback, verifying changes, testing, committing, or creating Convex
functions.

## Source Of Truth

Before changing code, read root `CLAUDE.md`. For convention-sensitive work,
also read `docs/convention.md`. Then read the relevant command file in
`.claude/commands`.

Do not duplicate or reinterpret those rules when a command file already covers
the workflow.

## Command Mapping

Codex does not need Claude slash-command syntax. If the user says any of these
natural-language requests, execute the matching workflow:

- Review a PR, address PR comments, fix review feedback, or "review-pr": read
  `.claude/commands/review-pr.md`.
- Commit, push, or create a PR: read `.claude/commands/commit.md`.
- Verify, health check, or pre-PR verification: read
  `.claude/commands/verify.md`.
- Run tests or "test": read `.claude/commands/test.md`.
- Create or update Convex functions: read
  `.claude/commands/convex-function.md`.
- Review code locally or "review": read `.claude/commands/review.md`.
- Sync the repo, refresh dependencies, clean up branches, or "up-to-date": read
  `.claude/commands/up-to-date.md`.

When a command file gives a sequence, follow it unless the user's newest
instruction narrows the scope. Keep the root `CLAUDE.md` commit-confirmation
rule in force: do not commit unless the user explicitly authorizes it.

## GitHub PR Review Rules

For `/review-pr` and PR URLs, use GitHub tools or `gh` to inspect PR metadata,
diffs, review submissions, inline comments, and review threads. Do not stop
after a local text review when the user asked for `/review-pr`.

There are two modes:

- **Review the PR diff**: submit findings back to GitHub as a PR review or PR
  comment. Prefer inline comments for changed lines and a review body for
  findings that cannot anchor to a diff line. If GitHub rejects
  `REQUEST_CHANGES` on the authenticated user's own PR, submit a `COMMENT`
  review instead and say so in the final response.
- **Address review feedback**: follow `.claude/commands/review-pr.md`: fix valid
  findings, run the required checks, reply to the specific inline review comment
  with the plain commit hash, and resolve only threads that are fixed or
  outdated according to that command.

Never resolve live review threads just because they exist. Resolve only when the
command's resolution rules are met, or when the user explicitly asks to resolve
addressed threads.

## Non-Negotiables

- Read relevant project instructions before editing.
- Use `bun` commands, not `npm`.
- Run path-appropriate validation for touched files.
- Keep commits and PR titles in conventional commit format with lowercase
  subjects.
- When creating a PR, add appropriate labels from the existing repository label
  set before requesting review.
- Never add Claude co-author text.
