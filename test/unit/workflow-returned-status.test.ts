import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";

describe("workflow returned status outputs", () => {
  test("failed result.status makes the run fail instead of completing successfully", async () => {
    const store = createStore();
    const def = workflow({
      name: "returned-failed-status",
      description: "",
      inputs: {},
      outputs: {
        status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("blocked")]),
        summary: Type.String(),
      },
      run: async (ctx) => {
        await ctx.stage("work").complete("done");
        return { status: "failed" as const, summary: "deterministic gate failed" };
      },
    });

    const result = await run(def, {}, { store, adapters: { complete: { complete: async (text) => text } } });
    const snapshot = store.runs().find((candidate) => candidate.id === result.runId);

    assert.equal(result.status, "failed");
    assert.equal(snapshot?.status, "failed");
    assert.equal(result.error, "deterministic gate failed");
    assert.deepEqual(result.result, { status: "failed", summary: "deterministic gate failed" });
    assert.deepEqual(snapshot?.result, { status: "failed", summary: "deterministic gate failed" });
    assert.equal(snapshot?.failureKind, "unknown");
    assert.equal(snapshot?.failureRecoverability, "non_recoverable");
    assert.equal(snapshot?.failureDisposition, "terminal_failed");
    assert.equal(snapshot?.failureMessage, "deterministic gate failed");
    assert.equal(snapshot?.resumable, false);
  });

  test("blocked result.status makes the run blocked instead of completing successfully", async () => {
    const store = createStore();
    const def = workflow({
      name: "returned-blocked-status",
      description: "",
      inputs: {},
      outputs: {
        status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("blocked")]),
        summary: Type.String(),
      },
      run: async (ctx) => {
        await ctx.stage("work").complete("done");
        return { status: "blocked" as const, summary: "required checks are pending" };
      },
    });

    const durableBackend = new InMemoryDurableBackend();
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        calls.push({ type, payload });
        return `entry-${calls.length}`;
      },
      setLabel(_entryId: string, _label: string): void {},
    };
    const result = await run(def, {}, {
      store,
      durableBackend,
      persistence,
      adapters: { complete: { complete: async (text) => text } },
    });
    const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
    const durableHandle = durableBackend.getWorkflow(result.runId);
    const runEnd = calls.find((call) => call.type === "workflow.run.end");

    assert.equal(result.status, "blocked");
    assert.equal(snapshot?.status, "blocked");
    assert.equal(result.error, "required checks are pending");
    assert.equal(snapshot?.error, "required checks are pending");
    assert.equal(snapshot?.resumable, false);
    assert.equal(durableHandle?.status, "blocked");
    assert.equal(durableHandle?.resumable, false);
    assert.deepEqual(durableBackend.listResumableWorkflows(), []);
    assert.equal(runEnd?.payload["resumable"], false);
    assert.deepEqual(result.result, { status: "blocked", summary: "required checks are pending" });
  });

  test("restores returned blocked run metadata without marking it as ctx.exit", () => {
    const store = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "run-returned-blocked", name: "returned-blocked", inputs: {}, ts: 1 } },
      {
        id: "e2",
        type: "workflow.run.end",
        payload: {
          runId: "run-returned-blocked",
          status: "blocked",
          result: { status: "blocked", summary: "required checks are pending" },
          error: "required checks are pending",
          resumable: false,
          ts: 2,
        },
      },
    ];

    restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "never", persistRuns: true }, store);
    const snapshot = store.runs().find((candidate) => candidate.id === "run-returned-blocked");

    assert.equal(snapshot?.status, "blocked");
    assert.equal(snapshot?.error, "required checks are pending");
    assert.equal(snapshot?.resumable, false);
    assert.equal(snapshot?.exited, undefined);
    assert.deepEqual(snapshot?.result, { status: "blocked", summary: "required checks are pending" });
  });
});
