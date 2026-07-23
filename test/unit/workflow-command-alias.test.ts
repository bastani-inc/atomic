import { test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { registerWorkflowSlashCommand } from "../../packages/workflows/src/extension/workflow-command-registration.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import type { WorkflowCommandHandler } from "../../packages/workflows/src/extension/workflow-command-utils.js";
import type { GraphOverlayPort } from "../../packages/workflows/src/tui/overlay-adapter.js";

const overlay: GraphOverlayPort = {
  open: () => {},
  toggle: () => {},
  close: () => {},
};

test("registers /workflows as the durable run-history alias", () => {
  setDurableBackend(new InMemoryDurableBackend());
  try {
    const handlers = new Map<string, WorkflowCommandHandler>();
    const registered: string[] = [];
    const pi: ExtensionAPI = {
      registerCommand(name) { registered.push(name); },
    };
    const runtime = createExtensionRuntime();
    registerWorkflowSlashCommand(pi, handlers, {
      runtimeProxy: runtime,
      runtimeForContext: () => runtime,
      overlay,
      reloadWorkflowResources: () => undefined,
      ensureWorkflowResourcesLoaded: () => undefined,
      runWithLifecycleSuppressedForPolicy: (_policy, run) => run(),
      runControl: {
        pi,
        overlay,
        runtimeForContext: () => runtime,
        ensureWorkflowResourcesLoaded: () => undefined,
      },
    });

    assert.equal(handlers.has("workflow"), true);
    assert.equal(handlers.has("workflows"), true);
    assert.deepEqual(registered.filter((name) => name.startsWith("workflow")), ["workflow", "workflows"]);
  } finally {
    setDurableBackend(undefined);
  }
});
