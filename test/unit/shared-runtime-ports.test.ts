/**
 * Tests for shared runtime ports added to shared/types.ts and store-types.ts:
 *   StageOptions, StageMcpOptions, WorkflowMcpPort, WorkflowPersistencePort,
 *   WorkflowOverlayAdapter (store-types), and RunOpts port fields.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type {
  StageOptions,
  StageMcpOptions,
  WorkflowMcpPort,
  WorkflowPersistencePort,
} from "../../packages/workflows/src/shared/types.js";
import type { WorkflowOverlayAdapter, WorkflowNotice } from "../../packages/workflows/src/shared/store-types.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { CancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// StageOptions — structural type tests
// ---------------------------------------------------------------------------

describe("StageOptions", () => {
  test("empty options object is valid", () => {
    const opts: StageOptions = {};
    assert.notEqual(opts, undefined);
  });

  test("mcp with allow", () => {
    const opts: StageOptions = { mcp: { allow: ["github", "fetch"] } };
    assert.deepEqual(opts.mcp?.allow, ["github", "fetch"]);
  });

  test("mcp with deny", () => {
    const opts: StageOptions = { mcp: { deny: ["filesystem"] } };
    assert.deepEqual(opts.mcp?.deny, ["filesystem"]);
  });

  test("mcp with both allow and deny", () => {
    const mcp: StageMcpOptions = { allow: ["a"], deny: ["b"] };
    const opts: StageOptions = { mcp };
    assert.deepEqual(opts.mcp?.allow, ["a"]);
    assert.deepEqual(opts.mcp?.deny, ["b"]);
  });
});

// ---------------------------------------------------------------------------
// WorkflowMcpPort — stub implementation satisfies the interface
// ---------------------------------------------------------------------------

describe("WorkflowMcpPort", () => {
  test("stub implements WorkflowMcpPort", () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const port: WorkflowMcpPort = {
      setScope(stageId, allow, deny) {
        calls.push({ method: "setScope", args: [stageId, allow, deny] });
      },
      clearScope(stageId) {
        calls.push({ method: "clearScope", args: [stageId] });
      },
    };

    port.setScope("s1", ["a"], null);
    port.clearScope("s1");

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { method: "setScope", args: ["s1", ["a"], null] }) // TODO: was toMatchObject — may need subset check;
    assert.deepEqual(calls[1], { method: "clearScope", args: ["s1"] }) // TODO: was toMatchObject — may need subset check;
  });
});

// ---------------------------------------------------------------------------
// WorkflowPersistencePort — stub implementation
// ---------------------------------------------------------------------------

describe("WorkflowPersistencePort", () => {
  test("minimal stub (appendEntry only) satisfies the port", () => {
    const appended: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const port: WorkflowPersistencePort = {
      appendEntry(type, payload) {
        appended.push({ type, payload });
        return `entry-${appended.length}`;
      },
    };

    const id = port.appendEntry("workflow.run.start", { runId: "r1" });
    assert.equal(id, "entry-1");
    assert.equal(appended[0]!.type, "workflow.run.start");
  });

  test("full stub with setLabel and appendCustomMessageEntry", () => {
    const labels: Record<string, string> = {};
    const messages: string[] = [];
    const port: WorkflowPersistencePort = {
      appendEntry: () => "e1",
      setLabel(entryId, label) { labels[entryId] = label; },
      appendCustomMessageEntry(content) { messages.push(content); return "m1"; },
    };

    port.setLabel?.("e1", "wf:test:abc123");
    port.appendCustomMessageEntry?.("stage completed");

    assert.equal(labels["e1"], "wf:test:abc123");
    assert.ok(messages.includes("stage completed"));
  });
});

// ---------------------------------------------------------------------------
// WorkflowOverlayAdapter — from store-types
// ---------------------------------------------------------------------------

describe("WorkflowOverlayAdapter", () => {
  test("stub satisfies the adapter interface", () => {
    const shown: WorkflowNotice[] = [];
    let hidden = false;

    const adapter: WorkflowOverlayAdapter = {
      show(notice) { shown.push(notice); },
      hide() { hidden = true; },
    };

    const notice: WorkflowNotice = {
      id: "n1",
      level: "info",
      message: "stage running",
      createdAt: Date.now(),
    };

    adapter.show(notice);
    adapter.hide();

    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.message, "stage running");
    assert.equal(hidden, true);
  });
});

// ---------------------------------------------------------------------------
// RunOpts — port fields present and type-safe
// ---------------------------------------------------------------------------

describe("RunOpts port fields", () => {
  test("RunOpts accepts all new port fields without error", () => {
    const mcpPort: WorkflowMcpPort = {
      setScope: () => {},
      clearScope: () => {},
    };
    const persistencePort: WorkflowPersistencePort = {
      appendEntry: () => undefined,
    };
    const overlayAdapter: WorkflowOverlayAdapter = {
      show: () => {},
      hide: () => {},
    };
    // AbortController for signal
    const abortCtrl = new AbortController();

    const opts: RunOpts = {
      mcp: mcpPort,
      persistence: persistencePort,
      overlay: overlayAdapter,
      signal: abortCtrl.signal,
    };

    assert.equal(opts.mcp, mcpPort);
    assert.equal(opts.persistence, persistencePort);
    assert.equal(opts.overlay, overlayAdapter);
    assert.equal(opts.signal, abortCtrl.signal);
  });

  test("RunOpts accepts CancellationRegistry", () => {
    const registry: CancellationRegistry = {
      register: () => {},
      registerChild: () => {},
      abort: () => false,
      abortAll: () => 0,
      unregister: () => {},
      isAborted: () => false,
    };

    const opts: RunOpts = { cancellation: registry };
    assert.equal(opts.cancellation, registry);
  });
});

// ---------------------------------------------------------------------------
// ctx.stage(name, options?) — optional stage options + MCP port wiring
// ---------------------------------------------------------------------------

describe("ctx.stage with StageOptions", () => {
  test("stage() with no options creates a default stage", async () => {
    const wf = defineWorkflow("default-stage-options-test")
      .description("d")
      .output("result", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        const s = ctx.stage("step");
        const result = await s.prompt("hello");
        return { result };
      })
      .compile();

    const res = await run(wf, {}, {
      adapters: { prompt: { prompt: async (text) => `ok:${text}` } },
    });
    assert.equal(res.status, "completed");
    assert.equal(res.stages[0]!.name, "step");
  });

  test("stage(name, options) passes mcp opts to WorkflowMcpPort", async () => {
    const scopeCalls: Array<{ method: string; stageId: string; allow: string[] | null; deny: string[] | null }> = [];

    const mcpPort: WorkflowMcpPort = {
      setScope(stageId, allow, deny) {
        scopeCalls.push({ method: "setScope", stageId, allow, deny });
      },
      clearScope(stageId) {
        scopeCalls.push({ method: "clearScope", stageId, allow: null, deny: null });
      },
    };

    const wf = defineWorkflow("mcp-opts-test")
      .description("d")
      .run(async (ctx) => {
        const s = ctx.stage("restricted", { mcp: { allow: ["github"], deny: ["filesystem"] } });
        await s.prompt("do work");
        return {};
      })
      .compile();

    await run(wf, {}, { mcp: mcpPort });

    const setCall = scopeCalls.find((c) => c.method === "setScope");
    const clearCall = scopeCalls.find((c) => c.method === "clearScope");

    assert.notEqual(setCall, undefined);
    assert.deepEqual(setCall?.allow, ["github"]);
    assert.deepEqual(setCall?.deny, ["filesystem"]);
    assert.notEqual(clearCall, undefined);
  });

  test("stage with mcp options but no mcp port is a no-op (no throw)", async () => {
    const wf = defineWorkflow("mcp-noop-test")
      .description("d")
      .run(async (ctx) => {
        const s = ctx.stage("step", { mcp: { allow: ["a"] } });
        await s.prompt("x");
        return {};
      })
      .compile();

    const res = await run(wf, {}, {
      adapters: { prompt: { prompt: async (text) => `ok:${text}` } },
    });
    assert.equal(res.status, "completed");
  });

  test("stage with empty mcp options ({}) does not call setScope", async () => {
    const scopeCalls: string[] = [];
    const mcpPort: WorkflowMcpPort = {
      setScope(stageId) { scopeCalls.push("setScope:" + stageId); },
      clearScope(stageId) { scopeCalls.push("clearScope:" + stageId); },
    };

    const wf = defineWorkflow("mcp-empty-test")
      .description("d")
      .run(async (ctx) => {
        const s = ctx.stage("step", { mcp: {} }); // no allow, no deny
        await s.prompt("x");
        return {};
      })
      .compile();

    await run(wf, {}, { mcp: mcpPort });
    // No allow/deny → null/null → should NOT call setScope/clearScope
    assert.equal(scopeCalls.length, 0);
  });
});
