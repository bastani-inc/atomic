import { test } from "bun:test";
import assert from "node:assert/strict";
import registerSubagentNotify from "../../packages/subagents/src/runs/background/notify.js";
import { deliverLocalCompletionNotification } from "../../packages/subagents/src/runs/background/completion-notification.js";

function createHarness() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let sends = 0;
  const pi = {
    events: {
      on(event: string, handler: (data: unknown) => void) {
        const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); return () => set.delete(handler);
      },
      emit(event: string, payload: unknown) { for (const handler of listeners.get(event) ?? []) handler(payload); },
    },
    sendMessage() {
      sends += 1;
      if (sends === 1) throw new Error("injected notification failure");
    },
  };
  return { pi, sends: () => sends };
}

test("local completion acknowledgement retries failures and dedupes successful request ids", async () => {
  const harness = createHarness();
  const unregister = registerSubagentNotify(harness.pi as never);
  const payload = { id: "notify-run", agent: "worker", success: true, summary: "done" };
  assert.equal(await deliverLocalCompletionNotification(harness.pi.events, payload, "stable-notify"), false);
  assert.equal(await deliverLocalCompletionNotification(harness.pi.events, payload, "stable-notify"), true);
  assert.equal(await deliverLocalCompletionNotification(harness.pi.events, payload, "stable-notify"), true);
  assert.equal(harness.sends(), 2, "the duplicate request is acknowledged without another message");
  unregister();
});

test("local completion acknowledgement waits for rejected async delivery before retrying", async () => {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let sends = 0;
  const events = {
    on(event: string, handler: (data: unknown) => void) { const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); return () => set.delete(handler); },
    emit(event: string, payload: unknown) { for (const handler of listeners.get(event) ?? []) handler(payload); },
  };
  const pi = { events, sendMessage: async () => { sends += 1; if (sends === 1) throw new Error("async notification failure"); } };
  const unregister = registerSubagentNotify(pi as never);
  const payload = { id: "async-notify-run", agent: "worker", success: true, summary: "done" };

  assert.equal(await deliverLocalCompletionNotification(events, payload, "stable-async-notify"), false);
  assert.equal(await deliverLocalCompletionNotification(events, payload, "stable-async-notify"), true);
  assert.equal(sends, 2);
  unregister();
});

test("queued child messages drain before a direct terminal notification", () => {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const pendingIdle = ["Ready…"];
  const delivered: string[] = [];
  const events = {
    on(event: string, handler: (data: unknown) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
    emit(event: string, payload: unknown) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
  };
  events.on("subagent:terminal-ordering-barrier", () => {
    delivered.push(...pendingIdle.splice(0));
  });
  const pi = {
    events,
    sendMessage(message: { customType: string }) { delivered.push(message.customType); },
  };
  registerSubagentNotify(pi as never);

  events.emit("subagent:async-complete", {
    id: "ordering-run", runId: "ordering-run", agent: "worker",
    success: false, state: "paused", summary: "Paused after interrupt.", timestamp: 2,
    results: [{ agent: "worker", intercomTarget: "subagent-worker-ordering-run-1" }],
  });
  delivered.push(...pendingIdle.splice(0));

  assert.deepEqual(delivered, ["Ready…", "subagent-notify"]);
});
