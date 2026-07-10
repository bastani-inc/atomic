import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  defaultStore,
  factory,
  getCommand,
  makeMock,
  runTool,
  waitForRun,
} from "./mock-extension-api-helpers.js";
import type {
  ExtensionAPI,
  PiCommandOptions,
  PiFlagNamedOpts,
  PiMessageRendererResult,
  PiToolOpts,
} from "./mock-extension-api-helpers.js";
import type {
  PiCustomComponent,
  PiCustomOverlayFunction,
} from "../../packages/workflows/src/extension/ui-surface.js";

describe("MockExtensionAPI — tool list returns bundled workflow names", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("action='list' returns bundled workflow names", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { inputs: {}, action: "list" });
    assert.equal(result.action, "list");
    const r = result as { action: "list"; items: { name: string }[] };
    const names = r.items.map((i) => i.name);
    assert.ok(names.includes("deep-research-codebase"));
    assert.ok(names.includes("ralph"));
    assert.ok(names.includes("open-claude-design"));
    assert.ok(r.items.length >= 3);
  });
});

describe("MockExtensionAPI — tool inputs returns schema for deep-research-codebase", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("action='inputs' for deep-research-codebase returns prompt and max_partitions fields", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "deep-research-codebase", inputs: {}, action: "inputs" });
    assert.equal(result.action, "inputs");
    const r = result as { action: "inputs"; name: string; inputs: Array<{ name: string; type: string; required?: boolean; default?: unknown }> };
    assert.equal(r.name, "deep-research-codebase");
    assert.notEqual(r.inputs, undefined);
    const byName = Object.fromEntries(r.inputs.map((i) => [i.name, i]));
    assert.notEqual(byName["prompt"], undefined);
    assert.equal(byName["prompt"]?.type, "text");
    assert.equal(byName["prompt"]?.required, true);
    assert.notEqual(byName["max_partitions"], undefined);
    assert.equal(byName["max_partitions"]?.type, "number");
    assert.equal(byName["max_partitions"]?.default, 100);
  });

  test("action='inputs' for deep-research-codebase has no error field", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "deep-research-codebase", inputs: {}, action: "inputs" });
    const r = result as { action: "inputs"; error?: string };
    assert.equal(r.error, undefined);
  });
});

describe("MockExtensionAPI — tool run returns non-placeholder runId and terminal status", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("action='run' for deep-research-codebase with prompt input returns non-placeholder runId", async () => {
    const execute = mock.tools[0]!.opts.execute;
    // deep-research-codebase requires prompt. Background dispatch returns
    // `status: "running"` synchronously with a real UUID runId; the eventual
    // terminal status (completed | failed) lives on the store after the
    // background promise settles.
    const result = await runTool(execute, { workflow: "deep-research-codebase", inputs: { prompt: "test query", max_partitions: 1 }, action: "run" });
    assert.equal(result.action, "run");
    const r = result as {
      action: "run";
      runId: string;
      status: string;
      stages: unknown[];
      error?: string;
    };
    // runId must be a non-empty non-placeholder value (real UUID).
    assert.equal(typeof r.runId, "string");
    assert.ok(r.runId.length > 0);
    assert.notEqual(r.runId, "");
    // Synchronous status from background dispatch is "running".
    assert.equal(r.status, "running");
    // stages is an empty array at dispatch time; the live snapshot lives on the store.
    assert.equal(Array.isArray(r.stages), true);

    // After the background promise settles, the store records a terminal status.
    await waitForRun(r.runId, { store: defaultStore });
    const settled = defaultStore.runs().find((run) => run.id === r.runId);
    assert.notEqual(settled, undefined);
    assert.ok(["completed", "failed"].includes(settled!.status));
  }, 15_000);

  test("action='run' for deep-research-codebase without adapters reports honest failure, not stub", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "deep-research-codebase", inputs: { prompt: "test", max_partitions: 1 }, action: "run" });
    const r = result as {
      action: "run";
      runId: string;
      status: string;
      stages: unknown[];
      error?: string;
    };
    // runId is minted synchronously by the background dispatch.
    assert.notEqual(r.runId, "");
    // The final terminal state lives on the store after the background promise settles.
    await waitForRun(r.runId, { store: defaultStore });
    const settled = defaultStore.runs().find((run) => run.id === r.runId);
    assert.notEqual(settled, undefined);
    // When no adapters and complete adapter is missing, the workflow should fail honestly.
    // A "failed" run must carry an error message (not placeholder text like "not yet implemented").
    if (settled!.status === "failed") {
      assert.notEqual(settled!.error, undefined);
      assert.ok(!settled!.error!.includes("not yet implemented"));
      assert.ok(!settled!.error!.includes("Phase B stub"));
    }
  });

  test("action='run' for unknown workflow returns non-placeholder empty runId string with failed status", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "nonexistent-workflow-xyz", inputs: {}, action: "run" });
    const r = result as { action: "run"; runId: string; status: string; error?: string };
    assert.equal(r.status, "failed");
    assert.ok(r.error!.includes("nonexistent-workflow-xyz"));
    // not-found returns "" as runId (documented behaviour: empty sentinel for not-found)
    assert.equal(r.runId, "");
  });
});

// ---------------------------------------------------------------------------
// Slash command registration — no bundled workflow aliases
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — no slash aliases for bundled workflows", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("no workflow:<name> commands are registered", () => {
    assert.equal(
      mock.commands.some((command) => command.name.startsWith("workflow:")),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Completions include admin subcommands and workflow names
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — completions include admin subcommands and workflow names", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("/workflow completions include all admin subcommands and all bundled workflow names", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = await cmd.options.getArgumentCompletions?.("") ?? [];
    const labels = completions.map((c) => c.label);

    // Admin subcommands
    for (const sub of ["list", "status", "connect", "interrupt", "resume", "inputs"]) {
      assert.ok(labels.includes(sub));
    }
    assert.equal(labels.includes("session"), false);

    // Bundled workflow names
    assert.ok(labels.includes("deep-research-codebase"));
    assert.ok(labels.includes("ralph"));
    assert.ok(labels.includes("open-claude-design"));
  });

  test("/workflow completions filter partial 'deep' to workflow name", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = await cmd.options.getArgumentCompletions?.("deep") ?? [];
    const labels = completions.map((c) => c.label);
    assert.ok(labels.includes("deep-research-codebase"));
    assert.equal(labels.every((l) => l.startsWith("deep")), true);
  });
});

// ---------------------------------------------------------------------------
// /workflow deep-research-codebase prompt=test dispatches run, not unknown subcommand
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — /workflow <name> dispatches run not unknown-subcommand", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("/workflow deep-research-codebase prompt=test dispatches run (not unknown subcommand)", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    await cmd.options.handler("deep-research-codebase prompt=test", { ui: { notify: (m: string) => messages.push(m) } });

    // Must not say "unknown subcommand"
    assert.equal(messages.some((m) => m.toLowerCase().includes("unknown subcommand")), false);

    // Must print a dispatch confirmation or a failure — never silent.
    // The success path now emits via pi.sendMessage (kind: "dispatch")
    // instead of ctx.ui.notify; either signal counts as evidence the
    // handler resolved without the unknown-subcommand fallback.
    const dispatchedSent = mock.sent.some(
      (m) => (m.details as { kind?: string } | undefined)?.kind === "dispatch",
    );
    const errored = messages.some(
      (m) =>
        m.includes("completed") ||
        m.includes("failed") ||
        m.includes("Workflow not found"),
    );
    assert.equal(dispatchedSent || errored, true);
  });
});

describe("MockExtensionAPI — workflow input picker capability gates", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("custom-only UI hosts reach the inline workflow input form", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    let customMounts = 0;
    const custom: PiCustomOverlayFunction = (mountFactory) => {
      customMounts++;
      const componentPromise = Promise.resolve(mountFactory(
        { requestRender: () => undefined },
        {},
        {},
        () => undefined,
      ));
      void componentPromise.then((component: PiCustomComponent) => component.dispose?.());
      return { kind: "cancel" };
    };

    await cmd.options.handler("deep-research-codebase", {
      ui: { notify: (message: string) => messages.push(message), custom },
    });

    assert.equal(customMounts, 1);
    assert.ok(
      mock.sent.some((message) => message.customType === "workflows:input-form"),
      "custom-only hosts should open the inline form instead of skipping to the fallback picker",
    );
  });
});

// ---------------------------------------------------------------------------
// Registered tool — list/status without name or inputs (schema-tool-args: optional fields)
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — tool list/status without name or inputs", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  // Schema: name and inputs must NOT appear in the required array
  test("schema has no required fields — name absent from required", () => {
    const params = mock.tools[0]!.opts.parameters as { required?: string[] };
    assert.ok(!(params.required ?? []).includes("name"));
  });

  test("schema has no required fields — inputs absent from required", () => {
    const params = mock.tools[0]!.opts.parameters as { required?: string[] };
    assert.ok(!(params.required ?? []).includes("inputs"));
  });

  // Tool execute: { action: "list" } — no name, no inputs
  test("execute({ action: 'list' }) returns action='list'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { action: "list" });
    assert.equal(result.action, "list");
  });

  test("execute({ action: 'list' }) returns items array", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { action: "list" });
    const r = result as { action: "list"; items: unknown[] };
    assert.equal(Array.isArray(r.items), true);
  });

  test("execute({ action: 'list' }) items includes bundled names", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { action: "list" });
    const r = result as { action: "list"; items: { name: string }[] };
    assert.ok(r.items.some((i) => i.name === "deep-research-codebase"));
  });

  // Tool execute: { action: "status" } — no name, no inputs
  test("execute({ action: 'status' }) returns action='status'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { action: "status" });
    assert.equal(result.action, "status");
  });

  test("execute({ action: 'status' }) returns snapshots array", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { action: "status" });
    const r = result as { action: "status"; snapshots: unknown[] };
    assert.equal(Array.isArray(r.snapshots), true);
  });

});

// ---------------------------------------------------------------------------
// Graceful degradation — empty API object
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — graceful degradation", () => {
  test("factory({}) does not throw", () => {
    assert.doesNotThrow(() => factory({}));
  });

  test("factory with partial API (only registerTool) does not throw", () => {
    const api: ExtensionAPI = {
      registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
        void opts;
      },
    };
    assert.doesNotThrow(() => factory(api));
  });

  test("factory with partial API (only registerCommand) does not throw", () => {
    const api: ExtensionAPI = {
      registerCommand(_name: string, options: PiCommandOptions) {
        void options;
      },
    };
    assert.doesNotThrow(() => factory(api));
  });

  test("factory with partial API (only registerMessageRenderer) does not throw", () => {
    const api: ExtensionAPI = {
      registerMessageRenderer(event: string, renderer: (payload: Record<string, unknown>) => PiMessageRendererResult) {
        void event;
        void renderer;
      },
    };
    assert.doesNotThrow(() => factory(api));
  });

  test("factory with partial API (only registerFlag) does not throw", () => {
    const api: ExtensionAPI = {
      registerFlag(name: string, opts: PiFlagNamedOpts) {
        void name; void opts;
      },
    };
    assert.doesNotThrow(() => factory(api));
  });
});

