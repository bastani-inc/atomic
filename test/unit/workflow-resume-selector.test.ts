import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflowResumeSelectorItems } from "../../packages/workflows/src/tui/workflow-resume-selector.js";
import type { ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function stage(id: string, startedAt: number, endedAt?: number): StageSnapshot {
  return {
    id,
    name: id,
    status: endedAt === undefined ? "running" : "completed",
    parentIds: [],
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    toolEvents: [],
  };
}

function liveRun(id: string, startedAt: number, stages: StageSnapshot[] = []): RunSnapshot {
  return {
    id,
    name: id,
    inputs: {},
    status: "paused",
    stages,
    startedAt,
  };
}

function durableEntry(id: string, updatedAt: number): ResumableWorkflowEntry {
  return {
    workflowId: id,
    name: id,
    inputs: {},
    status: "paused",
    completedCheckpoints: 1,
    pendingPrompts: 0,
    createdAt: updatedAt - 100,
    updatedAt,
  };
}

function itemIds(
  liveRuns: readonly RunSnapshot[],
  durableEntries: readonly ResumableWorkflowEntry[],
): string[] {
  return workflowResumeSelectorItems(liveRuns, durableEntries).map((item) => item.session.id);
}

describe("workflowResumeSelectorItems", () => {
  test("sorts unsorted live runs by their latest run or stage activity", () => {
    const runs = [
      liveRun("middle", 200),
      liveRun("newest-by-stage", 100, [stage("recent-stage", 250, 300)]),
      liveRun("oldest", 50),
    ];

    assert.deepEqual(itemIds(runs, []), ["newest-by-stage", "middle", "oldest"]);
  });

  test("sorts unsorted durable backend entries by updatedAt", () => {
    const entries = [durableEntry("oldest", 100), durableEntry("newest", 300), durableEntry("middle", 200)];

    assert.deepEqual(itemIds([], entries), ["newest", "middle", "oldest"]);
  });

  test("globally interleaves live and durable choices by recency", () => {
    const runs = [liveRun("live-oldest", 100), liveRun("live-newest", 400)];
    const entries = [durableEntry("durable-middle-new", 300), durableEntry("durable-middle-old", 200)];

    assert.deepEqual(itemIds(runs, entries), [
      "live-newest",
      "durable-middle-new",
      "durable-middle-old",
      "live-oldest",
    ]);
  });

  test("uses workflow id to break equal-time ties independently of source input order", () => {
    const runs = [liveRun("alpha-live", 500), liveRun("zulu-live", 500)];
    const entries = [durableEntry("zulu-durable", 500), durableEntry("alpha-durable", 500)];
    const expected = ["alpha-durable", "alpha-live", "zulu-durable", "zulu-live"];

    assert.deepEqual(itemIds(runs, entries), expected);
    assert.deepEqual(itemIds([...runs].reverse(), [...entries].reverse()), expected);
  });

  test("deduplicates live and durable workflow ids before sorting and keeps the live row", () => {
    const items = workflowResumeSelectorItems(
      [liveRun("duplicate", 100)],
      [durableEntry("duplicate", 1_000), durableEntry("durable-middle", 500)],
    );

    assert.deepEqual(items.map((item) => item.session.id), ["durable-middle", "duplicate"]);
    assert.deepEqual(items[1]?.result, { kind: "live", runId: "duplicate" });
    assert.equal(items.filter((item) => item.session.id === "duplicate").length, 1);
  });
});
