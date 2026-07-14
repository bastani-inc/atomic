import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowFileBackend } from "../../packages/workflows/src/durable/factory.js";
import { WorkflowFileDurableBackend, durableStateFileFor } from "../../packages/workflows/src/durable/file-backend.js";

function durableRecord(workflowId: string) {
  return {
    handle: {
      workflowId, name: "workflow", inputs: {}, createdAt: 1, updatedAt: 2,
      status: "paused", completedCheckpoints: 1, pendingPrompts: 0,
    },
    checkpoints: [{
      kind: "stage", workflowId, checkpointId: "stage:one", name: "one",
      replayKey: "stage:one", output: "done", completedAt: 2,
    }],
  };
}

describe("durable format adversarial file regressions", () => {
  let dir: string | undefined;
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  test("suppresses both filename and embedded IDs for current and legacy mismatches", () => {
    dir = mkdtempSync(join(tmpdir(), "durable-mismatched-ids-"));
    for (const [expected, version] of [["current-expected", 2], ["legacy-expected", 1]] as const) {
      const path = durableStateFileFor(dir, expected);
      const raw = JSON.stringify({ version, workflows: [durableRecord(`${expected}-payload`)], ...(version === 2 ? { deletedWorkflowIds: [] } : {}) });
      writeFileSync(path, raw);
      const backend: WorkflowFileDurableBackend = new WorkflowFileDurableBackend(dir);
      assert.deepEqual(backend.listResumableWorkflows(), []);
      assert.equal(backend.isWorkflowLoadable(expected), false);
      assert.equal(backend.isWorkflowLoadable(`${expected}-payload`), false);
      assert.equal(readFileSync(path, "utf-8"), raw);
    }
  });

  test("an authoritative current file supersedes mismatch-derived suppression", () => {
    dir = mkdtempSync(join(tmpdir(), "durable-mismatch-revival-"));
    writeFileSync(durableStateFileFor(dir, "expected"), JSON.stringify({
      version: 2, workflows: [durableRecord("payload")], deletedWorkflowIds: [],
    }));
    const backend = new WorkflowFileDurableBackend(dir);
    assert.deepEqual(backend.listResumableWorkflows(), []);
    assert.equal(backend.isWorkflowLoadable("payload"), false);

    backend.registerWorkflow({ workflowId: "payload", name: "current", inputs: {}, createdAt: 3, status: "paused", completedCheckpoints: 1 });
    backend.listResumableWorkflows();
    assert.equal(backend.isWorkflowLoadable("payload"), true);
  });

  test("public per-workflow factory binds the filename to the requested ID", () => {
    dir = mkdtempSync(join(tmpdir(), "durable-factory-id-"));
    process.env.HOME = dir;
    const durableDir = join(dir, ".atomic", "workflow-durable");
    mkdirSync(durableDir, { recursive: true });
    const path = durableStateFileFor(durableDir, "expected");
    writeFileSync(path, JSON.stringify({
      version: 2, workflows: [durableRecord("payload")], deletedWorkflowIds: [],
    }));
    const backend = createWorkflowFileBackend("expected");
    assert.equal(backend.isWorkflowLoadable("expected"), false);
    assert.equal(readFileSync(path, "utf-8").includes('"payload"'), true);
  });

  test("stale loadability and terminal writers cannot remove a deletion tombstone", async () => {
    dir = mkdtempSync(join(tmpdir(), "durable-stale-terminal-"));
    const deleting = new WorkflowFileDurableBackend(dir);
    const stale = new WorkflowFileDurableBackend(dir);
    deleting.registerWorkflow({ workflowId: "victim", name: "victim", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    assert.equal(stale.isWorkflowLoadable("victim"), true);

    await deleting.deleteWorkflow("victim");
    assert.equal(stale.isWorkflowLoadable("victim"), false);
    stale.setWorkflowStatus("victim", "cancelled");

    const tombstonePath = durableStateFileFor(dir, "victim");
    assert.equal(existsSync(tombstonePath), true);
    const fresh = new WorkflowFileDurableBackend(dir);
    assert.equal(fresh.isWorkflowLoadable("victim"), false);
    assert.deepEqual(JSON.parse(readFileSync(tombstonePath, "utf-8")).deletedWorkflowIds, ["victim"]);
  });
});
