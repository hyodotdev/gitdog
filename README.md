<p align="center">
  <img src="https://raw.githubusercontent.com/hyodotdev/gitdog-cli/main/.github/assets/gitdog-logo.png" alt="Gitdog" width="112" height="112">
</p>

<h1 align="center">Gitdog CLI</h1>

<p align="center">
  Your GitHub assistant. Now in the terminal.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/gitdog"><img src="https://img.shields.io/npm/v/gitdog?logo=npm&amp;color=CB3837" alt="npm version"></a>
  <a href="https://github.com/hyodotdev/gitdog-cli/actions/workflows/ci.yml"><img src="https://github.com/hyodotdev/gitdog-cli/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/hyodotdev/gitdog-cli/actions/workflows/release.yml"><img src="https://github.com/hyodotdev/gitdog-cli/actions/workflows/release.yml/badge.svg" alt="npm release"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.14.0-3c873a?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22.14 or later"></a>
  <a href="https://gitdog.dev"><img src="https://img.shields.io/badge/Gitdog-gitdog.dev-111" alt="Gitdog website"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/hyodotdev/gitdog-cli/main/.github/assets/terminal.svg?v=0.2.2" alt="Gitdog terminal: connect a project, configure automation and review pending actions" width="800">
</p>

Connect repositories, configure issue, discussion and PR automation, review
AI actions, and manage project tasks from your terminal or CI.

## Run with npx

Requires **Node.js 22.14+**. No global installation needed.

```sh
npx gitdog@latest --help
```

## Quick start

```sh
npx gitdog@latest login
npx gitdog@latest github install
npx gitdog@latest github recover
npx gitdog@latest init owner/repo
npx gitdog@latest config set requireApproval true
npx gitdog@latest config set pullRequestReviewsEnabled true
npx gitdog@latest config set requireApprovalForPullRequests true
npx gitdog@latest config push
```

GitHub App setup is only needed once. A project connects an existing GitHub
repository to Gitdog.

## Everyday commands

| Task                     | Command                                 |
| ------------------------ | --------------------------------------- |
| List projects            | `npx gitdog@latest projects list`       |
| Read automation settings | `npx gitdog@latest config get --remote` |
| Review pending actions   | `npx gitdog@latest tickets pending`     |
| Check code indexing      | `npx gitdog@latest index status`        |
| List team members        | `npx gitdog@latest team members`        |
| Check usage              | `npx gitdog@latest usage summary`       |

Use `npx gitdog@latest --help` to explore commands. Add `--json` for scripts.

## Use in CI

```sh
npx gitdog@latest keys create --name ci
npx --yes gitdog@0.2.2 --key-file /path/to/key.json projects list --json
npx gitdog@latest keys revoke KEY_ID --yes
```

`keys create` prints the private key file's path. Keys are project-scoped and
read-only by default; add `--write` for settings and ticket delete/restore. Keep key
files out of Git.

---

[Command reference](https://github.com/hyodotdev/gitdog-cli/blob/main/docs/REFERENCE.md)
· [Gitdog](https://gitdog.dev)
· [Report an issue](https://github.com/hyodotdev/gitdog-cli/issues)
