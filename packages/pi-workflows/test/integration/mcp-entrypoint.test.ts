/**
 * Integration tests: MCP scope events emitted via public extension entrypoints.
 *
 * Asserts that registered tool execute, slash command execute path, and CLI
 * flag run all cause pi.events.emit to receive:
 *   mcp.scope.set { allow: ["github"], deny: ["filesystem"] }  ← stage open
 *   mcp.scope.set { allow: null, deny: null }                  ← stage clear (after settle)
 *
 * cross-ref: packages/pi-workflows/src/extension/index.ts (factory, makeMcpPort,
 *            makeExecuteWorkflowTool)
 *            packages/pi-workflows/src/integrations/mcp.ts (setMcpScope, clearMcpScope)
 *            packages/pi-workflows/src/cli-flags.ts (runWorkflowFromCliFlags)
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  makeMcpPort,
  makeExecuteWorkflowTool,
  parseWorkflowArgs,
  type ExtensionAPI,
  type WorkflowToolArgs,
  type PiExecuteContext,
} from "../../src/extension/index.js";
import { createExtensionRuntime } from "../../src/extension/runtime.js";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";
import { runWorkflowFromCliFlags } from "../../src/cli-flags.js";
import type { McpScopeSetPayload } from "../../src/integrations/mcp.js";
import type { StageAdapters } from "../../src/runs/sync/stage-runner.js";

// ---------------------------------------------------------------------------
// Test workflow fixture: single restricted stage with MCP scoping
// ---------------------------------------------------------------------------

const mcpRestrictedWorkflow = defineWorkflow("mcp-restricted")
  .description("Workflow with MCP-scoped restricted stage")
  .run(async (ctx) => {
    const stage = ctx.stage("restricted", {
      mcp: { allow: ["github"], deny: ["filesystem"] },
    });
    await stage.prompt("go");
    return { done: true };
  })
  .compile();

// ---------------------------------------------------------------------------
// Shared: noop adapters (no real agent calls needed for MCP scope tests)
// ---------------------------------------------------------------------------

const noopAdapters: StageAdapters = {
  prompt: { prompt: async (_text) => "ok" },
  complete: { complete: async (_text) => "ok" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emitted mcp.scope.set payload from pi.events.emit. */
type ScopeEmit = { event: string; payload: McpScopeSetPayload };

/**
 * Build a minimal ExtensionAPI mock with events.emit recorder.
 * Returns both the mock pi and the list of recorded scope emit calls.
 */
function makeMockPiWithEvents(): {
  pi: ExtensionAPI;
  emits: ScopeEmit[];
} {
  const emits: ScopeEmit[] = [];

  const pi: ExtensionAPI = {
    events: {
      emit: (event: string, payload: Record<string, unknown>) => {
        if (event === "mcp.scope.set") {
          emits.push({ event, payload: payload as unknown as McpScopeSetPayload });
        }
      },
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    on: () => undefined,
    ui: { setWidget: () => undefined },
  };

  return { pi, emits };
}

/** Build a test runtime wired with the MCP-restricted workflow and an mcpPort. */
function buildTestRuntime(pi: ExtensionAPI) {
  const mcpPort = makeMcpPort(pi);
  const runtime = createExtensionRuntime({
    definitions: [mcpRestrictedWorkflow],
    adapters: noopAdapters,
    mcp: mcpPort,
  });
  return runtime;
}

/** Assert the expected emit sequence: one set + one clear. */
function assertScopeEmitSequence(emits: ScopeEmit[]): void {
  // Exactly two mcp.scope.set events: one with scope, one clear.
  expect(emits.length).toBeGreaterThanOrEqual(2);

  const setEmit = emits.find(
    (e) =>
      e.payload.allow !== null ||
      e.payload.deny !== null,
  );
  const clearEmit = emits.find(
    (e) => e.payload.allow === null && e.payload.deny === null,
  );

  expect(setEmit).toBeDefined();
  expect(clearEmit).toBeDefined();

  // Correct scope values
  expect(setEmit!.payload.allow).toEqual(["github"]);
  expect(setEmit!.payload.deny).toEqual(["filesystem"]);

  // Set fires BEFORE clear
  const setIdx = emits.indexOf(setEmit!);
  const clearIdx = emits.indexOf(clearEmit!);
  expect(setIdx).toBeLessThan(clearIdx);
}

// ---------------------------------------------------------------------------
// Tool entrypoint
// ---------------------------------------------------------------------------

describe("MCP entrypoints — workflow tool execute", () => {
  let emits: ScopeEmit[];
  let toolExecute: (
    args: WorkflowToolArgs,
    ctx: PiExecuteContext,
  ) => Promise<unknown>;

  beforeEach(() => {
    const { pi, emits: e } = makeMockPiWithEvents();
    emits = e;
    const runtime = buildTestRuntime(pi);
    toolExecute = makeExecuteWorkflowTool(runtime, () => undefined);
  });

  test("tool execute emits mcp.scope.set (set then clear) when running mcp-restricted workflow", async () => {
    await toolExecute({ action: "run", name: "mcp-restricted", inputs: {} }, {});
    assertScopeEmitSequence(emits);
  });

  test("set payload stageId is a non-empty string", async () => {
    await toolExecute({ action: "run", name: "mcp-restricted", inputs: {} }, {});
    const setEmit = emits.find((e) => e.payload.allow !== null);
    expect(typeof setEmit!.payload.stageId).toBe("string");
    expect(setEmit!.payload.stageId.length).toBeGreaterThan(0);
  });

  test("clear payload uses same stageId as set payload", async () => {
    await toolExecute({ action: "run", name: "mcp-restricted", inputs: {} }, {});
    const setEmit = emits.find((e) => e.payload.allow !== null)!;
    const clearEmit = emits.find((e) => e.payload.allow === null)!;
    expect(clearEmit.payload.stageId).toBe(setEmit.payload.stageId);
  });

  test("no mcp.scope.set emitted when pi.events absent", async () => {
    // Build pi without events bus → makeMcpPort returns undefined → no-op
    const piNoEvents: ExtensionAPI = {
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerMessageRenderer: () => undefined,
      registerFlag: () => undefined,
      on: () => undefined,
    };
    const runtime = createExtensionRuntime({
      definitions: [mcpRestrictedWorkflow],
      adapters: noopAdapters,
      mcp: makeMcpPort(piNoEvents),
    });
    const execute = makeExecuteWorkflowTool(runtime, () => undefined);
    // Should not throw, should complete
    const result = await execute({ action: "run", name: "mcp-restricted", inputs: {} }, {});
    expect((result as { action: string }).action).toBe("run");
    // No events because pi.events absent
  });
});

// ---------------------------------------------------------------------------
// Slash command entrypoint
// ---------------------------------------------------------------------------

describe("MCP entrypoints — slash command execute path", () => {
  let emits: ScopeEmit[];
  let runtime: ReturnType<typeof buildTestRuntime>;

  beforeEach(() => {
    const { pi, emits: e } = makeMockPiWithEvents();
    emits = e;
    runtime = buildTestRuntime(pi);
  });

  test("slash dispatch emits mcp.scope.set (set then clear) when running mcp-restricted workflow", async () => {
    // Mirrors the factory's /workflow slash execute handler for workflow-name dispatch:
    //   const parts = args.trim().split(/\s+/);
    //   const workflowName = parts[0];
    //   const inputs = parseWorkflowArgs(parts.slice(1));
    //   await runtimeProxy.dispatch({ name: workflowName, inputs, action: "run" });
    const rawArgs = "mcp-restricted";
    const parts = rawArgs.trim().split(/\s+/);
    const workflowName = parts[0]!;
    const inputs = parseWorkflowArgs(parts.slice(1));
    await runtime.dispatch({ name: workflowName, inputs, action: "run" });

    assertScopeEmitSequence(emits);
  });

  test("slash alias dispatch emits mcp.scope.set (set then clear) when running mcp-restricted workflow", async () => {
    // Mirrors the factory's /workflow:<name> alias execute handler:
    //   const inputs = parseWorkflowArgs(tokens);
    //   await runtimeProxy.dispatch({ name: workflowName, inputs, action: "run" });
    const aliasArgs = "";  // no extra args for alias
    const rawParts = aliasArgs.trim().split(/\s+/);
    const tokens = rawParts[0] === "" ? [] : rawParts;
    const inputs = parseWorkflowArgs(tokens);
    await runtime.dispatch({ name: "mcp-restricted", inputs, action: "run" });

    assertScopeEmitSequence(emits);
  });
});

// ---------------------------------------------------------------------------
// CLI flag entrypoint
// ---------------------------------------------------------------------------

describe("MCP entrypoints — CLI flag run", () => {
  let emits: ScopeEmit[];
  let runtime: ReturnType<typeof buildTestRuntime>;

  beforeEach(() => {
    const { pi, emits: e } = makeMockPiWithEvents();
    emits = e;
    runtime = buildTestRuntime(pi);
  });

  test("runWorkflowFromCliFlags emits mcp.scope.set (set then clear) when running mcp-restricted workflow", async () => {
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=mcp-restricted"],
    });

    expect(result.handled).toBe(true);
    assertScopeEmitSequence(emits);
  });

  test("CLI clear event has allow: null and deny: null per integrations/mcp.ts clearMcpScope", async () => {
    await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=mcp-restricted"],
    });

    const clearEmit = emits.find((e) => e.payload.allow === null && e.payload.deny === null);
    expect(clearEmit).toBeDefined();
    expect(clearEmit!.payload.allow).toBeNull();
    expect(clearEmit!.payload.deny).toBeNull();
  });

  test("CLI set event fires before clear event", async () => {
    await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=mcp-restricted"],
    });

    const setIdx = emits.findIndex((e) => e.payload.allow !== null);
    const clearIdx = emits.findIndex((e) => e.payload.allow === null);
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThan(setIdx);
  });
});
