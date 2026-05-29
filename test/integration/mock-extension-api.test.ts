/**
 * Integration tests: MockExtensionAPI registration.
 * Verifies factory(pi) registers workflow tool, slash commands,
 * and message renderers against a minimal MockExtensionAPI.
 *
 * cross-ref: spec §5.2 workflow tool, §5.3 slash commands,
 *            §5.6 renderer registration, §8.3 Phase B tests
 */

import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory, {
  makeExecuteWorkflowTool,
  type ExtensionAPI,
  type PiToolOpts,
  type PiCommandOptions,
  type PiFlagNamedOpts,
  type PiMessageRendererResult,
  type WorkflowToolArgs,
} from "../../packages/workflows/src/extension/index.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { renderCall } from "../../packages/workflows/src/extension/render-call.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { waitForRun } from "../support/helpers.ts";
import { store as defaultStore } from "../../packages/workflows/src/shared/store.ts";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

// ---------------------------------------------------------------------------
// MockExtensionAPI
// ---------------------------------------------------------------------------

interface RegisteredTool {
  opts: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
}

interface RegisteredCommand {
  name: string;
  options: PiCommandOptions;
}

interface RegisteredRenderer {
  event: string;
  renderer: (payload: Record<string, unknown>) => PiMessageRendererResult;
}

interface RegisteredFlag {
  name: string;
  options: PiFlagNamedOpts;
}

interface SentMessage {
  customType?: string;
  content?: string;
  display?: boolean;
  details?: unknown;
}

function makeMock(): ExtensionAPI & {
  tools: RegisteredTool[];
  commands: RegisteredCommand[];
  renderers: RegisteredRenderer[];
  flags: RegisteredFlag[];
  sent: SentMessage[];
} {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const renderers: RegisteredRenderer[] = [];
  const flags: RegisteredFlag[] = [];
  const sent: SentMessage[] = [];

  const api: ExtensionAPI & {
    tools: RegisteredTool[];
    commands: RegisteredCommand[];
    renderers: RegisteredRenderer[];
    flags: RegisteredFlag[];
    sent: SentMessage[];
  } = {
    tools,
    commands,
    renderers,
    flags,
    sent,
    // Keep integration tests deterministic: the startup registry already
    // contains bundled workflows, and project/global async discovery can spawn
    // background work that outlives each lightweight mock factory instance.
    disableAsyncDiscovery: true,

    registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
      tools.push({ opts: opts as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult> });
    },

    registerCommand(name: string, options: PiCommandOptions) {
      commands.push({ name, options });
    },

    registerMessageRenderer(event: string, renderer: (payload: Record<string, unknown>) => PiMessageRendererResult) {
      renderers.push({ event, renderer });
    },

    registerFlag(name: string, options: PiFlagNamedOpts) {
      flags.push({ name, options });
    },
    // Chat surfaces dispatch via emitChatSurface → pi.sendMessage. Mirror
    // the recipient so tests can assert against the message stream.
    sendMessage(msg: SentMessage) {
      sent.push(msg);
    },
  };

  return api;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Test shim for the pi-conformant tool execute signature.
 * Pi calls execute as `(toolCallId, params, signal, onUpdate, ctx)` and the
 * tool returns `{ content, details }` per AgentToolResult. These tests assert
 * against the workflow-specific `details` payload, so this helper unwraps it.
 */
async function runTool(
  execute: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>["execute"],
  params: WorkflowToolArgs,
): Promise<WorkflowToolResult> {
  const out = await execute("test-tool-call", params, undefined, undefined, {} as never);
  return out.details;
}

function recordWorkflowRun(
  id: string,
  name: string,
  status: "running" | "completed" | "failed" | "killed",
  error?: string,
): void {
  defaultStore.recordRunStart({
    id,
    name,
    inputs: {},
    stages: [],
    status: "running",
    startedAt: Date.now(),
  });
  if (status !== "running") {
    defaultStore.recordRunEnd(id, status, undefined, error);
  }
}

function getCommand(commands: RegisteredCommand[], name: string): RegisteredCommand | undefined {
  return commands.find((c) => c.name === name);
}

function getRenderer(
  renderers: RegisteredRenderer[],
  event: string,
): ((payload: Record<string, unknown>) => PiMessageRendererResult) | undefined {
  return renderers.find((r) => r.event === event)?.renderer;
}

function expectStringRendererOutput(output: PiMessageRendererResult): string {
  if (typeof output !== "string") {
    throw new Error("Expected renderer to return a string");
  }
  return output;
}

function expectRegisteredCommand(
  commands: RegisteredCommand[],
  name: string,
): RegisteredCommand {
  const cmd = getCommand(commands, name);
  if (cmd === undefined) {
    throw new Error(`Expected command "${name}" to be registered`);
  }

  assert.equal(cmd.name, name);
  assert.equal(typeof cmd.options.description, "string");
  assert.ok(cmd.options.description.length > 0);
  assert.equal(typeof cmd.options.handler, "function");
  return cmd;
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

  test("registers only the workflow tool", () => {
    // `workflow` is the workflows extension's sole registered tool;
    // `ask_user_question` now ships as a base tool from the coding-agent
    // package and is not registered here.
    assert.equal(mock.tools.length, 1);
    const names = mock.tools.map((t) => t.opts.name).sort();
    assert.deepEqual(names, ["workflow"]);
  });

  test("workflow tool is registered first (stable ordering)", () => {
    // Downstream tests in this suite use `mock.tools[0]!` as a shortcut to
    // the workflow tool — register the workflow tool first so that path
    // stays stable.
    assert.equal(mock.tools[0]!.opts.name, "workflow");
  });

  test("tool has non-empty description", () => {
    assert.equal(typeof mock.tools[0]!.opts.description, "string");
    assert.ok(mock.tools[0]!.opts.description.length > 0);
  });

  test("tool has parameters schema (TypeBox object)", () => {
    const params = mock.tools[0]!.opts.parameters as Record<string, unknown>;
    assert.notEqual(params, undefined);
    // TypeBox TObject has a 'type' property equal to 'object'
    assert.equal(params["type"], "object");
  });

  test("tool parameters include named, control, and direct execution properties", () => {
    const params = mock.tools[0]!.opts.parameters as {
      properties: Record<string, unknown>;
    };
    assert.ok("workflow" in params.properties);
    assert.ok(!("name" in params.properties));
    assert.ok("inputs" in params.properties);
    assert.ok("action" in params.properties);
    assert.ok("runId" in params.properties);
    assert.ok("all" in params.properties);
    assert.ok("stageId" in params.properties);
    assert.ok("message" in params.properties);
    assert.ok(!("id" in params.properties));
    assert.ok("task" in params.properties);
    assert.ok("tasks" in params.properties);
    assert.ok("chain" in params.properties);
    assert.ok("chainName" in params.properties);
    assert.ok("context" in params.properties);
    assert.ok("cwd" in params.properties);
    assert.ok("output" in params.properties);
    assert.ok("outputMode" in params.properties);
    assert.ok("maxOutput" in params.properties);
    assert.ok("artifacts" in params.properties);
    assert.ok("sessionDir" in params.properties);
  });

  test("tool 'action' schema covers rewritten literals only", () => {
    const params = mock.tools[0]!.opts.parameters as {
      properties: {
        action: { anyOf?: Array<{ const?: string; enum?: string[] }> };
      };
    };
    const actionSchema = params.properties.action;
    // TypeBox Optional(Union([...])) wraps in anyOf
    const raw = JSON.stringify(actionSchema);
    for (const literal of ["run", "list", "get", "status", "interrupt", "kill", "resume", "inputs"]) {
      assert.ok(raw.includes(literal));
    }
    assert.ok(!raw.includes("doctor"));
  });

  test("tool execute returns run stub for default action", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "my-workflow", inputs: {} });
    assert.equal(result.action, "run");
  });

  test("tool execute runs direct single-task mode through workflow runtime", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, {
      task: { name: "scout", task: "inspect direct mode" },
    });

    assert.equal(result.action, "run");
    const r = result as {
      action: "run";
      runId: string;
      status: string;
      details?: {
        mode: string;
        status: string;
        results?: Array<{ name: string; text: string }>;
      };
    };
    assert.equal(r.status, "completed");
    assert.equal(r.details?.mode, "single");
    assert.equal(r.details?.status, "completed");
    assert.equal(r.details?.results?.[0]?.name, "scout");
    assert.equal(r.details?.results?.[0]?.text, "stub:sdk:inspect direct mode");
    assert.ok(r.runId);
  });

  test("tool execute writes direct task output artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-tool-output-"));
    const output = join(dir, "scout.md");
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, {
      task: { name: "scout", task: "inspect with output", output },
    });

    assert.equal(result.action, "run");
    assert.equal(readFileSync(output, "utf8"), "stub:sdk:inspect with output");
    const r = result as {
      action: "run";
      details?: {
        artifacts?: Array<{ kind: string; path: string; taskName?: string }>;
      };
    };
    assert.ok(r.details?.artifacts?.some((artifact) =>
      artifact.kind === "output" &&
      artifact.path === output &&
      artifact.taskName === "scout",
    ));
  });

  test("tool execute runs direct parallel mode and expands count", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, {
      tasks: [{ name: "reviewer", task: "review direct mode", count: 2 }],
    });

    assert.equal(result.action, "run");
    const r = result as {
      action: "run";
      status: string;
      details?: {
        mode: string;
        results?: Array<{ name: string; text: string }>;
      };
    };
    assert.equal(r.status, "completed");
    assert.equal(r.details?.mode, "parallel");
    assert.deepEqual(r.details?.results?.map((item) => item.name), ["reviewer-1", "reviewer-2"]);
    assert.deepEqual(r.details?.results?.map((item) => item.text), [
      "stub:sdk:review direct mode",
      "stub:sdk:review direct mode",
    ]);
  });

  test("tool execute accepts async direct task runs and records them in the store", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, {
      task: { name: "async-scout", task: "inspect async mode" },
      async: true,
    });

    assert.equal(result.action, "run");
    const r = result as {
      action: "run";
      runId: string;
      status: string;
      details?: {
        mode: string;
        status: string;
        progress?: { completed: number; total: number };
      };
    };
    assert.equal(r.status, "accepted");
    assert.equal(r.details?.mode, "single");
    assert.equal(r.details?.status, "accepted");
    assert.deepEqual(r.details?.progress, { completed: 0, total: 1 });

    await waitForRun(r.runId, { store: defaultStore });
    const settled = defaultStore.runs().find((run) => run.id === r.runId);
    assert.notEqual(settled, undefined);
    assert.equal(settled?.name, "direct-task");
    assert.equal(settled?.status, "completed");

    const status = await runTool(execute, { action: "status", runId: r.runId });
    assert.equal(status.action, "statusDetail");
    const statusDetail = status as { action: "statusDetail"; runId: string };
    assert.equal(statusDetail.runId, r.runId);
  });

  test("tool execute can interrupt an async direct task while it is running", async () => {
    let promptStarted = false;
    const runtime = createExtensionRuntime({
      store: defaultStore,
      cancellation: cancellationRegistry,
      adapters: {
        prompt: {
          prompt: async (_text, meta) => {
            promptStarted = true;
            await new Promise<void>((resolve) => {
              const signal = meta?.signal;
              if (signal?.aborted) {
                resolve();
                return;
              }
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            return "aborted cleanup";
          },
        },
      },
    });
    const executeWorkflowTool = makeExecuteWorkflowTool(runtime, () => undefined, () => undefined);

    const started = await executeWorkflowTool({
      task: { name: "blocking-scout", task: "wait for interrupt" },
      async: true,
    }, {});
    assert.equal(started.action, "run");
    const runId = (started as Extract<WorkflowToolResult, { action: "run" }>).runId;
    assert.ok(runId);

    for (let attempt = 0; attempt < 20 && !promptStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(promptStarted, true);

    const interrupted = await executeWorkflowTool({ action: "interrupt", runId }, {});
    assert.equal(interrupted.action, "interrupt");
    const interruptResult = interrupted as Extract<WorkflowToolResult, { action: "interrupt" }>;
    assert.equal(interruptResult.status, "paused");

    const paused = defaultStore.runs().find((run) => run.id === runId);
    assert.equal(paused?.status, "paused");

    defaultStore.removeRun(runId);
  });

  test("tool execute runs direct chain mode with root task defaults", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, {
      task: "map direct chain",
      chain: [
        { name: "researcher" },
        {
          parallel: [
            { name: "reviewer-a" },
            { name: "reviewer-b", task: "check {previous}" },
          ],
        },
      ],
    });

    assert.equal(result.action, "run");
    const r = result as {
      action: "run";
      status: string;
      details?: {
        mode: string;
        results?: Array<{ name: string; text: string }>;
      };
    };
    assert.equal(r.status, "completed");
    assert.equal(r.details?.mode, "chain");
    assert.deepEqual(r.details?.results?.map((item) => item.name), [
      "researcher",
      "reviewer-a",
      "reviewer-b",
    ]);
    assert.equal(r.details?.results?.[0]?.text, "stub:sdk:map direct chain");
    assert.equal(r.details?.results?.[1]?.text, "stub:sdk:stub:sdk:map direct chain");
    assert.equal(r.details?.results?.[2]?.text, "stub:sdk:check stub:sdk:map direct chain");
  });

  test("tool execute rejects ambiguous named workflow plus direct task mode", async () => {
    const execute = mock.tools[0]!.opts.execute;
    await assert.rejects(
      () => runTool(execute, {
        workflow: "deep-research-codebase",
        task: { name: "scout", task: "inspect" },
      }),
      /exactly one normal execution mode/,
    );
  });

  test("tool execute returns list stub for action='list'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { inputs: {}, action: "list" });
    assert.equal(result.action, "list");
    assert.equal(
      Array.isArray((result as { action: "list"; items: unknown[] }).items),
      true,
    );
  });

  test("tool execute returns status stub for action='status'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { inputs: {}, action: "status" });
    assert.equal(result.action, "status");
    assert.equal(
      Array.isArray((result as { action: "status"; snapshots: unknown[] }).snapshots),
      true,
    );
  });

  test("tool execute status includes retained terminal snapshots", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const activeId = `status-active-${Date.now()}`;
    const completedId = `status-completed-${Date.now()}`;
    const failedId = `status-failed-${Date.now()}`;
    const killedId = `status-killed-${Date.now()}`;
    recordWorkflowRun(activeId, "active", "running");
    recordWorkflowRun(completedId, "completed", "completed");
    recordWorkflowRun(failedId, "failed", "failed", "boom");
    recordWorkflowRun(killedId, "killed", "killed", "killed");

    const result = await runTool(execute, { inputs: {}, action: "status" });
    const snapshots = (result as { action: "status"; snapshots: Array<{ id: string; status: string }> }).snapshots;

    assert.deepEqual(
      [activeId, completedId, failedId, killedId].map((id) => snapshots.find((s) => s.id === id)?.status),
      ["running", "completed", "failed", "killed"],
    );
  });

  test("tool execute returns inputs stub for action='inputs'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "wf", inputs: {}, action: "inputs" });
    assert.equal(result.action, "inputs");
    const r = result as { action: "inputs"; name: string; inputs: unknown[] };
    assert.equal(r.name, "wf");
    assert.equal(Array.isArray(r.inputs), true);
  });

  test("tool execute accepts canonical workflow field for action='inputs'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "deep-research-codebase", action: "inputs" });
    assert.equal(result.action, "inputs");
    const r = result as { action: "inputs"; name: string; inputs: Array<{ name: string }> };
    assert.equal(r.name, "deep-research-codebase");
    assert.ok(r.inputs.some((input) => input.name === "prompt"));
  });

  test("tool execute returns read-only workflow details for action='get'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "deep-research-codebase", action: "get" });

    assert.equal(result.action, "get");
    const r = result as {
      action: "get";
      details?: {
        mode: string;
        action: string;
        status: string;
        output?: {
          workflow?: string;
          description?: string;
          inputs?: Array<{ name: string; required?: boolean }>;
        };
      };
      error?: string;
    };
    assert.equal(r.error, undefined);
    assert.equal(r.details?.mode, "inspection");
    assert.equal(r.details?.action, "get");
    assert.equal(r.details?.status, "completed");
    assert.equal(r.details?.output?.workflow, "deep-research-codebase");
    assert.ok(r.details?.output?.description?.includes("Scout"));
    assert.ok(r.details?.output?.inputs?.some((input) => input.name === "prompt" && input.required === true));
  });

  test("tool execute rejects unknown actions", async () => {
    const execute = mock.tools[0]!.opts.execute;
    await assert.rejects(
      () => runTool(execute, { runId: "run-123", action: "archive" } as unknown as WorkflowToolArgs),
      /unknown action "archive"/,
    );
  });

  test("tool execute returns interrupt result for canonical action='interrupt'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { runId: "run-123", action: "interrupt" });
    assert.equal(result.action, "interrupt");
    const r = result as { action: "interrupt"; runId: string; status: string; message: string };
    assert.equal(r.runId, "run-123");
    assert.equal(r.status, "noop");
    assert.ok(r.message.includes("Run not found"));
  });

  test("tool execute returns kill result for canonical action='kill'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { runId: "run-123", action: "kill" });
    assert.equal(result.action, "kill");
    const r = result as { action: "kill"; runId: string; status: string; message: string };
    assert.equal(r.runId, "run-123");
    assert.equal(r.status, "noop");
    assert.ok(r.message.includes("Run not found"));
  });

  test("tool execute returns resume stub for action='resume'", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { runId: "run-456", inputs: {}, action: "resume" });
    assert.equal(result.action, "resume");
  });

  test("tool has renderCall slot", () => {
    assert.equal(typeof mock.tools[0]!.opts.renderCall, "function");
  });

  test("tool has renderResult slot", () => {
    assert.equal(typeof mock.tools[0]!.opts.renderResult, "function");
  });

  test("tool renders its own shell", () => {
    assert.equal(mock.tools[0]!.opts.renderShell, "self");
  });

  test("tool renderCall slot delegates correctly", () => {
    const slot = mock.tools[0]!.opts.renderCall!;
    const out = slot({ workflow: "test-wf", inputs: {}, action: "run" }, {} as never, {} as never);
    assert.ok(out.includes("test-wf"));
  });

  test("tool renderResult slot delegates correctly", () => {
    const slot = mock.tools[0]!.opts.renderResult!;
    const details: WorkflowToolResult = {
      action: "run",
      runId: "abc",
      status: "pending",
      message: "not yet implemented",
    };
    const out = slot({ content: [{ type: "text", text: "" }], details }, {}, {} as never, {} as never);
    assert.ok(out.includes("abc"));
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

  test("registers at least one command", () => {
    assert.ok(mock.commands.length >= 1);
  });

  test("/workflow command registered", () => {
    assert.notEqual(getCommand(mock.commands, "workflow"), undefined);
  });

  test("/workflow registered through canonical (name, opts) tuple", () => {
    expectRegisteredCommand(mock.commands, "workflow");
  });

  test("/workflow has non-empty description", () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    assert.ok(cmd.options.description.length > 0);
  });

  test("/workflow execute with empty args calls reply/print or sendMessage", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    await cmd.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    // Empty args now routes through the chat-surface renderer (kind:
    // "list"); pre-Component-path tests expected ctx.ui.notify to receive
    // output. Accept either signal.
    assert.ok(messages.length > 0 || mock.sent.length > 0);
  });

  test("/workflow execute 'list' calls reply/print or sendMessage", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    await cmd.options.handler("list", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(messages.length > 0 || mock.sent.length > 0);
  });

  test("/workflow execute 'status' calls reply/print or sendMessage", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    await cmd.options.handler("status", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(messages.length > 0 || mock.sent.length > 0);
  });

  test("/workflow execute unknown arg calls reply/print", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const messages: string[] = [];
    await cmd.options.handler("run my-wf", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(messages.length > 0);
  });
  test("/workflow getArgumentCompletions returns all subcommands for empty partial", () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = cmd.options.getArgumentCompletions?.("");
    assert.equal(Array.isArray(completions), true);
    assert.equal(typeof (completions as Promise<unknown> | null)?.then, "undefined");
    const labels = completions!.map((c) => c.label);
    for (const sub of ["list", "status", "connect", "interrupt", "kill", "resume", "inputs"]) {
      assert.ok(labels.includes(sub));
    }
    assert.equal(labels.includes("session"), false);
  });

  test("/workflow getArgumentCompletions filters by partial", () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = cmd.options.getArgumentCompletions?.("li");
    assert.notEqual(completions, undefined);
    assert.ok(completions!.length > 0);
    assert.equal(completions!.every((c) => c.label.startsWith("li")), true);
  });

  test("/workflow getArgumentCompletions covers subcommand arguments", () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const inputs = cmd.options.getArgumentCompletions?.("inputs de");
    assert.ok(inputs?.some((c) => c.value === "inputs deep-research-codebase "));

    const status = cmd.options.getArgumentCompletions?.("status --");
    assert.equal(status?.some((c) => c.value === "status --all ") ?? false, false);

    const interrupt = cmd.options.getArgumentCompletions?.("interrupt -");
    assert.ok(interrupt?.some((c) => c.value === "interrupt -y "));

    const kill = cmd.options.getArgumentCompletions?.("kill -");
    assert.ok(kill?.some((c) => c.value === "kill -y "));
  });

  test("/workflow getArgumentCompletions covers workflow run inputs and flags", () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const inputKeys = cmd.options.getArgumentCompletions?.("deep-research-codebase p");
    assert.ok(inputKeys?.some((c) => c.value === "deep-research-codebase prompt="));

    const flags = cmd.options.getArgumentCompletions?.("deep-research-codebase --");
    assert.ok(flags?.some((c) => c.value === "deep-research-codebase --no-picker "));
  });

});

// ---------------------------------------------------------------------------
// Message renderer registration
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — message renderer registration", () => {
  // Per-stage chat-scroll renderers were removed: the orchestrator pane
  // owns the per-stage view, and writing duplicate stage chips into chat
  // pushed unrelated chat content out of view on every stage transition.
  const REQUIRED_EVENTS = [
    "workflow.run.start",
    "workflow.run.end",
  ] as const;

  let mock: ReturnType<typeof makeMock>;

  beforeEach(() => {
    mock = makeMock();
    factory(mock);
  });

  for (const event of REQUIRED_EVENTS) {
    test(`registers renderer for '${event}'`, () => {
      assert.notEqual(getRenderer(mock.renderers, event), undefined);
    });
  }

  test("workflow.run.start renderer returns non-empty string", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.start")!;
    const out = expectStringRendererOutput(renderer({ runId: "r1", name: "my-wf", inputs: { foo: "bar" } }));
    assert.ok(out.length > 0);
    assert.ok(out.includes("my-wf"));
    assert.ok(out.includes("r1"));
  });

  test("workflow.run.start renderer shows input count", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.start")!;
    const out = expectStringRendererOutput(renderer({ runId: "r1", name: "wf", inputs: { a: 1, b: 2 } }));
    assert.ok(out.includes("2"));
  });

  test("workflow.run.end renderer ok status shows success emoji", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.end")!;
    const out = expectStringRendererOutput(renderer({ runId: "r1", status: "ok" }));
    assert.ok(out.includes("✅"));
    assert.ok(out.includes("r1"));
  });

  test("workflow.run.end renderer error status shows failure emoji", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.end")!;
    const out = expectStringRendererOutput(renderer({ runId: "r1", status: "error" }));
    assert.ok(out.includes("❌"));
  });

  test("skips renderer registration when registerMessageRenderer absent", () => {
    // No error thrown even without the method.
    assert.doesNotThrow(() => factory({}));
  });
});

// ---------------------------------------------------------------------------
// CLI flag registration
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — no CLI flag registration", () => {
  test("factory does not register process-level workflow flags", () => {
    const mock = makeMock();
    factory(mock);
    assert.deepEqual(mock.flags, []);
  });

  test("skips flag registration when registerFlag absent", () => {
    assert.doesNotThrow(() => factory({}));
  });
});

// ---------------------------------------------------------------------------
// renderCall — standalone unit coverage (reachable export)
// ---------------------------------------------------------------------------

describe("renderCall — all action branches", () => {
  test("action='list' returns list string", () => {
    assert.equal(renderCall({ action: "list" }), "workflow: list registered workflows");
  });

  test("action='status' returns status string", () => {
    assert.equal(renderCall({ action: "status" }), "workflow: list retained runs");
  });

  test("action='inputs' includes workflow", () => {
    assert.ok(renderCall({ workflow: "wf-a", action: "inputs" }).includes("wf-a"));
  });

  test("action='run' includes workflow", () => {
    assert.ok(renderCall({ workflow: "wf-b", action: "run" }).includes("wf-b"));
  });

  test("action='interrupt' includes runId", () => {
    assert.ok(renderCall({ runId: "run-1", action: "interrupt" }).includes("run-1"));
  });

  test("action='kill' includes runId", () => {
    assert.ok(renderCall({ runId: "run-kill", action: "kill" }).includes("run-kill"));
  });

  test("action='resume' includes runId", () => {
    assert.ok(renderCall({ runId: "run-2", action: "resume" }).includes("run-2"));
  });

  test("defaults to 'run' when action omitted", () => {
    assert.ok(renderCall({ workflow: "wf-c" }).includes("run"));
  });

  test("describes direct task runs instead of an unnamed workflow", () => {
    assert.equal(
      renderCall({ task: { name: "subagent-tool-probe", prompt: "probe" } }),
      'workflow: run "direct-task"',
    );
  });

  test("respects host render width", () => {
    const out = renderCall(
      { action: "run", workflow: "deep-research-codebase-with-a-long-name" },
      { width: 24 },
    );
    assert.ok(visibleWidth(out) <= 24);
    assert.match(out, /…/);
  });
});

// ---------------------------------------------------------------------------
// renderResult — standalone unit coverage (reachable export)
// ---------------------------------------------------------------------------

describe("renderResult — all action branches", () => {
  test("action='list' empty items renders catalogue header", () => {
    const out = renderResult({ action: "list", items: [] });
    assert.match(out, /WORKFLOWS/);
    assert.match(out, /0 registered/);
  });

  test("action='list' with items renders each workflow name", () => {
    const out = renderResult({
      action: "list",
      items: [
        { name: "wf-a", description: "Alpha", inputs: [] },
        { name: "wf-b", description: "Beta", inputs: [{ name: "prompt", required: true }] },
      ],
    });
    assert.ok(out.includes("wf-a"));
    assert.ok(out.includes("wf-b"));
    assert.ok(out.includes("Alpha"));
    assert.ok(out.includes("prompt"));
  });

  test("action='list' respects the host render width", () => {
    const width = 48;
    const out = renderResult(
      {
        action: "list",
        items: [
          {
            name: "deep-research-codebase-with-a-very-long-name",
            description: "Scout and aggregate a long codebase research pass.",
            inputs: [{ name: "prompt", required: true }],
          },
        ],
      },
      { width },
    );
    for (const line of out.split("\n")) {
      assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
    }
  });

  test("all compact tool results respect the host render width", () => {
    const width = 46;
    const cases: WorkflowToolResult[] = [
      {
        action: "get",
        workflow: "deep-research-codebase",
        details: {
          action: "get",
          mode: "inspection",
          status: "completed",
          output: { description: "A very long workflow description that must fit in the tool row." },
          progress: { completed: 0, total: 0 },
        },
      },
      { action: "run", runId: "run-abcdef", status: "running", message: "A very long background dispatch message." },
      {
        action: "transcript",
        runId: "run-abcdef",
        stageId: "stage-abcdef",
        source: "snapshot",
        entries: Array.from({ length: 10 }, (_, index) => ({
          role: "assistant",
          text: `A very long transcript entry ${index} ${"x".repeat(80)}`,
        })),
        truncated: false,
      },
      { action: "interrupt", runId: "run-abcdef", status: "paused", message: "A very long interrupt response message." },
      { action: "kill", runId: "run-abcdef", status: "killed", message: "A very long kill response message." },
      { action: "resume", runId: "run-abcdef", status: "ok", message: "A very long resume response message." },
    ];

    for (const result of cases) {
      const out = renderResult(result, { width });
      for (const line of out.split("\n")) {
        assert.ok(visibleWidth(line) <= width, `${result.action} exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
      }
    }
  });

  test("action='inputs' respects the host render width", () => {
    const width = 52;
    const out = renderResult(
      {
        action: "inputs",
        name: "deep-research-codebase-with-a-long-name",
        inputs: [
          {
            name: "prompt_with_a_very_long_name",
            type: "string",
            required: true,
            description: "A long prompt description that should truncate to fit the current tool width.",
          },
        ],
      },
      { width },
    );
    for (const line of out.split("\n")) {
      assert.ok(visibleWidth(line) <= width, `inputs exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
    }
  });

  test("action='status' empty snapshots renders empty band", () => {
    const out = renderResult({ action: "status", snapshots: [] });
    assert.match(out, /BACKGROUND/);
    assert.match(out, /0 runs/);
    assert.match(out, /no workflow runs in current session/);
  });

  test("action='status' with snapshots renders cards", () => {
    const out = renderResult({
      action: "status",
      snapshots: [
        {
          id: "r1-uuid",
          name: "wf",
          inputs: {},
          status: "running",
          stages: [],
          startedAt: Date.now() - 1_000,
        },
      ],
    });
    assert.ok(out.includes("wf"));
    assert.match(out, /running/);
  });

  test("action='inputs' empty inputs", () => {
    const out = renderResult({ action: "inputs", name: "wf-x", inputs: [] });
    assert.ok(out.includes("wf-x"));
    assert.ok(out.includes("no declared inputs"));
  });

  test("action='inputs' with inputs", () => {
    const out = renderResult({
      action: "inputs",
      name: "wf-y",
      inputs: [
        { name: "param1", type: "string", required: true, description: "A param" },
      ],
    });
    assert.ok(out.includes("param1"));
    assert.ok(out.includes("required"));
  });

  test("action='run' non-partial shows message", () => {
    const out = renderResult(
      { action: "run", runId: "r42", status: "pending", message: "not yet" },
      { isPartial: false },
    );
    assert.ok(out.includes("not yet"));
    assert.ok(out.includes("r42"));
  });

  test("action='run' background dispatch reuses the slash-command dispatch card", () => {
    const width = 64;
    const out = renderResult(
      {
        action: "run",
        name: "deep-research-codebase",
        runId: "abcdef123456",
        status: "running",
        message: "started",
      },
      { width, runInputs: { prompt: "map the repo" } },
    );
    assert.match(out, /deep-research-codebase/);
    assert.match(out, /prompt/);
    assert.match(out, /\/workflow connect abcdef12/);
    for (const line of out.split("\n")) {
      assert.ok(visibleWidth(line) <= width, `dispatch exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
    }
  });

  test("action='run' isPartial shows 'in progress'", () => {
    const out = renderResult(
      { action: "run", runId: "r42", status: "pending", message: "not yet" },
      { isPartial: true },
    );
    assert.ok(out.includes("in progress"));
    assert.ok(out.includes("r42"));
  });

  test("action='interrupt' shows message", () => {
    const out = renderResult({
      action: "interrupt",
      runId: "r10",
      status: "noop",
      message: "Interrupt not yet implemented",
    });
    assert.ok(out.includes("r10"));
    assert.ok(out.includes("Interrupt not yet implemented"));
  });

  test("action='kill' shows message", () => {
    const out = renderResult({
      action: "kill",
      runId: "r-kill",
      status: "killed",
      message: "Killed and retained for inspection",
    });
    assert.ok(out.includes("r-kill"));
    assert.ok(out.includes("Killed and retained for inspection"));
  });

  test("action='resume' shows message", () => {
    const out = renderResult({
      action: "resume",
      runId: "r20",
      status: "noop",
      message: "Resume not yet implemented",
    });
    assert.ok(out.includes("r20"));
    assert.ok(out.includes("Resume not yet implemented"));
  });

  test("unknown action falls through to default", () => {
    const out = renderResult({ action: "unknown-action", message: "oops" } as unknown as WorkflowToolResult);
    assert.equal(typeof out, "string");
    assert.ok(out.includes("oops"));
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
    const result = await runTool(execute, { workflow: "deep-research-codebase", inputs: { prompt: "test query" }, action: "run" });
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
  });

  test("action='run' for deep-research-codebase without adapters reports honest failure, not stub", async () => {
    const execute = mock.tools[0]!.opts.execute;
    const result = await runTool(execute, { workflow: "deep-research-codebase", inputs: { prompt: "test" }, action: "run" });
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
