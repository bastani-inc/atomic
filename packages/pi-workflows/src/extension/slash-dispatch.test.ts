/**
 * Slash dispatch tests.
 *
 * Verifies:
 *   - /workflow <name> [key=value] resolves non-admin first token as workflow
 *     name and dispatches run (not unknown subcommand).
 *   - /workflow inputs <name> shows schema via runtime.dispatch inputs.
 *   - /workflow inputs (missing name) shows usage.
 *   - Unknown workflow name prints "Workflow not found: <name>".
 *   - Alias registrations: workflow:deep-research-codebase, workflow:ralph,
 *     workflow:open-claude-design are registered via factory.
 *   - Completions include admin subcommands AND workflow names.
 *   - parseWorkflowArgs correctly parses key=value pairs and JSON objects.
 */

import { test, expect, describe } from "bun:test";
import { parseWorkflowArgs, stripDetachFlags, makeExecuteWorkflowTool } from "./index.js";
import type { ExtensionAPI, PiCommandContext, PiCommandOptions, PiSlashCommandOpts } from "./index.js";
import { createRegistry } from "../workflows/registry.js";
import { defineWorkflow } from "../workflows/define-workflow.js";
import type { WorkflowDefinition } from "../shared/types.js";
import { createExtensionRuntime } from "./runtime.js";
import { store } from "../store.js";

// ---------------------------------------------------------------------------
// parseWorkflowArgs
// ---------------------------------------------------------------------------

describe("parseWorkflowArgs", () => {
  test("empty tokens → empty object", () => {
    expect(parseWorkflowArgs([])).toEqual({});
  });

  test("parses key=value string pairs", () => {
    expect(parseWorkflowArgs(["prompt=hello world"])).toEqual({ prompt: "hello world" });
  });

  test("multiple key=value pairs", () => {
    expect(parseWorkflowArgs(["a=1", "b=foo"])).toEqual({ a: 1, b: "foo" });
  });

  test("JSON-typed values: number, boolean", () => {
    expect(parseWorkflowArgs(["count=42", "flag=true"])).toEqual({ count: 42, flag: true });
  });

  test("value with = in it splits on first = only", () => {
    expect(parseWorkflowArgs(["url=http://x.com/a=b"])).toEqual({ url: "http://x.com/a=b" });
  });

  test("JSON object token merged into result", () => {
    const result = parseWorkflowArgs(['{"key":"val","n":3}']);
    expect(result).toEqual({ key: "val", n: 3 });
  });

  test("JSON object merged with key=value", () => {
    const result = parseWorkflowArgs(['{"a":1}', "b=two"]);
    expect(result).toEqual({ a: 1, b: "two" });
  });

  test("tokens without = are ignored", () => {
    expect(parseWorkflowArgs(["positional", "another"])).toEqual({});
  });

  test("key with empty value", () => {
    expect(parseWorkflowArgs(["name="])).toEqual({ name: "" });
  });
});

// ---------------------------------------------------------------------------
// Shared test factory helpers
// ---------------------------------------------------------------------------

interface RegisteredCommand {
  name: string;
  opts: PiSlashCommandOpts;
}

function buildMockPi(): { pi: ExtensionAPI; commands: RegisteredCommand[] } {
  const commands: RegisteredCommand[] = [];
  const pi: ExtensionAPI = {
    registerCommand: (name: string, options: PiCommandOptions) => {
      const opts: PiSlashCommandOpts = {
        name,
        description: options.description,
        execute: options.handler,
        getArgumentCompletions: options.getArgumentCompletions,
      };
      commands.push({ name, opts });
    },
  };
  return { pi, commands };
}

function buildCtx(): { ctx: PiCommandContext; messages: string[] } {
  const messages: string[] = [];
  const ctx: PiCommandContext = {
    reply(msg: string) {
      messages.push(msg);
    },
  };
  return { ctx, messages };
}

function addFactoryStubs(pi: ExtensionAPI): void {
  pi.registerTool = () => {};
  pi.registerMessageRenderer = () => {};
  pi.registerFlag = () => {};
  pi.on = () => {};
  pi.ui = { setWidget: () => {} };
}

async function runFactory(pi: ExtensionAPI): Promise<void> {
  addFactoryStubs(pi);
  const factoryModule = await import("./index.js");
  factoryModule.default(pi);
}

// ---------------------------------------------------------------------------
// Slash dispatch: non-admin first token → workflow name run
// ---------------------------------------------------------------------------

describe("slash /workflow <name> dispatch", () => {
  test("/workflow <known-name> dispatches run, not unknown subcommand", async () => {
    const wf = defineWorkflow("test-wf")
      .run(async (_ctx) => ({ done: true }))
      .compile() as WorkflowDefinition;

    const registry = createRegistry([wf]);
    const runtime = createExtensionRuntime({ registry });

    const { pi, commands } = buildMockPi();

    const { ctx, messages } = buildCtx();

    let dispatchCalled = false;
    let dispatchedArgs: { name: string; inputs: Record<string, unknown>; action: string } | null = null;

    const execute = async (args: string, execCtx: PiCommandContext) => {
      const print = execCtx.reply ?? execCtx.print ?? ((_msg: string) => undefined);
      const rawParts = args.trim().split(/\s+/);
      const parts = rawParts[0] === "" ? [] : rawParts;
      const subcommand = parts[0] ?? "";

      const ADMIN = new Set(["list", "status", "kill", "resume", "inputs"]);

      if (!subcommand || subcommand === "list") {
        print(`Registered workflows: ${runtime.registry.names().join(", ")}`);
        return;
      }

      if (!ADMIN.has(subcommand)) {
        dispatchCalled = true;
        const inputTokens = parts.slice(1);
        const inputs = parseWorkflowArgs(inputTokens);
        dispatchedArgs = { name: subcommand, inputs, action: "run" };
        const result = await runtime.dispatch({ name: subcommand, inputs, action: "run" });
        if (result.action === "run" && "runId" in result) {
          const r = result as { action: "run"; runId: string; status: string; error?: string };
          if (r.status === "failed" && r.runId === "") {
            const available = runtime.registry.names();
            print(`Workflow not found: ${subcommand}\nAvailable: ${available.join(", ")}`);
          } else {
            print(`Workflow "${subcommand}" completed (runId: ${r.runId})`);
          }
        }
        return;
      }
      print(`unknown subcommand: ${subcommand}`);
    };

    await execute("test-wf prompt=hello", ctx);

    expect(dispatchCalled).toBe(true);
    const d = dispatchedArgs as { name: string; inputs: Record<string, unknown>; action: string } | null;
    expect(d?.name).toBe("test-wf");
    expect(d?.inputs).toEqual({ prompt: "hello" });
    expect(d?.action).toBe("run");
    expect(messages.some((m) => m.includes("completed"))).toBe(true);
    // Must NOT print unknown subcommand
    expect(messages.some((m) => m.includes("unknown subcommand"))).toBe(false);
  });

  test("/workflow <unknown-name> prints 'Workflow not found: <name>'", async () => {
    const registry = createRegistry([]);
    const runtime = createExtensionRuntime({ registry });
    const { ctx, messages } = buildCtx();

    const ADMIN = new Set(["list", "status", "kill", "resume", "inputs"]);
    const execute = async (args: string, execCtx: PiCommandContext) => {
      const print = execCtx.reply ?? execCtx.print ?? ((_msg: string) => undefined);
      const rawParts = args.trim().split(/\s+/);
      const parts = rawParts[0] === "" ? [] : rawParts;
      const subcommand = parts[0] ?? "";
      if (!ADMIN.has(subcommand) && subcommand) {
        const result = await runtime.dispatch({ name: subcommand, inputs: {}, action: "run" });
        if (result.action === "run" && "runId" in result) {
          const r = result as { action: "run"; runId: string; status: string };
          if (r.status === "failed" && r.runId === "") {
            const available = runtime.registry.names();
            print(`Workflow not found: ${subcommand}\nAvailable: ${available.length > 0 ? available.join(", ") : "(none)"}`);
          }
        }
      }
    };

    await execute("ghost-workflow", ctx);

    expect(messages[0]).toContain("Workflow not found: ghost-workflow");
    expect(messages[0]).not.toContain("unknown subcommand");
  });
});

// ---------------------------------------------------------------------------
// Factory alias + completion integration tests (using real factory)
// ---------------------------------------------------------------------------

describe("factory alias registration (real factory)", () => {
  /** Import factory and call it with a mock pi whose registry contains known workflows. */
  async function runFactoryWithMock(): Promise<RegisteredCommand[]> {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);
    return commands;
  }

  test("aliases workflow:deep-research-codebase, workflow:ralph, workflow:open-claude-design registered", async () => {
    const commands = await runFactoryWithMock();
    const names = commands.map((c) => c.name);
    expect(names).toContain("workflow:deep-research-codebase");
    expect(names).toContain("workflow:ralph");
    expect(names).toContain("workflow:open-claude-design");
  });

  test("base /workflow command registered", async () => {
    const commands = await runFactoryWithMock();
    const names = commands.map((c) => c.name);
    expect(names).toContain("workflow");
  });

  test("/workflows-doctor command registered", async () => {
    const commands = await runFactoryWithMock();
    const names = commands.map((c) => c.name);
    expect(names).toContain("workflows-doctor");
  });
});

// ---------------------------------------------------------------------------
// Completions include workflow names
// ---------------------------------------------------------------------------

describe("getArgumentCompletions includes workflow names", () => {
  test("completions include admin subcommands and workflow names from registry", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    expect(workflowCmd).toBeDefined();

    const completions = await workflowCmd!.opts.getArgumentCompletions?.("") ?? [];
    const labels = completions.map((c) => c.label);

    expect(labels).toContain("list");
    expect(labels).toContain("status");
    expect(labels).toContain("kill");
    expect(labels).toContain("resume");
    expect(labels).toContain("inputs");

    expect(labels).toContain("deep-research-codebase");
    expect(labels).toContain("ralph");
    expect(labels).toContain("open-claude-design");
  });

  test("completions filter by partial prefix", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const completions = await workflowCmd!.opts.getArgumentCompletions?.("li") ?? [];
    expect(completions.every((c) => c.label.startsWith("li"))).toBe(true);
    expect(completions.map((c) => c.label)).toContain("list");
  });
});

// ---------------------------------------------------------------------------
// inputs subcommand via execute handler (factory-registered)
// ---------------------------------------------------------------------------

describe("inputs subcommand", () => {
  test("/workflow inputs with no name prints usage", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const { ctx, messages } = buildCtx();
    await workflowCmd!.opts.execute("inputs", ctx);

    expect(messages[0]).toContain("Usage:");
    expect(messages[0]).toContain("inputs");
  });

  test("/workflow inputs <unknown> prints workflow not found plus available", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const { ctx, messages } = buildCtx();
    await workflowCmd!.opts.execute("inputs no-such-workflow-xyz", ctx);

    expect(messages[0]).toContain("no-such-workflow-xyz");
    expect(messages[0]).toContain("Available:");
  });

  test("/workflow inputs <known> shows schema", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const { ctx, messages } = buildCtx();
    await workflowCmd!.opts.execute("inputs ralph", ctx);

    expect(messages[0]).not.toContain("Workflow not found");
    expect(messages[0]).toContain("ralph");
  });
});

// ---------------------------------------------------------------------------
// /workflow deep-research-codebase prompt=test dispatch (full factory path)
// ---------------------------------------------------------------------------

describe("/workflow <name> prompt=test dispatches run via factory", () => {
  test("/workflow deep-research-codebase dispatches run action (not unknown subcommand)", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const { ctx, messages } = buildCtx();

    await workflowCmd!.opts.execute("deep-research-codebase prompt=test", ctx);

    expect(messages.some((m) => m.includes("unknown subcommand"))).toBe(false);
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
// Canonical registerCommand shape — opts.handler, no opts.execute
// ---------------------------------------------------------------------------

interface RawRegisteredCommand {
  name: string;
  options: PiCommandOptions;
}

function buildRawMockPi(): { pi: ExtensionAPI; commands: RawRegisteredCommand[] } {
  const commands: RawRegisteredCommand[] = [];
  const pi: ExtensionAPI = {
    registerCommand: (name: string, options: PiCommandOptions) => {
      commands.push({ name, options });
    },
  };
  return { pi, commands };
}

describe("canonical registerCommand — opts.handler shape", () => {
  async function runFactoryRaw(): Promise<RawRegisteredCommand[]> {
    const { pi, commands } = buildRawMockPi();
    await runFactory(pi);
    return commands;
  }

  test("registerCommand receives string name 'workflow'", async () => {
    const commands = await runFactoryRaw();
    const names = commands.map((c) => c.name);
    expect(names).toContain("workflow");
  });

  test("registerCommand receives string name 'workflows-doctor'", async () => {
    const commands = await runFactoryRaw();
    const names = commands.map((c) => c.name);
    expect(names).toContain("workflows-doctor");
  });

  test("registerCommand receives string names 'workflow:<alias>' for bundled workflows", async () => {
    const commands = await runFactoryRaw();
    const names = commands.map((c) => c.name);
    expect(names.some((n) => n.startsWith("workflow:"))).toBe(true);
  });

  test("opts passed to registerCommand have 'handler' (function)", async () => {
    const commands = await runFactoryRaw();
    for (const { name, options } of commands) {
      expect(typeof options.handler, `${name}: handler should be function`).toBe("function");
    }
  });

  test("opts passed to registerCommand do NOT have 'execute' property", async () => {
    const commands = await runFactoryRaw();
    for (const { name, options } of commands) {
      expect(
        Object.prototype.hasOwnProperty.call(options, "execute"),
        `${name}: opts must not have execute — use handler`,
      ).toBe(false);
    }
  });

  test("opts have 'description' string", async () => {
    const commands = await runFactoryRaw();
    for (const { name, options } of commands) {
      expect(typeof options.description, `${name}: description should be string`).toBe("string");
    }
  });

  test("handler for 'workflow' is callable — does not throw synchronously", async () => {
    const commands = await runFactoryRaw();
    const workflowCmd = commands.find((c) => c.name === "workflow");
    expect(workflowCmd).toBeDefined();
    const msgs: string[] = [];
    const ctx: PiCommandContext = {
      reply(message) {
        msgs.push(message);
      },
    };
    await workflowCmd!.options.handler("list", ctx);
    expect(msgs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Canonical preference — registerCommand wins over registerSlashCommand
// ---------------------------------------------------------------------------

describe("canonical preference — registerCommand preferred over registerSlashCommand", () => {
  test("when both present, registerCommand called and registerSlashCommand NOT called", async () => {
    let canonicalCalls = 0;
    let legacyCalls = 0;

    const pi: ExtensionAPI = {
      registerCommand() {
        canonicalCalls++;
      },
      registerSlashCommand() {
        legacyCalls++;
      },
    };

    await runFactory(pi);

    expect(canonicalCalls).toBeGreaterThan(0);
    expect(legacyCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Legacy fallback — registerSlashCommand called when registerCommand absent
// ---------------------------------------------------------------------------

describe("legacy fallback — registerSlashCommand when registerCommand absent", () => {
  async function runFactoryLegacy(): Promise<PiSlashCommandOpts[]> {
    const legacyCommands: PiSlashCommandOpts[] = [];

    const pi: ExtensionAPI = {
      registerSlashCommand(opts: PiSlashCommandOpts) {
        legacyCommands.push(opts);
      },
    };

    await runFactory(pi);
    return legacyCommands;
  }

  test("registerSlashCommand called for all commands when registerCommand absent", async () => {
    const legacyCommands = await runFactoryLegacy();

    expect(legacyCommands.length).toBeGreaterThan(0);
    const names = legacyCommands.map((c) => c.name);
    expect(names).toContain("workflow");
    expect(names).toContain("workflows-doctor");
  });

  test("legacy opts have 'execute' function (not 'handler')", async () => {
    const legacyCommands = await runFactoryLegacy();

    for (const opts of legacyCommands) {
      expect(typeof opts.execute, `${opts.name}: execute should be function on legacy path`).toBe("function");
    }
  });

  test("legacy opts have 'name' string", async () => {
    const legacyCommands = await runFactoryLegacy();

    for (const opts of legacyCommands) {
      expect(typeof opts.name, `${opts.name}: name should be string`).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// stripDetachFlags
// ---------------------------------------------------------------------------

describe("stripDetachFlags", () => {
  test("no flags — tokens unchanged, detach false", () => {
    const result = stripDetachFlags(["key=val", "foo=bar"]);
    expect(result.detach).toBe(false);
    expect(result.tokens).toEqual(["key=val", "foo=bar"]);
  });

  test("--detach flag removed, detach true", () => {
    const result = stripDetachFlags(["wf-name", "--detach", "key=val"]);
    expect(result.detach).toBe(true);
    expect(result.tokens).toEqual(["wf-name", "key=val"]);
  });

  test("--bg flag removed, detach true", () => {
    const result = stripDetachFlags(["--bg", "wf-name"]);
    expect(result.detach).toBe(true);
    expect(result.tokens).toEqual(["wf-name"]);
  });

  test("both --detach and --bg removed", () => {
    const result = stripDetachFlags(["--detach", "a=1", "--bg"]);
    expect(result.detach).toBe(true);
    expect(result.tokens).toEqual(["a=1"]);
  });

  test("empty tokens — detach false, empty tokens", () => {
    const result = stripDetachFlags([]);
    expect(result.detach).toBe(false);
    expect(result.tokens).toEqual([]);
  });

  test("flag before name — name preserved", () => {
    const result = stripDetachFlags(["--detach", "my-wf", "x=1"]);
    expect(result.detach).toBe(true);
    expect(result.tokens).toEqual(["my-wf", "x=1"]);
  });
});

// ---------------------------------------------------------------------------
// RFC §2 — /workflow ralph --bg prompt=test dispatches detached with
//           parsed input { prompt: "test" }
//
// Verifies that stripDetachFlags + parseWorkflowArgs compose correctly so
// that --bg is stripped before input parsing and prompt=test is extracted.
// ---------------------------------------------------------------------------

describe("--bg prompt=test → detach:true, parsed input { prompt: 'test' }", () => {
  test("ralph --bg prompt=test: detach true, inputs { prompt: 'test' }", () => {
    // Simulate how the /workflow execute handler processes "ralph --bg prompt=test"
    const rawTokens = ["ralph", "--bg", "prompt=test"];
    const { detach, tokens } = stripDetachFlags(rawTokens);
    expect(detach).toBe(true);
    // First token is workflow name; rest are inputs
    const [_name, ...inputTokens] = tokens;
    expect(_name).toBe("ralph");
    const inputs = parseWorkflowArgs(inputTokens);
    expect(inputs).toEqual({ prompt: "test" });
  });

  test("ralph --bg prompt=hello world: detach true, inputs { prompt: 'hello world' }", () => {
    const rawTokens = ["ralph", "--bg", "prompt=hello world"];
    const { detach, tokens } = stripDetachFlags(rawTokens);
    expect(detach).toBe(true);
    const [_name, ...inputTokens] = tokens;
    const inputs = parseWorkflowArgs(inputTokens);
    expect(inputs).toEqual({ prompt: "hello world" });
  });

  test("--bg ralph prompt=test (flag first): detach true, name ralph, inputs { prompt: 'test' }", () => {
    const rawTokens = ["--bg", "ralph", "prompt=test"];
    const { detach, tokens } = stripDetachFlags(rawTokens);
    expect(detach).toBe(true);
    const [name, ...inputTokens] = tokens;
    expect(name).toBe("ralph");
    const inputs = parseWorkflowArgs(inputTokens);
    expect(inputs).toEqual({ prompt: "test" });
  });

  test("--bg does NOT appear in parsed inputs", () => {
    const rawTokens = ["ralph", "--bg", "prompt=test", "count=3"];
    const { tokens } = stripDetachFlags(rawTokens);
    const [_name, ...inputTokens] = tokens;
    // --bg must not leak into inputTokens
    expect(inputTokens.includes("--bg")).toBe(false);
    const inputs = parseWorkflowArgs(inputTokens);
    expect(inputs).toEqual({ prompt: "test", count: 3 });
  });
});

// ---------------------------------------------------------------------------
// /workflow <name> --detach slash dispatch (factory path)
// ---------------------------------------------------------------------------

describe("/workflow <name> --detach flag (factory execute)", () => {
  async function buildFactoryWorkflowCmd(): Promise<{ cmd: PiSlashCommandOpts; messages: () => string[] }> {
    const { pi, commands } = buildMockPi();
    pi.registerTool = () => {};
    pi.registerMessageRenderer = () => {};
    pi.registerFlag = () => {};
    pi.on = () => {};
    pi.ui = { setWidget: () => {} };

    const factoryModule = await import("./index.js");
    factoryModule.default(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow")!;
    const msgs: string[] = [];
    const ctx: PiCommandContext = { reply: (m: string) => { msgs.push(m); } };
    return { cmd: workflowCmd.opts, messages: () => msgs };
  }

  test("/workflow ralph --detach prints 'started in background'", async () => {
    const { cmd, messages } = await buildFactoryWorkflowCmd();
    const msgs: string[] = [];
    const ctx: PiCommandContext = { reply: (m: string) => { msgs.push(m); } };
    await cmd.execute("ralph --detach", ctx);
    // Must say started in background, NOT unknown subcommand
    expect(msgs.some((m) => m.includes("unknown subcommand"))).toBe(false);
    expect(msgs.some((m) => m.includes("started in background") || m.includes("background"))).toBe(true);
  });

  test("/workflow ralph --bg prints 'started in background'", async () => {
    const { cmd, messages } = await buildFactoryWorkflowCmd();
    const msgs: string[] = [];
    const ctx: PiCommandContext = { reply: (m: string) => { msgs.push(m); } };
    await cmd.execute("ralph --bg", ctx);
    expect(msgs.some((m) => m.includes("unknown subcommand"))).toBe(false);
    expect(msgs.some((m) => m.includes("started in background") || m.includes("background"))).toBe(true);
  });

  test("/workflow --detach ralph (flag before name) prints 'started in background'", async () => {
    const { cmd } = await buildFactoryWorkflowCmd();
    const msgs: string[] = [];
    const ctx: PiCommandContext = { reply: (m: string) => { msgs.push(m); } };
    await cmd.execute("--detach ralph", ctx);
    expect(msgs.some((m) => m.includes("unknown subcommand"))).toBe(false);
    expect(msgs.some((m) => m.includes("started in background") || m.includes("background"))).toBe(true);
  });

  test("--detach removed before parseWorkflowArgs — not treated as input", async () => {
    const { cmd } = await buildFactoryWorkflowCmd();
    const msgs: string[] = [];
    const ctx: PiCommandContext = { reply: (m: string) => { msgs.push(m); } };
    // If --detach leaked into inputs it would be in result or cause no message about "background"
    await cmd.execute("ralph --detach prompt=test", ctx);
    expect(msgs.some((m) => m.includes("unknown subcommand"))).toBe(false);
    // Should not contain "--detach" as a workflow input error
    expect(msgs.every((m) => !m.includes("--detach"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// workflow:<name> alias --detach flag (factory path)
// ---------------------------------------------------------------------------

describe("workflow:<name> alias --detach flag (factory execute)", () => {
  test("workflow:ralph --detach prints 'started in background'", async () => {
    const { pi, commands } = buildMockPi();
    pi.registerTool = () => {};
    pi.registerMessageRenderer = () => {};
    pi.registerFlag = () => {};
    pi.on = () => {};
    pi.ui = { setWidget: () => {} };

    const factoryModule = await import("./index.js");
    factoryModule.default(pi);

    const aliasCmd = commands.find((c) => c.name === "workflow:ralph");
    expect(aliasCmd).toBeDefined();

    const msgs: string[] = [];
    const ctx: PiCommandContext = { reply: (m: string) => { msgs.push(m); } };
    await aliasCmd!.opts.execute("--detach", ctx);

    expect(msgs.some((m) => m.includes("unknown subcommand"))).toBe(false);
    expect(msgs.some((m) => m.includes("started in background") || m.includes("background"))).toBe(true);
  });

  test("workflow:ralph --bg prints 'started in background'", async () => {
    const { pi, commands } = buildMockPi();
    pi.registerTool = () => {};
    pi.registerMessageRenderer = () => {};
    pi.registerFlag = () => {};
    pi.on = () => {};
    pi.ui = { setWidget: () => {} };

    const factoryModule = await import("./index.js");
    factoryModule.default(pi);

    const aliasCmd = commands.find((c) => c.name === "workflow:ralph");
    const msgs: string[] = [];
    const ctx: PiCommandContext = { reply: (m: string) => { msgs.push(m); } };
    await aliasCmd!.opts.execute("--bg prompt=hello", ctx);

    expect(msgs.some((m) => m.includes("background"))).toBe(true);
    expect(msgs.every((m) => !m.includes("--bg"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resume regression: /workflow resume opens overlay + no legacy message
// ---------------------------------------------------------------------------

function makeInflightRun(id: string) {
  return {
    id,
    name: "test-wf",
    inputs: {},
    status: "running" as const,
    stages: [],
    startedAt: Date.now(),
  };
}

describe("/workflow resume <runId> — overlay open + no legacy message", () => {
  test("seeds active run; /workflow resume calls overlay.open (pi.ui.custom invoked with overlay:true)", async () => {
    const runId = `resume-slash-overlay-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));

    const openCalls: Array<{ overlay: boolean }> = [];
    const { pi, commands } = buildMockPi();
    pi.registerTool = () => {};
    pi.registerMessageRenderer = () => {};
    pi.registerFlag = () => {};
    pi.on = () => {};
    pi.ui = {
      setWidget: () => {},
      custom: (opts) => {
        openCalls.push({ overlay: !!opts.overlay });
        return { close: () => {} };
      },
    };

    const factoryModule = await import("./index.js");
    factoryModule.default(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow")!;
    const msgs: string[] = [];
    const ctx: PiCommandContext = { reply: (m: string) => { msgs.push(m); } };

    await workflowCmd.opts.execute(`resume ${runId}`, ctx);

    expect(openCalls.length).toBeGreaterThan(0);
    expect(openCalls[0].overlay).toBe(true);
  });

  test("active run resume output does NOT include 'still active — no resume needed'", async () => {
    const runId = `resume-nomsg-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));

    const { pi, commands } = buildMockPi();
    pi.registerTool = () => {};
    pi.registerMessageRenderer = () => {};
    pi.registerFlag = () => {};
    pi.on = () => {};
    pi.ui = {
      setWidget: () => {},
      custom: () => ({ close: () => {} }),
    };

    const factoryModule = await import("./index.js");
    factoryModule.default(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow")!;
    const msgs: string[] = [];
    const ctx: PiCommandContext = { reply: (m: string) => { msgs.push(m); } };

    await workflowCmd.opts.execute(`resume ${runId}`, ctx);

    expect(msgs.every((m) => !m.includes("still active"))).toBe(true);
    expect(msgs.every((m) => !m.includes("no resume needed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resume regression: tool action "resume" against active run returns status:"ok"
// ---------------------------------------------------------------------------

describe("tool action resume — active run returns status:ok", () => {
  test("makeExecuteWorkflowTool resume against in-flight run returns status:'ok'", async () => {
    const runId = `resume-tool-ok-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));

    const registry = createRegistry([]);
    const runtime = createExtensionRuntime({ registry });
    const handler = makeExecuteWorkflowTool(runtime, () => undefined);

    const result = await handler(
      { action: "resume", name: runId },
      {} as never,
    );

    expect(result.action).toBe("resume");
    const r = result as { action: string; status: string; runId: string };
    expect(r.status).toBe("ok");
    expect(r.runId).toBe(runId);
  });
});
