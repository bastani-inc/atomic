import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  countNestedRuns,
  formatNestedAggregate,
  formatNestedRunStatusLines,
} from "../../packages/subagents/src/runs/shared/nested-render.js";
import type { NestedRunSummary } from "../../packages/subagents/src/shared/types.js";

function run(id: string, state: NestedRunSummary["state"], children: NestedRunSummary[] = []): NestedRunSummary {
  return {
    id,
    parentRunId: "root",
    depth: 0,
    path: [],
    state,
    agent: id,
    children,
  };
}

describe("nested run rendering", () => {
  test("counts nested runs recursively across direct and step children", () => {
    const children: NestedRunSummary[] = [
      {
        ...run("parent", "running", [run("direct", "complete")]),
        steps: [{ agent: "step", status: "running", children: [run("stepChild", "failed")] }],
      },
      run("queued", "queued"),
    ];

    assert.deepEqual(countNestedRuns(children), {
      total: 4,
      running: 1,
      paused: 0,
      complete: 1,
      failed: 1,
      queued: 1,
    });
    assert.equal(formatNestedAggregate(children), "+4 nested runs (1 running, 1 failed, 1 complete, 1 queued)");
  });

  test("formats nested status lines with depth aggregation and command hints", () => {
    const lines = formatNestedRunStatusLines([run("parent", "running", [run("child", "complete")])], {
      indent: "",
      maxDepth: 0,
      maxLines: 4,
      commandHints: true,
    });

    assert.equal(lines[0]?.startsWith("↳ parent [parent] running"), true);
    assert.equal(lines[1], "  Status: subagent({ action: \"status\", id: \"parent\" })");
    assert.equal(lines[2], "  ↳ +1 nested run (1 complete)");
  });
});
