import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  prereleaseVersionPattern,
  stableVersionPattern,
  validateReleaseRequest,
} from "../../.atomic/workflows/lib/publish-release.js";
import {
  checkGhVersion,
  minimumGhVersion,
} from "../../.atomic/workflows/lib/publish-release-gh.js";
import { verifyReleaseBaseMetadata } from "../../scripts/release-base.js";

const workflowPath = ".atomic/workflows/publish-release.ts";
const workflowSource = (): string => readFileSync(workflowPath, "utf8");

describe("publish-release input validation", () => {
  test("accepts strict stable and alpha versions with matching release kinds", () => {
    assert.equal(stableVersionPattern.test("1.2.3"), true);
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

  test("rejects placeholders, leading v, leading zeros, mismatched kinds, and alpha revision zero", () => {
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

test("workflow exits before its first stage when gh cannot return an exact dispatched run", () => {
  assert.deepEqual(checkGhVersion("gh version 2.87.0 (2026-02-19)"), { ok: true, version: "2.87.0" });
  assert.deepEqual(checkGhVersion("gh version 3.0.0"), { ok: true, version: "3.0.0" });
  const old = checkGhVersion("gh version 2.86.9");
  assert.equal(old.ok, false);
  if (!old.ok) assert.match(old.summary, new RegExp(`requires gh >= ${minimumGhVersion.replaceAll(".", "\\.")}`, "u"));
  assert.equal(checkGhVersion("unexpected output").ok, false);

  const source = workflowSource();
  const guard = source.indexOf("if (!ghVersion.ok) return stop(\"validate-gh-version\"");
  const firstStage = source.indexOf("prepare-changelog-branch");
  assert.ok(guard >= 0 && guard < firstStage, "gh minimum-version guard must ctx.exit through stop before the first stage");
  assert.match(source, /const stop = .*ctx\.exit/u);
});

test("release-base integrity requires exact trailers, sole expected parent, and SHA", () => {
  const sha = "a".repeat(40);
  const message = `Release 1.2.3\n\nRelease-base-ref: refs/heads/main\nRelease-base-sha: ${sha}\n`;
  assert.deepEqual(verifyReleaseBaseMetadata(message, sha, "refs/heads/main", sha), {
    baseRef: "refs/heads/main",
    baseSha: sha,
  });
  assert.throws(
    () => verifyReleaseBaseMetadata(message, "b".repeat(40), "refs/heads/main", sha),
    /Release parent/u,
  );
  assert.throws(
    () => verifyReleaseBaseMetadata(`${message}Release-base-sha: ${sha}\n`, sha, "refs/heads/main", sha),
    /exactly one/u,
  );
});

test("workflow keeps the requested sequential stage order", () => {
  const source = workflowSource();
  const stages = [
    "prepare-changelog-branch",
    "validate-commit-push-open-pr",
    "const ci = await inspectGate(\"ci\"",
    "merge-exact-head-and-sync-base",
    "cut-and-push-release-tag",
    "dispatch-protected-publisher",
    "const publish = await inspectGate(\"publish\"",
    "summarize-release",
  ];
  let prior = -1;
  for (const stage of stages) {
    const index = source.indexOf(stage);
    assert.ok(index > prior, `${stage} must follow the previous stage`);
    prior = index;
  }
});

test("pending and failed gates suspend for a structured human decision in the same run", () => {
  const source = workflowSource();
  assert.match(source, /outcome\.status === "pending"/u);
  assert.match(source, /await ctx\.ui\.select/u);
  assert.match(source, /Reinspect after external state changes/u);
  assert.match(source, /Stop this release/u);
  assert.match(source, /continue this SAME workflow run/u);
  assert.match(source, /return inspectGate\(gate, prompt, attempt \+ 1\)/u);
  assert.match(source, /The workflow will not repair, merge, tag, dispatch, or publish silently/u);
});

test("workflow captures and inspects only the run created by its one dispatch", () => {
  const source = workflowSource();
  assert.match(source, /gh workflow run publish\.yml --ref main -f version=\$\{release\.version\}/u);
  assert.match(source, /GitHub CLI 2\.87 or newer returns the created run URL/u);
  assert.match(source, /Do not run any other dispatch command/u);
  assert.match(source, /return blocked and do not redispatch/u);
  assert.match(source, /Exact dispatched run ID/u);
  assert.match(source, /View only that exact run once/u);
  assert.match(source, /Do not list run history/u);
  assert.match(source, /event workflow_dispatch, head branch main/u);
});

test("release workflow contains no executable wait, polling, or watch loop", () => {
  const source = workflowSource();
  assert.doesNotMatch(source, /setTimeout|Bun\.sleep|while\s*\(|for\s*\(\s*;\s*;|gh\s+(?:run|pr)\s+watch/u);
});
