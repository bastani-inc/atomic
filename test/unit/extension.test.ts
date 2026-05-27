import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, { type ExtensionAPI } from "../../packages/workflows/src/extension/index.js";

test("extension factory is a function", () => {
  assert.equal(typeof factory, "function");
});

test("extension factory runs without error (no-op)", () => {
  // Phase A: factory accepts any API object and does nothing.
  assert.doesNotThrow(() => factory({}));
});

test("session_start warns when discovered workflows fail validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "atomic-workflow-warning-"));
  try {
    const workflowDir = join(root, "workflows");
    mkdirSync(workflowDir, { recursive: true });
    const workflowPath = join(workflowDir, "invalid-shape.js");
    writeFileSync(
      workflowPath,
      [
        "export default {",
        "  name: 'Invalid Workflow',",
        "  normalizedName: 'invalid-workflow',",
        "  description: 'invalid because it is missing the workflow sentinel',",
        "  inputs: {},",
        "  run: async () => ({ ok: true }),",
        "};",
      ].join("\n"),
      "utf-8",
    );

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
    const notifications: Array<{ message: string; type?: string }> = [];
    const pi: ExtensionAPI = {
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerMessageRenderer: () => undefined,
      registerFlag: () => undefined,
      registerShortcut: () => undefined,
      getWorkflowResources: () => [{ path: workflowPath, enabled: true }],
      on: (event, handler) => {
        handlers.set(event, handler as (event: unknown, ctx: unknown) => Promise<void> | void);
      },
    };

    factory(pi);
    const sessionStart = handlers.get("session_start");
    assert.notEqual(sessionStart, undefined);

    await sessionStart?.({}, {
      ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notifications.push({ message, type });
        },
      },
    });

    const warning = notifications.find((entry) => entry.message.includes("Workflow discovery diagnostics"));
    assert.notEqual(warning, undefined);
    assert.equal(warning?.type, "warning");
    assert.match(warning!.message, /invalid-shape\.js/);
    assert.match(warning!.message, /missing or incorrect __piWorkflow sentinel/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
