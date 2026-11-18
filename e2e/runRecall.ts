import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Replays the reviewer on commits where other reviewers later found issues
// (e2e/recall/cases.json) and reports how many of those issues it raised.
// Real provider calls on the development deployment; costs money.
const deployment = "fortunate-chihuahua-679";
const repository = "hyodotdev/gitdog";
const root = path.resolve(import.meta.dirname, "..");
const logRoot = path.resolve(
  process.env.GITDOG_E2E_LOG_DIR ?? path.join(tmpdir(), "gitdog-e2e"),
);
mkdirSync(logRoot, { recursive: true });
type Expected = { path: string; priority: string; title: string };
type Replay = {
  seconds: number;
  findings: Array<{
    path: string;
    line: number;
    priority: string;
    confidence: number;
    title: string;
  }>;
  headReads: number;
  excludedPaths: string[];
};
type Case = {
  pr: number;
  headSha: string;
  title: string;
  expected: Expected[];
};
const only = process.argv.slice(2).map(Number).filter(Boolean);
const cases = (
  JSON.parse(
    readFileSync(path.join(root, "e2e/recall/cases.json"), "utf8"),
  ) as Case[]
).filter((c) => only.length === 0 || only.includes(c.pr));
const runId = randomUUID();
const workspace = mkdtempSync(path.join(path.dirname(root), ".gitdog-recall-"));
const envFile = path.join(workspace, ".env.local");
const childEnv = { ...process.env };
delete childEnv.CONVEX_DEPLOY_KEY;
const report: Record<string, unknown> = { runId, deployment, cases: [] };

function exec(command: string, args: string[], timeout = 180000): string {
  return execFileSync(command, args, {
    cwd: workspace,
    env: childEnv,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function gh<T>(endpoint: string): T {
  return JSON.parse(exec("gh", ["api", endpoint]));
}
function call<T>(name: string, args: unknown): T {
  const file = path.join(workspace, "args.json");
  writeFileSync(file, JSON.stringify(args));
  return JSON.parse(
    exec(
      "bunx",
      [
        "convex",
        "run",
        name,
        readFileSync(file, "utf8"),
        "--deployment",
        deployment,
      ],
      900000,
    ),
  );
}
function deploy() {
  exec(
    "bunx",
    [
      "convex",
      "dev",
      "--once",
      "--tail-logs",
      "disable",
      "--env-file",
      envFile,
    ],
    300000,
  );
}
function tree(sha: string): string[] {
  const value = gh<{ tree: Array<{ type: string; path: string }> }>(
    `repos/${repository}/git/trees/${sha}?recursive=1`,
  );
  return value.tree.filter((x) => x.type === "blob").map((x) => x.path);
}

let seeded:
  { userId: string; repositoryId: string; actionId: string } | undefined;
let deployed = false;
let funded: string | undefined;
try {
  for (const file of [
    "package.json",
    "bun.lock",
    "convex.json",
    "tsconfig.json",
  ])
    if (existsSync(path.join(root, file)))
      cpSync(path.join(root, file), path.join(workspace, file));
  cpSync(path.join(root, "convex"), path.join(workspace, "convex"), {
    recursive: true,
  });
  symlinkSync(
    path.join(root, "node_modules"),
    path.join(workspace, "node_modules"),
    "dir",
  );
  const helpers = path.join(workspace, "convex/e2eSupport");
  mkdirSync(helpers);
  for (const name of ["prReviews.ts", "prRecall.ts"])
    writeFileSync(
      path.join(helpers, name),
      readFileSync(path.join(root, "e2e/convex", name), "utf8").replaceAll(
        '"../../convex/',
        '"../',
      ),
    );
  writeFileSync(
    envFile,
    `CONVEX_DEPLOYMENT=dev:${deployment}\nVITE_CONVEX_URL=https://${deployment}.convex.cloud\n`,
    { mode: 0o600 },
  );
  deployed = true;
  deploy();
  seeded = call("e2eSupport/prReviews:seedReview", { runId });
  funded = call<string>("e2eSupport/prRecall:fundReplay", {
    userId: seeded!.userId,
  });
  for (const c of cases) {
    const compare = gh<{
      merge_base_commit: { sha: string };
      files: Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      }>;
    }>(`repos/${repository}/compare/main...${c.headSha}`);
    const baseSha = compare.merge_base_commit.sha;
    const pr = gh<{ body: string | null }>(`repos/${repository}/pulls/${c.pr}`);
    let result: Replay;
    try {
      result = call<Replay>("e2eSupport/prRecall:replayReview", {
        ...seeded,
        repository,
        headSha: c.headSha,
        baseSha,
        title: c.title,
        body: pr.body ?? "",
        files: compare.files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          ...(f.patch !== undefined ? { patch: f.patch } : {}),
        })),
        paths: tree(c.headSha),
        basePaths: tree(baseSha),
      });
    } catch (error) {
      // The CLI can give up on a long review while the action still runs;
      // record the case and keep the fixture funded for the rest.
      const stderr = (error as { stderr?: unknown }).stderr;
      const message = String(typeof stderr === "string" ? stderr : error)
        .trim()
        .slice(-500);
      (report.cases as unknown[]).push({
        pr: c.pr,
        headSha: c.headSha,
        error: message,
      });
      console.log(`PR ${c.pr} @ ${c.headSha.slice(0, 7)}: failed (${message})`);
      continue;
    }
    const changed = new Set(compare.files.map((f) => f.filename));
    const notReviewed = result.excludedPaths.filter((p) => changed.has(p));
    // A file-level hit; titles are printed for a person to confirm.
    const hits = c.expected.filter((e) =>
      result.findings.some((f) => f.path === e.path),
    );
    const entry = {
      pr: c.pr,
      headSha: c.headSha.slice(0, 7),
      changedFiles: compare.files.length,
      expected: c.expected.length,
      fileLevelHits: hits.length,
      notReviewed,
      ...result,
      expectedIssues: c.expected,
    };
    (report.cases as unknown[]).push(entry);
    console.log(
      `PR ${c.pr} @ ${entry.headSha}: ${result.findings.length} findings, ` +
        `${hits.length}/${c.expected.length} expected files hit, ` +
        `${notReviewed.length} of ${compare.files.length} changed files not fully reviewed, ${result.seconds}s`,
    );
  }
} catch (error) {
  // The command line holds the whole diff; the cause is on stderr.
  const stderr = (error as { stderr?: unknown }).stderr;
  report.error =
    typeof stderr === "string" && stderr.trim()
      ? stderr.trim().slice(-4000)
      : error instanceof Error
        ? error.message.slice(-4000)
        : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  try {
    if (funded)
      call("e2eSupport/prRecall:unfundReplay", { subscriptionId: funded });
    if (seeded)
      report.cleanup = call("e2eSupport/prReviews:cleanupReview", {
        runId,
        userId: seeded.userId,
        repositoryId: seeded.repositoryId,
      });
  } catch (error) {
    report.cleanupError = String(error).slice(0, 1000);
    process.exitCode = 1;
  }
  try {
    if (deployed) {
      rmSync(path.join(workspace, "convex/e2eSupport"), {
        recursive: true,
        force: true,
      });
      deploy();
    }
  } catch (error) {
    report.temporaryFunctionsRemoved = false;
    report.removalError = String(error).slice(0, 1000);
    process.exitCode = 1;
  }
  const out = path.join(logRoot, `pr-review-recall-${runId}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  rmSync(workspace, { recursive: true, force: true });
  console.log(`Report: ${out}`);
}
