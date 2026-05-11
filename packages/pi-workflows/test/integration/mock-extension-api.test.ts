/**
 * Integration tests: MockExtensionAPI registration.
 * Verifies factory(pi) registers workflow tool, slash commands,
 * message renderers, and CLI flags against a minimal MockExtensionAPI.
 *
 * cross-ref: spec §5.2 workflow tool, §5.3 slash commands,
 *            §5.6 renderer registration, §8.3 Phase B tests
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
import { renderCall } from "../../src/extension/render-call.js";
import { renderResult } from "../../src/extension/render-result.js";

// ---------------------------------------------------------------------------
// MockExtensionAPI
// ---------------------------------------------------------------------------

interface RegisteredTool {
  opts: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
}

interface RegisteredCommand {
  opts: PiSlashCommandOpts;
}

interface RegisteredRenderer {
  event: string;
  renderer: (payload: Record<string, unknown>) => string;
}

interface RegisteredFlag {
  opts: PiFlagOpts;
}

function makeMock(): ExtensionAPI & {
  tools: RegisteredTool[];
  commands: RegisteredCommand[];
  renderers: RegisteredRenderer[];
  flags: RegisteredFlag[];
} {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const renderers: RegisteredRenderer[] = [];
  const flags: RegisteredFlag[] = [];

  const api: ExtensionAPI & {
    tools: RegisteredTool[];
    commands: RegisteredCommand[];
    renderers: RegisteredRenderer[];
    flags: RegisteredFlag[];
  } = {
    tools,
    commands,
    renderers,
    flags,

    registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
      tools.push({ opts: opts as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult> });
    },

    registerCommand(opts: PiSlashCommandOpts) {
      commands.push({ opts });
    },

    registerMessageRenderer(event: string, renderer: (payload: Record<string, unknown>) => string) {
      renderers.push({ event, renderer });
    },

    registerFlag(opts: PiFlagOpts) {
      flags.push({ opts });
    },
  };

  return api;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCommand(commands: RegisteredCommand[], name: string): PiSlashCommandOpts | undefined {
  return commands.find((c) => c.opts.name === name)?.opts;
}

function getRenderer(
  renderers: RegisteredRenderer[],
  event: string,
): ((payload: Record<string, unknown>) => string) | undefined {
  return renderers.find((r) => r.event === event)?.renderer;
}

// ---------------------------------------------------------------------------
// Describe blocks
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — tool registration", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("registers exactly one tool", () => {
    expect(mock.tools).toHaveLength(1);
  });

  test("tool name is 'workflow'", () => {
    expect(mock.tools[0]!.opts.name).toBe("workflow");
  });

  test("tool has non-empty description", () => {
    expect(typeof mock.tools[0]!.opts.description).toBe("string");
    expect(mock.tools[0]!.opts.description.length).toBeGreaterThan(0);
  });

  test("tool has parameters schema (TypeBox object)", () => {
    const params = mock.tools[0]!.opts.parameters as Record<string, unknown>;
    expect(params).toBeDefined();
    // TypeBox TObject has a 'type' property equal to 'object'
    expect(params["type"]).toBe("object");
  });

  test("tool parameters include 'name', 'inputs', 'action' properties", () => {
    const params = mock.tools[0]!.opts.parameters as {
      properties: Record<string, unknown>;
    };
    expect(params.properties).toHaveProperty("name");
    expect(params.properties).toHaveProperty("inputs");
    expect(params.properties).toHaveProperty("action");
  });

  test("tool 'action' schema covers all six literals", () => {
    const params = mock.tools[0]!.opts.parameters as {
      properties: {
        action: { anyOf?: Array<{ const?: string; enum?: string[] }> };
      };
    };
    const actionSchema = params.properties.action;
    // TypeBox Optional(Union([...])) wraps in anyOf
    const raw = JSON.stringify(actionSchema);
    for (const literal of ["run", "list", "status", "kill", "resume", "inputs"]) {
      expect(raw).toContain(literal);
    }
  });

  test("tool execute returns run stub for default action", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await execute({ name: "my-workflow", inputs: {} }, {});
    expect(result.action).toBe("run");
  });

  test("tool execute returns list stub for action='list'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await execute({ name: "", inputs: {}, action: "list" }, {});
    expect(result.action).toBe("list");
    expect(Array.isArray((result as { action: "list"; workflows: string[] }).workflows)).toBe(true);
  });

  test("tool execute returns status stub for action='status'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await execute({ name: "", inputs: {}, action: "status" }, {});
    expect(result.action).toBe("status");
    expect(Array.isArray((result as { action: "status"; runs: unknown[] }).runs)).toBe(true);
  });

  test("tool execute returns inputs stub for action='inputs'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await execute({ name: "wf", inputs: {}, action: "inputs" }, {});
    expect(result.action).toBe("inputs");
    const r = result as { action: "inputs"; name: string; inputs: unknown[] };
    expect(r.name).toBe("wf");
    expect(Array.isArray(r.inputs)).toBe(true);
  });

  test("tool execute returns kill stub for action='kill'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await execute({ name: "run-123", inputs: {}, action: "kill" }, {});
    expect(result.action).toBe("kill");
  });

  test("tool execute returns resume stub for action='resume'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await execute({ name: "run-456", inputs: {}, action: "resume" }, {});
    expect(result.action).toBe("resume");
  });

  test("tool has renderCall slot", () => {
    expect(typeof mock.tools[0]!.opts.renderCall).toBe("function");
  });

  test("tool has renderResult slot", () => {
    expect(typeof mock.tools[0]!.opts.renderResult).toBe("function");
  });

  test("tool renderCall slot delegates correctly", () => {
    const slot = mock.tools[0]!.opts.renderCall!;
    const out = slot({ args: { name: "test-wf", inputs: {}, action: "run" } }, {}, {});
    expect(out).toContain("test-wf");
  });

  test("tool renderResult slot delegates correctly", () => {
    const slot = mock.tools[0]!.opts.renderResult!;
    const result: WorkflowToolResult = {
      action: "run",
      runId: "abc",
      status: "pending",
      message: "not yet implemented",
    };
    const out = slot({ result }, {}, {}, {});
    expect(out).toContain("abc");
  });
});

// ---------------------------------------------------------------------------
// Slash command registration
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — slash command registration", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("registers at least two commands", () => {
    expect(mock.commands.length).toBeGreaterThanOrEqual(2);
  });

  test("/workflow command registered", () => {
    expect(getCommand(mock.commands, "workflow")).toBeDefined();
  });

  test("/workflows-doctor command registered", () => {
    expect(getCommand(mock.commands, "workflows-doctor")).toBeDefined();
  });

  test("/workflow has non-empty description", () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    expect(cmd.description.length).toBeGreaterThan(0);
  });

  test("/workflows-doctor has non-empty description", () => {
    const cmd = getCommand(mock.commands, "workflows-doctor")!;
    expect(cmd.description.length).toBeGreaterThan(0);
  });

  test("/workflow execute with empty args calls reply/print", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    await cmd.execute("", { reply: (m) => messages.push(m) });
    expect(messages.length).toBeGreaterThan(0);
  });

  test("/workflow execute 'list' calls reply/print", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    await cmd.execute("list", { reply: (m) => messages.push(m) });
    expect(messages.length).toBeGreaterThan(0);
  });

  test("/workflow execute 'status' calls reply/print", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    await cmd.execute("status", { reply: (m) => messages.push(m) });
    expect(messages.length).toBeGreaterThan(0);
  });

  test("/workflow execute unknown arg calls reply/print", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    await cmd.execute("run my-wf", { reply: (m) => messages.push(m) });
    expect(messages.length).toBeGreaterThan(0);
  });

  test("/workflow execute falls back to ctx.print if no ctx.reply", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    await cmd.execute("", { print: (m) => messages.push(m) });
    expect(messages.length).toBeGreaterThan(0);
  });

  test("/workflow getArgumentCompletions returns all subcommands for empty partial", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = await cmd.getArgumentCompletions?.("");
    expect(Array.isArray(completions)).toBe(true);
    const labels = completions!.map((c) => c.label);
    for (const sub of ["list", "status", "kill", "resume", "inputs"]) {
      expect(labels).toContain(sub);
    }
  });

  test("/workflow getArgumentCompletions filters by partial", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = await cmd.getArgumentCompletions?.("li");
    expect(completions).toBeDefined();
    expect(completions!.length).toBeGreaterThan(0);
    expect(completions!.every((c) => c.label.startsWith("li"))).toBe(true);
  });

  test("/workflows-doctor execute returns multi-line doctor report", async () => {
    const cmd = getCommand(mock.commands, "workflows-doctor")!;
    const messages: string[] = [];
    await cmd.execute("", { reply: (m) => messages.push(m) });
    const combined = messages.join("\n");
    expect(combined).toContain("pi-workflows");
  });

  test("/workflows-doctor execute falls back to ctx.print", async () => {
    const cmd = getCommand(mock.commands, "workflows-doctor")!;
    const messages: string[] = [];
    await cmd.execute("", { print: (m) => messages.push(m) });
    expect(messages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Slash command registration via registerSlashCommand alias
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — registerSlashCommand alias", () => {
  test("registers /workflow via registerSlashCommand when registerCommand absent", () => {
    const commands: RegisteredCommand[] = [];
    const api: ExtensionAPI = {
      registerSlashCommand(opts: PiSlashCommandOpts) {
        commands.push({ opts });
      },
    };
    factory(api);
    const names = commands.map((c) => c.opts.name);
    expect(names).toContain("workflow");
    expect(names).toContain("workflows-doctor");
  });

  test("prefers registerCommand over registerSlashCommand when both present", () => {
    const commandLog: string[] = [];
    const slashLog: string[] = [];
    const api: ExtensionAPI = {
      registerCommand(opts: PiSlashCommandOpts) {
        commandLog.push(opts.name);
      },
      registerSlashCommand(opts: PiSlashCommandOpts) {
        slashLog.push(opts.name);
      },
    };
    factory(api);
    expect(commandLog.length).toBeGreaterThan(0);
    expect(slashLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Message renderer registration
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — message renderer registration", () => {
  const REQUIRED_EVENTS = [
    "workflow.run.start",
    "workflow.stage.start",
    "workflow.stage.progress",
    "workflow.stage.end",
    "workflow.run.end",
  ] as const;

  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  for (const event of REQUIRED_EVENTS) {
    test(`registers renderer for '${event}'`, () => {
      expect(getRenderer(mock.renderers, event)).toBeDefined();
    });
  }

  test("workflow.run.start renderer returns non-empty string", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.start")!;
    const out = renderer({ runId: "r1", name: "my-wf", inputs: { foo: "bar" } });
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("my-wf");
    expect(out).toContain("r1");
  });

  test("workflow.run.start renderer shows input count", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.start")!;
    const out = renderer({ runId: "r1", name: "wf", inputs: { a: 1, b: 2 } });
    expect(out).toContain("2");
  });

  test("workflow.stage.start renderer returns non-empty string", () => {
    const renderer = getRenderer(mock.renderers, "workflow.stage.start")!;
    const out = renderer({ runId: "r1", stageId: "s1", name: "stage-one" });
    expect(typeof out).toBe("string");
    expect(out).toContain("stage-one");
  });

  test("workflow.stage.start renderer includes model if provided", () => {
    const renderer = getRenderer(mock.renderers, "workflow.stage.start")!;
    const out = renderer({ runId: "r1", stageId: "s1", name: "s", model: "gpt-4o" });
    expect(out).toContain("gpt-4o");
  });

  test("workflow.stage.progress renderer returns non-empty string", () => {
    const renderer = getRenderer(mock.renderers, "workflow.stage.progress")!;
    const out = renderer({ runId: "r1", stageId: "s1", kind: "token" });
    expect(typeof out).toBe("string");
    expect(out).toContain("s1");
  });

  test("workflow.stage.end renderer ok status shows checkmark", () => {
    const renderer = getRenderer(mock.renderers, "workflow.stage.end")!;
    const out = renderer({ runId: "r1", stageId: "s1", status: "ok", durationMs: 100 });
    expect(out).toContain("✓");
    expect(out).toContain("100");
  });

  test("workflow.stage.end renderer error status shows error mark", () => {
    const renderer = getRenderer(mock.renderers, "workflow.stage.end")!;
    const out = renderer({ runId: "r1", stageId: "s1", status: "error" });
    expect(out).toContain("✗");
  });

  test("workflow.stage.end renderer includes summary if provided", () => {
    const renderer = getRenderer(mock.renderers, "workflow.stage.end")!;
    const out = renderer({ runId: "r1", stageId: "s1", status: "ok", summary: "done well" });
    expect(out).toContain("done well");
  });

  test("workflow.run.end renderer ok status shows success emoji", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.end")!;
    const out = renderer({ runId: "r1", status: "ok" });
    expect(out).toContain("✅");
    expect(out).toContain("r1");
  });

  test("workflow.run.end renderer error status shows failure emoji", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.end")!;
    const out = renderer({ runId: "r1", status: "error" });
    expect(out).toContain("❌");
  });

  test("skips renderer registration when registerMessageRenderer absent", () => {
    // No error thrown even without the method.
    expect(() => factory({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CLI flag registration
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — CLI flag registration", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("registers at least two flags", () => {
    expect(mock.flags.length).toBeGreaterThanOrEqual(2);
  });

  test("registers 'workflow' flag", () => {
    const flag = mock.flags.find((f) => f.opts.name === "workflow");
    expect(flag).toBeDefined();
  });

  test("'workflow' flag is type 'string'", () => {
    const flag = mock.flags.find((f) => f.opts.name === "workflow")!;
    expect(flag.opts.type).toBe("string");
  });

  test("'workflow' flag has non-empty description", () => {
    const flag = mock.flags.find((f) => f.opts.name === "workflow")!;
    expect(flag.opts.description.length).toBeGreaterThan(0);
  });

  test("registers 'workflow-input-key' flag", () => {
    const flag = mock.flags.find((f) => f.opts.name === "workflow-input-key");
    expect(flag).toBeDefined();
  });

  test("'workflow-input-key' flag is type 'string'", () => {
    const flag = mock.flags.find((f) => f.opts.name === "workflow-input-key")!;
    expect(flag.opts.type).toBe("string");
  });

  test("skips flag registration when registerFlag absent", () => {
    expect(() => factory({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// renderCall — standalone unit coverage (reachable export)
// ---------------------------------------------------------------------------

describe("renderCall — all action branches", () => {
  test("action='list' returns list string", () => {
    expect(renderCall({ action: "list" })).toBe("workflow: list registered workflows");
  });

  test("action='status' returns status string", () => {
    expect(renderCall({ action: "status" })).toBe("workflow: list in-flight runs");
  });

  test("action='inputs' includes name", () => {
    expect(renderCall({ name: "wf-a", action: "inputs" })).toContain("wf-a");
  });

  test("action='run' includes name", () => {
    expect(renderCall({ name: "wf-b", action: "run" })).toContain("wf-b");
  });

  test("action='kill' includes name", () => {
    expect(renderCall({ name: "run-1", action: "kill" })).toContain("run-1");
  });

  test("action='resume' includes name", () => {
    expect(renderCall({ name: "run-2", action: "resume" })).toContain("run-2");
  });

  test("defaults to 'run' when action omitted", () => {
    expect(renderCall({ name: "wf-c" })).toContain("run");
  });

  test("falls back to '(unnamed)' when name omitted", () => {
    expect(renderCall({})).toContain("(unnamed)");
  });
});

// ---------------------------------------------------------------------------
// renderResult — standalone unit coverage (reachable export)
// ---------------------------------------------------------------------------

describe("renderResult — all action branches", () => {
  test("action='list' empty workflows", () => {
    const out = renderResult({ action: "list", workflows: [] });
    expect(out).toContain("none");
  });

  test("action='list' with workflows", () => {
    const out = renderResult({ action: "list", workflows: ["wf-a", "wf-b"] });
    expect(out).toContain("wf-a");
    expect(out).toContain("wf-b");
  });

  test("action='status' empty runs", () => {
    const out = renderResult({ action: "status", runs: [] });
    expect(out).toContain("no in-flight");
  });

  test("action='status' with runs", () => {
    const out = renderResult({
      action: "status",
      runs: [{ runId: "r1", name: "wf", status: "running" }],
    });
    expect(out).toContain("r1");
    expect(out).toContain("running");
  });

  test("action='inputs' empty inputs", () => {
    const out = renderResult({ action: "inputs", name: "wf-x", inputs: [] });
    expect(out).toContain("wf-x");
    expect(out).toContain("no declared inputs");
  });

  test("action='inputs' with inputs", () => {
    const out = renderResult({
      action: "inputs",
      name: "wf-y",
      inputs: [
        { name: "param1", type: "string", required: true, description: "A param" },
      ],
    });
    expect(out).toContain("param1");
    expect(out).toContain("required");
  });

  test("action='run' non-partial shows message", () => {
    const out = renderResult(
      { action: "run", runId: "r42", status: "pending", message: "not yet" },
      { isPartial: false },
    );
    expect(out).toContain("not yet");
    expect(out).toContain("r42");
  });

  test("action='run' isPartial shows 'in progress'", () => {
    const out = renderResult(
      { action: "run", runId: "r42", status: "pending", message: "not yet" },
      { isPartial: true },
    );
    expect(out).toContain("in progress");
    expect(out).toContain("r42");
  });

  test("action='kill' shows message", () => {
    const out = renderResult({
      action: "kill",
      runId: "r10",
      status: "noop",
      message: "Kill not yet implemented",
    });
    expect(out).toContain("r10");
    expect(out).toContain("Kill not yet implemented");
  });

  test("action='resume' shows message", () => {
    const out = renderResult({
      action: "resume",
      runId: "r20",
      status: "noop",
      message: "Resume not yet implemented",
    });
    expect(out).toContain("r20");
    expect(out).toContain("Resume not yet implemented");
  });

  test("unknown action falls through to default", () => {
    const out = renderResult({ action: "unknown-action", message: "oops" } as WorkflowToolResult);
    expect(typeof out).toBe("string");
    expect(out).toContain("oops");
  });
});

// ---------------------------------------------------------------------------
// Runtime behavior — tool list/inputs/run with real bundled registry
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — tool list returns bundled workflow names", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("action='list' returns bundled workflow names", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await execute({ name: "", inputs: {}, action: "list" }, {});
    expect(result.action).toBe("list");
    const r = result as { action: "list"; workflows: string[] };
    expect(r.workflows).toContain("deep-research-codebase");
    expect(r.workflows).toContain("ralph");
    expect(r.workflows).toContain("open-claude-design");
    expect(r.workflows.length).toBeGreaterThanOrEqual(3);
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
    const result = await execute({ name: "deep-research-codebase", inputs: {}, action: "inputs" }, {});
    expect(result.action).toBe("inputs");
    const r = result as { action: "inputs"; name: string; inputs: Array<{ name: string; type: string; required?: boolean; default?: unknown }> };
    expect(r.name).toBe("deep-research-codebase");
    expect(r.inputs).toBeDefined();
    const byName = Object.fromEntries(r.inputs.map((i) => [i.name, i]));
    expect(byName["prompt"]).toBeDefined();
    expect(byName["prompt"]?.type).toBe("text");
    expect(byName["prompt"]?.required).toBe(true);
    expect(byName["max_partitions"]).toBeDefined();
    expect(byName["max_partitions"]?.type).toBe("number");
    expect(byName["max_partitions"]?.default).toBe(4);
  });

  test("action='inputs' for deep-research-codebase has no error field", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await execute({ name: "deep-research-codebase", inputs: {}, action: "inputs" }, {});
    const r = result as { action: "inputs"; error?: string };
    expect(r.error).toBeUndefined();
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
    // deep-research-codebase requires prompt. Without adapters in test env,
    // prompt stages use the test stub but complete stages will throw — resulting
    // in an honest "failed" result (not a placeholder).
    const result = await execute(
      { name: "deep-research-codebase", inputs: { prompt: "test query" }, action: "run" },
      {},
    );
    expect(result.action).toBe("run");
    const r = result as {
      action: "run";
      runId: string;
      status: string;
      stages: unknown[];
      error?: string;
    };
    // runId must be a non-empty non-placeholder value (real UUID)
    expect(r.runId).toBeString();
    expect(r.runId.length).toBeGreaterThan(0);
    expect(r.runId).not.toBe("");
    // status must be terminal (completed or failed) — not pending/running/placeholder
    expect(["completed", "failed"]).toContain(r.status);
    // stages must be an array
    expect(Array.isArray(r.stages)).toBe(true);
  });

  test("action='run' for deep-research-codebase without adapters reports honest failure, not stub", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await execute(
      { name: "deep-research-codebase", inputs: { prompt: "test" }, action: "run" },
      {},
    );
    const r = result as {
      action: "run";
      runId: string;
      status: string;
      stages: unknown[];
      error?: string;
    };
    // When no adapters and complete adapter is missing, the workflow should fail honestly.
    // A "failed" run must carry an error message (not placeholder text like "not yet implemented").
    if (r.status === "failed") {
      expect(r.error).toBeDefined();
      expect(r.error).not.toContain("not yet implemented");
      expect(r.error).not.toContain("Phase B stub");
    }
    // Either way, runId must be real
    expect(r.runId).not.toBe("");
  });

  test("action='run' for unknown workflow returns non-placeholder empty runId string with failed status", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await execute({ name: "nonexistent-workflow-xyz", inputs: {}, action: "run" }, {});
    const r = result as { action: "run"; runId: string; status: string; error?: string };
    expect(r.status).toBe("failed");
    expect(r.error).toContain("nonexistent-workflow-xyz");
    // not-found returns "" as runId (documented behaviour: empty sentinel for not-found)
    expect(r.runId).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Slash command alias registration — bundled workflow aliases
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — slash alias registration for bundled workflows", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("alias workflow:deep-research-codebase registered", () => {
    expect(getCommand(mock.commands, "workflow:deep-research-codebase")).toBeDefined();
  });

  test("alias workflow:ralph registered", () => {
    expect(getCommand(mock.commands, "workflow:ralph")).toBeDefined();
  });

  test("alias workflow:open-claude-design registered", () => {
    expect(getCommand(mock.commands, "workflow:open-claude-design")).toBeDefined();
  });

  test("each alias command has non-empty description mentioning workflow name", () => {
    for (const name of ["deep-research-codebase", "ralph", "open-claude-design"]) {
      const cmd = getCommand(mock.commands, `workflow:${name}`)!;
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(cmd.description).toContain(name);
    }
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
    const completions = await cmd.getArgumentCompletions?.("") ?? [];
    const labels = completions.map((c) => c.label);

    // Admin subcommands
    for (const sub of ["list", "status", "kill", "resume", "inputs"]) {
      expect(labels).toContain(sub);
    }

    // Bundled workflow names
    expect(labels).toContain("deep-research-codebase");
    expect(labels).toContain("ralph");
    expect(labels).toContain("open-claude-design");
  });

  test("/workflow completions filter partial 'deep' to workflow name", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = await cmd.getArgumentCompletions?.("deep") ?? [];
    const labels = completions.map((c) => c.label);
    expect(labels).toContain("deep-research-codebase");
    expect(labels.every((l) => l.startsWith("deep"))).toBe(true);
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
    await cmd.execute("deep-research-codebase prompt=test", { reply: (m) => messages.push(m) });

    // Must not say "unknown subcommand"
    expect(messages.some((m) => m.toLowerCase().includes("unknown subcommand"))).toBe(false);

    // Must print either completed, failed, or "Workflow not found" — never silent
    const dispatched = messages.some(
      (m) =>
        m.includes("completed") ||
        m.includes("failed") ||
        m.includes("Workflow not found"),
    );
    expect(dispatched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /workflows-doctor reports real loaded count
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — /workflows-doctor reports real loaded count", () => {
  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  test("/workflows-doctor reports real loaded count (>= 3 bundled workflows)", async () => {
    const cmd = getCommand(mock.commands, "workflows-doctor")!;
    const messages: string[] = [];
    await cmd.execute("", { reply: (m) => messages.push(m) });
    const combined = messages.join("\n");

    // Must contain the pi-workflows header
    expect(combined).toContain("pi-workflows");
    // Must not contain placeholder stub text
    expect(combined).not.toContain("Phase B stub");
    expect(combined).not.toContain("Executor: not yet implemented");
    // Must report the bundled workflow count (at least 3)
    const match = combined.match(/Registry:\s*(\d+)\s*workflow/);
    expect(match).not.toBeNull();
    const count = match ? parseInt(match[1]!, 10) : 0;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("/workflows-doctor names bundled sources (deep-research-codebase, ralph, open-claude-design)", async () => {
    const cmd = getCommand(mock.commands, "workflows-doctor")!;
    const messages: string[] = [];
    await cmd.execute("", { reply: (m) => messages.push(m) });
    const combined = messages.join("\n");

    expect(combined).toContain("deep-research-codebase");
    expect(combined).toContain("ralph");
    expect(combined).toContain("open-claude-design");
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation — empty API object
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — graceful degradation", () => {
  test("factory({}) does not throw", () => {
    expect(() => factory({})).not.toThrow();
  });

  test("factory with partial API (only registerTool) does not throw", () => {
    const api: ExtensionAPI = {
      registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
        void opts;
      },
    };
    expect(() => factory(api)).not.toThrow();
  });

  test("factory with partial API (only registerCommand) does not throw", () => {
    const api: ExtensionAPI = {
      registerCommand(opts: PiSlashCommandOpts) {
        void opts;
      },
    };
    expect(() => factory(api)).not.toThrow();
  });

  test("factory with partial API (only registerMessageRenderer) does not throw", () => {
    const api: ExtensionAPI = {
      registerMessageRenderer(event: string, renderer: (payload: Record<string, unknown>) => string) {
        void event;
        void renderer;
      },
    };
    expect(() => factory(api)).not.toThrow();
  });

  test("factory with partial API (only registerFlag) does not throw", () => {
    const api: ExtensionAPI = {
      registerFlag(opts: PiFlagOpts) {
        void opts;
      },
    };
    expect(() => factory(api)).not.toThrow();
  });
});
