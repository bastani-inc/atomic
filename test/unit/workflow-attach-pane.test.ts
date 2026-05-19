/**
 * Unit tests for `WorkflowAttachPane`.
 *
 * Verifies:
 *  - Mounts in graph mode by default.
 *  - Pressing Enter on a graph node swaps the interior to stage chat
 *    without remounting the popup.
 *  - Ctrl+D in chat mode swaps back to graph with the same focused
 *    stage id preserved.
 *  - When a `uiStatus.setStatus` surface is provided, attach/detach
 *    flips the `pi-workflows` tag through `<workflow>/<stage>`.
 *
 * cross-ref: src/tui/workflow-attach-pane.ts
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Key } from "@earendil-works/pi-tui";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
  WorkflowAttachPane,
  type AttachUiStatusSurface,
} from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { AgentSession } from "@bastani/atomic";

function setupRun(store: ReturnType<typeof createStore>, runId: string, stages: Array<{ id: string; name: string; status?: "pending" | "running" | "paused" | "completed" }>) {
  store.recordRunStart({
    id: runId,
    name: "test-wf",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  });
  for (const s of stages) {
    store.recordStageStart(runId, {
      id: s.id,
      name: s.name,
      status: s.status ?? "running",
      parentIds: [],
      toolEvents: [],
    });
  }
}

function makeHandle(runId: string, stageId: string): StageControlHandle {
  return {
    runId,
    stageId,
    stageName: `stage-${stageId}`,
    status: "running",
    sessionId: undefined,
    sessionFile: undefined,
    isStreaming: false,
    messages: [] as AgentSession["messages"],
    async ensureAttached() {},
    async prompt() {},
    async steer() {},
    async followUp() {},
    async pause() {},
    async resume() {},
    subscribe() {
      return () => {};
    },
  };
}

describe("WorkflowAttachPane", () => {
  test("starts in graph mode", () => {
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      onClose: () => {},
    });
    assert.equal(pane._mode, "graph");
    assert.equal(pane._hasChatView, false);
    pane.dispose();
  });

  test("Enter on a graph node swaps to stage-chat mode", () => {
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
    const registry = createStageControlRegistry();
    registry.register(makeHandle("run-1", "stage-a"));
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      onClose: () => {},
    });
    // Enter dispatches through the GraphView's handler.
    pane.handleInput(Key.enter);
    assert.equal(pane._mode, "stage-chat");
    assert.equal(pane._lastAttachedStageId, "stage-a");
    assert.equal(pane._hasChatView, true);
    pane.dispose();
  });

  test("slash switcher selection swaps directly to selected stage chat", () => {
    const store = createStore();
    setupRun(store, "run-1", [
      { id: "stage-a", name: "A" },
      { id: "stage-b", name: "B" },
    ]);
    const registry = createStageControlRegistry();
    registry.register(makeHandle("run-1", "stage-a"));
    registry.register(makeHandle("run-1", "stage-b"));
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      onClose: () => {},
    });

    pane.handleInput(Key.slash);
    pane.handleInput(Key.down);
    pane.handleInput(Key.enter);

    assert.equal(pane._mode, "stage-chat");
    assert.equal(pane._lastAttachedStageId, "stage-b");
    assert.equal(pane._hasChatView, true);
    pane.dispose();
  });

  test("Ctrl+D in stage-chat mode swaps back to graph with same stage focused", () => {
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "A" }, { id: "stage-b", name: "B" }]);
    const registry = createStageControlRegistry();
    registry.register(makeHandle("run-1", "stage-a"));
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      onClose: () => {},
    });
    pane.handleInput(Key.enter);
    assert.equal(pane._mode, "stage-chat");
    // Ctrl+D returns to graph.
    pane.handleInput(Key.ctrl("d"));
    assert.equal(pane._mode, "graph");
    assert.equal(pane._hasChatView, false);
    // Stage id is preserved so re-attach lands on the same node.
    assert.equal(pane._lastAttachedStageId, "stage-a");
    pane.dispose();
  });

  test("Ctrl+D in paused stage-chat mode closes the pane", () => {
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "A", status: "paused" }]);
    const registry = createStageControlRegistry();
    registry.register({ ...makeHandle("run-1", "stage-a"), status: "paused" });
    let closed = 0;
    let hidden = 0;
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      onClose: () => {
        closed += 1;
      },
      onHide: () => {
        hidden += 1;
      },
      initialAttachStageId: "stage-a",
    });
    assert.equal(pane._mode, "stage-chat");
    pane.handleInput(Key.ctrl("d"));
    assert.equal(closed, 1);
    assert.equal(hidden, 0);
    assert.equal(pane._mode, "stage-chat");
    pane.dispose();
  });

  test("attach updates pi-workflows status tag with workflow/stage", () => {
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "review-a" }]);
    const registry = createStageControlRegistry();
    registry.register(makeHandle("run-1", "stage-a"));
    const calls: Array<{ key: string; value: string | undefined }> = [];
    const uiStatus: AttachUiStatusSurface = {
      setStatus: (key, value) => calls.push({ key, value }),
    };
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      uiStatus,
      onClose: () => {},
    });
    // Base status: pi-workflows/<workflow>
    assert.equal(calls[0]!.value, "pi-workflows/test-wf");
    pane.handleInput(Key.enter);
    // After attach: pi-workflows/<workflow>/<stage>
    const afterAttach = calls[calls.length - 1]!;
    assert.equal(afterAttach.value, "pi-workflows/test-wf/review-a");
    pane.dispose();
    // After dispose: the tag is cleared so subsequent chat messages
    // don't keep rendering `pi-workflows/...` in their header band.
    const lastCall = calls[calls.length - 1]!;
    assert.equal(lastCall.key, "pi-workflows");
    assert.equal(lastCall.value, undefined);
  });

  test("q kill delegates to graph close while chat gets the notice", () => {
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
    let killedRunId: string | undefined;
    let closed = 0;
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      onKill: (runId) => {
        killedRunId = runId;
        store.removeRun(runId);
      },
      onClose: () => {
        closed += 1;
      },
      getViewportRows: () => 36,
    });

    pane.handleInput("q");

    assert.equal(killedRunId, "run-1");
    assert.equal(closed, 1);
    assert.equal(pane._mode, "graph");
    pane.dispose();
  });

  test("initialAttachStageId opens directly on stage-chat", () => {
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
    const registry = createStageControlRegistry();
    registry.register(makeHandle("run-1", "stage-a"));
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      onClose: () => {},
      initialAttachStageId: "stage-a",
    });
    assert.equal(pane._mode, "stage-chat");
    assert.equal(pane._lastAttachedStageId, "stage-a");
    pane.dispose();
  });

  test("retarget replaces the current run and optional attached stage", () => {
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
    setupRun(store, "run-2", [{ id: "stage-b", name: "B" }]);
    const registry = createStageControlRegistry();
    registry.register(makeHandle("run-1", "stage-a"));
    registry.register(makeHandle("run-2", "stage-b"));
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      onClose: () => {},
    });

    pane.handleInput(Key.enter);
    assert.equal(pane._mode, "stage-chat");
    assert.equal(pane._runId, "run-1");
    assert.equal(pane._lastAttachedStageId, "stage-a");

    pane.retarget("run-2");
    assert.equal(pane._mode, "graph");
    assert.equal(pane._runId, "run-2");
    assert.equal(pane._lastAttachedStageId, null);
    assert.equal(pane._hasChatView, false);

    pane.retarget("run-2", "stage-b");
    assert.equal(pane._mode, "stage-chat");
    assert.equal(pane._runId, "run-2");
    assert.equal(pane._lastAttachedStageId, "stage-b");
    assert.equal(pane._hasChatView, true);
    pane.dispose();
  });

  test("keeps mouse scroll tracking active for graph and stage chat scrolling", () => {
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
    const registry = createStageControlRegistry();
    registry.register(makeHandle("run-1", "stage-a"));
    const mouseTracking: boolean[] = [];
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      onClose: () => {},
      setMouseScrollTracking: (enabled) => mouseTracking.push(enabled),
    });

    assert.deepEqual(mouseTracking, [true]);
    pane.handleInput(Key.enter);
    assert.equal(pane._mode, "stage-chat");
    assert.deepEqual(mouseTracking, [true, true]);
    pane.handleInput(Key.ctrl("d"));
    assert.equal(pane._mode, "graph");
    assert.deepEqual(mouseTracking, [true, true, true]);
    pane.dispose();
    assert.deepEqual(mouseTracking, [true, true, true, false]);
  });

  test("forwards getViewportRows to graph mode", () => {
    // The host provides terminal.rows through `getViewportRows`; the
    // attach pane must thread that through to GraphView so the
    // overlay frame fills the terminal in graph mode.
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      onClose: () => {},
      getViewportRows: () => 50,
    });
    const lines = pane.render(120);
    assert.equal(pane._mode, "graph");
    assert.equal(lines.length, 50);
    pane.dispose();
  });

  test("forwards getViewportRows to stage-chat mode after attach", () => {
    // After Enter on a graph node the attach pane swaps the interior
    // to StageChatView. The viewport accessor must continue to apply
    // so the chat surface keeps filling the terminal.
    const store = createStore();
    setupRun(store, "run-1", [{ id: "stage-a", name: "A" }]);
    const registry = createStageControlRegistry();
    registry.register(makeHandle("run-1", "stage-a"));
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      onClose: () => {},
      getViewportRows: () => 44,
    });
    pane.handleInput(Key.enter);
    assert.equal(pane._mode, "stage-chat");
    const lines = pane.render(120);
    assert.equal(lines.length, 44);
    pane.dispose();
  });
});
