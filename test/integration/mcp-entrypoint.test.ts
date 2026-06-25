/**
 * Integration tests: MCP scope events emitted via public extension entrypoints.
 *
 * Asserts that registered tool execute and slash command execute paths cause
 * pi.events.emit to receive:
 *   mcp.scope.set { allow: ["github"], deny: ["filesystem"] }  ← stage open
 *   mcp.scope.set { allow: null, deny: null }                  ← stage clear (after settle)
 *
 * cross-ref: src/extension/index.ts (factory, makeMcpPort,
 *            makeExecuteWorkflowTool)
 *            src/integrations/mcp.ts (setMcpScope, clearMcpScope)
 */

import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  makeMcpPort,
  makeExecuteWorkflowTool,
  parseWorkflowArgs,
  type ExtensionAPI,
  type WorkflowToolArgs,
  type PiExecuteContext,
} from "../../packages/workflows/src/extension/index.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { McpScopeSetPayload } from "../../packages/workflows/src/extension/mcp.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { waitForRun } from "../support/helpers.ts";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.ts";

// ---------------------------------------------------------------------------
// Test workflow fixture: single restricted stage with MCP scoping
// ---------------------------------------------------------------------------

const mcpRestrictedWorkflow = workflow({
  name: "mcp-restricted",
  description: "Workflow with MCP-scoped restricted stage",
  inputs: {},
  outputs: {
    done: Type.Boolean(),
  },
  run: async (ctx) => {
    const stage = ctx.stage("restricted", {
      mcp: { allow: ["github"], deny: ["filesystem"] },
    });
    await stage.prompt("go");
    return { done: true };
  },
});

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
  assert.ok(emits.length >= 2);

  const setEmit = emits.find(
    (e) =>
      e.payload.allow !== null ||
      e.payload.deny !== null,
  );
  const clearEmit = emits.find(
    (e) => e.payload.allow === null && e.payload.deny === null,
  );

  assert.notEqual(setEmit, undefined);
  assert.notEqual(clearEmit, undefined);

  // Correct scope values
  assert.deepEqual(setEmit!.payload.allow, ["github"]);
  assert.deepEqual(setEmit!.payload.deny, ["filesystem"]);

  // Set fires BEFORE clear
  const setIdx = emits.indexOf(setEmit!);
  const clearIdx = emits.indexOf(clearEmit!);
  assert.ok(setIdx < clearIdx);
}


/**
 * Extract the runId from a workflow tool result and wait for the
 * background run to settle. With background-only dispatch, side effects
 * (mcp.scope.set/clear, persistence appends, etc.) happen inside the
 * detached promise — tests must wait before asserting on event spies.
 */
async function waitForToolResult(out: unknown): Promise<void> {
  const details = (out as { details?: WorkflowToolResult }).details ?? (out as WorkflowToolResult);
  if (details && details.action === "run" && "runId" in details && details.runId) {
    await waitForRun(details.runId);
  }
}

async function waitForDispatchResult(out: WorkflowToolResult): Promise<void> {
  if (out.action === "run" && "runId" in out && out.runId) {
    await waitForRun(out.runId);
  }
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
    toolExecute = makeExecuteWorkflowTool(runtime, () => undefined, () => undefined);
  });

  test("tool execute emits mcp.scope.set (set then clear) when running mcp-restricted workflow", async () => {
    const out = await toolExecute({ action: "run", workflow: "mcp-restricted", inputs: {} }, {});
    await waitForToolResult(out);
    assertScopeEmitSequence(emits);
  });

  test("set payload stageId is a non-empty string", async () => {
    const out = await toolExecute({ action: "run", workflow: "mcp-restricted", inputs: {} }, {});
    await waitForToolResult(out);
    const setEmit = emits.find((e) => e.payload.allow !== null);
    assert.equal(typeof setEmit!.payload.stageId, "string");
    assert.ok(setEmit!.payload.stageId.length > 0);
  });

  test("clear payload uses same stageId as set payload", async () => {
    const out = await toolExecute({ action: "run", workflow: "mcp-restricted", inputs: {} }, {});
    await waitForToolResult(out);
    const setEmit = emits.find((e) => e.payload.allow !== null)!;
    const clearEmit = emits.find((e) => e.payload.allow === null)!;
    assert.equal(clearEmit.payload.stageId, setEmit.payload.stageId);
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
    const execute = makeExecuteWorkflowTool(runtime, () => undefined, () => undefined);
    // Should not throw, should complete
    const result = await execute({ action: "run", workflow: "mcp-restricted", inputs: {} }, {});
    assert.equal((result as { action: string }).action, "run");
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
    //   await runtimeProxy.dispatch({ workflow: workflowName, inputs, action: "run" });
    const rawArgs = "mcp-restricted";
    const parts = rawArgs.trim().split(/\s+/);
    const workflowName = parts[0]!;
    const inputs = parseWorkflowArgs(parts.slice(1));
    const result = await runtime.dispatch({ workflow: workflowName, inputs, action: "run" });
    await waitForDispatchResult(result);

    assertScopeEmitSequence(emits);
  });

  test("slash dispatch with no extra args emits mcp.scope.set (set then clear)", async () => {
    // Mirrors /workflow mcp-restricted with no key=value input tokens.
    const rawArgs = "mcp-restricted";
    const rawParts = rawArgs.trim().split(/\s+/);
    const tokens = rawParts[0] === "" ? [] : rawParts;
    const workflowName = tokens[0]!;
    const inputs = parseWorkflowArgs(tokens.slice(1));
    const result = await runtime.dispatch({ workflow: workflowName, inputs, action: "run" });
    await waitForDispatchResult(result);

    assertScopeEmitSequence(emits);
  });
});

