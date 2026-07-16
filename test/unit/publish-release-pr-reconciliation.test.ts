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
import { verifyReleasePrChecksPassed } from "../../.atomic/workflows/lib/publish-release-gates.js";

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
    runCommand: queuedExecutor(responses),
  });
}

describe("publish-release PR reconciliation", () => {
  test("keeps the normal exact OPEN path mergeable after checks pass", async () => {
    const commands: string[] = [];
    const result = await verifyReleasePrChecksPassed(release, prReference, "main", {
      runCommand: queuedExecutor([response(openPr), response(passingChecks), response(openPr)], commands),
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

  test("permits a failing optional Actions check sharing an external required status name", async () => {
    const requiredChecks: JsonValue = [{
      name: "external-status",
      workflow: "",
      link: "https://example.test/external-required",
      bucket: "pass",
      state: "SUCCESS",
    }];
    const statusCheckRollup: JsonValue = [
      {
        context: "external-status",
        targetUrl: "https://example.test/external-required",
        state: "SUCCESS",
      },
      {
        name: "external-status",
        workflowName: "Optional Actions",
        detailsUrl: "https://example.test/optional-actions",
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

    const changedTargetPending = await verify([
      response(openPr),
      response(requiredChecks),
      response({
        ...openPr,
        statusCheckRollup: [
          { context: "external-status", targetUrl: "https://example.test/external-required", state: "SUCCESS" },
          { context: "external-status", targetUrl: "https://example.test/external-rerun", state: "PENDING" },
        ],
      }),
    ]);
    assert.equal(changedTargetPending.ok, false);
    assert.match(changedTargetPending.summary, /pending or failing rerun/u);

    const wrongTarget = await verify([
      response(openPr),
      response(requiredChecks),
      response({
        ...openPr,
        statusCheckRollup: [{ context: "external-status", targetUrl: "https://example.test/other", state: "SUCCESS" }],
      }),
    ]);
    assert.equal(wrongTarget.ok, false);
  });

  test("infers one rollup kind for required checks with empty workflow and no target link", async () => {
    const requiredChecks: JsonValue = [{
      name: "external-status",
      workflow: "",
      link: "",
      bucket: "pass",
      state: "SUCCESS",
    }];
    const checkRunOnly = await verify([
      response(openPr),
      response(requiredChecks),
      response({
        ...openPr,
        statusCheckRollup: [{
          __typename: "CheckRun",
          name: "external-status",
          workflowName: "",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        }],
      }),
    ]);
    assert.equal(checkRunOnly.ok, true);

    const externalSuccess = await verify([
      response(openPr),
      response(requiredChecks),
      response({
        ...openPr,
        statusCheckRollup: [
          { context: "external-status", state: "SUCCESS" },
          { name: "external-status", workflowName: "Optional Actions", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      }),
    ]);
    assert.equal(externalSuccess.ok, true);

    const optionalActionsPassing = await verify([
      response(openPr),
      response(requiredChecks),
      response({
        ...openPr,
        statusCheckRollup: [
          { context: "external-status", state: "SUCCESS" },
          { name: "external-status", workflowName: "Optional Actions", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
    ]);
    assert.equal(optionalActionsPassing.ok, true);

    const crossKindRollups: readonly JsonValue[] = [
      [
        { context: "external-status", state: "SUCCESS" },
        { __typename: "CheckRun", name: "external-status", workflowName: "", status: "IN_PROGRESS", conclusion: null },
      ],
      [
        { __typename: "CheckRun", name: "external-status", workflowName: "", status: "COMPLETED", conclusion: "SUCCESS" },
        { context: "external-status", state: "PENDING" },
      ],
    ];
    for (const statusCheckRollup of crossKindRollups) {
      const crossKindPending = await verify([
        response(openPr),
        response(requiredChecks),
        response({ ...openPr, statusCheckRollup }),
      ]);
      assert.equal(crossKindPending.ok, false);
      assert.match(crossKindPending.summary, /pending or failing rerun/u);
    }

    const ambiguousPassingKinds = await verify([
      response(openPr),
      response(requiredChecks),
      response({
        ...openPr,
        statusCheckRollup: [
          { context: "external-status", state: "SUCCESS" },
          { __typename: "CheckRun", name: "external-status", workflowName: "", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
    ]);
    assert.equal(ambiguousPassingKinds.ok, true);

    const externalPending = await verify([
      response(openPr),
      response(requiredChecks),
      response({ ...openPr, statusCheckRollup: [{ context: "external-status", state: "PENDING" }] }),
    ]);
    assert.equal(externalPending.ok, false);
    assert.match(externalPending.summary, /pending or failing rerun/u);
  });


  test("accepts a required GitHub App CheckRun whose gh checks workflow is empty", async () => {
    const requiredChecks: JsonValue = [{
      name: "Greptile Review",
      workflow: "",
      link: "https://greptile.com/",
      bucket: "pass",
      state: "SUCCESS",
    }];
    const passingCheckRun = {
      __typename: "CheckRun",
      name: "Greptile Review",
      workflowName: "",
      detailsUrl: "https://greptile.com/",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    };
    const accepted = await verify([
      response(openPr),
      response(requiredChecks),
      response({
        ...openPr,
        statusCheckRollup: [
          passingCheckRun,
          { __typename: "StatusContext", context: "Greptile Review", state: "FAILURE" },
          {
            __typename: "CheckRun",
            name: "Greptile Review",
            workflowName: "Optional Actions",
            detailsUrl: "https://example.test/optional-actions",
            status: "COMPLETED",
            conclusion: "FAILURE",
          },
        ],
      }),
    ]);
    assert.equal(accepted.ok, true);

    const pendingRerun = await verify([
      response(openPr),
      response(requiredChecks),
      response({
        ...openPr,
        statusCheckRollup: [
          passingCheckRun,
          {
            __typename: "CheckRun",
            name: "Greptile Review",
            workflowName: "",
            detailsUrl: "https://greptile.com/rerun",
            status: "IN_PROGRESS",
            conclusion: null,
          },
        ],
      }),
    ]);
    assert.equal(pendingRerun.ok, false);
    assert.match(pendingRerun.summary, /pending or failing rerun/u);
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
