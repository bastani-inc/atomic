import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV, type AgentSession } from "@bastani/atomic";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import {
  stageControlRegistry,
  type StageControlHandle,
  type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";

function seedPartialRun(runId: string): InMemoryDurableBackend {
  const backend = new InMemoryDurableBackend();
  setDurableBackend(backend);
  store.recordRunStart({ id: runId, name: "partial", inputs: {}, status: "running", stages: [], startedAt: 1 });
  for (const stageId of ["resume-ok", "resume-fail"]) {
    store.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
    store.recordStagePaused(runId, stageId);
  }
  store.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
  backend.registerWorkflow({ workflowId: runId, name: "partial", inputs: {}, createdAt: 1, status: "paused" });
  backend.recordCheckpoint({
    kind: "tool", workflowId: runId, checkpointId: "progress", name: "progress",
    argsHash: "progress", output: "done", completedAt: 2,
  });
  registerHandle(runId, "resume-ok", async (setStatus) => {
    setStatus("running");
    store.recordStageResumed(runId, "resume-ok");
    store.recordRunResumed(runId);
  });
  registerHandle(runId, "resume-fail", async () => {
    throw new Error("surface resume failed");
  });
  return backend;
}

function registerHandle(
  runId: string,
  stageId: string,
  resume: (setStatus: (status: StageControlStatus) => void) => Promise<void>,
): void {
  let status: StageControlStatus = "paused";
  const handle: StageControlHandle = {
    runId,
    stageId,
    stageName: stageId,
    get status() { return status; },
    sessionId: undefined,
    sessionFile: undefined,
    isStreaming: false,
    messages: [] as AgentSession["messages"],
    async ensureAttached() {},
    async prompt() {},
    async steer() {},
    async followUp() {},
    async pause() { status = "paused"; },
    async resume() { await resume((next) => { status = next; }); },
    subscribe: () => () => {},
  };
  stageControlRegistry.register(handle);
}

beforeEach(() => {
  delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
});

afterEach(() => {
  delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
  stageControlRegistry.clear();
  store.clear();
  setDurableBackend(undefined);
});

describe("partial resume command surfaces", () => {
  test.serial("workflow tool preserves result identity and reports partial failure", async () => {
    const runId = "tool-partial-resume";
    const backend = seedPartialRun(runId);
    const runtime = createExtensionRuntime({ definitions: [], store });
    const execute = makeExecuteWorkflowTool(runtime, () => undefined, () => undefined);

    const result = await execute({ action: "resume", runId }, {} as never);

    assert.deepEqual(Object.keys(result).sort(), ["action", "message", "runId", "status"]);
    assert.equal(result.action, "resume");
    assert.equal(result.runId, runId);
    assert.equal(result.status, "partial");
    assert.match(result.message, /partially resumed/i);
    assert.match(result.message, new RegExp(`${runId}/resume-fail.*surface resume failed`));
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
    assert.equal(backend.getWorkflow(runId)?.status, "running");
  });

  test.serial("workflow tool reports durable resume failure as partial when a stage is running", async () => {
    class ThrowRunningBackend extends InMemoryDurableBackend {
      override setWorkflowStatus(
        workflowId: string,
        status: Parameters<InMemoryDurableBackend["setWorkflowStatus"]>[1],
        pendingPrompts?: number,
        resumable?: boolean,
      ): void {
        if (status === "running") throw new Error("durable running write failed");
        super.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
      }
    }
    const runId = "tool-durable-resume-failure";
    const backend = new ThrowRunningBackend();
    setDurableBackend(backend);
    store.recordRunStart({ id: runId, name: "partial", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart(runId, { id: "only", name: "only", status: "running", parentIds: [], toolEvents: [] });
    store.recordStagePaused(runId, "only");
    store.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
    backend.registerWorkflow({ workflowId: runId, name: "partial", inputs: {}, createdAt: 1, status: "paused" });
    backend.recordCheckpoint({
      kind: "tool", workflowId: runId, checkpointId: "progress", name: "progress",
      argsHash: "progress", output: "done", completedAt: 2,
    });
    registerHandle(runId, "only", async (setStatus) => {
      setStatus("running");
      store.recordStageResumed(runId, "only");
      store.recordRunResumed(runId);
    });
    const runtime = createExtensionRuntime({ definitions: [], store });
    const execute = makeExecuteWorkflowTool(runtime, () => undefined, () => undefined);

    const result = await execute({ action: "resume", runId }, {} as never);

    assert.deepEqual(Object.keys(result).sort(), ["action", "message", "runId", "status"]);
    assert.equal(result.action, "resume");
    assert.equal(result.status, "partial");
    assert.match(result.message, /durable running write failed/);
    assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.status, "running");
  });

  test.serial("workflow tool retries transient durable reconciliation on a later resume request", async () => {
    class TransientRunningBackend extends InMemoryDurableBackend {
      runningAttempts = 0;
      override setWorkflowStatus(
        workflowId: string,
        status: Parameters<InMemoryDurableBackend["setWorkflowStatus"]>[1],
        pendingPrompts?: number,
        resumable?: boolean,
      ): void {
        if (status === "running" && ++this.runningAttempts === 1) throw new Error("transient public durable failure");
        super.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
      }
    }
    const runId = "tool-durable-resume-retry";
    const backend = new TransientRunningBackend();
    setDurableBackend(backend);
    store.recordRunStart({ id: runId, name: "partial", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart(runId, { id: "only", name: "only", status: "running", parentIds: [], toolEvents: [] });
    store.recordStagePaused(runId, "only");
    store.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
    backend.registerWorkflow({ workflowId: runId, name: "partial", inputs: {}, createdAt: 1, status: "paused" });
    backend.recordCheckpoint({
      kind: "tool", workflowId: runId, checkpointId: "progress", name: "progress",
      argsHash: "progress", output: "done", completedAt: 2,
    });
    registerHandle(runId, "only", async (setStatus) => {
      setStatus("running");
      store.recordStageResumed(runId, "only");
      store.recordRunResumed(runId);
    });
    const runtime = createExtensionRuntime({ definitions: [], store });
    const execute = makeExecuteWorkflowTool(runtime, () => undefined, () => undefined);

    const first = await execute({ action: "resume", runId }, {} as never);
    assert.equal(first.action, "resume");
    assert.equal(first.runId, runId);
    assert.equal(first.status, "partial");
    assert.match(first.message, /transient public durable failure/);
    assert.equal(backend.getWorkflow(runId)?.status, "paused");

    const second = await execute({ action: "resume", runId }, {} as never);
    assert.equal(second.action, "resume");
    assert.equal(second.runId, runId);
    assert.equal(second.status, "ok");
    assert.equal(backend.runningAttempts, 2);
    assert.equal(backend.getWorkflow(runId)?.status, "running");
  });

  test.serial("no-target slash selector reports resume rejection through the reporter", async () => {
    const runId = "slash-picker-resume-failure";
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    store.recordRunStart({ id: runId, name: "picker", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordStageStart(runId, { id: "only", name: "only", status: "running", parentIds: [], toolEvents: [] });
    store.recordStagePaused(runId, "only");
    store.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
    backend.registerWorkflow({ workflowId: runId, name: "picker", inputs: {}, createdAt: 1, status: "paused" });
    backend.recordCheckpoint({
      kind: "tool", workflowId: runId, checkpointId: "progress", name: "progress",
      argsHash: "progress", output: "done", completedAt: 2,
    });
    registerHandle(runId, "only", async () => { throw new Error("picker resume rejected"); });
    const runtime = createExtensionRuntime({ definitions: [], store });
    const info: string[] = [];
    const errors: string[] = [];
    // Host session-picker seam: auto-select the first (live) row shortly
    // after open, mirroring a user hitting Enter on the seeded top row.
    const hostSessionPicker = (request: { sessions: Array<{ path: string }> }) => ({
      result: new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve(request.sessions[0]?.path), 10);
      }),
      update: () => undefined,
      error: () => undefined,
      close: () => undefined,
    });

    await handleRunControlCommand(
      "resume",
      [],
      { hasUI: true, ui: { notify: () => undefined, custom: () => undefined, hostSessionPicker } } as never,
      { info: (message) => info.push(message), error: (message) => errors.push(message) },
      {
        pi: {},
        overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
        runtimeForContext: () => runtime,
        ensureWorkflowResourcesLoaded: () => undefined,
      },
    );

    assert.deepEqual(info, []);
    assert.match(errors.join("\n"), /Failed to resume run.*picker resume rejected/);
  });

  test.serial("slash resume reports the same partial failure instead of success or noop", async () => {
    const runId = "slash-partial-resume";
    const backend = seedPartialRun(runId);
    const runtime = createExtensionRuntime({ definitions: [], store });
    const info: string[] = [];
    const errors: string[] = [];

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

    assert.deepEqual(info, []);
    assert.match(errors.join("\n"), /partially resumed/i);
    assert.match(errors.join("\n"), new RegExp(`${runId}/resume-fail.*surface resume failed`));
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
    assert.equal(backend.getWorkflow(runId)?.status, "running");
  });
});
