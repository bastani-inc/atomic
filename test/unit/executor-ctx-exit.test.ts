import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { inspectRun, killRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { NON_INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import type { StageContext, WorkflowChildResult, WorkflowExitOptions } from "../../packages/workflows/src/shared/types.js";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

function expectString(value: string): void {
  assert.equal(typeof value, "string");
}

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

async function expectBlockedStageMutation(action: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (err) {
    assert.notEqual(err, undefined);
    return;
  }
  assert.fail("expected retained stage mutation to be blocked after ctx.exit");
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

function controlProbeSymbolDescription(key: PropertyKey): string | undefined {
  return typeof key === "symbol" ? key.description : undefined;
}

function errorWithThrowingControlProbeAccessors(message: string): Error {
  const error = new Error(message);
  for (const key of ["cause", "reason", "errors", "scope"] as const) {
    Object.defineProperty(error, key, {
      configurable: true,
      get() {
        throw new Error(`${key} accessor should not escape control-signal probing`);
      },
    });
  }
  return new Proxy(error, {
    get(target, key, receiver) {
      const description = controlProbeSymbolDescription(key);
      if (description?.includes("atomic-workflows.workflow-exit-signal") === true) {
        throw new Error("workflow-exit marker accessor should not escape control-signal probing");
      }
      if (description?.includes("atomic-workflows.parent-workflow-exit-abort") === true) {
        throw new Error("parent-exit marker accessor should not escape control-signal probing");
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

describe("ctx.exit", () => {
  test("exits a top-level workflow before any stage without failing empty graph validation", async () => {
    const store = createStore();
    const def = defineWorkflow("exit-top-level")
      .run(async (ctx) => {
        return ctx.exit();
      })
      .compile();

    const result = await run(def, {}, { store });

    assert.equal(result.status, "completed");
    assert.equal(result.exited, true);
    assert.equal(result.error, undefined);
    assert.equal(result.stages.length, 0);
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.equal(snapshot?.status, "completed");
    assert.equal(snapshot?.exited, true);
    assert.equal(snapshot?.resumable, false);
  });

  test("exits from a nested helper with status, reason, and partial outputs", async () => {
    const store = createStore();
    const def = defineWorkflow("exit-helper")
      .output("count", Type.Number())
      .output("note", Type.String())
      .run(async (ctx) => {
        const helper = (): never => ctx.exit({
          status: "skipped",
          reason: "nothing to process",
          outputs: { count: 0 },
        });
        return helper();
      })
      .compile();

    const result = await run(def, {}, { store });

    assert.equal(result.status, "skipped");
    assert.deepEqual(result.result, { count: 0 });
    assert.equal(result.exitReason, "nothing to process");
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.equal(snapshot?.status, "skipped");
    assert.equal(snapshot?.exitReason, "nothing to process");
    assert.equal(snapshot?.resumable, false);
    assert.deepEqual(snapshot?.result, { count: 0 });
    const inspected = inspectRun(result.runId, { store });
    assert.equal(inspected.ok, true);
    if (inspected.ok) assert.equal(inspected.detail.exitReason, "nothing to process");
  });

  test("aborts and skips in-flight parallel siblings", async () => {
    const store = createStore();
    const def = defineWorkflow("exit-during-parallel")
      .run(async (ctx) => {
        await Promise.all([
          ctx.parallel([
            { name: "slow-a", prompt: "slow-a" },
            { name: "slow-b", prompt: "slow-b" },
          ]),
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            ctx.exit({ status: "cancelled", reason: "parallel gate closed" });
          })(),
        ]);
        return {};
      })
      .compile();

    const result = await run(def, {}, {
      store,
      adapters: {
        prompt: {
          prompt: async () => new Promise<string>(() => {}),
        },
      },
    });

    assert.equal(result.status, "cancelled");
    assert.equal(result.exitReason, "parallel gate closed");
    assert.equal(result.stages.length, 2);
    assert.deepEqual(
      result.stages.map((stage) => [stage.name, stage.status, stage.skippedReason]),
      [
        ["slow-a", "skipped", "workflow-exit: parallel gate closed"],
        ["slow-b", "skipped", "workflow-exit: parallel gate closed"],
      ],
    );
  });

  test("stops queued parallel work after exit with failFast false and limited concurrency", async () => {
    const store = createStore();
    const def = defineWorkflow("exit-parallel-queue-halt")
      .run(async (ctx) => {
        await Promise.all([
          ctx.parallel([
            { name: "started", prompt: "started" },
            { name: "queued-a", prompt: "queued-a" },
            { name: "queued-b", prompt: "queued-b" },
          ], { concurrency: 1, failFast: false }),
          (async () => {
            await delay(10);
            return ctx.exit({ status: "skipped", reason: "queue gate" });
          })(),
        ]);
        return {};
      })
      .compile();

    const result = await run(def, {}, {
      store,
      adapters: {
        prompt: {
          prompt: async () => new Promise<string>(() => {}),
        },
      },
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.exitReason, "queue gate");
    assert.deepEqual(
      result.stages.map((stage) => [stage.name, stage.status, stage.skippedReason]),
      [["started", "skipped", "workflow-exit: queue gate"]],
    );
    assert.equal(result.stages.some((stage) => stage.name === "queued-a" || stage.name === "queued-b"), false);
  });

  test("delayed post-exit stage and workflow calls do not create graph artifacts", async () => {
    const store = createStore();
    const lateStageDone = deferred();
    const lateWorkflowDone = deferred();
    const child = defineWorkflow("exit-delayed-child")
      .run(async () => ({}))
      .compile();
    const def = defineWorkflow("exit-delayed-spawn-guards")
      .run(async (ctx) => {
        void (async () => {
          await delay(20);
          try {
            ctx.stage("late-stage");
          } catch {
            // Expected: the selected ctx.exit sentinel is rethrown by the gate.
          } finally {
            lateStageDone.resolve();
          }
        })();
        void (async () => {
          await delay(25);
          try {
            await ctx.workflow(child);
          } catch {
            // Expected: no workflow boundary or child run is created after exit.
          } finally {
            lateWorkflowDone.resolve();
          }
        })();
        return ctx.exit({ status: "skipped", reason: "delayed guard" });
      })
      .compile();

    const result = await run(def, {}, { store });
    await Promise.all([lateStageDone.promise, lateWorkflowDone.promise]);

    assert.equal(result.status, "skipped");
    const parentSnapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.deepEqual(parentSnapshot?.stages.map((stage) => stage.name), []);
    assert.equal(store.runs().some((runSnapshot) => runSnapshot.name === "exit-delayed-child"), false);
  });

  test("blocks retained StageContext session mutations after exit without creating an AgentSession", async () => {
    const store = createStore();
    let retainedStage: StageContext | undefined;
    let sessionCreateCount = 0;
    const def = defineWorkflow("exit-retained-stage-gate")
      .run(async (ctx) => {
        retainedStage = ctx.stage("retained");
        return ctx.exit({ status: "skipped", reason: "retained gate" });
      })
      .compile();

    const result = await run(def, {}, {
      store,
      adapters: {
        agentSession: {
          create: async () => {
            sessionCreateCount += 1;
            return fakeAgentSession() as never;
          },
        },
      },
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.stages[0]?.status, "skipped");
    assert.equal(result.stages[0]?.skippedReason, "workflow-exit: retained gate");
    const stage = retainedStage;
    assert.ok(stage);
    await expectBlockedStageMutation(() => stage.prompt("late prompt"));
    await expectBlockedStageMutation(() => stage.complete("late complete"));
    await expectBlockedStageMutation(() => stage.steer("late steer"));
    await expectBlockedStageMutation(() => stage.followUp("late follow up"));
    await expectBlockedStageMutation(() => stage.setModel("haiku" as never));
    await expectBlockedStageMutation(() => stage.setThinkingLevel("high" as never));
    await expectBlockedStageMutation(() => stage.cycleModel());
    await expectBlockedStageMutation(() => stage.cycleThinkingLevel());
    await expectBlockedStageMutation(() => stage.navigateTree("node-1"));
    await expectBlockedStageMutation(() => stage.compact());
    await expectBlockedStageMutation(() => stage.abortCompaction());
    await expectBlockedStageMutation(() => stage.abort());
    assert.equal(sessionCreateCount, 0);
  });

  test("skips a workflow boundary without launching the child when exit is selected before launch", async () => {
    const store = createStore();
    let inputGetterCalls = 0;
    const child = defineWorkflow("exit-boundary-child")
      .input("trigger", Type.String())
      .run(async (ctx) => {
        await ctx.task("should-not-run", { prompt: "should not run" });
        return {};
      })
      .compile();
    const def = defineWorkflow("exit-boundary-before-launch")
      .run(async (ctx) => {
        const childInputs = {} as { trigger: string };
        Object.defineProperty(childInputs, "trigger", {
          enumerable: true,
          get() {
            inputGetterCalls += 1;
            return ctx.exit({ status: "skipped", reason: "input gate" });
          },
        });
        await ctx.workflow(child, { inputs: childInputs });
        return {};
      })
      .compile();

    const result = await run(def, {}, { store });

    assert.equal(inputGetterCalls, 1);
    assert.equal(result.status, "skipped");
    assert.equal(result.stages.length, 1);
    assert.deepEqual(
      result.stages.map((stage) => [stage.name, stage.status, stage.skippedReason]),
      [["workflow:exit-boundary-child", "skipped", "workflow-exit: input gate"]],
    );
    assert.equal(store.runs().some((runSnapshot) => runSnapshot.name === "exit-boundary-child"), false);
  });

  test("parent exit while a child workflow is in flight lets the child finalize cleanup", async () => {
    const store = createStore();
    const childPromptStarted = deferred();
    let childSessionDisposeCount = 0;
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const child = defineWorkflow("exit-inflight-child")
      .run(async (ctx) => {
        await ctx.task("child-slow", { prompt: "child slow" });
        return {};
      })
      .compile();
    const parent = defineWorkflow("exit-parent-cancels-child")
      .run(async (ctx) => {
        await Promise.all([
          ctx.workflow(child),
          (async () => {
            await childPromptStarted.promise;
            return ctx.exit({ status: "skipped", reason: "parent gate" });
          })(),
        ]);
        return {};
      })
      .compile();

    const result = await run(parent, {}, {
      store,
      persistence,
      adapters: {
        agentSession: {
          create: async () => ({
            ...fakeAgentSession(),
            sessionId: "child-session",
            sessionFile: "child-session.jsonl",
            async prompt() {
              childPromptStarted.resolve();
              return new Promise<string>(() => {});
            },
            async abort() {},
            async dispose() {
              childSessionDisposeCount += 1;
              entries.push({ type: "test.child-session.dispose", payload: { sessionId: "child-session" } });
            },
          }) as never,
        },
      },
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.exitReason, "parent gate");
    const boundary = result.stages.find((stage) => stage.name === "workflow:exit-inflight-child");
    assert.equal(boundary?.status, "skipped");
    assert.equal(boundary?.skippedReason, "workflow-exit: parent gate");
    assert.equal(boundary?.workflowChildRun, undefined);
    assert.equal(boundary?.workflowChild, undefined);
    const parentBoundaryEnd = entries.find((entry) =>
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === result.runId &&
      entry.payload["stageId"] === boundary?.id
    );
    assert.equal(parentBoundaryEnd?.payload["status"], "skipped");
    assert.equal("workflowChild" in (parentBoundaryEnd?.payload ?? {}), false);
    const childSnapshot = store.runs().find((runSnapshot) => runSnapshot.name === "exit-inflight-child");
    assert.ok(childSnapshot);
    assert.equal(childSnapshot.status, "cancelled");
    assert.equal(childSnapshot.exited, true);
    assert.equal(childSnapshot.exitReason, "parent workflow exited: parent gate");
    assert.equal(childSnapshot.resumable, false);
    assert.deepEqual(
      childSnapshot.stages.map((stage) => [stage.name, stage.status, stage.skippedReason]),
      [["child-slow", "skipped", "workflow-exit: parent gate"]],
    );
    assert.equal(childSnapshot.stages.some((stage) => stage.attachable === true), false);
    assert.equal(childSessionDisposeCount, 1);
    const childStage = childSnapshot.stages[0];
    assert.ok(childStage);
    const childStageEnds = entries.filter((entry) =>
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === childSnapshot.id &&
      entry.payload["stageId"] === childStage.id
    );
    assert.equal(childStageEnds.length, 1);
    const childRunEnds = entries.filter((entry) =>
      entry.type === "workflow.run.end" && entry.payload["runId"] === childSnapshot.id
    );
    assert.equal(childRunEnds.length, 1);
    const childStageEndIndex = entries.findIndex((entry) =>
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === childSnapshot.id &&
      entry.payload["stageId"] === childStage.id
    );
    const childRunEndIndex = entries.findIndex((entry) =>
      entry.type === "workflow.run.end" && entry.payload["runId"] === childSnapshot.id
    );
    const childDisposeIndex = entries.findIndex((entry) => entry.type === "test.child-session.dispose");
    const parentRunEndIndex = entries.findIndex((entry) =>
      entry.type === "workflow.run.end" && entry.payload["runId"] === result.runId
    );
    assert.notEqual(childStageEndIndex, -1);
    assert.notEqual(childRunEndIndex, -1);
    assert.notEqual(childDisposeIndex, -1);
    assert.notEqual(parentRunEndIndex, -1);
    assert.equal(entries[childStageEndIndex]?.payload["status"], "skipped");
    assert.equal(entries[childStageEndIndex]?.payload["skippedReason"], "workflow-exit: parent gate");
    assert.equal(childStageEndIndex < childRunEndIndex, true);
    assert.equal(childDisposeIndex < childRunEndIndex, true);
    assert.equal(childRunEndIndex < parentRunEndIndex, true);
    assert.equal(entries.some((entry, index) =>
      index > childRunEndIndex &&
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === childSnapshot.id
    ), false);
    assert.equal(childRunEnds[0]?.payload["status"], "cancelled");
    assert.equal(childRunEnds[0]?.payload["exited"], true);
    assert.equal(childRunEnds[0]?.payload["exitReason"], "parent workflow exited: parent gate");
    assert.equal(
      store.runs().some((runSnapshot) =>
        runSnapshot.stages.some((stage) => stage.status === "running" || stage.status === "pending" || stage.attachable === true)
      ),
      false,
    );
  });

  test("failed workflow boundaries clear linked child metadata and omit child replay persistence", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const child = defineWorkflow("exit-failed-boundary-child")
      .output("count", Type.Number())
      .run(async (ctx) => {
        await ctx.stage("child-ready").prompt("child ready");
        return { count: "not-a-number" as never };
      })
      .compile();
    const parent = defineWorkflow("exit-failed-boundary-parent")
      .run(async (ctx) => {
        await ctx.workflow(child);
        return {};
      })
      .compile();

    const result = await run(parent, {}, {
      store,
      persistence,
      adapters: { prompt: { prompt: async () => "ready" } },
    });

    assert.equal(result.status, "failed");
    const boundary = result.stages.find((stage) => stage.name === "workflow:exit-failed-boundary-child");
    assert.equal(boundary?.status, "failed");
    assert.equal(boundary?.workflowChildRun, undefined);
    assert.equal(boundary?.workflowChild, undefined);
    const boundaryEnd = entries.find((entry) =>
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === result.runId &&
      entry.payload["stageId"] === boundary?.id
    );
    assert.equal(boundaryEnd?.payload["status"], "failed");
    assert.equal("workflowChild" in (boundaryEnd?.payload ?? {}), false);
  });

  test("ctx.exit before continuation replay finalization clears preloaded workflow child metadata", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const child = defineWorkflow("exit-replay-child")
      .output("value", Type.String())
      .run(async (ctx) => {
        const value = await ctx.stage("child").prompt("child");
        return { value };
      })
      .compile();
    const parent = defineWorkflow("exit-replay-parent")
      .input("mode", Type.String())
      .run(async (ctx) => {
        if (ctx.inputs.mode === "exit") {
          await Promise.all([
            Promise.resolve().then(() => ctx.exit({ status: "skipped", reason: "replay gate" })),
            ctx.workflow(child),
          ]);
          return {};
        }
        const childResult = await ctx.workflow(child);
        if (childResult.exited === true) throw new Error("source child exited unexpectedly");
        await ctx.stage("after").prompt(`after:${childResult.outputs.value}`);
        return {};
      })
      .compile();

    const sourceResult = await run(parent, { mode: "source" }, {
      store,
      persistence,
      adapters: {
        prompt: {
          prompt: async (text) => {
            if (text.startsWith("after:")) throw new Error("source failure after child replay point");
            return "child-ok";
          },
        },
      },
    });
    assert.equal(sourceResult.status, "failed");
    const source = store.runs().find((runSnapshot) => runSnapshot.id === sourceResult.runId)!;
    const sourceBoundary = source.stages.find((stage) => stage.name === "workflow:exit-replay-child");
    assert.equal(sourceBoundary?.status, "completed");
    assert.equal(sourceBoundary?.workflowChild?.outputs["value"], "child-ok");

    const continued = await run(parent, { mode: "exit" }, {
      store,
      persistence,
      continuation: { source, resumeFromStageId: source.failedStageId! },
      adapters: { prompt: { prompt: async () => "should-not-run" } },
    });

    assert.equal(continued.status, "skipped");
    assert.equal(continued.exitReason, "replay gate");
    const boundary = continued.stages.find((stage) => stage.name === "workflow:exit-replay-child");
    assert.equal(boundary?.status, "skipped");
    assert.equal(boundary?.skippedReason, "workflow-exit: replay gate");
    assert.equal(boundary?.workflowChildRun, undefined);
    assert.equal(boundary?.workflowChild, undefined);
    const boundaryEnd = entries.find((entry) =>
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === continued.runId &&
      entry.payload["stageId"] === boundary?.id
    );
    assert.equal(boundaryEnd?.payload["status"], "skipped");
    assert.equal("workflowChild" in (boundaryEnd?.payload ?? {}), false);
    assert.equal(
      store.runs().filter((runSnapshot) => runSnapshot.name === "exit-replay-child").length,
      1,
    );
  });

  test("delayed prompt-node UI calls after exit do not create prompt stages", async () => {
    const store = createStore();
    const lateUiDone = deferred();
    let lateUiAttempted = false;
    const def = defineWorkflow("exit-delayed-ui-guard")
      .run(async (ctx) => {
        void (async () => {
          await delay(20);
          lateUiAttempted = true;
          try {
            await ctx.ui.input("late input");
          } catch {
            // Expected: the selected ctx.exit sentinel is rethrown before prompt-node creation.
          } finally {
            lateUiDone.resolve();
          }
        })();
        return ctx.exit({ status: "cancelled", reason: "ui gate" });
      })
      .compile();

    const result = await run(def, {}, { store, usePromptNodesForUi: true });
    await lateUiDone.promise;

    assert.equal(result.status, "cancelled");
    assert.equal(lateUiAttempted, true);
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.deepEqual(snapshot?.stages, []);
  });

  test("preserves workflow-exit reasons when prompt-node abort handling runs after cleanup", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const def = defineWorkflow("exit-prompt-node-reason")
      .run(async (ctx) => {
        await Promise.all([
          ctx.ui.input("wait for exit"),
          (async () => {
            await delay(10);
            return ctx.exit({ status: "skipped", reason: "prompt gate" });
          })(),
        ]);
        return {};
      })
      .compile();

    const result = await run(def, {}, { store, persistence, usePromptNodesForUi: true });
    await delay(20);

    assert.equal(result.status, "skipped");
    assert.equal(result.exitReason, "prompt gate");
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    const promptStage = snapshot?.stages.find((stage) => stage.name === "input");
    assert.equal(promptStage?.status, "skipped");
    assert.equal(promptStage?.skippedReason, "workflow-exit: prompt gate");
    const persistedPromptEnd = entries.find((entry) =>
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === result.runId &&
      entry.payload["stageId"] === promptStage?.id
    );
    assert.equal(persistedPromptEnd?.payload["status"], "skipped");
    assert.equal(persistedPromptEnd?.payload["skippedReason"], "workflow-exit: prompt gate");
  });

  test("keeps the first exit when a later exit is thrown during unwind", async () => {
    const def = defineWorkflow("exit-first-wins")
      .output("winner", Type.String())
      .run(async (ctx) => {
        try {
          return ctx.exit({ status: "skipped", reason: "first", outputs: { winner: "first" } });
        } finally {
          ctx.exit({ status: "cancelled", reason: "second", outputs: { winner: "second" } });
        }
      })
      .compile();

    const result = await run(def, {}, { store: createStore() });

    assert.equal(result.status, "skipped");
    assert.equal(result.exitReason, "first");
    assert.deepEqual(result.result, { winner: "first" });
  });

  test("fails the run when exit outputs violate declared schemas", async () => {
    const def = defineWorkflow("exit-invalid-output")
      .output("count", Type.Number())
      .run(async (ctx) => {
        return ctx.exit({ outputs: { count: "not-a-number" as never } });
      })
      .compile();

    const result = await run(def, {}, { store: createStore() });

    assert.equal(result.status, "failed");
    assert.match(
      result.error ?? "",
      /workflow "exit-invalid-output" ctx\.exit\(\) output "count" expected number, got string/,
    );
  });

  test("scopes child workflow exits to the child result", async () => {
    const store = createStore();
    const child = defineWorkflow("exit-child")
      .output("note", Type.String())
      .run(async (ctx) => {
        return ctx.exit({ status: "skipped", reason: "child guard", outputs: { note: "child-note" } });
      })
      .compile();
    const parent = defineWorkflow("exit-parent")
      .output("childStatus", Type.String())
      .output("childNote", Type.String())
      .output("childReason", Type.String())
      .run(async (ctx) => {
        const childResult = await ctx.workflow(child);
        if (childResult.exited === true) {
          return {
            childStatus: childResult.status,
            childNote: childResult.outputs.note ?? "",
            childReason: childResult.exitReason ?? "",
          };
        }
        return {
          childStatus: childResult.status,
          childNote: childResult.outputs.note,
          childReason: "",
        };
      })
      .compile();

    const result = await run(parent, {}, { store });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, {
      childStatus: "skipped",
      childNote: "child-note",
      childReason: "child guard",
    });
    const childSnapshot = store.runs().find((runSnapshot) => runSnapshot.name === "exit-child");
    assert.equal(childSnapshot?.status, "skipped");
    assert.equal(childSnapshot?.exitReason, "child guard");
    const boundary = result.stages.find((stage) => stage.name === "workflow:exit-child");
    assert.equal(boundary?.status, "completed");
    assert.equal(boundary?.workflowChild?.status, "skipped");
    assert.equal(boundary?.workflowChild?.exited, true);
    assert.equal(boundary?.workflowChild?.exitReason, "child guard");
  });

  test("cleans up in-flight work before failing invalid exit output containers", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const def = defineWorkflow("exit-invalid-output-cleanup")
      .output("count", Type.Number())
      .run(async (ctx) => {
        await Promise.all([
          ctx.parallel([
            { name: "slow-cleanup-a", prompt: "slow-cleanup-a" },
            { name: "slow-cleanup-b", prompt: "slow-cleanup-b" },
          ]),
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return ctx.exit({ reason: "bad outputs after cleanup", outputs: [] as never });
          })(),
        ]);
        return { count: 1 };
      })
      .compile();

    const result = await run(def, {}, {
      store,
      persistence,
      adapters: {
        prompt: {
          prompt: async () => new Promise<string>(() => {}),
        },
      },
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /ctx\.exit\(\) outputs must be a JSON-serializable .* object, got array/);
    assert.deepEqual(
      result.stages.map((stage) => [stage.name, stage.status, stage.skippedReason]),
      [
        ["slow-cleanup-a", "skipped", "workflow-exit: bad outputs after cleanup"],
        ["slow-cleanup-b", "skipped", "workflow-exit: bad outputs after cleanup"],
      ],
    );
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.equal(snapshot?.status, "failed");
    assert.equal(snapshot?.resumable, false);
    assert.equal(snapshot?.exitReason, "bad outputs after cleanup");
    assert.equal(snapshot?.stages.some((stage) => stage.status === "running" || stage.attachable === true), false);
    const runEnd = entries.find((entry) => entry.type === "workflow.run.end" && entry.payload["runId"] === result.runId);
    assert.equal(runEnd?.payload["status"], "failed");
    assert.equal(runEnd?.payload["resumable"], false);
    assert.equal(runEnd?.payload["exitReason"], "bad outputs after cleanup");
  });

  test("snapshots exit outputs before finally mutations can change validation", async () => {
    const valid = defineWorkflow("exit-output-snapshot-valid")
      .output("count", Type.Number())
      .run(async (ctx) => {
        const outputs = { count: 1 } as { count: number | string; extra?: string };
        try {
          return ctx.exit({ outputs: outputs as never });
        } finally {
          outputs.count = "not-a-number";
          outputs.extra = "late-extra";
        }
      })
      .compile();

    const validResult = await run(valid, {}, { store: createStore() });
    assert.equal(validResult.status, "completed");
    assert.deepEqual(validResult.result, { count: 1 });

    const undeclared = defineWorkflow("exit-output-snapshot-undeclared")
      .output("count", Type.Number())
      .run(async (ctx) => {
        const outputs = { count: 1, extra: "bad" } as { count: number; extra?: string };
        try {
          return ctx.exit({ outputs: outputs as never });
        } finally {
          delete outputs.extra;
        }
      })
      .compile();

    const undeclaredResult = await run(undeclared, {}, { store: createStore() });
    assert.equal(undeclaredResult.status, "failed");
    assert.match(undeclaredResult.error ?? "", /provided undeclared output "extra"/);

    const invalidValue = defineWorkflow("exit-output-snapshot-invalid-value")
      .output("count", Type.Number())
      .run(async (ctx) => {
        const outputs = { count: "bad" as number | string };
        try {
          return ctx.exit({ outputs: outputs as never });
        } finally {
          outputs.count = 1;
        }
      })
      .compile();

    const invalidValueResult = await run(invalidValue, {}, { store: createStore() });
    assert.equal(invalidValueResult.status, "failed");
    assert.match(invalidValueResult.error ?? "", /output "count" expected number, got string/);
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
    const def = defineWorkflow("exit-output-snapshot-capture-error")
      .output("count", Type.Number())
      .run(async (ctx) => {
        await Promise.all([
          ctx.task("slow-before-capture-failure", { prompt: "wait" }),
          (async () => {
            await promptStarted.promise;
            return ctx.exit({ reason: "capture failure", outputs });
          })(),
        ]);
        return { count: 1 };
      })
      .compile();

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
    const def = defineWorkflow("exit-option-getter-error")
      .run(async (ctx) => {
        await Promise.all([
          ctx.task("slow-before-option-failure", { prompt: "wait" }),
          (async () => {
            await promptStarted.promise;
            return ctx.exit(options);
          })(),
        ]);
        return {};
      })
      .compile();

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
      const def = defineWorkflow(`exit-replay-stage-${action}`)
        .input("mode", Type.String())
        .run(async (ctx) => {
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
        })
        .compile();

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
    const def = defineWorkflow("exit-replay-prompt-node")
      .input("mode", Type.String())
      .run(async (ctx) => {
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
      })
      .compile();

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

  test("returns canonical killed result when invalid ctx.exit output loses to external kill", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const promptStarted = deferred();
    const cleanupAbortStarted = deferred();
    const releaseCleanup = deferred();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const onRunEndCalls: Array<{ status: string; error?: string; exitReason?: string }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const def = defineWorkflow("exit-invalid-output-kill-race")
      .output("count", Type.Number())
      .run(async (ctx) => {
        await Promise.all([
          ctx.task("cleanup-pending", { prompt: "wait for cleanup" }),
          (async () => {
            await promptStarted.promise;
            return ctx.exit({
              status: "completed",
              reason: "invalid output cleanup pending",
              outputs: { count: "not-a-number" as never },
            });
          })(),
        ]);
        return { count: 1 };
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
      onRunEnd: (_runId, status, _result, error, exitReason) => {
        onRunEndCalls.push({
          status,
          ...(error !== undefined ? { error } : {}),
          ...(exitReason !== undefined ? { exitReason } : {}),
        });
      },
      adapters: {
        agentSession: {
          create: async () => ({
            ...fakeAgentSession(),
            sessionId: "exit-invalid-output-kill-race-session",
            sessionFile: "exit-invalid-output-kill-race-session.jsonl",
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
    assert.equal(result.exitReason, undefined);
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === runId);
    assert.equal(snapshot?.status, "killed");
    assert.equal(snapshot?.error, "workflow killed");
    assert.equal(snapshot?.exitReason, undefined);
    const runEndEntries = entries.filter((entry) =>
      entry.type === "workflow.run.end" && entry.payload["runId"] === runId
    );
    assert.equal(runEndEntries.length, 1);
    assert.equal(runEndEntries[0]?.payload["status"], "killed");
    assert.equal(runEndEntries.some((entry) => entry.payload["status"] === "failed"), false);
    assert.equal(runEndEntries.some((entry) => entry.payload["status"] === "completed"), false);
    assert.deepEqual(onRunEndCalls, [{ status: "killed", error: "workflow killed" }]);
  });

  test("finalizes ordinary failures when control-signal probing sees throwing accessors", async () => {
    const store = createStore();
    const thrown = errorWithThrowingControlProbeAccessors("ordinary control-probe failure");
    const def = defineWorkflow("exit-safe-probe-ordinary-failure")
      .run(async () => {
        throw thrown;
      })
      .compile();

    const result = await run(def, {}, { store });

    assert.equal(result.status, "failed");
    assert.equal(result.exited, undefined);
    assert.equal(result.exitReason, undefined);
    assert.match(result.error ?? "", /ordinary control-probe failure/);
    assert.doesNotMatch(result.error ?? "", /accessor should not escape|workflow-exit|ctx\.exit/);
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.equal(snapshot?.status, "failed");
    assert.equal(snapshot?.exited, undefined);
    assert.equal(snapshot?.exitReason, undefined);
  });

  test("ignores AggregateError-like errors accessors that throw during ctx.exit probing", async () => {
    const store = createStore();
    const aggregateLike = { message: "ordinary aggregate-like failure" } as { readonly message: string; readonly errors?: unknown };
    Object.defineProperty(aggregateLike, "errors", {
      configurable: true,
      get() {
        throw new Error("aggregate errors accessor should not escape control-signal probing");
      },
    });
    const def = defineWorkflow("exit-safe-probe-aggregate-errors")
      .run(async () => {
        throw aggregateLike;
      })
      .compile();

    const result = await run(def, {}, { store });

    assert.equal(result.status, "failed");
    assert.equal(result.exited, undefined);
    assert.equal(result.exitReason, undefined);
    assert.match(result.error ?? "", /ordinary aggregate-like failure/);
    assert.doesNotMatch(result.error ?? "", /aggregate errors accessor should not escape|workflow-exit|ctx\.exit/);
  });

  test("treats aborted runs with throwing control-signal probe accessors as killed", async () => {
    const store = createStore();
    const controller = new AbortController();
    controller.abort(errorWithThrowingControlProbeAccessors("external abort should stay killed"));
    const def = defineWorkflow("exit-safe-probe-abort-reason")
      .run(async () => ({}))
      .compile();

    const result = await run(def, {}, { store, signal: controller.signal });

    assert.equal(result.status, "killed");
    assert.equal(result.error, "workflow killed");
    assert.equal(result.exited, undefined);
    assert.equal(result.exitReason, undefined);
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.equal(snapshot?.status, "killed");
    assert.equal(snapshot?.exited, undefined);
    assert.equal(snapshot?.exitReason, undefined);
  });

  test("returns completed child ctx.exit results as exited with partial outputs", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const child = defineWorkflow("exit-child-completed-partial")
      .output("requiredNote", Type.String())
      .output("optionalCount", Type.Optional(Type.Number()))
      .run(async (ctx) => {
        return ctx.exit({ status: "completed", outputs: { optionalCount: 7 } });
      })
      .compile();
    const parent = defineWorkflow("exit-parent-completed-child")
      .output("childExited", Type.Boolean())
      .output("childStatus", Type.String())
      .output("requiredPresent", Type.Boolean())
      .output("optionalCount", Type.Number())
      .run(async (ctx) => {
        const childResult = await ctx.workflow(child);
        if (childResult.exited === true) {
          return {
            childExited: true,
            childStatus: childResult.status,
            requiredPresent: childResult.outputs.requiredNote !== undefined,
            optionalCount: childResult.outputs.optionalCount ?? -1,
          };
        }
        return {
          childExited: false,
          childStatus: childResult.status,
          requiredPresent: childResult.outputs.requiredNote.length > 0,
          optionalCount: childResult.outputs.optionalCount ?? -1,
        };
      })
      .compile();

    const result = await run(parent, {}, { store, persistence });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, {
      childExited: true,
      childStatus: "completed",
      requiredPresent: false,
      optionalCount: 7,
    });
    const childSnapshot = store.runs().find((runSnapshot) => runSnapshot.name === "exit-child-completed-partial");
    assert.equal(childSnapshot?.status, "completed");
    assert.equal(childSnapshot?.exited, true);
    const boundary = result.stages.find((stage) => stage.name === "workflow:exit-child-completed-partial");
    assert.equal(boundary?.workflowChild?.status, "completed");
    assert.equal(boundary?.workflowChild?.exited, true);
    assert.deepEqual(boundary?.workflowChild?.outputs, { optionalCount: 7 });
    const childRunEnd = entries.find((entry) =>
      entry.type === "workflow.run.end" && entry.payload["runId"] === childSnapshot?.id
    );
    assert.equal(childRunEnd?.payload["status"], "completed");
    assert.equal(childRunEnd?.payload["exited"], true);
    const boundaryEnd = entries.find((entry) =>
      entry.type === "workflow.stage.end" &&
      (entry.payload["workflowChild"] as { workflow?: unknown } | undefined)?.workflow === "exit-child-completed-partial"
    );
    assert.equal((boundaryEnd?.payload["workflowChild"] as { exited?: unknown } | undefined)?.exited, true);
  });

  test("WorkflowChildResult narrows full outputs behind exited === false", () => {
    type ChildOutputs = { readonly requiredNote: string; readonly optionalCount?: number };
    const normal: WorkflowChildResult<ChildOutputs> = {
      workflow: "child",
      runId: "run-normal",
      status: "completed",
      exited: false,
      outputs: { requiredNote: "ready" },
    };
    const exited: WorkflowChildResult<ChildOutputs> = {
      workflow: "child",
      runId: "run-exited",
      status: "completed",
      exited: true,
      outputs: {},
    };

    const assertNarrowing = (child: WorkflowChildResult<ChildOutputs>): void => {
      if (false) {
        // @ts-expect-error unguarded child outputs may be partial when child.exited is true.
        expectString(child.outputs.requiredNote);
      }
      if (child.exited === true) {
        const maybeRequired: string | undefined = child.outputs.requiredNote;
        assert.equal(maybeRequired === undefined || typeof maybeRequired === "string", true);
      } else {
        expectString(child.outputs.requiredNote);
      }
    };

    assertNarrowing(normal);
    assertNarrowing(exited);
  });

  test("non-interactive dispatch returns ctx.exit status, reason, and marker", async () => {
    const store = createStore();
    const jobs = createJobTracker();
    const def = defineWorkflow("headless-exit")
      .output("note", Type.String())
      .run(async (ctx) => {
        return ctx.exit({ status: "skipped", reason: "headless guard", outputs: { note: "ok" } });
      })
      .compile();
    const registry = createRegistry([def]);

    const result = await dispatch(
      { action: "run", workflow: "headless-exit", inputs: {} },
      {
        registry,
        store,
        jobs,
        cancellation: createCancellationRegistry(),
        policy: NON_INTERACTIVE_WORKFLOW_POLICY,
      },
    );

    assert.equal(result.action, "run");
    if (result.action === "run") {
      assert.equal(result.status, "skipped");
      assert.equal(result.exitReason, "headless guard");
      assert.equal(result.exited, true);
      assert.deepEqual(result.result, { note: "ok" });
    }
  });
});
