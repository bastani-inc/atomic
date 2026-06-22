import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowExitOptions } from "../../packages/workflows/src/shared/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void } {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForExecutorStagePendingPrompt(
  store: ReturnType<typeof createStore>,
  timeoutMs = 1000,
): Promise<{ runId: string; stageId: string; promptId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const runSnapshot of store.runs()) {
      const stage = runSnapshot.stages.find((candidate) => candidate.pendingPrompt !== undefined);
      if (stage?.pendingPrompt !== undefined) {
        return { runId: runSnapshot.id, stageId: stage.id, promptId: stage.pendingPrompt.id };
      }
    }
    await delay(5);
  }
  throw new Error("stage pending prompt did not appear");
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
  test("snapshots exit outputs before finally mutations can change validation", async () => {
    const valid = workflow({
      name: "exit-output-snapshot-valid",
      description: "",
      inputs: {},
      outputs: {
        count: Type.Number(),
      },
      run: async (ctx) => {
        const outputs = { count: 1 } as { count: number | string; extra?: string };
        try {
          return ctx.exit({ outputs: outputs as never });
        } finally {
          outputs.count = "not-a-number";
          outputs.extra = "late-extra";
        }
      },
    });

    const validResult = await run(valid, {}, { store: createStore() });
    assert.equal(validResult.status, "completed");
    assert.deepEqual(validResult.result, { count: 1 });

    const undeclared = workflow({
      name: "exit-output-snapshot-undeclared",
      description: "",
      inputs: {},
      outputs: {
        count: Type.Number(),
      },
      run: async (ctx) => {
        const outputs = { count: 1, extra: "bad" } as { count: number; extra?: string };
        try {
          return ctx.exit({ outputs: outputs as never });
        } finally {
          delete outputs.extra;
        }
      },
    });

    const undeclaredResult = await run(undeclared, {}, { store: createStore() });
    assert.equal(undeclaredResult.status, "failed");
    assert.match(
      undeclaredResult.error ?? "",
      /provided undeclared output "extra"; declare it in outputs: \{ "extra": Type\.\.\.\. \}/,
    );

    const invalidValue = workflow({
      name: "exit-output-snapshot-invalid-value",
      description: "",
      inputs: {},
      outputs: {
        count: Type.Number(),
      },
      run: async (ctx) => {
        const outputs = { count: "bad" as number | string };
        try {
          return ctx.exit({ outputs: outputs as never });
        } finally {
          outputs.count = 1;
        }
      },
    });

    const invalidValueResult = await run(invalidValue, {}, { store: createStore() });
    assert.equal(invalidValueResult.status, "failed");
    assert.match(invalidValueResult.error ?? "", /output "count" expected number, got string/);
  });

  test("freezes the thrown exit signal so a catching workflow cannot rewrite the terminal result", async () => {
    let signalFrozen: boolean | undefined;
    let snapshotValueFrozen: boolean | undefined;
    let nestedValueFrozen: boolean | undefined;
    const def = workflow({
      name: "exit-signal-immutable",
      description: "",
      inputs: {},
      outputs: {
        count: Type.Number(),
        nested: Type.Object({ value: Type.Number() }),
      },
      run: async (ctx) => {
        try {
          return ctx.exit({
            status: "skipped",
            reason: "original",
            outputs: { count: 1, nested: { value: 1 } },
          });
        } catch (signal) {
          const tamper = signal as {
            status?: string;
            reason?: string;
            outputSnapshot?: { value?: { count?: number; nested?: { value?: number } } };
          };
          const snapshotValue = tamper.outputSnapshot?.value;
          signalFrozen = Object.isFrozen(signal);
          snapshotValueFrozen = snapshotValue !== undefined && Object.isFrozen(snapshotValue);
          nestedValueFrozen = snapshotValue?.nested !== undefined && Object.isFrozen(snapshotValue.nested);
          // Broad catch that tries to rewrite the selected exit before rethrowing. Each
          // mutation is guarded because a frozen target throws in strict mode; the original
          // (frozen) signal is still rethrown so the executor finalizes from it.
          try { tamper.status = "completed"; } catch { /* frozen */ }
          try { tamper.reason = "tampered"; } catch { /* frozen */ }
          try { if (tamper.outputSnapshot?.value) tamper.outputSnapshot.value.count = 999; } catch { /* frozen */ }
          try { if (tamper.outputSnapshot?.value?.nested) tamper.outputSnapshot.value.nested.value = 999; } catch { /* frozen */ }
          throw signal;
        }
      },
    });

    const result = await run(def, {}, { store: createStore() });

    assert.equal(signalFrozen, true);
    assert.equal(snapshotValueFrozen, true);
    assert.equal(nestedValueFrozen, true);
    assert.equal(result.status, "skipped");
    assert.equal(result.exitReason, "original");
    assert.deepEqual(result.result, { count: 1, nested: { value: 1 } });
  });

  test("cleans up before failing output snapshot capture errors", async () => {
    const store = createStore();
    const promptStarted = deferred();
    const outputs = {} as { readonly count: number };
    Object.defineProperty(outputs, "count", {
      enumerable: true,
      get() {
        throw new Error("output getter boom");
      },
    });
    const def = workflow({
      name: "exit-output-snapshot-capture-error",
      description: "",
      inputs: {},
      outputs: {
        count: Type.Number(),
      },
      run: async (ctx) => {
        await Promise.all([
          ctx.task("slow-before-capture-failure", { prompt: "wait" }),
          (async () => {
            await promptStarted.promise;
            return ctx.exit({ reason: "capture failure", outputs });
          })(),
        ]);
        return { count: 1 };
      },
    });

    const result = await run(def, {}, {
      store,
      adapters: {
        agentSession: {
          create: async () => ({
            ...fakeAgentSession(),
            async prompt() {
              promptStarted.resolve();
              return new Promise<string>(() => {});
            },
          }) as never,
        },
      },
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /ctx\.exit\(\) outputs could not be snapshotted: output getter boom/);
    assert.deepEqual(
      result.stages.map((stage) => [stage.name, stage.status, stage.skippedReason]),
      [["slow-before-capture-failure", "skipped", "workflow-exit: capture failure"]],
    );
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.equal(snapshot?.resumable, false);
    assert.equal(snapshot?.exitReason, "capture failure");
  });

  test("cleans up before failing ctx.exit option getter errors", async () => {
    const store = createStore();
    const promptStarted = deferred();
    const options = { reason: "status getter cleanup" } as WorkflowExitOptions;
    Object.defineProperty(options, "status", {
      enumerable: true,
      get() {
        throw new Error("status getter boom");
      },
    });
    const def = workflow({
      name: "exit-option-getter-error",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await Promise.all([
          ctx.task("slow-before-option-failure", { prompt: "wait" }),
          (async () => {
            await promptStarted.promise;
            return ctx.exit(options);
          })(),
        ]);
        return {};
      },
    });

    const result = await run(def, {}, {
      store,
      adapters: {
        agentSession: {
          create: async () => ({
            ...fakeAgentSession(),
            async prompt() {
              promptStarted.resolve();
              return new Promise<string>(() => {});
            },
          }) as never,
        },
      },
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /ctx\.exit\(\) status option could not be read: status getter boom/);
    assert.deepEqual(
      result.stages.map((stage) => [stage.name, stage.status, stage.skippedReason]),
      [["slow-before-option-failure", "skipped", "workflow-exit: status getter cleanup"]],
    );
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.equal(snapshot?.resumable, false);
    assert.equal(snapshot?.exitReason, "status getter cleanup");
  });

  test("suppresses replayed stage prompt and complete finalization after ctx.exit", async () => {
    for (const action of ["prompt", "complete"] as const) {
      const store = createStore();
      const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const persistence = {
        appendEntry(type: string, payload: Record<string, unknown>): string {
          entries.push({ type, payload });
          return `entry-${entries.length}`;
        },
      };
      const def = workflow({
        name: `exit-replay-stage-${action}`,
        description: "",
        inputs: {
          mode: Type.String(),
        },
        outputs: {},
        run: async (ctx) => {
          if (ctx.inputs.mode === "exit") {
            const stage = ctx.stage("first");
            await Promise.all([
              Promise.resolve().then(() => ctx.exit({ status: "skipped", reason: `${action} replay gate` })),
              action === "prompt" ? stage.prompt("first") : stage.complete("first complete"),
            ]);
            return {};
          }
          const first = await ctx.stage("first").prompt("first");
          await ctx.stage("second").prompt(`second:${first}`);
          return {};
        },
      });

      const sourceResult = await run(def, { mode: "source" }, {
        store,
        persistence,
        adapters: {
          prompt: {
            prompt: async (text) => {
              if (text.startsWith("second:")) throw new Error("continuation test failure");
              return "first-result";
            },
          },
        },
      });
      assert.equal(sourceResult.status, "failed");
      const source = store.runs().find((runSnapshot) => runSnapshot.id === sourceResult.runId)!;

      const continued = await run(def, { mode: "exit" }, {
        store,
        persistence,
        continuation: { source, resumeFromStageId: source.failedStageId! },
        adapters: {
          prompt: {
            prompt: async () => {
              throw new Error("continuation should not prompt after replay exit");
            },
          },
        },
      });

      assert.equal(continued.status, "skipped");
      assert.equal(continued.exitReason, `${action} replay gate`);
      const replayed = continued.stages.find((stage) => stage.name === "first");
      assert.equal(replayed?.status, "skipped");
      assert.equal(replayed?.skippedReason, `workflow-exit: ${action} replay gate`);
      assert.equal(replayed?.replayed, true);
      const replayedStageEnds = entries.filter((entry) =>
        entry.type === "workflow.stage.end" &&
        entry.payload["runId"] === continued.runId &&
        entry.payload["stageId"] === replayed?.id
      );
      assert.equal(replayedStageEnds.some((entry) => entry.payload["status"] === "completed"), false);
      assert.equal(replayedStageEnds.some((entry) => entry.payload["status"] === "skipped"), true);
    }
  });

  test("suppresses replayed prompt-node finalization after ctx.exit", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const def = workflow({
      name: "exit-replay-prompt-node",
      description: "",
      inputs: {
        mode: Type.String(),
      },
      outputs: {},
      run: async (ctx) => {
        const exitPromise = ctx.inputs.mode === "exit"
          ? Promise.resolve().then(() => ctx.exit({ status: "skipped", reason: "prompt-node replay gate" }))
          : undefined;
        const proceedPromise = ctx.ui.confirm("continue?");
        if (exitPromise !== undefined) {
          await Promise.all([exitPromise, proceedPromise]);
          return {};
        }
        const proceed = await proceedPromise;
        await ctx.stage("after").prompt(proceed ? "after yes" : "after no");
        return {};
      },
    });

    const sourcePromise = run(def, { mode: "source" }, {
      store,
      persistence,
      usePromptNodesForUi: true,
      adapters: {
        prompt: {
          prompt: async (text) => {
            if (text.startsWith("after")) throw new Error("continuation test failure");
            return "unused";
          },
        },
      },
    });
    const sourcePrompt = await waitForExecutorStagePendingPrompt(store);
    store.resolveStagePendingPrompt(sourcePrompt.runId, sourcePrompt.stageId, sourcePrompt.promptId, true);
    const sourceResult = await sourcePromise;
    assert.equal(sourceResult.status, "failed");
    const source = store.runs().find((runSnapshot) => runSnapshot.id === sourceResult.runId)!;

    const continued = await run(def, { mode: "exit" }, {
      store,
      persistence,
      continuation: { source, resumeFromStageId: source.failedStageId! },
      usePromptNodesForUi: true,
      adapters: {
        prompt: {
          prompt: async () => {
            throw new Error("continuation should not prompt after prompt-node replay exit");
          },
        },
      },
    });

    assert.equal(continued.status, "skipped");
    assert.equal(continued.exitReason, "prompt-node replay gate");
    const replayedPrompt = continued.stages.find((stage) => stage.name === "confirm");
    assert.equal(replayedPrompt?.status, "skipped");
    assert.equal(replayedPrompt?.skippedReason, "workflow-exit: prompt-node replay gate");
    assert.equal(replayedPrompt?.replayed, true);
    const replayedPromptEnds = entries.filter((entry) =>
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === continued.runId &&
      entry.payload["stageId"] === replayedPrompt?.id
    );
    assert.equal(replayedPromptEnds.some((entry) => entry.payload["status"] === "completed"), false);
    assert.equal(replayedPromptEnds.some((entry) => entry.payload["status"] === "skipped"), true);
  });

});
