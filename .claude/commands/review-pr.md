# Review PR Comments

Review a pull request or address PR review comments for this repository.

## Arguments

- `$ARGUMENTS` - PR number (e.g., `42`) or PR URL

## Project-Specific Build Commands

Based on changed files, run these checks BEFORE committing:

| Path      | Commands                            |
| --------- | ----------------------------------- |
| `convex/` | `bun run typecheck && bun run lint` |
| `src/`    | `bun run typecheck && bun run lint` |

Always run the full CI-equivalent suite locally before pushing:

```sh
bun run typecheck && bun run lint && bun run format:check && bun test && bun run build
```

## Project Conventions

When reviewing, check these project-specific rules:

- **State management**: Use `@preact/signals-react` for global state, `useState` for local state
- **UI**: No border-radius, black/white monochrome style
- **Icons**: Use `@icons-pack/react-simple-icons` for brand icons
- **Loading states**: Always use `<LoadingIndicator />` component
- **Convex queries**: Use `.withIndex()` instead of `.filter()`
- **Convex API**: Use dot notation `api.repositories.query.list` NOT `api["repositories/query"].list`
- **Switch statements**: Prefer switch for 3+ conditions

See [CLAUDE.md](../../CLAUDE.md) and [docs/convention.md](../../docs/convention.md) for full conventions.

## Review Modes

`/review-pr` must interact with GitHub. Do not stop after writing a local final
answer when the user provided a PR number or URL.

### A. Reviewing the PR diff

Use this mode when the user asks to review a PR's changes.

1. Fetch PR metadata, changed files, full diff, reviews, comments, and review
   threads.
2. Inspect the surrounding code locally before making findings.
3. Submit findings back to GitHub as a PR review or PR comment:
   - Prefer inline comments for findings on changed lines.
   - Put findings that cannot anchor to changed lines in the review body.
   - If GitHub rejects `REQUEST_CHANGES` because the authenticated user owns the
     PR, submit a `COMMENT` review instead.
4. Final response should summarize what was posted to GitHub and what local
   checks ran.

Do not resolve existing review threads in this mode unless the user explicitly
asks for resolution or the thread is outdated.

### B. Addressing review feedback

Use this mode when the user asks to fix PR comments, resolve review feedback, or
continue a review-fix loop. Follow the execution flow below.

## Execution Flow

Follow this sequence every time `/review-pr` runs in review-feedback mode:

### 1. Fetch all review feedback

```sh
gh pr view <num> --json reviews,comments
gh api repos/{owner}/{repo}/pulls/<num>/comments
```

Also fetch review thread state with GraphQL, including `isResolved` and
`isOutdated`.

Deduplicate by `in_reply_to_id` — only act on root comments that don't already
have a reply from the PR author addressing them.

Before fixing comments, auto-resolve threads that GitHub marks as outdated:

```sh
gh api graphql -f query='
query($owner:String!,$name:String!,$pr:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$pr) {
      reviewThreads(first:100) {
        nodes { id isResolved isOutdated }
      }
    }
  }
}' -F owner={owner} -F name={repo} -F pr=<num> --jq '
  .data.repository.pullRequest.reviewThreads.nodes[]
  | select(.isResolved == false)
  | select(.isOutdated == true)
  | .id' | while read tid; do
  [ -n "$tid" ] && gh api graphql -f query='
    mutation($id:ID!) {
      resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } }
    }' -F id="$tid" >/dev/null && echo "auto-resolved outdated $tid"
done
```

### 2. Address each comment

Make the code changes. Group related comments into a single logical commit when they touch the same concern. Run the full local CI suite (above) before committing.

### 3. Commit and push

Respect root `CLAUDE.md`: if the user has not explicitly authorized a commit in
this session, stop here and ask before running `git commit` or `git push`.

```sh
git add <specific files>
git commit -m "fix: address review feedback on <topic>"
git push
```

**Never skip hooks** (`--no-verify`). **Never add Claude co-author.** Use lowercase after the conventional-commit prefix.

### 4. Reply to each review comment

Reply **inline** on each original comment with the commit hash that addressed it:

```sh
gh api -X POST "repos/{owner}/{repo}/pulls/<num>/comments/<comment_id>/replies" \
  -f body="Fixed in <short-hash>. <one-line summary of the fix>."
```

Keep replies concise — the commit diff speaks for itself.

### 5. Resolve fixed or outdated threads

After the push and inline replies:

- Resolve threads you fixed in the pushed commit after replying with the plain
  commit hash.
- Resolve threads GitHub marks as `isOutdated: true`.
- Do not resolve live threads that you did not fix, threads awaiting user
  clarification, or threads where you are only pushing back.

```sh
# List threads + their resolved / outdated state
gh api graphql -f query='
query {
  repository(owner: "<owner>", name: "<repo>") {
    pullRequest(number: <num>) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          comments(first: 1) { nodes { databaseId } }
        }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] |
  select(.isOutdated == true and .isResolved == false) | .id'

# Resolve each thread id returned above
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<thread_node_id>"}) { thread { id isResolved } } }'
```

For fixed non-outdated threads, resolve only the thread IDs that correspond to
comments fixed in the commit you just pushed.

#### 5a. Reply-and-resolve batch

If the user says something like "fixed라고 한건 resolve 처리해줘" / "resolve
everything I marked Fixed" / "close all addressed threads", batch-resolve every
unresolved thread whose latest comment from the PR author starts with "Fixed in"
(i.e. the inline reply you posted in step 4):

```sh
gh api graphql -f query='
query {
  repository(owner: "<owner>", name: "<repo>") {
    pullRequest(number: <num>) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(last: 1) {
            nodes { author { login } body }
          }
        }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] |
  select(.isResolved == false) |
  select(.comments.nodes[0].author.login? == "<your_github_login>") |
  select(.comments.nodes[0].body? | startswith("Fixed in")) | .id'

# Resolve each thread id returned above (same mutation as 5)
```

**Sticky for the rest of the session**: once the user has authorized this in the current session ("fixed라고 한건 resolve 처리해줘" or equivalent), keep doing it on every subsequent `/review-pr` invocation in that session **without asking again**. The user shouldn't have to repeat the instruction.

### 6. Trigger fresh reviews

After all replies are posted:

```sh
# Re-request Copilot (capital C — it's a Bot, not a user)
gh api -X POST "repos/{owner}/{repo}/pulls/<num>/requested_reviewers" \
  -f 'reviewers[]=Copilot'

# Post /gemini review
gh pr comment <num> --body "/gemini review"
```

Both are idempotent. If Copilot resolution fails with `Could not resolve user`, skip it (the account may not have the bot installed) but still post the Gemini comment.

### 7. Poll for new review comments (loop)

Review bots typically respond within 5–10 minutes. After step 5, **schedule a wake-up in 8 minutes** (`480` seconds) using `ScheduleWakeup` with the same `/review-pr <num>` prompt so the loop re-enters. On wake-up:

- Re-fetch reviews + comments.
- Diff against the comment IDs you've already replied to.
- If **new unaddressed comments exist** → go back to step 2 (address, commit, push, reply, re-trigger, schedule another 8-min wake-up).
- If **no new comments** → the loop is done. Report final state (open comments count, CI status) and stop scheduling. Do not schedule another wake-up.

Cap the loop at **5 total iterations** to avoid runaway. If iteration 5 still has new comments, stop and surface the situation to the user for manual triage.

## Reply Format Rules (CRITICAL)

When replying to PR comments:

### Commit Hash Formatting

**NEVER wrap commit hashes in backticks or code blocks.** GitHub only auto-links plain text commit hashes.

| Format     | Example                 | Result                   |
| ---------- | ----------------------- | ------------------------ |
| ✅ CORRECT | `Fixed in f3b5fec.`     | Clickable link to commit |
| ❌ WRONG   | `Fixed in \`f3b5fec\`.` | Plain text, no link      |

**Examples of correct replies:**

```text
Fixed in f3b5fec.

**Changes:**
- Updated validation logic for confidence scoring
```

```text
Fixed in abc1234 along with other review items.
```

**Do NOT use backticks around the commit hash** - this breaks GitHub's auto-linking feature.
