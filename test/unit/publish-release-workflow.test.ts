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

test("workflow preserves versionless bases and delegates publication to the tag-created pipeline", () => {
  const source = workflowSource();
  assert.match(source, /package manifests, lockfiles, Cargo files, and generated version files remain at 0\.0\.0/u);
  assert.match(source, /scripts\/cut-release\.ts \$\{release\.version\} --base \$\{baseRef\} --push --yes/u);
  assert.match(source, /Pushing the version tag automatically starts publish\.yml/u);
  assert.match(source, /automatically triggered Publish \$\{release\.version\}/u);
  assert.doesNotMatch(source, /gh workflow run|workflow_dispatch|environment:\s*npm-publish/u);
});

test("pending and failed external gates pause for a same-run human decision", () => {
  const source = workflowSource();
  assert.match(source, /await ctx\.ui\.select/u);
  assert.match(source, /Reinspect after external state changes/u);
  assert.match(source, /Stop this release/u);
  assert.match(source, /continue this same workflow run and reinspect/u);
  assert.match(source, /return inspectGate\(label, prompt, attempt \+ 1\)/u);
});

test("workflow contains no executable wait, polling, watch, or manual publisher dispatch", () => {
  const source = workflowSource();
  assert.doesNotMatch(source, /setTimeout|Bun\.sleep|while\s*\(|for\s*\(\s*;\s*;|gh\s+(?:run|pr)\s+watch|gh\s+workflow\s+run/u);
});
