import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  prereleaseVersionPattern,
  releaseVersionPattern,
  selectPublishWorkflowRunJson,
  validateReleaseRequest,
  verifyPublishWorkflowRunJson,
  verifyPullRequestChecksJson,
  verifyPullRequestMergedJson,
  verifyReleasePullRequestReferenceJson,
  type CommandResult,
  type JsonValue,
} from "../../.atomic/workflows/lib/publish-release.js";
import { waitForWorkflowRunSucceeded } from "../../.atomic/workflows/lib/publish-release-run-wait.js";

describe("publish-release version validation", () => {
  test("accepts stable release versions only for release requests", () => {
    assert.equal(releaseVersionPattern.test("1.2.3"), true);
    assert.equal(releaseVersionPattern.test("1.2.3-alpha.1"), false);

    assert.deepEqual(validateReleaseRequest("release", "1.2.3"), {
      kind: "release",
      version: "1.2.3",
      branch: "release/1.2.3",
    });
    assert.throws(
      () => validateReleaseRequest("release", "1.2.3-alpha.1"),
      /expected MAJOR\.MINOR\.PATCH/u,
    );
  });

  test("accepts alpha prerelease revisions starting at one only for prerelease requests", () => {
    assert.equal(prereleaseVersionPattern.test("1.2.3-alpha.1"), true);
    assert.equal(prereleaseVersionPattern.test("1.2.3-alpha.0"), false);
    assert.equal(prereleaseVersionPattern.test("1.2.3-beta.1"), false);
    assert.equal(prereleaseVersionPattern.test("1.2.3"), false);

    assert.deepEqual(validateReleaseRequest("prerelease", "1.2.3-alpha.1"), {
      kind: "prerelease",
      version: "1.2.3-alpha.1",
      branch: "prerelease/1.2.3-alpha.1",
    });
    assert.throws(
      () => validateReleaseRequest("prerelease", "1.2.3"),
      /expected MAJOR\.MINOR\.PATCH-alpha\.REVISION/u,
    );
  });

  test("rejects versions with a leading v before applying kind-specific validation", () => {
    assert.throws(
      () => validateReleaseRequest("release", "v1.2.3"),
      /must not include a leading "v"/u,
    );
    assert.throws(
      () => validateReleaseRequest("prerelease", "v1.2.3-alpha.1"),
      /must not include a leading "v"/u,
    );
  });
});

describe("publish-release GitHub PR reference verification", () => {
  const releasePr: JsonValue = {
    number: 123,
    state: "OPEN",
    baseRefName: "main",
    headRefName: "release/1.2.3",
    headRefOid: "def456",
    url: "https://github.com/earendil-works/pi-mono/pull/123",
  };

  test("accepts GitHub PR JSON only when the URL, number, and refs match the release branch", () => {
    assert.deepEqual(verifyReleasePullRequestReferenceJson(releasePr, "release/1.2.3"), {
      ok: true,
      summary: [
        "GitHub PR reference is verified.",
        "number: 123",
        "url: https://github.com/earendil-works/pi-mono/pull/123",
        "baseRefName: main",
        "headRefName: release/1.2.3",
        "headRefOid: def456",
        "state: OPEN",
      ].join("\n"),
      prUrl: "https://github.com/earendil-works/pi-mono/pull/123",
      prNumber: 123,
      headRefOid: "def456",
      state: "OPEN",
    });
  });

  test("rejects GitHub PR JSON for an unrelated branch before merge verification", () => {
    const result = verifyReleasePullRequestReferenceJson(
      { ...releasePr, headRefName: "release/other" },
      "release/1.2.3",
    );

    assert.equal(result.ok, false);
    assert.match(result.summary, /headRefName was release\/other, expected release\/1\.2\.3/u);
  });
});

describe("publish-release GitHub merge verification", () => {
  const mergedPr: JsonValue = {
    state: "MERGED",
    mergedAt: "2026-06-12T08:00:00Z",
    mergeCommit: { oid: "abc123" },
    baseRefName: "main",
    headRefName: "release/1.2.3",
    headRefOid: "def456",
    url: "https://github.com/earendil-works/pi-mono/pull/123",
  };

  test("accepts GitHub PR JSON only when merged with matching refs and merge commit", () => {
    assert.deepEqual(verifyPullRequestMergedJson(mergedPr, "release/1.2.3"), {
      ok: true,
      summary: [
        "GitHub PR is verified as merged.",
        "state: MERGED",
        "mergedAt: 2026-06-12T08:00:00Z",
        "mergeCommit.oid: abc123",
        "baseRefName: main",
        "headRefName: release/1.2.3",
        "headRefOid: def456",
        "url: https://github.com/earendil-works/pi-mono/pull/123",
      ].join("\n"),
      mergeCommitOid: "abc123",
      prUrl: "https://github.com/earendil-works/pi-mono/pull/123",
    });
  });

  test("rejects unmerged or mismatched GitHub PR JSON", () => {
    const result = verifyPullRequestMergedJson({ ...mergedPr, state: "OPEN", headRefName: "release/other" }, "release/1.2.3");

    assert.equal(result.ok, false);
    assert.match(result.summary, /state was OPEN, expected MERGED/u);
    assert.match(result.summary, /headRefName was release\/other, expected release\/1\.2\.3/u);
  });
});

describe("publish-release GitHub PR checks verification", () => {
  test("accepts only non-empty required check lists where every check is passing", () => {
    assert.deepEqual(verifyPullRequestChecksJson([
      { name: "typecheck", bucket: "pass", state: "SUCCESS" },
      { name: "unit", state: "SUCCESS" },
    ]), {
      ok: true,
      summary: [
        "GitHub PR required checks are verified as passing.",
        "checkCount: 2",
      ].join("\n"),
      checkCount: 2,
    });
  });

  test("rejects empty, failing, pending, or malformed required check lists", () => {
    assert.equal(verifyPullRequestChecksJson([]).ok, false);

    const result = verifyPullRequestChecksJson([
      { name: "typecheck", bucket: "fail", state: "FAILURE", link: "https://example.test/check" },
      { name: "unit", bucket: "pending", state: "PENDING" },
    ]);

    assert.equal(result.ok, false);
    assert.match(result.summary, /typecheck bucket=fail state=FAILURE link=https:\/\/example\.test\/check/u);
    assert.match(result.summary, /unit bucket=pending state=PENDING/u);
  });

  test("does not treat completed check status as passing without a pass bucket", () => {
    const result = verifyPullRequestChecksJson([
      { name: "typecheck", state: "COMPLETED" },
    ]);

    assert.equal(result.ok, false);
    assert.match(result.summary, /typecheck bucket=missing state=COMPLETED/u);
  });
});

describe("publish-release GitHub Actions publish verification", () => {
  const successfulRun: JsonValue = {
    databaseId: 987654321,
    workflowName: "Publish",
    headBranch: "1.2.3",
    event: "push",
    status: "completed",
    conclusion: "success",
    headSha: "abc123",
    url: "https://github.com/earendil-works/pi-mono/actions/runs/987654321",
  };

  test("selects the newest push run for the release tag from gh run list JSON", () => {
    const result = selectPublishWorkflowRunJson([
      { ...successfulRun, databaseId: 111, headBranch: "1.2.4" },
      { ...successfulRun, status: "in_progress", conclusion: null },
    ], "1.2.3");

    assert.deepEqual(result, {
      ok: true,
      summary: [
        "GitHub Actions publish run is selected.",
        "databaseId: 987654321",
        "headBranch: 1.2.3",
        "event: push",
        "status: in_progress",
        "headSha: abc123",
        "url: https://github.com/earendil-works/pi-mono/actions/runs/987654321",
      ].join("\n"),
      runId: 987654321,
      runUrl: "https://github.com/earendil-works/pi-mono/actions/runs/987654321",
      status: "in_progress",
      conclusion: undefined,
      headSha: "abc123",
    });
  });

  test("rejects run lists without a matching tag-triggered publish run", () => {
    const result = selectPublishWorkflowRunJson([
      { ...successfulRun, headBranch: "1.2.4" },
      { ...successfulRun, event: "workflow_dispatch" },
    ], "1.2.3");

    assert.equal(result.ok, false);
    assert.match(result.summary, /expected headBranch: 1\.2\.3/u);
    assert.match(result.summary, /headBranch=1\.2\.4 event=push/u);
    assert.match(result.summary, /headBranch=1\.2\.3 event=workflow_dispatch/u);
  });

  test("accepts only completed successful publish runs for the release tag", () => {
    assert.deepEqual(verifyPublishWorkflowRunJson(successfulRun, "1.2.3"), {
      ok: true,
      summary: [
        "GitHub Actions publish run is verified as successful.",
        "databaseId: 987654321",
        "workflowName: Publish",
        "headBranch: 1.2.3",
        "event: push",
        "status: completed",
        "conclusion: success",
        "headSha: abc123",
        "url: https://github.com/earendil-works/pi-mono/actions/runs/987654321",
      ].join("\n"),
      runId: 987654321,
      runUrl: "https://github.com/earendil-works/pi-mono/actions/runs/987654321",
      status: "completed",
      conclusion: "success",
      headSha: "abc123",
    });
  });

  test("rejects unsuccessful or mismatched publish run JSON", () => {
    const result = verifyPublishWorkflowRunJson(
      { ...successfulRun, headBranch: "1.2.4", status: "completed", conclusion: "failure" },
      "1.2.3",
    );

    assert.equal(result.ok, false);
    assert.match(result.summary, /headBranch was 1\.2\.4, expected 1\.2\.3/u);
    assert.match(result.summary, /conclusion was failure, expected success/u);
  });

  test("polls a selected publish run until GitHub reports terminal success", async () => {
    const commands: string[] = [];
    const sleeps: number[] = [];
    const runningRun = { ...successfulRun, status: "in_progress", conclusion: null };
    const responses: CommandResult[] = [
      {
        command: "gh run list",
        exitCode: 0,
        stdout: JSON.stringify([runningRun]),
        stderr: "",
      },
      {
        command: "gh run view 987654321",
        exitCode: 0,
        stdout: JSON.stringify(runningRun),
        stderr: "",
      },
      {
        command: "gh run view 987654321",
        exitCode: 0,
        stdout: JSON.stringify(successfulRun),
        stderr: "",
      },
    ];

    const result = await waitForWorkflowRunSucceeded("abc123", {
      workflowFile: "publish.yml",
      expectedHeadBranch: "1.2.3",
      listAttempts: 1,
      viewAttempts: 3,
      pollIntervalMs: 25,
      runCommand: (args) => {
        commands.push(args.join(" "));
        const response = responses.shift();
        if (response === undefined) throw new Error(`unexpected command: ${args.join(" ")}`);
        return { ...response, command: args.join(" ") };
      },
      sleep: (durationMs) => {
        sleeps.push(durationMs);
        return Promise.resolve();
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(sleeps, [25]);
    assert.equal(commands.some((command) => command.includes(" run watch ")), false);
    assert.match(result.summary, /status: completed/u);
  });

  test("marks a still-running publish run as pending when polling times out", async () => {
    const runningRun = { ...successfulRun, status: "in_progress", conclusion: null };
    const result = await waitForWorkflowRunSucceeded("abc123", {
      workflowFile: "publish.yml",
      expectedHeadBranch: "1.2.3",
      listAttempts: 1,
      viewAttempts: 1,
      pollIntervalMs: 25,
      runCommand: (args) => ({
        command: args.join(" "),
        exitCode: 0,
        stdout: JSON.stringify(args.includes("list") ? [runningRun] : runningRun),
        stderr: "",
      }),
      sleep: () => Promise.resolve(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.pending, true);
    assert.match(result.summary, /did not reach a terminal status/u);
  });
});
