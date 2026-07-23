import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { statusRuns } from "../../packages/workflows/src/runs/background/status.js";
import { classifyReturnedRunStatus } from "../../packages/workflows/src/engine/run-returned-status.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

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

  test("blocked result.status remains non-resumable without structured failure metadata", async () => {
    const store = createStore();
    const def = workflow({
      name: "returned-blocked-status-with-auth-like-text",
      description: "",
      inputs: {},
      outputs: {
        status: Type.Literal("blocked"),
        summary: Type.String(),
      },
      run: async (ctx) => {
        await ctx.stage("reviewers").complete("reviewers reported a login issue");
        return { status: "blocked" as const, summary: "No API key for provider: github-copilot" };
      },
    });

    const durableBackend = new InMemoryDurableBackend();
    const result = await run(def, {}, {
      store,
      durableBackend,
      adapters: { complete: { complete: async (text) => text } },
    });
    const snapshot = store.runs().find((candidate) => candidate.id === result.runId);
    const durableHandle = durableBackend.getWorkflow(result.runId);

    assert.equal(result.status, "blocked");
    assert.equal(snapshot?.status, "blocked");
    assert.equal(snapshot?.failureKind, undefined);
    assert.equal(snapshot?.failureCode, undefined);
    assert.equal(snapshot?.resumable, false);
    assert.equal(durableHandle?.status, "blocked");
    assert.equal(durableHandle?.resumable, false);
  });

  test("structured recoverable stage failures block even without a returned status field", () => {
    const runSnapshot: RunSnapshot = {
      id: "run-structured-auth",
      name: "goal",
      inputs: {},
      status: "completed",
      startedAt: 1,
      failedStageId: "reviewer-a",
      stages: [
        {
          id: "reviewer-a",
          name: "reviewer-a",
          status: "failed",
          parentIds: [],
          toolEvents: [],
          error: "A required model provider API key is missing. Configure the provider credentials and resume the workflow.",
          failureKind: "auth",
          failureCode: "missing_api_key",
          failureRecoverability: "recoverable",
          failureDisposition: "active_blocked",
          failureMessage: "No API key for provider: github-copilot",
        },
      ],
    };

    const classified = classifyReturnedRunStatus({ remaining_work: "Reviewer execution failed" }, runSnapshot);

    assert.equal(classified.status, "blocked");
    assert.equal(classified.error, "A required model provider API key is missing. Configure the provider credentials and resume the workflow.");
    assert.equal(classified.metadata?.failureKind, "auth");
    assert.equal(classified.metadata?.failureCode, "missing_api_key");
    assert.equal(classified.metadata?.failedStageId, "reviewer-a");
    assert.equal(classified.metadata?.resumable, true);
  });

  test("tolerated recoverable stage failures do not block successful completed runs", () => {
    const runSnapshot: RunSnapshot = {
      id: "run-tolerated-auth",
      name: "ralph",
      inputs: {},
      status: "completed",
      startedAt: 1,
      result: { result: "approved" },
      stages: [
        {
          id: "reviewer-a",
          name: "reviewer-a",
          status: "failed",
          parentIds: [],
          toolEvents: [],
          error: "A required model provider API key is missing. Configure the provider credentials and resume the workflow.",
          failureKind: "auth",
          failureCode: "missing_api_key",
          failureRecoverability: "recoverable",
          failureDisposition: "active_blocked",
          failureMessage: "No API key for provider: github-copilot",
        },
        {
          id: "reviewer-b",
          name: "reviewer-b",
          status: "completed",
          parentIds: [],
          toolEvents: [],
          result: "approved",
        },
      ],
    };

    const classified = classifyReturnedRunStatus(runSnapshot.result, runSnapshot);

    assert.equal(classified.status, "completed");
    assert.equal(classified.error, undefined);
    assert.equal(classified.metadata, undefined);
  });

  test("needs_human result.status blocks Goal-like auth fallback exhaustion instead of completing", async () => {
    const store = createStore();
    const def = workflow({
      name: "goal-like-needs-human-auth",
      description: "",
      inputs: {},
      outputs: {
        result: Type.String(),
        status: Type.Union([
          Type.Literal("complete"),
          Type.Literal("blocked"),
          Type.Literal("needs_human"),
          Type.Literal("active"),
        ]),
        remaining_work: Type.String(),
      },
      run: async (ctx) => {
        await ctx.stage("work-turn-1").complete("worker failed before receipt");
        return {
          result: "Final status needs_human\nRemaining work: Worker failed before producing a receipt: No API key for provider: github-copilot",
          status: "needs_human" as const,
          remaining_work: "Worker failed before producing a receipt: No API key for provider: github-copilot",
        };
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
    const [statusEntry] = statusRuns({ store });

    assert.equal(result.status, "blocked");
    assert.equal(snapshot?.status, "blocked");
    assert.equal(statusEntry?.status, "blocked");
    assert.match(result.error ?? "", /No API key for provider: github-copilot/);
    assert.equal(snapshot?.result?.["status"], "needs_human");
    assert.equal(snapshot?.failureKind, undefined);
    assert.equal(snapshot?.failureCode, undefined);
    assert.equal(snapshot?.failureRecoverability, "recoverable");
    assert.equal(snapshot?.failureDisposition, "active_blocked");
    assert.equal(snapshot?.resumable, true);
    assert.equal(durableHandle?.status, "blocked");
    assert.equal(durableHandle?.resumable, true);
    assert.equal(runEnd?.payload["status"], "blocked");
    assert.equal(runEnd?.payload["resumable"], true);
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
