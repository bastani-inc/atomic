import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, { type ExtensionAPI } from "../../packages/workflows/src/extension/index.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

type SessionBeforeSwitchHandler = (event?: unknown, ctx?: unknown) => unknown;

function workflowRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "run-1",
    name: "Test workflow",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
    ...overrides,
  };
}

function captureHandlers(): Map<string, SessionBeforeSwitchHandler> {
  const handlers = new Map<string, SessionBeforeSwitchHandler>();
  const pi: ExtensionAPI = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: () => undefined,
    on: (event, handler) => {
      handlers.set(event, handler as SessionBeforeSwitchHandler);
    },
    disableAsyncDiscovery: true,
  };
  factory(pi);
  return handlers;
}

function getSessionBeforeSwitchHandler(): SessionBeforeSwitchHandler {
  const handler = captureHandlers().get("session_before_switch");
  if (handler === undefined) {
    assert.fail("session_before_switch handler was not registered");
  }
  return handler;
}

test("extension factory is a function", () => {
  assert.equal(typeof factory, "function");
});

test("extension factory runs without error (no-op)", () => {
  // Phase A: factory accepts any API object and does nothing.
  assert.doesNotThrow(() => factory({}));
});

test("session_before_switch prompts for /new and /resume when workflows are in flight", async () => {
  for (const reason of ["new", "resume"] as const) {
    store.clear();
    try {
      store.recordRunStart(workflowRun());
      const handler = getSessionBeforeSwitchHandler();

      const prompts: Array<{ title: string; message?: string }> = [];
      const result = await handler({ reason }, {
        ui: {
          confirm: async (title: string, message?: string) => {
            prompts.push({ title, message });
            return true;
          },
        },
      });

      assert.equal(result, undefined);
      assert.equal(prompts.length, 1);
      const promptText = `${prompts[0]?.title}\n${prompts[0]?.message}`;
      assert.match(promptText, reason === "new" ? /new session/i : /resume another session/i);
      assert.match(promptText, /stop|kill/i);
      assert.match(promptText, /in-flight workflows/i);
      assert.match(promptText, /clear workflow history tied to (the )?current session/i);
      assert.equal(store.runs().length, 1);
      assert.equal(store.runs()[0]?.endedAt, undefined);
    } finally {
      store.clear();
    }
  }
});

test("session_before_switch cancels /new and /resume when warning is declined", async () => {
  for (const reason of ["new", "resume"] as const) {
    store.clear();
    try {
      store.recordRunStart(workflowRun());
      const handler = getSessionBeforeSwitchHandler();
      const notifications: Array<{ message: string; type?: string }> = [];

      const result = await handler({ reason }, {
        ui: {
          confirm: async () => false,
          notify: (message: string, type?: string) => notifications.push({ message, type }),
        },
      });

      assert.deepEqual(result, { cancel: true });
      assert.equal(store.runs().length, 1);
      assert.equal(store.runs()[0]?.endedAt, undefined);
      assert.equal(notifications.at(-1)?.type, "info");
      assert.match(notifications.at(-1)?.message ?? "", reason === "new" ? /New session cancelled/i : /Resume cancelled/i);
    } finally {
      store.clear();
    }
  }
});

test("session_before_switch does not prompt without in-flight workflows", async () => {
  store.clear();
  try {
    store.recordRunStart(workflowRun({ id: "done", status: "running" }));
    store.recordRunEnd("done", "completed", {});
    const handler = getSessionBeforeSwitchHandler();
    let confirmCalls = 0;

    assert.equal(
      await handler({ reason: "new" }, { ui: { confirm: async () => { confirmCalls += 1; return false; } } }),
      undefined,
    );
    assert.equal(confirmCalls, 0);
  } finally {
    store.clear();
  }
});

test("session_before_switch does not prompt for unrelated switch reasons", async () => {
  store.clear();
  try {
    store.recordRunStart(workflowRun());
    const handler = getSessionBeforeSwitchHandler();
    let confirmCalls = 0;

    assert.equal(
      await handler({ reason: "fork" }, { ui: { confirm: async () => { confirmCalls += 1; return false; } } }),
      undefined,
    );
    assert.equal(confirmCalls, 0);
  } finally {
    store.clear();
  }
});

test("session_before_switch does not prompt without confirm UI", async () => {
  store.clear();
  try {
    store.recordRunStart(workflowRun());
    const handler = getSessionBeforeSwitchHandler();

    assert.equal(await handler({ reason: "new" }, { ui: {} }), undefined);
    assert.equal(store.runs().length, 1);
  } finally {
    store.clear();
  }
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
