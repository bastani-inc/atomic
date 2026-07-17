import { beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
  openWorkflowResumeSelector,
  workflowResumeSelectorItems,
  type OpenWorkflowResumeSelectorResult,
  type WorkflowResumeCatalogRows,
} from "../../packages/workflows/src/tui/workflow-resume-selector.js";
import type {
  PiCustomComponent,
  PiCustomOverlayFactory,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayFunction,
} from "../../packages/workflows/src/extension/wiring.js";
import type { ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

interface MountedSelector {
  readonly promise: Promise<OpenWorkflowResumeSelectorResult>;
  readonly component: () => PiCustomComponent;
}

function mountSelector(
  liveRuns: readonly RunSnapshot[],
  hydrate: () => Promise<WorkflowResumeCatalogRows>,
  options: Parameters<typeof openWorkflowResumeSelector>[3] = {},
): MountedSelector {
  let mounted: PiCustomComponent | undefined;
  const custom: PiCustomOverlayFunction = (factory: PiCustomOverlayFactory) =>
    new Promise<undefined>((resolveCustom) => {
      const tui: PiCustomOverlayFactoryTui = { requestRender: () => {} };
      const built = factory(tui, undefined, undefined, () => resolveCustom(undefined));
      if (built instanceof Promise) void built.then((component) => { mounted = component; });
      else mounted = built;
    });
  const promise = openWorkflowResumeSelector({ custom }, liveRuns, hydrate, options);
  return {
    promise,
    component: () => {
      if (mounted === undefined) throw new Error("selector not mounted");
      return mounted;
    },
  };
}

function renderText(component: PiCustomComponent, width = 120): string {
  return stripAnsi(component.render(width).join("\n"));
}

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

describe("workflow resume selector", () => {
  beforeAll(() => {
    initTheme("dark");
  });

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

  test("closes when the custom selector mount throws or rejects", async () => {
    const noCatalog = async (): Promise<WorkflowResumeCatalogRows> => ({ durable: [], completed: [] });
    const thrown = await openWorkflowResumeSelector({
      custom: () => { throw new Error("mount failed"); },
    }, [pausedLiveRun()], noCatalog);
    const rejected = await openWorkflowResumeSelector({
      custom: async () => { throw new Error("async mount failed"); },
    }, [pausedLiveRun()], noCatalog);

    assert.deepEqual(thrown.result, { kind: "close" });
    assert.deepEqual(rejected.result, { kind: "close" });
  });

  test("mounts live rows before hydrate resolves and merges durable rows after", async () => {
    const gate = deferred<WorkflowResumeCatalogRows>();
    let hydrateCalls = 0;
    const mounted = mountSelector([pausedLiveRun("live-a", 100)], () => {
      hydrateCalls += 1;
      return gate.promise;
    });

    await flush();
    const before = renderText(mounted.component());
    assert.ok(before.includes("live-workflow"), "live row visible on the first frame");
    assert.ok(!before.includes("paused-workflow"), "durable row absent before hydrate resolves");

    gate.resolve({ durable: [entry("durable-a", "paused")], completed: [] });
    await flush();
    const after = renderText(mounted.component());
    assert.ok(after.includes("paused-workflow"), "durable row merged after hydrate resolves");
    assert.ok(after.includes("live-workflow"), "live row retained after merge");
    assert.equal(hydrateCalls, 1, "hydrate invoked exactly once");

    mounted.component().dispose?.();
    const outcome = await mounted.promise;
    assert.deepEqual(outcome.result, { kind: "close" });
    assert.equal(outcome.catalog.durable.length, 1, "resolved catalog returned for follow-on resume");
  });

  test("dispose cancels late hydration and prevents merge after close", async () => {
    const gate = deferred<WorkflowResumeCatalogRows>();
    const mounted = mountSelector([pausedLiveRun("live-b", 100)], () => gate.promise);

    await flush();
    mounted.component().dispose?.();
    const outcome = await mounted.promise;
    assert.deepEqual(outcome.result, { kind: "close" });
    assert.equal(outcome.catalog.durable.length, 0, "catalog empty because closed before hydrate");

    // Late-resolving hydration must not merge into the disposed selector.
    gate.resolve({ durable: [entry("late", "paused")], completed: [] });
    await flush();
    const rendered = renderText(mounted.component());
    assert.ok(!rendered.includes("paused-workflow"), "late hydration not merged after dispose");
  });

  test("hydrate failure keeps live rows on screen without rejecting", async () => {
    const mounted = mountSelector([pausedLiveRun("live-c", 100)], async () => {
      throw new Error("catalog boom");
    });

    await flush();
    const rendered = renderText(mounted.component());
    assert.ok(rendered.includes("live-workflow"), "live rows survive a hydrate failure");

    mounted.component().dispose?.();
    const outcome = await mounted.promise;
    assert.deepEqual(outcome.result, { kind: "close" });
  });
});

describe("workflow resume selector row presentation", () => {
  beforeAll(() => {
    initTheme("dark");
  });

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

describe("workflow resume selector live updates", () => {
  beforeAll(() => {
    initTheme("dark");
  });

  test("watch-triggered refresh re-lists rows while the picker stays open", async () => {
    let onChange: (() => void) | undefined;
    let unsubscribed = 0;
    let refreshCalls = 0;
    let rows: WorkflowResumeCatalogRows = { durable: [], completed: [] };
    const mounted = mountSelector(
      [pausedLiveRun("live-a", 100)],
      async () => rows,
      {
        refreshIntervalMs: 0,
        watch: (change) => {
          onChange = change;
          return () => { unsubscribed += 1; };
        },
        refresh: async () => {
          refreshCalls += 1;
          return { liveRuns: [], catalog: rows };
        },
      },
    );
    await flush();
    assert.ok(renderText(mounted.component()).includes("live-workflow"));
    assert.ok(onChange, "watch registered after mount");

    // A quit elsewhere pauses the workflow: the durable row must appear and the
    // (now stale) live row must drop without reopening the picker.
    rows = { durable: [entry("d-now-paused", "paused")], completed: [] };
    onChange!();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();

    const rendered = renderText(mounted.component());
    assert.ok(rendered.includes("paused-workflow"), "transitioned row appears live");
    assert.ok(!rendered.includes("live-workflow"), "removed live row disappears");
    assert.equal(refreshCalls, 1);

    mounted.component().dispose?.();
    await mounted.promise;
    assert.equal(unsubscribed, 1, "watch unsubscribed on close");

    // Late change events after close never refresh again.
    onChange!();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(refreshCalls, 1);
  });

  test("interval polling refreshes cross-session changes", async () => {
    let refreshCalls = 0;
    const mounted = mountSelector(
      [],
      async () => ({ durable: [], completed: [] }),
      {
        refreshIntervalMs: 40,
        refresh: async () => {
          refreshCalls += 1;
          return {
            liveRuns: [],
            catalog: { durable: [entry("d-from-poll", "paused")], completed: [] },
          };
        },
      },
    );
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 130));
    await flush();

    assert.ok(refreshCalls >= 2, `interval refresh ran (${refreshCalls})`);
    assert.ok(renderText(mounted.component()).includes("paused-workflow"));

    mounted.component().dispose?.();
    await mounted.promise;
    const settledCalls = refreshCalls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(refreshCalls, settledCalls, "interval stops after close");
  });
});
