import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { registerCompletedStageIntercomAskRouter } from "../../packages/workflows/src/extension/completed-stage-intercom-ask.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { ensurePostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageAdapters, StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowRuntimeConfig } from "../../packages/workflows/src/shared/types.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterSlot } from "../../packages/intercom/reply-waiter.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const config: WorkflowRuntimeConfig = {
  maxDepth: 4,
  defaultConcurrency: 2,
  persistRuns: false,
  statusFile: false,
  resumeInFlight: "never",
};

function session(
  sessionId: string,
  promptImpl: (text: string) => Promise<string>,
): StageSessionRuntime {
  let lastAssistantText: string | undefined;
  return {
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    isStreaming: false,
    messages: [],
    agent: Object.create(null) as StageSessionRuntime["agent"],
    model: undefined,
    thinkingLevel: "off",
    async prompt(text: string) { lastAssistantText = await promptImpl(text); return lastAssistantText; },
    async steer() {},
    async followUp() {},
    subscribe() { return () => {}; },
    async setModel() {},
    setThinkingLevel() {},
    async cycleModel() { return undefined; },
    cycleThinkingLevel() { return undefined; },
    async navigateTree() { return { cancelled: true }; },
    async compact() { throw new Error("not used"); },
    abortCompaction() {},
    async abort() {},
    dispose() {},
    getLastAssistantText() { return lastAssistantText; },
  };
}

async function waitForCompletedStage(store: ReturnType<typeof createStore>, name: string): Promise<{ runId: string; stageId: string }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    for (const currentRun of store.runs()) {
      const stage = currentRun.stages.find((candidate) => candidate.name === name && candidate.status === "completed");
      if (stage) return { runId: currentRun.id, stageId: stage.id };
    }
    await Bun.sleep(2);
  }
  throw new Error(`stage ${name} did not complete`);
}

test("parallel workflow revives completed A for B's exact correlated ask and terminates normally", async () => {
  const store = createStore();
  const registry = createStageControlRegistry();
  const events = new EventEmitter();
  const targetTracker = new ReplyTracker();
  const callerWaiter = new ReplyWaiterSlot();
  const wrongReplyAttempts: boolean[] = [];
  const postMortemPrompts: string[] = [];
  const target: SessionInfo = {
    id: "stage-a-session", name: "A", cwd: "/repo", model: "test",
    pid: 1, startedAt: 1, lastActivity: 1, status: "idle",
  };
  const caller: SessionInfo = {
    id: "stage-b-session", name: "B", cwd: "/repo", model: "test",
    pid: 2, startedAt: 1, lastActivity: 1, status: "thinking",
  };

  const adapters: StageAdapters = {
    agentSession: {
      async create(_options, meta) {
        assert.ok(meta);
        if (meta.stageName === "A") {
          return session(target.id, async (text) => {
            if (text === "A completes first") return "A initial result";
            postMortemPrompts.push(text);
            targetTracker.beginTurn();
            const pending = targetTracker.resolveReplyTarget({});
            const waiter = callerWaiter.current();
            assert.ok(waiter);
            wrongReplyAttempts.push(routeIncomingReply(waiter, {
              ...target,
              id: "parent-session",
              name: "parent",
            }, {
              id: "parent-reply",
              timestamp: Date.now(),
              replyTo: pending.message.id,
              content: { text: "must not resolve" },
            }));
            const reply: Message = {
              id: "stage-a-reply",
              timestamp: Date.now(),
              replyTo: pending.message.id,
              content: { text: `A exact answer: ${pending.message.content.text}` },
            };
            assert.equal(routeIncomingReply(waiter, target, reply), true);
            targetTracker.markReplied(pending.message.id);
            targetTracker.endTurn();
            return "A post-mortem reply sent";
          });
        }
        return session(caller.id, async () => {
          const completed = await waitForCompletedStage(store, "A");
          const ask: Message = {
            id: "ask-b-to-a",
            timestamp: Date.now(),
            expectsReply: true,
            content: { text: "return your final summary verbatim" },
          };
          const admission = callerWaiter.begin(target.id, ask.id);
          assert.equal(admission.ok, true);
          const context = targetTracker.recordIncomingMessage(caller, ask);
          targetTracker.queueTurnContext(context);
          const payload: {
            handled: boolean;
            completion?: Promise<void>;
            batch: boolean;
            workflowRunId: string;
            workflowStageId: string;
            messages: Array<{
              customType: "intercom_message";
              content: string;
              display: boolean;
              details: { from: SessionInfo; message: Message; bodyText: string };
            }>;
          } = {
            handled: false,
            batch: false,
            workflowRunId: completed.runId,
            workflowStageId: completed.stageId,
            messages: [{
              customType: "intercom_message",
              content: "**📨 From B** (/repo)\n\nreturn your final summary verbatim",
              display: true,
              details: { from: caller, message: ask, bodyText: ask.content.text },
            }],
          };
          events.emit("atomic:workflow-stage-late-message", payload);
          assert.equal(payload.handled, true);
          const reply = await admission.wait.promise;
          await payload.completion!;
          return reply.content.text;
        });
      },
    },
  };

  registerCompletedStageIntercomAskRouter({
    events: {
      on(name, listener) { events.on(name, listener); return () => events.off(name, listener); },
    },
  }, (runId, stageId) => {
    const stage = store.runs().find((candidate) => candidate.id === runId)?.stages.find((candidate) => candidate.id === stageId);
    if (!stage) return undefined;
    return ensurePostMortemStageHandle(runId, stage, { registry, adapters });
  });

  const fixture = workflow({
    name: "completed-stage-intercom-reproduction",
    description: "Reproduces #1854 with parallel stages.",
    inputs: {},
    outputs: { reply: Type.String() },
    run: async (ctx) => {
      const [, b] = await ctx.parallel([
        { name: "A", prompt: "A completes first" },
        { name: "B", prompt: "Wait for A, then ask A" },
      ]);
      return { reply: b.text };
    },
  });

  const result = await run(fixture, {}, { store, adapters, config, stageControlRegistry: registry });
  assert.equal(result.status, "completed");
  assert.equal(result.result?.reply, "A exact answer: return your final summary verbatim");
  assert.deepEqual(wrongReplyAttempts, [false], "parent/unrelated session cannot satisfy B's child-to-child ask");
  assert.deepEqual(postMortemPrompts, ["**📨 From B** (/repo)\n\nreturn your final summary verbatim"]);
  assert.equal(callerWaiter.has(), false);
  assert.equal(targetTracker.listPending().length, 0);
  assert.deepEqual(result.stages.filter((stage) => stage.name === "A").map((stage) => stage.status), ["completed"]);
});
