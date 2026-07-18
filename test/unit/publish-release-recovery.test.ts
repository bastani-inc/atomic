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
  const baseRef = "refs/heads/main";
  const releaseMessage = `Release ${release.version}\n\nRelease-base-ref: ${baseRef}\nRelease-base-sha: ${baseOid}\n`;

  test("classifies absent, partial, and fully published exact tags without force", async () => {
    const cases = [
      { expected: "absent", responses: [rawResponse("", 1), rawResponse("")] },
      { expected: "remote-only", responses: [rawResponse("", 1), rawResponse(`${tagOid}\trefs/tags/${release.version}`)] },
      { expected: "local-only", responses: [rawResponse(tagOid), rawResponse(""), rawResponse(baseOid), rawResponse(manifest), rawResponse(releaseMessage), rawResponse(""), rawResponse("")] },
      { expected: "published", responses: [rawResponse(tagOid), rawResponse(`${tagOid}\trefs/tags/${release.version}`), rawResponse(baseOid), rawResponse(manifest), rawResponse(releaseMessage), rawResponse(""), rawResponse("")] },
    ] as const;
    for (const fixture of cases) {
      const result = await inspectReleaseTagRecovery(release, baseOid, mergeOid, baseRef, queuedExecutor(fixture.responses));
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.state, fixture.expected);
    }
  });

  test("rejects existing tags with wrong parent, version, or remote target", async () => {
    for (const responses of [
      [rawResponse(tagOid), rawResponse(""), rawResponse(headOid), rawResponse(manifest), rawResponse(releaseMessage), rawResponse("", 1), rawResponse("")],
      [rawResponse(tagOid), rawResponse(""), rawResponse(baseOid), rawResponse(JSON.stringify({ version: "9.9.9" })), rawResponse(releaseMessage), rawResponse(""), rawResponse("")],
      [rawResponse(tagOid), rawResponse(`${headOid}\trefs/tags/${release.version}`), rawResponse(baseOid), rawResponse(manifest), rawResponse(releaseMessage), rawResponse(""), rawResponse("")],
    ]) {
      const result = await inspectReleaseTagRecovery(release, baseOid, mergeOid, baseRef, queuedExecutor(responses));
      assert.equal(result.ok, false);
      assert.match(result.summary, /conflicts with deterministic release evidence/u);
    }
  });

  test("rejects a prior tag whose integrated parent predates the verified merge", async () => {
    const result = await inspectReleaseTagRecovery(release, baseOid, mergeOid, baseRef, queuedExecutor([
      rawResponse(tagOid), rawResponse(`${tagOid}\trefs/tags/${release.version}`), rawResponse(headOid),
      rawResponse(manifest), rawResponse(releaseMessage.replace(baseOid, headOid)), rawResponse(""), rawResponse("", 1),
    ]));
    assert.equal(result.ok, false);
    assert.match(result.summary, /verified merge commit .* is not an ancestor/u);
  });

  test("rejects tag recovery metadata from another release workstream", async () => {
    const result = await inspectReleaseTagRecovery(release, baseOid, mergeOid, baseRef, queuedExecutor([
      rawResponse(tagOid), rawResponse(`${tagOid}\trefs/tags/${release.version}`), rawResponse(baseOid),
      rawResponse(manifest), rawResponse(releaseMessage.replace(baseRef, "refs/heads/workstream")), rawResponse(""), rawResponse(""),
    ]));
    assert.equal(result.ok, false);
    assert.match(result.summary, /Release trailer base ref refs\/heads\/workstream does not match expected refs\/heads\/main/u);
  });

  test("final tag publication accepts an integrated prior parent during recovery", async () => {
    const result = await verifyReleaseTagPublished(release, baseOid, {
      allowIntegratedParent: true,
      requiredAncestorOid: mergeOid,
      expectedBaseRef: baseRef,
      execute: queuedExecutor([
        rawResponse(tagOid), rawResponse(headOid), rawResponse(""), rawResponse(""), rawResponse(manifest),
        rawResponse(releaseMessage.replace(baseOid, headOid)), rawResponse(`${tagOid}\trefs/tags/${release.version}`),
      ]),
    });
    assert.equal(result.ok, true);
  });

  test("final tag verification binds publication to the requested release workstream", async () => {
    const result = await verifyReleaseTagPublished(release, baseOid, {
      allowIntegratedParent: true,
      requiredAncestorOid: mergeOid,
      expectedBaseRef: baseRef,
      execute: queuedExecutor([
        rawResponse(tagOid), rawResponse(baseOid), rawResponse(""), rawResponse(""), rawResponse(manifest),
        rawResponse(releaseMessage), rawResponse(`${tagOid}\trefs/tags/${release.version}`),
      ]),
    });
    assert.equal(result.ok, true);

    const mismatch = await verifyReleaseTagPublished(release, baseOid, {
      allowIntegratedParent: true,
      requiredAncestorOid: mergeOid,
      expectedBaseRef: "refs/heads/workstream",
      execute: queuedExecutor([
        rawResponse(tagOid), rawResponse(baseOid), rawResponse(""), rawResponse(""), rawResponse(manifest),
        rawResponse(releaseMessage), rawResponse(`${tagOid}\trefs/tags/${release.version}`),
      ]),
    });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.summary, /Release trailer base ref refs\/heads\/main does not match expected refs\/heads\/workstream/u);
  });

  test("newly materialized tags require the exact current base parent", async () => {
    const result = await verifyReleaseTagPublished(release, baseOid, {
      requiredAncestorOid: mergeOid,
      expectedBaseRef: baseRef,
      execute: queuedExecutor([
        rawResponse(tagOid), rawResponse(headOid), rawResponse(""), rawResponse(manifest),
        rawResponse(releaseMessage.replace(baseOid, headOid)), rawResponse(`${tagOid}\trefs/tags/${release.version}`),
      ]),
    });
    assert.equal(result.ok, false);
    assert.match(result.summary, /expected the verified base commit/u);
  });

  test("workflow pushes a tag as the sole publish signal and never dispatches or waits", () => {
    const source = readFileSync(".atomic/workflows/publish-release.ts", "utf8");
    assert.match(source, /inspectReleaseTagRecovery\(release, mainReady\.mainOid, mergeVerification\.mergeCommitOid, releaseBaseRef\)/u);
    assert.match(source, /ctx\.task\("materialize-release-tag"/u);
    assert.match(source, /const postMergeCiVerification = await verifyReleasePrChecksPassed/u);
    assert.doesNotMatch(source, /wait-for-release-ci|coordinate-protected-publish-dispatch|gh workflow run|--watch/u);
    assert.match(source, /allowIntegratedParent: tagRecovery\.state !== "absent"/u);
    assert.match(source, /expectedBaseRef: releaseBaseRef/u);

    assert.equal(existsSync(".github/workflows/publish-dispatch.yml"), false);
    assert.equal(existsSync(".github/workflows/release-tag.yml"), false);
    const publish = readFileSync(".github/workflows/publish.yml", "utf8");
    assert.match(publish, /on:[ \t]*\r?\n(?:[ \t]*#[^\r\n]*\r?\n)*[ \t]*create:/u);
    assert.doesNotMatch(publish, /gh workflow run|sleep [0-9]|--paginate|--watch|workflow_run:/u);
  });
});
