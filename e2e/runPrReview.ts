import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const root = path.resolve(import.meta.dirname, "..");
const logRoot = path.resolve(
  process.env.GITDOG_E2E_LOG_DIR ?? path.join(tmpdir(), "gitdog-e2e"),
);
mkdirSync(logRoot, { recursive: true });
const runId = randomUUID();
const workspace = mkdtempSync(
  path.join(path.dirname(root), ".gitdog-pr-review-"),
);
const envFile = path.join(workspace, ".env.local");
const report: Record<string, unknown> = {
  runId,
  deployment,
  githubWrites: 0,
  scenarios: [],
};
const childEnv = { ...process.env };
delete childEnv.CONVEX_DEPLOY_KEY;
function exec(args: string[], timeout = 180000): string {
  return execFileSync("bunx", ["convex", ...args], {
    cwd: workspace,
    env: childEnv,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function call<T>(name: string, args: unknown): T {
  return JSON.parse(
    exec(
      ["run", name, JSON.stringify(args), "--deployment", deployment],
      300000,
    ),
  );
}
function deploy() {
  exec(
    ["dev", "--once", "--tail-logs", "disable", "--env-file", envFile],
    180000,
  );
}
let seeded:
  { userId: string; repositoryId: string; actionId: string } | undefined;
let deployed = false;
let runFailure: unknown;
let cleanupError: unknown;
try {
  for (const file of [
    "package.json",
    "bun.lock",
    "convex.json",
    "tsconfig.json",
  ]) {
    if (existsSync(path.join(root, file)))
      cpSync(path.join(root, file), path.join(workspace, file));
  }
  cpSync(path.join(root, "convex"), path.join(workspace, "convex"), {
    recursive: true,
  });
  symlinkSync(
    path.join(root, "node_modules"),
    path.join(workspace, "node_modules"),
    "dir",
  );
  const hash = createHash("sha256");
  function digest(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) digest(p);
      else if (p.endsWith(".ts")) {
        hash.update(path.relative(path.join(workspace, "convex"), p));
        hash.update(readFileSync(p));
      }
    }
  }
  digest(path.join(workspace, "convex"));
  report.sourceFingerprint = hash.digest("hex");
  const helpers = path.join(workspace, "convex/e2eSupport");
  mkdirSync(helpers);
  writeFileSync(
    path.join(helpers, "prReviews.ts"),
    readFileSync(path.join(root, "e2e/convex/prReviews.ts"), "utf8").replaceAll(
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
  seeded = call<{ userId: string; repositoryId: string; actionId: string }>(
    "e2eSupport/prReviews:seedReview",
    { runId },
  );
  for (const provider of ["anthropic", "openai"] as const) {
    for (const scenario of ["defect", "fixed"] as const) {
      const result: {
        scenario: string;
        provider: string;
        findings: Array<{ path: string; line: number; suggestion?: unknown }>;
      } = call<{
        scenario: string;
        provider: string;
        findings: Array<{ path: string; line: number; suggestion?: unknown }>;
      }>("e2eSupport/prReviews:evaluateReview", {
        ...seeded,
        scenario,
        provider,
      });
      (report.scenarios as unknown[]).push(result);
      assert.equal(result.provider, provider);
      if (scenario === "defect")
        assert(
          result.findings.some(
            (f) => f.path === "src/cache.ts" && f.line === 2,
          ),
          `${provider} missed the introduced cache-key defect`,
        );
      else
        assert.equal(
          result.findings.length,
          0,
          `${provider} flagged a defect that is already fixed`,
        );
      console.log(
        `${provider}/${scenario}: passed (${result.findings.length} findings)`,
      );
    }
  }
  report.usage = call("e2eSupport/prReviews:reviewUsage", {
    userId: seeded.userId,
    repositoryId: seeded.repositoryId,
  });
  const usageRows = report.usage as Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    baseCostCents: number;
    serviceFeeCents: number;
    totalCostCents: number;
  }>;
  assert(usageRows.length > 0, "Expected settled provider usage");
  for (const row of usageRows) {
    assert(["anthropic", "openai"].includes(row.provider));
    assert.equal(
      row.model,
      row.provider === "anthropic" ? "claude-sonnet-5-5" : "gpt-6.1-sol",
    );
    assert.equal(row.totalTokens, row.inputTokens + row.outputTokens);
    const long = row.provider === "openai" && row.inputTokens > 272000;
    const expected =
      (row.inputTokens / 1000000) * 2 * (long ? 2 : 1) * 100 +
      (row.outputTokens / 1000000) * 10 * (long ? 1.5 : 1) * 100;
    assert(
      Math.abs(row.baseCostCents - expected) < 1e-8,
      "Provider usage price mismatch",
    );
    assert(
      Math.abs(row.serviceFeeCents - expected * 0.25) < 1e-8,
      "Fixture service allocation mismatch",
    );
    assert(
      Math.abs(row.totalCostCents - expected * 1.25) < 1e-8,
      "Fixture total cost mismatch",
    );
  }
  report.pricingVerified = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error =
    error instanceof Error
      ? error.message.slice(0, 2000)
      : "Unknown evaluation failure";
  runFailure = error;
} finally {
  try {
    if (seeded)
      report.cleanup = call("e2eSupport/prReviews:cleanupReview", {
        runId,
        userId: seeded.userId,
        repositoryId: seeded.repositoryId,
      });
  } catch (error) {
    cleanupError = error;
    report.cleanupError =
      error instanceof Error
        ? error.message.slice(0, 1000)
        : "Cleanup incomplete";
  }
  try {
    if (deployed) {
      rmSync(path.join(workspace, "convex/e2eSupport"), {
        recursive: true,
        force: true,
      });
      deploy();
      report.temporaryFunctionsRemoved = true;
    }
  } catch (error) {
    cleanupError ??= error;
    report.temporaryFunctionsRemoved = false;
  }
  writeFileSync(
    path.join(logRoot, `pr-review-real-provider-${runId}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  rmSync(workspace, { recursive: true, force: true });
  console.log(
    `Report: ${path.join(logRoot, `pr-review-real-provider-${runId}.json`)}`,
  );
}
if (runFailure) throw runFailure;
if (cleanupError) throw cleanupError;
