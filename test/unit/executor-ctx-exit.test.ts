import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageContext } from "../../packages/workflows/src/shared/types.js";
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

describe("ctx.exit", () => {
  test("exits a top-level workflow before any stage without failing empty graph validation", async () => {
    const store = createStore();
    const def = workflow({
      name: "exit-top-level",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        return ctx.exit();
      },
    });

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
    const def = workflow({
      name: "exit-helper",
      description: "",
      inputs: {},
      outputs: {
        count: Type.Number(),
        note: Type.String(),
      },
      run: async (ctx) => {
        const helper = (): never => ctx.exit({
          status: "skipped",
          reason: "nothing to process",
          outputs: { count: 0 },
        });
        return helper();
      },
    });

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
    const def = workflow({
      name: "exit-during-parallel",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
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
      },
    });

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
    const def = workflow({
      name: "exit-parallel-queue-halt",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
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
      },
    });

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
    const child = workflow({
      name: "exit-delayed-child",
      description: "",
      inputs: {},
      outputs: {},
      run: async () => ({}),
    });
    const def = workflow({
      name: "exit-delayed-spawn-guards",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
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
      },
    });

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
    const def = workflow({
      name: "exit-retained-stage-gate",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        retainedStage = ctx.stage("retained");
        return ctx.exit({ status: "skipped", reason: "retained gate" });
      },
    });

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
    const child = workflow({
      name: "exit-boundary-child",
      description: "",
      inputs: {
        trigger: Type.String(),
      },
      outputs: {},
      run: async (ctx) => {
        await ctx.task("should-not-run", { prompt: "should not run" });
        return {};
      },
    });
    const def = workflow({
      name: "exit-boundary-before-launch",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
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
      },
    });

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
    const child = workflow({
      name: "exit-inflight-child",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.task("child-slow", { prompt: "child slow" });
        return {};
      },
    });
    const parent = workflow({
      name: "exit-parent-cancels-child",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await Promise.all([
          ctx.workflow(child),
          (async () => {
            await childPromptStarted.promise;
            return ctx.exit({ status: "skipped", reason: "parent gate" });
          })(),
        ]);
        return {};
      },
    });

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

});
