---
name: review-self
description: Independently review and improve Codex's current Gitdog implementation, working-tree changes, or pull request; fix actionable in-scope gaps; rerun relevant repository checks; and recheck at five-minute intervals until the work is stable or genuinely blocked. Use when the user says "review-self", asks Codex to review its own changes, requests a self-review loop, or wants current Gitdog work monitored for new issues after implementation.
---

# Review Self

Review the current Gitdog work immediately, fix validated gaps, and use
five-minute confirmation rounds until the result is stable.

## Preserve Authority And Scope

- Treat invocation as authorization to inspect current work, make local
  in-scope fixes, and run relevant verification.
- Preserve the authority of the original request. Do not commit, push, create or
  edit a PR, post comments, resolve threads, merge, deploy, or change live
  external state unless the user already authorized that action.
- Keep fixes tied to the original goal. Do not turn self-review into a broad
  audit, speculative refactor, dependency upgrade, or unrelated cleanup.
- Preserve pre-existing user changes. Record the initial working-tree state and
  never sweep-stage, overwrite, or discard files outside the current fix batch.
- Stop and ask for direction when a valid fix requires a material product choice,
  new authority, an irreversible action, or a meaningful expansion of scope.

## Establish The Review Target

1. Reconstruct the requested outcome and acceptance criteria from the active
   conversation and repository evidence.
2. Use an explicitly supplied PR, branch, commit range, or path as the target.
   Otherwise, review the current branch plus its staged, unstaged, and untracked
   changes. When the target is a path, restrict every diff layer, finding, fix,
   and check to that path.
3. For a PR, derive the actual base and head from PR metadata. Without a PR, use
   an explicit integration base, hosting metadata, the remote default branch, or
   a verified fork point. Do not treat a feature branch's push upstream as its
   integration base; use that upstream only to inspect local-versus-remote
   divergence. Ask when the integration base remains ambiguous.
4. Read root `AGENTS.md`, `CLAUDE.md`, and the portions of `docs/convention.md`
   that apply to the changed paths before editing them. Read the relevant local
   workflow file when the target includes a repository workflow.
5. Stop with a concise report when there is no reviewable diff and no
   asynchronous PR state to monitor.

## Run One Review Round

1. Resnapshot the target from disk. Include the full base-to-head diff, staged
   and unstaged overlays, and the contents of untracked files. Do not review only
   the latest commit or trust a snapshot from a previous round. Apply an explicit
   path target to every one of these layers.
2. Read surrounding implementation, tests, documentation, issue or PR
   requirements, and current CI or review feedback needed to understand the
   change.
3. Review for evidence-backed, actionable gaps:
   - requirement completeness and end-to-end wiring;
   - correctness, error paths, state transitions, concurrency, idempotency,
     authorization, data safety, and security;
   - Convex validators, authentication, indexes, bounded reads, generated API
     paths, and dot-notation references;
   - React signal usage, UI conventions, loading behavior, and user-facing copy;
   - AI response grounding, tool boundaries, and unsafe or unsupported claims;
   - missing or weak tests, documentation, migrations, and operational
     safeguards required by the change.
4. Use independent read-only subagents for separate review lenses when the diff
   is large or cross-cutting. Give them the raw target and request, not suspected
   findings or an expected answer.
5. Validate every finding against the current code and applicable instructions.
   Reject pure taste, cosmetic churn, duplicate findings, and unrelated
   nice-to-have work.
6. Fix all validated in-scope findings in one coherent batch. Preserve unrelated
   edits and regenerate generated files only through their documented workflow.
7. Re-read the resulting diff, then run checks appropriate to the touched paths:
   - run the repository formatter or Prettier for workflow-only Markdown or YAML;
   - run `bun run typecheck` and `bun run lint` for TypeScript or Convex changes;
   - run focused tests, plus `bun test` for broad shared behavior;
   - use the full CI-equivalent suite from `review-pr.md` before an authorized
     push;
   - check every reviewed tracked layer for whitespace errors: run
     `git diff --check <base>...<head>`, `git diff --cached --check`, and
     `git diff --check` as applicable. For every untracked target, also run
     `git diff --no-index --check /dev/null <file>` or an equivalent whitespace
     validator; the no-index command's difference status is expected, so treat
     whitespace diagnostics rather than exit code `1` as a failure.
     Do not rerun an expensive unchanged check fingerprint unless new state can
     affect it.
8. For a PR, inspect new failed checks and unresolved feedback as additional
   evidence. Reuse `review-pr.md` for a single thread-handling pass only when
   GitHub writes are authorized. Skip its polling section; keep `review-self` as
   the only polling-loop owner and never retrigger review bots on a no-op poll.
9. Commit or push only when already authorized. Stage only files owned by the
   current round and publish one verified fix batch rather than one commit per
   finding.

## Related Project Workflows

Load only the workflow needed by the current finding; do not run every command by
default. Use `$gitdog-workflows` as the router for `.claude/commands/`:

- Read `review.md` for Gitdog's local review criteria.
- Read `review-pr.md` for one pass of PR review or external review-feedback
  handling. Skip its eight-minute polling section while this skill owns the loop.
- Read `verify.md` for an explicitly requested full health check or a risky,
  cross-cutting change; otherwise run touched-path checks.
- Read `test.md` for broad bug detection, coverage analysis, or test generation.
- Read `convex-function.md` when a finding changes Convex functions.
- Read `commit.md` only for an already authorized commit, push, or PR workflow.

Use `$gitdog-audit` when the target is a Gitdog-generated issue or discussion
comment and the goal is to correct the underlying product behavior. If both
skills apply, keep this skill as the sole recurring-loop owner.

## Recheck Every Five Minutes

- Run the first round immediately; never wait before the initial review.
- If the user explicitly requests one pass, finish after that round and do not
  schedule a confirmation.
- Use the product's real recurring-monitor or wake-up mechanism to schedule the
  next round for 300 seconds after the current round. Make the scheduled prompt
  explicitly invoke `$review-self`; re-enter this skill instead of performing
  semantic review inside a shell loop.
- Keep at most one outstanding wake-up for the same target. Cancel or supersede
  stale duplicate wake-ups when the mechanism supports it.
- Carry a compact state capsule in the scheduled prompt or monitor state. Include
  the original goal and acceptance criteria, target and base, head or tree and
  working-tree fingerprints, seen feedback and check IDs, poll count, clean
  count, start time, finding fingerprints with fix attempts, and existing
  commit, push, and external-write authority.
- Keep loop state out of tracked repository files. Revalidate it against disk and
  remote state on every wake-up.
- Increment the clean count only after a complete round has no actionable
  findings, requested verification passes, required checks are terminal and
  successful or explicitly allowed to skip, no actionable feedback remains, and
  the final diff has been reread. Reset it when material state or a finding
  changes, then let the fully clean post-change result start a new count.
- Finish successfully after two consecutive clean snapshots separated by a
  five-minute interval. Continue without a fixed round cap while new findings or
  state changes lead to meaningful progress.
- Treat pending CI or review automation as neither clean nor failed. Poll it every
  five minutes without repeating expensive local checks on an unchanged
  fingerprint.
- If no recurring mechanism is available, complete the current round and report
  that automatic re-entry could not be scheduled. Do not emulate it with
  `sleep 300`, `while true`, `nohup`, or an abandoned background process, and do
  not claim a future pass was scheduled unless the mechanism accepted it.

## Stop Safely

Stop the loop and report the exact state when any of these conditions holds:

- two clean confirmation snapshots establish stability;
- the user stops, replaces, or materially redirects the task;
- the target PR is merged or closed, the target branch disappears, or the target
  changes incompatibly with the active worktree;
- a finding needs authority or a decision that is not already available;
- the same root finding remains after two fix attempts;
- the same authentication, rate-limit, tool, or environment failure blocks three
  consecutive rounds;
- only unchanged pending external state remains after 12 polls, about one hour.

Do not call a blocked or interrupted result clean. Do not stop merely because one
poll is a no-op while asynchronous state is still pending.

## Communicate Each Round

- At startup, state the target, base, review scope, and whether commit, push, or
  external writes are authorized.
- Report material findings, fixes, validation failures, pushes, and external
  state transitions promptly. Keep no-op updates brief.
- On success or stop, provide a self-contained summary of findings fixed, files
  changed, checks run, commits or pushes made, clean-count evidence, and any
  unresolved blocker.
