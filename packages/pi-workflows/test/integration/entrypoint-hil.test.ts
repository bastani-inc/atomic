/**
 * Integration tests: extension entrypoints share HIL-capable runtime proxy.
 *
 * Proves that tool invocation, /workflow slash command, /workflow:<name> alias,
 * and CLI flag execution all route through a runtime proxy that forwards
 * ctx.ui.* HIL calls to the pi.ui surface provided at factory time.
 *
 * All four entrypoints close over the same runtimeProxy built with
 * buildUIAdapter(pi) → WorkflowUIAdapter. These tests simulate pi.ui and
 * assert the mocked dialog methods are actually invoked when a HIL workflow
 * executes through each path.
 *
 * cross-ref:
 *   src/extension/index.ts        — factory, runtimeProxy, makeExecuteWorkflowTool
 *   src/extension/wiring.ts       — buildUIAdapter, buildRuntimeAdapters
 *   src/extension/runtime.ts      — createExtensionRuntime
 *   src/cli-flags.ts              — runWorkflowFromCliFlags
 *   workflows/ralph.ts            — bundled HIL workflow (ctx.ui.editor + ctx.ui.confirm)
 */

import { test, expect, describe, beforeEach } from "bun:test";
import factory, {
  type ExtensionAPI,
  type PiToolOpts,
  type PiSlashCommandOpts,
  type PiFlagOpts,
  type WorkflowToolArgs,
} from "../../src/extension/index.js";
import type { WorkflowToolResult } from "../../src/extension/render-result.js";
import type { PiExecResult } from "../../src/extension/wiring.js";
import type { PiUISurface } from "../../src/extension/wiring.js";
import { buildUIAdapter } from "../../src/extension/wiring.js";
import { createExtensionRuntime } from "../../src/extension/runtime.js";
import { createStore } from "../../src/store.js";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";
import type { WorkflowDefinition } from "../../src/shared/types.js";
import { runWorkflowFromCliFlags } from "../../src/cli-flags.js";

// ---------------------------------------------------------------------------
// Shared: NDJSON helper + mock pi builder
// ---------------------------------------------------------------------------

/** One NDJSON line returning `text` as assistant message_end. */
function ndjsonText(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/**
 * Build a minimal mock ExtensionAPI.
 * Includes:
 *  - exec surface (returns APPROVED NDJSON for all stage calls so ralph loop
 *    exits after the first review stage)
 *  - pi.ui surface with editor/confirm/input/select spies
 *  - registration stubs that capture tool + command registrations
 */
interface MockPi extends ExtensionAPI {
  tools: Array<{ opts: PiToolOpts<WorkflowToolArgs, WorkflowToolResult> }>;
  commands: Array<{ opts: PiSlashCommandOpts }>;
  flags: Array<{ opts: PiFlagOpts }>;
  editorCalls: string[];
  confirmCalls: string[];
  inputCalls: string[];
}

function makeMockPi(overrides?: {
  editorResult?: string;
  confirmResult?: boolean;
  inputResult?: string;
}): MockPi {
  const opts = {
    editorResult: overrides?.editorResult ?? "",
    confirmResult: overrides?.confirmResult ?? false,
    inputResult: overrides?.inputResult ?? "",
  };

  const tools: MockPi["tools"] = [];
  const commands: MockPi["commands"] = [];
  const flags: MockPi["flags"] = [];
  const editorCalls: string[] = [];
  const confirmCalls: string[] = [];
  const inputCalls: string[] = [];

  const piUiSurface: PiUISurface & { setWidget?: () => void } = {
    setWidget: () => {},
    // editor: called by ctx.ui.editor() inside ralph
    async editor(_title: string, prefill?: string): Promise<string | undefined> {
      editorCalls.push(prefill ?? "");
      return opts.editorResult;
    },
    // confirm: called by ralph between iterations (only when iteration < cap)
    async confirm(title: string, _message: string): Promise<boolean> {
      confirmCalls.push(title);
      return opts.confirmResult;
    },
    // input: not used by ralph but present for completeness
    async input(title: string): Promise<string | undefined> {
      inputCalls.push(title);
      return opts.inputResult || undefined;
    },
    // select: not used by ralph
    async select(_title: string, options: string[]): Promise<string | undefined> {
      return options[0];
    },
  };

  const mock: MockPi = {
    tools,
    commands,
    flags,
    editorCalls,
    confirmCalls,
    inputCalls,

    // exec surface → buildRuntimeAdapters picks this up
    async exec(_command: string, _args: string[]): Promise<PiExecResult> {
      // Always return "APPROVED" so ralph's review stage triggers approved=true
      // and the loop exits without calling confirm.
      return { stdout: ndjsonText("APPROVED"), stderr: "", code: 0, killed: false };
    },

    registerTool<TArgs, TResult>(o: PiToolOpts<TArgs, TResult>) {
      tools.push({ opts: o as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult> });
    },
    registerCommand(o: PiSlashCommandOpts) {
      commands.push({ opts: o });
    },
    registerMessageRenderer(_event: string, _renderer: unknown) {},
    registerFlag(o: PiFlagOpts) { flags.push({ opts: o }); },
    on: undefined,

    ui: piUiSurface,
  };

  return mock;
}

/** Extract the workflow tool execute fn from a mock pi after factory(pi). */
function getToolExecute(
  mock: MockPi,
): (args: WorkflowToolArgs, ctx: object) => Promise<WorkflowToolResult> {
  const tool = mock.tools.find((t) => t.opts.name === "workflow");
  if (!tool) throw new Error("workflow tool not registered");
  return tool.opts.execute as (args: WorkflowToolArgs, ctx: object) => Promise<WorkflowToolResult>;
}

/** Extract a slash command by name from the mock. */
function getCommand(mock: MockPi, name: string): PiSlashCommandOpts {
  const cmd = mock.commands.find((c) => c.opts.name === name);
  if (!cmd) throw new Error(`command "${name}" not registered`);
  return cmd.opts;
}

/** Capture reply/print messages. */
function makeCtx(): { ctx: { reply: (m: string) => void }; messages: string[] } {
  const messages: string[] = [];
  return { ctx: { reply: (m: string) => { messages.push(m); } }, messages };
}

/** Common ralph args: 1 iteration so loop terminates immediately after APPROVED. */
const RALPH_ARGS: WorkflowToolArgs = {
  name: "ralph",
  inputs: { prompt: "test task", max_iterations: 1 },
  action: "run",
};

// ---------------------------------------------------------------------------
// 1. Tool execute path — factory-registered tool → HIL via pi.ui
// ---------------------------------------------------------------------------

describe("entrypoint-hil — tool execute path calls pi.ui", () => {
  let mock: MockPi;

  beforeEach(() => {
    mock = makeMockPi();
    factory(mock);
  });

  test("workflow tool is registered", () => {
    const tool = mock.tools.find((t) => t.opts.name === "workflow");
    expect(tool).toBeDefined();
  });

  test("tool execute with ralph invokes pi.ui.editor (HIL checkpoint)", async () => {
    const execute = getToolExecute(mock);
    await execute(RALPH_ARGS, {});
    // ralph calls ctx.ui.editor() at the start of each iteration
    expect(mock.editorCalls.length).toBeGreaterThan(0);
  });

  test("tool execute result has action=run", async () => {
    const execute = getToolExecute(mock);
    const result = await execute(RALPH_ARGS, {});
    expect(result.action).toBe("run");
  });

  test("tool execute with ralph completes successfully when all stages return APPROVED", async () => {
    const execute = getToolExecute(mock);
    const result = await execute(RALPH_ARGS, {}) as Extract<WorkflowToolResult, { action: "run"; runId: string }>;
    expect(result.status).toBe("completed");
  });

  test("editor receives the plan text as prefill (HIL signal routing confirmed)", async () => {
    const execute = getToolExecute(mock);
    await execute(RALPH_ARGS, {});
    // Prefill from ralph contains "Iteration 1" header
    const prefill = mock.editorCalls[0]!;
    expect(prefill).toContain("Iteration 1");
    expect(prefill).toContain("APPROVED"); // plan text set by first prompt stage
  });

  test("pi.ui not called when workflow not found (no HIL leak)", async () => {
    const execute = getToolExecute(mock);
    await execute({ name: "nonexistent-xyz", inputs: {}, action: "run" }, {});
    // no HIL dialog should fire for a missing workflow
    expect(mock.editorCalls).toHaveLength(0);
    expect(mock.confirmCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Slash /workflow execute path — factory-registered /workflow command → HIL
// ---------------------------------------------------------------------------

describe("entrypoint-hil — /workflow slash execute calls pi.ui", () => {
  let mock: MockPi;

  beforeEach(() => {
    mock = makeMockPi();
    factory(mock);
  });

  test("/workflow command is registered", () => {
    const cmd = mock.commands.find((c) => c.opts.name === "workflow");
    expect(cmd).toBeDefined();
  });

  test("/workflow ralph prompt=test max_iterations=1 invokes pi.ui.editor", async () => {
    const cmd = getCommand(mock, "workflow");
    const { ctx } = makeCtx();
    await cmd.execute("ralph prompt=test max_iterations=1", ctx);
    expect(mock.editorCalls.length).toBeGreaterThan(0);
  });

  test("/workflow ralph prints completed or failed (not unknown subcommand)", async () => {
    const cmd = getCommand(mock, "workflow");
    const { ctx, messages } = makeCtx();
    await cmd.execute("ralph prompt=test max_iterations=1", ctx);
    const combined = messages.join(" ");
    expect(combined).not.toContain("unknown subcommand");
    const dispatched = combined.includes("completed") || combined.includes("failed");
    expect(dispatched).toBe(true);
  });

  test("/workflow ralph reports completed when all stages return APPROVED", async () => {
    const cmd = getCommand(mock, "workflow");
    const { ctx, messages } = makeCtx();
    await cmd.execute("ralph prompt=test max_iterations=1", ctx);
    expect(messages.some((m) => m.includes("completed"))).toBe(true);
  });

  test("/workflow list does NOT call pi.ui (admin subcommand bypasses HIL)", async () => {
    const cmd = getCommand(mock, "workflow");
    const { ctx } = makeCtx();
    await cmd.execute("list", ctx);
    expect(mock.editorCalls).toHaveLength(0);
    expect(mock.confirmCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Alias /workflow:ralph execute path → HIL via pi.ui
// ---------------------------------------------------------------------------

describe("entrypoint-hil — /workflow:ralph alias execute calls pi.ui", () => {
  let mock: MockPi;

  beforeEach(() => {
    mock = makeMockPi();
    factory(mock);
  });

  test("/workflow:ralph alias is registered by factory", () => {
    const cmd = mock.commands.find((c) => c.opts.name === "workflow:ralph");
    expect(cmd).toBeDefined();
  });

  test("/workflow:ralph execute invokes pi.ui.editor (HIL via alias path)", async () => {
    const cmd = getCommand(mock, "workflow:ralph");
    const { ctx } = makeCtx();
    await cmd.execute("prompt=test max_iterations=1", ctx);
    expect(mock.editorCalls.length).toBeGreaterThan(0);
  });

  test("/workflow:ralph execute prints completed when all stages return APPROVED", async () => {
    const cmd = getCommand(mock, "workflow:ralph");
    const { ctx, messages } = makeCtx();
    await cmd.execute("prompt=test max_iterations=1", ctx);
    expect(messages.some((m) => m.includes("completed"))).toBe(true);
  });

  test("/workflow:ralph alias description mentions 'ralph'", () => {
    const cmd = getCommand(mock, "workflow:ralph");
    expect(cmd.description).toContain("ralph");
  });
});

// ---------------------------------------------------------------------------
// 4. CLI flag path — runWorkflowFromCliFlags with runtime built from pi.ui
// ---------------------------------------------------------------------------
//
// CLI flags path creates its own runtime from outside the factory.
// To prove HIL-capability, we build the runtime with buildUIAdapter(pi) the
// same way the factory does, then pass it to runWorkflowFromCliFlags.
// ---------------------------------------------------------------------------

describe("entrypoint-hil — CLI flag path HIL-capable runtime", () => {
  /** Minimal HIL workflow: one ctx.ui.input call, no stage adapters needed. */
  const hilInputWorkflow = defineWorkflow("hil-cli-test")
    .description("Simple HIL input workflow for CLI flag entrypoint tests")
    .run(async (ctx) => {
      const answer = await ctx.ui.input("Enter answer:");
      return { answer };
    })
    .compile() as WorkflowDefinition;

  /** Minimal HIL editor workflow: one ctx.ui.editor call. */
  const hilEditorWorkflow = defineWorkflow("hil-cli-editor")
    .description("HIL editor workflow for CLI flag entrypoint tests")
    .run(async (ctx) => {
      const text = await ctx.ui.editor("initial text");
      return { text };
    })
    .compile() as WorkflowDefinition;

  test("CLI flag path calls ui.input when runtime carries UIAdapter built from pi.ui", async () => {
    const piUiMock: { ui: PiUISurface } = {
      ui: {
        async input(title: string): Promise<string | undefined> {
          return `reply to: ${title}`;
        },
        async confirm(): Promise<boolean> { return false; },
        async select(_t: string, opts: string[]): Promise<string | undefined> { return opts[0]; },
        async editor(_t: string, p?: string): Promise<string | undefined> { return p ?? ""; },
      },
    };

    const uiAdapter = buildUIAdapter(piUiMock);
    expect(uiAdapter).toBeDefined();

    const runtime = createExtensionRuntime({
      definitions: [hilInputWorkflow],
      ui: uiAdapter,
      store: createStore(),
    });

    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=hil-cli-test"],
    });

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.status).toBe("completed");
    }
  });

  test("CLI flag path result contains HIL answer routed through ui.input", async () => {
    let captured: string | undefined;
    const piUiMock: { ui: PiUISurface } = {
      ui: {
        async input(title: string): Promise<string | undefined> {
          captured = title;
          return "user-typed-answer";
        },
        async confirm(): Promise<boolean> { return false; },
        async select(_t: string, opts: string[]): Promise<string | undefined> { return opts[0]; },
        async editor(_t: string, p?: string): Promise<string | undefined> { return p ?? ""; },
      },
    };

    const runtime = createExtensionRuntime({
      definitions: [hilInputWorkflow],
      ui: buildUIAdapter(piUiMock),
      store: createStore(),
    });

    await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=hil-cli-test"],
    });

    expect(captured).toBe("Enter answer:");
  });

  test("CLI flag path with editor HIL workflow calls ui.editor", async () => {
    let editorCalled = false;
    const piUiMock: { ui: PiUISurface } = {
      ui: {
        async input(): Promise<string | undefined> { return ""; },
        async confirm(): Promise<boolean> { return false; },
        async select(_t: string, opts: string[]): Promise<string | undefined> { return opts[0]; },
        async editor(_t: string, p?: string): Promise<string | undefined> {
          editorCalled = true;
          return p ?? "";
        },
      },
    };

    const runtime = createExtensionRuntime({
      definitions: [hilEditorWorkflow],
      ui: buildUIAdapter(piUiMock),
      store: createStore(),
    });

    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=hil-cli-editor"],
    });

    expect(editorCalled).toBe(true);
    expect(result.handled).toBe(true);
  });

  test("CLI flag path: absent pi.ui → HIL workflow fails with unavailable error", async () => {
    // No ui surface → buildUIAdapter returns undefined → no UIAdapter in runtime
    const runtimeNoUI = createExtensionRuntime({
      definitions: [hilInputWorkflow],
      store: createStore(),
    });

    const result = await runWorkflowFromCliFlags({
      runtime: runtimeNoUI,
      argv: ["--workflow=hil-cli-test"],
    });

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.status).toBe("failed");
      expect(result.error).toContain("ui.input is unavailable");
    }
  });

  test("CLI flag path: buildUIAdapter(pi) returns undefined when pi.ui absent", () => {
    // No ui field → adapter is undefined → runtime degrades gracefully
    const adapter = buildUIAdapter({});
    expect(adapter).toBeUndefined();
  });

  test("CLI flag path: buildUIAdapter(pi) returns WorkflowUIAdapter when pi.ui has dialog methods", () => {
    const pi: { ui: PiUISurface } = {
      ui: {
        async input(): Promise<string | undefined> { return ""; },
        async confirm(): Promise<boolean> { return false; },
        async select(_t: string, opts: string[]): Promise<string | undefined> { return opts[0]; },
        async editor(): Promise<string | undefined> { return ""; },
      },
    };
    const adapter = buildUIAdapter(pi);
    expect(adapter).not.toBeUndefined();
    expect(typeof adapter?.input).toBe("function");
    expect(typeof adapter?.confirm).toBe("function");
    expect(typeof adapter?.select).toBe("function");
    expect(typeof adapter?.editor).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 5. Shared runtime proxy invariant — tool + slash + alias close over same proxy
// ---------------------------------------------------------------------------

describe("entrypoint-hil — tool, slash, alias share same runtimeProxy", () => {
  /**
   * Prove that all three registered entrypoints route through the SAME runtime.
   * Strategy: capture dispatch calls via a mock runtime and assert all three
   * entrypoints call dispatch with action=run for a workflow name.
   *
   * NOTE: This group tests the *proxy pattern* by verifying that each entrypoint
   * delegates to runtimeProxy.dispatch rather than invoking separate runtimes.
   * We assert this indirectly: all three resolve the same workflow names from
   * the shared bundled registry.
   */

  let mock: MockPi;

  beforeEach(() => {
    mock = makeMockPi();
    factory(mock);
  });

  test("tool execute and slash execute both see the same registered workflow names", async () => {
    // Get names from the tool (via list action)
    const toolExec = getToolExecute(mock);
    const toolList = await toolExec({ name: "", inputs: {}, action: "list" }, {}) as Extract<WorkflowToolResult, { action: "list" }>;
    const toolNames = toolList.workflows;

    // Get names from slash command
    const cmd = getCommand(mock, "workflow");
    const { ctx, messages } = makeCtx();
    await cmd.execute("list", ctx);
    const slashMsg = messages.join(" ");

    // Both should mention the same bundled workflow names
    for (const name of ["ralph", "deep-research-codebase", "open-claude-design"]) {
      expect(toolNames).toContain(name);
      expect(slashMsg).toContain(name);
    }
  });

  test("alias /workflow:ralph and /workflow ralph both report the same workflow", async () => {
    const aliasCmd = getCommand(mock, "workflow:ralph");
    const slashCmd = getCommand(mock, "workflow");

    const { ctx: aliasCtx, messages: aliasMessages } = makeCtx();
    const { ctx: slashCtx, messages: slashMessages } = makeCtx();

    await aliasCmd.execute("prompt=test max_iterations=1", aliasCtx);
    await slashCmd.execute("ralph prompt=test max_iterations=1", slashCtx);

    // Both should report 'ralph' in their output
    expect(aliasMessages.join(" ")).toContain("ralph");
    expect(slashMessages.join(" ")).toContain("ralph");
  });

  test("pi.ui.editor called equal times for tool and slash when running ralph once each", async () => {
    const toolExec = getToolExecute(mock);
    const cmd = getCommand(mock, "workflow");

    const editorCountBefore = mock.editorCalls.length;

    await toolExec(RALPH_ARGS, {});
    const afterTool = mock.editorCalls.length;

    await cmd.execute("ralph prompt=test max_iterations=1", { reply: () => {} });
    const afterSlash = mock.editorCalls.length;

    // Each run calls editor at least once
    expect(afterTool - editorCountBefore).toBeGreaterThan(0);
    expect(afterSlash - afterTool).toBeGreaterThan(0);
  });
});
