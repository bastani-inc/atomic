import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { findResumableWorkflowNotices } from "../../packages/workflows/src/shared/resumable-workflow-notices.js";

describe("findResumableWorkflowNotices", () => {
  const cases = [
    { status: "running", resumable: undefined, completedCheckpoints: 1, expected: true },
    { status: "running", resumable: false, completedCheckpoints: 1, expected: true },
    { status: "running", resumable: true, completedCheckpoints: 0, expected: false },
    { status: "paused", resumable: undefined, pendingPrompts: 1, expected: true },
    { status: "paused", resumable: true, pendingPrompts: 0, expected: false },
    { status: "failed", resumable: undefined, expected: true },
    { status: "failed", resumable: true, expected: true },
    { status: "failed", resumable: false, expected: false },
    { status: "blocked", resumable: undefined, expected: true },
    { status: "blocked", resumable: true, expected: true },
    { status: "blocked", resumable: false, expected: false },
    { status: "completed", resumable: true, expected: false },
    { status: "cancelled", resumable: true, expected: false },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    test(`${scenario.status} with resumable=${String(scenario.resumable)} is ${scenario.expected ? "included" : "excluded"}`, () => {
      const workflowId = `run-${index}`;
      const data = {
        workflowId,
        name: `workflow-${index}`,
        status: scenario.status,
        ...(scenario.resumable !== undefined ? { resumable: scenario.resumable } : {}),
        completedCheckpoints: "completedCheckpoints" in scenario ? scenario.completedCheckpoints : 0,
        pendingPrompts: "pendingPrompts" in scenario ? scenario.pendingPrompts : 0,
      };
      const entries = [{ type: "custom", customType: "workflow.durable.checkpoint", data }];

      assert.equal(findResumableWorkflowNotices(entries, [data]).length, scenario.expected ? 1 : 0);
    });
  }

  test("uses only the latest checkpoint for each workflow", () => {
    const entries = [
      { type: "custom", customType: "workflow.durable.checkpoint", data: { workflowId: "run-1", name: "ralph", status: "failed" } },
      { type: "custom", customType: "workflow.durable.checkpoint", data: { workflowId: "run-1", name: "ralph", status: "completed" } },
    ];

    assert.deepEqual(findResumableWorkflowNotices(entries, [{ workflowId: "run-1" }]), []);
  });

  test("accepts legacy direct workflow entries", () => {
    const entries = [{
      type: "workflow.durable.checkpoint",
      workflowId: "run-legacy",
      name: "research",
      status: "blocked",
    }];

    assert.deepEqual(findResumableWorkflowNotices(entries, [{ workflowId: "run-legacy" }]), [{ workflowId: "run-legacy", name: "research" }]);
  });

  test("accepts legacy payload-wrapped workflow entries", () => {
    const entries = [{
      type: "workflow.durable.checkpoint",
      payload: { workflowId: "run-wrapped", name: "research", status: "blocked" },
    }];

    assert.deepEqual(findResumableWorkflowNotices(entries, [{ workflowId: "run-wrapped" }]), [{ workflowId: "run-wrapped", name: "research" }]);
  });

  test("excludes cached workflows missing from the authoritative catalog", () => {
    const entries = [{
      type: "custom",
      customType: "workflow.durable.checkpoint",
      data: { workflowId: "stale", name: "stale-workflow", status: "failed" },
    }];

    assert.deepEqual(findResumableWorkflowNotices(entries, []), []);
  });

  test("excludes nested child workflows", () => {
    const entries = [{
      type: "custom",
      customType: "workflow.durable.checkpoint",
      data: { workflowId: "child", rootWorkflowId: "root", name: "child-workflow", status: "failed" },
    }];

    assert.deepEqual(findResumableWorkflowNotices(entries, [{ workflowId: "child" }]), []);
  });
});
