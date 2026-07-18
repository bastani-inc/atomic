import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { _runAgentPrompt } from "../../packages/coding-agent/src/core/agent-session-prompt.js";

describe("AgentSession prompt-start handshake", () => {
  test("reports prompt ownership only after agent.prompt is invoked and before the turn settles", async () => {
    const turn = Promise.withResolvers<void>();
    const events: string[] = [];
    let streaming = false;
    const session = {
      agent: {
        prompt() {
          events.push("agent.prompt");
          streaming = true;
          return turn.promise;
        },
      },
      get isStreaming() { return streaming; },
      async waitForRetry() { events.push("retry-complete"); },
      async _continueQueuedAgentMessages() { events.push("queues-complete"); },
      async _awaitPendingPostCompactionContinuation() { events.push("compaction-complete"); },
      _systemPromptOverride: "override" as string | undefined,
    };

    const running = _runAgentPrompt.call(session as never, [], () => events.push("prompt-started"));

    assert.deepEqual(events, ["agent.prompt", "prompt-started"]);
    assert.equal(session._systemPromptOverride, "override");

    turn.resolve();
    await running;
    assert.deepEqual(events, [
      "agent.prompt",
      "prompt-started",
      "retry-complete",
      "queues-complete",
      "compaction-complete",
    ]);
    assert.equal(session._systemPromptOverride, undefined);
  });

  test("does not report prompt ownership when agent.prompt throws synchronously", async () => {
    let promptStarted = false;
    const session = {
      agent: { prompt() { throw new Error("startup failed"); } },
      isStreaming: false,
      async waitForRetry() {},
      async _continueQueuedAgentMessages() {},
      async _awaitPendingPostCompactionContinuation() {},
      _systemPromptOverride: "override" as string | undefined,
    };

    await assert.rejects(
      _runAgentPrompt.call(session as never, [], () => { promptStarted = true; }),
      /startup failed/,
    );
    assert.equal(promptStarted, false);
    assert.equal(session._systemPromptOverride, undefined);
  });

  test("does not report prompt ownership when startup rejects before streaming", async () => {
    let promptStarted = false;
    const session = {
      agent: { prompt: () => Promise.reject(new Error("startup rejected")) },
      isStreaming: false,
      async waitForRetry() {},
      async _continueQueuedAgentMessages() {},
      async _awaitPendingPostCompactionContinuation() {},
      _systemPromptOverride: "override" as string | undefined,
    };

    await assert.rejects(
      _runAgentPrompt.call(session as never, [], () => { promptStarted = true; }),
      /startup rejected/,
    );
    assert.equal(promptStarted, false);
    assert.equal(session._systemPromptOverride, undefined);
  });
});
