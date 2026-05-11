/**
 * Tests for shared runtime ports added to shared/types.ts and store-types.ts:
 *   StageOptions, StageMcpOptions, WorkflowMcpPort, WorkflowPersistencePort,
 *   WorkflowOverlayAdapter (store-types), and RunOpts port fields.
 */

import { test, expect, describe } from "bun:test";
import type {
  StageOptions,
  StageMcpOptions,
  WorkflowMcpPort,
  WorkflowPersistencePort,
} from "../../src/shared/types.js";
import type { WorkflowOverlayAdapter, WorkflowNotice } from "../../src/store-types.js";
import type { RunOpts } from "../../src/runs/sync/executor.js";
import type { CancellationRegistry } from "../../src/runs/detach/cancellation-registry.js";
import { run } from "../../src/runs/sync/executor.js";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";

// ---------------------------------------------------------------------------
// StageOptions — structural type tests
// ---------------------------------------------------------------------------

describe("StageOptions", () => {
  test("empty options object is valid", () => {
    const opts: StageOptions = {};
    expect(opts).toBeDefined();
  });

  test("mcp with allow", () => {
    const opts: StageOptions = { mcp: { allow: ["github", "fetch"] } };
    expect(opts.mcp?.allow).toEqual(["github", "fetch"]);
  });

  test("mcp with deny", () => {
    const opts: StageOptions = { mcp: { deny: ["filesystem"] } };
    expect(opts.mcp?.deny).toEqual(["filesystem"]);
  });

  test("mcp with both allow and deny", () => {
    const mcp: StageMcpOptions = { allow: ["a"], deny: ["b"] };
    const opts: StageOptions = { mcp };
    expect(opts.mcp?.allow).toEqual(["a"]);
    expect(opts.mcp?.deny).toEqual(["b"]);
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

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: "setScope", args: ["s1", ["a"], null] });
    expect(calls[1]).toMatchObject({ method: "clearScope", args: ["s1"] });
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
    expect(id).toBe("entry-1");
    expect(appended[0]!.type).toBe("workflow.run.start");
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

    expect(labels["e1"]).toBe("wf:test:abc123");
    expect(messages).toContain("stage completed");
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

    expect(shown).toHaveLength(1);
    expect(shown[0]!.message).toBe("stage running");
    expect(hidden).toBe(true);
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

    expect(opts.mcp).toBe(mcpPort);
    expect(opts.persistence).toBe(persistencePort);
    expect(opts.overlay).toBe(overlayAdapter);
    expect(opts.signal).toBe(abortCtrl.signal);
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
    expect(opts.cancellation).toBe(registry);
  });
});

// ---------------------------------------------------------------------------
// ctx.stage(name, options?) — backward compat + MCP port wiring
// ---------------------------------------------------------------------------

describe("ctx.stage with StageOptions", () => {
  test("stage() with no options still works (backward compat)", async () => {
    const wf = defineWorkflow("compat-test")
      .description("d")
      .run(async (ctx) => {
        const s = ctx.stage("step");
        const result = await s.prompt("hello");
        return { result };
      })
      .compile();

    const res = await run(wf, {});
    expect(res.status).toBe("completed");
    expect(res.stages[0]!.name).toBe("step");
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

    expect(setCall).toBeDefined();
    expect(setCall?.allow).toEqual(["github"]);
    expect(setCall?.deny).toEqual(["filesystem"]);
    expect(clearCall).toBeDefined();
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

    const res = await run(wf, {});
    expect(res.status).toBe("completed");
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
    expect(scopeCalls).toHaveLength(0);
  });
});
