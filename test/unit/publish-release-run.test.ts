import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  selectPublishWorkflowRunJson,
  verifyPublishWorkflowRunJson,
  type CommandResult,
  type JsonValue,
} from "../../.atomic/workflows/lib/publish-release.js";
import { verifyPublishRunSucceeded } from "../../.atomic/workflows/lib/publish-release-run.js";

describe("publish-release event-driven GitHub Actions verification", () => {
  const releaseSha = "dddddddddddddddddddddddddddddddddddddddd";
  const successfulRun: JsonValue = {
    databaseId: 987654321,
    workflowName: "Publish",
    headBranch: "1.2.3",
    event: "create",
    displayTitle: "Publish 1.2.3",
    status: "completed",
    conclusion: "success",
    headSha: "abc123",
    url: "https://github.com/bastani-inc/atomic/actions/runs/987654321",
  };
  const integrityJobs = {
    jobs: [{ databaseId: 222, name: "Verify release integrity", status: "completed", conclusion: "success" }],
  };
  const integrityLog = `Release integrity verified: ${releaseSha} is deterministic output from integrated parent aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.`;

  test("selects the newest tag-triggered protected publish run", () => {
    const result = selectPublishWorkflowRunJson([
      { ...successfulRun, databaseId: 111, displayTitle: "Publish 1.2.4" },
      { ...successfulRun, status: "in_progress", conclusion: null },
    ], "1.2.3");

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.runId, 987654321);
    assert.equal(result.status, "in_progress");
    assert.match(result.summary, /event: create/u);
  });

  test("rejects manual dispatches and unrelated tag events", () => {
    const result = selectPublishWorkflowRunJson([
      { ...successfulRun, displayTitle: "Publish 1.2.4" },
      { ...successfulRun, event: "workflow_dispatch" },
    ], "1.2.3");

    assert.equal(result.ok, false);
    assert.match(result.summary, /expected release: 1\.2\.3 on protected main workflow Publish/u);
    assert.match(result.summary, /event=workflow_dispatch/u);
  });

  test("accepts only a completed successful create event", () => {
    const result = verifyPublishWorkflowRunJson(successfulRun, "1.2.3");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.conclusion, "success");
    assert.match(result.summary, /releaseTag: 1\.2\.3/u);
  });

  test("verifies one observed run and its integrity evidence without polling", async () => {
    const commands: string[] = [];
    const responses = [
      JSON.stringify([successfulRun]),
      JSON.stringify(successfulRun),
      JSON.stringify(integrityJobs),
      integrityLog,
    ];
    const execute = (args: readonly string[]): CommandResult => {
      commands.push(args.join(" "));
      const stdout = responses.shift();
      if (stdout === undefined) throw new Error(`unexpected command: ${args.join(" ")}`);
      return { command: args.join(" "), exitCode: 0, stdout, stderr: "" };
    };

    const result = await verifyPublishRunSucceeded("1.2.3", releaseSha, execute);

    assert.equal(result.ok, true);
    assert.equal(commands.length, 4);
    assert.match(commands[0] ?? "", /--event create/u);
    assert.equal(commands.some((command) => command.includes("--watch")), false);
  });

  test("returns pending when the observed run is active", async () => {
    const runningRun = { ...successfulRun, status: "in_progress", conclusion: null };
    const commands: string[] = [];
    const execute = (args: readonly string[]): CommandResult => {
      commands.push(args.join(" "));
      return {
        command: args.join(" "),
        exitCode: 0,
        stdout: JSON.stringify(args.includes("list") ? [runningRun] : runningRun),
        stderr: "",
      };
    };

    const result = await verifyPublishRunSucceeded("1.2.3", releaseSha, execute);

    assert.equal(result.ok, false);
    assert.equal(result.pending, true);
    assert.equal(commands.length, 2);
    assert.match(result.summary, /status: in_progress/u);
    assert.doesNotMatch(result.summary, /poll|resume after/u);
  });

  test("rejects integrity evidence bound to another release SHA", async () => {
    const execute = (args: readonly string[]): CommandResult => ({
      command: args.join(" "),
      exitCode: 0,
      stdout: args.includes("list")
        ? JSON.stringify([successfulRun])
        : args.includes("jobs")
          ? JSON.stringify(integrityJobs)
          : args.includes("--log")
            ? integrityLog
            : JSON.stringify(successfulRun),
      stderr: "",
    });

    const result = await verifyPublishRunSucceeded("1.2.3", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", execute);
    assert.equal(result.ok, false);
    assert.match(result.summary, /did not bind the run to expected release SHA/u);
  });

  test("implementation contains no sleep, timeout, watch, or polling loop", () => {
    const source = readFileSync(".atomic/workflows/lib/publish-release-run.ts", "utf8");
    assert.doesNotMatch(source, /setTimeout|\bsleep\b|--watch|while\s*\(/u);
  });
});
