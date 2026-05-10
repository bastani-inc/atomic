import { describe, expect, test } from "bun:test";
import {
  type CopilotHILSessionSurface,
  type CopilotSendSessionSurface,
  type OpenCodeHILEvent,
  watchCopilotSessionForElicitation,
  watchCopilotSessionForHIL,
  watchOpencodeStreamForHIL,
  wrapCopilotSend,
} from "./hil-watchers.ts";

interface FakeSession {
  surface: CopilotSendSessionSurface & CopilotHILSessionSurface;
  emit: (eventType: string, event: { data?: unknown }) => void;
  listeners: Map<string, Set<(event: { data?: unknown }) => void>>;
}

function makeFakeSession(): FakeSession {
  const listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  const surface = {
    on(eventType: string, handler: (event: { data?: unknown }) => void) {
      let set = listeners.get(eventType);
      if (!set) {
        set = new Set();
        listeners.set(eventType, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
      };
    },
  };
  return {
    surface,
    listeners,
    emit(eventType, event) {
      const set = listeners.get(eventType);
      if (!set) return;
      for (const handler of [...set]) handler(event);
    },
  };
}

describe("wrapCopilotSend", () => {
  test("resolves with nativeSend's value once session.idle fires", async () => {
    const fake = makeFakeSession();
    const wrapped = wrapCopilotSend(fake.surface, async (msg: string) => `ack:${msg}`);

    const pending = wrapped("hello");
    queueMicrotask(() => fake.emit("session.idle", {}));
    expect(await pending).toBe("ack:hello");

    expect(fake.listeners.get("session.idle")?.size ?? 0).toBe(0);
    expect(fake.listeners.get("session.error")?.size ?? 0).toBe(0);
  });

  test("rejects with the error message when session.error fires before idle", async () => {
    const fake = makeFakeSession();
    const wrapped = wrapCopilotSend(fake.surface, async () => "should-not-resolve");

    const pending = wrapped(undefined);
    queueMicrotask(() => fake.emit("session.error", { data: { message: "boom" } }));
    let caught: unknown;
    try {
      await pending;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
    expect(fake.listeners.get("session.idle")?.size ?? 0).toBe(0);
  });

  test("falls back to a generic message when session.error has no payload", async () => {
    const fake = makeFakeSession();
    const wrapped = wrapCopilotSend(fake.surface, async () => "noop");
    const pending = wrapped(undefined);
    queueMicrotask(() => fake.emit("session.error", {}));
    let caught: unknown;
    try {
      await pending;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Copilot session error");
  });
});

describe("watchOpencodeStreamForHIL", () => {
  async function* streamOf(...events: OpenCodeHILEvent[]): AsyncIterable<OpenCodeHILEvent> {
    for (const e of events) yield e;
  }

  test("emits waiting=true on question.asked and false on reply/rejection for matching session", async () => {
    const calls: boolean[] = [];
    await watchOpencodeStreamForHIL(
      streamOf(
        { type: "question.asked", properties: { sessionID: "s1" } },
        { type: "question.replied", properties: { sessionID: "s1" } },
        { type: "question.asked", properties: { sessionID: "s1" } },
        { type: "question.rejected", properties: { sessionID: "s1" } },
      ),
      "s1",
      (waiting) => calls.push(waiting),
    );
    expect(calls).toEqual([true, false, true, false]);
  });

  test("ignores events for other sessions and unrelated event types", async () => {
    const calls: boolean[] = [];
    await watchOpencodeStreamForHIL(
      streamOf(
        { type: "question.asked", properties: { sessionID: "other" } },
        { type: "noise", properties: { sessionID: "s1" } },
        { type: "question.replied", properties: { sessionID: "other" } },
      ),
      "s1",
      (waiting) => calls.push(waiting),
    );
    expect(calls).toEqual([]);
  });
});

describe("watchCopilotSessionForHIL", () => {
  test("emits true only on the first ask_user and false only when all complete", () => {
    const fake = makeFakeSession();
    const calls: boolean[] = [];
    const unsub = watchCopilotSessionForHIL(fake.surface, (w) => calls.push(w));

    fake.emit("tool.execution_start", { data: { toolName: "ask_user", toolCallId: "a" } });
    fake.emit("tool.execution_start", { data: { toolName: "ask_user", toolCallId: "b" } });
    fake.emit("tool.execution_complete", { data: { toolCallId: "a" } });
    fake.emit("tool.execution_complete", { data: { toolCallId: "b" } });

    expect(calls).toEqual([true, false]);
    unsub();
    expect(fake.listeners.get("tool.execution_start")?.size ?? 0).toBe(0);
    expect(fake.listeners.get("tool.execution_complete")?.size ?? 0).toBe(0);
  });

  test("ignores non-ask_user tools and unknown toolCallIds", () => {
    const fake = makeFakeSession();
    const calls: boolean[] = [];
    watchCopilotSessionForHIL(fake.surface, (w) => calls.push(w));

    fake.emit("tool.execution_start", { data: { toolName: "other", toolCallId: "x" } });
    fake.emit("tool.execution_start", { data: { toolName: "ask_user" } });
    fake.emit("tool.execution_complete", { data: { toolCallId: "unknown" } });

    expect(calls).toEqual([]);
  });
});

describe("watchCopilotSessionForElicitation", () => {
  test("brackets HIL across overlapping elicitation requests", () => {
    const fake = makeFakeSession();
    const calls: boolean[] = [];
    const unsub = watchCopilotSessionForElicitation(fake.surface, (w) => calls.push(w));

    fake.emit("elicitation.requested", { data: { requestId: "r1" } });
    fake.emit("elicitation.requested", { data: { requestId: "r2" } });
    fake.emit("elicitation.completed", { data: { requestId: "r1" } });
    fake.emit("elicitation.completed", { data: { requestId: "r2" } });

    expect(calls).toEqual([true, false]);
    unsub();
    expect(fake.listeners.get("elicitation.requested")?.size ?? 0).toBe(0);
    expect(fake.listeners.get("elicitation.completed")?.size ?? 0).toBe(0);
  });

  test("ignores events without requestId and stale completions", () => {
    const fake = makeFakeSession();
    const calls: boolean[] = [];
    watchCopilotSessionForElicitation(fake.surface, (w) => calls.push(w));

    fake.emit("elicitation.requested", {});
    fake.emit("elicitation.completed", { data: { requestId: "unknown" } });

    expect(calls).toEqual([]);
  });
});
