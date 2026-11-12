# /up-to-date - Sync, Refresh Dependencies, and Clean the Repo

Bring the checkout to a clean, current, verified state: sync `main`, retire dead
branches, refresh dependencies inside their declared ranges, and prove the result
with the full gate.

## Usage

```
/up-to-date [options]
```

**Options:**

- `--deps`: Only refresh dependencies (skip branch and worktree cleanup)
- `--clean`: Only sync and clean (skip dependency work)
- `--pr`: Open a PR at the end instead of leaving the branch local

Default (no options) runs every step below.

## Execution Flow

### 1. Sync main

```bash
git checkout main && git pull --prune
git status --porcelain   # must be empty before going further
```

If the working tree is dirty, stop and report. Never stash the user's work away
silently.

### 2. Retire merged branches — prove it before deleting

This repo squash-merges, so **`git cherry` and `git log main..branch` both lie**:
squashing collapses N commits into one, patch-ids never match, and every commit
looks unmerged. Compare trees instead.

```bash
# For each local branch whose upstream is gone:
git branch -vv | grep ': gone]'

# Prove the content already landed. Find the squash commit on main, then:
git rev-parse <branch>^{tree}
git rev-parse <squash-commit>^{tree}
git diff <branch> <squash-commit> | wc -l    # 0 means fully merged
```

Delete only when the trees match exactly or a file-level comparison shows main
already contains the work. If commits are genuinely absent from main, **do not
delete** — report them and let the user decide.

```bash
git branch -D <branch>   # only after the proof above
git remote prune origin
```

### 3. Refresh dependencies

Stay inside the declared semver ranges. `bun update` does exactly that.

```bash
bun outdated          # survey first
bun update            # in-range minors and patches only
bunx update-browserslist-db@latest   # clears the stale caniuse-lite build warning
```

**Do not silently cross a major**, and do not unpin an exact version. An exact
pin with no caret (e.g. `"convex": "1.42.2"`) is a deliberate decision — surface
it as a recommendation instead of editing `package.json`.

Drop dependencies nothing imports:

```bash
grep -rn --include='*.ts' --include='*.tsx' '<package-name>' src convex test
# zero hits across all three -> bun remove <package-name>
```

### 4. Handle the two things that always break after an update

- **Prettier minor bumps reformat files.** `format:check` is a CI gate, so run
  `bun run format` right after updating and commit the drift with the bump.
- **`lint` runs with `--max-warnings 0`.** A typescript-eslint minor can add
  rules to the recommended set and fail CI on warnings that did not exist before.

An icon or type package can also drop an export between minors — a typecheck
error naming a missing member means the upstream removed it, not that the code
is wrong. Replace the usage; do not pin backwards without saying why.

### 5. Verify — the whole gate, not part of it

```bash
bun run check   # typecheck + lint + format:check
bun run test    # vitest run, full suite
bun run build   # vite build
```

All three must pass before anything is committed. `bun run check` alone is not
enough: it skips tests and the build.

### 6. Commit and report

Follow `.claude/commands/commit.md`. The rules from root `CLAUDE.md` stay in
force:

- **NEVER** commit without explicit user confirmation
- **NEVER** add a Claude co-author trailer
- Commit messages, PR titles, and PR bodies in English, lowercase after the
  prefix (`chore: refresh dependencies`)
- Label the PR (`🛠 bugfix`, `🧪 test`, `:stadium: ui`, `:earth_americas: web`,
  `:rabbit2: server`, `👷‍♀️ build`)

### 7. If it deploys, verify the deployed artifact

A green `Deploy on merge to main` check is not proof the change is live — an
older successful run is easy to mistake for the current one. Confirm the
artifact itself:

```bash
gh run view <run-id> --json status,conclusion    # the specific run, by id
curl -sI https://gitdog.dev/ | grep -i last-modified
curl -s "https://gitdog.dev/?cb=$RANDOM" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

The bundle hash must have changed and `last-modified` must be recent. Grep the
new bundle for a string only the new code contains.

## Output Format

```markdown
## Up to date

| Area         | Result                                      |
| ------------ | ------------------------------------------- |
| main         | synced to <sha>                             |
| Branches     | <n> deleted, <n> kept (unmerged work)       |
| Dependencies | <n> updated in range, <n> removed as unused |
| Gate         | check / test (<n>) / build — pass           |

### Needs a decision

- <major upgrades, deliberate pins, or branches with unmerged commits>
```

## Project-Specific Notes

- Package manager is `bun`. Never `npm install` or `yarn`.
- `bun run check` = `typecheck + lint + format:check`. Tests and build are separate.
- The pre-commit hook already runs lint-staged + typecheck + test. Never bypass
  it with `--no-verify`.
- `bun audit` runs in CI as a non-blocking `security` job.
- There is no Renovate or Dependabot config — this command is the dependency
  freshness process.
