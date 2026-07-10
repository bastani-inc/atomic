import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { findResumableWorkflowNotices } from "../../packages/workflows/src/shared/resumable-workflow-notices.js";

describe("findResumableWorkflowNotices", () => {
  test("returns only the latest resumable durable workflow metadata", () => {
    const entries = [
      { type: "custom", customType: "workflow.durable.checkpoint", data: { workflowId: "run-1", name: "ralph", status: "running", resumable: true } },
      { type: "custom", customType: "workflow.durable.checkpoint", data: { workflowId: "run-2", name: "done", status: "completed", resumable: true } },
      { type: "custom", customType: "workflow.durable.checkpoint", data: { workflowId: "run-1", name: "ralph", status: "paused", resumable: true } },
      { type: "custom", customType: "workflow.durable.checkpoint", data: { workflowId: "run-3", name: "failed", status: "failed", resumable: false } },
    ];

    assert.deepEqual(findResumableWorkflowNotices(entries), [{ workflowId: "run-1", name: "ralph" }]);
  });

  test("accepts legacy direct workflow entries", () => {
    const entries = [{
      type: "workflow.durable.checkpoint",
      payload: { workflowId: "run-4", name: "research", status: "blocked", resumable: true },
    }];

    assert.deepEqual(findResumableWorkflowNotices(entries), [{ workflowId: "run-4", name: "research" }]);
  });
});
