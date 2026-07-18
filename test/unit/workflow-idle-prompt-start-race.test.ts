import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  _runAgentPrompt,
  prompt,
  sendUserMessage,
} from "../../packages/coding-agent/src/core/agent-session-prompt.js";
import type { InternalStageContext, StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStageContext, makeOpts } from "./stage-runner-helpers.js";

function messageText(messages: AgentMessage | AgentMessage[]): string {
  const message = (Array.isArray(messages) ? messages : [messages]).find((item) => item.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

test("production prompt wiring holds idle admission until the first agent turn starts", async () => {
  const allowPromptStartup = Promise.withResolvers<void>();
  const promptStartupRequested = Promise.withResolvers<void>();
  const firstPromptStarted = Promise.withResolvers<void>();
  const firstTurn = Promise.withResolvers<void>();
  let streaming = false;
  let startupRequests = 0;
  let promptStarts = 0;
  const consumed: string[] = [];
  const followUps: string[] = [];

  const surface = {
    agent: {
      state: { systemPrompt: "base" },
      prompt(messages: AgentMessage | AgentMessage[]) {
        promptStarts += 1;
        if (streaming) return Promise.reject(new Error("duplicate prompt startup"));
        streaming = true;
        consumed.push(messageText(messages));
        firstPromptStarted.resolve();
        return firstTurn.promise.finally(() => { streaming = false; });
      },
    },
    get isStreaming() { return streaming; },
    prompt(text: string, options?: Parameters<typeof prompt>[1]) {
      return prompt.call(surface as never, text, options);
    },
    sendUserMessage(content: Parameters<typeof sendUserMessage>[0], options?: Parameters<typeof sendUserMessage>[1]) {
      return sendUserMessage.call(surface as never, content, options);
    },
    async _runAgentPrompt(messages: AgentMessage | AgentMessage[], started?: () => void) {
      startupRequests += 1;
      promptStartupRequested.resolve();
      await allowPromptStartup.promise;
      await _runAgentPrompt.call(surface as never, messages, started);
    },
    _extensionRunner: {
      hasHandlers: () => false,
      emitBeforeAgentStart: async () => undefined,
    },
    _flushPendingBashMessages() {},
    model: { provider: "test", id: "test" },
    _modelRegistry: { hasConfiguredAuth: () => true },
    _findLastAssistantMessage: () => undefined,
    _pendingNextTurnMessages: [] as AgentMessage[],
    _baseSystemPrompt: "base",
    _baseSystemPromptOptions: {},
    _systemPromptOverride: undefined,
    async waitForRetry() {},
    async _continueQueuedAgentMessages() {},
    async _awaitPendingPostCompactionContinuation() {},
    async _queueFollowUp(text: string) {
      followUps.push(text);
      consumed.push(text);
    },
    async _queueSteer() {},
    promptTemplates: [],
  };

  const runtime = {
    ...surface,
    steer: async () => {},
    followUp: async () => {},
    subscribe: () => () => {},
    sessionFile: undefined,
    sessionId: "race-session",
    setModel: async () => {},
    setThinkingLevel: () => {},
    cycleModel: async () => undefined,
    cycleThinkingLevel: () => undefined,
    thinkingLevel: "off",
    messages: [],
    navigateTree: async () => ({ cancelled: false }),
    compact: async () => undefined,
    abortCompaction: () => {},
    abort: async () => {},
    dispose: () => {},
  } as unknown as StageSessionRuntime;
  Object.defineProperty(runtime, "isStreaming", { get: () => streaming });
  const ctx = createStageContext(makeOpts({
    adapters: { agentSession: { async create() { return runtime; } } },
  })) as InternalStageContext;

  const first = ctx.__sendUserMessage("first");
  const second = ctx.__sendUserMessage("second");
  await promptStartupRequested.promise;
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

  let earlyAdmissionError: Error | undefined;
  try {
    assert.equal(startupRequests, 1);
    assert.equal(promptStarts, 0);
  } catch (error) {
    earlyAdmissionError = error instanceof Error ? error : new Error(String(error));
  }

  allowPromptStartup.resolve();
  await firstPromptStarted.promise;
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  const followUpsBeforeTurnEnd = [...followUps];
  firstTurn.resolve();
  const [firstOutcome, secondOutcome] = await Promise.all([
    Promise.allSettled([first]),
    Promise.allSettled([second]),
  ]);
  if (earlyAdmissionError) throw earlyAdmissionError;

  assert.deepEqual(followUpsBeforeTurnEnd, ["second"]);
  assert.deepEqual(secondOutcome, [{ status: "fulfilled", value: "followUp" }]);
  assert.deepEqual(firstOutcome, [{ status: "fulfilled", value: "prompt" }]);
  assert.equal(promptStarts, 1);
  assert.deepEqual(consumed, ["first", "second"]);
});
