import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createDurableCachedStageRecorder,
  reconcileCachedDirectChildParentStage,
} from "../../packages/workflows/src/engine/run-durable-topology.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import type { DurableCompletedStageCheckpoint } from "../../packages/workflows/src/durable/stage-primitive.js";
import { DURABLE_STAGE_TOPOLOGY_VERSION } from "../../packages/workflows/src/durable/types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, RunSnapshot, StageSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const ROOT_ID = "guard-root";
const CHILD_ID = "guard-child";
const OLD_BOUNDARY_ID = "completed-stage-2";

function stage(id: string, name = "leaf"): StageSnapshot {
  return {
    id,
    name,
    status: "completed",
    parentIds: ["parent-a", "parent-a"],
    startedAt: 10,
    endedAt: 20,
    durationMs: 10,
    result: "verbatim",
    toolEvents: [],
  };
}

function childRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: CHILD_ID,
    name: "guard-child-name",
    inputs: { raw: " unchanged " },
    status: "completed",
    stages: [stage("leaf-stage")],
    startedAt: 1,
    endedAt: 30,
    durationMs: 29,
    result: { value: "original" },
    parentRunId: ROOT_ID,
    parentStageId: OLD_BOUNDARY_ID,
    rootRunId: ROOT_ID,
    resumable: false,
    ...overrides,
  };
}

function parentRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: ROOT_ID,
    name: "guard-root-name",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: 1,
    rootRunId: ROOT_ID,
    ...overrides,
  };
}

function boundary(id = "current-boundary", childId = CHILD_ID): StageSnapshot {
  return {
    id,
    name: "current-boundary",
    status: "completed",
    parentIds: [],
    toolEvents: [],
    workflowChild: {
      alias: "guard-child",
      workflow: "guard-child-name",
      runId: childId,
      status: "completed",
      outputs: { value: "original" },
    },
  };
}

interface ReconcileCase {
  readonly name: string;
  readonly existing?: RunSnapshot;
  readonly catalog?: RunSnapshot;
  readonly parent?: RunSnapshot;
  readonly boundary?: StageSnapshot;
  readonly checkpointChildRunId?: string;
  readonly includeExisting?: boolean;
}

function attempt(item: ReconcileCase): {
  readonly changed: boolean;
  readonly before: StoreSnapshot;
  readonly after: StoreSnapshot;
  readonly notifications: StoreSnapshot[];
} {
  const store = createStore();
  if (item.includeExisting !== false) store.recordRunStart(item.existing ?? childRun());
  const before = store.snapshot();
  const notifications: StoreSnapshot[] = [];
  store.subscribe((snapshot) => notifications.push(snapshot));
  const changed = reconcileCachedDirectChildParentStage({
    store,
    parentRun: item.parent ?? parentRun(),
    catalogRun: item.catalog ?? childRun(),
    checkpointChildRunId: item.checkpointChildRunId ?? CHILD_ID,
    boundary: item.boundary ?? boundary(),
  });
  return { changed, before, after: store.snapshot(), notifications };
}

test("cached child reconciliation rejects every ownership and status mismatch verbatim", () => {
  const cases: ReconcileCase[] = [
    {
      name: "unknown checkpoint child",
      includeExisting: false,
      checkpointChildRunId: "unknown-child",
      catalog: childRun({ id: "unknown-child" }),
      boundary: boundary("current-boundary", "unknown-child"),
    },
    { name: "checkpoint/catalog child mismatch", catalog: childRun({ id: "catalog-other" }) },
    { name: "boundary claims another child", boundary: boundary("current-boundary", "claimed-other") },
    { name: "existing run is not completed", existing: childRun({ status: "running" }) },
    { name: "catalog run is not completed", catalog: childRun({ status: "failed" }) },
    { name: "existing direct parent differs", existing: childRun({ parentRunId: "other-parent" }) },
    { name: "catalog direct parent differs", catalog: childRun({ parentRunId: "other-parent" }) },
    { name: "catalog old parent is absent", catalog: childRun({ parentStageId: undefined }) },
    { name: "existing old parent differs", existing: childRun({ parentStageId: "other-old-boundary" }) },
    {
      name: "present root mismatches replay root",
      existing: childRun({ rootRunId: "other-root" }),
      catalog: childRun({ rootRunId: "other-root" }),
    },
    { name: "existing and catalog present roots disagree", existing: childRun({ rootRunId: "other-root" }) },
  ];

  for (const item of cases) {
    const result = attempt(item);
    assert.equal(result.changed, false, item.name);
    assert.deepEqual(result.after, result.before, item.name);
    assert.deepEqual(result.notifications, [], item.name);
  }
});

test("cached child reconciliation preserves run order, prompts, and notices while changing only the parent stage", () => {
  const store = createStore();
  const beforeSentinel = parentRun({
    id: "sentinel-before",
    name: "sentinel-before",
    status: "completed",
    endedAt: 2,
    durationMs: 1,
    rootRunId: "sentinel-before",
  });
  const existing = childRun({ rootRunId: undefined });
  const afterSentinel = parentRun({
    id: "sentinel-after",
    name: "sentinel-after",
    status: "completed",
    endedAt: 3,
    durationMs: 2,
    rootRunId: "sentinel-after",
  });
  const promptSentinel = parentRun({
    id: "prompt-sentinel",
    name: "prompt-sentinel",
    status: "running",
    rootRunId: "prompt-sentinel",
  });
  const terminalChildPrompt: PendingPrompt = {
    id: "terminal-child-prompt",
    kind: "input",
    message: "must be rejected for a completed child",
    initial: "rejected",
    createdAt: 39,
  };
  const preservedPrompt: PendingPrompt = {
    id: "guard-prompt",
    kind: "select",
    message: " prompt preserved verbatim ",
    choices: [" second ", "first", " second "],
    createdAt: 40,
  };
  store.recordRunStart(beforeSentinel);
  store.recordRunStart(existing);
  store.recordRunStart(afterSentinel);
  store.recordRunStart(promptSentinel);
  assert.equal(store.recordPendingPrompt(CHILD_ID, terminalChildPrompt), false);
  assert.equal(store.runs().find((run) => run.id === CHILD_ID)?.pendingPrompt, undefined);
  assert.equal(store.recordPendingPrompt(promptSentinel.id, preservedPrompt), true);
  store.recordNotice({
    id: "guard-notice",
    runId: CHILD_ID,
    stageId: "leaf-stage",
    level: "info",
    message: " notice preserved verbatim ",
    createdAt: 40,
  });
  const before = store.snapshot();
  const notifications: StoreSnapshot[] = [];
  store.subscribe((snapshot) => notifications.push(snapshot));

  const changed = reconcileCachedDirectChildParentStage({
    store,
    parentRun: parentRun(),
    catalogRun: childRun({ rootRunId: undefined }),
    checkpointChildRunId: CHILD_ID,
    boundary: boundary(),
  });
  const after = store.snapshot();

  assert.equal(changed, true);
  assert.deepEqual(after.runs.map((run) => run.id), [
    "sentinel-before",
    CHILD_ID,
    "sentinel-after",
    "prompt-sentinel",
  ]);
  assert.deepEqual(after.runs[0], before.runs[0]);
  assert.deepEqual(after.runs[2], before.runs[2]);
  const beforePromptRun = before.runs[3]!;
  const afterPromptRun = after.runs[3]!;
  assert.deepEqual(afterPromptRun, beforePromptRun);
  assert.equal(afterPromptRun.status, "running");
  assert.deepEqual(afterPromptRun.pendingPrompt, preservedPrompt);
  assert.equal(afterPromptRun.pendingPrompt?.id, "guard-prompt");
  assert.equal(afterPromptRun.pendingPrompt?.kind, "select");
  assert.equal(afterPromptRun.pendingPrompt?.message, " prompt preserved verbatim ");
  assert.deepEqual(afterPromptRun.pendingPrompt?.choices, [" second ", "first", " second "]);
  assert.equal(afterPromptRun.pendingPrompt?.createdAt, 40);
  assert.deepEqual(after.notices, before.notices);
  assert.deepEqual(store.notices(), before.notices);
  assert.equal(after.version, before.version + 1);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], after);
  const beforeRun = before.runs[1]!;
  const afterRun = after.runs[1]!;
  assert.equal(afterRun.parentStageId, "current-boundary");
  const { parentStageId: _beforeParent, ...beforeRest } = beforeRun;
  const { parentStageId: _afterParent, ...afterRest } = afterRun;
  assert.deepEqual(afterRest, beforeRest);
  assert.equal(beforeRun.parentStageId, OLD_BOUNDARY_ID);
  assert.equal(Array.isArray(afterRun.stages[0]?.parentIds), true);
  assert.deepEqual(afterRun.stages[0]?.parentIds, ["parent-a", "parent-a"]);
});

test("an already reconciled child cannot be stolen by a later corrupt boundary", () => {
  const store = createStore();
  store.recordRunStart(childRun());
  const catalog = childRun();
  const first = reconcileCachedDirectChildParentStage({
    store,
    parentRun: parentRun(),
    catalogRun: catalog,
    checkpointChildRunId: CHILD_ID,
    boundary: boundary("first-current-boundary"),
  });
  const afterFirst = store.snapshot();
  const second = reconcileCachedDirectChildParentStage({
    store,
    parentRun: parentRun(),
    catalogRun: catalog,
    checkpointChildRunId: CHILD_ID,
    boundary: boundary("stealing-boundary"),
  });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(store.runs()[0]?.parentStageId, "first-current-boundary");
  assert.deepEqual(store.snapshot(), afterFirst);
});

test("nested cached child reconciles only with complete reciprocal legacy-root ancestry", () => {
  const rootBoundary = boundary("root-to-middle", "middle");
  const root = parentRun({ stages: [rootBoundary] });
  const middle = parentRun({
    id: "middle",
    name: "middle-name",
    parentRunId: ROOT_ID,
    parentStageId: rootBoundary.id,
    rootRunId: undefined,
    stages: [boundary("current-boundary")],
  });
  const existing = childRun({ parentRunId: middle.id, rootRunId: ROOT_ID });
  const catalog = childRun({ parentRunId: middle.id, rootRunId: ROOT_ID });
  const store = createStore();
  store.recordRunStart(root);
  store.recordRunStart(middle);
  store.recordRunStart(existing);
  const before = store.snapshot();

  const changed = reconcileCachedDirectChildParentStage({
    store,
    parentRun: middle,
    catalogRun: catalog,
    checkpointChildRunId: CHILD_ID,
    boundary: boundary(),
  });

  assert.equal(changed, true);
  assert.equal(store.runs().find((item) => item.id === CHILD_ID)?.parentStageId, "current-boundary");
  const beforeChild = before.runs.find((item) => item.id === CHILD_ID)!;
  const afterChild = store.snapshot().runs.find((item) => item.id === CHILD_ID)!;
  const { parentStageId: _beforeParent, ...beforeRest } = beforeChild;
  const { parentStageId: _afterParent, ...afterRest } = afterChild;
  assert.deepEqual(afterRest, beforeRest);

  const isolatedStore = createStore();
  isolatedStore.recordRunStart(childRun({ parentRunId: middle.id, rootRunId: ROOT_ID }));
  assert.equal(reconcileCachedDirectChildParentStage({
    store: isolatedStore,
    parentRun: middle,
    catalogRun: catalog,
    checkpointChildRunId: CHILD_ID,
    boundary: boundary(),
  }), false);
  assert.equal(isolatedStore.runs()[0]?.parentStageId, OLD_BOUNDARY_ID);

  const conflictingStore = createStore();
  conflictingStore.recordRunStart(root);
  conflictingStore.recordRunStart({ ...middle, rootRunId: "other-root" });
  conflictingStore.recordRunStart(childRun({ parentRunId: middle.id, rootRunId: ROOT_ID }));
  assert.equal(reconcileCachedDirectChildParentStage({
    store: conflictingStore,
    parentRun: { ...middle, rootRunId: "other-root" },
    catalogRun: catalog,
    checkpointChildRunId: CHILD_ID,
    boundary: boundary(),
  }), false);
  assert.equal(conflictingStore.runs().find((item) => item.id === CHILD_ID)?.parentStageId, OLD_BOUNDARY_ID);

  const storeConflict = createStore();
  storeConflict.recordRunStart(root);
  storeConflict.recordRunStart({ ...middle, rootRunId: "other-root" });
  storeConflict.recordRunStart(childRun({ parentRunId: middle.id, rootRunId: ROOT_ID }));
  assert.equal(reconcileCachedDirectChildParentStage({
    store: storeConflict,
    parentRun: middle,
    catalogRun: catalog,
    checkpointChildRunId: CHILD_ID,
    boundary: boundary(),
  }), false);
  assert.equal(storeConflict.runs().find((item) => item.id === CHILD_ID)?.parentStageId, OLD_BOUNDARY_ID);
});

test("cached recorder derives the durable catalog root through rootless parent ancestry", () => {
  const backend = new InMemoryDurableBackend();
  backend.registerWorkflow({
    workflowId: ROOT_ID,
    name: "guard-root-name",
    inputs: {},
    createdAt: 1,
    updatedAt: 10,
    status: "completed",
  });
  const rootChildOutput = {
    workflow: "middle-name", runId: "middle", status: "completed", outputs: {},
  } as const;
  const grandChildOutput = {
    workflow: "guard-child-name", runId: CHILD_ID, status: "completed", outputs: {},
  } as const;
  backend.recordCheckpoint({
    kind: "stage", workflowId: ROOT_ID, checkpointId: "root-boundary", name: "root-boundary",
    replayKey: "root-boundary", output: rootChildOutput, completedAt: 2,
    topology: {
      version: DURABLE_STAGE_TOPOLOGY_VERSION, stageId: "root-boundary", parentIds: [],
      run: { runId: ROOT_ID, runName: "guard-root-name", rootRunId: ROOT_ID },
    },
  });
  const cachedBoundary: DurableCompletedStageCheckpoint = {
    kind: "stage", workflowId: "middle", checkpointId: "middle-boundary", name: "middle-boundary",
    replayKey: "middle-boundary", output: grandChildOutput, completedAt: 3,
    topology: {
      version: DURABLE_STAGE_TOPOLOGY_VERSION, stageId: "middle-boundary", parentIds: [],
      run: {
        runId: "middle", runName: "middle-name",
        parentRunId: ROOT_ID, parentStageId: "root-boundary",
      },
    },
  };
  backend.recordCheckpoint({ ...cachedBoundary, workflowId: ROOT_ID });
  backend.recordCheckpoint({
    kind: "stage", workflowId: ROOT_ID, checkpointId: "grand-leaf", name: "leaf",
    replayKey: "grand-leaf", output: "leaf-result", completedAt: 4,
    topology: {
      version: DURABLE_STAGE_TOPOLOGY_VERSION, stageId: "leaf", parentIds: [],
      run: {
        runId: CHILD_ID, runName: "guard-child-name", parentRunId: "middle",
        parentStageId: "middle-boundary", rootRunId: ROOT_ID,
      },
    },
  });

  const root = parentRun({ stages: [boundary("root-boundary", "middle")] });
  const middle = parentRun({
    id: "middle", name: "middle-name", parentRunId: ROOT_ID,
    parentStageId: "root-boundary", rootRunId: undefined, stages: [],
  });
  const store = createStore();
  store.recordRunStart(root);
  store.recordRunStart(middle);
  const recorder = createDurableCachedStageRecorder({
    store,
    tracker: new GraphFrontierTracker(),
    run: middle,
    backend,
    rootBackend: backend,
    completedStageReplayKeys: new Map(),
  });
  recorder.record("middle-boundary", "middle-boundary", cachedBoundary);

  const hydrated = store.runs().find((item) => item.id === CHILD_ID);
  const replayedBoundary = store.runs().find((item) => item.id === "middle")?.stages[0];
  assert.equal(hydrated?.parentRunId, "middle");
  assert.equal(hydrated?.parentStageId, replayedBoundary?.id);
  assert.equal(hydrated?.rootRunId, ROOT_ID);
  assert.equal(replayedBoundary?.workflowChild?.runId, CHILD_ID);

  const incompleteStore = createStore();
  incompleteStore.recordRunStart(middle);
  createDurableCachedStageRecorder({
    store: incompleteStore,
    tracker: new GraphFrontierTracker(),
    run: middle,
    backend,
    rootBackend: backend,
    completedStageReplayKeys: new Map(),
  }).record("middle-boundary", "middle-boundary", cachedBoundary);
  assert.equal(incompleteStore.runs().some((item) => item.id === CHILD_ID), false);
});
