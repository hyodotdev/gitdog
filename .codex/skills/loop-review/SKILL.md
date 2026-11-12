---
name: loop-review
description: "Run Gitdog's complete change-to-production loop from the latest origin/main: implement and verify, stabilize with review-self, open or reuse one PR, review it until its exact head is clean, merge, and verify the production deployment of Convex and the web app."
---

# Loop Review

Own one Gitdog change from a fresh `main` baseline through verified production
delivery. Use the repository workflows as SSOT instead of duplicating their
detailed commands.

## Load The Workflows

Read these before acting:

- `AGENTS.md`, `CLAUDE.md` and `docs/convention.md`
- `.codex/skills/gitdog-workflows/SKILL.md`
- `.codex/skills/review-self/SKILL.md`
- `.claude/commands/commit.md`
- `.claude/commands/review-pr.md`
- `.claude/commands/verify.md`
- `docs/github-app-setup.md` when the change touches the GitHub App, auth or
  webhooks

If the change edits any of the files above, read them from the recorded merge
base for the whole run, so a PR never rewrites the rules that judge it:

```bash
git diff --name-only "$(git merge-base origin/main HEAD)"..HEAD
```

Root `CLAUDE.md` requires explicit user confirmation before any commit, and
invoking this loop does not satisfy it on its own. Ask "이제 커밋할까요?" before
the first commit and confirm before merging, unless the user's request in this
conversation already explicitly asks for this change to be committed, merged or
deployed. With that confirmation the loop covers the in-scope commit, push, PR,
review replies, thread resolution, squash merge, and production deployment
through the main-branch deploy workflow. Read-only production checks such as
`bunx convex logs --prod` and `bunx convex data --prod` need no extra approval.

It does not authorize product-code commits directly to `main`, Convex
environment variable changes, production data writes or `convex run --prod`,
GitHub App, DNS or domain settings, activity on user repositories, destructive
recovery, or unrelated cleanup. Ask for those separately.

This loop owns one PR. Reuse the relevant open PR instead of opening another.

## 1. Start From Current Main

Before editing task files:

1. Snapshot `git status --short --branch`. Preserve every existing change.
2. For a new task, require a clean worktree, then run `git fetch origin`, switch
   to `main`, and run `git pull --ff-only --no-tags origin main`.
3. Verify local `main` equals `origin/main`, then create a branch named
   according to `.claude/commands/commit.md`.
4. Record the starting main SHA. The implementation must descend from it.

When resumed for work already in progress, do not switch branches, stash, reset
or discard it. Verify its merge base with `origin/main`, and stop for direction
if updating from `main` would overwrite unrelated work.

## 2. Implement And Verify

Implement the requested scope. Before proceeding, run `.claude/commands/verify.md`
plus the formatting check that CI enforces:

```bash
bun run lint && bun run typecheck && bun run build && bun run test && bun run format:check
```

A Convex schema change deploys against existing production documents. New
fields must be optional, and a removed or tightened field needs a migration
first. Do not proceed while a required check fails.

## 3. Stabilize With Review Self

Run `$review-self` against the complete base-to-working-tree diff. Give each
independent reviewer the raw diff and the request, not suspected findings.
Fix every validated in-scope finding and rerun the affected checks. Continue
until two consecutive complete snapshots are clean. Any material diff change
resets the count.

Use the product's recurring wake-up for waiting, never a shell sleep loop.

## 4. Commit And Open The PR

Follow `.claude/commands/commit.md --pr`: stage only task files, use an English
conventional commit with a lowercase subject, never add an agent co-author,
push, open or update an English PR against `main`, and add labels from the
existing label set. Keep the PR description true to the final head.

Record the PR number and exact head SHA. A push invalidates prior clean review
coverage.

## 5. Review The PR Until The Exact Head Is Clean

Each round runs steps 1–5 of `.claude/commands/review-pr.md` in
review-feedback mode once, and its step 6 review requests only after a head
change. Do not run its step 7 polling loop: this loop owns waiting, through the
product's wake-up or PR notifications while review or CI is pending. Never
re-request reviews on a round where nothing changed.

1. Fetch unresolved threads, reviews, the head SHA and required checks.
2. Fix valid findings in one batch, verify, then push. Reply to the exact inline
   comment and resolve only fixed or outdated threads.
3. After a head change, request Copilot and Gemini reviews as step 6 of
   `review-pr` describes. When neither reviews the exact head within one wait,
   run one independent read-only review pass on that head as fallback coverage.

Clean means, for one head SHA:

- zero unresolved actionable review threads;
- clean exact-head review coverage (Copilot, Gemini, a human, or the fallback
  pass);
- the checks `lint-and-typecheck`, `test` and `security` succeeded, and
  `build_and_preview` succeeded when it ran. It runs only when the PR touches
  the paths in `.github/workflows/deploy-preview.yml`;
- the PR is mergeable and contains every required update from `main`;
- the worktree is clean and the final diff has been reread.

## 6. Gate Production Impact Before Merging

A merge deploys straight to production Convex and gitdog.dev. Stop without
merging, and report the concrete risk, when the diff:

- changes the Convex schema in a way existing documents might not satisfy;
- changes billing, quota, settlement or payments (`convex/_ai/*Billing*`,
  `convex/subscriptions/`, `convex/tokenUsage/`, `convex/lemonSqueezy/`,
  `convex/paymentLogs/`);
- changes authentication or the GitHub App flow;
- needs a new Convex environment variable, GitHub App permission or event.

Exactly one thing clears this gate: the user's explicit approval in the
conversation to merge and deploy this change, which the final report quotes.
Silence is not approval. When the gate does not apply, say so and name the
paths that justify it.

## 7. Merge And Close The Loop

Immediately before merging, refetch the PR and confirm its head still equals
the clean reviewed SHA. Squash merge with branch deletion. Never bypass branch
protection or merge a stale, pending or failing head.

After merge:

1. Confirm the PR is `MERGED` and record the merge commit.
2. Confirm the remote branch was deleted. Delete the local branch and any task
   worktree only after proving the squash merge contains its tree.
3. Switch to `main` and run `git pull --ff-only --no-tags origin main` when that
   cannot disturb other work. Verify `HEAD` equals `origin/main` and the
   worktree is clean.

## 8. Verify The Production Deployment

1. "Deploy on merge to main" runs only when the merge touches the paths in
   `.github/workflows/deploy.yml`. When it does not, report that no deployment
   was needed and skip to the report.
2. Otherwise wait for its run on the merge commit. Every job must succeed: the
   frontend build, the Convex deploy, Firebase hosting and the Convex
   configuration verification.
3. Confirm gitdog.dev serves the new build, and read recent production Convex
   logs for new errors.
4. Run the production acceptance checks in the PR's test plan. When a check
   needs production writes or activity on a user repository, ask first.
5. Report against Gitdog production records: tickets, ticket actions, failure
   details and token usage.

Report the PR, merge commit, final checks, review coverage, deployment run,
production evidence, and any remaining manual follow-up.

## Stop Conditions

Stop without merging when a required choice lacks authority, the same finding
survives two fix attempts, the production-impact gate is unapproved, or the
exact head cannot satisfy the clean gate. Never describe a pending or partially
reviewed PR as clean.

After merge, stop and report the exact resume point when the deploy workflow
fails or production cannot be verified. Never fix forward with a direct
product-code commit to `main`; return the fix to a PR.
