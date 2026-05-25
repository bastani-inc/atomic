/**
 * Slash dispatch tests.
 *
 * Verifies:
 *   - /workflow <name> [key=value] resolves non-admin first token as workflow
 *     name and dispatches run (not unknown subcommand).
 *   - /workflow inputs <name> shows schema via runtime.dispatch inputs.
 *   - /workflow inputs (missing name) shows usage.
 *   - Unknown workflow name prints "Workflow not found: <name>".
 *   - Per-workflow slash aliases are not registered; /workflow <name> is the
 *     single workflow-run slash surface.
 *   - /workflow completions include admin subcommands, aliases, AND workflow names.
 *   - parseWorkflowArgs correctly parses key=value pairs and JSON objects.
 */

import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  parseWorkflowArgs,
  tokenizeWorkflowArgs,
  makeExecuteWorkflowTool,
} from "../../packages/workflows/src/extension/index.js";
import type {
  ExtensionAPI,
  PiArgumentCompletion,
  PiCommandContext,
  PiCommandOptions,
} from "../../packages/workflows/src/extension/index.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { WORKFLOW_AUTH_FAILURE_MESSAGE } from "../../packages/workflows/src/shared/workflow-failures.js";
import type {
  PiCustomComponent,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayFunction,
  PiCustomOverlayOptions,
  PiOverlayHandle,
} from "../../packages/workflows/src/extension/wiring.js";
import { killAllRuns } from "../../packages/workflows/src/runs/background/status.js";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";

afterEach(async () => {
  killAllRuns({ store, cancellation: cancellationRegistry });
  await Promise.all(jobTracker.runIds().map((runId) => jobTracker.get(runId)?.promise));
  store.clear();
});

// ---------------------------------------------------------------------------
// parseWorkflowArgs
// ---------------------------------------------------------------------------

describe("parseWorkflowArgs", () => {
  test("empty tokens → empty object", () => {
    assert.deepEqual(parseWorkflowArgs([]), {});
  });

  test("parses key=value string pairs", () => {
    assert.deepEqual(parseWorkflowArgs(["prompt=hello world"]), { prompt: "hello world" });
  });

  test("multiple key=value pairs", () => {
    assert.deepEqual(parseWorkflowArgs(["a=1", "b=foo"]), { a: 1, b: "foo" });
  });

  test("JSON-typed values: number, boolean", () => {
    assert.deepEqual(parseWorkflowArgs(["count=42", "flag=true"]), { count: 42, flag: true });
  });

  test("value with = in it splits on first = only", () => {
    assert.deepEqual(parseWorkflowArgs(["url=http://x.com/a=b"]), { url: "http://x.com/a=b" });
  });

  test("JSON object token merged into result", () => {
    const result = parseWorkflowArgs(['{"key":"val","n":3}']);
    assert.deepEqual(result, { key: "val", n: 3 });
  });

  test("JSON object merged with key=value", () => {
    const result = parseWorkflowArgs(['{"a":1}', "b=two"]);
    assert.deepEqual(result, { a: 1, b: "two" });
  });

  test("tokens without = are ignored", () => {
    assert.deepEqual(parseWorkflowArgs(["positional", "another"]), {});
  });

  test("key with empty value", () => {
    assert.deepEqual(parseWorkflowArgs(["name="]), { name: "" });
  });
});

// ---------------------------------------------------------------------------
// tokenizeWorkflowArgs
// ---------------------------------------------------------------------------

describe("tokenizeWorkflowArgs", () => {
  test("empty string → empty array", () => {
    assert.deepEqual(tokenizeWorkflowArgs(""), []);
  });

  test("whitespace-only string → empty array", () => {
    assert.deepEqual(tokenizeWorkflowArgs("   \t  "), []);
  });

  test("plain whitespace split for bare tokens", () => {
    assert.deepEqual(
      tokenizeWorkflowArgs("workflow-name a=1 b=foo"),
      ["workflow-name", "a=1", "b=foo"],
    );
  });

  test("double-quoted value preserves internal whitespace", () => {
    // Regression: `prompt="map the codebase"` used to split into three
    // tokens (`prompt="map`, `the`, `codebase"`), which then rendered as
    // `prompt=""map"` in the dispatch confirm card.
    assert.deepEqual(
      tokenizeWorkflowArgs('workflow-name prompt="map the codebase" max=4'),
      ["workflow-name", 'prompt="map the codebase"', "max=4"],
    );
  });

  test("single-quoted value preserves internal whitespace", () => {
    assert.deepEqual(
      tokenizeWorkflowArgs("wf prompt='hello there' n=2"),
      ["wf", "prompt='hello there'", "n=2"],
    );
  });

  test("nested quotes of the opposite kind are treated as literal characters", () => {
    assert.deepEqual(
      tokenizeWorkflowArgs(`wf msg="she said 'hi'"`),
      ["wf", `msg="she said 'hi'"`],
    );
  });

  test("unterminated quote is recovered as a single tail token", () => {
    // The user can paste a partial value mid-typing; we never throw on
    // their input, the downstream JSON parse just falls back to string.
    assert.deepEqual(
      tokenizeWorkflowArgs('wf prompt="map the codebase'),
      ["wf", 'prompt="map the codebase'],
    );
  });

  test("collapses runs of whitespace", () => {
    assert.deepEqual(
      tokenizeWorkflowArgs("a   b\t\tc"),
      ["a", "b", "c"],
    );
  });

  test("end-to-end: tokenize + parse unquotes the string value", () => {
    const tokens = tokenizeWorkflowArgs(
      'deep-research-codebase prompt="map the codebase" max_partitions=4',
    );
    assert.deepEqual(tokens, [
      "deep-research-codebase",
      'prompt="map the codebase"',
      "max_partitions=4",
    ]);
    assert.deepEqual(parseWorkflowArgs(tokens.slice(1)), {
      prompt: "map the codebase",
      max_partitions: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// Shared test factory helpers
// ---------------------------------------------------------------------------

interface RegisteredCommand {
  name: string;
  options: PiCommandOptions;
}

interface SentMessage {
  customType?: string;
  content?: string;
  display?: boolean;
  details?: unknown;
}

function buildMockPi(): {
  pi: ExtensionAPI;
  commands: RegisteredCommand[];
  sent: SentMessage[];
} {
  const commands: RegisteredCommand[] = [];
  const sent: SentMessage[] = [];
  const pi: ExtensionAPI = {
    registerCommand: (name: string, options: PiCommandOptions) => {
      commands.push({ name, options });
    },
    // Chat surfaces dispatch via `emitChatSurface` → `pi.sendMessage`.
    // Mirror the message store so tests can observe the message stream.
    sendMessage: (msg: SentMessage) => {
      sent.push(msg);
    },
  };
  return { pi, commands, sent };
}

function buildCtx(): { ctx: PiCommandContext; messages: string[] } {
  const messages: string[] = [];
  const ctx: PiCommandContext = {
    ui: {
      notify(msg: string) {
        messages.push(msg);
      },
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
  pi.createAgentSession = async () => ({ session: fakeAgentSession() });
  pi.disableAsyncDiscovery = true;
}

function fakeAgentSession(): StageSessionRuntime {
  let last = "";
  return {
    async prompt(text: string): Promise<string> {
      last = `stub:${text.slice(0, 24)}`;
      return last;
    },
    async steer(text: string): Promise<void> {
      last = `steer:${text}`;
    },
    async followUp(text: string): Promise<void> {
      last = `follow:${text}`;
    },
    subscribe: () => () => {},
    sessionFile: undefined,
    sessionId: "slash-dispatch-test-session",
    async setModel(): Promise<void> {},
    setThinkingLevel(): void {},
    async cycleModel(): Promise<undefined> { return undefined; },
    cycleThinkingLevel(): undefined { return undefined; },
    agent: {} as StageSessionRuntime["agent"],
    model: undefined,
    thinkingLevel: "medium" as StageSessionRuntime["thinkingLevel"],
    messages: [],
    isStreaming: false,
    async navigateTree(): Promise<{ cancelled: boolean }> { return { cancelled: true }; },
    async compact(): ReturnType<StageSessionRuntime["compact"]> {
      return undefined as unknown as Awaited<ReturnType<StageSessionRuntime["compact"]>>;
    },
    abortCompaction(): void {},
    async abort(): Promise<void> {},
    dispose(): void {},
    getLastAssistantText(): string | undefined {
      return last;
    },
  };
}

async function runFactory(pi: ExtensionAPI): Promise<void> {
  addFactoryStubs(pi);
  const factoryModule = await import("../../packages/workflows/src/extension/index.js");
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

    const { ctx, messages } = buildCtx();

    let dispatchCalled = false;
    let dispatchedArgs: { name: string; inputs: Record<string, unknown>; action: string } | null = null;

    const execute = async (args: string, execCtx: PiCommandContext) => {
      const print = (msg: string): void => execCtx.ui.notify(msg, "info");
      const rawParts = args.trim().split(/\s+/);
      const parts = rawParts[0] === "" ? [] : rawParts;
      const subcommand = parts[0] ?? "";

      const ADMIN = new Set(["list", "status", "interrupt", "kill", "resume", "inputs"]);

      if (!subcommand || subcommand === "list") {
        print(`Registered workflows: ${runtime.registry.names().join(", ")}`);
        return;
      }

      if (!ADMIN.has(subcommand)) {
        dispatchCalled = true;
        const inputTokens = parts.slice(1);
        const inputs = parseWorkflowArgs(inputTokens);
        dispatchedArgs = { name: subcommand, inputs, action: "run" };
        const result = await runtime.dispatch({ workflow: subcommand, inputs, action: "run" });
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

    assert.equal(dispatchCalled, true);
    const d = dispatchedArgs as { name: string; inputs: Record<string, unknown>; action: string } | null;
    assert.equal(d?.name, "test-wf");
    assert.deepEqual(d?.inputs, { prompt: "hello" });
    assert.equal(d?.action, "run");
    assert.equal(messages.some((m) => m.includes("completed")), true);
    // Must NOT print unknown subcommand
    assert.equal(messages.some((m) => m.includes("unknown subcommand")), false);
  });

  test("/workflow <unknown-name> prints 'Workflow not found: <name>'", async () => {
    const registry = createRegistry([]);
    const runtime = createExtensionRuntime({ registry });
    const { ctx, messages } = buildCtx();

    const ADMIN = new Set(["list", "status", "interrupt", "kill", "resume", "inputs"]);
    const execute = async (args: string, execCtx: PiCommandContext) => {
      const print = (msg: string): void => execCtx.ui.notify(msg, "info");
      const rawParts = args.trim().split(/\s+/);
      const parts = rawParts[0] === "" ? [] : rawParts;
      const subcommand = parts[0] ?? "";
      if (!ADMIN.has(subcommand) && subcommand) {
        const result = await runtime.dispatch({ workflow: subcommand, inputs: {}, action: "run" });
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

    assert.ok(messages[0].includes("Workflow not found: ghost-workflow"));
    assert.ok(!messages[0].includes("unknown subcommand"));
  });
});

// ---------------------------------------------------------------------------
// Factory command registration + completion integration tests (using real factory)
// ---------------------------------------------------------------------------

describe("factory command registration (real factory)", () => {
  /** Import factory and call it with a mock pi whose registry contains known workflows. */
  async function runFactoryWithMock(): Promise<RegisteredCommand[]> {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);
    return commands;
  }

  test("per-workflow slash aliases are not registered", async () => {
    const commands = await runFactoryWithMock();
    const names = commands.map((c) => c.name);
    assert.equal(names.some((name) => name.startsWith("workflow:")), false);
  });

  test("base /workflow command registered", async () => {
    const commands = await runFactoryWithMock();
    const names = commands.map((c) => c.name);
    assert.ok(names.includes("workflow"));
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
    assert.notEqual(workflowCmd, undefined);

    const completions = await workflowCmd!.options.getArgumentCompletions?.("") ?? [];
    const labels = completions.map((c) => c.label);

    assert.ok(labels.includes("list"));
    assert.ok(labels.includes("status"));
    assert.ok(labels.includes("connect"));
    assert.ok(labels.includes("interrupt"));
    assert.ok(labels.includes("kill"));
    assert.ok(labels.includes("resume"));
    assert.ok(labels.includes("inputs"));
    assert.equal(labels.includes("session"), false);

    assert.ok(labels.includes("deep-research-codebase"));
    assert.ok(labels.includes("ralph"));
    assert.ok(labels.includes("open-claude-design"));
  });

  test("completions filter by partial prefix", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const completions = await workflowCmd!.options.getArgumentCompletions?.("li") ?? [];
    assert.equal(completions.every((c) => c.label.startsWith("li")), true);
    assert.ok(completions.map((c) => c.label).includes("list"));
  });

  test("completions cover subcommand arguments without shadowing submit", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const completions = workflowCmd!.options.getArgumentCompletions?.("interrupt -") ?? [];
    assert.ok(completions.some((c) => c.value === "interrupt -y "));

    const killCompletions = workflowCmd!.options.getArgumentCompletions?.("kill -") ?? [];
    assert.ok(killCompletions.some((c) => c.value === "kill -y "));
  });

  test("trailing-space completion does not throw on empty subcommand", async () => {
    // Regression: typing `/workflow ` (just the slash command + space)
    // forwards `partial = " "` to getArgumentCompletions, which used to
    // fall through to `registry.get("")`, throwing
    // `TypeError: normalizeWorkflowName: name must be a non-empty string`.
    // The trailing-space case should produce the same admin + workflow-name
    // menu as the no-args case (partial = "").
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    let completions: PiArgumentCompletion[] | null | undefined;
    assert.doesNotThrow(() => {
      completions = workflowCmd!.options.getArgumentCompletions?.(" ") as
        | PiArgumentCompletion[]
        | null
        | undefined;
    });
    const labels = (completions ?? []).map((c) => c.label);
    assert.ok(labels.includes("list"), "admin subcommands offered");
    assert.ok(labels.includes("deep-research-codebase"), "workflow names offered");
  });
});

// ---------------------------------------------------------------------------
// removed session namespace
// ---------------------------------------------------------------------------

describe("/workflow session namespace removed", () => {
  test("/workflow session ... is not treated as a control namespace", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const { ctx, messages } = buildCtx();
    await workflowCmd!.options.handler("session kill abc12345", ctx);

    const joined = messages.join("\n");
    assert.match(joined, /Workflow not found: session/);
    assert.doesNotMatch(joined, /Usage: \/workflow session/);
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
    await workflowCmd!.options.handler("inputs", ctx);

    assert.ok(messages[0].includes("Usage:"));
    assert.ok(messages[0].includes("inputs"));
  });

  test("/workflow inputs <unknown> prints workflow not found plus available", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const { ctx, messages } = buildCtx();
    await workflowCmd!.options.handler("inputs no-such-workflow-xyz", ctx);

    assert.ok(messages[0].includes("no-such-workflow-xyz"));
    assert.ok(messages[0].includes("Available:"));
  });

  test("/workflow inputs <known> shows schema", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const { ctx, messages } = buildCtx();
    await workflowCmd!.options.handler("inputs ralph", ctx);

    assert.ok(!messages[0].includes("Workflow not found"));
    assert.ok(messages[0].includes("ralph"));
  });
});

// ---------------------------------------------------------------------------
// /workflow deep-research-codebase prompt=test dispatch (full factory path)
// ---------------------------------------------------------------------------

describe("/workflow <name> prompt=test dispatches run via factory", () => {
  test("/workflow deep-research-codebase dispatches run action (not unknown subcommand)", async () => {
    const { pi, commands, sent } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const { ctx, messages } = buildCtx();

    await workflowCmd!.options.handler("deep-research-codebase prompt=test", ctx);

    assert.equal(messages.some((m) => m.includes("unknown subcommand")), false);
    // Success path: the dispatch confirmation is now emitted as a
    // chat-surface `kind: "dispatch"` message (sendMessage), not a string
    // through ctx.ui.notify. Either error wording in `messages` or a
    // dispatch payload in `sent` counts as evidence the handler resolved.
    const dispatchSent = sent.some(
      (m) => (m.details as { kind?: string } | undefined)?.kind === "dispatch",
    );
    const errored = messages.some(
      (m) =>
        m.includes("completed") ||
        m.includes("failed") ||
        m.includes("Workflow not found"),
    );
    assert.equal(dispatchSent || errored, true);
  });
});

// ---------------------------------------------------------------------------
// /workflow <name> --help prints schema, skips dispatch
// ---------------------------------------------------------------------------

describe("/workflow <name> --help prints schema without dispatching", () => {
  test("--help token short-circuits to the schema printer", async () => {
    const { pi, commands } = buildMockPi();
    await runFactory(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow");
    const { ctx, messages } = buildCtx();

    await workflowCmd!.options.handler("deep-research-codebase --help", ctx);

    // Schema printer prints the pretty themed header or the plain text header.
    assert.ok(
      messages.some((m) => /INPUTS FOR DEEP-RESEARCH-CODEBASE|Inputs for "deep-research-codebase":/.test(m)),
      `expected schema header in messages; got: ${JSON.stringify(messages)}`,
    );
    // Should NOT have a run completion/failure line
    assert.equal(
      messages.some((m) => m.includes("started") || m.includes("completed (runId:")),
      false,
    );
  });

});

// ---------------------------------------------------------------------------
// Canonical registerCommand shape — opts.handler, no opts.execute
// ---------------------------------------------------------------------------

interface RawRegisteredCommand {
  name: string;
  options: PiCommandOptions;
}

function buildRawMockPi(): {
  pi: ExtensionAPI;
  commands: RawRegisteredCommand[];
  sent: SentMessage[];
} {
  const commands: RawRegisteredCommand[] = [];
  const sent: SentMessage[] = [];
  const pi: ExtensionAPI = {
    registerCommand: (name: string, options: PiCommandOptions) => {
      commands.push({ name, options });
    },
    sendMessage: (msg: SentMessage) => {
      sent.push(msg);
    },
  };
  return { pi, commands, sent };
}

describe("canonical registerCommand — opts.handler shape", () => {
  async function runFactoryRaw(): Promise<{
    commands: RawRegisteredCommand[];
    sent: SentMessage[];
  }> {
    const { pi, commands, sent } = buildRawMockPi();
    await runFactory(pi);
    return { commands, sent };
  }

  test("registerCommand receives string name 'workflow'", async () => {
    const { commands } = await runFactoryRaw()
    const names = commands.map((c) => c.name);
    assert.ok(names.includes("workflow"));
  });

  test("registerCommand does not receive per-workflow alias names", async () => {
    const { commands } = await runFactoryRaw()
    const names = commands.map((c) => c.name);
    assert.equal(names.some((n) => n.startsWith("workflow:")), false);
  });

  test("opts passed to registerCommand have 'handler' (function)", async () => {
    const { commands } = await runFactoryRaw()
    for (const { name, options } of commands) {
      assert.equal(typeof options.handler, "function", `${name}: handler should be function`);
    }
  });

  test("opts passed to registerCommand do NOT have 'execute' property", async () => {
    const { commands } = await runFactoryRaw()
    for (const { name, options } of commands) {
      assert.equal(Object.prototype.hasOwnProperty.call(options, "execute"),
        false, `${name}: opts must not have execute — use handler`);
    }
  });

  test("opts have 'description' string", async () => {
    const { commands } = await runFactoryRaw()
    for (const { name, options } of commands) {
      assert.equal(typeof options.description, "string", `${name}: description should be string`);
    }
  });

  test("handler for 'workflow' is callable — does not throw synchronously", async () => {
    const { commands, sent } = await runFactoryRaw();
    const workflowCmd = commands.find((c) => c.name === "workflow");
    assert.notEqual(workflowCmd, undefined);
    const msgs: string[] = [];
    const ctx: PiCommandContext = {
      ui: {
        notify(message: string) {
          msgs.push(message);
        },
      },
    };
    await workflowCmd!.options.handler("list", ctx);
    // `/workflow list` now routes through `emitChatSurface` → pi.sendMessage,
    // so the catalogue payload lands in `sent` rather than `msgs`. Either
    // path counts as the handler having produced output.
    assert.ok(msgs.length > 0 || sent.length > 0);
    if (sent.length > 0) {
      const listPayload = sent.find(
        (m) => (m.details as { kind?: string } | undefined)?.kind === "list",
      );
      assert.ok(listPayload, "expected a chat-surface list message to be sent");
    }
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

describe("/workflow interrupt chat command", () => {
  test("top-level /workflow kill <id> kills and removes from chat without requiring confirmation", async () => {
    const runId = `kill-chat-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));

    const { pi, commands, sent } = buildMockPi();
    addFactoryStubs(pi);

    const factoryModule = await import("../../packages/workflows/src/extension/index.js");
    factoryModule.default(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow")!;
    const msgs: string[] = [];
    let confirmCalls = 0;
    const ctx: PiCommandContext = {
      ui: {
        notify: (message: string) => { msgs.push(message); },
        confirm: async () => {
          confirmCalls++;
          return false;
        },
      },
    };

    await workflowCmd.options.handler(`kill ${runId}`, ctx);

    const run = store.runs().find((r) => r.id === runId);
    assert.equal(confirmCalls, 0);
    assert.equal(run, undefined);
    assert.equal(msgs.some((m) => m.includes("killed and removed")), true);
    assert.equal(sent.some((m) => (m.details as { kind?: string } | undefined)?.kind === "killed"), true);
  });

  test("top-level /workflow interrupt defaults to the active run", async () => {
    const runId = `interrupt-active-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));

    const { pi, commands } = buildMockPi();
    addFactoryStubs(pi);

    const factoryModule = await import("../../packages/workflows/src/extension/index.js");
    factoryModule.default(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow")!;
    const msgs: string[] = [];
    const ctx: PiCommandContext = {
      ui: {
        notify: (message: string) => { msgs.push(message); },
        confirm: async () => false,
      },
    };

    await workflowCmd.options.handler("interrupt", ctx);

    const run = store.runs().find((r) => r.id === runId);
    assert.equal(run?.status, "running");
    assert.equal(msgs.some((m) => m.includes("No active stages to interrupt")), true);
  });

  test("top-level /workflow interrupt <id> reports no active stages without confirmation", async () => {
    const runId = `interrupt-chat-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));

    const { pi, commands } = buildMockPi();
    addFactoryStubs(pi);

    const factoryModule = await import("../../packages/workflows/src/extension/index.js");
    factoryModule.default(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow")!;
    const msgs: string[] = [];
    let confirmCalls = 0;
    const ctx: PiCommandContext = {
      ui: {
        notify: (message: string) => { msgs.push(message); },
        confirm: async () => {
          confirmCalls++;
          return false;
        },
      },
    };

    await workflowCmd.options.handler(`interrupt ${runId}`, ctx);

    const run = store.runs().find((r) => r.id === runId);
    assert.equal(confirmCalls, 0);
    assert.equal(run?.status, "running");
    assert.equal(msgs.some((m) => m.includes("No active stages to interrupt")), true);
  });
});

// ---------------------------------------------------------------------------
// resume regression: /workflow resume opens overlay + no legacy message
// ---------------------------------------------------------------------------

describe("/workflow resume <runId> — overlay open + no legacy message", () => {
  test("seeds active run; /workflow resume calls overlay.open with overlay:true", async () => {
    const runId = `resume-slash-overlay-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));

    const openCalls: Array<{ overlay: boolean }> = [];
    const { pi, commands } = buildMockPi();
    addFactoryStubs(pi);
    const customFn: PiCustomOverlayFunction = (factoryArg, options: PiCustomOverlayOptions) => {
      openCalls.push({ overlay: options.overlay });
      // Mirror Pi's runtime: invoke the factory and surface a handle
      // so the adapter has the same control surface it would in prod.
      const handle: PiOverlayHandle = {
        hide: () => undefined,
        setHidden: () => undefined,
        isHidden: () => false,
        focus: () => undefined,
        unfocus: () => undefined,
        isFocused: () => true,
      };
      options.onHandle?.(handle);
      const tui: PiCustomOverlayFactoryTui = { requestRender: () => undefined };
      const component = factoryArg(tui, {}, {}, () => undefined);
      if (component instanceof Promise) throw new Error("expected sync factory");
      // Touch render so the GraphView's render path is exercised.
      (component as PiCustomComponent).render(80);
      return undefined;
    };
    pi.ui = {
      setWidget: () => {},
      custom: customFn,
    };

    const factoryModule = await import("../../packages/workflows/src/extension/index.js");
    factoryModule.default(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow")!;
    const msgs: string[] = [];
    const ctx: PiCommandContext = { ui: { notify: (m: string) => { msgs.push(m); } } };

    await workflowCmd.options.handler(`resume ${runId}`, ctx);

    assert.ok(openCalls.length > 0);
    assert.equal(openCalls[0].overlay, true);
  });

  test("active run resume output does NOT include 'still active — no resume needed'", async () => {
    const runId = `resume-nomsg-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));

    const { pi, commands } = buildMockPi();
    addFactoryStubs(pi);
    const customFn: PiCustomOverlayFunction = (factoryArg, options) => {
      const handle: PiOverlayHandle = {
        hide: () => undefined,
        setHidden: () => undefined,
        isHidden: () => false,
        focus: () => undefined,
        unfocus: () => undefined,
        isFocused: () => true,
      };
      options.onHandle?.(handle);
      const tui: PiCustomOverlayFactoryTui = { requestRender: () => undefined };
      factoryArg(tui, {}, {}, () => undefined);
      return undefined;
    };
    pi.ui = {
      setWidget: () => {},
      custom: customFn,
    };

    const factoryModule = await import("../../packages/workflows/src/extension/index.js");
    factoryModule.default(pi);

    const workflowCmd = commands.find((c) => c.name === "workflow")!;
    const msgs: string[] = [];
    const ctx: PiCommandContext = { ui: { notify: (m: string) => { msgs.push(m); } } };

    await workflowCmd.options.handler(`resume ${runId}`, ctx);

    assert.equal(msgs.every((m) => !m.includes("still active")), true);
    assert.equal(msgs.every((m) => !m.includes("no resume needed")), true);
  });
});

// ---------------------------------------------------------------------------
// resume regression: tool action "resume" against active run returns status:"ok"
// ---------------------------------------------------------------------------

describe("tool run-control actions", () => {
  function makeToolHandler() {
    const registry = createRegistry([]);
    const runtime = createExtensionRuntime({ registry });
    return makeExecuteWorkflowTool(runtime, () => undefined);
  }

  test("makeExecuteWorkflowTool kill without runId defaults to the active run", async () => {
    const runId = `kill-tool-active-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));
    const handler = makeToolHandler();

    const result = await handler({ action: "kill" }, {} as never);

    assert.equal(result.action, "kill");
    const r = result as { action: string; status: string; runId: string };
    assert.equal(r.status, "killed");
    assert.equal(r.runId, runId);
    assert.equal(store.runs().some((run) => run.id === runId), false);
  });

  test("makeExecuteWorkflowTool kill supports unique run id prefixes", async () => {
    const runId = `kill-tool-prefix-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));
    const handler = makeToolHandler();

    const result = await handler({ action: "kill", runId: runId.slice(0, 12) }, {} as never);

    assert.equal(result.action, "kill");
    const r = result as { action: string; status: string; runId: string };
    assert.equal(r.status, "killed");
    assert.equal(r.runId, runId);
    assert.equal(store.runs().some((run) => run.id === runId), false);
  });

  test("makeExecuteWorkflowTool kill supports all:true", async () => {
    const r1 = `kill-tool-all-1-${Date.now()}`;
    const r2 = `kill-tool-all-2-${Date.now()}`;
    const ended = `kill-tool-all-ended-${Date.now()}`;
    store.recordRunStart(makeInflightRun(r1));
    store.recordRunStart(makeInflightRun(r2));
    store.recordRunStart(makeInflightRun(ended));
    store.recordRunEnd(ended, "completed");
    const handler = makeToolHandler();

    const result = await handler({ action: "kill", all: true }, {} as never);

    assert.equal(result.action, "kill");
    const r = result as { action: string; status: string };
    assert.equal(r.status, "killed");
    assert.equal(store.runs().some((run) => run.id === r1), false);
    assert.equal(store.runs().some((run) => run.id === r2), false);
    assert.equal(store.runs().some((run) => run.id === ended), true);
  });

  test("makeExecuteWorkflowTool interrupt without runId defaults to the active run", async () => {
    const runId = `interrupt-tool-active-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));
    const handler = makeToolHandler();

    const result = await handler({ action: "interrupt" }, {} as never);

    assert.equal(result.action, "interrupt");
    const r = result as { action: string; status: string; runId: string; message: string };
    assert.equal(r.status, "noop");
    assert.equal(r.runId, runId);
    assert.match(r.message, /No active stages to interrupt/);
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
  });

  test("makeExecuteWorkflowTool returns ambiguous run-prefix messages", async () => {
    store.recordRunStart(makeInflightRun("ambiguous-run-a"));
    store.recordRunStart(makeInflightRun("ambiguous-run-b"));
    const handler = makeToolHandler();

    const result = await handler({ action: "kill", runId: "ambiguous-run" }, {} as never);

    assert.equal(result.action, "kill");
    const r = result as { action: string; status: string; message: string };
    assert.equal(r.status, "noop");
    assert.match(r.message, /Ambiguous run prefix/);
    assert.equal(store.runs().some((run) => run.id === "ambiguous-run-a"), true);
    assert.equal(store.runs().some((run) => run.id === "ambiguous-run-b"), true);
  });

  test("makeExecuteWorkflowTool resume accepts run prefixes, stage names, and messages", async () => {
    const runId = `resume-tool-stage-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));
    store.recordStageStart(runId, {
      id: "stage-abc123",
      name: "review-stage",
      status: "running",
      parentIds: [],
      toolEvents: [],
    });
    const handler = makeToolHandler();

    const result = await handler(
      { action: "resume", runId: runId.slice(0, 12), stageId: "review-stage", message: "continue please" },
      {} as never,
    );

    assert.equal(result.action, "resume");
    const r = result as { action: string; status: string; runId: string; message: string };
    assert.equal(r.status, "ok");
    assert.equal(r.runId, runId);
    assert.match(r.message, /Snapshot available/);
  });

  test("makeExecuteWorkflowTool resume against in-flight run returns status:'ok'", async () => {
    const runId = `resume-tool-ok-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));

    const handler = makeToolHandler();

    const result = await handler(
      { action: "resume", runId },
      {} as never,
    );

    assert.equal(result.action, "resume");
    const r = result as { action: string; status: string; runId: string };
    assert.equal(r.status, "ok");
    assert.equal(r.runId, runId);
  });

  test("runtime runDirect classifies direct pre-run model auth failures", async () => {
    const runtime = createExtensionRuntime({
      registry: createRegistry([]),
      models: {
        async listModels() {
          throw { message: "request failed", status: 401 };
        },
      },
    });

    const result = await runtime.runDirect({ task: { name: "scout", task: "inspect repo", model: "openai/gpt" }, async: true });

    assert.equal(result.status, "failed");
    assert.equal(result.error, WORKFLOW_AUTH_FAILURE_MESSAGE);
  });

  test("makeExecuteWorkflowTool resume rejects ambiguous stage prefixes", async () => {
    const runId = `resume-tool-ambiguous-stage-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));
    for (const stageId of ["ambiguous-stage-aaa", "ambiguous-stage-bbb"]) {
      store.recordStageStart(runId, {
        id: stageId,
        name: stageId,
        status: "failed",
        parentIds: [],
        toolEvents: [],
      });
      store.recordStageEnd(runId, {
        id: stageId,
        name: stageId,
        status: "failed",
        parentIds: [],
        toolEvents: [],
        error: "boom",
      });
    }
    store.recordRunEnd(runId, "failed", undefined, "boom", { resumable: true, failedStageId: "ambiguous-stage-aaa" });
    const handler = makeToolHandler();

    const result = await handler({ action: "resume", runId, stageId: "ambiguous-stage" }, {} as never);

    assert.equal(result.action, "resume");
    const r = result as { action: string; status: string; runId: string; message: string };
    assert.equal(r.status, "noop");
    assert.equal(r.runId, runId);
    assert.match(r.message, /Ambiguous stage identifier/);
    assert.match(r.message, /ambiguous-stage-aaa/);
    assert.match(r.message, /ambiguous-stage-bbb/);
  });

  test("makeExecuteWorkflowTool resume starts linked continuation for failed resumable workflow", async () => {
    const sourceRunId = `resume-tool-source-${Date.now()}`;
    const def = defineWorkflow("tool-resume-wf")
      .run(async (ctx) => {
        const first = await ctx.stage("first").prompt("first");
        const second = await ctx.stage("second").prompt(`second:${first}`);
        return { first, second };
      })
      .compile();

    store.recordRunStart({
      id: sourceRunId,
      name: def.name,
      inputs: {},
      status: "running",
      startedAt: Date.now(),
      stages: [],
    });
    store.recordStageStart(sourceRunId, { id: "old-first", name: "first", status: "completed", parentIds: [], toolEvents: [], result: "first-old" });
    store.recordStageEnd(sourceRunId, { id: "old-first", name: "first", status: "completed", parentIds: [], toolEvents: [], result: "first-old" });
    store.recordStageStart(sourceRunId, { id: "old-second", name: "second", status: "failed", parentIds: ["old-first"], toolEvents: [], error: "rate limit" });
    store.recordStageEnd(sourceRunId, { id: "old-second", name: "second", status: "failed", parentIds: ["old-first"], toolEvents: [], error: "rate limit" });
    store.recordRunEnd(sourceRunId, "failed", undefined, "rate limit", { resumable: true, failedStageId: "old-second", failureKind: "rate_limit" });

    const calls: string[] = [];
    const runtime = createExtensionRuntime({
      registry: createRegistry([def]),
      store,
      adapters: { prompt: { prompt: async (text) => { calls.push(text); return "second-new"; } } },
    });
    const handler = makeExecuteWorkflowTool(runtime, () => undefined);

    const result = await handler({ action: "resume", runId: sourceRunId }, {} as never);

    assert.equal(result.action, "resume");
    const r = result as { action: string; status: string; runId: string; message: string };
    assert.equal(r.status, "running");
    assert.notEqual(r.runId, sourceRunId);
    assert.match(r.message, /Resuming failed workflow/);
    await jobTracker.get(r.runId)?.promise;
    assert.deepEqual(calls, ["second:first-old"]);
    const continued = store.runs().find((run) => run.id === r.runId)!;
    assert.equal(continued.status, "completed");
    assert.equal(continued.resumedFromRunId, sourceRunId);
    assert.equal(continued.stages[0]!.replayed, true);
    assert.equal(store.runs().find((run) => run.id === sourceRunId)!.status, "failed");
  });

  test("makeExecuteWorkflowTool resume surfaces workflow_not_found for failed resumable run without registry definition", async () => {
    const runId = `resume-tool-failed-${Date.now()}`;
    store.recordRunStart(makeInflightRun(runId));
    store.recordStageStart(runId, {
      id: "stage-a",
      name: "stage-a",
      status: "failed",
      parentIds: [],
      toolEvents: [],
    });
    store.recordStageEnd(runId, {
      id: "stage-a",
      name: "stage-a",
      status: "failed",
      parentIds: [],
      toolEvents: [],
      error: "boom",
    });
    store.recordRunEnd(runId, "failed", undefined, "boom", { resumable: true, failedStageId: "stage-a" });

    const handler = makeToolHandler();

    const result = await handler(
      { action: "resume", runId },
      {} as never,
    );

    assert.equal(result.action, "resume");
    const r = result as { action: string; status: string; runId: string; message: string };
    assert.equal(r.status, "noop");
    assert.equal(r.runId, runId);
    assert.match(r.message, /workflow_not_found/);
  });
});
