import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { findResumableWorkflowNotices } from "../../packages/workflows/src/shared/resumable-workflow-notices.js";
import type { DurableWorkflowStatus, ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";

interface CatalogOptions {
  readonly completedCheckpoints?: number;
  readonly pendingPrompts?: number;
  readonly resumable?: boolean;
  readonly rootWorkflowId?: string;
}

function catalogEntry(
  workflowId: string,
  name: string,
  status: DurableWorkflowStatus,
  options: CatalogOptions = {},
): ResumableWorkflowEntry {
  return {
    workflowId,
    name,
    inputs: {},
    status,
    completedCheckpoints: options.completedCheckpoints ?? 0,
    pendingPrompts: options.pendingPrompts ?? 0,
    ...(options.resumable !== undefined ? { resumable: options.resumable } : {}),
    ...(options.rootWorkflowId !== undefined ? { rootWorkflowId: options.rootWorkflowId } : {}),
    createdAt: 1,
    updatedAt: 2,
  };
}

function customEntry(data: Record<string, string | number | boolean | undefined>): object {
  return { type: "custom", customType: "workflow.durable.checkpoint", data };
}

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
      const name = `workflow-${index}`;
      const options: CatalogOptions = {
        ...("completedCheckpoints" in scenario ? { completedCheckpoints: scenario.completedCheckpoints } : {}),
        ...("pendingPrompts" in scenario ? { pendingPrompts: scenario.pendingPrompts } : {}),
        ...(scenario.resumable !== undefined ? { resumable: scenario.resumable } : {}),
      };
      const entry = catalogEntry(workflowId, name, scenario.status, options);

      assert.equal(
        findResumableWorkflowNotices([customEntry({ workflowId, name, status: scenario.status })], [entry]).length,
        scenario.expected ? 1 : 0,
      );
    });
  }

  test("uses authoritative state when cached checkpoint status is stale", () => {
    const entries = [
      customEntry({ workflowId: "run-1", name: "stale-name", status: "failed" }),
      customEntry({ workflowId: "run-1", name: "stale-name", status: "completed" }),
    ];
    const authoritative = catalogEntry("run-1", "authoritative-name", "failed");

    assert.deepEqual(findResumableWorkflowNotices(entries, [authoritative]), [
      { workflowId: "run-1", name: "authoritative-name" },
    ]);
  });

  test("accepts legacy direct workflow entries", () => {
    const entries = [{
      type: "workflow.durable.checkpoint",
      workflowId: "run-legacy",
      name: "stale-name",
      status: "blocked",
    }];
    const authoritative = catalogEntry("run-legacy", "research", "blocked");

    assert.deepEqual(findResumableWorkflowNotices(entries, [authoritative]), [
      { workflowId: "run-legacy", name: "research" },
    ]);
  });

  test("accepts legacy payload-wrapped workflow entries", () => {
    const entries = [{
      type: "workflow.durable.checkpoint",
      payload: { workflowId: "run-wrapped", name: "stale-name", status: "completed" },
    }];
    const authoritative = catalogEntry("run-wrapped", "research", "blocked");

    assert.deepEqual(findResumableWorkflowNotices(entries, [authoritative]), [
      { workflowId: "run-wrapped", name: "research" },
    ]);
  });

  test("excludes cached workflows missing from the authoritative catalog", () => {
    const entries = [customEntry({ workflowId: "stale", name: "stale-workflow", status: "failed" })];

    assert.deepEqual(findResumableWorkflowNotices(entries, []), []);
  });

  test("excludes authoritative zero-progress workflows despite stale cached progress", () => {
    const entries = [customEntry({
      workflowId: "zero-progress",
      name: "stale-name",
      status: "running",
      completedCheckpoints: 2,
    })];
    const authoritative = catalogEntry("zero-progress", "research", "running");

    assert.deepEqual(findResumableWorkflowNotices(entries, [authoritative]), []);
  });

  test("excludes nested child workflows", () => {
    const entries = [customEntry({ workflowId: "child", name: "child-workflow", status: "failed" })];
    const authoritative = catalogEntry("child", "child-workflow", "failed", { rootWorkflowId: "root" });

    assert.deepEqual(findResumableWorkflowNotices(entries, [authoritative]), []);
  });
});
