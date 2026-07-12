import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

let tempDir = "";

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "atomic-completed-inspection-")); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

function retainedSession(name: string): string {
  const path = join(tempDir, `${name}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: `${name}-session`, timestamp: new Date().toISOString(), cwd: tempDir }),
    JSON.stringify({ type: "message", id: `${name}-message`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Original workflow request", timestamp: Date.now() } }),
  ].join("\n") + "\n");
  return path;
}

describe("completed workflow inspection", () => {
  test("opens immutable detail and appends follow-up chat without durable re-dispatch", async () => {
    const backend = new InMemoryDurableBackend();
    const store = createStore();
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
});
