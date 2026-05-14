/**
 * Integration tests: runtime adapter wiring through dispatch path.
 *
 * Covers:
 * 1. Mock ExtensionAPI with exec surface → SDK session adapters built → workflow
 *    tool dispatch does not shell out through exec.
 * 2. Initial runtime (pre-discovery, seeded from discoverStartupWorkflowsSync)
 *    carries adapters — workflow dispatch calls prompt/complete adapters.
 * 3. Post-discovery runtime swap preserves the same adapters — exec still
 *    called after createExtensionRuntime is re-called with discovered registry.
 * 4. No exec surface → SDK test stub fires (no hard error).
 *
 * Tests use the public extension/tool dispatch path wherever practical:
 *   factory(mockApi) → mock.tools[0].opts.execute → exec spy
 * Lower-level createExtensionRuntime tests cover the pre/post-swap invariant.
 *
 * cross-ref: src/extension/wiring.ts, src/extension/index.ts,
 *            src/runs/foreground/stage-runner.ts, RFC runtime-wiring task
 */

import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import factory, {
  type ExtensionAPI,
  type PiToolOpts,
  type PiCommandOptions,
  type PiFlagNamedOpts,
  type WorkflowToolArgs,
} from "../../src/extension/index.js";
import type { WorkflowToolResult } from "../../src/extension/render-result.js";
import type { PiExecResult } from "../../src/extension/wiring.js";
import { createExtensionRuntime } from "../../src/extension/runtime.js";
import { discoverStartupWorkflowsSync, discoverWorkflows } from "../../src/extension/discovery.js";
import { waitForRun } from "../support/helpers.ts";

/**
 * Helper: dispatch a workflow run and wait for the background promise to
 * settle so subsequent spy-call assertions race-free.
 */
async function dispatchAndWait(
  runtime: ReturnType<typeof createExtensionRuntime>,
  args: WorkflowToolArgs,
): Promise<WorkflowToolResult> {
  const result = await runtime.dispatch(args);
  if (result.action === "run" && "runId" in result && result.runId !== "") {
    await waitForRun(result.runId);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Valid NDJSON payload: assistant text message_end event. */
function makeNdjson(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/** Minimal StageAdapters backed by a call-recording spy. */
function makeSpyAdapters(calls: string[]) {
  return {
    prompt: {
      async prompt(text: string): Promise<string> {
        calls.push(`prompt:${text.slice(0, 20)}`);
        return `[spy-prompt-result]`;
      },
    },
    complete: {
      async complete(text: string): Promise<string> {
        calls.push(`complete:${text.slice(0, 20)}`);
        return `partition-a\npartition-b`;
      },
    },
  };
}

/** Mock ExtensionAPI that records registrations and exposes an exec spy. */
interface MockApi extends ExtensionAPI {
  tools: Array<{ opts: PiToolOpts<WorkflowToolArgs, WorkflowToolResult> }>;
  commands: Array<{ name: string; options: PiCommandOptions }>;
  flags: Array<{ name: string; options: PiFlagNamedOpts }>;
  execCalls: Array<{ command: string; args: string[] }>;
}

function makeMockApi(): MockApi {
  const tools: MockApi["tools"] = [];
  const commands: MockApi["commands"] = [];
  const flags: MockApi["flags"] = [];
  const execCalls: MockApi["execCalls"] = [];

  return {
    tools,
    commands,
    flags,
    execCalls,

    // exec surface — present on real pi runtime, used by buildRuntimeAdapters
    async exec(command: string, args: string[]): Promise<PiExecResult> {
      execCalls.push({ command, args });
      // Return valid NDJSON for prompt and complete calls; also works for subagent.
      // complete calls need partition-like output so the workflow can proceed.
      const isComplete = args.some((a) => a.includes("extract") || a.includes("partition"));
      const text = isComplete ? "partition-a\npartition-b" : "[spy-exec-response]";
      return { stdout: makeNdjson(text), stderr: "", code: 0, killed: false };
    },

    registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
      tools.push({ opts: opts as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult> });
    },
    registerCommand(name: string, options: PiCommandOptions) {
      commands.push({ name, options });
    },
    registerMessageRenderer(_event: string, _renderer: unknown) {},
    registerFlag(name: string, options: PiFlagNamedOpts) {
      flags.push({ name, options });
    },
  };
}

/** Run the workflow tool for deep-research-codebase with a minimal prompt input. */
async function runWorkflowTool(
  mock: MockApi,
): Promise<WorkflowToolResult> {
  const execute = mock.tools[0]?.opts.execute;
  if (!execute) throw new Error("workflow tool not registered");
  // Pi calls execute as `(toolCallId, params, signal, onUpdate, ctx)` and the
  // tool returns `{ content, details }`. Tests assert against `details`.
  const out = await execute(
    "test-tool-call",
    { workflow: "deep-research-codebase", inputs: { prompt: "test research question" }, action: "run" },
    undefined,
    undefined,
    {} as never,
  );
  return out.details;
}

// ---------------------------------------------------------------------------
// 1. Mock ExtensionAPI with exec → SDK session dispatch without exec shell-out
// ---------------------------------------------------------------------------

describe("runtime-wiring — SDK session invoked through workflow tool", () => {
  let mock: MockApi;

  beforeEach(() => {
    mock = makeMockApi();
    factory(mock);
  });

  test("factory registers workflow tool on mock api", () => {
    assert.ok(mock.tools.length > 0);
    assert.equal(mock.tools[0]?.opts.name, "workflow");
  });

  test("exec is not called when running deep-research-codebase through workflow tool", async () => {
    await runWorkflowTool(mock);
    assert.equal(mock.execCalls.length, 0);
  });

  test("legacy pi json command is never constructed", async () => {
    await runWorkflowTool(mock);
    assert.deepEqual(mock.execCalls.map((c) => c.command), []);
  });

  test("legacy pi json args are never constructed", async () => {
    await runWorkflowTool(mock);
    assert.deepEqual(mock.execCalls.map((c) => c.args), []);
  });

  test("dispatch result has action=run and status field", async () => {
    const result = await runWorkflowTool(mock);
    assert.equal(result.action, "run");
    assert.equal("status" in result, true);
  });

  test("no 'prompt adapter not configured' error thrown", async () => {
    // If adapters are missing, stage-runner throws this message in non-test env.
    // With adapters wired, this must not appear.
    await assert.ok(await runWorkflowTool(mock));
  });
});

// ---------------------------------------------------------------------------
// 2. No exec surface → no adapters → test-env stub fires (no hard error)
// ---------------------------------------------------------------------------

describe("runtime-wiring — no exec surface → stub fires in test env", () => {
  let mock: MockApi;

  beforeEach(() => {
    // Remove exec surface — simulates a degraded / older pi runtime
    const stripped: ExtensionAPI & {
      tools: MockApi["tools"];
      commands: MockApi["commands"];
      execCalls: MockApi["execCalls"];
      flags: MockApi["flags"];
    } = {
      tools: [],
      commands: [],
      execCalls: [],
      flags: [],
      registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
        (this as unknown as MockApi).tools.push({
          opts: opts as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult>,
        });
      },
      registerCommand(name: string, options: PiCommandOptions) {
        (this as unknown as MockApi).commands.push({ name, options });
      },
      registerMessageRenderer(_event: string, _renderer: unknown) {},
      registerFlag(name: string, options: PiFlagNamedOpts) {
        (this as unknown as MockApi).flags.push({ name, options });
      },
    };
    mock = stripped as unknown as MockApi;
    factory(mock);
  });

  test("workflow tool dispatch resolves (test-env prompt stub fires)", async () => {
    // In NODE_ENV=test: stage-runner uses a deterministic stub string instead of
    // throwing — so the run completes (possibly with stub content) rather than erroring.
    const result = await runWorkflowTool(mock);
    assert.notEqual(result, undefined);
  });

  test("exec is NOT called when exec surface is absent", async () => {
    await runWorkflowTool(mock);
    // No exec surface → exec was never invoked
    assert.equal(mock.execCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Pre-discovery runtime invariant — adapters present in initial runtime
// ---------------------------------------------------------------------------

describe("runtime-wiring — pre-discovery: initial runtime carries adapters", () => {
  test("createExtensionRuntime with sync bundled registry + spy adapters → adapters invoked", async () => {
    const calls: string[] = [];
    const adapters = makeSpyAdapters(calls);

    // Simulate the pre-discovery state: sync bundled registry + adapters (same
    // as factory does at line: current = createExtensionRuntime({ registry: discoverStartupWorkflowsSync().registry, adapters }))
    const initialRuntime = createExtensionRuntime({
      registry: discoverStartupWorkflowsSync().registry,
      adapters,
    });

    await dispatchAndWait(initialRuntime, {
      action: "run",
      workflow: "deep-research-codebase",
      inputs: { prompt: "test pre-discovery" },
    });

    // Adapter must have been called (not test stub, not "not configured" error)
    assert.ok(calls.length > 0);
  });

  test("initial runtime prompt adapter invoked with workflow prompt text", async () => {
    const calls: string[] = [];
    const adapters = makeSpyAdapters(calls);

    const initialRuntime = createExtensionRuntime({
      registry: discoverStartupWorkflowsSync().registry,
      adapters,
    });

    await dispatchAndWait(initialRuntime, {
      action: "run",
      workflow: "deep-research-codebase",
      inputs: { prompt: "pre-discovery-research" },
    });

    const promptCalls = calls.filter((c) => c.startsWith("prompt:"));
    assert.ok(promptCalls.length > 0);
  });

  test("initial runtime no longer needs complete adapter", async () => {
    const calls: string[] = [];
    const adapters = makeSpyAdapters(calls);

    const initialRuntime = createExtensionRuntime({
      registry: discoverStartupWorkflowsSync().registry,
      adapters,
    });

    await dispatchAndWait(initialRuntime, {
      action: "run",
      workflow: "deep-research-codebase",
      inputs: { prompt: "test-complete" },
    });

    const completeCalls = calls.filter((c) => c.startsWith("complete:"));
    assert.equal(completeCalls.length, 0);
    assert.ok(calls.filter((c) => c.startsWith("prompt:")).length > 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Post-discovery runtime swap — same adapters preserved
// ---------------------------------------------------------------------------

describe("runtime-wiring — post-discovery: swapped runtime preserves adapters", () => {
  test("runtime created with discovered registry + same adapters → adapters still invoked", async () => {
    const calls: string[] = [];
    const adapters = makeSpyAdapters(calls);

    // Simulate the post-discovery swap:
    // factory does: runtimeRef.current = createExtensionRuntime({ registry: result.registry, adapters })
    const discoveredResult = await discoverWorkflows({ includeBundled: true });
    const swappedRuntime = createExtensionRuntime({
      registry: discoveredResult.registry,
      adapters,
    });

    await dispatchAndWait(swappedRuntime, {
      action: "run",
      workflow: "deep-research-codebase",
      inputs: { prompt: "test post-discovery" },
    });

    assert.ok(calls.length > 0);
  });

  test("post-discovery prompt adapter receives call with workflow text", async () => {
    const calls: string[] = [];
    const adapters = makeSpyAdapters(calls);

    const discoveredResult = await discoverWorkflows({ includeBundled: true });
    const swappedRuntime = createExtensionRuntime({
      registry: discoveredResult.registry,
      adapters,
    });

    await dispatchAndWait(swappedRuntime, {
      action: "run",
      workflow: "deep-research-codebase",
      inputs: { prompt: "post-discovery-question" },
    });

    const promptCalls = calls.filter((c) => c.startsWith("prompt:"));
    assert.ok(promptCalls.length > 0);
  });

  test("same adapters object works identically in initial and swapped runtime", async () => {
    const calls: string[] = [];
    const adapters = makeSpyAdapters(calls);

    // Initial runtime (pre-discovery)
    const initialRuntime = createExtensionRuntime({
      registry: discoverStartupWorkflowsSync().registry,
      adapters,
    });
    await dispatchAndWait(initialRuntime, {
      action: "run",
      workflow: "deep-research-codebase",
      inputs: { prompt: "initial" },
    });
    const callsAfterInitial = calls.length;
    assert.ok(callsAfterInitial > 0);

    // Swapped runtime (post-discovery) — same adapters reference
    const discoveredResult = await discoverWorkflows({ includeBundled: true });
    const swappedRuntime = createExtensionRuntime({
      registry: discoveredResult.registry,
      adapters,
    });
    await dispatchAndWait(swappedRuntime, {
      action: "run",
      workflow: "deep-research-codebase",
      inputs: { prompt: "swapped" },
    });

    // Both runs must have invoked the adapters
    assert.ok(calls.length > callsAfterInitial);
  });

  test("deep-research-codebase is present in discovered registry (bundled workflows survive swap)", async () => {
    const discoveredResult = await discoverWorkflows({ includeBundled: true });
    assert.ok(discoveredResult.registry.names().includes("deep-research-codebase"));
  });
});

// ---------------------------------------------------------------------------
// 5. End-to-end: factory with exec → pre-discovery dispatch uses SDK session
// ---------------------------------------------------------------------------

describe("runtime-wiring — factory e2e: SDK session active immediately (initial runtime)", () => {
  test("dispatch via workflow tool before discovery swap → exec not called", async () => {
    const mock = makeMockApi();
    factory(mock);

    // dispatch immediately — runtimeRef.current is still the initial sync-seeded runtime
    const result = await runWorkflowTool(mock);

    assert.notEqual(result, undefined);
    // SDK session adapter is active; legacy exec shell-out must not be used.
    assert.equal(mock.execCalls.length, 0);
  });

  test("multiple dispatch calls → exec remains unused (adapters stable)", async () => {
    const mock = makeMockApi();
    factory(mock);

    await runWorkflowTool(mock);
    assert.equal(mock.execCalls.length, 0);

    await runWorkflowTool(mock);
    // Second run must also avoid exec (SDK session adapters still wired).
    assert.equal(mock.execCalls.length, 0);
  });
});
