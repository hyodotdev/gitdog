# Gitdog

AI-powered GitHub Assistant for your repositories.

## Features

- **Issue Assistant** - Auto-format issues, answer questions, tag maintainers
- **Discussion Assistant** - Same features for GitHub Discussions
- **Repository Indexing** - Code analysis with RAG for context-aware responses
- **Usage-based Billing** - Token tracking with Lemon Squeezy integration

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS
- **Backend**: Convex (real-time database)
- **Auth**: GitHub App (OAuth + repository access)
- **Payments**: Lemon Squeezy
- **AI**: Claude Sonnet 5.5 with GPT-6.1 Sol fallback; OpenAI embeddings for retrieval
- **i18n**: react-i18next (en, ko, ja)

## Quick Start

Use Node.js 26 LTS (`nvm use`) and Bun 1.4.4.

```bash
bun install
cp .env.example .env
bun run dev
```

## Repository Layout

- Web app and Convex backend at the repository root (`src/`, `convex/`)
- [`packages/cli`](packages/cli): the `gitdog` CLI, published to npm. Its API
  catalog is generated from `convex/`; run `bun run check:api` after changing
  public Convex functions.

## Documentation

- [Development Guidelines](CLAUDE.md)
- [Code Conventions](docs/convention.md)
- [GitHub App Setup](docs/github-app-setup.md)
- [CLI Reference](packages/cli/docs/REFERENCE.md)

## License

This repository is currently marked `UNLICENSED` in `package.json`.
