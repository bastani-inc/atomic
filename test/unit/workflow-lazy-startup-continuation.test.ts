import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, { type ExtensionAPI, type PiCommandOptions } from "../../packages/workflows/src/extension/index.js";
import type { ChatSurfacePayload } from "../../packages/workflows/src/tui/chat-surface-message.js";
import type { SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { killAllRuns } from "../../packages/workflows/src/runs/background/status.js";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { Type } from "typebox";
import { createExtensionRuntime, type ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";

interface SentMessage {
  customType?: string;
  content?: string;
  details?: unknown;
}

type Handler = (event?: unknown, ctx?: unknown) => Promise<void> | void;

const originalCwd = process.cwd();

async function cleanupJobs(): Promise<void> {
  await Promise.all(jobTracker.runIds().map((runId) => jobTracker.get(runId)?.promise));
}

beforeEach(() => {
  setDurableBackend(new InMemoryDurableBackend());
});

afterEach(async () => {
  delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
  process.chdir(originalCwd);
  killAllRuns({ store, cancellation: cancellationRegistry });
  await cleanupJobs();
  store.clear();
  setDurableBackend(undefined);
});

function workflowConfigDir(root: string): string {
  return join(root, ".atomic", "extensions", "workflow");
}

function registerFactory(piOverrides: Partial<ExtensionAPI> = {}): {
  handlers: Map<string, Handler>;
  commands: Array<{ name: string; options: PiCommandOptions }>;
  sent: SentMessage[];
} {
  const handlers = new Map<string, Handler>();
  const commands: Array<{ name: string; options: PiCommandOptions }> = [];
  const sent: SentMessage[] = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: (name: string, options: PiCommandOptions) => { commands.push({ name, options }); },
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: () => undefined,
    sendMessage: (message: SentMessage) => { sent.push(message); },
    createAgentSession: async () => ({
      session: {
        prompt: async () => "ok",
        steer: async () => undefined,
        followUp: async () => undefined,
        subscribe: () => () => undefined,
        sessionFile: undefined,
        sessionId: "workflow-lazy-test-session",
        setModel: async () => undefined,
        setThinkingLevel: () => undefined,
        dispose: async () => undefined,
      },
    }),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    ...piOverrides,
  } as unknown as ExtensionAPI;
  factory(pi);
  return { handlers, commands, sent };
}

function inFlightEntry(runId: string, name = "config-restore-wf"): SessionEntry {
  return { id: `${runId}-start`, type: "workflow.run.start", payload: { runId, name, inputs: {}, ts: 1 } };
}

function listPayload(sent: readonly SentMessage[]): ChatSurfacePayload | undefined {
  const message = sent.find((entry) => {
    const details = entry.details;
    return typeof details === "object" && details !== null && "kind" in details && details.kind === "list";
  });
  return message?.details as ChatSurfacePayload | undefined;
}

async function writeWorkflowFixture(filePath: string, name: string): Promise<void> {
  await writeFile(filePath, `import { workflow } from "@bastani/workflows";
export default workflow({
  name: ${JSON.stringify(name)},
  description: "",
  inputs: {},
  outputs: {},
  run: async () => ({}),
});
`, "utf8");
}

async function writePromptWorkflowFixture(filePath: string, name: string): Promise<void> {
  await writeFile(filePath, `import { workflow } from "@bastani/workflows";
export default workflow({
  name: ${JSON.stringify(name)},
  description: "",
  inputs: {},
  outputs: { value: { type: "string" } },
  run: async (ctx) => ({ value: await ctx.stage("retry").prompt("retry") }),
});
`, "utf8");
}

describe("workflow lazy-startup continuation fixes", () => {
  test("session_start loads persistRuns config before restore without discovering workflow modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-workflow-config-restore-"));
    try {
      mkdirSync(workflowConfigDir(root), { recursive: true });

      writeFileSync(join(workflowConfigDir(root), "config.json"), JSON.stringify({ persistRuns: false }), "utf8");
      process.chdir(root);
      let resourceCalls = 0;
      const { handlers } = registerFactory({ disableAsyncDiscovery: true, getWorkflowResources: () => { resourceCalls += 1; return []; } });
      const sessionStart = handlers.get("session_start");
      assert.ok(sessionStart);
      await sessionStart({}, { sessionManager: { getEntries: () => [inFlightEntry("persist-off-run")] } });
      assert.equal(store.runs().length, 0);
      assert.equal(resourceCalls, 0);
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session_start loads resumeInFlight config before restore", async () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-workflow-config-auto-"));
    try {
      mkdirSync(workflowConfigDir(root), { recursive: true });
      writeFileSync(join(workflowConfigDir(root), "config.json"), JSON.stringify({ resumeInFlight: "auto" }), "utf8");
      process.chdir(root);
      const { handlers } = registerFactory({ disableAsyncDiscovery: true });
      await handlers.get("session_start")?.({}, { sessionManager: { getEntries: () => [inFlightEntry("auto-run")] } });
      const restored = store.runs().find((run) => run.id === "auto-run");
      assert.equal(restored?.status, "running");
      assert.equal(restored?.endedAt, undefined);
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session_start emits immediate config diagnostics without workflow discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-workflow-config-diagnostics-"));
    try {
      mkdirSync(workflowConfigDir(root), { recursive: true });
      writeFileSync(join(workflowConfigDir(root), "config.json"), "{ not valid json", "utf8");
      process.chdir(root);
      let resourceCalls = 0;
      const notifications: string[] = [];
      const { handlers } = registerFactory({ disableAsyncDiscovery: true, getWorkflowResources: () => { resourceCalls += 1; return []; } });
      await handlers.get("session_start")?.({}, { ui: { notify: (message: string) => notifications.push(message) } });
      assert.equal(resourceCalls, 0);
      assert.match(notifications.join("\n"), /CONFIG_INVALID/);
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("/workflow list retries after a transient lazy discovery failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-lazy-retry-"));
    try {
      const workflowPath = join(dir, "retry-workflow.ts");
      await writeWorkflowFixture(workflowPath, "retry workflow");
      let refreshCalls = 0;
      const { commands, sent } = registerFactory({
        refreshWorkflowResources: async () => {
          refreshCalls += 1;
          if (refreshCalls === 1) throw new Error("transient refresh failure");
          return [{ path: workflowPath, enabled: true }];
        },
      });
      const workflowCmd = commands.find((command) => command.name === "workflow");
      assert.ok(workflowCmd);
      const notices: string[] = [];
      const headlessCtx = { hasUI: false, ui: { notify: (message: string) => { notices.push(message); } } };
      await workflowCmd.options.handler?.("list", headlessCtx);
      assert.equal(refreshCalls, 1);
      assert.match(notices.join("\n"), /transient refresh failure/);
      sent.length = 0;
      await workflowCmd.options.handler?.("list", headlessCtx);
      assert.equal(refreshCalls, 2);
      assert.equal(listPayload(sent)?.kind, "list");
      assert.match(sent.map((entry) => entry.content ?? "").join("\n"), /retry-workflow/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("/workflow autocomplete falls back to admin completions when lazy discovery fails", async () => {
    let refreshCalls = 0;
    const { commands } = registerFactory({
      refreshWorkflowResources: async () => {
        refreshCalls += 1;
        throw new Error("discovery failed");
      },
    });
    const workflowCmd = commands.find((command) => command.name === "workflow");
    assert.ok(workflowCmd?.options.getArgumentCompletions);

    const completions = await workflowCmd.options.getArgumentCompletions("");

    assert.equal(refreshCalls, 1);
    assert.ok(Array.isArray(completions));
    assert.ok(completions.some((item) => item.value === "list "));
    assert.ok(completions.some((item) => item.value === "resume "));
  });

  test("/workflow resume for paused live runs does not force workflow discovery", async () => {
    let refreshCalls = 0;
    const { commands } = registerFactory({
      refreshWorkflowResources: async () => {
        refreshCalls += 1;
        throw new Error("discovery failed");
      },
    });
    const runId = "paused-slash-resume-source";
    store.recordRunStart({ id: runId, name: "paused workflow", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    assert.equal(store.recordRunPaused(runId), true);
    const workflowCmd = commands.find((command) => command.name === "workflow");
    assert.ok(workflowCmd);

    await workflowCmd.options.handler?.(`resume ${runId}`, { hasUI: false, ui: { notify: () => undefined } });

    assert.equal(refreshCalls, 0);
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
  });


  test("workflow tool direct task run bypasses workflow discovery", async () => {
    let ensureCalls = 0;
    let runDirectCalls = 0;
    const runtime = {
      async runDirect(): Promise<unknown> {
        runDirectCalls += 1;
        return { mode: "task", status: "completed", runId: "direct-run", output: { ok: true } };
      },
      dispatch(): never {
        throw new Error("dispatch should not run");
      },
    } as unknown as ExtensionRuntime;
    const handler = makeExecuteWorkflowTool(
      runtime,
      () => undefined,
      async () => {
        ensureCalls += 1;
        throw new Error("discovery failed");
      },
    );

    const result = await handler({ action: "run", task: { name: "direct", task: "do it" } }, {} as never);

    assert.equal(ensureCalls, 0);
    assert.equal(runDirectCalls, 1);
    assert.equal(result.action, "run");
    assert.equal(result.runId, "direct-run");
  });


  test("workflow tool paused resume bypasses workflow discovery", async () => {
    let ensureCalls = 0;
    const runId = "paused-tool-resume-source";
    store.recordRunStart({ id: runId, name: "paused tool workflow", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    assert.equal(store.recordRunPaused(runId), true);
    const runtime = createExtensionRuntime({ registry: createRegistry([]), store });
    const handler = makeExecuteWorkflowTool(
      runtime,
      () => undefined,
      async () => {
        ensureCalls += 1;
        throw new Error("discovery failed");
      },
    );

    const result = await handler({ action: "resume", runId }, {} as never);

    assert.equal(ensureCalls, 0);
    assert.equal(result.action, "resume");
    assert.equal(result.status, "ok");
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
  });

  test("/workflow resume lazy-loads resources before failed-run registry lookup", async () => {
    class CatalogCountingBackend extends InMemoryDurableBackend {
      completedCatalogCalls = 0;

      override listCompletedWorkflows() {
        this.completedCatalogCalls += 1;
        return super.listCompletedWorkflows();
      }
    }

    const backend = new CatalogCountingBackend();
    setDurableBackend(backend);
    const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-slash-resume-lazy-"));
    try {
      const workflowPath = join(dir, "slash-resume-lazy.ts");
      await writePromptWorkflowFixture(workflowPath, "slash-resume-lazy");
      let refreshCalls = 0;
      const { commands, sent } = registerFactory({
        refreshWorkflowResources: async () => {
          refreshCalls += 1;
          return [{ path: workflowPath, enabled: true }];
        },
      });
      const sourceRunId = "lazy-slash-resume-source";
      store.recordRunStart({ id: sourceRunId, name: "slash-resume-lazy", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
      store.recordStageStart(sourceRunId, { id: "retry-old", name: "retry", status: "failed", parentIds: [], toolEvents: [], error: "boom" });
      store.recordStageEnd(sourceRunId, { id: "retry-old", name: "retry", status: "failed", parentIds: [], toolEvents: [], error: "boom" });
      store.recordRunEnd(sourceRunId, "failed", undefined, "boom", { resumable: true, failedStageId: "retry-old" });
      backend.registerWorkflow({ workflowId: sourceRunId, name: "slash-resume-lazy", inputs: {}, createdAt: Date.now(), status: "failed", resumable: true });
      const workflowCmd = commands.find((command) => command.name === "workflow");
      assert.ok(workflowCmd);
      await workflowCmd.options.handler?.(`resume ${sourceRunId}`, { hasUI: false, ui: { notify: () => undefined } });
      assert.equal(refreshCalls, 1);
      assert.equal(backend.completedCatalogCalls, 1);
      const output = sent.map((entry) => entry.content ?? "").join("\n");
      assert.match(output, /Resum/);
      assert.doesNotMatch(output, /Run not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });


  test("workflow tool resume lazy-loads resources before failed-run registry lookup", async () => {
    delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
    const def = workflow({
      name: "lazy resume workflow",
      description: "",
      inputs: {},
      outputs: { value: Type.Optional(Type.String()) },
      run: async (ctx) => ({ value: await ctx.stage("retry").prompt("retry") }),
    });
    const sourceRunId = "lazy-tool-resume-source";
    store.recordRunStart({ id: sourceRunId, name: def.name, inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    store.recordStageStart(sourceRunId, { id: "retry-old", name: "retry", status: "failed", parentIds: [], toolEvents: [], error: "boom" });
    store.recordStageEnd(sourceRunId, { id: "retry-old", name: "retry", status: "failed", parentIds: [], toolEvents: [], error: "boom" });
    store.recordRunEnd(sourceRunId, "failed", undefined, "boom", { resumable: true, failedStageId: "retry-old" });
    let runtime: ExtensionRuntime = createExtensionRuntime({ registry: createRegistry([]) });
    let ensureCalls = 0;
    const handler = makeExecuteWorkflowTool(
      () => runtime,
      () => undefined,
      async () => {
        ensureCalls += 1;
        runtime = createExtensionRuntime({ registry: createRegistry([def]), store, adapters: { prompt: { prompt: async () => "new" } } });
      },
    );
    const result = await handler({ action: "resume", runId: sourceRunId }, { model: { provider: "fake", id: "model" } } as never);
    assert.equal(ensureCalls, 1);
    assert.equal(result.action, "resume");
    assert.equal(result.status, "running");
    assert.match(result.message ?? "", /Resum/);
  });

  test("session_start invalidates stale workflow warmups before they publish old registries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-stale-warmup-"));
    try {
      const oldPath = join(dir, "old-workflow.ts");
      const newPath = join(dir, "new-workflow.ts");
      await writeWorkflowFixture(oldPath, "old workflow");
      await writeWorkflowFixture(newPath, "new workflow");

      let refreshCalls = 0;
      const resolvers: Array<(resources: Array<{ path: string; enabled: true }>) => void> = [];
      const refreshStarted: Promise<void>[] = [];
      const waitForRefresh = async (index: number): Promise<void> => {
        while (refreshStarted.length <= index) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        await refreshStarted[index];
      };
      const { handlers, commands, sent } = registerFactory({
        refreshWorkflowResources: () => {
          refreshCalls += 1;
          let markStarted: () => void = () => undefined;
          refreshStarted.push(new Promise((resolve) => { markStarted = resolve; }));
          markStarted();
          return new Promise((resolve) => { resolvers.push(resolve); });
        },
      });
      const sessionStart = handlers.get("session_start");
      assert.ok(sessionStart);

      await sessionStart({}, { ui: { notify: () => undefined } });
      await waitForRefresh(0);
      await sessionStart({}, { ui: { notify: () => undefined } });

      // The permanent reload coordinator serializes generations. Release the
      // stale pass before waiting for the new session's trailing pass to start.
      assert.equal(refreshCalls, 1);
      resolvers[0]?.([{ path: oldPath, enabled: true }]);
      await waitForRefresh(1);
      assert.equal(refreshCalls, 2);
      resolvers[1]?.([{ path: newPath, enabled: true }]);

      const workflowCmd = commands.find((command) => command.name === "workflow");
      assert.ok(workflowCmd);
      await workflowCmd.options.handler?.("list", { hasUI: false, ui: { notify: () => undefined } });
      const output = sent.map((entry) => entry.content ?? "").join("\n");
      assert.match(output, /new-workflow/);
      assert.doesNotMatch(output, /old-workflow/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
