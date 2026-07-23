import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { InboundIdleQueue } from "../../packages/intercom/inbound-idle-queue.js";
import { registerSubagentRelay } from "../../packages/intercom/subagent-relay.js";
import { ReplyWaiterSlot } from "../../packages/intercom/reply-waiter.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import {
  emitGlobalTerminalOrderingBarrier,
  registerTerminalOrderingBarrier,
  SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT,
} from "../../packages/intercom/terminal-ordering-barrier.js";
import registerSubagentNotify from "../../packages/subagents/src/runs/background/notify.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../packages/subagents/src/shared/types.js";
import type { InboundMessageEntry } from "../../packages/intercom/intercom-utils.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

function source(id: string, name: string): SessionInfo {
  return { id, name, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
}

function entry(from: SessionInfo, id: string, timestamp: number): InboundMessageEntry {
  const message: Message = { id, timestamp, content: { text: id } };
  return { from, message, bodyText: id };
}

function eventHarness() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const deliveries: string[] = [];
  const sentOptions: Array<Record<string, unknown> | undefined> = [];
  const pi = {
    events: {
      on(event: string, handler: (data: unknown) => void) {
        const handlers = listeners.get(event) ?? new Set();
        handlers.add(handler);
        listeners.set(event, handlers);
        return () => handlers.delete(handler);
      },
      emit(event: string, payload: unknown) {
        for (const handler of listeners.get(event) ?? []) handler(payload);
      },
    },
    sendMessage(message: { customType: string }, options?: Record<string, unknown>) {
      deliveries.push(message.customType);
      sentOptions.push(options);
    },
    sendMessages(messages: Array<{ customType: string }>, options?: Record<string, unknown>) {
      deliveries.push(...messages.map((message) => message.customType));
      sentOptions.push(options);
    },
    appendEntry() {},
  };
  return { pi, deliveries, sentOptions };
}

describe("per-child terminal ordering barrier", () => {
  test("drains accepted child messages before pause while leaving another child queued", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const pausedChild = source("session-paused", "subagent-worker-run-1802-1");
    const otherChild = source("session-other", "subagent-reviewer-run-other-1");
    queue.enqueue(entry(pausedChild, "Ready…", 100));
    queue.enqueue(entry(otherChild, "Unrelated", 101));
    queue.enqueue(entry(pausedChild, "Still ready", 102));
    const barriers: unknown[] = [];
    harness.pi.events.on(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, (value) => barriers.push(value));
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });
    registerSubagentNotify(harness.pi as never);

    harness.pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "run-1802", runId: "run-1802", agent: "worker", success: false,
      state: "paused", summary: "Paused after interrupt.", timestamp: 200,
      results: [{ agent: "worker", intercomTarget: pausedChild.name }],
    });

    assert.deepEqual(harness.deliveries, ["Ready…", "Still ready", "subagent-notify"]);
    const [{ dispatch, ...barrier }] = barriers as Array<Record<string, unknown>>;
    assert.equal(typeof dispatch, "function");
    assert.deepEqual(barrier, {
      runId: "run-1802", terminalAt: 200, source: "background-notify",
      sourceSessionTargets: [pausedChild.name],
    });
    assert.deepEqual(queue.drain().map((queued) => queued.message.id), ["Unrelated"]);
  });

  test("completion and failure drain their own FIFO messages without drops", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });
    registerSubagentNotify(harness.pi as never);

    for (const [runId, success] of [["completed-run", true], ["failed-run", false]] as const) {
      const target = `subagent-worker-${runId}-1`;
      queue.enqueue(entry(source(`session-${runId}`, target), `${runId}-first`, 10));
      queue.enqueue(entry(source(`session-${runId}`, target), `${runId}-second`, 11));
      harness.pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: runId, runId, agent: "worker", success,
        summary: success ? "done" : "failed", timestamp: 20,
        results: [{ agent: "worker", intercomTarget: target }],
      });
    }

    assert.deepEqual(harness.deliveries, [
      "completed-run-first", "completed-run-second", "subagent-notify",
      "failed-run-first", "failed-run-second", "subagent-notify",
    ]);
    assert.equal(queue.size, 0);
    assert.deepEqual(harness.sentOptions, [
      { triggerTurn: true, stageAdmissionKey: "subagent:run:completed-run" },
      { triggerTurn: true, stageAdmissionKey: "subagent:run:failed-run" },
    ]);
  });

  test("completion derives a target when optional result target metadata is omitted", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("fallback-session", "subagent-worker-fallback-run-1");
    queue.enqueue(entry(child, "fallback message", 1));
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });
    registerSubagentNotify(harness.pi as never);

    harness.pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      id: "fallback-run", agent: "worker", success: true, summary: "done", timestamp: 2,
    });

    assert.deepEqual(harness.deliveries, ["fallback message", "subagent-notify"]);
  });

  test("duplicate child aliases are isolated by broker session and source run metadata", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const alias = "subagent-worker-shared-1";
    const wanted = entry(source("session-wanted", alias), "wanted", 1);
    wanted.message.source = { subagentRunId: "wanted-run", subagentAgent: "worker", subagentIndex: 0 };
    const unrelated = entry(source("session-unrelated", alias), "unrelated", 2);
    unrelated.message.source = { subagentRunId: "other-run", subagentAgent: "worker", subagentIndex: 0 };
    queue.enqueue(wanted);
    queue.enqueue(unrelated);
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });

    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
      runId: "wanted-run", terminalAt: 3, source: "background-notify",
      sourceSessionTargets: [alias],
    });

    assert.deepEqual(harness.deliveries, ["wanted"]);
    assert.deepEqual(queue.drain().map((queued) => queued.message.id), ["unrelated"]);
  });

  test("deduplicates successful empty terminal dispatch across event and global paths", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    let dispatches = 0;
    const unregister = registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      toMessage: (queued) => ({
        customType: "intercom_message",
        content: queued.bodyText,
        display: true,
        details: queued,
      }),
      deliver: () => {},
    });
    const barrier = {
      runId: "empty-run",
      terminalId: "empty-terminal",
      terminalAt: 1,
      source: "background-notify" as const,
      sourceSessionTargets: ["empty-target"],
      dispatch(prefix: unknown[]) {
        assert.deepEqual(prefix, []);
        dispatches++;
      },
    };

    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, barrier);
    emitGlobalTerminalOrderingBarrier(barrier);
    unregister();

    assert.equal(dispatches, 1);
  });

  test("leaves a failed empty terminal dispatch retryable", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    let attempts = 0;
    const unregister = registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      toMessage: (queued) => ({
        customType: "intercom_message",
        content: queued.bodyText,
        display: true,
        details: queued,
      }),
      deliver: () => {},
    });
    const barrier = {
      runId: "retry-empty-run",
      terminalId: "retry-empty-terminal",
      terminalAt: 1,
      source: "result-relay" as const,
      sourceSessionTargets: ["retry-empty-target"],
      dispatch() {
        attempts++;
        if (attempts === 1) throw new Error("injected empty terminal failure");
      },
    };

    assert.throws(
      () => harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, barrier),
      /injected empty terminal failure/,
    );
    emitGlobalTerminalOrderingBarrier(barrier);

    assert.equal(attempts, 2);
    unregister();
  });

  test("dispatches distinct empty lifecycle terminals for the same resumed run", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const dispatched: string[] = [];
    const unregister = registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      toMessage: (queued) => ({
        customType: "intercom_message",
        content: queued.bodyText,
        display: true,
        details: queued,
      }),
      deliver: () => {},
    });
    const emitTerminal = (terminalId: string) => {
      harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
        runId: "resumed-empty-run",
        terminalId,
        terminalAt: terminalId === "pause" ? 1 : 2,
        source: "background-notify",
        sourceSessionTargets: ["resumed-empty-target"],
        dispatch: () => dispatched.push(terminalId),
      });
    };

    emitTerminal("pause");
    emitTerminal("pause");
    emitTerminal("completion");

    assert.deepEqual(dispatched, ["pause", "completion"]);
    unregister();
  });

  test("cross-path duplicate barriers cannot claim post-terminal messages", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("exact-session", "exact-target");
    queue.enqueue(entry(child, "one", 1));
    queue.enqueue(entry(child, "two", 2));
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });
    const relayBarrier = {
      runId: "exact-run", terminalId: "terminal-1", terminalAt: 3, source: "result-relay",
      sourceSessionTargets: [child.id, child.id],
    };
    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, relayBarrier);
    queue.enqueue(entry(child, "post-terminal", 4));
    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
      ...relayBarrier, source: "background-notify",
    });

    assert.deepEqual(harness.deliveries, ["one", "two"]);
    assert.deepEqual(queue.drain().map((queued) => queued.message.id), ["post-terminal"]);
  });

  test("a second terminal path can claim a late-arriving pre-terminal message", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("late-session", "late-target");
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });
    const barrier = {
      runId: "late-run", terminalId: "same-terminal", terminalAt: 10,
      source: "result-relay", sourceSessionTargets: [child.name],
    } as const;

    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, barrier);
    queue.enqueue(entry(child, "accepted-before-terminal", 9));
    queue.enqueue(entry(child, "after-terminal", 11));
    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
      ...barrier, source: "background-notify",
    });

    assert.deepEqual(harness.deliveries, ["accepted-before-terminal"]);
    assert.deepEqual(queue.drain().map((queued) => queued.message.id), ["after-terminal"]);
  });

  test("a later terminal event for a resumed run drains newly queued messages", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("resumed-session", "resumed-target");
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });

    queue.enqueue(entry(child, "ready", 1));
    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
      runId: "resumed-run", terminalId: "pause-event", terminalAt: 2,
      source: "background-notify", sourceSessionTargets: [child.name],
    });
    queue.enqueue(entry(child, "almost-done", 10));
    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
      runId: "resumed-run", terminalId: "completion-event", terminalAt: 20,
      source: "background-notify", sourceSessionTargets: [child.name],
    });

    assert.deepEqual(harness.deliveries, ["ready", "almost-done"]);
    assert.equal(queue.size, 0);
  });

  test("result relay derives run child targets before direct result delivery", async () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("relay-session", "subagent-worker-relay-run-1");
    queue.enqueue(entry(child, "Ready from relay", 1));
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });
    registerSubagentRelay(harness.pi as never, {
      runtimeGeneration: () => 1,
      runtimeStarted: () => false,
      runtimeContext: () => null,
      getLiveContext: () => null,
      currentSessionTargetMatches: () => true,
      sendIncomingMessage: () => harness.deliveries.push("subagent-result"),
      ensureConnected: async () => { throw new Error("not used"); },
      resolveSessionTarget: async () => null,
    });

    harness.pi.events.emit("subagent:result-intercom", {
      to: "parent", message: "terminal result", requestId: "relay-result",
      runId: "relay-run", children: [{ agent: "worker", index: 0, intercomTarget: "" }],
    });
    await Bun.sleep(0);

    assert.deepEqual(harness.deliveries, ["Ready from relay", "subagent-result"]);
  });

  test("a failed direct delivery restores undelivered entries at original positions", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("retry-session", "retry-target");
    const unrelated = source("unrelated-session", "other-target");
    queue.enqueue(entry(child, "first", 1));
    queue.enqueue(entry(unrelated, "unrelated", 2));
    queue.enqueue(entry(child, "second", 3));
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => {
        if (queued.message.id === "second") throw new Error("injected send failure");
        harness.deliveries.push(queued.message.id);
      },
    });

    assert.throws(() => harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
      runId: "retry-run", terminalAt: 4, source: "background-notify",
      sourceSessionTargets: [child.name],
    }), /injected send failure/);
    assert.deepEqual(harness.deliveries, ["first"]);
    assert.deepEqual(queue.drain().map((queued) => queued.message.id), ["unrelated", "second"]);
  });

  test("an asynchronously rejected terminal dispatch restores its claimed prelude", async () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("async-retry-session", "async-retry-target");
    queue.enqueue(entry(child, "first", 1));
    registerTerminalOrderingBarrier(harness.pi as never, { queue, toMessage: (queued) => ({ customType: "intercom_message", content: queued.bodyText, display: true, details: queued }), deliver: () => {} });
    const payload = {
      runId: "async-retry-run", terminalId: "complete", terminalAt: 2, source: "background-notify",
      sourceSessionTargets: [child.name], dispatch: async () => { throw new Error("async dispatch failure"); },
    };

    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, payload);
    const completion = (payload as typeof payload & { completion?: Promise<void> }).completion;
    assert.ok(completion);
    await assert.rejects(completion, /async dispatch failure/);
    assert.deepEqual(queue.drain().map((queued) => queued.message.id), ["first"]);
  });
  test("a terminal barrier can win during an in-flight foreground owner probe", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("probe-session", "probe-target");
    const accepted = entry(child, "accepted-before-terminal", 1);
    queue.enqueue(accepted);
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });

    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
      runId: "probe-run", terminalAt: 2, source: "background-notify",
      sourceSessionTargets: [child.name],
    });
    if (queue.remove(accepted)) harness.deliveries.push("foreground-surface");

    assert.deepEqual(harness.deliveries, ["accepted-before-terminal"]);
  });


  test("marks claimed messages as an ordered terminal prelude", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("prelude-session", "prelude-target");
    queue.enqueue(entry(child, "accepted-before-terminal", 1));
    const deliveries: Array<{ id: string; mode: string | undefined }> = [];
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued, mode) => deliveries.push({ id: queued.message.id, mode }),
    });

    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
      runId: "prelude-run", terminalAt: 2, source: "background-notify",
      sourceSessionTargets: [child.name],
    });

    assert.deepEqual(deliveries, [{ id: "accepted-before-terminal", mode: "prelude" }]);
  });

  test("terminal draining is synchronous and never waits for idle state", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("noninteractive-session", "noninteractive-target");
    queue.enqueue(entry(child, "busy child update", 1));
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });

    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
      runId: "noninteractive-run", terminalAt: 2, source: "background-notify",
      sourceSessionTargets: [child.name],
    });
    assert.deepEqual(harness.deliveries, ["busy child update"]);
  });

  test("terminal barriers leave same-child asks on the normal reply path", () => {
    const harness = eventHarness();
    const queue = new InboundIdleQueue();
    const child = source("asking-session", "asking-target");
    const ask = entry(child, "ask", 1);
    ask.message.expectsReply = true;
    queue.enqueue(ask);
    queue.enqueue(entry(child, "ordinary", 2));
    registerTerminalOrderingBarrier(harness.pi as never, {
      queue,
      deliver: (queued) => harness.deliveries.push(queued.message.id),
    });

    harness.pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, {
      runId: "asking-run", terminalAt: 3, source: "background-notify",
      sourceSessionTargets: [child.name],
    });

    assert.deepEqual(harness.deliveries, ["ordinary"]);
    assert.deepEqual(queue.drain().map((queued) => queued.message.id), ["ask"]);
  });

  test("a correlated ask reply bypasses unrelated queued ordinary sends", async () => {
    const queue = new InboundIdleQueue();
    queue.enqueue(entry(source("other-session", "other-child"), "ordinary", 1));
    const waiters = new ReplyWaiterSlot(1_000);
    const admission = waiters.begin("asking-child", "ask-id");
    assert.equal(admission.ok, true);
    if (!admission.ok) return;
    const reply: Message = { id: "reply-id", timestamp: 2, replyTo: "ask-id", content: { text: "answer" } };

    assert.equal(routeIncomingReply(waiters.current(), source("asking-session", "asking-child"), reply), true);
    assert.equal((await admission.wait.promise).id, "reply-id");
    assert.deepEqual(queue.drain().map((queued) => queued.message.id), ["ordinary"]);
  });
});
