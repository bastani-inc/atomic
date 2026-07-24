import { test } from "bun:test";
import assert from "node:assert/strict";
import { reconcileCachedDirectChildParentStage } from "../../packages/workflows/src/engine/run-durable-topology.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const ROOT_ID = "legacy-root";
const PARENT_ID = "legacy-parent";
const CHILD_ID = "legacy-child";
const OLD_BOUNDARY_ID = "completed-stage-2";
const CURRENT_BOUNDARY_ID = "current-boundary";

function childBoundary(
  id: string,
  childId: string,
  overrides: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    id,
    name: id,
    status: "completed",
    parentIds: [],
    toolEvents: [],
    workflowChild: {
      alias: childId,
      workflow: `${childId}-workflow`,
      runId: childId,
      status: "completed",
      outputs: {},
    },
    ...overrides,
  };
}

function run(
  id: string,
  stages: readonly StageSnapshot[],
  overrides: Partial<RunSnapshot> = {},
): RunSnapshot {
  return {
    id,
    name: `${id}-name`,
    inputs: {},
    status: "completed",
    stages: [...stages],
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    ...overrides,
  };
}

function hierarchy(input: {
  readonly storedParentRoot?: string;
  readonly callerParentRoot?: string;
  readonly existingChildRoot?: string;
  readonly catalogChildRoot?: string;
  readonly storedBoundary?: StageSnapshot;
} = {}): {
  readonly root: RunSnapshot;
  readonly storedParent: RunSnapshot;
  readonly callerParent: RunSnapshot;
  readonly existingChild: RunSnapshot;
  readonly catalogChild: RunSnapshot;
  readonly callerBoundary: StageSnapshot;
} {
  const rootBoundary = childBoundary("root-boundary", PARENT_ID);
  const callerBoundary = childBoundary(CURRENT_BOUNDARY_ID, CHILD_ID);
  const storedBoundary = input.storedBoundary ?? callerBoundary;
  const parentOwnership = {
    parentRunId: ROOT_ID,
    parentStageId: rootBoundary.id,
  };
  const childOwnership = {
    parentRunId: PARENT_ID,
    parentStageId: OLD_BOUNDARY_ID,
  };
  return {
    root: run(ROOT_ID, [rootBoundary], { rootRunId: ROOT_ID }),
    storedParent: run(PARENT_ID, [storedBoundary], {
      ...parentOwnership,
      rootRunId: input.storedParentRoot,
    }),
    callerParent: run(PARENT_ID, [callerBoundary], {
      ...parentOwnership,
      rootRunId: input.callerParentRoot,
    }),
    existingChild: run(CHILD_ID, [], {
      ...childOwnership,
      rootRunId: input.existingChildRoot,
    }),
    catalogChild: run(CHILD_ID, [], {
      ...childOwnership,
      rootRunId: input.catalogChildRoot,
    }),
    callerBoundary,
  };
}

function reconcile(input: ReturnType<typeof hierarchy>): {
  readonly changed: boolean;
  readonly before: StoreSnapshot;
  readonly after: StoreSnapshot;
  readonly notifications: StoreSnapshot[];
} {
  const store = createStore();
  store.recordRunStart(input.root);
  store.recordRunStart(input.storedParent);
  store.recordRunStart(input.existingChild);
  const before = store.snapshot();
  const notifications: StoreSnapshot[] = [];
  store.subscribe((snapshot) => notifications.push(snapshot));
  const changed = reconcileCachedDirectChildParentStage({
    store,
    parentRun: input.callerParent,
    catalogRun: input.catalogChild,
    checkpointChildRunId: CHILD_ID,
    boundary: input.callerBoundary,
  });
  return { changed, before, after: store.snapshot(), notifications };
}

function assertOnlyParentStageChanged(result: ReturnType<typeof reconcile>, name: string): void {
  assert.equal(result.changed, true, name);
  assert.deepEqual(result.after.runs.map((item) => item.id), result.before.runs.map((item) => item.id), name);
  assert.deepEqual(result.after.notices, result.before.notices, name);
  assert.equal(result.after.version, result.before.version + 1, name);
  assert.equal(result.notifications.length, 1, name);
  assert.deepEqual(result.notifications[0], result.after, name);
  for (let index = 0; index < result.before.runs.length; index += 1) {
    const beforeRun = result.before.runs[index]!;
    const afterRun = result.after.runs[index]!;
    if (beforeRun.id !== CHILD_ID) {
      assert.deepEqual(afterRun, beforeRun, name);
      continue;
    }
    assert.equal(afterRun.parentStageId, CURRENT_BOUNDARY_ID, name);
    const { parentStageId: _beforeParent, ...beforeRest } = beforeRun;
    const { parentStageId: _afterParent, ...afterRest } = afterRun;
    assert.deepEqual(afterRest, beforeRest, name);
    assert.equal(beforeRun.parentStageId, OLD_BOUNDARY_ID, name);
  }
}

test("durable reconciliation accepts compatible omitted and present roots", () => {
  const cases = [
    { name: "all omitted", input: {} },
    { name: "stored parent omitted", input: { callerParentRoot: ROOT_ID } },
    { name: "caller parent omitted", input: { storedParentRoot: ROOT_ID } },
    { name: "existing child omitted", input: { catalogChildRoot: ROOT_ID } },
    { name: "catalog child omitted", input: { existingChildRoot: ROOT_ID } },
    {
      name: "all present and correct",
      input: {
        storedParentRoot: ROOT_ID,
        callerParentRoot: ROOT_ID,
        existingChildRoot: ROOT_ID,
        catalogChildRoot: ROOT_ID,
      },
    },
  ] as const;

  for (const item of cases) {
    assertOnlyParentStageChanged(reconcile(hierarchy(item.input)), item.name);
  }
});

test("durable reconciliation rejects every present root conflict", () => {
  const cases = [
    { name: "stored parent conflicts", input: { storedParentRoot: "other-root" } },
    { name: "caller parent conflicts", input: { callerParentRoot: "other-root" } },
    { name: "existing child conflicts", input: { existingChildRoot: "other-root" } },
    { name: "catalog child conflicts", input: { catalogChildRoot: "other-root" } },
    {
      name: "children disagree",
      input: { existingChildRoot: ROOT_ID, catalogChildRoot: "other-root" },
    },
  ] as const;

  for (const item of cases) {
    const result = reconcile(hierarchy(item.input));
    assert.equal(result.changed, false, item.name);
    assert.deepEqual(result.after, result.before, item.name);
    assert.deepEqual(result.notifications, [], item.name);
  }
});

test("stored parent must corroborate the caller boundary claim", () => {
  const completedConflict = childBoundary(CURRENT_BOUNDARY_ID, "replay-other", {
    workflowChildRun: {
      alias: CHILD_ID,
      workflow: `${CHILD_ID}-workflow`,
      runId: CHILD_ID,
    },
  });
  const activeConflict = childBoundary(CURRENT_BOUNDARY_ID, CHILD_ID, {
    status: "running",
    workflowChildRun: {
      alias: "live-other",
      workflow: "live-other-workflow",
      runId: "live-other",
    },
  });
  const cases = [
    { name: "missing stored boundary", storedBoundary: undefined },
    { name: "stored boundary claims another child", storedBoundary: childBoundary(CURRENT_BOUNDARY_ID, "other") },
    { name: "stored boundary failed", storedBoundary: childBoundary(CURRENT_BOUNDARY_ID, CHILD_ID, { status: "failed" }) },
    { name: "stored boundary skipped", storedBoundary: childBoundary(CURRENT_BOUNDARY_ID, CHILD_ID, { status: "skipped" }) },
    { name: "completed replay claim wins", storedBoundary: completedConflict },
    { name: "active live claim wins", storedBoundary: activeConflict },
  ];

  for (const item of cases) {
    const input = hierarchy({
      storedBoundary: item.storedBoundary ?? childBoundary("different-boundary", CHILD_ID),
    });
    const result = reconcile(input);
    assert.equal(result.changed, false, item.name);
    assert.deepEqual(result.after, result.before, item.name);
    assert.deepEqual(result.notifications, [], item.name);
  }
});

test("top-level caller-only reconciliation remains compatible without a stored parent", () => {
  const store = createStore();
  const existing = run(CHILD_ID, [], {
    parentRunId: ROOT_ID,
    parentStageId: OLD_BOUNDARY_ID,
    rootRunId: ROOT_ID,
  });
  const catalog = { ...existing, stages: [...existing.stages] };
  const parent = run(ROOT_ID, [childBoundary(CURRENT_BOUNDARY_ID, CHILD_ID)], { rootRunId: ROOT_ID });
  store.recordRunStart(existing);

  const changed = reconcileCachedDirectChildParentStage({
    store,
    parentRun: parent,
    catalogRun: catalog,
    checkpointChildRunId: CHILD_ID,
    boundary: parent.stages[0]!,
  });

  assert.equal(changed, true);
  assert.equal(store.runs()[0]?.parentStageId, CURRENT_BOUNDARY_ID);
});
