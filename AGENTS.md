# AGENTS.md

## Project

Gitdog is an AI-powered GitHub assistant for repository automation. It is built with React, TypeScript, Convex, Tailwind CSS, Lemon Squeezy, and GitHub App integration.

## Layout

- The web app and Convex backend live at the repository root.
- `packages/cli` is the published `gitdog` npm CLI (bun workspace). Its `src/api-catalog.json` is generated from `convex/`; run `bun run check:api` when public Convex functions change, and `bun run test:cli` for CLI changes.

## Source Of Truth

- Read `CLAUDE.md` first for repository rules.
- Read `docs/convention.md` for implementation conventions.
- For workflow-style tasks, follow `.codex/skills/gitdog-workflows/SKILL.md` and the relevant `.claude/commands/*.md` file.
- Do not mention internal agent files, skills, or private workflow names in user-facing GitHub issue, discussion, PR, or review comments.

## Package Manager

- Use `bun`, not `npm`.
- Run scripts with `bun run ...`.
- Use `bunx convex ...` for Convex CLI commands.
- CI installs dependencies with `bun install --frozen-lockfile`.

## Git And PRs

- Do not commit unless the user explicitly approves.
- Commit messages, PR titles, and PR descriptions must be in English.
- Use conventional commit style with lowercase subjects, for example `fix: update convex deploy workflow`.
- Never add Claude, Codex, or other agent co-author trailers.
- Preserve unrelated dirty worktree changes.
- Inspect untracked files before deleting them; discard only files that are clearly unnecessary.
- Use branch prefix `codex/` unless the user requests another prefix.

## Validation

- For TypeScript or Convex changes, run `bun run typecheck` and `bun run lint`.
- For broad shared behavior, also run `bun test` when available.
- For workflow-only changes, run Prettier on touched YAML and Markdown files.
- Keep generated Convex files only when intentionally updated.

## Convex

- Do not create barrel export files in the `convex/` root.
- Organize functions in subdirectories with `query.ts`, `mutation.ts`, and `action.ts`.
- Use the new Convex function syntax with validators.
- Authenticate with `getAuthUserId(ctx)` from `@convex-dev/auth/server`.
- Use dot-notation API references such as `api.repositories.query.list`.
- Use `.withIndex()` instead of `.filter()` for database queries.
- Avoid unbounded `.collect()`; use `paginatedCollect()` for large reads.
- Production deploys use GitHub Actions secret `CONVEX_DEPLOY_KEY` and `bunx convex deploy --yes`.

## Frontend

- Follow the existing sharp rectangular monochrome design system.
- Use `@preact/signals-react` for global state and React `useState` for local component state.
- Put global signals in `src/utils/signals/`.
- Call `useSignals()` in components that read signal values.
- Use `LoadingIndicator` instead of plain loading text.
- User-facing text should start with capital letters.
- Use `@icons-pack/react-simple-icons` for brand and technology icons.

## Safety

- Do not expose secrets in logs, commits, PRs, or final messages.
- Prefer editing existing files over creating new files unless the task requires a new file.
- Keep comments concise and only add them when the code is not self-explanatory.
- Read existing implementation patterns before adding abstractions.
