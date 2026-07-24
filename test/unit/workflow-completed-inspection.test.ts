import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import {
  createWorkflowLifecycleNotificationState,
  installWorkflowLifecycleNotifications,
  seedWorkflowLifecycleNotificationState,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

let tempDir = "";

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "atomic-completed-inspection-")); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

function retainedSession(name: string, internal = false): string {
  const path = join(tempDir, `${name}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({
      type: "session",
      version: 3,
      id: `${name}-session`,
      timestamp: new Date().toISOString(),
      cwd: tempDir,
      ...(internal ? { internal: true, workflow: { runId: name, stageId: "final", stageName: "final" } } : {}),
    }),
    JSON.stringify({ type: "message", id: `${name}-message`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Original workflow request", timestamp: Date.now() } }),
  ].join("\n") + "\n");
  return path;
}
function lifecycleRestoration(store: ReturnType<typeof createStore>) {
  const state = createWorkflowLifecycleNotificationState();
  const sent: Array<{ readonly options?: { readonly deliverAs?: string } }> = [];
  const unsubscribe = installWorkflowLifecycleNotifications({
    store,
    state,
    config: { enabled: true, notifyOn: ["completed", "failed"] },
    sendMessage(_message, options) { sent.push({ options }); },
  });
  return {
    sent,
    unsubscribe,
    beforeRestore(snapshots: readonly RunSnapshot[]) {
      seedWorkflowLifecycleNotificationState(state, { ...store.snapshot(), runs: snapshots });
    },
  };
}


describe("completed workflow inspection", () => {
  test("opens immutable detail and appends follow-up chat without durable re-dispatch", async () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const lifecycle = lifecycleRestoration(store);
    const registry = createStageControlRegistry();
    const sessionFile = retainedSession("completed-inspection");
    const promptCalls: string[] = [];
    const session: StageSessionRuntime = {
      ...mockSession(),
      sessionFile,
      async prompt(text: string) { promptCalls.push(text); },
    };
    backend.registerWorkflow({
      workflowId: "completed-inspection",
      name: "completed-flow",
      inputs: { topic: "done" },
      createdAt: 1,
      updatedAt: 3,
      status: "completed",
    });
    backend.recordCheckpoint({
      kind: "stage",
      workflowId: "completed-inspection",
      checkpointId: "stage:1",
      name: "final",
      replayKey: "stage:final:1",
      output: "done",
      sessionFile,
      completedAt: 2,
    });

    let sessionCreates = 0;
    let restoredMessageCount = 0;
    const opened = openCompletedDurableWorkflow("completed-ins", {
      durableBackend: backend,
      store,
      beforeRestore: lifecycle.beforeRestore,
      stageControlRegistry: registry,
      adapters: {
        agentSession: {
          async create(options) {
            restoredMessageCount = options.sessionManager?.getEntries().length ?? 0;
            sessionCreates += 1;
            return session;
          },
        },
      },
      cwd: tempDir,
    });

    assert.equal(opened.ok, true);
    assert.equal(store.runs()[0]?.status, "completed");
    assert.equal(backend.getWorkflow("completed-inspection")?.status, "completed");
    const handle = registry.get("completed-inspection", "completed-stage-1");
    assert.ok(handle);
    assert.deepEqual(registry.run("completed-inspection").stages(), []);
    await handle.prompt("What should I do next?");
    assert.equal(sessionCreates, 1);
    assert.equal(restoredMessageCount, 1);
    assert.deepEqual(promptCalls, ["What should I do next?"]);
    assert.equal(store.runs()[0]?.status, "completed");
    assert.equal(backend.getWorkflow("completed-inspection")?.status, "completed");
    assert.deepEqual(lifecycle.sent, []);
    lifecycle.unsubscribe();
  });

  test("refuses to replace an active run with the same id", () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const sessionFile = retainedSession("same-id");
    backend.registerWorkflow({ workflowId: "same-id", name: "completed-flow", inputs: {}, createdAt: 1, status: "completed" });
    backend.recordCheckpoint({ kind: "stage", workflowId: "same-id", checkpointId: "stage:1", name: "final", replayKey: "stage:final:1", sessionFile, completedAt: 2 });
    store.recordRunStart({ id: "same-id", name: "active", inputs: {}, status: "running", stages: [], startedAt: 1 });

    const opened = openCompletedDurableWorkflow("same-id", { durableBackend: backend, store });
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.reason, "active");
    assert.equal(store.runs()[0]?.status, "running");
  });

  test("replaces a retained completed snapshot with authoritative durable detail", () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const sessionFile = retainedSession("authoritative");
    backend.registerWorkflow({ workflowId: "authoritative", name: "durable-name", inputs: {}, createdAt: 1, status: "completed" });
    backend.recordCheckpoint({
      kind: "stage", workflowId: "authoritative", checkpointId: "stage:1", name: "durable-stage",
      replayKey: "stage:durable:1", output: "durable result", sessionFile, completedAt: 2,
    });
    store.recordRunStart({
      id: "authoritative", name: "stale-local-name", inputs: {}, status: "completed",
      stages: [], startedAt: 1, endedAt: 2, resumable: false,
    });

    const opened = openCompletedDurableWorkflow("authoritative", { durableBackend: backend, store });

    assert.equal(opened.ok, true);
    assert.equal(store.runs()[0]?.name, "durable-name");
    assert.equal(store.runs()[0]?.stages[0]?.name, "durable-stage");
    assert.equal(store.runs()[0]?.stages[0]?.sessionFile, sessionFile);
  });

  test("refreshes a retained chat handle when authoritative transcript detail changes", () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const lifecycle = lifecycleRestoration(store);
    const registry = createStageControlRegistry();
    const firstSessionFile = retainedSession("first-authoritative");
    const secondSessionFile = retainedSession("second-authoritative");
    backend.registerWorkflow({
      workflowId: "refresh-chat", name: "completed-flow", inputs: {}, createdAt: 1, status: "completed",
    });
    backend.recordCheckpoint({
      kind: "stage", workflowId: "refresh-chat", checkpointId: "stage:1", name: "final",
      replayKey: "stage:final:1", sessionFile: firstSessionFile, completedAt: 2,
    });
    const deps = {
      durableBackend: backend,
      store,
      stageControlRegistry: registry,
      beforeRestore: lifecycle.beforeRestore,
      adapters: { agentSession: { async create() { return mockSession(); } } },
    };

    assert.equal(openCompletedDurableWorkflow("refresh-chat", deps).ok, true);
    const firstHandle = registry.get("refresh-chat", "completed-stage-1");
    assert.equal(firstHandle?.sessionFile, firstSessionFile);
    backend.recordCheckpoint({
      kind: "stage", workflowId: "refresh-chat", checkpointId: "stage:2", name: "final",
      replayKey: "stage:final:1", sessionFile: secondSessionFile, completedAt: 3,
    });

    assert.equal(openCompletedDurableWorkflow("refresh-chat", deps).ok, true);
    assert.equal(firstHandle?.isDisposed, true);
    assert.equal(registry.get("refresh-chat", "completed-stage-1")?.sessionFile, secondSessionFile);
    assert.deepEqual(lifecycle.sent, []);
    lifecycle.unsubscribe();
  });

  test("removes a retained chat handle when its transcript becomes invalid", () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const registry = createStageControlRegistry();
    const invalidatedSessionFile = retainedSession("invalidated-stage");
    const retainedSessionFile = retainedSession("still-retained-stage");
    backend.registerWorkflow({
      workflowId: "invalidate-chat", name: "completed-flow", inputs: {}, createdAt: 1, status: "completed",
    });
    backend.recordCheckpoint({
      kind: "stage", workflowId: "invalidate-chat", checkpointId: "stage:1", name: "first",
      replayKey: "stage:first:1", sessionFile: invalidatedSessionFile, completedAt: 2,
    });
    backend.recordCheckpoint({
      kind: "stage", workflowId: "invalidate-chat", checkpointId: "stage:2", name: "second",
      replayKey: "stage:second:1", sessionFile: retainedSessionFile, completedAt: 3,
    });
    const deps = {
      durableBackend: backend,
      store,
      stageControlRegistry: registry,
      adapters: { agentSession: { async create() { return mockSession(); } } },
    };

    assert.equal(openCompletedDurableWorkflow("invalidate-chat", deps).ok, true);
    const invalidatedHandle = registry.get("invalidate-chat", "completed-stage-1");
    assert.ok(invalidatedHandle);
    rmSync(invalidatedSessionFile);

    assert.equal(openCompletedDurableWorkflow("invalidate-chat", deps).ok, true);
    assert.equal(invalidatedHandle.isDisposed, true);
    assert.equal(registry.get("invalidate-chat", "completed-stage-1"), undefined);
    assert.equal(registry.get("invalidate-chat", "completed-stage-2")?.sessionFile, retainedSessionFile);
  });

  test("opens a retained internal stage transcript without exposing it in ordinary history", async () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const internalSessionFile = retainedSession("internal-completed", true);
    retainedSession("regular-history");
    backend.registerWorkflow({
      workflowId: "internal-completed", name: "completed-flow", inputs: {}, createdAt: 1, status: "completed",
    });
    backend.recordCheckpoint({
      kind: "stage", workflowId: "internal-completed", checkpointId: "stage:1", name: "final",
      replayKey: "stage:final:1", sessionFile: internalSessionFile, completedAt: 2,
    });

    assert.equal(openCompletedDurableWorkflow("internal-completed", { durableBackend: backend, store }).ok, true);
    assert.equal(store.runs()[0]?.stages[0]?.sessionFile, internalSessionFile);
    assert.deepEqual((await SessionManager.list(tempDir, tempDir)).map((session) => session.id), ["regular-history-session"]);
  });

  test("opens a tool-only run as a read-only graph without promising chat", () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const registry = createStageControlRegistry();
    backend.registerWorkflow({
      workflowId: "completed-tool-only", name: "tool-only", inputs: {}, createdAt: 1, status: "completed",
    });
    backend.recordCheckpoint({
      kind: "tool", workflowId: "completed-tool-only", checkpointId: "tool:publish", name: "publish",
      argsHash: "publish-hash", output: "done", completedAt: 2,
    });

    const opened = openCompletedDurableWorkflow("completed-tool", {
      durableBackend: backend,
      store,
      stageControlRegistry: registry,
      adapters: { agentSession: { async create() { return mockSession(); } } },
    });

    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.match(opened.message, /read-only inspection/);
    assert.doesNotMatch(opened.message, /follow-up chat/);
    assert.deepEqual(registry.forRun("completed-tool-only"), []);
    assert.deepEqual(store.runs()[0]?.toolNodes?.map((tool) => tool.name), ["publish"]);
  });


  test("restores nested completed snapshots without lifecycle delivery", () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const lifecycle = lifecycleRestoration(store);
    const runId = "silent-nested-root";
    const childRunId = "silent-nested-child";
    backend.registerWorkflow({
      workflowId: runId, name: "nested root", inputs: {}, createdAt: 1, updatedAt: 4, status: "completed",
    });
    backend.recordCheckpoint({
      kind: "stage", workflowId: runId, checkpointId: "boundary", name: "workflow:nested child", replayKey: "boundary",
      output: { workflow: "nested child", runId: childRunId, status: "completed", exited: false, outputs: {} },
      completedAt: 3,
      topology: {
        version: 1, stageId: "boundary", parentIds: [],
        run: { runId, runName: "nested root" },
      },
    });
    backend.recordCheckpoint({
      kind: "tool", workflowId: runId, checkpointId: "child-tool", name: "nested publish", argsHash: "nested-publish",
      output: "done", completedAt: 2,
      topology: {
        version: 1, nodeId: "nested-tool-node", ordinal: 1, order: 1, parentIds: [], endedAt: 2,
        run: { runId: childRunId, runName: "nested child", parentRunId: runId, parentStageId: "boundary", rootRunId: runId },
      },
    });

    const opened = openCompletedDurableWorkflow("silent-nested", {
      durableBackend: backend, store, beforeRestore: lifecycle.beforeRestore,
    });
    lifecycle.unsubscribe();

    assert.equal(opened.ok, true);
    assert.deepEqual(store.runs().map((run) => run.id).sort(), [childRunId, runId].sort());
    assert.equal(store.runs().find((run) => run.id === childRunId)?.toolNodes?.[0]?.name, "nested publish");
    assert.deepEqual(lifecycle.sent, []);
  });
  test("historical tool-only restoration is lifecycle-silent", () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const sent: unknown[] = [];
    const unsubscribe = installWorkflowLifecycleNotifications({
      store,
      state,
      config: { enabled: true, notifyOn: ["completed", "failed"] },
      sendMessage(message, options) { sent.push({ message, options }); },
    });
    backend.registerWorkflow({
      workflowId: "silent-tool-only", name: "silent tool", inputs: {}, createdAt: 1, updatedAt: 3, status: "completed",
    });
    backend.recordCheckpoint({
      kind: "tool", workflowId: "silent-tool-only", checkpointId: "tool:publish", name: "publish",
      argsHash: "publish-hash", output: "done", completedAt: 2,
    });

    const opened = openCompletedDurableWorkflow("silent-tool", {
      durableBackend: backend,
      store,
      beforeRestore(snapshots) {
        seedWorkflowLifecycleNotificationState(state, { ...store.snapshot(), runs: snapshots });
      },
    });
    unsubscribe();

    assert.equal(opened.ok, true);
    assert.deepEqual(store.runs()[0]?.toolNodes?.map((node) => node.name), ["publish"]);
    assert.deepEqual(sent, []);
  });

  test("completed inspection does not duplicate an already delivered live notice", () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
    const state = createWorkflowLifecycleNotificationState();
    const sent: unknown[] = [];
    const unsubscribe = installWorkflowLifecycleNotifications({
      store,
      state,
      seedExisting: false,
      config: { enabled: true, notifyOn: ["completed"] },
      sendMessage(message, options) { sent.push({ message, options }); },
    });
    store.recordRunStart({ id: "live-then-inspect", name: "live tool", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordRunEnd("live-then-inspect", "completed", {});
    assert.equal(sent.length, 1);
    backend.registerWorkflow({
      workflowId: "live-then-inspect", name: "live tool", inputs: {}, createdAt: 1, updatedAt: 3, status: "completed",
    });
    backend.recordCheckpoint({
      kind: "tool", workflowId: "live-then-inspect", checkpointId: "tool:done", name: "done",
      argsHash: "done-hash", output: true, completedAt: 2,
    });

    const opened = openCompletedDurableWorkflow("live-then", {
      durableBackend: backend,
      store,
      beforeRestore(snapshots) {
        seedWorkflowLifecycleNotificationState(state, { ...store.snapshot(), runs: snapshots });
      },
    });
    unsubscribe();

    assert.equal(opened.ok, true);
    assert.equal(sent.length, 1);
  });
});
