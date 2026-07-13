import { beforeEach, afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import type { ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import type { WorkflowExecutionPolicy } from "../../packages/workflows/src/shared/types.js";
import { buildMockPi, buildPrintCtxWithRealCustom, delay, factory, initTheme, singletonStore, type PiCustomOverlayFunction, visibleText } from "./overlay-entrypoints-helpers.js";

describe("/workflow resume — durable regression coverage", () => {
  beforeEach(() => {
    singletonStore.clear();
    setDurableBackend(new InMemoryDurableBackend());
    initTheme("dark");
  });
  afterEach(() => setDurableBackend(undefined));

  test("durable resume forwards non-interactive command policy", async () => {
    let capturedPolicy: WorkflowExecutionPolicy | undefined;
    const runtime = {
      prepareDurableResumable: async () => [{
        workflowId: "durable-policy-run",
        name: "policy-wf",
        status: "paused" as const,
        completedCheckpoints: 0,
        pendingPrompts: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
      resumeDurableWorkflow: (_target: string, options?: { readonly policy?: WorkflowExecutionPolicy }) => {
        capturedPolicy = options?.policy;
        return { ok: false as const, reason: "workflow_not_found" as const, message: "missing" };
      },
    } as unknown as ExtensionRuntime;
    const messages: string[] = [];

    await handleRunControlCommand("resume", ["durable-policy-run"], { hasUI: false, ui: { notify: () => undefined } }, {
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
    }, {
      pi: buildMockPi().pi,
      overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
      getPersistence: () => undefined,
      runtimeForContext: () => runtime,
      ensureWorkflowResourcesLoaded: () => undefined,
    });

    assert.equal(capturedPolicy?.mode, "non_interactive");
    assert.equal(messages.some((message) => message.includes("missing")), true);
  });

  test("targeted resume prefers a paused durable root over an ended restored snapshot", async () => {
    const runId = "restored-shadow-durable-root";
    singletonStore.recordRunStart({
      id: runId,
      name: "restored-shadow",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: 1,
    });
    singletonStore.recordRunEnd(runId, "failed", undefined, "Run did not complete — process was interrupted", {
      resumable: false,
    });
    let resumedTarget: string | undefined;
    const runtime = {
      isDurableWorkflowExecutionActive: () => false,
      isDurableRootResumable: (target: string) => target === runId,
      prepareDurableResumable: async () => [],
      resumeDurableWorkflow: (target: string) => {
        resumedTarget = target;
        return { ok: true as const, runId: target, workflowId: target, name: "restored-shadow", message: `Resumed durable ${target}` };
      },
      registry: { has: () => true },
    } as unknown as ExtensionRuntime;
    const messages: string[] = [];

    await handleRunControlCommand("resume", [runId], { hasUI: false, ui: { notify: () => undefined } }, {
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
    }, {
      pi: buildMockPi().pi,
      overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
      getPersistence: () => undefined,
      runtimeForContext: () => runtime,
      ensureWorkflowResourcesLoaded: () => undefined,
    });

    assert.equal(resumedTarget, runId);
    assert.match(messages.join("\n"), /Resumed durable restored-shadow-durable-root/);
    assert.doesNotMatch(messages.join("\n"), /Snapshot available/);
  });

  test("restored-running resume refreshes a stale DBOS external-owner marker then proceeds", async () => {
    const runId = "dbos-stale-external-owner";
    singletonStore.recordRunStart({ id: runId, name: "dbos-wf", inputs: {}, status: "running", stages: [], startedAt: 1 });
    let refreshed = false;
    let resumedTarget: string | undefined;
    const runtime = {
      // A DBOS observer cached this workflow as externally owned; the real
      // owner has since exited. The command must refresh remote ownership
      // before the sync active check, which clears the stale marker.
      refreshDurableWorkflowExecution: async (target: string) => { if (target === runId) refreshed = true; },
      isDurableWorkflowExecutionActive: (target: string) => target === runId && !refreshed,
      isDurableRootResumable: (target: string) => target === runId,
      prepareDurableResumable: async () => [],
      resumeDurableWorkflow: (target: string) => {
        resumedTarget = target;
        return { ok: true as const, runId: target, workflowId: target, name: "dbos-wf", message: `Resumed durable ${target}` };
      },
      registry: { has: () => true },
    } as unknown as ExtensionRuntime;
    const messages: string[] = [];

    await handleRunControlCommand("resume", [runId], { hasUI: false, ui: { notify: () => undefined } }, {
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
    }, {
      pi: buildMockPi().pi,
      overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
      getPersistence: () => undefined,
      runtimeForContext: () => runtime,
      ensureWorkflowResourcesLoaded: () => undefined,
    });

    assert.equal(refreshed, true);
    assert.equal(resumedTarget, runId);
    assert.doesNotMatch(messages.join("\n"), /already running/);
  });

  test("headless no-arg durable resume prints catalog without awaiting no-op custom UI", async () => {
    const runtime = {
      prepareDurableResumable: async () => [{
        workflowId: "durable-headless-catalog",
        name: "headless-wf",
        status: "paused" as const,
        completedCheckpoints: 0,
        pendingPrompts: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
    } as unknown as ExtensionRuntime;
    const messages: string[] = [];
    let customCalls = 0;
    const noopCustom: PiCustomOverlayFunction = () => {
      customCalls++;
      return undefined;
    };

    await handleRunControlCommand("resume", [], {
      hasUI: false,
      ui: {
        notify: () => undefined,
        custom: noopCustom,
      },
    }, {
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
    }, {
      pi: buildMockPi().pi,
      overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
      getPersistence: () => undefined,
      runtimeForContext: () => runtime,
      ensureWorkflowResourcesLoaded: () => undefined,
    });

    const joined = messages.join("\n");
    assert.equal(customCalls, 0);
    assert.match(joined, /Resumable workflows/);
    assert.match(joined, /headless-wf/);
    assert.match(joined, /Resume with: \/workflow resume <id>/);
  });

  test("targeted stale running durable resume does not print stale catalog", async () => {
    const runtime = {
      registry: { has: () => false },
      prepareDurableResumable: async () => [{
        workflowId: "stale-running-id",
        name: "stale-running-wf",
        status: "running" as const,
        completedCheckpoints: 0,
        pendingPrompts: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
      resumeDurableWorkflow: () => ({
        ok: false as const,
        reason: "workflow_not_found" as const,
        message: "Workflow definition not found: stale-running-wf",
      }),
    } as unknown as ExtensionRuntime;
    const messages: string[] = [];

    await handleRunControlCommand("resume", ["stale-running-id"], { hasUI: false, ui: { notify: () => undefined } }, {
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
    }, {
      pi: buildMockPi().pi,
      overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
      getPersistence: () => undefined,
      runtimeForContext: () => runtime,
      ensureWorkflowResourcesLoaded: () => undefined,
    });

    const joined = messages.join("\n");
    assert.match(joined, /Workflow definition not found/);
    assert.doesNotMatch(joined, /Resumable workflows/);
  });


  test("no-arg resume with no resumable workflows opens empty /resume-style selector", async () => {
    const { pi, commands } = buildMockPi();
    factory(pi);
    const { ctx, customCalls, messages } = buildPrintCtxWithRealCustom();

    const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
    await delay(5);

    assert.equal(messages.length, 0);
    assert.ok(customCalls.length >= 1);
    const rendered = visibleText(customCalls[0]!.component.render(100));
    assert.match(rendered, /Resume Session \(Current Folder\)/);
    assert.doesNotMatch(rendered, /No resumable workflow runs found/);

    customCalls[0]!.component.handleInput?.("\u001b");
    await handlerPromise;
  });

  test("no-arg durable picker renders the /resume selector chrome", async () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-tree-ui", name: "durable-tree-wf", inputs: {}, createdAt: Date.now(), status: "paused", completedCheckpoints: 1 });
    setDurableBackend(backend);
    const { pi, commands } = buildMockPi();
    factory(pi);
    const { ctx, customCalls } = buildPrintCtxWithRealCustom();

    const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
    await delay(5);

    assert.ok(customCalls.length >= 1);
    const rendered = visibleText(customCalls[0]!.component.render(100));
    assert.match(rendered, /Resume Session \(Current Folder\)/);
    assert.match(rendered, /durable-tree-wf\s+paused\s+1 checkpoints/);
    assert.doesNotMatch(rendered, /Resumable workflows/);

    customCalls[0]!.component.handleInput?.("\u001b");
    await handlerPromise;
  });

  test("no-arg durable picker hides stale failed/running entries without current definitions", async () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "old-failed-run", name: "old-missing-definition", inputs: {}, createdAt: Date.now(), status: "failed" });
    backend.registerWorkflow({ workflowId: "old-running-run", name: "old-running-definition", inputs: {}, createdAt: Date.now(), status: "running", completedCheckpoints: 1 });
    backend.registerWorkflow({ workflowId: "visible-paused-run", name: "visible-paused-definition", inputs: {}, createdAt: Date.now(), status: "paused", completedCheckpoints: 1 });
    setDurableBackend(backend);
    const { pi, commands } = buildMockPi();
    factory(pi);
    const { ctx, customCalls } = buildPrintCtxWithRealCustom();

    const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
    await delay(5);

    assert.ok(customCalls.length >= 1);
    const rendered = visibleText(customCalls[0]!.component.render(100));
    assert.doesNotMatch(rendered, /old-missing-definition/);
    assert.doesNotMatch(rendered, /old-running-definition/);
    assert.match(rendered, /visible-paused-definition/);

    customCalls[0]!.component.handleInput?.("\u001b");
    await handlerPromise;
  });
  test("no-arg durable picker resolves selection before dispose", async () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-select-race", name: "missing-selection-def", inputs: {}, createdAt: Date.now(), status: "paused", completedCheckpoints: 1 });
    setDurableBackend(backend);
    const { pi, commands } = buildMockPi();
    factory(pi);
    const { ctx, customCalls, messages } = buildPrintCtxWithRealCustom();

    const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
    await delay(5);
    assert.ok(customCalls.length >= 1);
    customCalls[0]!.component.handleInput?.("\r");
    await handlerPromise;

    const joined = messages.join("\n");
    assert.match(joined, /Workflow definition not found: missing-selection-def/);
    assert.doesNotMatch(joined, /Resume with: \/workflow resume <id>/);
  });

  test("combined picker resolves live selection before dispose", async () => {
    const now = Date.now();
    const liveRunId = `live-select-${now}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "live-select-wf", inputs: {}, status: "running", stages: [], startedAt: now });
    singletonStore.recordRunPaused(liveRunId, now + 2);
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-select-alongside", name: "durable-select", inputs: {}, createdAt: now, updatedAt: now + 1, status: "paused", completedCheckpoints: 1 });
    setDurableBackend(backend);
    const { pi, commands } = buildMockPi();
    factory(pi);
    const { ctx, customCalls } = buildPrintCtxWithRealCustom();

    const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
    await delay(5);
    assert.ok(customCalls.length >= 1);
    customCalls[0]!.component.handleInput?.("\r");
    await handlerPromise;

    assert.ok(customCalls.some((call) => call.options.overlay === true));
  });

  test("combined picker resumes failed live runs through continuation path", async () => {
    const now = Date.now();
    const failedRunId = `failed-live-${now}`;
    singletonStore.recordRunStart({ id: failedRunId, name: "missing-continuation-wf", inputs: {}, status: "running", stages: [], startedAt: now });
    singletonStore.recordRunEnd(failedRunId, "failed", undefined, "recoverable", {
      failureRecoverability: "recoverable",
      failureDisposition: "terminal_failed",
      failedStageId: "failed-stage",
      resumable: true,
    });
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-with-failed-live", name: "durable-select", inputs: {}, createdAt: now - 2, updatedAt: now - 1, status: "paused", completedCheckpoints: 1 });
    setDurableBackend(backend);
    const { pi, commands } = buildMockPi();
    factory(pi);
    const { ctx, customCalls, messages } = buildPrintCtxWithRealCustom();

    const handlerPromise = commands["workflow"]!.options.handler("resume", ctx);
    await delay(5);
    assert.ok(customCalls.length >= 1);
    customCalls[0]!.component.handleInput?.("\r");
    await handlerPromise;

    const joined = messages.join("\n");
    assert.match(joined, /missing-continuation-wf/);
    assert.doesNotMatch(joined, /Snapshot available/);
  });
});
