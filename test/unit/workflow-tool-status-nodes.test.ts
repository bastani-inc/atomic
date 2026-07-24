import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import type { RunSnapshot, ToolNodeSnapshot, ToolNodeStatus } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";

function tool(status: ToolNodeStatus, index: number): ToolNodeSnapshot {
  return {
    kind: "tool",
    id: `tool-${status}`,
    name: `tool-${status}`,
    argsHash: `hash-${status}`,
    ordinal: index + 1,
    parentIds: [],
    status,
    executionOrder: index + 1,
    startedAt: 100 + index,
    ...(status === "running" ? {} : { endedAt: 200 + index }),
    ...(status === "cached" ? { replayed: true } : {}),
    ...(status === "failed" ? { error: "publish rejected" } : { resultSummary: `result-${status}` }),
    attachable: false,
  };
}

function toolRun(): RunSnapshot {
  const statuses: ToolNodeStatus[] = ["running", "completed", "failed", "cached", "cancelled"];
  return {
    id: "tool-status-run",
    name: "tool status workflow",
    inputs: {},
    status: "running",
    stages: [],
    toolNodes: statuses.map(tool),
    startedAt: 100,
  };
}

describe("workflow tool status nodes", () => {
  test("targeted run detail renders tool names and every visible state", () => {
    const run = toolRun();
    const text = renderRunDetail({
      runId: run.id,
      name: run.name,
      status: run.status,
      mode: "single",
      startedAt: run.startedAt,
      inputs: run.inputs,
      stages: [],
      tools: run.toolNodes ?? [],
    }, { now: 300, width: 100 });

    assert.match(text, /TOOLS/);
    for (const status of ["running", "completed", "failed", "cached", "cancelled"]) {
      assert.match(text, new RegExp(`tool-${status}.*${status}`));
    }
    assert.doesNotMatch(text, /no stages recorded yet/);
  });

  test("no-target status includes additive tool metadata in text and JSON", () => {
    const run = toolRun();
    const summary = summarizeRunSnapshot(run, 300);
    const result = { action: "status" as const, filter: "all" as const, runs: [summary], snapshots: [run] };

    assert.deepEqual(summary.tools?.map(({ id, name, status, attachable }) => ({ id, name, status, attachable })),
      (run.toolNodes ?? []).map(({ id, name, status, attachable }) => ({ id, name, status, attachable })));
    const text = renderWorkflowToolContent(result, { action: "status" });
    for (const status of ["running", "completed", "failed", "cached", "cancelled"]) {
      assert.match(text, new RegExp(`tool-${status} \\(${status}\\)`));
    }
    const json = JSON.parse(renderWorkflowToolContent(result, { action: "status", format: "json" })) as {
      runs: Array<{ tools: Array<{ name: string; status: string }> }>;
    };
    assert.deepEqual(json.runs[0]?.tools.map(({ name, status }) => ({ name, status })),
      (run.toolNodes ?? []).map(({ name, status }) => ({ name, status })));
  });

  test("tool cards render terminal state labels", () => {
    const run = toolRun();
    const graph = expandWorkflowGraph({ runs: [run], notices: [], version: 1 }, run.id);
    const theme = deriveGraphTheme({});
    for (const status of ["completed", "failed", "cached", "cancelled"] as const) {
      const card = graph.renderStages.find((stage) => stage.toolStatus === status);
      assert.ok(card !== undefined);
      const rendered = renderNodeCard(card, { theme }).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(rendered, new RegExp(status));
    }
  });
});
