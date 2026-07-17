import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import factory, { type ExtensionAPI, type PiCommandOptions } from "../../packages/workflows/src/extension/index.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { handleRunControlCommand, type WorkflowRunControlDeps } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";

const previousWorkflowStageSubagentGuard = process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];

class HydrationCapableBackend extends InMemoryDurableBackend {
  hydrateCalls = 0;
  async hydrateWorkflow(): Promise<void> { this.hydrateCalls += 1; }
}

class UnclassifiedHydrationBackend extends HydrationCapableBackend {
  loadable = false;
  override isWorkflowLoadable(): boolean { return this.loadable; }
  async hydrateResumableWorkflows(): Promise<void> {
    this.hydrateCalls += 1;
    this.loadable = true;
  }
}

function registerFactory(piOverrides: Partial<ExtensionAPI> = {}): Array<{ name: string; options: PiCommandOptions }> {
  const commands: Array<{ name: string; options: PiCommandOptions }> = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: (name: string, options: PiCommandOptions) => { commands.push({ name, options }); },
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: () => undefined,
    sendMessage: () => undefined,
    createAgentSession: async () => ({
      session: {
        prompt: async () => "ok",
        steer: async () => undefined,
        followUp: async () => undefined,
        subscribe: () => () => undefined,
        sessionFile: undefined,
        sessionId: "workflow-review-followup-session",
        setModel: async () => undefined,
        setThinkingLevel: () => undefined,
        dispose: async () => undefined,
      },
    }),
    on: () => undefined,
    ...piOverrides,
  } as unknown as ExtensionAPI;
  factory(pi);
  return commands;
}

beforeEach(() => {
  delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
  setDurableBackend(new InMemoryDurableBackend());
});

afterEach(() => {
  store.clear();
  setDurableBackend(undefined);
  if (previousWorkflowStageSubagentGuard === undefined) {
    delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
    return;
  }
  process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = previousWorkflowStageSubagentGuard;
});

describe("workflow lazy-startup review follow-up fixes", () => {
  test("/workflow resume picker shows live runs when lazy discovery fails", async () => {
    let refreshCalls = 0;
    let pickerCalls = 0;
    const commands = registerFactory({
      refreshWorkflowResources: async () => {
        refreshCalls += 1;
        throw new Error("discovery failed");
      },
    });
    const runId = "picker-live-resume-source";
    store.recordRunStart({ id: runId, name: "picker workflow", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    assert.equal(store.recordRunPaused(runId), true);
    const workflowCmd = commands.find((command) => command.name === "workflow");
    assert.ok(workflowCmd);

    await workflowCmd.options.handler?.("resume", {
      hasUI: true,
      ui: {
        notify: () => undefined,
        custom: () => undefined,
        hostSessionPicker: () => {
          pickerCalls += 1;
          return {
            // The picker must open before any resource/catalog discovery runs.
            // Discovery happens lazily via hydrate(), so keep the picker open
            // until it has been attempted (and failed), then cancel — proving
            // the picker stayed open the whole time.
            result: (async (): Promise<string | undefined> => {
              // Wait on a generous wall-clock deadline (not a fixed tick count):
              // under a loaded event loop the hydrate failure can take many more
              // than a handful of setImmediate turns to land, so a small tick
              // budget would cancel prematurely and flake.
              const deadline = Date.now() + 5_000;
              while (refreshCalls === 0 && Date.now() < deadline) {
                await new Promise((resolve) => setImmediate(resolve));
              }
              return undefined;
            })(),
            update: () => undefined,
            error: () => undefined,
            close: () => undefined,
          };
        },
      },
    });
    assert.equal(refreshCalls, 1);
    assert.equal(pickerCalls, 1);
  });

  test("/workflow list surfaces lazy discovery failures as warnings", async () => {
    const notices: string[] = [];
    const commands = registerFactory({
      refreshWorkflowResources: async () => {
        throw new Error("broken workflow file");
      },
    });
    const workflowCmd = commands.find((command) => command.name === "workflow");
    assert.ok(workflowCmd);

    await workflowCmd.options.handler?.("list", { hasUI: true, ui: { notify: (message) => { notices.push(message); } } });

    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /Workflow discovery diagnostics/);
    assert.match(notices[0]!, /broken workflow file/);
    assert.match(notices[0]!, /currently loaded workflow registry/);
  });

  test("/workflow resume for quit-paused live runs does not force durable discovery", async () => {
    let refreshCalls = 0;
    const commands = registerFactory({
      refreshWorkflowResources: async () => {
        refreshCalls += 1;
        throw new Error("discovery failed");
      },
    });
    const runId = "quit-paused-resume-source";
    store.recordRunStart({ id: runId, name: "quit paused workflow", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    assert.equal(store.recordRunPaused(runId, Date.now(), { resumable: true, exitReason: "quit" }), true);
    const workflowCmd = commands.find((command) => command.name === "workflow");
    assert.ok(workflowCmd);

    await workflowCmd.options.handler?.(`resume ${runId}`, { hasUI: false, ui: { notify: () => undefined } });

    assert.equal(refreshCalls, 0);
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
  });

  test("/workflow resume keeps hydration-capable current live runs on the lazy fast path", async () => {
    const backend = new HydrationCapableBackend();
    setDurableBackend(backend);
    let refreshCalls = 0;
    const commands = registerFactory({ refreshWorkflowResources: async () => { refreshCalls += 1; return []; } });
    const runId = "dbos-like-current-live";
    store.recordRunStart({ id: runId, name: "current live", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    assert.equal(store.recordRunPaused(runId), true);
    const workflowCmd = commands.find((command) => command.name === "workflow");
    assert.ok(workflowCmd);

    await workflowCmd.options.handler?.(`resume ${runId}`, { hasUI: false, ui: { notify: () => undefined } });

    assert.equal(refreshCalls, 0);
    assert.equal(backend.hydrateCalls, 0);
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
  });

  test("/workflow resume prepares unclassified hydration-capable restored runs before choosing live path", async () => {
    const backend = new UnclassifiedHydrationBackend();
    setDurableBackend(backend);
    let refreshCalls = 0;
    const commands = registerFactory({ refreshWorkflowResources: async () => { refreshCalls += 1; return []; } });
    const runId = "dbos-like-unclassified-restored";
    store.recordRunStart({ id: runId, name: "restored", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    assert.equal(store.recordRunPaused(runId), true);
    const workflowCmd = commands.find((command) => command.name === "workflow");
    assert.ok(workflowCmd);
    await workflowCmd.options.handler?.(`resume ${runId}`, { hasUI: false, ui: { notify: () => undefined } });
    assert.equal(refreshCalls, 1);
    assert.ok(backend.hydrateCalls >= 1);
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
  });

  test("/workflow resume routes quit durable shadows through durable resume", async () => {
    const runId = "quit-shadow-durable-resume";
    store.recordRunStart({ id: runId, name: "quit shadow workflow", inputs: {}, status: "running", stages: [], startedAt: Date.now(), exitReason: "quit", resumable: true });
    let ensureCalls = 0;
    let preparedTarget: string | undefined;
    let resumedTarget: string | undefined;
    const opened: string[] = [];
    const messages: string[] = [];
    const runtime = {
      prepareDurableResumable: async (target?: string) => {
        preparedTarget = target;
        return [{ workflowId: runId, name: "quit shadow workflow", status: "paused", completedCheckpoints: 1, pendingPrompts: 0, createdAt: Date.now(), updatedAt: Date.now() }];
      },
      resumeDurableWorkflow: (target: string) => {
        resumedTarget = target;
        return { ok: true, runId: target, message: `Resumed durable ${target}` };
      },
      registry: { has: () => true },
    } as unknown as ExtensionRuntime;
    const deps: WorkflowRunControlDeps = {
      pi: {} as never,
      overlay: { open: (id) => { if (id) opened.push(id); }, toggle: () => undefined, close: () => undefined },
      runtimeForContext: () => runtime,
      ensureWorkflowResourcesLoaded: () => { ensureCalls += 1; },
    };

    await handleRunControlCommand("resume", [runId], { hasUI: true, ui: { notify: () => undefined } }, { info: (message) => messages.push(message), error: (message) => messages.push(message) }, deps);

    assert.equal(ensureCalls, 1);
    assert.equal(preparedTarget, runId);
    assert.equal(resumedTarget, runId);
    assert.deepEqual(opened, [runId]);
    assert.deepEqual(messages, [`Resumed durable ${runId}`]);
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
  });

  test("workflow tool named run re-resolves runtime after lazy discovery", async () => {
    let ensureCalls = 0;
    let registryLoaded = false;
    const runtimeForCurrentRegistry = (): ExtensionRuntime => {
      const canSeeLazyWorkflow = registryLoaded;
      return {
        dispatch: async (): Promise<WorkflowToolResult> => canSeeLazyWorkflow
          ? { action: "run", name: "lazy model run", runId: "model-run", status: "running", stages: [] }
          : { action: "run", name: "lazy model run", runId: "", status: "failed", error: "Workflow not found: lazy model run", stages: [] },
        runDirect: async (): Promise<never> => { throw new Error("runDirect should not run"); },
      } as unknown as ExtensionRuntime;
    };
    const handler = makeExecuteWorkflowTool(
      runtimeForCurrentRegistry,
      () => undefined,
      async () => {
        ensureCalls += 1;
        registryLoaded = true;
      },
    );

    const result = await handler({ action: "run", workflow: "lazy model run", inputs: {} }, { model: { provider: "fake", id: "model" } } as never);

    assert.equal(ensureCalls, 1);
    assert.equal(result.action, "run");
    assert.equal(result.status, "running");
    assert.equal(result.runId, "model-run");
  });

  test("workflow tool failed resume re-resolves runtime after lazy discovery", async () => {
    const backend = new HydrationCapableBackend();
    setDurableBackend(backend);
    const sourceRunId = "lazy-tool-model-resume-source";
    store.recordRunStart({ id: sourceRunId, name: "lazy model resume", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    store.recordStageStart(sourceRunId, { id: "retry-old", name: "retry", status: "failed", parentIds: [], toolEvents: [], error: "boom" });
    store.recordStageEnd(sourceRunId, { id: "retry-old", name: "retry", status: "failed", parentIds: [], toolEvents: [], error: "boom" });
    store.recordRunEnd(sourceRunId, "failed", undefined, "boom", { resumable: true, failedStageId: "retry-old" });
    let ensureCalls = 0;
    let registryLoaded = false;
    const runtimeForCurrentRegistry = (): ExtensionRuntime => {
      const canResume = registryLoaded;
      return {
        resumeFailedRun: () => canResume
          ? { ok: true, runId: "continued-run", message: "Resuming failed workflow" }
          : { ok: false, reason: "workflow_not_found", message: "workflow_not_found: lazy model resume" },
      } as unknown as ExtensionRuntime;
    };
    const handler = makeExecuteWorkflowTool(
      runtimeForCurrentRegistry,
      () => undefined,
      async () => {
        ensureCalls += 1;
        registryLoaded = true;
      },
    );

    const result = await handler({ action: "resume", runId: sourceRunId }, { model: { provider: "fake", id: "model" } } as never);

    assert.equal(ensureCalls, 1);
    assert.equal(backend.hydrateCalls, 0);
    assert.equal(result.action, "resume");
    assert.equal(result.status, "running");
    assert.equal(result.runId, "continued-run");
    assert.match(result.message ?? "", /Resuming failed workflow/);
  });
});
