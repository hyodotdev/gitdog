# Contributing to Gitdog

Thanks for your interest in Gitdog. This guide covers how the repository is
organized, how to run it locally and what a pull request needs.

## Repository layout

| Path           | What lives there                                        |
| -------------- | ------------------------------------------------------- |
| `src/`         | React web app (Vite, Tailwind CSS, react-i18next)       |
| `convex/`      | Convex backend: GitHub App, AI workflows, billing, data |
| `packages/cli` | The `gitdog` npm CLI (bun workspace)                    |
| `test/`        | Vitest suites for the web app and backend               |
| `e2e/`         | Opt-in end-to-end runners against a development backend |
| `docs/`        | Conventions, GitHub App setup and AI model notes        |

## How it works

```text
GitHub webhook ─▶ Convex ─▶ repository index (keyword search)
                    │
                    ▼
        Claude Sonnet 5.5 (GPT-6.1 Sol fallback)
                    │
                    ▼
     draft reply or review ─▶ approval ─▶ GitHub comment / PR review
```

See [docs/ai-models.md](docs/ai-models.md) for model routing, pricing and usage
accounting.

## Development setup

Use Node.js 26 (`nvm use`) and Bun 1.4.4.

```bash
bun install
cp .env.example .env.local   # fill in your own development values
bunx convex dev              # creates or connects your Convex dev deployment
bun run dev                  # web app and Convex together
```

A development GitHub App is required for repository features; follow
[docs/github-app-setup.md](docs/github-app-setup.md).

## Checks

Run these before opening a pull request:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test
```

When you change public Convex functions, also run `bun run check:api` (and
regenerate the CLI catalog with `bun packages/cli/scripts/sync-api.mjs` if it
reports drift). For CLI changes, run `bun run typecheck:cli && bun run test:cli`.

## Pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org) with a
  lowercase subject, for example `fix: keep the review checkpoint on retry`.
- Write commit messages, PR titles and descriptions in English.
- Keep each pull request focused, and add or update tests with behavior changes.
- Follow [docs/convention.md](docs/convention.md) and [CLAUDE.md](CLAUDE.md) for
  code style.

## Security

Please do not open public issues for security problems. Email
[hyo@hyo.dev](mailto:hyo@hyo.dev) instead.

## License

This repository is currently marked `UNLICENSED` in `package.json`.
