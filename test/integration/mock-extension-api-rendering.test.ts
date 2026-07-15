import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  expectRegisteredCommand,
  factory,
  getCommand,
  getRenderer,
  makeMock,
  renderCall,
  rendererOutputText,
  renderResult,
  visibleWidth,
} from "./mock-extension-api-helpers.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";

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
  test("/workflow getArgumentCompletions returns all subcommands for empty partial", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = (await cmd.options.getArgumentCompletions?.("")) ?? [];
    const labels = completions.map((c) => c.label);
    for (const sub of ["list", "status", "connect", "interrupt", "quit", "resume", "inputs"]) {
      assert.ok(labels.includes(sub));
    }
    assert.equal(labels.includes("kill"), false);
    assert.equal(labels.includes("session"), false);
  });

  test("/workflow getArgumentCompletions filters by partial", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = (await cmd.options.getArgumentCompletions?.("li")) ?? [];
    assert.ok(completions.length > 0);
    assert.equal(completions.every((c) => c.label.startsWith("li")), true);
  });

  test("/workflow getArgumentCompletions covers subcommand arguments", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const inputs = (await cmd.options.getArgumentCompletions?.("inputs de")) ?? [];
    assert.ok(inputs.some((c) => c.value === "inputs deep-research-codebase "));

    const status = (await cmd.options.getArgumentCompletions?.("status --")) ?? [];
    assert.equal(status.some((c) => c.value === "status --all "), false);

    const interrupt = (await cmd.options.getArgumentCompletions?.("interrupt -")) ?? [];
    assert.ok(interrupt.some((c) => c.value === "interrupt -y "));

    const quit = (await cmd.options.getArgumentCompletions?.("quit -")) ?? [];
    assert.ok(quit.some((c) => c.value === "quit --all "));
    assert.equal(quit.some((c) => c.label === "-y" || c.label === "--yes"), false);
  });

  test("/workflow getArgumentCompletions covers workflow run inputs and flags", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const inputKeys = (await cmd.options.getArgumentCompletions?.("deep-research-codebase p")) ?? [];
    assert.ok(inputKeys.some((c) => c.value === "deep-research-codebase prompt="));

    const flags = (await cmd.options.getArgumentCompletions?.("deep-research-codebase --")) ?? [];
    assert.ok(flags.some((c) => c.value === "deep-research-codebase --no-picker "));
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

  test("workflow.run.start renderer renders workflow name and runId", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.start")!;
    const out = rendererOutputText(renderer({ runId: "r1", name: "my-wf", inputs: { foo: "bar" } }));
    assert.ok(out.length > 0);
    assert.ok(out.includes("my-wf"));
    assert.ok(out.includes("r1"));
  });

  test("workflow.run.start renderer shows input count", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.start")!;
    const out = rendererOutputText(renderer({ runId: "r1", name: "wf", inputs: { a: 1, b: 2 } }));
    assert.ok(out.includes("2"));
  });

  test("workflow.run.end renderer ok status shows success marker", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.end")!;
    const out = rendererOutputText(renderer({ runId: "r1", status: "ok" }));
    assert.ok(out.includes("✓"));
    assert.ok(out.includes("r1"));
  });

  test("workflow.run.end renderer error status shows failure marker", () => {
    const renderer = getRenderer(mock.renderers, "workflow.run.end")!;
    const out = rendererOutputText(renderer({ runId: "r1", status: "error" }));
    assert.ok(out.includes("✗"));
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

  test("action='quit' includes runId", () => {
    assert.ok(renderCall({ runId: "run-quit", action: "quit" }).includes("run-quit"));
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
      { action: "quit", runId: "run-abcdef", status: "paused", message: "A very long resumable quit response message." },
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

  test("action='quit' shows resumable message", () => {
    const out = renderResult({
      action: "quit",
      runId: "r-quit",
      status: "paused",
      message: "Workflow quit and can be resumed",
    });
    assert.ok(out.includes("r-quit"));
    assert.ok(out.includes("Workflow quit and can be resumed"));
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

