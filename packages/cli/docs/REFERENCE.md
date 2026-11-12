# Command reference

Detailed commands, credentials and development setup for [Gitdog CLI](../README.md).

Every command below works without global installation: replace `gitdog` with
`npx gitdog@latest` (add `--yes` before the package name in non-interactive scripts).
For example: `npx gitdog@latest login`. An optional global installation with
`npm install --global gitdog` provides the shorter `gitdog` command.

## Sign in

`gitdog login` opens GitHub in your browser. Use a browser on the same computer,
or pass `--no-browser` to open the printed URL yourself. Ctrl+C cancels the entire
sign-in flow. The browser callback times out after five minutes. When sign-in
finishes, your browser shows the result on Gitdog and the tab can be closed.

## Projects, like Firebase

A Gitdog project is an authorized GitHub repository connected to your workspace.
Creating one connects it to Gitdog and schedules indexing; it does not create a
new GitHub repository. GitHub App permissions remain controlled by GitHub.

```sh
gitdog github install
gitdog github recover
gitdog projects available
gitdog projects create owner/repo
gitdog init owner/repo --alias production

gitdog use owner/another-repo --add staging
gitdog use production
gitdog use --list
gitdog projects list
gitdog status --project staging
gitdog open
```

`init` detects the current checkout's GitHub `origin` and offers it as the default
in interactive mode. Supply `owner/repo` explicitly in scripts. It writes a
portable `gitdog.json`; running from a nested directory finds the nearest parent
configuration. Existing files are preserved unless `--force` is supplied.

```json
{
  "version": 1,
  "defaultProject": "production",
  "projects": {
    "production": {
      "repository": "owner/repo",
      "settings": {
        "requireApproval": true,
        "issueResponseStyle": "Be concise and provide concrete examples."
      }
    }
  }
}
```

The configuration may be committed: it contains project names and settings,
never credentials. `--project` accepts an alias, `owner/repo`, or a Convex
repository ID. `--config` selects an explicit configuration file. Endpoint URLs
are deliberately kept out of project configuration so checking out a repository
cannot redirect saved credentials to another server.

## Project API keys

Create a project and issue a key with an owner login:

```sh
gitdog projects create owner/repo
gitdog init owner/repo
gitdog keys create --name ci --write --expires-in 30
gitdog keys list
```

The one-time secret is saved to a `0600` JSON file in the private credentials
directory. Output contains the key ID, prefix, permissions, expiry and file
path, never the secret. `--out /private/path/key.json` selects another new file.
Existing files are preserved. The server stores only a SHA-256 hash of a random
256-bit secret. Default expiry is 30 days; `--expires-in` accepts 1–365 days.
Each project supports 50 unrevoked keys. Metadata lists support `--limit` and
`--cursor`. Keep key files out of Git and transfer them through a secret manager.

Use the returned file without an owner session:

```sh
gitdog --key-file /private/path/key.json keys check
gitdog --key-file /private/path/key.json projects list
gitdog --key-file /private/path/key.json init owner/repo
gitdog --key-file /private/path/key.json config get --remote
gitdog --key-file /private/path/key.json config set issueResponseStyle 'Be concise.'
gitdog --key-file /private/path/key.json config push --yes
gitdog --key-file /private/path/key.json tickets list
gitdog --key-file /private/path/key.json index files
```

Default scope is `read`. `--write` adds project settings and ticket
delete/restore permissions. Keys access only their own project. Project/key
creation, billing, member management and GitHub write approvals require an owner
login. Failed key requests never fall back to a saved owner session.

```sh
gitdog keys revoke KEY_ID --yes
```

Revocation immediately blocks subsequent requests and is safe to repeat. The
default local copy is also removed; remove custom copies or CI secrets yourself.
Project disconnection immediately invalidates its keys and deletes their metadata
during cleanup. Expired keys, missing owners and revoked GitHub connections fail
authentication too.

`GITDOG_API_KEY_FILE` is an alternative to `--key-file`. CI may supply a raw
`GITDOG_API_KEY` through a secret store and set `GITDOG_API_URL`. Do not combine
raw-key and file modes. Files are bound to their API origin. Unset key variables
to use the owner session for key management. `doctor` identifies the selected
authentication mode; `keys check` verifies it with a live request.

The HTTP endpoint is `https://YOUR_DEPLOYMENT.convex.site/v1/cli`. Supply the key
in `X-Gitdog-Api-Key` with `Content-Type: application/json` and a body such as
`{"kind":"query","path":"repositories/query:list","args":{}}`. Responses are
`{"value":...}` or `{"error":{"code":"UNAUTHORIZED","message":"..."}}` with
appropriate HTTP status codes. Every request checks the key and runs its
operation in the same transaction.

Key operations cover project list/get/settings, indexing status/logs, cached
files, learning counts, ticket list/pending/get/delete/restore and action reads.
Ticket aggregation is bounded to 1,000 tickets per project and 500 actions per
ticket (100 pending actions), with separate 4 MB ticket and 6 MB action read
budgets; over-limit requests fail explicitly. Advanced `api call` secret issuance
is disabled: use `keys create` for secure file output. Custom backends must include the companion `apiKeys` functions, schema and HTTP route.

## Configure every automation setting

```sh
gitdog config keys
gitdog config get
gitdog config get --remote
gitdog config set requireApproval false
gitdog config set issueResponseStyle 'Answer in Korean, with concise examples.'
gitdog config push --dry-run
gitdog config push
gitdog config pull
```

`set` edits local configuration. `push` shows before/after changes, asks for
confirmation, applies them and verifies the saved values. Partial configurations
are merged with current server settings; omitted settings are preserved. Use
`--yes` for a deliberate non-interactive application. `pull` confirms before
replacing local settings. No-op pushes do not write to the server.

| Issue settings                 | Discussion settings                      | Type    |
| ------------------------------ | ---------------------------------------- | ------- |
| `issueAssistantEnabled`        | `discussionAssistantEnabled`             | Boolean |
| `autoFormatIssue`              | `autoFormatDiscussion`                   | Boolean |
| `autoAnswerQuestions`          | `autoAnswerDiscussionQuestions`          | Boolean |
| `tagMaintainersForCodeChanges` | `tagMaintainersForDiscussionCodeChanges` | Boolean |
| `requireApproval`              | `requireApprovalForDiscussions`          | Boolean |
| `issueResponseStyle`           | `discussionResponseStyle`                | String  |

## Feature inventory

The implementation was compared with every public function in the companion
Gitdog backend: **86 operations**. Friendly commands cover normal workflows;
`api list`, `api describe` and `api call` expose the complete public inventory,
including advanced admin operations. Internal functions are excluded. All
authorization is enforced by the existing backend.

| Feature                  | Commands                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Authentication           | `login`, `logout`, `whoami`, `doctor`                                                                      |
| Projects                 | `init`, `use`, `status`, `open`, `projects list/available/create/get/reconnect/sync/enable/disable/delete` |
| Automation settings      | `config keys/get/set/pull/push`                                                                            |
| Indexing and cached code | `index status/logs/files/file/restart/learnings`                                                           |
| Issues and discussions   | `tickets list/pending/get/delete/restore`                                                                  |
| Assistant approvals      | `actions list/get/approve/reject/request-changes`                                                          |
| Notifications            | `notifications list/count/read/read-all`                                                                   |
| Members and sharing      | `team members/role/invite/invitations/remove/leave`                                                        |
| Incoming invitations     | `invitations list/accept/reject/cancel`                                                                    |
| Usage and quota          | `usage summary/projects/estimate/quota`                                                                    |
| Plans and token packs    | `billing status/pricing/checkout`                                                                          |
| Account                  | `account profile/sync/consent`                                                                             |
| GitHub App access        | `github install/installations/recover/bind/retry`                                                          |
| Admin views              | `admin status/stats/logs/payments/subscriptions`                                                           |
| Advanced admin writes    | `admin call <operation> --data @args.json`                                                                 |
| Complete public API      | `api list/describe/call`                                                                                   |

`repos` is an alias for `projects`. Firebase-style colon commands work too:
`projects:list`, `projects:create`, `config:push`, `tickets:pending`.

```sh
gitdog tickets pending --type issue
gitdog tickets list --all --status open --search regression --limit 20 --offset 20
gitdog actions get ACTION_ID
gitdog actions approve ACTION_ID
gitdog actions request-changes ACTION_ID 'Include a minimal reproduction.'

gitdog index status --wait --timeout 300
gitdog index logs --limit 50
gitdog index file src/index.ts
gitdog projects sync

gitdog team invite username
gitdog team invitations --pending
gitdog invitations accept INVITATION_ID
gitdog usage summary
gitdog billing checkout pro --open
gitdog billing checkout small
```

Approval executes the approved action on GitHub. Project deletion disconnects
the Gitdog project and removes cached Gitdog data; the GitHub repository is
preserved. Team features and ownership restrictions follow the web app's plan
and access rules. Checkout returns a secure link; purchasing requires completing
the provider's checkout. Account eligibility and policy consent are completed in
the browser using `account consent`, or through an explicitly selected public
API operation. Consent is never inferred from login.

Admin token adjustments, subscription changes, payment log edits, settlement
retries and provider usage reconciliation are available through the public API
catalog. Inspect the validator before sending exact arguments. Billing operation
IDs must be UUIDs and reused when retrying the same operation.

```sh
gitdog api list --filter admin/
gitdog api describe admin/paymentMutation:addTokens
gitdog admin call admin/paymentMutation:addTokens --data @adjustment.json --yes
gitdog api call tickets/query:list --data '{"limit":10,"offset":0}' --json
```

Queries run directly. Advanced mutations and actions require confirmation or
`--yes`; review their arguments before execution. Use `--data @file.json` for
multiline feedback or complex arguments. GitHub webhooks, AI generation,
embeddings, learning extraction and scheduled jobs stay on the server; they
are triggered by the same connection, sync and approval flows as the web app.
There is no MCP server or MCP integration in this package.

## Scripting and credentials

```sh
gitdog projects list --json
gitdog config push --project production --yes --json
gitdog tickets pending --project owner/repo --json
```

`--json` emits one JSON result to stdout without banners, colors, progress
messages or interactive questions. Errors are JSON on stderr with a nonzero
exit status. Commands requiring confirmation also need `--yes`. Browser login
is interactive and rejects `--json`. `--help` and `--version` keep their standard
text output.

| Environment variable  | Purpose                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GITDOG_API_KEY_FILE` | Project API key file; equivalent to `--key-file`                                                           |
| `GITDOG_API_KEY`      | Raw project API key from a secret store; set `GITDOG_API_URL` too                                          |
| `GITDOG_TOKEN`        | Supply an existing Gitdog/Convex bearer token for automation; it is never saved or automatically refreshed |
| `GITDOG_CONFIG_DIR`   | Private credentials directory; defaults to `$XDG_CONFIG_HOME/gitdog` or `~/.config/gitdog`                 |
| `GITDOG_API_URL`      | Explicit backend override; also available as `--api-url`                                                   |
| `GITDOG_SITE_URL`     | Explicit website override; also available as `--site-url`                                                  |
| `GITDOG_NO_BANNER=1`  | Hide the dog banner                                                                                        |
| `NO_COLOR=1`          | Disable ANSI color                                                                                         |

`GITDOG_TOKEN` is a Gitdog session token, not a GitHub personal access token. Treat
it as a secret and supply it through your CI secret store. This version does
not issue long-lived service-account tokens. Browser sessions refresh
automatically; rotation and logout are serialized with a credential lock.
Sessions are bound to their API origin. Credential directories use mode `0700`
and files use `0600` on POSIX systems; Windows uses the account's filesystem ACLs.
Credentials are stored locally as JSON, so keep the directory private.

`logout` revokes the current server session before clearing the saved session.
If the server is unavailable or the credential file is damaged, `logout --local`
removes only local credentials. Unset `GITDOG_TOKEN` before revoking a saved
browser session. Stale locks from an interrupted process produce a diagnostic
with the lock path; remove that lock only after the other Gitdog process exits.

For a development backend:

```sh
gitdog login --api-url https://your-deployment.convex.cloud --site-url http://localhost:5173
gitdog github install --app gitdogbot-dev
```

Custom URLs require HTTPS except for loopback development. The sign-in URL must
use the selected backend's origin or its matching `convex.site` origin.

## Development and verification

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun scripts/sync-api.mjs --check
```

Tests run the compiled code under Node, including real local HTTP login and
token-refresh exchanges, state/redirect rejection, concurrent sessions, project
creation, settings round trips, command contracts and JSON errors. They do not
sign in to or modify a live Gitdog account. Set `GITDOG_TEST_DIR` to place
disposable fixtures on an external QA volume.

The separate live development test requires the companion `gitdog.dev` checkout,
Convex administrator access, GitHub CLI access, and a public repository with at
most 100 files that the development GitHub App can already access:

```sh
GITDOG_DEV_DEPLOYMENT=<dev-deployment> GITDOG_TEST_REPORT_DIR=<report-dir> \
  bun run test:dev --repository owner/test-repo --installation INSTALLATION_ID
```

It targets only the named Convex development deployment (and verifies it is a
development deployment before running), refuses an installation with existing
development data, creates isolated test users, connects the real GitHub project,
checks concurrent project enable/disable commands, issues read/write keys,
uses them without owner credentials, verifies cached
file content against GitHub, checks access denial/revocation/expiry/disconnection,
and removes its project, keys, sessions, fixture data and unshared file storage.
It uses server-issued test sessions; browser OAuth is a separate test. Test users
cannot invoke paid AI work. Reports go to `GITDOG_TEST_REPORT_DIR`; temporary credentials stay in
the local private cache and are removed even if remote cleanup fails. Inspect the
report's cleanup result before retrying a failed run.

`scripts/sync-api.mjs` reads the repository's `convex` directory by default. Use
`--backend=/absolute/path/to/convex` for another checkout. Run it without
`--check` to regenerate the catalog when public functions change. The published
CLI includes the catalog and does not require the backend source at runtime.

To prepare a package, run `npm pack`; the prepack hook builds `dist`.

## Release the CLI

Update both versions in `package.json` and `src/ui.ts`, then merge to `main`.
Publish a GitHub Release tagged `vVERSION`; the Release workflow validates and
tests that commit, packs once, smoke-tests the archive on Node.js 22.14, then
publishes the same archive through npm trusted publishing. Stable releases use
`latest`; GitHub prereleases use `next`. No npm token is needed in GitHub secrets.

The npm trusted publisher is restricted to `hyodotdev/gitdog`, `release.yml`
and the `npm` GitHub environment. The workflow verifies the registry archive and
signed provenance against the release tag and commit. A rerun verifies an already
published matching archive instead of republishing it.

### Pull request reviews

```sh
npx gitdog@latest config set pullRequestReviewsEnabled true
npx gitdog@latest config set pullRequestSuggestionsEnabled true
npx gitdog@latest config set requireApprovalForPullRequests true
npx gitdog@latest config push --dry-run
npx gitdog@latest config push
npx gitdog@latest tickets pending --type pull_request
```

Reviews are opt-in and require GitHub App pull-request write permission.
Proposals appear in Tickets; approval posts inline comments on the reviewed
commit. GitHub commit suggestions can be applied individually or as a batch by authors
or reviewers with write access. Disable them with
`config set pullRequestSuggestionsEnabled false`. Gitdog does not approve merges,
commit changes automatically or execute PR code. Incomplete coverage
and failed reviews remain visible. New settings require the corresponding
Gitdog server release.
