import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  selectPublishWorkflowRunJson,
  verifyPublishWorkflowRunJson,
  type CommandResult,
  type JsonValue,
} from "../../.atomic/workflows/lib/publish-release.js";
import { waitForWorkflowRunSucceeded } from "../../.atomic/workflows/lib/publish-release-run-wait.js";

describe("publish-release GitHub Actions publish verification", () => {
  const releaseSha = "dddddddddddddddddddddddddddddddddddddddd";
  const integrityJobs = {
    jobs: [{ databaseId: 222, name: "Verify release integrity", status: "completed", conclusion: "success" }],
  };
  const integrityLog = `Release integrity verified: ${releaseSha} is deterministic output from integrated parent aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.`;
  const successfulRun: JsonValue = {
    databaseId: 987654321,
    workflowName: "Publish",
    headBranch: "main",
    event: "workflow_dispatch",
    displayTitle: "Publish 1.2.3",
    status: "completed",
    conclusion: "success",
    headSha: "abc123",
    url: "https://github.com/earendil-works/pi-mono/actions/runs/987654321",
  };

  test("selects the newest protected dispatch for the release tag", () => {
    const result = selectPublishWorkflowRunJson([
      { ...successfulRun, databaseId: 111, displayTitle: "Publish 1.2.4" },
      { ...successfulRun, status: "in_progress", conclusion: null },
    ], "1.2.3");

    assert.deepEqual(result, {
      ok: true,
      summary: [
        "GitHub Actions publish run is selected.",
        "databaseId: 987654321",
        "headBranch: main",
        "event: workflow_dispatch",
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

  test("rejects run lists without a matching release dispatch title", () => {
    const result = selectPublishWorkflowRunJson([
      { ...successfulRun, displayTitle: "Publish 1.2.4" },
      { ...successfulRun, event: "push" },
    ], "1.2.3");

    assert.equal(result.ok, false);
    assert.match(result.summary, /expected release: 1\.2\.3 on protected main workflow Publish/u);
    assert.match(result.summary, /displayTitle=Publish 1\.2\.4 event=workflow_dispatch/u);
    assert.match(result.summary, /displayTitle=Publish 1\.2\.3 event=push/u);
  });

  test("accepts only completed successful publish runs for the release tag", () => {
    assert.deepEqual(verifyPublishWorkflowRunJson(successfulRun, "1.2.3"), {
      ok: true,
      summary: [
        "GitHub Actions publish run is verified as successful.",
        "databaseId: 987654321",
        "workflowName: Publish",
        "headBranch: main",
        "event: workflow_dispatch",
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
      { ...successfulRun, displayTitle: "Publish 1.2.4", status: "completed", conclusion: "failure" },
      "1.2.3",
    );

    assert.equal(result.ok, false);
    assert.match(result.summary, /displayTitle was Publish 1\.2\.4, expected Publish 1\.2\.3/u);
    assert.match(result.summary, /conclusion was failure, expected success/u);
  });

  test("polls a selected publish run until terminal success bound to the release SHA", async () => {
    const commands: string[] = [];
    const sleeps: number[] = [];
    const runningRun = { ...successfulRun, status: "in_progress", conclusion: null };
    const responses: CommandResult[] = [
      { command: "gh run list", exitCode: 0, stdout: JSON.stringify([runningRun]), stderr: "" },
      { command: "gh run view", exitCode: 0, stdout: JSON.stringify(runningRun), stderr: "" },
      { command: "gh run view", exitCode: 0, stdout: JSON.stringify(successfulRun), stderr: "" },
      { command: "gh run jobs", exitCode: 0, stdout: JSON.stringify(integrityJobs), stderr: "" },
      { command: "gh run log", exitCode: 0, stdout: integrityLog, stderr: "" },
    ];

    const result = await waitForWorkflowRunSucceeded(releaseSha, {
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

  test("polls an exhaustively reconciled publish run by pinned ID", async () => {
    const commands: string[] = [];
    const result = await waitForWorkflowRunSucceeded(releaseSha, {
      workflowFile: "publish.yml",
      expectedHeadBranch: "1.2.3",
      expectedRunId: 987654321,
      viewAttempts: 1,
      runCommand: (args) => {
        commands.push(args.join(" "));
        const stdout = args.includes("jobs")
          ? JSON.stringify(integrityJobs)
          : args.includes("--log")
            ? integrityLog
            : JSON.stringify(successfulRun);
        return { command: args.join(" "), exitCode: 0, stdout, stderr: "" };
      },
      sleep: () => Promise.resolve(),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(commands, [
      "gh run view 987654321 --json databaseId,status,conclusion,url,headBranch,event,workflowName,displayTitle,createdAt,headSha",
      "gh run view 987654321 --json jobs",
      "gh run view 987654321 --job 222 --log",
    ]);
    assert.match(result.summary, /pinned by exhaustive reconciliation/u);
  });

  test("rejects a successful recovered run whose integrity job verified another tag target", async () => {
    const result = await waitForWorkflowRunSucceeded("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", {
      workflowFile: "publish.yml",
      expectedHeadBranch: "1.2.3",
      expectedRunId: 987654321,
      viewAttempts: 1,
      runCommand: (args) => ({
        command: args.join(" "),
        exitCode: 0,
        stdout: args.includes("jobs")
          ? JSON.stringify(integrityJobs)
          : args.includes("--log")
            ? integrityLog
            : JSON.stringify(successfulRun),
        stderr: "",
      }),
      sleep: () => Promise.resolve(),
    });

    assert.equal(result.ok, false);
    assert.match(result.summary, /did not bind the run to expected release SHA/u);
  });

  test("publish-release run polling helper does not reference Bun globals", () => {
    const source = readFileSync(".atomic/workflows/lib/publish-release-run-wait.ts", "utf8");
    assert.doesNotMatch(source, /\bBun\./u);
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
