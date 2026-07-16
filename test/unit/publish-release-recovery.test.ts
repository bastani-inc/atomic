import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { validateReleaseRequest, type CommandResult } from "../../.atomic/workflows/lib/publish-release.js";
import { inspectReleaseTagRecovery } from "../../.atomic/workflows/lib/publish-release-recovery.js";
import { verifyReleaseTagPublished } from "../../.atomic/workflows/lib/publish-release-gates.js";

const headOid = "dddddddddddddddddddddddddddddddddddddddd";
const mergeOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const release = validateReleaseRequest("release", "1.2.3");

function rawResponse(stdout: string, exitCode = 0): CommandResult {
  return { command: "fixture", exitCode, stdout, stderr: "" };
}

function queuedExecutor(responses: readonly CommandResult[]) {
  const queue = [...responses];
  return (args: readonly string[]): CommandResult => {
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected command: ${args.join(" ")}`);
    return { ...next, command: args.join(" ") };
  };
}

describe("publish-release tag recovery", () => {
  const baseOid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const tagOid = "cccccccccccccccccccccccccccccccccccccccc";
  const manifest = JSON.stringify({ version: release.version });

  test("classifies absent, partial, and fully published exact tags without force", () => {
    const cases = [
      { expected: "absent", responses: [rawResponse("", 1), rawResponse("")] },
      { expected: "remote-only", responses: [rawResponse("", 1), rawResponse(`${tagOid}\trefs/tags/${release.version}`)] },
      { expected: "local-only", responses: [rawResponse(tagOid), rawResponse(""), rawResponse(baseOid), rawResponse(manifest), rawResponse(""), rawResponse("")] },
      { expected: "published", responses: [rawResponse(tagOid), rawResponse(`${tagOid}\trefs/tags/${release.version}`), rawResponse(baseOid), rawResponse(manifest), rawResponse(""), rawResponse("")] },
    ] as const;
    for (const fixture of cases) {
      const result = inspectReleaseTagRecovery(release, baseOid, mergeOid, queuedExecutor(fixture.responses));
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.state, fixture.expected);
    }
  });

  test("rejects existing tags with wrong parent, version, or remote target", () => {
    for (const responses of [
      [rawResponse(tagOid), rawResponse(""), rawResponse(headOid), rawResponse(manifest), rawResponse("", 1), rawResponse("")],
      [rawResponse(tagOid), rawResponse(""), rawResponse(baseOid), rawResponse(JSON.stringify({ version: "9.9.9" })), rawResponse(""), rawResponse("")],
      [rawResponse(tagOid), rawResponse(`${headOid}\trefs/tags/${release.version}`), rawResponse(baseOid), rawResponse(manifest), rawResponse(""), rawResponse("")],
    ]) {
      const result = inspectReleaseTagRecovery(release, baseOid, mergeOid, queuedExecutor(responses));
      assert.equal(result.ok, false);
      assert.match(result.summary, /conflicts with deterministic release evidence/u);
    }
  });

  test("rejects a prior tag whose integrated parent predates the verified merge", () => {
    const result = inspectReleaseTagRecovery(release, baseOid, mergeOid, queuedExecutor([
      rawResponse(tagOid), rawResponse(`${tagOid}\trefs/tags/${release.version}`), rawResponse(headOid),
      rawResponse(manifest), rawResponse(""), rawResponse("", 1),
    ]));
    assert.equal(result.ok, false);
    assert.match(result.summary, /verified merge commit .* is not an ancestor/u);
  });

  test("final tag publication accepts an integrated prior parent during recovery", () => {
    const result = verifyReleaseTagPublished(release, baseOid, {
      allowIntegratedParent: true,
      requiredAncestorOid: mergeOid,
      execute: queuedExecutor([
        rawResponse(tagOid), rawResponse(headOid), rawResponse(""), rawResponse(""), rawResponse(manifest),
        rawResponse(`${tagOid}\trefs/tags/${release.version}`),
      ]),
    });
    assert.equal(result.ok, true);
  });

  test("newly materialized tags require the exact current base parent", () => {
    const result = verifyReleaseTagPublished(release, baseOid, {
      requiredAncestorOid: mergeOid,
      execute: queuedExecutor([
        rawResponse(tagOid), rawResponse(headOid), rawResponse(""), rawResponse(manifest),
        rawResponse(`${tagOid}\trefs/tags/${release.version}`),
      ]),
    });
    assert.equal(result.ok, false);
    assert.match(result.summary, /expected the verified base commit/u);
  });

  test("workflow pushes a tag as the sole publish signal and never dispatches or waits", () => {
    const source = readFileSync(".atomic/workflows/publish-release.ts", "utf8");
    assert.match(source, /inspectReleaseTagRecovery\(release, mainReady\.mainOid, mergeVerification\.mergeCommitOid\)/u);
    assert.match(source, /ctx\.task\("materialize-release-tag"/u);
    assert.match(source, /const postMergeCiVerification = await verifyReleasePrChecksPassed/u);
    assert.doesNotMatch(source, /wait-for-release-ci|coordinate-protected-publish-dispatch|gh workflow run|--watch/u);
    assert.match(source, /allowIntegratedParent: tagRecovery\.state !== "absent"/u);

    assert.equal(existsSync(".github/workflows/publish-dispatch.yml"), false);
    assert.equal(existsSync(".github/workflows/release-tag.yml"), false);
    const publish = readFileSync(".github/workflows/publish.yml", "utf8");
    assert.match(publish, /on:\s*\n(?:\s*#.*\n)*\s*create:/u);
    assert.doesNotMatch(publish, /gh workflow run|sleep [0-9]|--paginate|--watch|workflow_run:/u);
  });
});
