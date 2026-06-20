import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { killRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void } {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeAgentSession(): Record<string, unknown> {
  return {
    sessionId: "session-retained",
    sessionFile: "session-retained.jsonl",
    isStreaming: false,
    messages: [],
    model: "sonnet",
    thinkingLevel: "medium",
    agent: {},
    async prompt() { return ""; },
    async steer() {},
    async followUp() {},
    subscribe() { return () => {}; },
    async setModel(model: string) { this.model = model; },
    setThinkingLevel(level: string) { this.thinkingLevel = level; },
    async cycleModel() { this.model = "opus"; return undefined; },
    cycleThinkingLevel() { this.thinkingLevel = "high"; return undefined; },
    async navigateTree() { return { cancelled: false }; },
    async compact() { return { summary: "", firstKeptEntryId: "", tokensBefore: 10, tokensAfter: 5 }; },
    abortCompaction() {},
    async abort() {},
    dispose() {},
    getLastAssistantText() { return undefined; },
  };
}

describe("ctx.exit", () => {
  test("returns canonical killed result when external kill wins while ctx.exit cleanup is pending", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const promptStarted = deferred();
    const cleanupAbortStarted = deferred();
    const releaseCleanup = deferred();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const onRunEndCalls: Array<{
      status: string;
      result?: unknown;
      error?: string;
      exitReason?: string;
    }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const def = defineWorkflow("exit-kill-race")
      .run(async (ctx) => {
        await Promise.all([
          ctx.task("cleanup-pending", { prompt: "wait for cleanup" }),
          (async () => {
            await promptStarted.promise;
            return ctx.exit({ status: "skipped", reason: "cleanup pending" });
          })(),
        ]);
        return {};
      })
      .compile();

    let runId = "";
    const runPromise = run(def, {}, {
      store,
      cancellation,
      persistence,
      onRunStart: (snapshot) => {
        runId = snapshot.id;
      },
      onRunEnd: (_runId, status, result, error, exitReason) => {
        onRunEndCalls.push({
          status,
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(exitReason !== undefined ? { exitReason } : {}),
        });
      },
      adapters: {
        agentSession: {
          create: async () => ({
            ...fakeAgentSession(),
            sessionId: "exit-kill-race-session",
            sessionFile: "exit-kill-race-session.jsonl",
            async prompt() {
              promptStarted.resolve();
              return new Promise<string>(() => {});
            },
            async abort() {
              cleanupAbortStarted.resolve();
              await releaseCleanup.promise;
            },
          }) as never,
        },
      },
    });

    await cleanupAbortStarted.promise;
    const killed = killRun(runId, { store, cancellation, persistence });
    assert.equal(killed.ok, true);
    releaseCleanup.resolve();

    const result = await runPromise;

    assert.equal(result.status, "killed");
    assert.equal(result.error, "workflow killed");
    assert.equal(result.exited, undefined);
    assert.equal(result.exitReason, undefined);
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === runId);
    assert.equal(snapshot?.status, "killed");
    assert.equal(snapshot?.error, "workflow killed");
    assert.equal(snapshot?.exited, undefined);
    assert.equal(snapshot?.exitReason, undefined);
    const runEndEntries = entries.filter((entry) =>
      entry.type === "workflow.run.end" && entry.payload["runId"] === runId
    );
    assert.equal(runEndEntries.length, 1);
    assert.equal(runEndEntries[0]?.payload["status"], "killed");
    assert.equal(runEndEntries.some((entry) => entry.payload["status"] === "skipped"), false);
    assert.equal(runEndEntries.some((entry) => entry.payload["status"] === "completed"), false);
    assert.equal(onRunEndCalls.length, 1);
    assert.deepEqual(onRunEndCalls[0], { status: "killed", error: "workflow killed" });
  });

});
