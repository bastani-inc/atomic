import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflowResumeSelectorItems } from "../../packages/workflows/src/tui/workflow-resume-selector.js";
import type { ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function entry(id: string, status: ResumableWorkflowEntry["status"]): ResumableWorkflowEntry {
  return {
    workflowId: id,
    name: `${status}-workflow`,
    status,
    completedCheckpoints: 2,
    pendingPrompts: 0,
    createdAt: 1,
    updatedAt: status === "completed" ? 3 : 2,
  };
}

function pausedLiveRun(): RunSnapshot {
  return {
    id: "live-paused",
    name: "live-workflow",
    inputs: {},
    status: "paused",
    stages: [],
    startedAt: 1,
    pausedAt: 2,
    resumable: true,
  };
}

describe("workflow resume selector", () => {
  test("mixes live, resumable, and completed rows with a green completed semantic", () => {
    const items = workflowResumeSelectorItems(
      [pausedLiveRun()],
      [entry("durable-paused", "paused")],
      [entry("durable-completed", "completed")],
    );

    assert.deepEqual(items.map((item) => item.result.kind), ["live", "durable", "completed"]);
    assert.match(items[2]!.session.firstMessage, /✓ completed/);
    assert.equal(items[2]!.session.messageColor, "success");
    assert.equal(items[2]!.session.path, "workflow-completed:durable-completed");
  });

  test("does not duplicate a completed row shadowed by a live or resumable id", () => {
    const items = workflowResumeSelectorItems(
      [pausedLiveRun()],
      [entry("same-id", "paused")],
      [entry("same-id", "completed"), entry("live-paused", "completed")],
    );
    assert.deepEqual(items.map((item) => item.session.id), ["live-paused", "same-id"]);
  });
});
