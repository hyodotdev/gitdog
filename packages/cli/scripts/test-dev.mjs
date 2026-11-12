import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { httpClient, invoke } from "../dist/client.js";
import { SessionStore } from "../dist/storage.js";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = resolve(root, "../..");
const deployment = process.env.GITDOG_DEV_DEPLOYMENT;
assert(
  /^[a-z]+-[a-z]+-\d+$/.test(deployment ?? ""),
  "Set GITDOG_DEV_DEPLOYMENT to the Convex development deployment name.",
);
const apiUrl = `https://${deployment}.convex.cloud`;
const httpUrl = `https://${deployment}.convex.site`;
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
assert(
  process.argv.includes("--repository") &&
    /^[\w.-]+\/[\w.-]+$/.test(value("--repository")),
  "Pass --repository owner/repo for an existing public development-App repository.",
);
assert(process.argv.includes("--installation"), "Pass --installation ID.");
const repositoryName = value("--repository");
const installationId = Number(value("--installation"));
assert(Number.isSafeInteger(installationId) && installationId > 0);
const reportRoot = process.env.GITDOG_TEST_REPORT_DIR;
assert(
  reportRoot && (await stat(reportRoot)).isDirectory(),
  "Set GITDOG_TEST_REPORT_DIR to an existing directory for run reports.",
);
const runId = randomUUID();
const marker = `gitdog-key-e2e-${runId.slice(0, 8)}`;
const output = join(resolve(reportRoot), `project-keys-${runId}`);
const privateRoot = await mkdtemp(
  join(homedir(), "Library/Caches/gitdog-key-e2e-"),
);
await mkdir(output, { recursive: true });
const env = { ...process.env };
for (const name of [
  "CONVEX_DEPLOY_KEY",
  "GITDOG_TOKEN",
  "GITDOG_API_KEY",
  "GITDOG_API_KEY_FILE",
  "GITDOG_API_URL",
  "GITDOG_HTTP_URL",
])
  delete env[name];
const report = {
  runId,
  deployment,
  repository: repositoryName,
  marker,
  checks: [],
  createdAt: new Date().toISOString(),
  success: false,
  cleanup: null,
};
const owned = new Set();
const sessions = {};
const keyFiles = [];
let reportWrite = Promise.resolve();
let repositoryId;
let fixtureOwnerId;
let baselineBlobs = new Set();
const fixtureBlobIds = new Set();
let client;

async function query(source) {
  const result = await exec(
    "bunx",
    ["convex", "run", "--deployment", deployment, "--inline-query", source],
    { cwd: web, env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  );
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
async function admin(path, args) {
  if (!client) {
    const auth = JSON.parse(
      await readFile(join(homedir(), ".convex/config.json"), "utf8"),
    );
    const response = await fetch(
      "https://api.convex.dev/api/deployment/authorize_within_current_project",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          selectedDeploymentName: deployment,
          projectSelection: {
            kind: "deploymentName",
            deploymentName: deployment,
            deploymentType: "dev",
          },
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    assert.equal(response.status, 200);
    const authorization = await response.json();
    assert.equal(authorization.url, apiUrl);
    assert.equal(authorization.deploymentType, "dev");
    client = httpClient(apiUrl, 30000);
    client.setAdminAuth(authorization.adminKey);
  }
  return invoke(
    client,
    "mutation",
    path.includes(":") ? path : `${path}:default`,
    args,
  );
}
async function rows(table) {
  const result = await query(
    `return await ctx.db.query(${JSON.stringify(table)}).take(1001)`,
  );
  assert(result.length < 1001, `Refusing incomplete scan of ${table}.`);
  return result;
}
async function insert(table, documents) {
  assert.equal(
    (await admin("_system/frontend/addDocument", { table, documents })).success,
    true,
  );
  const matches = (await rows(table)).filter((row) =>
    Object.values(row).some(
      (field) =>
        typeof field === "string" &&
        (field.startsWith(marker) || owned.has(field)),
    ),
  );
  matches.forEach((row) => owned.add(row._id));
  return matches;
}
async function session(role, userId) {
  const result = await admin("auth:store", {
    args: { type: "signIn", userId, generateTokens: true },
  });
  assert.equal(typeof result.tokens?.token, "string");
  const directory = join(privateRoot, role);
  const store = new SessionStore();
  Object.defineProperty(store, "path", {
    value: join(directory, "session.json"),
  });
  await store.save({
    ...result.tokens,
    apiUrl,
    siteUrl: "http://localhost:5173",
  });
  sessions[role] = { directory, store };
}
async function checkpoint() {
  report.fixture = {
    repositoryId,
    fixtureOwnerId,
    ownedIds: [...owned],
    baselineBlobIds: [...baselineBlobs],
    blobIds: [...fixtureBlobIds],
  };
  const content = JSON.stringify(report, null, 2) + "\n";
  reportWrite = reportWrite.then(() =>
    writeFile(join(output, "report.json"), content),
  );
  await reportWrite;
}
async function cli(
  args,
  { role = "owner", keyFile, fail = false, verify } = {},
) {
  const directory = keyFile
    ? join(privateRoot, "without-owner-session")
    : sessions[role].directory;
  const childEnv = { ...env, GITDOG_CONFIG_DIR: directory, NO_COLOR: "1" };
  const argv = [
    join(root, "dist/cli.js"),
    "--json",
    "--yes",
    "--api-url",
    apiUrl,
    ...(keyFile ? ["--key-file", keyFile] : []),
    ...args,
  ];
  let result;
  try {
    const response = await exec(process.execPath, argv, {
      cwd: output,
      env: childEnv,
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    });
    for (const file of keyFiles) {
      const credential = JSON.parse(await readFile(file, "utf8"));
      assert(
        !response.stdout.includes(credential.apiKey) &&
          !response.stderr.includes(credential.apiKey),
        "A key secret appeared in CLI output.",
      );
    }
    if (fail) throw new Error("Expected operation to be rejected.");
    result = JSON.parse(response.stdout);
    if (verify) verify(result);
  } catch (error) {
    if (!fail || !error.code) throw error;
    result = JSON.parse(error.stderr);
    if (verify) verify(result);
  }
  const label = args.slice(0, 2).join(" ");
  report.checks.push({
    command: label,
    authentication: keyFile ? "project key without owner session" : role,
    result: fail ? "denied as expected" : "pass",
  });
  console.log(
    `PASS ${keyFile ? "key" : role}: ${label}${fail ? " (denied)" : ""}`,
  );
  await checkpoint();
  return result;
}
async function request(keyFile, path, args = {}, kind = "query") {
  const credential = JSON.parse(await readFile(keyFile, "utf8"));
  const response = await fetch(`${httpUrl}/v1/cli`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gitdog-Api-Key": credential.apiKey,
    },
    body: JSON.stringify({ kind, path, args }),
    signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, body: await response.json() };
}
async function waitUntil(label, predicate, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out: ${label}`);
}

async function cleanup() {
  if (!repositoryId && fixtureOwnerId) {
    const recovered = await query(
      `return await ctx.db.query("repositories").withIndex("by_user",q=>q.eq("userId",${JSON.stringify(fixtureOwnerId)})).take(2)`,
    );
    assert(
      recovered.length <= 1 &&
        recovered.every(
          (repo) =>
            repo.githubRepo.toLowerCase() === repositoryName.toLowerCase(),
        ),
      "Unexpected fixture projects need inspection.",
    );
    repositoryId = recovered[0]?._id;
    if (repositoryId) owned.add(repositoryId);
  }
  if (repositoryId) {
    const repository = await query(
      `return await ctx.db.get(${JSON.stringify(repositoryId)})`,
    );
    if (repository) {
      await captureFixtureBlobs();
      await cli(["--project", repositoryName, "projects", "delete"]);
    }
    await waitUntil("project and key metadata deletion", async () => {
      const result = await query(
        `return {repo:await ctx.db.get(${JSON.stringify(repositoryId)}),keys:await ctx.db.query("projectApiKeys").withIndex("by_repository",q=>q.eq("repositoryId",${JSON.stringify(repositoryId)})).take(1)}`,
      );
      return !result.repo && result.keys.length === 0;
    });
  }
  for (const role of Object.keys(sessions)) {
    try {
      await cli(["logout"], { role });
    } catch {
      /* Exact-ID cleanup below also revokes sessions. */
    }
  }
  const schema = await readFile(join(web, "convex/schema.ts"), "utf8");
  const tables = [...schema.matchAll(/^  (\w+): defineTable\(/gm)].map(
    (match) => match[1],
  );
  tables.push(
    "users",
    "authAccounts",
    "authSessions",
    "authRefreshTokens",
    "authVerificationCodes",
    "authVerifiers",
    "authRateLimits",
  );
  const readAll = () =>
    query(
      `const result={};for(const table of ${JSON.stringify(tables)})result[table]=await ctx.db.query(table).take(1001);return result;`,
    );
  const data = await readAll();
  for (const [table, records] of Object.entries(data))
    assert(records.length < 1001, `Refusing incomplete ${table} cleanup.`);
  for (let round = 0; round < 5; round++)
    for (const records of Object.values(data))
      for (const row of records) {
        if (
          Object.values(row).some(
            (field) =>
              typeof field === "string" &&
              (field.startsWith(marker) || owned.has(field)),
          )
        )
          owned.add(row._id);
      }
  const reservations = [
    ...(data.embeddingUsageReservations ?? []),
    ...(data.chatUsageReservations ?? []),
  ].filter((row) => owned.has(row._id));
  assert.equal(
    reservations.length,
    0,
    "Unexpected provider work must be reconciled before deleting billing evidence.",
  );
  const toDelete = Object.entries(data).flatMap(([tableName, records]) =>
    records
      .filter((row) => owned.has(row._id))
      .map((row) => ({ id: row._id, tableName })),
  );
  if (toDelete.length)
    assert.equal(
      (await admin("_system/frontend/deleteDocuments", { toDelete })).success,
      true,
    );
  let removedBlobs = 0;
  for (const blob of data.repoFileBlobs ?? []) {
    if (baselineBlobs.has(blob._id) || !fixtureBlobIds.has(blob._id)) continue;
    if (
      await admin("repoIndexing/mutation:deleteFileBlobIfStale", {
        blobId: blob._id,
        threshold: Date.now() + 1,
      })
    )
      removedBlobs++;
  }
  const remaining = await readAll();
  const leftovers = Object.entries(remaining).filter(([, records]) =>
    records.some(
      (row) =>
        owned.has(row._id) ||
        Object.values(row).some(
          (field) => typeof field === "string" && owned.has(field),
        ),
    ),
  );
  assert.deepEqual(leftovers, []);
  await rm(privateRoot, { recursive: true, force: true });
  await rm(join(output, "gitdog.json"), { force: true });
  report.cleanup = {
    deletedDocuments: toDelete.length,
    removedBlobs,
    remainingOwnedDocuments: 0,
    privateCredentialsRemoved: true,
    projectAndKeyMetadataRemoved: true,
  };
}

async function captureFixtureBlobs() {
  const ids = await query(
    `const files=await ctx.db.query("repoFileMap").withIndex("by_repository",q=>q.eq("repositoryId",${JSON.stringify(repositoryId)})).take(101);if(files.length>100)throw new Error("Unexpected project size");const ids=[];for(const file of files){const blob=await ctx.db.query("repoFileBlobs").withIndex("by_sha256",q=>q.eq("sha256",file.sha256)).first();if(blob)ids.push(blob._id);}return ids;`,
  );
  ids.forEach((id) => fixtureBlobIds.add(id));
  await checkpoint();
}

try {
  const metadata = JSON.parse(
    (
      await exec("gh", ["api", `repos/${repositoryName}`], {
        env,
        timeout: 30000,
      })
    ).stdout,
  );
  assert.equal(metadata.private, false, "Select a public test repository.");
  const tree = JSON.parse(
    (
      await exec(
        "gh",
        [
          "api",
          `repos/${repositoryName}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`,
        ],
        { env, timeout: 30000 },
      )
    ).stdout,
  );
  assert(
    !tree.truncated &&
      tree.tree.filter((item) => item.type === "blob").length <= 100,
    "Use a test repository with at most 100 files.",
  );
  const existing = await query(
    `return await ctx.db.query("githubInstallations").withIndex("by_installation_id",q=>q.eq("installationId",${installationId})).take(2)`,
  );
  assert.equal(
    existing.length,
    0,
    "The installation already has development data; preserve it and choose a fresh fixture.",
  );
  baselineBlobs = new Set((await rows("repoFileBlobs")).map((row) => row._id));
  const users = await insert("users", [
    { name: `${marker}-owner` },
    { name: `${marker}-outsider` },
  ]);
  const user = Object.fromEntries(
    users.map((row) => [row.name.split("-").at(-1), row._id]),
  );
  fixtureOwnerId = user.owner;
  await insert(
    "userProfiles",
    Object.entries(user).map(([role, userId]) => ({
      userId,
      githubUsername: `${marker}-${role}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
  );
  // A synthetic fixture receives no legal attestation: file indexing works, paid AI generation remains blocked.
  await insert("githubInstallations", [
    {
      userId: user.owner,
      installationId,
      ownerGithubAccountId: String(metadata.owner.id),
      ownershipVerifiedAt: Date.now(),
      accountLogin: metadata.owner.login,
      accountType: "User",
      targetType: "User",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
  await session("owner", user.owner);
  await session("outsider", user.outsider);
  await cli(["projects", "list"], {
    verify: (result) => assert.deepEqual(result, []),
  });
  const created = await cli(["projects", "create", repositoryName]);
  repositoryId = created._id;
  assert.equal(created.githubRepositoryId, metadata.id);
  owned.add(repositoryId);
  await cli(["init", repositoryName]);
  await waitUntil(
    "initial real GitHub file indexing",
    async () => (await cli(["index", "status"])).status === "completed",
  );
  const beforePause = await cli(["projects", "get", repositoryName]);
  await Promise.all(
    [1, 2].map(() => cli(["projects", "disable", repositoryName])),
  );
  await cli(["projects", "get", repositoryName], {
    verify: (value) => {
      assert.equal(value.isActive, false);
      assert.equal(value.indexVersion, beforePause.indexVersion + 1);
    },
  });
  await Promise.all(
    [1, 2].map(() => cli(["projects", "enable", repositoryName])),
  );
  await cli(["projects", "get", repositoryName], {
    verify: (value) => {
      assert.equal(value.isActive, true);
      assert.equal(value.indexVersion, beforePause.indexVersion + 1);
    },
  });
  await waitUntil(
    "resumed real GitHub file indexing",
    async () => (await cli(["index", "status"])).status === "completed",
  );
  const readFilePath = join(privateRoot, "read-key.json");
  const readKey = await cli([
    "keys",
    "create",
    "--name",
    `${marker}-read`,
    "--expires-in",
    "1",
    "--out",
    readFilePath,
  ]);
  keyFiles.push(readFilePath);
  const writeFilePath = join(privateRoot, "write-key.json");
  const writeKey = await cli([
    "keys",
    "create",
    "--name",
    `${marker}-write`,
    "--write",
    "--expires-in",
    "1",
    "--out",
    writeFilePath,
  ]);
  keyFiles.push(writeFilePath);
  await cli(["keys", "list"], {
    verify: (result) => assert.equal(result.items.length, 2),
  });
  const credential = JSON.parse(await readFile(readFilePath, "utf8"));
  const stored = await query(
    `return await ctx.db.get(${JSON.stringify(readKey.keyId)})`,
  );
  assert.equal(
    stored.tokenHash,
    createHash("sha256").update(credential.apiKey).digest("hex"),
  );
  assert(
    !JSON.stringify(stored).includes(credential.apiKey),
    "Key secret persisted in the database.",
  );
  assert.equal((await stat(readFilePath)).mode & 0o777, 0o600);
  await cli(["keys", "check"], { keyFile: readFilePath });
  await cli(["doctor"], {
    keyFile: readFilePath,
    verify: (result) => assert.equal(result.authentication, "project API key"),
  });
  await cli(["projects", "get", repositoryName], {
    keyFile: readFilePath,
    verify: (result) => assert.equal(result._id, repositoryId),
  });
  const read = await request(readFilePath, "repositories/query:list");
  assert.equal(read.status, 200);
  assert.equal(read.body.value[0]._id, repositoryId);
  report.checks.push({
    command: "direct HTTP key-only request",
    result: "pass",
  });
  const update = {
    repositoryId,
    settings: { issueResponseStyle: `${marker}: concise` },
  };
  assert.equal(
    (
      await request(
        readFilePath,
        "repositories/mutation:updateSettings",
        update,
        "mutation",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        writeFilePath,
        "repositories/mutation:updateSettings",
        update,
        "mutation",
      )
    ).status,
    200,
  );
  await cli(["config", "get", "issueResponseStyle", "--remote"], {
    verify: (value) => assert.equal(value, update.settings.issueResponseStyle),
  });
  await cli(["config", "set", "requireApproval", "false"], {
    keyFile: writeFilePath,
  });
  await cli(["config", "push"], { keyFile: writeFilePath });
  await cli(["config", "get", "requireApproval", "--remote"], {
    verify: (value) => assert.equal(value, false),
  });
  await cli(["tickets", "list"], { keyFile: readFilePath });
  await cli(["tickets", "pending"], { keyFile: readFilePath });
  assert.equal(
    (
      await request(readFilePath, "repositories/query:get", {
        owner: "unrelated",
        repo: "project",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(writeFilePath, "admin/query:isAdmin")).status,
    403,
  );
  await cli(["keys", "revoke", readKey.keyId], {
    role: "outsider",
    fail: true,
  });
  await waitUntil(
    "real GitHub file indexing",
    async () =>
      (await cli(["index", "status"], { keyFile: readFilePath })).status ===
      "completed",
  );
  const files = await cli(["index", "files"], { keyFile: readFilePath });
  const text = files.find((file) => file.isText && file.size > 0);
  assert(text, "Real repository indexing must produce a text file.");
  const file = await cli(["index", "file", text.filePath], {
    keyFile: readFilePath,
  });
  const downloaded = await fetch(file.url, {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(downloaded.status, 200);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  const githubFile = JSON.parse(
    (
      await exec(
        "gh",
        [
          "api",
          `repos/${repositoryName}/contents/${text.filePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(metadata.default_branch)}`,
        ],
        { env, timeout: 30000 },
      )
    ).stdout,
  );
  assert.equal(githubFile.encoding, "base64");
  assert.deepEqual(bytes, Buffer.from(githubFile.content, "base64"));
  report.checks.push({
    command: "key-authorized cached file matches real GitHub content",
    result: "pass",
  });
  await cli(["keys", "revoke", readKey.keyId]);
  await cli(["keys", "revoke", readKey.keyId]);
  assert.equal(
    (await request(readFilePath, "repositories/query:list")).status,
    401,
  );
  await cli(["keys", "check"], { keyFile: readFilePath, fail: true });
  await admin("_system/frontend/patchDocumentsFields", {
    table: "projectApiKeys",
    ids: [writeKey.keyId],
    fields: { expiresAt: Date.now() - 1 },
  });
  assert.equal(
    (await request(writeFilePath, "repositories/query:list")).status,
    401,
  );
  await cli(["keys", "revoke", writeKey.keyId]);
  const liveFile = join(privateRoot, "disconnect-key.json");
  await cli([
    "keys",
    "create",
    "--name",
    `${marker}-disconnect`,
    "--out",
    liveFile,
  ]);
  keyFiles.push(liveFile);
  await captureFixtureBlobs();
  await cli(["projects", "delete", repositoryName]);
  assert.equal(
    (await request(liveFile, "repositories/query:list")).status,
    401,
  );
  report.success = true;
} catch (error) {
  report.failure = error.message
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted token]")
    .replace(/\bgdk_[a-f0-9]{64}\b/g, "[redacted API key]");
  console.error("DEV E2E FAILED:", report.failure);
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    report.cleanup = { error: error.message };
    process.exitCode = 2;
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
    await rm(join(output, "gitdog.json"), { force: true });
    report.cleanup = { ...report.cleanup, privateCredentialsRemoved: true };
  }
  await checkpoint();
  console.log(
    `RESULT success=${report.success}; checks=${report.checks.length}; cleanup=${JSON.stringify(report.cleanup)}`,
  );
  console.log(`Report: ${join(output, "report.json")}`);
}
