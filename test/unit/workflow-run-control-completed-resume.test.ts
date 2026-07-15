import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime, type ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { handleRunControlCommand, type WorkflowRunControlDeps } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { store } from "../../packages/workflows/src/shared/store.js";

let tempDir = "";

beforeEach(() => {
  // The workflows store is a module-level singleton shared across test files in
  // the same bun process; clear leftovers so index/id lookups see only this file's runs.
  store.clear();
  tempDir = mkdtempSync(join(tmpdir(), "atomic-completed-command-"));
});
afterEach(() => {
  setDurableBackend(undefined);
  store.clear();
  rmSync(tempDir, { recursive: true, force: true });
});

function retainedSession(name: string): string {
  const path = join(tempDir, `${name}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: `${name}-session`, timestamp: new Date().toISOString(), cwd: tempDir }),
    JSON.stringify({ type: "message", id: `${name}-message`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `Prior context for ${name}`, timestamp: Date.now() } }),
  ].join("\n") + "\n");
  return path;
}

function registerCompleted(backend: InMemoryDurableBackend, id: string, sessionFile = retainedSession(id)): void {
  backend.registerWorkflow({ workflowId: id, name: `${id}-flow`, inputs: {}, createdAt: 1, status: "completed" });
  backend.recordCheckpoint({
    kind: "stage", workflowId: id, checkpointId: "stage:1", name: "final",
    replayKey: "stage:final:1", output: "ok", sessionFile, completedAt: 2,
  });
}

function commandDeps(runtime: ExtensionRuntime, opened: string[]): WorkflowRunControlDeps {
  return {
    pi: {},
    overlay: { open: (runId) => { if (runId) opened.push(runId); }, toggle: () => undefined, close: () => undefined },
    getPersistence: () => undefined,
    runtimeForContext: () => runtime,
    ensureWorkflowResourcesLoaded: () => undefined,
  };
}

async function resume(target: string, runtime: ExtensionRuntime, opened: string[] = []): Promise<{ messages: string[]; errors: string[] }> {
  const messages: string[] = [];
  const errors: string[] = [];
  await handleRunControlCommand(
    "resume",
    [target],
    { hasUI: true, ui: { notify: () => undefined } },
    { info: (message) => messages.push(message), error: (message) => errors.push(message) },
    commandDeps(runtime, opened),
  );
  return { messages, errors };
}

describe("/workflow resume completed target", () => {
  test("opens a unique completed id prefix without invoking durable resume dispatch", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    registerCompleted(backend, "completed-command-target");
    const baseRuntime = createExtensionRuntime({ store });
    let resumeCalls = 0;
    const runtime: ExtensionRuntime = {
      ...baseRuntime,
      resumeDurableWorkflow(workflowIdOrPrefix, options) {
        resumeCalls += 1;
        return baseRuntime.resumeDurableWorkflow(workflowIdOrPrefix, options);
      },
    };
    const opened: string[] = [];

    const result = await resume("completed-command", runtime, opened);

    assert.equal(resumeCalls, 0);
    assert.deepEqual(opened, ["completed-command-target"]);
    assert.match(result.messages.join("\n"), /read-only inspection and follow-up chat/);
    assert.equal(store.runs().find((run) => run.id === "completed-command-target")?.status, "completed");
    assert.equal(backend.getWorkflow("completed-command-target")?.status, "completed");
  });

  test("opens an exact completed id and reports completed-prefix ambiguity", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    registerCompleted(backend, "completed-exact-alpha");
    registerCompleted(backend, "completed-exact-beta");
    const runtime = createExtensionRuntime({ store });
    const opened: string[] = [];

    const exact = await resume("completed-exact-alpha", runtime, opened);
    store.clear();
    const ambiguous = await resume("completed-exact-", runtime);

    assert.deepEqual(opened, ["completed-exact-alpha"]);
    assert.match(exact.messages.join("\n"), /Opened completed durable workflow/);
    assert.match(ambiguous.errors.join("\n"), /Ambiguous workflow prefix/);
    assert.match(ambiguous.errors.join("\n"), /completed-exact-alpha-flow/);
    assert.match(ambiguous.errors.join("\n"), /completed-exact-beta-flow/);
  });

  test("reports a clear missing target without dispatching completed inspection", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    registerCompleted(backend, "known-completed");

    const result = await resume("missing-workflow", createExtensionRuntime({ store }));

    assert.match(result.errors.join("\n"), /No durable workflow found for id\/prefix: missing-workflow/);
  });

  test("reports a stale completed target instead of dispatching it", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    backend.registerWorkflow({ workflowId: "stale-completed-target", name: "completed-flow", inputs: {}, createdAt: 1, status: "completed", completedCheckpoints: 1 });
    const baseRuntime = createExtensionRuntime({ store });
    let resumeCalls = 0;
    const runtime: ExtensionRuntime = {
      ...baseRuntime,
      resumeDurableWorkflow(workflowIdOrPrefix, options) {
        resumeCalls += 1;
        return baseRuntime.resumeDurableWorkflow(workflowIdOrPrefix, options);
      },
    };

    const result = await resume("stale-completed", runtime);

    assert.equal(resumeCalls, 0);
    assert.match(result.errors.join("\n"), /stale or missing durable checkpoint\/session data/);
  });

  test("does not let a retained completed snapshot bypass authoritative stale checks", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    backend.registerWorkflow({ workflowId: "retained-stale", name: "completed-flow", inputs: {}, createdAt: 1, status: "completed", completedCheckpoints: 1 });
    store.recordRunStart({ id: "retained-stale", name: "completed-flow", inputs: {}, status: "completed", stages: [], startedAt: 1, endedAt: 2, resumable: false });
    const baseRuntime = createExtensionRuntime({ store });
    let resumeCalls = 0;
    const runtime: ExtensionRuntime = { ...baseRuntime, resumeDurableWorkflow(target, options) { resumeCalls += 1; return baseRuntime.resumeDurableWorkflow(target, options); } };
    const opened: string[] = [];

    const result = await resume("retained-stale", runtime, opened);

    assert.equal(resumeCalls, 0);
    assert.deepEqual(opened, []);
    assert.match(result.errors.join("\n"), /stale or missing durable checkpoint\/session data/);
  });

  test("reports ambiguity across live and completed workflow prefixes", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    registerCompleted(backend, "shared-completed");
    store.recordRunStart({ id: "shared-live", name: "live-flow", inputs: {}, status: "paused", stages: [], startedAt: 1, resumable: true });
    const result = await resume("shared-", createExtensionRuntime({ store }));

    assert.match(result.errors.join("\n"), /Ambiguous workflow prefix/);
    assert.match(result.errors.join("\n"), /live-flow/);
    assert.match(result.errors.join("\n"), /shared-completed-flow/);
  });

  test("excludes cancelled, killed, and non-resumable failed locals from prefix resolution", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    registerCompleted(backend, "excluded-completed");
    store.recordRunStart({ id: "excluded-cancelled", name: "cancelled", inputs: {}, status: "cancelled", stages: [], startedAt: 1, endedAt: 2, resumable: false });
    store.recordRunStart({ id: "excluded-killed", name: "killed", inputs: {}, status: "killed", stages: [], startedAt: 1, endedAt: 2, resumable: false });
    store.recordRunStart({ id: "excluded-failed", name: "failed", inputs: {}, status: "failed", stages: [], startedAt: 1, endedAt: 2, resumable: false });
    const opened: string[] = [];

    const result = await resume("excluded-", createExtensionRuntime({ store }), opened);

    assert.equal(result.errors.length, 0);
    assert.deepEqual(opened, ["excluded-completed"]);
  });

  test("keeps quit shadows on the durable resume path", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    backend.registerWorkflow({ workflowId: "quit-shadow", name: "quit-flow", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    store.recordRunStart({ id: "quit-shadow", name: "quit-flow", inputs: {}, status: "running", stages: [], startedAt: 1, endedAt: 2, exitReason: "quit", resumable: true });
    const baseRuntime = createExtensionRuntime({ store });
    let durableResumeCalls = 0;
    const runtime: ExtensionRuntime = {
      ...baseRuntime,
      resumeDurableWorkflow() {
        durableResumeCalls += 1;
        return { ok: true, runId: "quit-shadow", workflowId: "quit-shadow", name: "quit-flow", message: "resumed quit shadow" };
      },
    };

    const result = await resume("quit-shadow", runtime);

    assert.equal(durableResumeCalls, 1);
    assert.match(result.messages.join("\n"), /resumed quit shadow/);
  });

  for (const status of ["running", "failed", "blocked"] as const) {
    test(`keeps durable ${status} targets on the durable resume path`, async () => {
      const backend = new InMemoryDurableBackend();
      setDurableBackend(backend);
      const id = `durable-${status}`;
      const entry = { workflowId: id, name: `${status}-flow`, status, completedCheckpoints: 1, pendingPrompts: 0, createdAt: 1, updatedAt: 2, resumable: true };
      let resumeCalls = 0;
      const runtime = {
        registry: { has: () => true },
        prepareDurableResumable: async () => [entry],
        prepareCompletedDurable: async () => [],
        resumeDurableWorkflow: () => {
          resumeCalls += 1;
          return { ok: true as const, runId: id, workflowId: id, name: entry.name, message: `resumed ${status}` };
        },
      } as unknown as ExtensionRuntime;

      const result = await resume(id, runtime);

      assert.equal(resumeCalls, 1);
      assert.match(result.messages.join("\n"), new RegExp(`resumed ${status}`));
    });
  }

  test("keeps exact full live ids on the existing paused resume path without listing completed durable runs", async () => {
    const backend = new InMemoryDurableBackend();
    let completedCatalogReads = 0;
    const listCompletedWorkflows = backend.listCompletedWorkflows.bind(backend);
    backend.listCompletedWorkflows = () => {
      completedCatalogReads += 1;
      return listCompletedWorkflows();
    };
    setDurableBackend(backend);
    registerCompleted(backend, "exact-live-other-completed");
    store.recordRunStart({ id: "exact-live", name: "live-flow", inputs: {}, status: "paused", stages: [], startedAt: 1, resumable: true });
    const opened: string[] = [];

    const result = await resume("exact-live", createExtensionRuntime({ store }), opened);

    assert.equal(result.errors.length, 0);
    assert.equal(store.runs().find((run) => run.id === "exact-live")?.status, "running");
    assert.match(result.messages.join("\n"), /Resumed run exact-li/);
    assert.equal(completedCatalogReads, 0, "an exact live run must bypass durable completed-catalog enumeration");
  });

  test("keeps recoverable failed and active-running explicit behavior unchanged", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    store.recordRunStart({ id: "failed-live", name: "failed-flow", inputs: {}, status: "failed", stages: [], startedAt: 1, endedAt: 2, resumable: true });
    store.recordRunStart({ id: "running-live", name: "running-flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
    const baseRuntime = createExtensionRuntime({ store });
    let failedResumeCalls = 0;
    const runtime: ExtensionRuntime = {
      ...baseRuntime,
      resumeFailedRun() {
        failedResumeCalls += 1;
        return { ok: true, runId: "continued-run", sourceRunId: "failed-live", resumeFromStageId: "failed-stage", message: "continued failed workflow" };
      },
    };

    const failedResult = await resume("failed-live", runtime);
    const runningResult = await resume("running-live", runtime);

    assert.equal(failedResumeCalls, 1);
    assert.match(failedResult.messages.join("\n"), /continued failed workflow/);
    assert.match(runningResult.errors.join("\n"), /already running.*connect/i);
  });
});
