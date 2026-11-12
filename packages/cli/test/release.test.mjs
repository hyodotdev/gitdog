import assert from "node:assert/strict";
import test from "node:test";
import { validateRelease, assertProvenance } from "../scripts/release.mjs";

const repo = "https://github.com/hyodotdev/gitdog";
const pkg = {
  name: "gitdog",
  version: "0.1.1",
  repository: { url: `git+${repo}.git` },
};
const event = {
  action: "published",
  repository: { full_name: "hyodotdev/gitdog" },
  release: { tag_name: "v0.1.1", draft: false, prerelease: false },
};
const sha = "a".repeat(40);

test("release gates reject wrong tags, package identities and prerelease channels", () => {
  assert.equal(validateRelease(pkg, event, sha).channel, "latest");
  for (const change of [
    { tag_name: "v0.1.0" },
    { draft: true },
    { prerelease: true },
  ])
    assert.throws(() =>
      validateRelease(
        pkg,
        { ...event, release: { ...event.release, ...change } },
        sha,
      ),
    );
  assert.throws(() => validateRelease({ ...pkg, name: "other" }, event, sha));
  assert.throws(() =>
    validateRelease(
      pkg,
      { ...event, repository: { full_name: "other/repo" } },
      sha,
    ),
  );
  assert.throws(() => validateRelease(pkg, event, "not-a-commit"));
  for (const version of ["01.1.0", "0.1.1-beta.01", "0.1.1\n"])
    assert.throws(() => validateRelease({ ...pkg, version }, event, sha));
  assert.equal(
    validateRelease(
      { ...pkg, version: "0.2.0-beta.1" },
      {
        ...event,
        release: {
          ...event.release,
          tag_name: "v0.2.0-beta.1",
          prerelease: true,
        },
      },
      sha,
    ).channel,
    "next",
  );
});

test("provenance must bind the artifact to the exact repository, workflow, tag and commit", () => {
  const release = validateRelease(pkg, event, sha);
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "pkg:npm/gitdog@0.1.1", digest: { sha512: "digest" } }],
    predicate: {
      buildDefinition: {
        buildType:
          "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            repository: repo,
            path: ".github/workflows/release.yml",
            ref: "refs/tags/v0.1.1",
          },
        },
        resolvedDependencies: [
          { uri: `git+${repo}@refs/tags/v0.1.1`, digest: { gitCommit: sha } },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
      },
    },
  };
  assertProvenance(statement, release, "digest");
  assert.throws(() => assertProvenance(statement, release, "wrong digest"));
  for (const [field, value] of [
    ["repository", "https://github.com/other/repo"],
    ["path", ".github/workflows/other.yml"],
    ["ref", "refs/heads/main"],
  ]) {
    const changed = structuredClone(statement);
    changed.predicate.buildDefinition.externalParameters.workflow[field] =
      value;
    assert.throws(() => assertProvenance(changed, release, "digest"));
  }
  const changed = structuredClone(statement);
  changed.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
    "b".repeat(40);
  assert.throws(() => assertProvenance(changed, release, "digest"));
});
