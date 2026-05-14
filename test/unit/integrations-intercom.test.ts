/**
 * Unit tests — intercom/intercom-bridge.ts + result-intercom.ts
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  deriveCwdHash,
  buildParentSessionName,
  isIntercomPresent,
  registerIntercomParentSession,
  type PiIntercomExtensionAPI,
} from "../../src/intercom/intercom-bridge.js";
import { subscribeIntercomControl } from "../../src/intercom/result-intercom.js";
import { buildIntercomCallbacks } from "../../src/intercom/intercom-routing.js";
import { createStore } from "../../src/shared/store.js";

// ---------------------------------------------------------------------------
// intercom-bridge
// ---------------------------------------------------------------------------

describe("deriveCwdHash", () => {
  test("returns 8-char hex string", () => {
    const h = deriveCwdHash("/home/user/project");
    assert.equal(h.length, 8);
    assert.match(h, /^[0-9a-f]{8}$/);
  });

  test("stable: same input same hash", () => {
    assert.equal(deriveCwdHash("/tmp/foo"), deriveCwdHash("/tmp/foo"));
  });

  test("different inputs produce different hashes (high probability)", () => {
    assert.notEqual(deriveCwdHash("/a"), deriveCwdHash("/b"));
  });
});

describe("buildParentSessionName", () => {
  test("returns string starting with pi-workflows-parent-", () => {
    const name = buildParentSessionName("/some/dir");
    assert.equal(name.startsWith("pi-workflows-parent-"), true);
  });

  test("hash portion is 8 chars", () => {
    const name = buildParentSessionName("/some/dir");
    const hash = name.replace("pi-workflows-parent-", "");
    assert.equal(hash.length, 8);
  });
});

describe("isIntercomPresent", () => {
  test("returns false when setSessionName absent", () => {
    assert.equal(isIntercomPresent({}), false);
  });

  test("returns true when setSessionName is a function", () => {
    assert.equal(isIntercomPresent({ setSessionName: () => {} }), true);
  });

  test("returns false when setSessionName is not a function", () => {
    assert.equal(isIntercomPresent({ setSessionName: "not-a-fn" } as unknown as PiIntercomExtensionAPI), false);
  });
});

describe("registerIntercomParentSession", () => {
  test("returns null when intercom absent", () => {
    const result = registerIntercomParentSession({});
    assert.equal(result, null);
  });

  test("calls setSessionName and returns name when intercom present", () => {
    const calls: string[] = [];
    const pi = { setSessionName: (name: string) => { calls.push(name); } };
    const result = registerIntercomParentSession(pi, "/workspace/myproject");
    assert.match(result!, /^pi-workflows-parent-[0-9a-f]{8}$/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], result!);
  });

  test("uses cwd derived hash (stable for same cwd)", () => {
    const calls: string[] = [];
    const pi = { setSessionName: (name: string) => { calls.push(name); } };
    registerIntercomParentSession(pi, "/fixed/cwd");
    registerIntercomParentSession(pi, "/fixed/cwd");
    assert.equal(calls[0], calls[1]);
  });
});

// ---------------------------------------------------------------------------
// result-intercom
// ---------------------------------------------------------------------------

describe("subscribeIntercomControl", () => {
  test("returns null when events.on absent", () => {
    const cleanup = subscribeIntercomControl({}, {});
    assert.equal(cleanup, null);
  });

  test("returns null when events absent", () => {
    const cleanup = subscribeIntercomControl({ events: {} }, {});
    assert.equal(cleanup, null);
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
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].event, "subagent:control-intercom");
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
    assert.equal(received.length, 1);
    assert.equal((received[0] as { message: string }).message, "approve?");
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
    assert.equal(received.length, 1);
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
    assert.equal(received.length, 1);
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
    assert.equal(received.length, 0);
  });

  test("cleanup calls event-bus unsubscribe when provided", () => {
    let unsubscribed = 0;
    const pi = {
      events: {
        on: (_event: string, _handler: (payload: unknown) => void) => {
          return () => { unsubscribed += 1; };
        },
      },
    };
    const cleanup = subscribeIntercomControl(pi, {});
    cleanup!();
    assert.equal(unsubscribed, 1);
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
    assert.doesNotThrow(() => capturedHandler!(null));
    assert.doesNotThrow(() => capturedHandler!("string"));
    assert.doesNotThrow(() => capturedHandler!(42));
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
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.level, "info");
    assert.equal(notices[0]!.message, "stage started");
    assert.equal(notices[0]!.requiresAck, undefined);
  });

  test("notify event with warning level records warning notice", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const callbacks = buildIntercomCallbacks({ store, emit: undefined, confirm: undefined });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "notify", message: "memory high", level: "warning" });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(store.notices()[0]!.level, "warning");
  });

  test("notify does not ack the notice", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const callbacks = buildIntercomCallbacks({ store, emit: undefined, confirm: undefined });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "notify", message: "info only" });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(store.notices()[0]!.ackedAt, undefined);
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
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.level, "warning");
    assert.equal(notices[0]!.requiresAck, true);
    assert.equal(notices[0]!.message, "proceed?");
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

    assert.equal(emitCalls.length, 1);
    assert.equal(emitCalls[0]!.event, "subagent:control-intercom:response");
    assert.equal(emitCalls[0]!.payload["accepted"], false);
    assert.equal(emitCalls[0]!.payload["requestId"], "req-noui");
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

    assert.notEqual(store.notices()[0]!.ackedAt, undefined);
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
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.level, "warning");
    assert.ok(notices[0]!.message.includes("future_event"));
    assert.ok(notices[0]!.message.includes("unknown payload"));
  });

  test("unknown type does not ack notice", async () => {
    const store = createStore();
    const bus = makeEventBus();
    const callbacks = buildIntercomCallbacks({ store, emit: undefined, confirm: undefined });
    subscribeIntercomControl(bus.pi, callbacks);

    bus.fire({ type: "novel_type", message: "hi" });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(store.notices()[0]!.ackedAt, undefined);
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

    assert.equal(emitCalls.length, 0);
  });
});
