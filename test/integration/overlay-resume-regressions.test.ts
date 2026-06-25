import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import type { ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import type { WorkflowExecutionPolicy } from "../../packages/workflows/src/shared/types.js";
import { buildMockPi, buildPrintCtxWithRealCustom, delay, factory, singletonStore } from "./overlay-entrypoints-helpers.js";

describe("/workflow resume — durable regression coverage", () => {
  beforeEach(() => {
    singletonStore.clear();
    setDurableBackend(new InMemoryDurableBackend());
  });

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
    });

    assert.equal(capturedPolicy?.mode, "non_interactive");
    assert.equal(messages.some((message) => message.includes("missing")), true);
  });

  test("no-arg durable picker resolves selection before dispose", async () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-select-race", name: "missing-selection-def", inputs: {}, createdAt: Date.now(), status: "paused" });
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
    const liveRunId = `live-select-${Date.now()}`;
    singletonStore.recordRunStart({ id: liveRunId, name: "live-select-wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunPaused(liveRunId);
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-select-alongside", name: "durable-select", inputs: {}, createdAt: Date.now(), status: "paused" });
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
    const failedRunId = `failed-live-${Date.now()}`;
    singletonStore.recordRunStart({ id: failedRunId, name: "missing-continuation-wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    singletonStore.recordRunEnd(failedRunId, "failed", undefined, "recoverable", {
      failureRecoverability: "recoverable",
      failureDisposition: "terminal_failed",
      failedStageId: "failed-stage",
      resumable: true,
    });
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "durable-with-failed-live", name: "durable-select", inputs: {}, createdAt: Date.now(), status: "paused" });
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
    assert.match(joined, /Workflow definition not found|Cannot resume failed run|missing-continuation-wf/);
    assert.doesNotMatch(joined, /Snapshot available/);
  });
});
