/**
 * Row building, ordering, and presentation for the `/workflow resume` picker
 * (`workflowResumeSelectorItems`). Picker interaction is covered by
 * `workflow-resume-selector-host-picker.test.ts` — the selector mounts
 * exclusively through the host session-picker capability; there is no
 * remote-rendered path.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflowResumeSelectorItems } from "../../packages/workflows/src/tui/workflow-resume-selector.js";
import type { ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function entry(
  id: string,
  status: ResumableWorkflowEntry["status"],
  updatedAt = status === "completed" ? 300 : 200,
): ResumableWorkflowEntry {
  return {
    workflowId: id,
    name: `${status}-workflow`,
    status,
    completedCheckpoints: 2,
    pendingPrompts: 0,
    createdAt: 1,
    updatedAt,
  };
}

function stage(id: string, endedAt: number): StageSnapshot {
  return {
    id,
    name: id,
    status: "completed",
    parentIds: [],
    startedAt: endedAt - 1,
    endedAt,
    toolEvents: [],
  };
}

function pausedLiveRun(id = "live-paused", activityAt = 100): RunSnapshot {
  return {
    id,
    name: "live-workflow",
    inputs: {},
    status: "paused",
    stages: [],
    startedAt: 1,
    pausedAt: activityAt,
    resumable: true,
  };
}

describe("workflow resume selector rows", () => {
  test("globally orders mixed rows and renders completed rows with a green semantic", () => {
    const items = workflowResumeSelectorItems(
      [pausedLiveRun()],
      [entry("durable-paused", "paused")],
      [entry("durable-completed", "completed")],
    );

    assert.deepEqual(items.map((item) => item.result.kind), ["completed", "durable", "live"]);
    const completed = items[0]!;
    assert.match(completed.session.firstMessage, /✓ completed/);
    assert.equal(completed.session.messageColor, "success");
    assert.equal(completed.session.path, "workflow-completed:durable-completed");
  });

  test("sorts unsorted live rows by latest activity", () => {
    const items = workflowResumeSelectorItems([
      pausedLiveRun("middle", 200),
      pausedLiveRun("newest", 300),
      pausedLiveRun("oldest", 100),
    ], []);

    assert.deepEqual(items.map((item) => item.session.id), ["newest", "middle", "oldest"]);
  });

  test("sorts unsorted durable rows by durable update time", () => {
    const items = workflowResumeSelectorItems([], [
      entry("oldest", "paused", 100),
      entry("newest", "paused", 300),
      entry("middle", "paused", 200),
    ]);

    assert.deepEqual(items.map((item) => item.session.id), ["newest", "middle", "oldest"]);
  });

  test("globally interleaves live and durable rows by recency", () => {
    const items = workflowResumeSelectorItems(
      [pausedLiveRun("live-oldest", 100), pausedLiveRun("live-newest", 400)],
      [entry("durable-middle-new", "paused", 300), entry("durable-middle-old", "paused", 200)],
    );

    assert.deepEqual(items.map((item) => item.session.id), [
      "live-newest",
      "durable-middle-new",
      "durable-middle-old",
      "live-oldest",
    ]);
  });

  test("uses latest stage activity and deterministic ids for equal-time ties", () => {
    const live = pausedLiveRun("zulu-live", 50);
    live.stages.push(stage("recent", 500));
    const reversed = workflowResumeSelectorItems(
      [live, pausedLiveRun("alpha-live", 400)],
      [entry("zulu-durable", "paused", 400), entry("alpha-durable", "paused", 400)],
      [entry("middle-completed", "completed", 450)],
    );

    assert.deepEqual(reversed.map((item) => item.session.id), [
      "zulu-live",
      "middle-completed",
      "alpha-durable",
      "alpha-live",
      "zulu-durable",
    ]);
    assert.deepEqual(
      workflowResumeSelectorItems(
        [pausedLiveRun("alpha-live", 400), live],
        [entry("alpha-durable", "paused", 400), entry("zulu-durable", "paused", 400)],
        [entry("middle-completed", "completed", 450)],
      ).map((item) => item.session.id),
      reversed.map((item) => item.session.id),
    );
  });

  test("deduplicates before sorting and keeps live then durable precedence", () => {
    const items = workflowResumeSelectorItems(
      [pausedLiveRun()],
      [entry("same-id", "paused", 500)],
      [entry("same-id", "completed", 900), entry("live-paused", "completed", 1_000)],
    );

    assert.deepEqual(items.map((item) => item.session.id), ["same-id", "live-paused"]);
    assert.deepEqual(items.map((item) => item.result.kind), ["durable", "live"]);
  });
});

describe("workflow resume selector row presentation", () => {
  test("colors paused yellow, failed and blocked red, completed green", () => {
    const items = workflowResumeSelectorItems(
      [pausedLiveRun("live-paused-run")],
      [entry("d-paused", "paused"), entry("d-failed", "failed"), entry("d-blocked", "blocked")],
      [entry("d-completed", "completed")],
    );
    const byId = new Map(items.map((item) => [item.session.id, item.session]));
    assert.equal(byId.get("d-paused")?.messageColor, "warning");
    assert.equal(byId.get("d-failed")?.messageColor, "error");
    assert.equal(byId.get("d-blocked")?.messageColor, "error");
    assert.equal(byId.get("d-completed")?.messageColor, "success");
    assert.equal(byId.get("live-paused-run")?.messageColor, "warning");
  });

  test("presents a stale-heartbeat running durable row as crashed, never running", () => {
    const [item] = workflowResumeSelectorItems([], [{ ...entry("d-crashed", "running"), name: "repro-flow" }], []);
    assert.match(item!.session.firstMessage, /repro-flow {2}crashed/);
    assert.doesNotMatch(item!.session.firstMessage, /running/);
    assert.equal(item!.session.messageColor, "error");
    assert.match(item!.session.allMessagesText, /crashed/);
  });
});
