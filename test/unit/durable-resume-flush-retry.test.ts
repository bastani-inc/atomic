import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import {
  createStageControlRegistry,
  stageControlRegistry,
  type StageControlRegistry,
  type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore, store, type Store } from "../../packages/workflows/src/shared/store.js";

class FlushTrackingBackend extends InMemoryDurableBackend {
  flushCalls = 0;
  durableStatus = "paused";

  constructor(private readonly failures: number) { super(); }

  async flush(): Promise<void> {
    this.flushCalls += 1;
    if (this.flushCalls <= this.failures) throw new Error("transient durable flush failure");
    this.durableStatus = this.getWorkflow("flush-retry")?.status ?? "missing";
  }
}

function seedPausedRun(
  runId: string,
  backend: FlushTrackingBackend,
  activeStore: Store,
  registry: StageControlRegistry,
): void {
  activeStore.recordRunStart({ id: runId, name: runId, inputs: {}, status: "running", stages: [], startedAt: 1 });
  activeStore.recordStageStart(runId, { id: "only", name: "only", status: "running", parentIds: [], toolEvents: [] });
  activeStore.recordStagePaused(runId, "only");
  activeStore.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
  backend.registerWorkflow({ workflowId: runId, name: runId, inputs: {}, createdAt: 1, status: "paused" });
  backend.recordCheckpoint({
    kind: "tool", workflowId: runId, checkpointId: "progress", name: "progress",
    argsHash: "progress", output: "done", completedAt: 2,
  });
  let status: StageControlStatus = "paused";
  registry.register({
    runId,
    stageId: "only",
    stageName: "only",
    get status() { return status; },
    sessionId: undefined,
    sessionFile: undefined,
    isStreaming: false,
    messages: [],
    async ensureAttached() {},
    async prompt() {},
    async steer() {},
    async followUp() {},
    async pause() {},
    async resume() {
      status = "running";
      activeStore.recordStageResumed(runId, "only");
      activeStore.recordRunResumed(runId);
    },
    subscribe: () => () => {},
  });
}

afterEach(() => {
  delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
  stageControlRegistry.clear();
  store.clear();
  setDurableBackend(undefined);
});

describe("durable-running asynchronous flush retry", () => {
  delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
  test("primitive retries a transient failed flush after local state is already running", async () => {
    const runId = "flush-retry";
    const backend = new FlushTrackingBackend(1);
    const activeStore = createStore();
    const registry = createStageControlRegistry();
    seedPausedRun(runId, backend, activeStore, registry);
    setDurableBackend(backend);

    const first = await resumeRun(runId, { store: activeStore, stageControlRegistry: registry });
    assert.equal(first.ok && first.mode, "partial");
    assert.equal(backend.getWorkflow(runId)?.status, "running");
    assert.equal(backend.durableStatus, "paused");

    const second = await resumeRun(runId, { store: activeStore, stageControlRegistry: registry });
    assert.equal(second.ok && second.mode, "snapshot");
    assert.equal(backend.flushCalls, 2);
    assert.equal(backend.durableStatus, "running");
  });

  test("primitive keeps reporting partial while the durable flush continues failing", async () => {
    const runId = "flush-retry";
    const backend = new FlushTrackingBackend(Number.POSITIVE_INFINITY);
    const activeStore = createStore();
    const registry = createStageControlRegistry();
    seedPausedRun(runId, backend, activeStore, registry);
    setDurableBackend(backend);

    const first = await resumeRun(runId, { store: activeStore, stageControlRegistry: registry });
    const second = await resumeRun(runId, { store: activeStore, stageControlRegistry: registry });
    assert.equal(first.ok && first.mode, "partial");
    assert.equal(second.ok && second.mode, "partial");
    if (second.ok) assert.match(second.message ?? "", /transient durable flush failure/);
    assert.equal(backend.flushCalls, 2);
    assert.equal(backend.durableStatus, "paused");
  });

  test.serial("workflow tool retries a pending durable transition instead of reporting snapshot success", async () => {
    const runId = "flush-retry";
    const backend = new FlushTrackingBackend(1);
    setDurableBackend(backend);
    seedPausedRun(runId, backend, store, stageControlRegistry);
    const runtime = createExtensionRuntime({ definitions: [], store });
    const execute = makeExecuteWorkflowTool(runtime, () => undefined, () => undefined);

    const first = await execute({ action: "resume", runId }, {} as never);
    const second = await execute({ action: "resume", runId }, {} as never);
    if (first.action !== "resume" || second.action !== "resume") assert.fail("expected resume results");
    assert.equal(first.status, "partial");
    assert.equal(second.status, "ok");
    assert.equal(backend.flushCalls, 2);
    assert.equal(backend.durableStatus, "running");
  });

  test.serial("slash resume retries a pending durable transition instead of saying already running", async () => {
    const runId = "flush-retry";
    const backend = new FlushTrackingBackend(1);
    setDurableBackend(backend);
    seedPausedRun(runId, backend, store, stageControlRegistry);
    const runtime = createExtensionRuntime({ definitions: [], store });
    const info: string[] = [];
    const errors: string[] = [];
    const invoke = async (): Promise<void> => {
      await handleRunControlCommand(
        "resume",
        [runId],
        { hasUI: false, ui: { notify: () => undefined } },
        { info: (message) => info.push(message), error: (message) => errors.push(message) },
        {
          pi: {},
          overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
          runtimeForContext: () => runtime,
          ensureWorkflowResourcesLoaded: () => undefined,
        },
      );
    };

    await invoke();
    assert.match(errors.join("\n"), /transient durable flush failure/);
    errors.length = 0;
    await invoke();
    assert.doesNotMatch(errors.join("\n"), /already running/);
    assert.equal(backend.flushCalls, 2);
    assert.equal(backend.durableStatus, "running");
    assert.ok(info.length > 0);
  });
});
