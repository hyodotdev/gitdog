# Gitdog Comment Audit Rubric

## Evidence Requirements

Treat each posted Gitdog comment as production feedback until checked against source context.

- Read the issue or discussion title/body and the latest human comment that triggered the reply.
- Read earlier bot and human comments when continuity matters.
- Read the repository code, docs, tests, or config named by the thread before accepting technical claims.
- Verify file paths, functions, classes, options, version numbers, and line references.
- If a claim depends on current external behavior, verify it from official docs or phrase the answer as needing external verification.

## Hard Failures

Improve the `gitdog.dev` project when any of these appear:

- It exposes internal fields such as `suggestedResponse`, `isActionable`, `issueType`, `ticketId`, `repositoryId`, `tokenUsage`, `inputTokens`, or `outputTokens`.
- It cites internal AI instruction files such as `.claude/`, `.ai/`, `AGENTS.md`, `CLAUDE.md`, `COPILOT.md`, or `llm.txt`.
- It says it lacks previous conversation context when the GitHub thread provides that context.
- It invents files, functions, APIs, platform behavior, or release-version facts.
- It answers a different topic from the issue/discussion or ignores the latest human follow-up.
- It recommends code that is syntactically wrong, a no-op, or unrelated to the user report.
- It overstates external dependency behavior with universal claims like "always" or "never" without evidence.
- It recommends closing, rejecting, or redirecting an issue without sufficient repository evidence.

## Completeness Checks

Mark `needs-project-fix` or patch the project when the answer is directionally correct but insufficient:

- Missing a direct answer to the latest question.
- Missing a concrete next step, workaround, reproduction request, or file path.
- Missing uncertainty language for partial codebase coverage.
- Missing version mismatch notes when the thread mentions a release but the indexed code is newer or older.
- Missing maintainer mention only when the project action type required one.

## Project Fix Style

- Do not edit or delete the original GitHub comment unless the user explicitly asks for that.
- Convert the bad comment into a reproducible product gap: prompt, validation, retrieval, routing, webhook handling, or tests.
- Keep fixes focused on the failing behavior that produced the bad answer.
- Prefer deterministic validation or regression tests when a bad answer pattern can be detected before posting.
- Prefer prompt regression tests when the issue is instruction priority, wording, scope, or missing uncertainty language.
- Preserve user-facing response quality: future comments should be code-grounded, concise, and honest about uncertainty.

## Status Meanings

- `ok`: checked against source context and no correction needed.
- `comment-corrected`: the posted GitHub comment was edited or otherwise corrected, but no project change was needed.
- `comment-and-project-fixed`: the posted GitHub comment was corrected and `gitdog.dev` was changed so future comments should avoid the failure.
- `project-fixed`: `gitdog.dev` was changed so future comments should avoid the failure.
- `needs-project-fix`: a project fix is needed but could not be applied in this run.
- `skipped`: intentionally not audited, with a note explaining why.
- `blocked`: cannot audit safely because required GitHub/API/code context is unavailable.
