import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { sendStageUserMessage } from "../../packages/workflows/src/runs/foreground/stage-runner-send-user-message.js";
import type {
  AgentSessionAdapter as PublicAgentSessionAdapter,
  StageSessionRuntime as PublicStageSessionRuntime,
} from "../../packages/workflows/src/authoring.js";
import type { InternalStageContext, StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageSessionEvent, StageUserMessageDeliveryAction } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createStageContext, flushMicrotasks, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

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

  test("retains public agent_start ownership while isStreaming publication lags", async () => {
    const allowPromptStart = Promise.withResolvers<void>();
    const promptStarted = Promise.withResolvers<void>();
    const firstTurn = Promise.withResolvers<void>();
    let streaming = false;
    let promptStarts = 0;
    let secondSettled = false;
    const consumed: string[] = [];
    const listeners = new Set<(event: StageSessionEvent) => void>();
    const { session } = makeMockSession({
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt(text) {
        await allowPromptStart.promise;
        promptStarts += 1;
        consumed.push(text);
        for (const listener of listeners) listener({ type: "agent_start" });
        promptStarted.resolve();
        await flushMicrotasks();
        streaming = true;
        await firstTurn.promise;
        for (const listener of listeners) listener({ type: "agent_end", messages: [] });
        streaming = false;
      },
      async followUp(text) { consumed.push(text); },
    });
    Object.defineProperty(session, "isStreaming", { get: () => streaming });
    const adapter = {
      async create() { return session as unknown as PublicStageSessionRuntime; },
    } satisfies PublicAgentSessionAdapter;
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: adapter as never },
    })) as InternalStageContext;

    const first = ctx.__sendUserMessage("first");
    const second = ctx.__sendUserMessage("second");
    void second.then(() => { secondSettled = true; });
    allowPromptStart.resolve();
    await promptStarted.promise;
    await flushMicrotasks();
    const settledBeforeTurnEnd = secondSettled;

    firstTurn.resolve();
    const outcomes = await Promise.all([first, second]);

    assert.equal(settledBeforeTurnEnd, true);
    assert.deepEqual(outcomes, ["prompt", "followUp"]);
    assert.equal(promptStarts, 1);
    assert.deepEqual(consumed, ["first", "second"]);
  });

  test("correlates late public ends without clearing a newer owned generation", async () => {
    const firstTurn = Promise.withResolvers<void>();
    const secondTurn = Promise.withResolvers<void>();
    const fourthTurn = Promise.withResolvers<void>();
    const promptStarted = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const consumed: string[] = [];
    let promptStarts = 0;
    const tracked = listenerTrackingSession({
      async prompt(text) {
        const index = promptStarts++;
        consumed.push(text);
        tracked.emit({ type: "agent_start" });
        promptStarted[index]?.resolve();
        if (index === 0) await firstTurn.promise;
        else if (index === 1) await secondTurn.promise;
        else await fourthTurn.promise;
      },
      async followUp(text) { consumed.push(text); },
    });
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: { async create() { return tracked.session; } } },
    })) as InternalStageContext;

    const first = ctx.__sendUserMessage("first");
    await promptStarted[0]!.promise;
    firstTurn.resolve();
    assert.equal(await first, "prompt");

    const second = ctx.__sendUserMessage("second");
    await promptStarted[1]!.promise;
    tracked.emit({ type: "agent_end", messages: [] });
    assert.equal(await ctx.__sendUserMessage("third"), "followUp");

    tracked.emit({ type: "agent_end", messages: [] });
    secondTurn.resolve();
    assert.equal(await second, "prompt");
    const fourth = ctx.__sendUserMessage("fourth");
    await promptStarted[2]!.promise;
    tracked.emit({ type: "agent_end", messages: [] });
    fourthTurn.resolve();

    assert.equal(await fourth, "prompt");
    assert.equal(promptStarts, 3);
    assert.deepEqual(consumed, ["first", "second", "third", "fourth"]);
  });

  test("routes three or more concurrent idle sends exactly once after public ownership", async () => {
    const turn = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const consumed: string[] = [];
    let promptStarts = 0;
    const tracked = listenerTrackingSession({
      async prompt(text) {
        promptStarts += 1;
        consumed.push(text);
        tracked.emit({ type: "agent_start" });
        started.resolve();
        await turn.promise;
        tracked.emit({ type: "agent_end", messages: [] });
      },
      async followUp(text) { consumed.push(text); },
      async steer(text) { consumed.push(text); },
    });
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: { async create() { return tracked.session; } } },
    })) as InternalStageContext;

    const deliveries = [
      ctx.__sendUserMessage("one"),
      ctx.__sendUserMessage("two"),
      ctx.__sendUserMessage("three"),
      ctx.__sendUserMessage("four", { deliverAs: "steer" }),
    ];
    await started.promise;
    const queuedOutcomes = await Promise.all(deliveries.slice(1));

    assert.deepEqual(queuedOutcomes, ["followUp", "followUp", "steer"]);
    assert.equal(promptStarts, 1);
    assert.deepEqual(consumed, ["one", "two", "three", "four"]);

    turn.resolve();
    assert.equal(await deliveries[0], "prompt");
  });

  test("does not retain logical ownership for a handled no-turn delivery", async () => {
    const turn = Promise.withResolvers<void>();
    let calls = 0;
    let promptStarts = 0;
    const tracked = listenerTrackingSession({
      async sendUserMessage(_content, options) {
        calls += 1;
        if (calls === 1) {
          options?.__workflowDelivery?.delivered?.("handled");
          return;
        }
        promptStarts += 1;
        tracked.emit({ type: "agent_start" });
        options?.__workflowDelivery?.delivered?.("prompt");
        await turn.promise;
        tracked.emit({ type: "agent_end", messages: [] });
      },
    });
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: { async create() { return tracked.session; } } },
    })) as InternalStageContext;

    assert.equal(await ctx.__sendUserMessage("handled"), "handled");
    const prompted = ctx.__sendUserMessage("next");
    await flushMicrotasks();
    assert.equal(promptStarts, 1);
    turn.resolve();
    assert.equal(await prompted, "prompt");
  });

  test("treats bundled private and public start signals as one owned generation", async () => {
    const turn = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const actions: StageUserMessageDeliveryAction[] = [];
    let promptStarts = 0;
    const tracked = listenerTrackingSession({
      async sendUserMessage(_content, options) {
        const action = options?.deliverAs ?? "prompt";
        actions.push(action);
        options?.__workflowDelivery?.delivered?.(action);
        if (action !== "prompt") return;
        promptStarts += 1;
        options?.__workflowDelivery?.promptStarted?.();
        tracked.emit({ type: "agent_start" });
        started.resolve();
        await turn.promise;
        tracked.emit({ type: "agent_end", messages: [] });
      },
    });
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: { async create() { return tracked.session; } } },
    })) as InternalStageContext;

    const first = ctx.__sendUserMessage("first");
    const second = ctx.__sendUserMessage("second");
    await started.promise;

    assert.equal(await second, "followUp");
    assert.equal(promptStarts, 1);
    assert.deepEqual(actions, ["prompt", "followUp"]);

    turn.resolve();
    assert.equal(await first, "prompt");
  });

  test("clears an owned generation on abort without letting its late end clear the next", async () => {
    const firstTurn = Promise.withResolvers<void>();
    const secondTurn = Promise.withResolvers<void>();
    const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const consumed: string[] = [];
    let promptStarts = 0;
    const tracked = listenerTrackingSession({
      async prompt(text) {
        const index = promptStarts++;
        consumed.push(text);
        tracked.emit({ type: "agent_start" });
        started[index]?.resolve();
        if (index === 0) await firstTurn.promise;
        else await secondTurn.promise;
      },
      async followUp(text) { consumed.push(text); },
      async abort() { firstTurn.reject(new DOMException("adapter aborted", "AbortError")); },
    });
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: { async create() { return tracked.session; } } },
    })) as InternalStageContext;

    const aborted = ctx.__sendUserMessage("aborted");
    await started[0]!.promise;
    await ctx.abort();
    await assert.rejects(aborted, /adapter aborted/);

    const next = ctx.__sendUserMessage("next");
    await started[1]!.promise;
    tracked.emit({ type: "agent_end", messages: [] });
    assert.equal(await ctx.__sendUserMessage("during next"), "followUp");

    tracked.emit({ type: "agent_end", messages: [] });
    secondTurn.resolve();
    assert.equal(await next, "prompt");
    assert.equal(promptStarts, 2);
    assert.deepEqual(consumed, ["aborted", "next", "during next"]);
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

  test("startup rejection clears coordinated admission for the queued delivery", async () => {
    let calls = 0;
    const tracked = listenerTrackingSession({
      async sendUserMessage(_content, options) {
        calls += 1;
        if (calls === 1) throw new Error("startup rejected");
        options?.__workflowDelivery?.delivered?.("prompt");
      },
    });
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: { async create() { return tracked.session; } } },
    })) as InternalStageContext;

    const rejected = ctx.__sendUserMessage("rejected");
    const next = ctx.__sendUserMessage("next");

    await assert.rejects(rejected, /startup rejected/);
    assert.equal(await next, "prompt");
    assert.equal(calls, 2);
  });

  test("ordinary failure after ownership cannot clear the next generation", async () => {
    const failedTurn = Promise.withResolvers<void>();
    const nextTurn = Promise.withResolvers<void>();
    const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let promptStarts = 0;
    const tracked = listenerTrackingSession({
      async prompt() {
        const index = promptStarts++;
        tracked.emit({ type: "agent_start" });
        started[index]?.resolve();
        if (index === 0) await failedTurn.promise;
        else await nextTurn.promise;
      },
    });
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: { async create() { return tracked.session; } } },
    })) as InternalStageContext;

    const failed = ctx.__sendUserMessage("failed");
    await started[0]!.promise;
    failedTurn.reject(new Error("turn failed"));
    await assert.rejects(failed, /turn failed/);

    const next = ctx.__sendUserMessage("next");
    await started[1]!.promise;
    tracked.emit({ type: "agent_end", messages: [] });
    assert.equal(await ctx.__sendUserMessage("during next"), "followUp");
    tracked.emit({ type: "agent_end", messages: [] });
    nextTurn.resolve();

    assert.equal(await next, "prompt");
    assert.equal(promptStarts, 2);
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
