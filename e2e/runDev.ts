import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const deployment = "fortunate-chihuahua-679";
const runId = randomUUID();
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const repository = process.argv[process.argv.indexOf("--repository") + 1];
const installationId = Number(
  process.argv[process.argv.indexOf("--installation") + 1],
);
if (
  !process.argv.includes("--repository") ||
  !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
  !Number.isSafeInteger(installationId) ||
  installationId <= 0
)
  throw new Error(
    "Specify --repository owner/repo --installation ID for an existing development App installation",
  );
const logRoot = path.resolve(
  process.env.GITDOG_E2E_LOG_DIR ?? path.join(tmpdir(), "gitdog-e2e"),
);
mkdirSync(logRoot, { recursive: true });
const workspace = path.join(path.dirname(root), `.gitdog-e2e-${runId}`);
const helperDir = path.join(workspace, "convex/e2eSupport");
const envFile = path.join(workspace, ".env.e2e");
const report: Record<string, unknown> = {
  runId,
  revision,
  repository,
  deployment,
};
let userId: string | undefined;
let repositoryId: string | undefined;
let workspaceCreated = false;
let helpersDeployed = false;
let failure: unknown;

function exec(
  command: string,
  args: string[],
  cwd = workspace,
  timeout = 90_000,
): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const err = error as { stderr?: Buffer; message: string };
    throw new Error(
      `${command} failed: ${err.stderr?.toString().slice(-3000) ?? err.message}`,
      { cause: error },
    );
  }
}
function call<T>(ref: string, args: unknown, authenticated = false): T {
  const identity = authenticated
    ? ["--identity", JSON.stringify({ subject: userId })]
    : [];
  return JSON.parse(
    exec("bunx", [
      "convex",
      "run",
      ref,
      JSON.stringify(args),
      "--deployment",
      deployment,
      ...identity,
    ]),
  );
}
type Progress = {
  repositoryId: string | null;
  indexStatus: string | null;
  ragStatus: string | null;
  indexVersion: number | null;
  mode: string | null;
  chunks: number;
  vectors: number;
  embeddingUsageRows: number;
  usageProviders: string[];
  blobIds: string[];
  foreignActive: boolean;
  error: string | null;
};
function progress(): Progress {
  return call("e2eSupport/internalQuery:progress", {
    runId,
    userId,
    ...(repositoryId ? { repositoryId } : {}),
  });
}
async function waitFor(
  label: string,
  predicate: (p: Progress) => boolean,
  timeout = 180_000,
  checkIndexFailure = true,
): Promise<Progress> {
  const deadline = Date.now() + timeout;
  let lastReport = 0;
  while (Date.now() < deadline) {
    const p = progress();
    if (predicate(p)) return p;
    if (Date.now() - lastReport > 15_000) {
      console.log(
        label,
        JSON.stringify({
          index: p.indexStatus,
          rag: p.ragStatus,
          version: p.indexVersion,
          chunks: p.chunks,
          vectors: p.vectors,
        }),
      );
      lastReport = Date.now();
    }
    if (
      checkIndexFailure &&
      (p.indexStatus === "failed" || p.ragStatus === "failed")
    )
      throw new Error(
        `${label}: indexing failed (${p.error ?? "inspect development logs"})`,
      );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${label}: deadline exceeded`);
}
function deploy(): void {
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
    workspace,
    180_000,
  );
}

try {
  const metadata = JSON.parse(
    exec("gh", ["api", `repos/${repository}`], root),
  ) as {
    id: number;
    private: boolean;
    default_branch: string;
    owner: { id: number; login: string };
  };
  assert.equal(
    metadata.private,
    false,
    "Use a public repository for this fixture",
  );
  const tree = JSON.parse(
    exec(
      "gh",
      [
        "api",
        `repos/${repository}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`,
      ],
      root,
    ),
  ) as { truncated: boolean; tree: Array<{ type: string }> };
  assert(
    !tree.truncated && tree.tree.filter((e) => e.type === "blob").length <= 100,
    "Use a repository with at most 100 files",
  );
  exec("git", ["worktree", "add", "--detach", workspace, revision], root);
  workspaceCreated = true;
  symlinkSync(
    path.join(root, "node_modules"),
    path.join(workspace, "node_modules"),
    "dir",
  );
  mkdirSync(helperDir, { recursive: true });
  for (const name of readdirSync(path.join(workspace, "e2e/convex")))
    if (name.endsWith(".ts"))
      writeFileSync(
        path.join(helperDir, name),
        readFileSync(
          path.join(workspace, "e2e/convex", name),
          "utf8",
        ).replaceAll('"../../convex/', '"../'),
      );
  writeFileSync(
    envFile,
    `CONVEX_DEPLOYMENT=dev:${deployment}\nVITE_CONVEX_URL=https://${deployment}.convex.cloud\n`,
    { mode: 0o600 },
  );
  helpersDeployed = true;
  deploy();
  userId = call<{ userId: string }>("e2eSupport/internalMutation:seed", {
    runId,
    installationId,
    ownerId: String(metadata.owner.id),
    ownerLogin: metadata.owner.login,
  }).userId;
  repositoryId = call<string>(
    "repositories/action:createAndIndex",
    { installationId, githubRepositoryId: metadata.id },
    true,
  );
  call(
    "repositories/mutation:updateSettings",
    {
      repositoryId,
      settings: {
        issueAssistantEnabled: false,
        autoFormatIssue: false,
        autoAnswerQuestions: false,
        tagMaintainersForCodeChanges: false,
        requireApproval: true,
        discussionAssistantEnabled: false,
        autoFormatDiscussion: false,
        autoAnswerDiscussionQuestions: false,
        tagMaintainersForDiscussionCodeChanges: false,
        requireApprovalForDiscussions: true,
      },
    },
    true,
  );
  const first = await waitFor(
    "Initial OpenAI index",
    (p) => p.indexStatus === "completed" && p.ragStatus === "completed",
  );
  assert.equal(first.mode, "openai");
  assert(first.chunks > 0 && first.vectors > 0);
  assert(first.usageProviders.includes("openai"));
  assert(!first.usageProviders.includes("google"));
  report.initial = first;
  const results = call<unknown[]>("ragV2/action:hybridSearch", {
    repositoryId,
    query: "application user interface entry point",
    requestedByUserId: userId,
    topK: 5,
  });
  assert(results.length > 0);
  report.searchResults = results.length;
  const beforeSync = progress();
  assert.equal(
    beforeSync.embeddingUsageRows,
    first.embeddingUsageRows + 1,
    "Semantic search must perform and meter an actual OpenAI query embedding",
  );
  assert.equal(
    beforeSync.foreignActive,
    false,
    "Periodic E2E must not schedule another user's repository",
  );
  call("repoIndexing/internalAction:dailySyncAllRepositories", {});
  const second = await waitFor(
    "Periodic OpenAI index",
    (p) =>
      (p.indexVersion ?? 0) > (first.indexVersion ?? 0) &&
      p.indexStatus === "completed" &&
      p.ragStatus === "completed",
  );
  assert.equal(second.mode, "openai");
  assert(second.vectors > 0);
  report.periodic = second;
  assert.equal(
    second.embeddingUsageRows,
    beforeSync.embeddingUsageRows,
    "Unchanged content must reuse cached vectors without another embedding bill",
  );
  console.log(
    "Live development indexing, search and periodic cache reuse passed",
  );
} catch (error) {
  failure = error;
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (helpersDeployed && !userId) {
    try {
      userId =
        call<string | null>("e2eSupport/internalQuery:findFixture", {
          runId,
        }) ?? undefined;
    } catch (error) {
      failure ??= error;
      report.fixtureRecoveryError =
        error instanceof Error ? error.message : String(error);
    }
  }
  if (helpersDeployed && userId) {
    try {
      const snapshot = progress();
      repositoryId ??= snapshot.repositoryId ?? undefined;
      if (repositoryId && snapshot.repositoryId) {
        call("repositories/mutation:remove", { repositoryId }, true);
        await waitFor(
          "Fixture disconnect",
          (p) => p.repositoryId === null,
          120_000,
          false,
        );
      }
      report.cleanup = call("e2eSupport/internalMutation:cleanup", {
        runId,
        userId,
        blobIds: snapshot.blobIds,
      });
      const readback = call<Record<string, boolean>>(
        "e2eSupport/internalQuery:verifyCleanup",
        { userId, repositoryId, blobIds: snapshot.blobIds },
      );
      assert(Object.values(readback).every((v) => !v));
      report.cleanupVerified = readback;
    } catch (error) {
      failure ??= error;
      report.cleanupError =
        error instanceof Error ? error.message : String(error);
    }
  }
  if (workspaceCreated) {
    try {
      rmSync(helperDir, { recursive: true, force: true });
      if (helpersDeployed) deploy();
      rmSync(envFile, { force: true });
      exec("git", ["diff", "--exit-code"], workspace);
      exec("git", ["worktree", "remove", workspace], root);
    } catch (error) {
      failure ??= error;
      report.environmentCleanupError =
        error instanceof Error ? error.message : String(error);
    }
  }
  writeFileSync(
    path.join(logRoot, `openai-indexing-${runId}.json`),
    JSON.stringify(report, null, 2),
  );
}
if (failure) throw failure;
console.log(
  "Development fixture data, temporary functions and worktree removed",
);
