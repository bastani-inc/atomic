import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run as executeWorkflow } from "../../packages/workflows/src/runs/foreground/executor.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStageControlRegistry, stageControlRegistry, type StageControlHandle, type StageControlStatus } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore, store as singletonStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { buildCtx, installSlashDispatchTestHooks, registerWorkflowCommand } from "./slash-dispatch-utils.js";

function handle(input: {
  readonly runId: string;
  readonly stageId: string;
  readonly status: () => StageControlStatus;
  readonly pause?: () => Promise<void>;
  readonly resume?: () => Promise<void>;
}): StageControlHandle {
  return {
    runId: input.runId,
    stageId: input.stageId,
    stageName: input.stageId,
    get status() { return input.status(); },
    sessionId: undefined,
    sessionFile: undefined,
    isStreaming: false,
    messages: [] as AgentSession["messages"],
    async ensureAttached() {},
    async prompt() {},
    async steer() {},
    async followUp() {},
    pause: input.pause ?? (async () => {}),
    resume: input.resume ?? (async () => {}),
    subscribe: () => () => {},
  };
}

function seedNested(
  targetStore: ReturnType<typeof createStore>,
  backend: InMemoryDurableBackend,
  rootId: string,
  childId: string,
  stageIds: readonly string[],
): void {
  targetStore.recordRunStart({ id: rootId, name: "root", inputs: {}, status: "running", stages: [], startedAt: 1 });
  targetStore.recordStageStart(rootId, {
    id: "child-boundary",
    name: "workflow:child",
    status: "running",
    parentIds: [],
    toolEvents: [],
    workflowChildRun: { alias: "child", workflow: "child", runId: childId },
  });
  targetStore.recordRunStart({ id: childId, name: "child", inputs: {}, status: "running", stages: [], startedAt: 2 });
  for (const stageId of stageIds) {
    targetStore.recordStageStart(childId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
    targetStore.recordStagePaused(childId, stageId);
  }
  targetStore.recordRunPaused(childId, undefined, { resumable: true, exitReason: "quit" });
  targetStore.recordRunPaused(rootId, undefined, { resumable: true, exitReason: "quit" });
  backend.registerWorkflow({ workflowId: rootId, name: "root", inputs: {}, createdAt: 1, status: "paused", resumable: true });
  backend.recordCheckpoint({ kind: "tool", workflowId: rootId, checkpointId: "progress", name: "progress", argsHash: "progress", output: true, completedAt: 3 });
}

function toolHandler() {
  const runtime = createExtensionRuntime({ registry: createRegistry([]) });
  return makeExecuteWorkflowTool(runtime, () => undefined);
}

async function startAnsweredQuitSyntheticPrompt(runId: string): Promise<InMemoryDurableBackend> {
  const backend = new InMemoryDurableBackend();
  setDurableBackend(backend);
  const definition = workflow({
    name: runId,
    description: "",
    inputs: {},
    outputs: {},
    run: async (ctx) => {
      await ctx.ui.input("P11 replay answer?");
      return {};
    },
  });
  runDetached(definition, {}, { runId });
  const deadline = Date.now() + 1_000;
  let promptStage: ReturnType<typeof singletonStore.runs>[number]["stages"][number] | undefined;
  while (Date.now() < deadline) {
    promptStage = singletonStore.runs().find((run) => run.id === runId)?.stages.find(
      (stage) => stage.pendingPrompt !== undefined,
    );
    if (promptStage !== undefined) break;
    await Bun.sleep(5);
  }
  assert.notEqual(promptStage?.pendingPrompt, undefined);
  assert.equal((await quitRun(runId)).ok, true);
  assert.equal((await quitRun(runId)).ok, true);
  assert.equal(
    singletonStore.resolveStagePendingPrompt(
      runId,
      promptStage!.id,
      promptStage!.pendingPrompt!.id,
      "paused-answer",
    ),
    true,
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(singletonStore.runs().find((run) => run.id === runId)?.status, "paused");
  return backend;
}

installSlashDispatchTestHooks();
afterEach(() => setDurableBackend(undefined));

describe("post-commit quit and nested resume coherence", () => {
  test("quit records a fulfilled conforming pause handle in the Store before returning snapshots", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const targetStore = createStore();
    const registry = createStageControlRegistry();
    const runId = "quit-store-coherence";
    let controlStatus: StageControlStatus = "running";
    targetStore.recordRunStart({ id: runId, name: runId, inputs: {}, status: "running", stages: [], startedAt: 1 });
    targetStore.recordStageStart(runId, { id: "stage", name: "stage", status: "running", parentIds: [], toolEvents: [] });
    backend.registerWorkflow({ workflowId: runId, name: runId, inputs: {}, createdAt: 1, status: "running" });
    registry.register(handle({
      runId,
      stageId: "stage",
      status: () => controlStatus,
      pause: async () => { controlStatus = "paused"; },
    }));

    const result = await quitRun(runId, { store: targetStore, stageControlRegistry: registry });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.paused.map((stage) => [stage.id, stage.status]), [["stage", "paused"]]);
    assert.equal(targetStore.runs()[0]?.stages[0]?.status, "paused");
    assert.equal(targetStore.runs()[0]?.status, "paused");
    assert.equal(targetStore.runs()[0]?.exitReason, "quit");
    assert.equal(backend.getWorkflow(runId)?.status, "paused");
  });

  test("targeted primitive child resume reconciles child, aggregate root, and root durability", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const targetStore = createStore();
    const registry = createStageControlRegistry();
    seedNested(targetStore, backend, "root-primitive", "child-primitive", ["child-stage"]);
    let calls = 0;
    registry.register(handle({
      runId: "child-primitive",
      stageId: "child-stage",
      status: () => targetStore.runs().find((run) => run.id === "child-primitive")?.stages[0]?.status ?? "paused",
      resume: async () => { calls += 1; },
    }));

    const result = await resumeRun("child-primitive", { store: targetStore, stageControlRegistry: registry, stageId: "child-stage" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.runId, "child-primitive");
    assert.deepEqual(result.resumed.map((stage) => stage.id), ["child-stage"]);
    assert.equal(calls, 1);
    assert.equal(targetStore.runs().find((run) => run.id === "child-primitive")?.status, "running");
    assert.equal(targetStore.runs().find((run) => run.id === "child-primitive")?.stages[0]?.status, "running");
    assert.equal(targetStore.runs().find((run) => run.id === "root-primitive")?.status, "running");
    assert.equal(backend.getWorkflow("root-primitive")?.status, "running");
  });

  test.serial("slash-targeted nested progress then tool root retry does not duplicate resumed descendants", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const rootId = "root-reverse-surface-retry";
    const childId = "child-reverse-surface-retry";
    seedNested(singletonStore, backend, rootId, childId, ["first", "second"]);
    const calls = new Map<string, number>();
    for (const stageId of ["first", "second"]) {
      stageControlRegistry.register(handle({
        runId: childId,
        stageId,
        status: () => singletonStore.runs().find((run) => run.id === childId)?.stages.find((stage) => stage.id === stageId)?.status ?? "paused",
        resume: async () => { calls.set(stageId, (calls.get(stageId) ?? 0) + 1); },
      }));
    }
    const { workflowCmd } = await registerWorkflowCommand();
    const firstContext = buildCtx();

    await workflowCmd.options.handler(`resume ${rootId} first`, firstContext.ctx);
    assert.deepEqual([...calls], [["first", 1]]);
    assert.equal(singletonStore.runs().find((run) => run.id === rootId)?.status, "running");
    assert.equal(backend.getWorkflow(rootId)?.status, "running");

    const retried = await toolHandler()({ action: "resume", runId: rootId }, {} as never);
    assert.equal(retried.action, "resume");
    assert.equal("status" in retried ? retried.status : undefined, "ok");
    assert.deepEqual([...calls], [["first", 1], ["second", 1]]);
    assert.deepEqual(singletonStore.runs().find((run) => run.id === childId)?.stages.map((stage) => stage.status), ["running", "running"]);
    assert.equal(singletonStore.runs().find((run) => run.id === rootId)?.status, "running");
    assert.equal(backend.getWorkflow(rootId)?.status, "running");
  });

  test.serial("tool-targeted nested progress then slash root retry resumes only the remaining descendant", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const rootId = "root-surface-retry";
    const childId = "child-surface-retry";
    seedNested(singletonStore, backend, rootId, childId, ["first-child-stage", "second-child-stage"]);
    const calls = new Map<string, number>();
    for (const stageId of ["first-child-stage", "second-child-stage"]) {
      stageControlRegistry.register(handle({
        runId: childId,
        stageId,
        status: () => singletonStore.runs().find((run) => run.id === childId)?.stages.find((stage) => stage.id === stageId)?.status ?? "paused",
        resume: async () => { calls.set(stageId, (calls.get(stageId) ?? 0) + 1); },
      }));
    }

    const targeted = await toolHandler()({ action: "resume", runId: rootId, stageId: "first-child-stage" }, {} as never);
    assert.equal(targeted.action, "resume");
    assert.equal("runId" in targeted ? targeted.runId : undefined, childId);
    assert.equal("status" in targeted ? targeted.status : undefined, "ok");
    assert.equal(singletonStore.runs().find((run) => run.id === rootId)?.status, "running");
    assert.equal(backend.getWorkflow(rootId)?.status, "running");
    assert.deepEqual([...calls], [["first-child-stage", 1]]);

    const { workflowCmd } = await registerWorkflowCommand();
    const { ctx, messages } = buildCtx();
    await workflowCmd.options.handler(`resume ${rootId}`, ctx);

    assert.deepEqual([...calls], [["first-child-stage", 1], ["second-child-stage", 1]]);
    assert.deepEqual(singletonStore.runs().find((run) => run.id === childId)?.stages.map((stage) => stage.status), ["running", "running"]);
    assert.equal(singletonStore.runs().find((run) => run.id === childId)?.status, "running");
    assert.equal(singletonStore.runs().find((run) => run.id === rootId)?.status, "running");
    assert.equal(backend.getWorkflow(rootId)?.status, "running");
    assert.match(messages.join("\n"), /Resumed 1 stage/);
  });
  test.serial("slash resume reports synthetic prompt acknowledgement as info while the root completes", async () => {
    const runId = "resume-terminal-synthetic-slash";
    const backend = await startAnsweredQuitSyntheticPrompt(runId);
    const { workflowCmd } = await registerWorkflowCommand();
    const infos: string[] = [];
    const errors: string[] = [];
    const ctx = {
      ui: {
        notify(message: string, level?: "error" | "info" | "warning") {
          if (level === "error") errors.push(message);
          else if (level === "info") infos.push(message);
        },
      },
    };

    await workflowCmd.options.handler(`resume ${runId}`, ctx);
    await jobTracker.get(runId)?.promise;

    assert.deepEqual(infos, [`Resume acknowledged; workflow ${runId} reached terminal status completed.`]);
    assert.deepEqual(errors, []);
    assert.equal(singletonStore.runs().find((run) => run.id === runId)?.status, "completed");
    assert.equal(backend.getWorkflow(runId)?.status, "completed");
  });

  test.serial("tool resume reports synthetic prompt acknowledgement as ok while the root completes", async () => {
    const runId = "resume-terminal-synthetic-tool";
    const backend = await startAnsweredQuitSyntheticPrompt(runId);

    const result = await toolHandler()({ action: "resume", runId }, {} as never);
    await jobTracker.get(runId)?.promise;

    assert.deepEqual(Object.keys(result).sort(), ["action", "message", "runId", "status"]);
    assert.equal(result.action, "resume");
    assert.equal("status" in result ? result.status : undefined, "ok");
    assert.equal(
      "message" in result ? result.message : undefined,
      `Resume acknowledged; workflow ${runId} reached terminal status completed.`,
    );
    assert.equal(singletonStore.runs().find((run) => run.id === runId)?.status, "completed");
    assert.equal(backend.getWorkflow(runId)?.status, "completed");
  });

  test.serial("slash resume reports terminal completion acknowledged by a paused control", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const runId = "resume-terminal-slash";
    const stageId = "awaiting-answer";
    let controlStatus: StageControlStatus = "paused";
    singletonStore.recordRunStart({ id: runId, name: runId, inputs: {}, status: "running", stages: [], startedAt: 1 });
    singletonStore.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
    singletonStore.recordStagePaused(runId, stageId);
    singletonStore.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
    backend.registerWorkflow({ workflowId: runId, name: runId, inputs: {}, createdAt: 1, status: "paused", resumable: true });
    backend.recordCheckpoint({ kind: "tool", workflowId: runId, checkpointId: "progress", name: "progress", argsHash: "progress", output: true, completedAt: 2 });
    stageControlRegistry.register(handle({
      runId,
      stageId,
      status: () => controlStatus,
      resume: async () => {
        controlStatus = "completed";
        const stage = singletonStore.runs().find((run) => run.id === runId)?.stages[0];
        assert.notEqual(stage, undefined);
        singletonStore.recordStageEnd(runId, { ...stage!, status: "completed", endedAt: 3, durationMs: 2, result: "held-answer" });
        singletonStore.recordRunEnd(runId, "completed", { answer: "held-answer" });
        backend.setWorkflowStatus(runId, "completed");
      },
    }));
    const { workflowCmd } = await registerWorkflowCommand();
    const messages: string[] = [];
    const levels: Array<string | undefined> = [];
    const ctx = { ui: { notify(message: string, level?: "error" | "info" | "warning") { messages.push(message); levels.push(level); } } };

    await workflowCmd.options.handler(`resume ${runId}`, ctx);

    const output = messages.join("\n");
    assert.doesNotMatch(output, /No paused stages/i);
    assert.match(output, /completed/i);
    assert.equal(levels.includes("error"), false);
    assert.equal(singletonStore.runs().find((run) => run.id === runId)?.status, "completed");
    assert.equal(backend.getWorkflow(runId)?.status, "completed");
  });

  test.serial("tool resume reports async terminal completion as successful progress", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const runId = "resume-terminal-tool";
    const stageId = "awaiting-answer";
    let controlStatus: StageControlStatus = "paused";
    singletonStore.recordRunStart({ id: runId, name: runId, inputs: {}, status: "running", stages: [], startedAt: 1 });
    singletonStore.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
    singletonStore.recordStagePaused(runId, stageId);
    singletonStore.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
    backend.registerWorkflow({ workflowId: runId, name: runId, inputs: {}, createdAt: 1, status: "paused", resumable: true });
    backend.recordCheckpoint({ kind: "tool", workflowId: runId, checkpointId: "progress", name: "progress", argsHash: "progress", output: true, completedAt: 2 });
    stageControlRegistry.register(handle({
      runId,
      stageId,
      status: () => controlStatus,
      resume: async () => {
        await Promise.resolve();
        controlStatus = "completed";
        const stage = singletonStore.runs().find((run) => run.id === runId)?.stages[0];
        assert.notEqual(stage, undefined);
        singletonStore.recordStageEnd(runId, { ...stage!, status: "completed", endedAt: 3, durationMs: 2, result: "held-answer" });
        singletonStore.recordRunEnd(runId, "completed", { answer: "held-answer" });
        backend.setWorkflowStatus(runId, "completed");
      },
    }));

    const result = await toolHandler()({ action: "resume", runId }, {} as never);

    assert.deepEqual(Object.keys(result).sort(), ["action", "message", "runId", "status"]);
    assert.equal(result.action, "resume");
    assert.equal("status" in result ? result.status : undefined, "ok");
    assert.doesNotMatch("message" in result ? result.message : "", /No paused stages|noop|error/i);
    assert.match("message" in result ? result.message : "", /completed/i);
    assert.equal(singletonStore.runs().find((run) => run.id === runId)?.status, "completed");
    assert.equal(backend.getWorkflow(runId)?.status, "completed");
  });

  test.serial("tool resume retains noop for a pre-existing paused snapshot with no paused control", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const runId = "resume-no-paused-control";
    const stageId = "stale-paused-stage";
    singletonStore.recordRunStart({ id: runId, name: runId, inputs: {}, status: "running", stages: [], startedAt: 1 });
    singletonStore.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
    singletonStore.recordStagePaused(runId, stageId);
    singletonStore.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
    backend.registerWorkflow({ workflowId: runId, name: runId, inputs: {}, createdAt: 1, status: "paused", resumable: true });
    backend.recordCheckpoint({ kind: "tool", workflowId: runId, checkpointId: "progress", name: "progress", argsHash: "progress", output: true, completedAt: 2 });
    stageControlRegistry.register(handle({ runId, stageId, status: () => "completed" }));

    const result = await toolHandler()({ action: "resume", runId }, {} as never);

    assert.equal(result.action, "resume");
    assert.equal("status" in result ? result.status : undefined, "noop");
    assert.match("message" in result ? result.message : "", /No paused stages/i);
    assert.equal(singletonStore.runs().find((run) => run.id === runId)?.status, "paused");
    assert.equal(backend.getWorkflow(runId)?.status, "paused");

    const { workflowCmd } = await registerWorkflowCommand();
    const infos: string[] = [];
    const errors: string[] = [];
    const ctx = {
      ui: {
        notify(message: string, level?: "error" | "info" | "warning") {
          if (level === "error") errors.push(message);
          else if (level === "info") infos.push(message);
        },
      },
    };
    await workflowCmd.options.handler(`resume ${runId}`, ctx);
    assert.deepEqual(infos, []);
    assert.deepEqual(errors, [`No paused stages on run ${runId.slice(0, 8)}.`]);
  });

  test.serial("slash quit, held synthetic prompt answer, and resume reports one truthful acknowledgment", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    const runId = "resume-synthetic-prompt-command";
    const definition = workflow({
      name: "resume-synthetic-prompt-command",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.ui.input("P11 replay answer?");
        return {};
      },
    });
    const execution = executeWorkflow(definition, {}, {
      runId,
      store: singletonStore,
      stageControlRegistry,
      durableBackend: backend,
      usePromptNodesForUi: true,
    });
    const deadline = Date.now() + 1_000;
    let prompt: { readonly stageId: string; readonly promptId: string } | undefined;
    while (Date.now() < deadline && prompt === undefined) {
      const stage = singletonStore.runs().find((run) => run.id === runId)?.stages
        .find((candidate) => candidate.pendingPrompt !== undefined);
      if (stage?.pendingPrompt !== undefined) prompt = { stageId: stage.id, promptId: stage.pendingPrompt.id };
      else await Bun.sleep(5);
    }
    assert.notEqual(prompt, undefined, "synthetic prompt must be visible before command control");
    const { workflowCmd } = await registerWorkflowCommand();
    const messages: string[] = [];
    const levels: Array<string | undefined> = [];
    const ctx = { ui: { notify(message: string, level?: "error" | "info" | "warning") { messages.push(message); levels.push(level); } } };

    await workflowCmd.options.handler(`quit ${runId}`, ctx);
    await workflowCmd.options.handler(`quit ${runId}`, ctx);
    assert.equal(singletonStore.resolveStagePendingPrompt(runId, prompt!.stageId, prompt!.promptId, "held-answer"), true);
    await Bun.sleep(10);
    assert.equal(singletonStore.runs().find((run) => run.id === runId)?.status, "paused");
    messages.length = 0;
    levels.length = 0;

    await workflowCmd.options.handler(`resume ${runId}`, ctx);
    const completed = await execution;

    assert.equal(completed.status, "completed");
    assert.equal(messages.length, 1, "resume command must emit one result");
    assert.doesNotMatch(messages[0] ?? "", /No paused stages/i);
    assert.match(messages[0] ?? "", /resume acknowledged|resumed/i);
    assert.equal(levels.includes("error"), false);
    assert.equal(singletonStore.runs().find((run) => run.id === runId)?.status, "completed");
  });

});
