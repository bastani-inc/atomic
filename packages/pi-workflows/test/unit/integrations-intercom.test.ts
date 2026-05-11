/**
 * Unit tests — integrations/intercom/intercom-bridge.ts + result-intercom.ts
 */
import { test, expect, describe } from "bun:test";
import {
  deriveCwdHash,
  buildParentSessionName,
  isIntercomPresent,
  registerIntercomParentSession,
  type PiIntercomExtensionAPI,
} from "../../src/integrations/intercom/intercom-bridge.js";
import { subscribeIntercomControl } from "../../src/integrations/intercom/result-intercom.js";
import { buildIntercomCallbacks } from "../../src/integrations/intercom/intercom-routing.js";
import { createStore } from "../../src/store.js";

// ---------------------------------------------------------------------------
// intercom-bridge
// ---------------------------------------------------------------------------

describe("deriveCwdHash", () => {
  test("returns 8-char hex string", () => {
    const h = deriveCwdHash("/home/user/project");
    expect(h).toHaveLength(8);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  test("stable: same input same hash", () => {
    expect(deriveCwdHash("/tmp/foo")).toBe(deriveCwdHash("/tmp/foo"));
  });

  test("different inputs produce different hashes (high probability)", () => {
    expect(deriveCwdHash("/a")).not.toBe(deriveCwdHash("/b"));
  });
});

describe("buildParentSessionName", () => {
  test("returns string starting with pi-workflows-parent-", () => {
    const name = buildParentSessionName("/some/dir");
    expect(name.startsWith("pi-workflows-parent-")).toBe(true);
  });

  test("hash portion is 8 chars", () => {
    const name = buildParentSessionName("/some/dir");
    const hash = name.replace("pi-workflows-parent-", "");
    expect(hash).toHaveLength(8);
  });
});

describe("isIntercomPresent", () => {
  test("returns false when setSessionName absent", () => {
    expect(isIntercomPresent({})).toBe(false);
  });

  test("returns true when setSessionName is a function", () => {
    expect(isIntercomPresent({ setSessionName: () => {} })).toBe(true);
  });

  test("returns false when setSessionName is not a function", () => {
    expect(isIntercomPresent({ setSessionName: "not-a-fn" } as unknown as PiIntercomExtensionAPI)).toBe(false);
  });
});

describe("registerIntercomParentSession", () => {
  test("returns null when intercom absent", () => {
    const result = registerIntercomParentSession({});
    expect(result).toBeNull();
  });

  test("calls setSessionName and returns name when intercom present", () => {
    const calls: string[] = [];
    const pi = { setSessionName: (name: string) => { calls.push(name); } };
    const result = registerIntercomParentSession(pi, "/workspace/myproject");
    expect(result).toMatch(/^pi-workflows-parent-[0-9a-f]{8}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(result!);
  });

  test("uses cwd derived hash (stable for same cwd)", () => {
    const calls: string[] = [];
    const pi = { setSessionName: (name: string) => { calls.push(name); } };
    registerIntercomParentSession(pi, "/fixed/cwd");
    registerIntercomParentSession(pi, "/fixed/cwd");
    expect(calls[0]).toBe(calls[1]);
  });
});

// ---------------------------------------------------------------------------
// result-intercom
// ---------------------------------------------------------------------------

describe("subscribeIntercomControl", () => {
  test("returns null when events.on absent", () => {
    const cleanup = subscribeIntercomControl({}, {});
    expect(cleanup).toBeNull();
  });

  test("returns null when events absent", () => {
    const cleanup = subscribeIntercomControl({ events: {} }, {});
    expect(cleanup).toBeNull();
  });

  test("registers handler on subagent:control-intercom", () => {
    const registrations: { event: string }[] = [];
    const pi = {
      events: {
        on: (event: string, _handler: (payload: unknown) => void) => {
          registrations.push({ event });
        },
      },
    };
    subscribeIntercomControl(pi, {});
    expect(registrations).toHaveLength(1);
    expect(registrations[0].event).toBe("subagent:control-intercom");
  });

  test("routes need_decision to onNeedDecision callback", async () => {
    const received: unknown[] = [];
    let capturedHandler: ((p: unknown) => void) | null = null;
    const pi = {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    };
    subscribeIntercomControl(pi, {
      onNeedDecision: (p) => { received.push(p); },
    });
    capturedHandler!({ type: "need_decision", message: "approve?" });
    // allow async dispatch
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);
    expect((received[0] as { message: string }).message).toBe("approve?");
  });

  test("routes notify to onNotify callback", async () => {
    const received: unknown[] = [];
    let capturedHandler: ((p: unknown) => void) | null = null;
    const pi = {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    };
    subscribeIntercomControl(pi, {
      onNotify: (p) => { received.push(p); },
    });
    capturedHandler!({ type: "notify", message: "stage complete" });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);
  });

  test("routes unknown type to onUnknown callback", async () => {
    const received: unknown[] = [];
    let capturedHandler: ((p: unknown) => void) | null = null;
    const pi = {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    };
    subscribeIntercomControl(pi, {
      onUnknown: (p) => { received.push(p); },
    });
    capturedHandler!({ type: "future_type", message: "hi" });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);
  });

  test("cleanup stops routing", async () => {
    const received: unknown[] = [];
    let capturedHandler: ((p: unknown) => void) | null = null;
    const pi = {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    };
    const cleanup = subscribeIntercomControl(pi, {
      onNotify: (p) => { received.push(p); },
    });
    cleanup!();
    capturedHandler!({ type: "notify", message: "after cleanup" });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(0);
  });

  test("ignores malformed payload (no crash)", async () => {
    let capturedHandler: ((p: unknown) => void) | null = null;
    const pi = {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    };
    subscribeIntercomControl(pi, {});
    expect(() => capturedHandler!(null)).not.toThrow();
    expect(() => capturedHandler!("string")).not.toThrow();
    expect(() => capturedHandler!(42)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// result-intercom + intercom-routing integration
// Wires subscribeIntercomControl with buildIntercomCallbacks and asserts
// store-level behaviour end-to-end.
// ---------------------------------------------------------------------------

/** Capture handler registered via pi.events.on and expose a fire() helper. */
function makeEventBus(): {
  pi: { events: { on: (event: string, handler: (payload: unknown) => void) => void } };
  fire: (payload: unknown) => void;
} {
  let capturedHandler: ((payload: unknown) => void) = () => {};
  return {
    pi: {
      events: {
        on: (_event: string, handler: (payload: unknown) => void) => {
          capturedHandler = handler;
        },
      },
    },
    fire: (payload: unknown) => capturedHandler(payload),
  };
}

describe("result-intercom + intercom-routing — notify records notice", () => {
  test("notify event records info notice in store", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const callbacks = buildIntercomCallbacks({ store, emit: undefined, confirm: undefined });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "notify", message: "stage started" });
    await new Promise((r) => setTimeout(r, 0));

    const notices = store.notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("info");
    expect(notices[0]!.message).toBe("stage started");
    expect(notices[0]!.requiresAck).toBeUndefined();
  });

  test("notify event with warning level records warning notice", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const callbacks = buildIntercomCallbacks({ store, emit: undefined, confirm: undefined });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "notify", message: "memory high", level: "warning" });
    await new Promise((r) => setTimeout(r, 0));

    expect(store.notices()[0]!.level).toBe("warning");
  });

  test("notify does not ack the notice", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const callbacks = buildIntercomCallbacks({ store, emit: undefined, confirm: undefined });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "notify", message: "info only" });
    await new Promise((r) => setTimeout(r, 0));

    expect(store.notices()[0]!.ackedAt).toBeUndefined();
  });
});

describe("result-intercom + intercom-routing — need_decision records requiresAck warning when UI unavailable", () => {
  test("need_decision records requiresAck=true warning notice when confirm absent", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const emitCalls: { event: string; payload: Record<string, unknown> }[] = [];
    const callbacks = buildIntercomCallbacks({
      store,
      emit: (event, payload) => { emitCalls.push({ event, payload }); },
      confirm: undefined,
    });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "need_decision", message: "proceed?", requestId: "req-1", runId: "run-1", stageId: "s-1" });
    await new Promise((r) => setTimeout(r, 10));

    const notices = store.notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("warning");
    expect(notices[0]!.requiresAck).toBe(true);
    expect(notices[0]!.message).toBe("proceed?");
  });

  test("need_decision emits response with accepted=false when confirm absent", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const emitCalls: { event: string; payload: Record<string, unknown> }[] = [];
    const callbacks = buildIntercomCallbacks({
      store,
      emit: (event, payload) => { emitCalls.push({ event, payload }); },
      confirm: undefined,
    });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "need_decision", message: "ok?", requestId: "req-noui" });
    await new Promise((r) => setTimeout(r, 10));

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0]!.event).toBe("subagent:control-intercom:response");
    expect(emitCalls[0]!.payload["accepted"]).toBe(false);
    expect(emitCalls[0]!.payload["requestId"]).toBe("req-noui");
  });

  test("need_decision notice is acked after response emitted", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const callbacks = buildIntercomCallbacks({
      store,
      emit: () => {},
      confirm: undefined,
    });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "need_decision", message: "ack me" });
    await new Promise((r) => setTimeout(r, 10));

    expect(store.notices()[0]!.ackedAt).toBeDefined();
  });
});

describe("result-intercom + intercom-routing — unknown event records warning", () => {
  test("unknown type records warning notice containing type name and message", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const callbacks = buildIntercomCallbacks({ store, emit: undefined, confirm: undefined });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "future_event", message: "unknown payload" });
    await new Promise((r) => setTimeout(r, 0));

    const notices = store.notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("warning");
    expect(notices[0]!.message).toContain("future_event");
    expect(notices[0]!.message).toContain("unknown payload");
  });

  test("unknown type does not ack notice", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const callbacks = buildIntercomCallbacks({ store, emit: undefined, confirm: undefined });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "novel_type", message: "hi" });
    await new Promise((r) => setTimeout(r, 0));

    expect(store.notices()[0]!.ackedAt).toBeUndefined();
  });

  test("unknown type does not emit response event", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const emitCalls: unknown[] = [];
    const callbacks = buildIntercomCallbacks({
      store,
      emit: (event, payload) => { emitCalls.push({ event, payload }); },
      confirm: undefined,
    });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "novel_type", message: "hi" });
    await new Promise((r) => setTimeout(r, 0));

    expect(emitCalls).toHaveLength(0);
  });
});
