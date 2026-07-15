import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV, type AgentSession } from "@bastani/atomic";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { reconcileDurableResumeShadow } from "../../packages/workflows/src/extension/workflow-resume-shadow.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker, jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import {
  createStageControlRegistry,
  stageControlRegistry,
  type StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { restoreOnSessionStart } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import type { DurableWorkflowStatus } from "../../packages/workflows/src/durable/types.js";

function seedRestoredShadow(
  backend: InMemoryDurableBackend,
  workflowId: string,
  status: Extract<DurableWorkflowStatus, "paused" | "running">,
): void {
  backend.registerWorkflow({
    workflowId,
    name: "restored-workflow",
    inputs: {},
    createdAt: 1,
    status,
    resumable: true,
  });
  backend.recordCheckpoint({
    kind: "tool",
    workflowId,
    checkpointId: `tool:${workflowId}`,
    name: "completed-side-effect",
    argsHash: `hash:${workflowId}`,
    output: "done",
    completedAt: 2,
  });
  restoreOnSessionStart(
    {
      getEntries: () => [{
        id: `run-start:${workflowId}`,
        type: "workflow.run.start",
        payload: { runId: workflowId, name: "restored-workflow", inputs: {}, ts: 1 },
      }],
    },
    { resumeInFlight: "auto", persistRuns: true },
    store,
  );
}

function seedZeroProgressRestoredOrphan(
  backend: InMemoryDurableBackend,
  workflowId: string,
  status: Extract<DurableWorkflowStatus, "paused" | "running">,
): void {
  backend.registerWorkflow({
    workflowId,
    name: "restored-workflow",
    inputs: {},
    createdAt: 1,
    status,
    resumable: true,
  });
  restoreOnSessionStart(
    {
      getEntries: () => [{
        id: `run-start:${workflowId}`,
        type: "workflow.run.start",
        payload: { runId: workflowId, name: "restored-workflow", inputs: {}, ts: 1 },
      }],
    },
    { resumeInFlight: "auto", persistRuns: true },
    store,
  );
}

function resumableRuntime(releaseResumedStage: Promise<void>) {
  const definition = workflow({
    name: "restored-workflow",
    description: "",
    inputs: {},
    outputs: { done: Type.Boolean() },
    run: async (ctx) => {
      await ctx.stage("resumed-stage").prompt("resume");
      return { done: true };
    },
  });
  return createExtensionRuntime({
    definitions: [definition],
    store,
    adapters: {
      prompt: {
        prompt: async () => {
          await releaseResumedStage;
          return "resumed";
        },
      },
    },
  });
}

function liveControl(runId: string): StageControlHandle {
  return {
    runId,
    stageId: "live-stage",
    stageName: "live-stage",
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
    subscribe: () => () => {},
  };
}

beforeEach(() => {
  delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
});

afterEach(async () => {
  delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
  stageControlRegistry.clear();
  for (const runId of jobTracker.runIds()) {
    const entry = jobTracker.get(runId);
    entry?.controller.abort();
    await entry?.promise;
    jobTracker.unregister(runId);
  }
  store.clear();
  setDurableBackend(undefined);
});

describe("gracefully quit durable workflow session restore", () => {
  test.serial.each(["paused", "running"] as const)(
    "slash resume recovers authoritative durable %s shadow with the original workflow id",
    async (durableStatus) => {
      const workflowId = `slash-restored-${durableStatus}`;
      const backend = new InMemoryDurableBackend();
      setDurableBackend(backend);
      seedRestoredShadow(backend, workflowId, durableStatus);
      assert.equal(store.runs().find((run) => run.id === workflowId)?.status, "running");
      assert.equal(jobTracker.has(workflowId), false);
      assert.equal(stageControlRegistry.run(workflowId).stages().length, 0);

      const releaseResumedStage = Promise.withResolvers<void>();
      const runtime = resumableRuntime(releaseResumedStage.promise);
      const info: string[] = [];
      const errors: string[] = [];

      await handleRunControlCommand(
        "resume",
        [workflowId.slice(0, 12)],
        { hasUI: false, ui: { notify: () => undefined } },
        { info: (message) => info.push(message), error: (message) => errors.push(message) },
        {
          pi: {},
          overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
          runtimeForContext: () => runtime,
          ensureWorkflowResourcesLoaded: () => undefined,
        },
      );

      assert.deepEqual(errors, []);
      assert.match(info.join("\n"), /Resuming durable workflow/);
      const resumedJob = jobTracker.get(workflowId);
      assert.ok(resumedJob, "durable resume must dispatch a live job with the original workflow id");
      assert.equal(backend.getWorkflow(workflowId)?.status, "running");
      assert.equal(store.runs().filter((run) => run.id === workflowId).length, 1);

      releaseResumedStage.resolve();
      await resumedJob.promise;
      assert.equal(store.runs().find((run) => run.id === workflowId)?.status, "completed");
    },
  );

  test.serial.each(["paused", "running"] as const)(
    "workflow tool resume recovers authoritative durable %s shadow with the original workflow id",
    async (durableStatus) => {
      const workflowId = `tool-restored-${durableStatus}`;
      const backend = new InMemoryDurableBackend();
      setDurableBackend(backend);
      seedRestoredShadow(backend, workflowId, durableStatus);
      const releaseResumedStage = Promise.withResolvers<void>();
      const runtime = resumableRuntime(releaseResumedStage.promise);
      const execute = makeExecuteWorkflowTool(runtime, () => undefined, () => undefined);

      const result = await execute({ action: "resume", runId: workflowId }, {} as never);

      assert.equal(result.action, "resume");
      assert.equal(result.runId, workflowId);
      assert.equal(result.status, "running");
      assert.match(result.message, /Resuming durable workflow/);
      const resumedJob = jobTracker.get(workflowId);
      assert.ok(resumedJob, "tool resume must dispatch a live job with the original workflow id");
      assert.equal(backend.getWorkflow(workflowId)?.status, "running");
      assert.equal(store.runs().filter((run) => run.id === workflowId).length, 1);

      releaseResumedStage.resolve();
      await resumedJob.promise;
    },
  );

  test.serial.each([
    ["paused", "job"],
    ["running", "job"],
    ["paused", "control"],
    ["running", "control"],
  ] as const)(
    "durable %s snapshot is not a resume shadow while a live %s exists",
    (durableStatus, liveKind) => {
      const workflowId = `live-${durableStatus}-${liveKind}`;
      const backend = new InMemoryDurableBackend();
      backend.registerWorkflow({
        workflowId,
        name: "restored-workflow",
        inputs: {},
        createdAt: 1,
        status: durableStatus,
      });
      const localStore = createStore();
      localStore.recordRunStart({
        id: workflowId,
        name: "restored-workflow",
        inputs: {},
        status: "running",
        stages: [],
        startedAt: 1,
      });
      const jobs = createJobTracker();
      const controls = createStageControlRegistry();
      if (liveKind === "job") {
        jobs.register({ runId: workflowId, controller: new AbortController(), promise: Promise.resolve() });
      } else {
        controls.register(liveControl(workflowId));
      }
      const run = localStore.runs().find((candidate) => candidate.id === workflowId)!;

      assert.equal(reconcileDurableResumeShadow(run, localStore, {
        backend,
        jobs,
        stageControls: controls,
      }), false);
      assert.equal(localStore.runs().find((candidate) => candidate.id === workflowId)?.status, "running");
    },
  );

  test.serial.each(["paused", "running"] as const)(
    "zero-progress durable %s orphan stays unmodified and tool resume is a noop",
    async (durableStatus) => {
      const workflowId = `zero-tool-${durableStatus}`;
      const backend = new InMemoryDurableBackend();
      setDurableBackend(backend);
      seedZeroProgressRestoredOrphan(backend, workflowId, durableStatus);
      const before = structuredClone(store.runs().find((run) => run.id === workflowId));
      assert.ok(before);
      assert.equal(reconcileDurableResumeShadow(before, store, { backend }), false);

      const release = Promise.withResolvers<void>();
      const execute = makeExecuteWorkflowTool(resumableRuntime(release.promise), () => undefined, () => undefined);
      const result = await execute({ action: "resume", runId: workflowId.slice(0, 12) }, {} as never);

      assert.equal(result.action, "resume");
      assert.equal(result.runId, workflowId);
      assert.equal(result.status, "noop");
      assert.match(result.message, /not resumable|no durable progress/i);
      assert.deepEqual(store.runs().find((run) => run.id === workflowId), before);
      assert.equal(backend.getWorkflow(workflowId)?.status, durableStatus);
      assert.equal(jobTracker.has(workflowId), false);
    },
  );

  test.serial.each(["paused", "running"] as const)(
    "zero-progress durable %s orphan stays unmodified through slash resume",
    async (durableStatus) => {
      const workflowId = `zero-slash-${durableStatus}`;
      const backend = new InMemoryDurableBackend();
      setDurableBackend(backend);
      seedZeroProgressRestoredOrphan(backend, workflowId, durableStatus);
      const before = structuredClone(store.runs().find((run) => run.id === workflowId));
      assert.ok(before);
      const release = Promise.withResolvers<void>();
      const info: string[] = [];
      const errors: string[] = [];

      await handleRunControlCommand(
        "resume",
        [workflowId.slice(0, 12)],
        { hasUI: false, ui: { notify: () => undefined } },
        { info: (message) => info.push(message), error: (message) => errors.push(message) },
        {
          pi: {},
          overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
          runtimeForContext: () => resumableRuntime(release.promise),
          ensureWorkflowResourcesLoaded: () => undefined,
        },
      );

      assert.deepEqual(info, []);
      assert.match(errors.join("\n"), /not resumable|no durable progress/i);
      assert.deepEqual(store.runs().find((run) => run.id === workflowId), before);
      assert.equal(backend.getWorkflow(workflowId)?.status, durableStatus);
      assert.equal(jobTracker.has(workflowId), false);
    },
  );
});
