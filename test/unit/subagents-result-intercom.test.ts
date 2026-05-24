import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  attachNestedChildrenToResultChildren,
  compactNestedResultChildren,
  resolveSubagentResultStatus,
} from "../../packages/subagents/src/intercom/result-intercom.js";
import type { NestedRunSummary, SubagentResultIntercomChild } from "../../packages/subagents/src/shared/types.js";

function nested(id: string, parentRunId = "root", parentStepIndex?: number, children: NestedRunSummary[] = []): NestedRunSummary {
  return {
    id,
    parentRunId,
    ...(parentStepIndex !== undefined ? { parentStepIndex } : {}),
    depth: 0,
    path: [{ runId: parentRunId }],
    state: "complete",
    agent: id,
    children,
  };
}

describe("subagent result intercom helpers", () => {
  test("resolves result status from detached, paused, success, state, and exit code inputs", () => {
    assert.equal(resolveSubagentResultStatus({ detached: true, success: true }), "detached");
    assert.equal(resolveSubagentResultStatus({ interrupted: true }), "paused");
    assert.equal(resolveSubagentResultStatus({ state: "paused" }), "paused");
    assert.equal(resolveSubagentResultStatus({ success: true }), "completed");
    assert.equal(resolveSubagentResultStatus({ state: "failed" }), "failed");
    assert.equal(resolveSubagentResultStatus({ exitCode: 0 }), "completed");
  });

  test("attaches nested children by parent step index and compacts depth", () => {
    const children: SubagentResultIntercomChild[] = [
      { agent: "worker-a", status: "completed", index: 0, summary: "done" },
      { agent: "worker-b", status: "completed", index: 1, summary: "done" },
    ];
    const nestedChildren = [nested("nested-a", "root", 0), nested("nested-b", "root", 1)];

    const attached = attachNestedChildrenToResultChildren("root", children, nestedChildren);

    assert.deepEqual(attached.map((child) => child.children?.map((run) => run.id)), [["nested-a"], ["nested-b"]]);
  });

  test("compacts nested result trees to bounded breadth and depth", () => {
    const deep = nested("level0", "root", undefined, [
      nested("level1", "level0", undefined, [
        nested("level2", "level1", undefined, [nested("level3", "level2")]),
      ]),
    ]);
    const compact = compactNestedResultChildren(Array.from({ length: 20 }, (_, index) => ({ ...deep, id: `run${index}` })));

    assert.equal(compact?.length, 16);
    assert.equal(compact?.[0]?.children?.[0]?.children?.[0]?.id, "level2");
    assert.equal(compact?.[0]?.children?.[0]?.children?.[0]?.children, undefined);
  });
});
