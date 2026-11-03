import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repository = "https://github.com/hyodotdev/gitdog-cli";
const registry = "https://registry.npmjs.org";
class RegistryPendingError extends Error {}

export function validateRelease(pkg, event, sha) {
  assert.equal(pkg.name, "gitdog", "Unexpected npm package");
  assert.equal(pkg.repository?.url, `git+${repository}.git`);
  assert.match(
    pkg.version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/,
  );
  const prerelease = pkg.version.split("-")[1];
  if (prerelease)
    for (const part of prerelease.split("."))
      assert.ok(!/^0\d+$/.test(part), "Invalid numeric prerelease");
  assert.equal(event.action, "published");
  assert.equal(event.repository?.full_name, "hyodotdev/gitdog-cli");
  assert.equal(event.release?.draft, false);
  assert.equal(
    event.release?.tag_name,
    `v${pkg.version}`,
    "Tag must match package version",
  );
  assert.equal(event.release?.prerelease, Boolean(prerelease));
  assert.match(sha, /^[a-f0-9]{40}$/);
  return {
    version: pkg.version,
    tag: `v${pkg.version}`,
    channel: prerelease ? "next" : "latest",
    sha,
  };
}

async function metadata(version) {
  const response = await fetch(
    `${registry}/gitdog/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (response.status === 404) return null;
  assert.equal(response.status, 200, "npm registry lookup failed");
  return response.json();
}

export function assertProvenance(statement, release, digest) {
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1");
  assert.deepEqual(statement.subject, [
    { name: `pkg:npm/gitdog@${release.version}`, digest: { sha512: digest } },
  ]);
  const build = statement.predicate.buildDefinition;
  assert.equal(
    build.buildType,
    "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
  );
  assert.deepEqual(build.externalParameters.workflow, {
    repository,
    path: ".github/workflows/release.yml",
    ref: `refs/tags/${release.tag}`,
  });
  assert.ok(
    build.resolvedDependencies.some(
      (entry) =>
        entry.uri === `git+${repository}@refs/tags/${release.tag}` &&
        entry.digest.gitCommit === release.sha,
    ),
    "Provenance commit mismatch",
  );
  assert.equal(
    statement.predicate.runDetails.builder.id,
    "https://github.com/actions/runner/github-hosted",
  );
}

async function verifyPublished(release, tarball, required) {
  const value = await metadata(release.version);
  if (!value) {
    assert.ok(!required, "Published package missing");
    return false;
  }
  assert.equal(value.name, "gitdog");
  assert.equal(value.version, release.version);
  const hash = createHash("sha512").update(readFileSync(tarball)).digest();
  assert.equal(
    value.dist.integrity,
    `sha512-${hash.toString("base64")}`,
    "Published tarball differs",
  );
  if (!value.dist.attestations?.provenance)
    throw new RegistryPendingError("npm provenance is not available yet");
  assert.equal(
    value.dist.attestations?.provenance?.predicateType,
    "https://slsa.dev/provenance/v1",
  );
  const url = new URL(value.dist.attestations.url);
  assert.equal(url.origin, registry);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (
    response.status === 404 ||
    response.status === 429 ||
    response.status >= 500
  )
    throw new RegistryPendingError("npm attestation endpoint is not ready");
  assert.equal(response.status, 200);
  const attestations = await response.json();
  const bundle = attestations.attestations.find(
    (entry) => entry.predicateType === "https://slsa.dev/provenance/v1",
  )?.bundle;
  assert.ok(bundle, "npm provenance missing");
  const npmRoot = execFileSync("npm", ["root", "--global"], {
    encoding: "utf8",
  }).trim();
  const npmRequire = createRequire(join(npmRoot, "npm", "package.json"));
  await npmRequire("sigstore").verify(bundle, {
    certificateIssuer: "https://token.actions.githubusercontent.com",
    certificateIdentityURI: `${repository}/.github/workflows/release.yml@refs/tags/${release.tag}`,
    timeout: 10000,
    retry: { retries: 2 },
  });
  assert.equal(bundle.dsseEnvelope.payloadType, "application/vnd.in-toto+json");
  assertProvenance(
    JSON.parse(
      Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"),
    ),
    release,
    hash.toString("hex"),
  );
  console.log(
    `Verified gitdog@${release.version}: tarball, signature, workflow and commit`,
  );
  return true;
}

async function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const release = validateRelease(pkg, event, process.env.GITHUB_SHA);
  assert.equal(process.env.GITHUB_REF, `refs/tags/${release.tag}`);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    release.sha,
  );
  assert.equal(
    execFileSync("git", ["rev-parse", `refs/tags/${release.tag}^{commit}`], {
      encoding: "utf8",
    }).trim(),
    release.sha,
    "Release tag moved away from the event commit",
  );
  execFileSync("git", [
    "merge-base",
    "--is-ancestor",
    release.sha,
    "origin/main",
  ]);
  const tarball = `gitdog-${release.version}.tgz`;
  switch (process.argv[2]) {
    case "check": {
      const latest = await metadata("latest");
      if (
        latest &&
        release.channel === "latest" &&
        !(await metadata(release.version))
      ) {
        const old = latest.version.split(".").map(Number);
        const next = release.version.split(".").map(Number);
        assert.ok(
          next.some(
            (n, i) =>
              n > old[i] && next.slice(0, i).every((v, j) => v === old[j]),
          ),
          "Stable releases must advance latest",
        );
      }
      console.log(
        `Validated ${release.tag} (${release.channel}) at ${release.sha}`,
      );
      break;
    }
    case "publish": {
      // Existing versions are immutable; never publish them again.
      if (!(await metadata(release.version)))
        execFileSync(
          "npm",
          [
            "publish",
            tarball,
            "--ignore-scripts",
            "--access",
            "public",
            "--tag",
            release.channel,
            "--provenance",
            "--registry",
            registry,
          ],
          { stdio: "inherit" },
        );
      // Registry propagation is bounded; no repeated publishing.
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          if (await verifyPublished(release, tarball, false)) return;
        } catch (error) {
          const transientNetworkFailure = [
            "ECONNRESET",
            "ECONNREFUSED",
            "ETIMEDOUT",
            "EAI_AGAIN",
            "ENOTFOUND",
            "UND_ERR_CONNECT_TIMEOUT",
          ].includes(error?.cause?.code ?? error?.code);
          if (
            !(error instanceof RegistryPendingError) &&
            !transientNetworkFailure
          )
            throw error;
          if (attempt === 59) throw error;
          console.log("Waiting for npm provenance propagation");
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      throw new Error(
        "Registry did not expose the release within five minutes; rerun to verify",
      );
    }
    default:
      throw new Error("Use release.mjs check or publish");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
