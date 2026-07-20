import { describe } from "bun:test";
import {
  assert,
  createStageControlRegistry,
  createStore,
  deferred,
  mockSession,
  run,
  test,
  waitForMicrotasks,
  waitForPromptCall,
  workflow,
  type StageSessionRuntime,
} from "./executor-shared.js";

function idleStageChatSession(promptCalls: string[]): StageSessionRuntime {
  type Listener = Parameters<StageSessionRuntime["subscribe"]>[0];
  const listeners = new Set<Listener>();
  const emit = (event: Parameters<Listener>[0]): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    ...mockSession(),
    get isStreaming() { return false; },
    async prompt(text: string) {
      promptCalls.push(text);
      if (text === "initial") {
        emit({ type: "tool_execution_start", toolCallId: "question-1", toolName: "ask_user_question" } as Parameters<Listener>[0]);
        emit({ type: "tool_execution_end", toolCallId: "question-1", toolName: "ask_user_question" } as Parameters<Listener>[0]);
      }
      emit({ type: "agent_end", messages: [] } as Parameters<Listener>[0]);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

async function startIdleStageChat(name: string): Promise<{
  readonly runPromise: ReturnType<typeof run>;
  readonly handle: NonNullable<ReturnType<ReturnType<typeof createStageControlRegistry>["get"]>>;
  readonly promptCalls: string[];
}> {
  const registry = createStageControlRegistry();
  const active = deferred<{ runId: string; stageId: string }>();
  const waiting = deferred();
  const promptCalls: string[] = [];
  const def = workflow({
    name,
    description: "",
    inputs: {},
    outputs: {},
    run: async (ctx) => {
      await ctx.stage("chat").prompt("initial");
      return {};
    },
  });
  const runPromise = run(def, {}, {
    adapters: { agentSession: { async create() { return idleStageChatSession(promptCalls); } } },
    store: createStore(),
    stageControlRegistry: registry,
    onStageStart(runId, stage) {
      if (stage.name === "chat") active.resolve({ runId, stageId: stage.id });
    },
    confirmStageReadiness: async () => {
      waiting.resolve();
      return false;
    },
  });
  const { runId, stageId } = await active.promise;
  await waiting.promise;
  const handle = registry.get(runId, stageId);
  assert.ok(handle);
  assert.equal(handle.isStreaming, false);
  return { runPromise, handle, promptCalls };
}

describe("executor — paused idle stage-chat resume", () => {
  test("resume(message) starts exactly one prompt containing the message", async () => {
    const { runPromise, handle, promptCalls } = await startIdleStageChat("idle-chat-resume-message");

    await handle.pause();
    assert.equal(handle.status, "paused");
    await handle.resume("approved — continue");
    await waitForPromptCall(promptCalls, "approved — continue");

    const result = await runPromise;
    assert.equal(result.status, "completed");
    assert.deepEqual(promptCalls, ["initial", "approved — continue"]);
  });

  test("resume() without a message does not fabricate a prompt", async () => {
    const { runPromise, handle, promptCalls } = await startIdleStageChat("idle-chat-resume-empty");

    await handle.pause();
    await handle.resume();
    await waitForMicrotasks();
    assert.deepEqual(promptCalls, ["initial"]);

    await handle.prompt("finish later");
    const result = await runPromise;
    assert.equal(result.status, "completed");
    assert.deepEqual(promptCalls, ["initial", "finish later"]);
  });

  test("resume(whitespace) treats the empty text as no message", async () => {
    const { runPromise, handle, promptCalls } = await startIdleStageChat("idle-chat-resume-whitespace");

    await handle.pause();
    await handle.resume("   ");
    await waitForMicrotasks();
    assert.deepEqual(promptCalls, ["initial"]);

    await handle.prompt("finish after whitespace");
    const result = await runPromise;
    assert.equal(result.status, "completed");
    assert.deepEqual(promptCalls, ["initial", "finish after whitespace"]);
  });
});
