import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateReleaseRequest,
  type CommandResult,
  type JsonValue,
} from "../../.atomic/workflows/lib/publish-release.js";
import { findExistingPublishDispatch, inspectReleaseTagRecovery } from "../../.atomic/workflows/lib/publish-release-recovery.js";
import { verifyReleaseTagPublished } from "../../.atomic/workflows/lib/publish-release-gates.js";

const headOid = "dddddddddddddddddddddddddddddddddddddddd";
const mergeOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const release = validateReleaseRequest("release", "1.2.3");

function response(value: JsonValue, exitCode = 0): CommandResult {
  return { command: "fixture", exitCode, stdout: JSON.stringify(value), stderr: "" };
}

function rawResponse(stdout: string, exitCode = 0): CommandResult {
  return { command: "fixture", exitCode, stdout, stderr: "" };
}

function queuedExecutor(responses: readonly CommandResult[], commands: string[] = []) {
  const queue = [...responses];
  return (args: readonly string[]): CommandResult => {
    commands.push(args.join(" "));
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected command: ${args.join(" ")}`);
    return { ...next, command: args.join(" ") };
  };
}

describe("publish-release tag and dispatch recovery", () => {
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

  test("reuses an exact prior tag after unrelated base advancement", () => {
    const result = inspectReleaseTagRecovery(release, baseOid, mergeOid, queuedExecutor([
      rawResponse(tagOid), rawResponse(`${tagOid}\trefs/tags/${release.version}`), rawResponse(headOid),
      rawResponse(manifest), rawResponse(""), rawResponse(""),
    ]));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.state, "published");
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

  test("reuses only an existing protected-main Publish dispatch for the exact release", async () => {
    const run = {
      id: 987, name: "Publish", head_branch: "main", path: ".github/workflows/publish.yml",
      event: "workflow_dispatch", display_title: `Publish ${release.version}`, status: "in_progress",
      conclusion: null, head_sha: baseOid, html_url: "https://github.com/bastani-inc/atomic/actions/runs/987",
    };
    const found = await findExistingPublishDispatch(release, { execute: queuedExecutor([response([{ workflow_runs: [run] }])]) });
    assert.equal(found.ok, true);
    if (found.ok) {
      assert.equal(found.found, true);
      if (found.found) assert.equal(found.runId, 987);
    }
    for (const mismatch of [
      { ...run, head_branch: release.version },
      { ...run, path: ".github/workflows/other.yml" },
      { ...run, display_title: "Publish 9.9.9" },
    ]) {
      const result = await findExistingPublishDispatch(release, { execute: queuedExecutor([response([{ workflow_runs: [mismatch] }])]) });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.found, false);
    }
  });

  test("finds an exact dispatch beyond 1,000 newer history entries", async () => {
    const newerRuns = Array.from({ length: 1_100 }, (_, index) => ({
      id: index + 1, name: "Publish", head_branch: "main", event: "workflow_dispatch",
      path: ".github/workflows/publish.yml", display_title: `Publish 9.9.${index}`,
      status: "completed", conclusion: "success", head_sha: baseOid,
      html_url: `https://github.com/bastani-inc/atomic/actions/runs/${index + 1}`,
    }));
    const exact = {
      ...newerRuns[0], id: 987, display_title: `Publish ${release.version}`,
      html_url: "https://github.com/bastani-inc/atomic/actions/runs/987",
    };
    const result = await findExistingPublishDispatch(release, {
      execute: queuedExecutor([response([{ workflow_runs: newerRuns }, { workflow_runs: [exact] }])]),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.found, true);
      if (result.found) assert.equal(result.runId, 987);
    }
  });

  test("polls an ambiguity window before deciding a prior dispatch is absent", async () => {
    const sleeps: number[] = [];
    const result = await findExistingPublishDispatch(release, {
      attempts: 3,
      pollIntervalMs: 25,
      execute: queuedExecutor([
        response([{ workflow_runs: [] }]), response([{ workflow_runs: [] }]), response([{ workflow_runs: [] }]),
      ]),
      sleep: (durationMs) => {
        sleeps.push(durationMs);
        return Promise.resolve();
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.found, false);
    assert.deepEqual(sleeps, [25, 25]);
    assert.match(result.summary, /reconciliation window/u);
  });

  test("workflow separates tag materialization from protected dispatch and reconciles before both", () => {
    const source = readFileSync(".atomic/workflows/publish-release.ts", "utf8");
    assert.match(source, /inspectReleaseTagRecovery\(release, mainReady\.mainOid, mergeVerification\.mergeCommitOid\)/u);
    assert.match(source, /ctx\.task\("materialize-release-tag"/u);
    assert.match(source, /findExistingPublishDispatch\(release,/u);
    assert.match(source, /ctx\.task\("coordinate-protected-publish-dispatch"/u);
    assert.match(source, /existingDispatch\.found \? existingDispatch\.runId : undefined/u);
    assert.match(source, /allowIntegratedParent: tagRecovery\.state !== "absent"/u);
    assert.doesNotMatch(source, /cut-release-tag|--limit\s+50|event=workflow_dispatch/u);
    assert.match(source, /const postMergeCiVerification = await verifyReleasePrChecksPassed/u);
    assert.match(source, /gh workflow run publish-dispatch\.yml --ref main/u);

    const coordinator = readFileSync(".github/workflows/publish-dispatch.yml", "utf8");
    assert.match(coordinator, /group: protected-publish-dispatch-\$\{\{ inputs\.tag \}\}/u);
    assert.match(coordinator, /gh api --method GET --paginate --slurp/u);
    assert.doesNotMatch(coordinator, /event=workflow_dispatch/u);
    assert.equal(coordinator.match(/gh workflow run publish\.yml/g)?.length, 1);
    const dispatchIndex = coordinator.indexOf("gh workflow run publish.yml --ref main");
    const ambiguousIndex = coordinator.indexOf("acceptance is ambiguous", dispatchIndex);
    const observableIndex = coordinator.indexOf('until [[ "$(count_existing)" -gt 0 ]]', dispatchIndex);
    const releaseIndex = coordinator.indexOf("releasing the per-tag lock", observableIndex);
    assert.match(coordinator, /lookup failed; retaining the per-tag lock and retrying\." >&2/u);
    assert.match(coordinator, /gh workflow run publish\.yml --ref main .* \|\| dispatch_status=\$\?/u);
    assert.ok(dispatchIndex >= 0 && ambiguousIndex > dispatchIndex);
    assert.ok(observableIndex > ambiguousIndex && releaseIndex > observableIndex);

    for (const path of ["AGENTS.md", "docs/ci.md", "scripts/cut-release.ts"]) {
      assert.doesNotMatch(readFileSync(path, "utf8"), /gh workflow run publish\.yml/u, path);
    }
  });
});
