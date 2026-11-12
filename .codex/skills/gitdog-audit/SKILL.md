---
name: gitdog-audit
description: Audit Gitdog-authored GitHub issue and discussion comments, then improve the gitdog.dev project when a generated comment is wrong or incomplete. Use when the user asks Codex or Claude to verify comments written by Gitdog or an AI bot, review auto issue/discussion replies, fix the underlying Gitdog behavior, resume a comment audit, or show where comment checking started, stopped, or last completed.
---

# Gitdog Audit

## Purpose

Use this workflow to review Gitdog-generated issue and discussion comments after they have been posted to GitHub, identify whether the response was wrong or incomplete, improve the `gitdog.dev` project so future responses are better, and leave a durable checkpoint showing the checked range and last audited item.

Do not edit or delete existing GitHub comments unless the user explicitly asks for that. Treat bad comments as production feedback for the app, prompts, validation, code retrieval, or tests.

## Default Invocation

If the user only says `$gitdog-audit`, `gitdog-audit`, or "gitdog audit" without extra scope, audit the latest Gitdog-authored issue comment only:

```bash
python3 .codex/skills/gitdog-audit/scripts/comment_audit.py status
python3 .codex/skills/gitdog-audit/scripts/comment_audit.py collect --repo owner/repo --types issues --latest --limit 1 --lookback-hours 720
```

Then review that one JSONL record, patch the project if the comment exposes a product issue, and record `ok`, `comment-corrected`, `comment-and-project-fixed`, `project-fixed`, `needs-project-fix`, `skipped`, or `blocked`. "Latest issue comment" means the newest issue comment authored by Gitdog or containing the Gitdog footer; do not include discussion comments unless the user asks for discussions or all comments.

If the user provides an exact GitHub issue or pull request issue-comment URL, audit that comment instead of inferring the current repository or collecting the latest item:

```bash
python3 .codex/skills/gitdog-audit/scripts/comment_audit.py status --repo owner/repo
python3 .codex/skills/gitdog-audit/scripts/comment_audit.py collect --url https://github.com/owner/repo/issues/1#issuecomment-123456789 --types issues
```

Use the repository parsed from the URL for status and recording. This path is for exact issue comments such as `#issuecomment-...`; discussion comments still require the normal discussion collection path unless direct discussion URL support has been added.

When an exact URL points to an item that was already recorded, treat the run as a re-audit. Fetch the current GitHub comment and source issue state again, verify whether the latest posted text is now correct, and record a new result only if the re-audit changes or confirms the latest outcome. Status summaries should be interpreted by the latest record per item, not by raw append counts.

## Required First Step

Run status before collecting comments or changing the project:

```bash
python3 .codex/skills/gitdog-audit/scripts/comment_audit.py status
```

If the user provides a repository, pass `--repo owner/repo`. If not, infer it with `gh repo view` or from the current git remote. If the checkpoint already has a `last_collection_output`, resume from that output unless the user asked for a new collection window.

## Collection

Collect candidate Gitdog comments with the script. By default it resumes from the saved checkpoint; on the first run it uses a 7-day lookback.

```bash
python3 .codex/skills/gitdog-audit/scripts/comment_audit.py collect --repo owner/repo
```

Useful options:

- `--since 2026-07-01T00:00:00Z` to override the checkpoint start.
- `--lookback-hours 24` for first-run scoped audits.
- `--types issues`, `--types discussions`, or `--types all`.
- `--latest --limit 1` to ignore the checkpoint and collect the newest matching comment.
- `--url https://github.com/owner/repo/issues/1#issuecomment-123456789` to collect one exact issue or pull request issue comment.
- `--bot-logins gitdogbot[bot],gitdogbot-dev[bot]` to override the default authors.
- `--out .codex/comment-audits/custom.jsonl` to choose the report path.

The script writes JSONL records under `.codex/comment-audits/` and updates `.codex/comment-audits/checkpoint.json` with the collection `from`, `to`, item count, and output path. This collection checkpoint is not proof that each item has been semantically audited.

The `collect` command requires the GitHub CLI (`gh`). If `gh` is unavailable, use the GitHub connector or API tools to fetch the same fields, save JSONL records with the same keys shown by the script (`key`, `type`, `repo`, `url`, `author`, `updated_at`, `body`, `body_without_footer`), then continue the audit loop and use `record` for per-item progress.

## Audit Loop

For each collected record, oldest first:

1. Read `references/comment-audit-rubric.md`.
2. Fetch the source issue/discussion title, body, and surrounding comments.
3. Read relevant project code before judging technical claims.
4. Apply `convex/_ai/responseValidation.ts` checks conceptually: no internal field leaks, internal path leaks, context-loss phrases, unsupported external overclaims, high-risk technical claims, suspicious code, or topic drift.
5. Decide `ok`, `comment-corrected`, `comment-and-project-fixed`, `project-fixed`, `needs-project-fix`, `skipped`, or `blocked`.
6. If wrong or incomplete, find the root cause in `gitdog.dev` and improve the project before moving on. Common fix surfaces are `convex/_ai/issueAnalysis`, `convex/_ai/followUp`, `convex/_ai/responseValidation.ts`, `convex/_ai/tools`, `convex/github`, prompt tests, and workflow tests.
7. Add or update focused tests that would have caught the bad comment when the fix affects deterministic validation, prompt text, comment routing, code retrieval, or webhook behavior.
8. Run path-appropriate validation for touched files.
9. Record the item result immediately:

```bash
python3 .codex/skills/gitdog-audit/scripts/comment_audit.py record \
  --repo owner/repo \
  --item issue_comment:123456789 \
  --status project-fixed \
  --url https://github.com/owner/repo/issues/1#issuecomment-123456789 \
  --note "Added response validation for unsupported framework-version claims"
```

Use `record` after every item, or after a very small batch if each item has already been checked. This keeps the last audited item visible if the run is interrupted.

If a previously recorded item is checked again after a comment correction or project fix, record the current final outcome for that same item key. The audit script reports counts from the latest status per item so an item can move from `project-fixed` to `comment-and-project-fixed` without being double-counted.

## Direct Comment Correction

By default, do not edit posted GitHub comments. If the user explicitly asks to correct wrong Gitdog answers, repair the existing comment as part of the audit:

1. Prepare a concise corrected replacement body that answers the original issue accurately using the source context you verified.
2. Keep or restore the Gitdog footer at the end of the edited body.
3. Include a short correction note near the top, for example:

```md
> Correction: The earlier answer was inaccurate. The corrected analysis is below.
```

4. Edit issue comments with GitHub CLI:

```bash
gh api -X PATCH repos/owner/repo/issues/comments/123456789 \
  -f body="$(cat /tmp/corrected-gitdog-comment.md)"
```

5. If GitHub denies edit permission, do not delete the comment. Post a maintainer-owned follow-up correction only when the user explicitly asks for a follow-up instead of an edit; otherwise record `blocked` with the permission error.
6. Use `comment-corrected` when only the GitHub comment was corrected, `project-fixed` when only `gitdog.dev` was changed, and `comment-and-project-fixed` when both were done.

Never hide the correction. Do not silently replace a bad answer with a new answer that gives no indication it was corrected.

## Project Improvement Rules

Improve the app, not the already-posted comment:

- Prompt gap: update the relevant prompt and add a prompt regression test.
- Validation gap: extend `convex/_ai/responseValidation.ts` and add validation tests.
- Retrieval/tool gap: fix the code search, context assembly, or tool executor behavior and add tests around the failing path.
- Routing/webhook gap: fix issue/discussion/comment classification, bot detection, or follow-up threading and add tests.
- Product copy or footer gap: fix the generator path and tests that assert comment shape.

If no safe project fix can be completed in the current run, record `needs-project-fix` with the specific failing behavior and the suspected code surface. If the comment was correct, record `ok`. If the audit cannot be performed because required GitHub/API/code context is unavailable, record `blocked`.

## Ship Remediation PR

When the user asks to ship the audit fixes, carry the remediation through PR, review loops, merge, and deploy:

1. Create a branch if on `main`. Use the `codex/` prefix unless the user requested another branch name.
2. Keep changes scoped to audited failures and the skill/script improvements needed to prevent recurrence.
3. Run focused checks for touched files, then the repo verification suite required by `CLAUDE.md` and `.claude/commands/verify.md` before committing.
4. Commit only after the user has explicitly authorized committing in the current session. Use lowercase conventional commits and no co-author text.
5. Open a PR with a tracking section that lists every audited GitHub item handled:

```md
## Audit tracking

| Source                                   | Result                    | Comment correction                      | Project fix                            |
| ---------------------------------------- | ------------------------- | --------------------------------------- | -------------------------------------- |
| owner/repo#123 / issue_comment:123456789 | comment-and-project-fixed | Edited bad answer to correct root cause | Added validation and prompt regression |
```

Include direct links to source issues/comments so future audits can trace why the project changed.

6. Request review after the PR is open. Use the review workflow from `.claude/commands/review-pr.md`, but poll every 5 minutes (`300` seconds) when the user asks for this full audit shipping flow.
7. On each review loop:
   - Fetch reviews, comments, and GraphQL review-thread state.
   - Address every new valid review comment.
   - Run required validation.
   - Commit and push fixes after commit authorization for the session.
   - Reply inline with `Fixed in <plain-short-hash>.`
   - Resolve only fixed or outdated threads.
   - Re-request reviewers and schedule the next 5-minute poll.

8. Stop polling only when there are no new unresolved review comments and required checks are green, or after five review-loop iterations. If the fifth loop still has comments, stop and report the remaining blockers.
9. Merge only after the user has explicitly authorized merge for this PR or invoked the full ship-and-merge flow. After merge succeeds, make sure production Convex is deployed. Prefer the repository's main-branch Deploy Convex GitHub Action when `.github/workflows/deploy-convex.yml` and the `CONVEX_DEPLOY_KEY` secret are configured; otherwise run the manual deploy command the user requested:

```bash
bunx convex deploy
```

If CI deploy or manual deploy fails, report the exact failure and leave the audit result as not fully shipped.

## Status Meanings

- `ok`: checked against source context and no correction needed.
- `comment-corrected`: the posted GitHub comment was edited or otherwise corrected, but no project change was needed.
- `comment-and-project-fixed`: the posted GitHub comment was corrected and `gitdog.dev` was changed so future comments should avoid the failure.
- `project-fixed`: `gitdog.dev` was changed so future comments should avoid the failure.
- `needs-project-fix`: a project fix is needed but could not be applied in this run.
- `skipped`: intentionally not audited, with a note explaining why.
- `blocked`: cannot audit safely or cannot correct the comment because required GitHub/API/code context or permissions are unavailable.

## Progress Reporting

When asked where checking started or stopped, run:

```bash
python3 .codex/skills/gitdog-audit/scripts/comment_audit.py status --repo owner/repo
```

Report both:

- Collection range: `from`, `to`, output path, candidate count.
- Audit progress: `last_audited_item`, `last_audited_at`, last status, and counts by status.

If collection succeeded but auditing did not finish, say exactly which JSONL output should be resumed and which item was last recorded.
