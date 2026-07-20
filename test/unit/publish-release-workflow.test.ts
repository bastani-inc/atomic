import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import publishRelease from "../../.atomic/workflows/publish-release.js";
import {
  prereleaseVersionPattern,
  releaseVersionPattern,
  validateReleaseRequest,
} from "../../.atomic/workflows/lib/publish-release.js";

const workflowSource = (): string => readFileSync(".atomic/workflows/publish-release.ts", "utf8");

describe("publish-release request validation", () => {
  test("accepts stable and alpha versions with matching release kinds", () => {
    assert.equal(releaseVersionPattern.test("1.2.3"), true);
    assert.equal(prereleaseVersionPattern.test("1.2.3-alpha.1"), true);
    assert.deepEqual(validateReleaseRequest("release", "1.2.3"), {
      kind: "release",
      version: "1.2.3",
      branch: "release/1.2.3",
    });
    assert.deepEqual(validateReleaseRequest("prerelease", "1.2.3-alpha.1"), {
      kind: "prerelease",
      version: "1.2.3-alpha.1",
      branch: "prerelease/1.2.3-alpha.1",
    });
  });

  test("rejects placeholders, leading v, mismatched kinds, and alpha revision zero", () => {
    for (const [kind, version] of [
      ["release", "0.0.0"],
      ["release", "v1.2.3"],
      ["release", "01.2.3"],
      ["release", "1.2.3-alpha.1"],
      ["prerelease", "1.2.3"],
      ["prerelease", "1.2.3-alpha.0"],
    ] as const) {
      assert.throws(() => validateReleaseRequest(kind, version), /target_version/u);
    }
  });
});

test("invalid versions return the declared structured failure output", async () => {
  for (const [release_kind, target_version] of [
    ["release", "v1.2.3"],
    ["prerelease", "1.2.3"],
  ] as const) {
    const result = await publishRelease.run({
      inputs: { target_version, release_kind, base_ref: "main" },
    } as never);

    assert.equal(result.status, "failed");
    assert.equal(result.target_version, target_version);
    assert.equal(result.release_kind, release_kind);
    assert.equal(result.branch, `${release_kind}/${target_version}`);
    assert.match(result.summary, /validate-release-request/u);
    assert.match(result.summary, /target_version/u);
  }
});

test("invalid base refs return the declared structured failure output", async () => {
  const result = await publishRelease.run({
    inputs: {
      target_version: "1.2.3",
      release_kind: "release",
      base_ref: "origin/main",
    },
  } as never);

  assert.equal(result.status, "failed");
  assert.equal(result.target_version, "1.2.3");
  assert.equal(result.release_kind, "release");
  assert.equal(result.branch, "release/1.2.3");
  assert.match(result.summary, /validate-release-base-ref/u);
  assert.match(result.summary, /canonical remote branch name/u);
});

test("workflow follows the short versionless release sequence", () => {
  const source = workflowSource();
  const stages = [
    "prepare-changelog-branch",
    "validate-commit-push-open-pr",
    "inspectGate(\"required CI\"",
    "merge-exact-head-and-sync-base",
    "cut-and-push-release-tag",
    "inspectGate(\"publish action\"",
  ];

  let prior = -1;
  for (const stage of stages) {
    const index = source.indexOf(stage);
    assert.ok(index > prior, `${stage} must follow the previous stage`);
    prior = index;
  }
});

test("workflow preserves versionless bases and inspects direct tag publication", () => {
  const source = workflowSource();
  assert.match(source, /package manifests, lockfiles, Cargo files, and generated version files remain at 0\.0\.0/u);
  assert.match(source, /scripts\/cut-release\.ts \$\{release\.version\} --base \$\{baseRef\} --push --yes/u);
  assert.match(source, /Pushing the version tag directly starts publish\.yml/u);
  assert.match(source, /push-event publish\.yml run for the exact tag and release SHA/u);
  assert.match(source, /exact publish workflow path, matching tag, SHA, and push event/u);
  assert.doesNotMatch(source, /gh workflow run|workflow_dispatch|environment:\s*npm-publish/u);
});

test("external gates watch to a terminal state and stop the run instead of prompting humans", () => {
  const source = workflowSource();
  assert.doesNotMatch(source, /await ctx\.ui\.select|Reinspect after external state changes|Stop this release/u);
  assert.match(source, /until they reach a terminal state/u);
  assert.match(source, /re-check with gh pr checks\/view roughly every 30 seconds/u);
  assert.match(source, /admin merge/u);
  assert.match(source, /Watch the automatically triggered Publish \$\{release\.version\} GitHub Actions run until it completes/u);
  assert.match(source, /did not reach a terminal state within the watch window/u);
});

test("workflow contains no executable wait, polling, watch, or manual publisher dispatch", () => {
  const source = workflowSource();
  assert.doesNotMatch(source, /setTimeout|Bun\.sleep|while\s*\(|for\s*\(\s*;\s*;|gh\s+(?:run|pr)\s+watch|gh\s+workflow\s+run/u);
});
