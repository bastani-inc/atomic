/**
 * Run/stage store fixtures shared by the overlay entrypoint integration
 * tests. Split from overlay-entrypoints-helpers.ts (re-exported there) to
 * keep both files under the repository file-length gate.
 */
import type { createStore } from "../../packages/workflows/src/shared/store.js";

export function setupSequentialRun(store: ReturnType<typeof createStore>, runId: string, count: number): void {
  store.recordRunStart({
    id: runId,
    name: "wf",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  });
  for (let i = 0; i < count; i++) {
    store.recordStageStart(runId, {
      id: `stage-${i}`,
      name: `stage-${i}`,
      status: "pending",
      parentIds: i === 0 ? [] : [`stage-${i - 1}`],
      toolEvents: [],
    });
  }
}

export function setupBranchingRun(store: ReturnType<typeof createStore>, runId: string): void {
  const stages = [
    { id: "root", parentIds: [] },
    { id: "branch-left", parentIds: ["root"] },
    { id: "branch-right", parentIds: ["root"] },
    { id: "merge", parentIds: ["branch-left", "branch-right"] },
    { id: "tail-a", parentIds: ["merge"] },
    { id: "tail-b", parentIds: ["tail-a"] },
  ];
  setupRunFromStages(store, runId, stages);
}

export function setupWideFanoutRun(store: ReturnType<typeof createStore>, runId: string): void {
  setupRunFromStages(store, runId, [
    { id: "root", parentIds: [] },
    { id: "child-0", parentIds: ["root"] },
    { id: "child-1", parentIds: ["root"] },
    { id: "child-2", parentIds: ["root"] },
    { id: "child-3", parentIds: ["root"] },
    { id: "child-4", parentIds: ["root"] },
    { id: "child-5", parentIds: ["root"] },
  ]);
}

export function setupRunFromStages(
  store: ReturnType<typeof createStore>,
  runId: string,
  stages: Array<{ id: string; parentIds: string[] }>,
): void {
  store.recordRunStart({
    id: runId,
    name: "wf",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  });
  for (const stage of stages) {
    store.recordStageStart(runId, {
      id: stage.id,
      name: stage.id,
      status: "pending",
      parentIds: stage.parentIds,
      toolEvents: [],
    });
  }
}
