# Development indexing E2E

Run the committed revision against the existing Convex development deployment:

```sh
bun run test:e2e:dev --repository hyochan/ai-chat --installation 89276866
```

The development GitHub App must already have access to the selected public
repository. Fixtures are limited to 100 files. The runner refuses to reuse an
installation that already has development account data, and never targets
production. Local Convex CLI and GitHub CLI authentication are required.

The runner creates a detached temporary worktree, temporarily deploys internal
fixture helpers, and exercises the real repository connection action, GitHub
source indexing, OpenAI vector generation, semantic search and daily-sync handler.
It verifies that unchanged content reuses cached vectors without a second
embedding bill. The synthetic fixture uses the authenticated deployment-admin
CLI identity; it does not exercise browser OAuth or accept terms for a real user.
Issue and discussion automation stays approval-gated and is disabled for the
fixture. No GitHub repository content or permissions are changed.

Cleanup disconnects only the fixture repository, removes its settled usage and
synthetic account, deletes unshared fixture blobs, removes the temporary backend
helpers, redeploys the clean revision and deletes the worktree. Unknown provider
usage is retained for reconciliation if an external failure makes cleanup unsafe.
The original development deployment and its credentials remain available.

Reports are written to `GITDOG_E2E_LOG_DIR` (default: `gitdog-e2e` in the system
temporary directory). No API keys or JWTs are written to reports.

## PR review evaluation

`bun run test:e2e:pr-review` evaluates the current working tree on the fixed
development deployment with real Claude and OpenAI requests. It uses virtual
source fixtures to check an introduced cache-key defect, its corrected version,
and untrusted PR text. It does not read or write GitHub issues, PRs or comments.
Settled usage, synthetic account/project data and temporary functions are cleaned
up; unresolved provider usage is preserved for reconciliation. Reports include
exact source fingerprints and per-request usage, with no credentials.
