import { beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, { type ExtensionAPI } from "../../packages/workflows/src/extension/index.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
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

function captureHandlersWithActiveTools(activeTools: readonly string[]): {
  handlers: Map<string, SessionBeforeSwitchHandler>;
  setCalls: string[][];
} {
  const handlers = new Map<string, SessionBeforeSwitchHandler>();
  const setCalls: string[][] = [];
  let current = [...activeTools];
  const pi: ExtensionAPI = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: () => undefined,
    getActiveTools: () => [...current],
    setActiveTools: (names: string[]) => {
      current = [...names];
      setCalls.push([...names]);
    },
    on: (event, handler) => {
      handlers.set(event, handler as SessionBeforeSwitchHandler);
    },
    disableAsyncDiscovery: true,
  };
  factory(pi);
  return { handlers, setCalls };
}

function getSessionBeforeSwitchHandler(): SessionBeforeSwitchHandler {
  const handler = captureHandlers().get("session_before_switch");
  if (handler === undefined) {
    assert.fail("session_before_switch handler was not registered");
  }
  return handler;
}

function getSessionBeforeShutdownHandler(): SessionBeforeSwitchHandler {
  const handler = captureHandlers().get("session_before_shutdown");
  if (handler === undefined) {
    assert.fail("session_before_shutdown handler was not registered");
  }
  return handler;
}

beforeEach(() => {
  stageControlRegistry.clear();
  store.clear();
});

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
      assert.match(promptText, /1 in-flight workflow/i);
      assert.doesNotMatch(promptText, /1 in-flight workflows/i);
      assert.match(promptText, /clear workflow history tied to (the )?current session/i);
      assert.equal(store.runs().length, 1);
      assert.equal(store.runs()[0]?.endedAt, undefined);
    } finally {
      store.clear();
    }
  }
});

test("session_before_switch renders plural in-flight workflow counts", async () => {
  store.recordRunStart(workflowRun({ id: "run-1" }));
  store.recordRunStart(workflowRun({ id: "run-2" }));
  const handler = getSessionBeforeSwitchHandler();

  const prompts: Array<{ title: string; message?: string }> = [];
  const result = await handler({ reason: "new" }, {
    ui: {
      confirm: async (title: string, message?: string) => {
        prompts.push({ title, message });
        return true;
      },
    },
  });

  assert.equal(result, undefined);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]?.title ?? "", /2 in-flight workflows/i);
  assert.match(prompts[0]?.message ?? "", /2 in-flight workflows/i);
});

test("session_before_switch fails open when confirm throws", async () => {
  store.recordRunStart(workflowRun());
  const handler = getSessionBeforeSwitchHandler();

  const result = await handler({ reason: "new" }, {
    ui: {
      confirm: async () => {
        throw new Error("confirm unavailable");
      },
    },
  });

  assert.equal(result, undefined);
  assert.equal(store.runs().length, 1);
  assert.equal(store.runs()[0]?.endedAt, undefined);
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

test("session_before_shutdown confirms quit with active workflows and cancels by default", async () => {
  store.recordRunStart(workflowRun({ id: "run-1", stages: [{ id: "s1", name: "plan", status: "running", parentIds: [], toolEvents: [] }] }));
  const handler = getSessionBeforeShutdownHandler();
  const notifications: Array<{ message: string; type?: string }> = [];
  let customMounted = 0;

  const result = await handler({ reason: "quit" }, {
    ui: {
      custom: (factory: Function) => {
        customMounted += 1;
        const component = factory({ requestRender: () => undefined }, {}, {}, () => undefined);
        component.handleInput("n");
        return undefined;
      },
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  });

  assert.deepEqual(result, { cancel: true });
  assert.equal(customMounted, 1);
  assert.equal(notifications.at(-1)?.type, "info");
  assert.match(notifications.at(-1)?.message ?? "", /quit cancelled/i);
  assert.equal(store.runs()[0]?.endedAt, undefined);
});

test("session_before_shutdown allows quit after custom confirmation", async () => {
  store.recordRunStart(workflowRun({ id: "run-1" }));
  const handler = getSessionBeforeShutdownHandler();

  const result = await handler({ reason: "quit" }, {
    ui: {
      custom: (factory: Function) => {
        const component = factory({ requestRender: () => undefined }, {}, {}, () => undefined);
        component.handleInput("y");
        return undefined;
      },
      notify: () => undefined,
    },
  });

  assert.equal(result, undefined);
});

test("session_before_shutdown fails open without custom UI", async () => {
  store.recordRunStart(workflowRun({ id: "run-1" }));
  const handler = getSessionBeforeShutdownHandler();

  assert.equal(await handler({ reason: "quit" }, { ui: { notify: () => undefined } }), undefined);
});

test("session_before_shutdown fails open when hasUI is false even with no-op custom UI", async () => {
  store.recordRunStart(workflowRun({ id: "run-1" }));
  const handler = getSessionBeforeShutdownHandler();
  let customCalls = 0;

  const result = await handler({ reason: "quit" }, {
    hasUI: false,
    ui: {
      custom: () => {
        customCalls += 1;
        return undefined;
      },
      notify: () => undefined,
    },
  });

  assert.equal(result, undefined);
  assert.equal(customCalls, 0);
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
}, 15_000);

// ---------------------------------------------------------------------------
// Non-interactive (-p) mode: the `workflow` tool remains available so
// deterministic workflows can run through the tool or `/workflow`.
// ---------------------------------------------------------------------------

test("session_shutdown quit disposes retained completed stage handles", async () => {
  let disposed = 0;
  stageControlRegistry.register({
    runId: "run-1",
    stageId: "stage-1",
    stageName: "completed-stage",
    status: "completed",
    sessionId: "session-1",
    sessionFile: undefined,
    isStreaming: false,
    messages: [],
    async ensureAttached() {},
    async prompt() {},
    async steer() {},
    async followUp() {},
    async pause() {},
    async resume() {},
    subscribe() {
      return () => {};
    },
    dispose() {
      disposed += 1;
    },
  });
  stageControlRegistry.detachControl("run-1", "stage-1");

  const handlers = captureHandlers();
  const sessionShutdown = handlers.get("session_shutdown");
  assert.notEqual(sessionShutdown, undefined);

  await sessionShutdown?.({ reason: "quit" });

  assert.equal(disposed, 1);
  assert.equal(stageControlRegistry.get("run-1", "stage-1"), undefined);
});

test("session_start removes ask_user_question but keeps workflow in non-interactive sessions", async () => {
  const { handlers, setCalls } = captureHandlersWithActiveTools([
    "read",
    "bash",
    "workflow",
    "ask_user_question",
    "todo",
  ]);
  const sessionStart = handlers.get("session_start");
  assert.notEqual(sessionStart, undefined);

  await sessionStart?.({ reason: "startup" }, { hasUI: false });

  assert.deepEqual(setCalls, [["read", "bash", "workflow", "todo"]]);
});

test("session_start leaves active tools unchanged when a UI is available", async () => {
  const { handlers, setCalls } = captureHandlersWithActiveTools(["read", "workflow", "ask_user_question"]);
  const sessionStart = handlers.get("session_start");

  await sessionStart?.({ reason: "startup" }, { hasUI: true });

  assert.deepEqual(setCalls, []);
});

test("session_start leaves the active tool set untouched when ask_user_question is already absent", async () => {
  const { handlers, setCalls } = captureHandlersWithActiveTools(["read", "bash", "workflow"]);
  const sessionStart = handlers.get("session_start");

  await sessionStart?.({ reason: "startup" }, { hasUI: false });

  assert.deepEqual(setCalls, []);
});

test("session_start does not throw on hosts without the active-tools API", async () => {
  const handlers = captureHandlers();
  const sessionStart = handlers.get("session_start");
  assert.notEqual(sessionStart, undefined);

  await assert.doesNotReject(Promise.resolve(sessionStart?.({ reason: "startup" }, { hasUI: false })));
});
