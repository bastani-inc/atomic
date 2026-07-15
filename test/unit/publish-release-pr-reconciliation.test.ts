import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateReleaseRequest,
  verifyPullRequestMergedJson,
  type CommandResult,
  type JsonValue,
  type PullRequestReferenceVerification,
} from "../../.atomic/workflows/lib/publish-release.js";
import { findExistingPublishDispatch, inspectReleaseTagRecovery } from "../../.atomic/workflows/lib/publish-release-recovery.js";
import {
  verifyReleasePrChecksPassed,
  verifyReleaseTagPublished,
} from "../../.atomic/workflows/lib/publish-release-gates.js";

const headOid = "dddddddddddddddddddddddddddddddddddddddd";
const mergeOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const prUrl = "https://github.com/earendil-works/pi-mono/pull/123";
const release = validateReleaseRequest("release", "1.2.3");
const prReference = {
  ok: true as const,
  summary: "captured",
  prUrl,
  prNumber: 123,
  headRefOid: headOid,
  state: "OPEN" as const,
};
const openPr: JsonValue = {
  number: 123,
  state: "OPEN",
  baseRefName: "main",
  headRefName: release.branch,
  headRefOid: headOid,
  statusCheckRollup: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
  url: prUrl,
};
const mergedPr: JsonValue = {
  ...openPr,
  state: "MERGED",
  mergedAt: "2026-07-15T18:00:00Z",
  mergeCommit: { oid: mergeOid },
};
const passingChecks: JsonValue = [{ name: "unit", bucket: "pass", state: "SUCCESS" }];

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
type SuccessfulPrReference = Extract<PullRequestReferenceVerification, { readonly ok: true }>;

async function verify(responses: readonly CommandResult[], reference: SuccessfulPrReference = prReference) {
  return await verifyReleasePrChecksPassed(release, reference, "main", {
    attempts: 1,
    pollIntervalMs: 1,
    runCommand: queuedExecutor(responses),
    sleep: () => Promise.resolve(),
  });
}

describe("publish-release PR reconciliation", () => {
  test("keeps the normal exact OPEN path mergeable after checks pass", async () => {
    const commands: string[] = [];
    const result = await verifyReleasePrChecksPassed(release, prReference, "main", {
      attempts: 1,
      runCommand: queuedExecutor([response(openPr), response(passingChecks), response(openPr)], commands),
      sleep: () => Promise.resolve(),
    });

    assert.deepEqual(result.ok && result.disposition, "merge-required");
    assert.deepEqual(commands.map((command) => command.includes(" pr checks ") ? "checks" : "view"), ["view", "checks", "view"]);
  });

  test("reconciles an exact OPEN to MERGED transition without requesting another merge", async () => {
    const result = await verify([
      response(openPr),
      response(passingChecks),
      response(mergedPr),
      rawResponse(`${headOid}\trefs/heads/${release.branch}`),
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.disposition, "already-merged");
    assert.match(result.summary, /mergeCommit\.oid: a{40}/u);
    assert.match(result.summary, /retained at the captured head SHA/u);

    const source = readFileSync(".atomic/workflows/publish-release.ts", "utf8");
    assert.match(source, /if \(ciVerification\.disposition === "merge-required"\)/u);
    assert.match(source, /Merge task skipped: the exact captured release PR was already externally merged/u);
    assert.match(source, /await ctx\.tool\(\s*"capture-source-head"/u);
    assert.doesNotMatch(source, /ctx\.tool\(\s*"verify-release-pr-merged"/u);
    assert.match(source, /const mergeVerification = verifyReleasePrMerged/u);
    assert.match(source, /gh pr merge \$\{prReference\.prUrl\} --match-head-commit/u);
    assert.doesNotMatch(source, /ctx\.tool\(\s*"verify-release-pr-checks-passed"/u);
    assert.match(source, /const ciVerification = await verifyReleasePrChecksPassed/u);
  });

  test("accepts an exact PR already MERGED at capture and rejects state regression", async () => {
    const capturedMerged = { ...prReference, state: "MERGED" as const };
    const result = await verify([
      response(mergedPr),
      response(passingChecks),
      response(mergedPr),
      rawResponse(`${headOid}\trefs/heads/${release.branch}`),
    ], capturedMerged);

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.disposition, "already-merged");

    const regressed = await verify([response(openPr)], capturedMerged);
    assert.equal(regressed.ok, false);
    assert.match(regressed.summary, /regressed from captured MERGED/u);
  });

  test("rejects CLOSED and every captured identity, ref, or SHA mismatch", async () => {
    const cases: readonly [string, JsonValue, RegExp][] = [
      ["state", { ...openPr, state: "CLOSED" }, /state was CLOSED/u],
      ["url", { ...openPr, url: `${prUrl}-other` }, /expected captured URL/u],
      ["number", { ...openPr, number: 124 }, /expected captured number 123/u],
      ["base", { ...openPr, baseRefName: "develop" }, /expected main/u],
      ["head", { ...openPr, headRefName: "release/other" }, /expected release\/1\.2\.3/u],
      ["sha", { ...openPr, headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, /headRefOid was .* expected/u],
    ];

    for (const [name, candidate, expected] of cases) {
      const result = await verify([response(candidate)]);
      assert.equal(result.ok, false, name);
      assert.match(result.summary, expected, name);
    }
  });

  test("rejects stale identity or SHA changes after passing check collection", async () => {
    for (const candidate of [
      { ...openPr, number: 124 },
      { ...openPr, headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
    ]) {
      const result = await verify([response(openPr), response(passingChecks), response(candidate)]);
      assert.equal(result.ok, false);
      assert.match(result.summary, /expected captured number|headRefOid was/u);
    }
  });

  test("rejects required-check results that are absent or non-passing on the captured head rollup", async () => {
    for (const statusCheckRollup of [
      [],
      [{ name: "unit", status: "COMPLETED", conclusion: "FAILURE" }],
      [{ name: "different", status: "COMPLETED", conclusion: "SUCCESS" }],
      [
        { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "unit", status: "IN_PROGRESS", conclusion: null },
      ],
    ]) {
      const result = await verify([
        response(openPr),
        response(passingChecks),
        response({ ...openPr, statusCheckRollup }),
      ]);
      assert.equal(result.ok, false);
      assert.match(result.summary, /not verified for the captured head SHA/u);
    }
  });

  test("permits a failing optional check that shares a required job name in another workflow", async () => {
    const requiredChecks: JsonValue = [{
      name: "test",
      workflow: "Required CI",
      link: "https://example.test/required",
      bucket: "pass",
      state: "SUCCESS",
    }];
    const statusCheckRollup: JsonValue = [
      {
        name: "test",
        workflowName: "Required CI",
        detailsUrl: "https://example.test/required",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
      {
        name: "test",
        workflowName: "Optional CI",
        detailsUrl: "https://example.test/optional",
        status: "COMPLETED",
        conclusion: "FAILURE",
      },
    ];
    const result = await verify([
      response(openPr),
      response(requiredChecks),
      response({ ...openPr, statusCheckRollup }),
    ]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.disposition, "merge-required");
  });

  test("rejects a pending rerun from the same workflow-qualified required context", async () => {
    const requiredChecks: JsonValue = [{
      name: "test",
      workflow: "Required CI",
      link: "https://example.test/required-old",
      bucket: "pass",
      state: "SUCCESS",
    }];
    const statusCheckRollup: JsonValue = [
      {
        name: "test",
        workflowName: "Required CI",
        detailsUrl: "https://example.test/required-old",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
      {
        name: "test",
        workflowName: "Required CI",
        detailsUrl: "https://example.test/required-rerun",
        status: "IN_PROGRESS",
        conclusion: null,
      },
    ];
    const result = await verify([
      response(openPr),
      response(requiredChecks),
      response({ ...openPr, statusCheckRollup }),
    ]);
    assert.equal(result.ok, false);
    assert.match(result.summary, /pending or failing rerun/u);
  });

  test("keeps pending and failing required checks non-mergeable", async () => {
    const pending = await verify([response(openPr), response(passingChecks, 8)]);
    assert.equal(pending.ok, false);
    assert.equal(pending.pending, true);

    const failingChecks: JsonValue = [{ name: "unit", bucket: "fail", state: "FAILURE", link: "https://example.test/failure" }];
    const failing = await verify([response(openPr), response(failingChecks, 1)]);
    assert.equal(failing.ok, false);
    assert.equal(failing.pending, undefined);
    assert.match(failing.summary, /unit bucket=fail state=FAILURE link=https:\/\/example\.test\/failure/u);
  });

  test("rejects missing or invalid merge evidence", async () => {
    const invalidMerged: readonly JsonValue[] = [
      { ...mergedPr, mergedAt: null },
      { ...mergedPr, mergedAt: "0" },
      { ...mergedPr, mergeCommit: null },
      { ...mergedPr, mergedAt: "2026-02-30T00:00:00Z" },
      { ...mergedPr, mergeCommit: { oid: "abc123" } },
    ];
    for (const candidate of invalidMerged) {
      const result = await verify([response(openPr), response(passingChecks), response(candidate)]);
      assert.equal(result.ok, false);
      assert.match(result.summary, /mergedAt was missing or invalid|mergeCommit\.oid was missing or invalid/u);
    }
  });

  test("requires the retained remote branch to remain at the captured SHA", async () => {
    for (const branchResult of [
      rawResponse(""),
      rawResponse("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\trefs/heads/release/1.2.3"),
    ]) {
      const result = await verify([response(openPr), response(passingChecks), response(mergedPr), branchResult]);
      assert.equal(result.ok, false);
      assert.match(result.summary, /retention is not verified at the captured head SHA/u);
    }
  });

  test("final merge evidence rejects URL and number mismatches independently", () => {
    for (const candidate of [{ ...mergedPr, url: `${prUrl}-other` }, { ...mergedPr, number: 124 }]) {
      const result = verifyPullRequestMergedJson(candidate, release.branch, "main", headOid, { prUrl, prNumber: 123 });
      assert.equal(result.ok, false);
      assert.match(result.summary, /expected captured URL|expected captured number/u);
    }
  });
});

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
      rawResponse(tagOid),
      rawResponse(`${tagOid}\trefs/tags/${release.version}`),
      rawResponse(headOid),
      rawResponse(manifest),
      rawResponse(""),
      rawResponse(""),
    ]));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.state, "published");
  });

  test("rejects a prior tag whose integrated parent predates the verified merge", () => {
    const result = inspectReleaseTagRecovery(release, baseOid, mergeOid, queuedExecutor([
      rawResponse(tagOid),
      rawResponse(`${tagOid}\trefs/tags/${release.version}`),
      rawResponse(headOid),
      rawResponse(manifest),
      rawResponse(""),
      rawResponse("", 1),
    ]));
    assert.equal(result.ok, false);
    assert.match(result.summary, /verified merge commit .* is not an ancestor/u);
  });

  test("final tag publication gate accepts an integrated prior parent during recovery", () => {
    const result = verifyReleaseTagPublished(release, baseOid, {
      allowIntegratedParent: true,
      requiredAncestorOid: mergeOid,
      execute: queuedExecutor([
        rawResponse(tagOid),
        rawResponse(headOid),
        rawResponse(""),
        rawResponse(""),
        rawResponse(manifest),
        rawResponse(`${tagOid}\trefs/tags/${release.version}`),
      ]),
    });
    assert.equal(result.ok, true);
  });

  test("newly materialized tags still require the exact current base parent", () => {
    const result = verifyReleaseTagPublished(release, baseOid, {
      requiredAncestorOid: mergeOid,
      execute: queuedExecutor([
        rawResponse(tagOid),
        rawResponse(headOid),
        rawResponse(""),
        rawResponse(manifest),
        rawResponse(`${tagOid}\trefs/tags/${release.version}`),
      ]),
    });
    assert.equal(result.ok, false);
    assert.match(result.summary, /expected the verified base commit/u);
  });

  test("reuses only an existing protected-main Publish dispatch for the exact release", async () => {
    const run = {
      id: 987,
      name: "Publish",
      head_branch: "main",
      path: ".github/workflows/publish.yml",
      event: "workflow_dispatch",
      display_title: `Publish ${release.version}`,
      status: "in_progress",
      conclusion: null,
      head_sha: baseOid,
      html_url: "https://github.com/bastani-inc/atomic/actions/runs/987",
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
      id: index + 1,
      name: "Publish",
      head_branch: "main",
      event: "workflow_dispatch",
      path: ".github/workflows/publish.yml",
      display_title: `Publish 9.9.${index}`,
      status: "completed",
      conclusion: "success",
      head_sha: baseOid,
      html_url: `https://github.com/bastani-inc/atomic/actions/runs/${index + 1}`,
    }));
    const exact = {
      ...newerRuns[0],
      id: 987,
      display_title: `Publish ${release.version}`,
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
        response([{ workflow_runs: [] }]),
        response([{ workflow_runs: [] }]),
        response([{ workflow_runs: [] }]),
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
    assert.doesNotMatch(source, /cut-release-tag/u);
    assert.doesNotMatch(source, /--limit\s+50/u);
    assert.match(source, /const postMergeCiVerification = await verifyReleasePrChecksPassed/u);
    assert.doesNotMatch(source, /event=workflow_dispatch/u);
    assert.match(source, /gh workflow run publish-dispatch\.yml --ref main/u);

    const coordinator = readFileSync(".github/workflows/publish-dispatch.yml", "utf8");
    assert.match(coordinator, /group: protected-publish-dispatch-\$\{\{ inputs\.tag \}\}/u);
    assert.match(coordinator, /gh api --method GET --paginate --slurp/u);
    assert.doesNotMatch(coordinator, /event=workflow_dispatch/u);
    assert.match(coordinator, /gh workflow run publish\.yml --ref main/u);
    const dispatchIndex = coordinator.indexOf("gh workflow run publish.yml --ref main");
    const observableIndex = coordinator.indexOf('until [[ "$(count_existing)" -gt 0 ]]', dispatchIndex);
    const releaseIndex = coordinator.indexOf("releasing the per-tag lock", observableIndex);
    assert.match(coordinator, /lookup failed; retaining the per-tag lock and retrying\." >&2/u);
    assert.ok(dispatchIndex >= 0);
    assert.ok(observableIndex > dispatchIndex);
    assert.ok(releaseIndex > observableIndex);

    for (const path of ["AGENTS.md", "docs/ci.md", "scripts/cut-release.ts"]) {
      assert.doesNotMatch(readFileSync(path, "utf8"), /gh workflow run publish\.yml/u, path);
    }
  });
});
