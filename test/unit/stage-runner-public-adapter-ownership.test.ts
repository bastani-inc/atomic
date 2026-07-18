import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { sendStageUserMessage } from "../../packages/workflows/src/runs/foreground/stage-runner-send-user-message.js";
import type { InternalStageContext, StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageSessionEvent } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

function listenerTrackingSession(overrides: Partial<StageSessionRuntime>): {
  session: StageSessionRuntime;
  emit: (event: StageSessionEvent) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const { session } = makeMockSession({
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...overrides,
  });
  return {
    session,
    emit(event) { for (const listener of listeners) listener(event); },
    listenerCount: () => listeners.size,
  };
}

describe("public AgentSessionAdapter prompt ownership", () => {
  test("falls back to a synchronous public isStreaming transition without polling", async () => {
    const firstTurn = Promise.withResolvers<void>();
    let streaming = false;
    let promptStarts = 0;
    const consumed: string[] = [];
    const { session } = makeMockSession({
      async sendUserMessage(content) {
        if (typeof content !== "string") throw new Error("expected text");
        if (streaming) {
          consumed.push(content);
          return;
        }
        promptStarts += 1;
        streaming = true;
        consumed.push(content);
        await firstTurn.promise;
        streaming = false;
      },
    });
    Object.defineProperty(session, "isStreaming", { get: () => streaming });
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: { async create() { return session; } } },
    })) as InternalStageContext;

    const first = ctx.__sendUserMessage("first");
    const second = ctx.__sendUserMessage("second");

    assert.equal(await second, "followUp");
    assert.equal(streaming, true);
    assert.equal(promptStarts, 1);
    assert.deepEqual(consumed, ["first", "second"]);

    firstTurn.resolve();
    assert.equal(await first, "prompt");
  });

  test("deduplicates private and public ownership signals", async () => {
    let streaming = false;
    let ownershipSignals = 0;
    let emit: (event: StageSessionEvent) => void = () => {};
    const tracked = listenerTrackingSession({
      async sendUserMessage(_content, options) {
        streaming = true;
        options?.__workflowDelivery?.promptStarted?.();
        emit({ type: "agent_start" });
        options?.__workflowDelivery?.delivered?.("prompt");
      },
    });
    emit = tracked.emit;
    Object.defineProperty(tracked.session, "isStreaming", { get: () => streaming });

    assert.equal(
      await sendStageUserMessage(tracked.session, "message", undefined, undefined, () => { ownershipSignals += 1; }),
      "prompt",
    );
    assert.equal(ownershipSignals, 1);
    assert.equal(tracked.listenerCount(), 0);
  });

  test("cleans the public listener after handled delivery and startup rejection", async () => {
    const handled = listenerTrackingSession({
      async sendUserMessage(_content, options) {
        options?.__workflowDelivery?.delivered?.("handled");
      },
    });
    assert.equal(await sendStageUserMessage(handled.session, "handled"), "handled");
    assert.equal(handled.listenerCount(), 0);

    const rejected = listenerTrackingSession({
      async sendUserMessage() { throw new Error("startup rejected"); },
    });
    await assert.rejects(sendStageUserMessage(rejected.session, "rejected"), /startup rejected/);
    assert.equal(rejected.listenerCount(), 0);
  });

  test("abort before ownership releases admission and removes the public listener", async () => {
    const startup = Promise.withResolvers<void>();
    let calls = 0;
    let rejectStartup: ((error: Error) => void) | undefined;
    const tracked = listenerTrackingSession({
      sendUserMessage(_content, options) {
        calls += 1;
        if (calls > 1) {
          options?.__workflowDelivery?.delivered?.("prompt");
          return Promise.resolve();
        }
        startup.resolve();
        return new Promise<void>((_resolve, reject) => { rejectStartup = reject; });
      },
      async abort() { rejectStartup?.(new DOMException("adapter aborted", "AbortError")); },
    });
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: { async create() { return tracked.session; } } },
    })) as InternalStageContext;
    await ctx.__ensureSession();
    const baselineListeners = tracked.listenerCount();

    const aborted = ctx.__sendUserMessage("aborted");
    const next = ctx.__sendUserMessage("next");
    await startup.promise;
    await ctx.abort();

    await assert.rejects(aborted, /adapter aborted/);
    assert.equal(await next, "prompt");
    assert.equal(calls, 2);
    assert.equal(tracked.listenerCount(), baselineListeners);
  });
});
