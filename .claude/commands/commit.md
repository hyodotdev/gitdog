# Commit Changes

Complete workflow: branch -> commit -> push -> PR

## Usage

```
/commit [options]
```

**Options:**

- `--push` or `-p`: Push to remote after commit
- `--pr`: Create PR after push
- `--all` or `-a`: Commit all changes at once
- `<path>`: Commit only specific path (e.g., `convex/_ai`)

## Examples

```bash
# Commit all and create PR
/commit --all --pr

# Just commit specific path
/commit convex/_ai

# Commit and push
/commit --push
```

## Complete Workflow

### 1. Check Branch

```bash
git branch --show-current
```

**If on `main`** -> Create a feature branch first:

```bash
git checkout -b feat/<feature-name>
```

**If NOT on `main`** -> Proceed with commits directly.

**Branch naming conventions:**

- `feat/<feature-name>` - New features
- `fix/<bug-description>` - Bug fixes
- `docs/<doc-update>` - Documentation only
- `chore/<task>` - Maintenance tasks

### 2. Check Current Status

```bash
git status
git diff --name-only
```

### 3. Stage Changes

**Specific path:**

```bash
git add <path>
```

**All changes:**

```bash
git add .
```

### 4. Review Staged Changes

```bash
git diff --cached --stat
git diff --cached --name-only
```

### 5. Pre-commit Checks

Run typecheck and lint before committing:

```bash
bun run typecheck && bun run lint
```

### 6. Create Commit

Follow conventional commit format (lowercase after prefix):

```bash
git commit -m "$(cat <<'EOF'
<type>: <description>

<body - what changed and why>
EOF
)"
```

**IMPORTANT:**

- **NEVER** add Claude co-author to commits
- **NEVER** commit without explicit user confirmation
- Always ask "이제 커밋할까요?" before committing

**Commit Types:**

| Type       | Description           |
| ---------- | --------------------- |
| `feat`     | New feature           |
| `fix`      | Bug fix               |
| `docs`     | Documentation only    |
| `refactor` | Code refactoring      |
| `chore`    | Maintenance tasks     |
| `test`     | Adding/updating tests |

**Commit message rules:**

- Use lowercase after prefix: `feat: add` NOT `feat: Add`
- Keep first line under 72 characters

### 7. Push to Remote

```bash
git push -u origin <branch-name>
```

### 8. Create Pull Request

```bash
gh pr create --title "<type>: <description>" --body "$(cat <<'EOF'
## Summary

<1-3 bullet points describing changes>

## Changes

- Change 1
- Change 2

## Test plan

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

🤖 Generated with [Claude Code](https://claude.ai/code)
EOF
)"
```

**PR title rules:**

- Lowercase after prefix: `fix: lemon squeezy webhook integration`
- NOT: `Fix: Lemon Squeezy webhook integration`

### 9. Label Pull Request

After creating a PR with `--pr`, add labels from the repository's existing
label set before requesting review. Use labels that match the commit type and
changed surface area.

```bash
PR_NUMBER=$(gh pr view --json number --jq .number)
gh api -X POST "repos/{owner}/{repo}/issues/${PR_NUMBER}/labels" \
  -f 'labels[]=🛠 bugfix'
```

**Common label mapping:**

- `fix`: `🛠 bugfix`
- `feat`: `🎯 feature`
- `docs`: `📖 documentation`
- `test` or test-only changes: `🧪 test`
- `refactor`: `፦ refactor`
- CI/build changes: `💨 ci` or `👷‍♀️ build`
- Type-only changes: `❄️ types`

Add multiple labels when applicable. For example, a bug fix that adds or updates
tests should usually get both `🛠 bugfix` and `🧪 test`.

---

## Example Commit Messages

**AI prompt improvement:**

```
fix: add confidence scoring and speculation detection to AI responses
```

**New feature:**

```
feat: add repository automation settings page
```

**Bug fix:**

```
fix: lemon squeezy webhook subscription sync
```

---

## Quick Reference

```bash
# Full workflow from main
git checkout -b feat/my-feature
# ... make changes ...
bun run typecheck && bun run lint
git add convex/_ai/
git commit -m "feat: add new AI feature"
git push -u origin feat/my-feature
gh pr create --title "feat: add new AI feature" --body "..."
```
