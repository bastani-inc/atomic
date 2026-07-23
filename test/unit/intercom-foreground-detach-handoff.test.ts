import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ForegroundDetachHandoff, handleForegroundInboundDelivery, INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT } from "../../packages/intercom/foreground-detach-handoff.js";
import { createForwardedHandlerMap, createHeavyProxy, type CapturedHeavy } from "../../packages/intercom/lazy-heavy-proxy.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const from = (id: string, name: string): SessionInfo => ({ id, name, cwd: "/tmp", model: "m", pid: 1, startedAt: 1, lastActivity: 1 });
const message = (id: string, expectsReply: boolean): Message => ({ id, timestamp: 1, expectsReply, content: { text: "hello" } });
function fixture() {
  const emitter = new EventEmitter();
  const events = {
    emit(channel: string, payload: object) { emitter.emit(channel, payload); },
    on(channel: string, handler: (payload: object) => void) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
  };
  return { emitter, handoff: new ForegroundDetachHandoff({ events } as never) };
}

describe("broker foreground delivery handshake", () => {
  test("probes and commits the exact owner before surfacing a blocking detach", async () => {
    const { emitter, handoff } = fixture();
    const order: string[] = [];
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string; requestId: string; childIntercomTarget?: string; runtimeGeneration?: number }) => {
      order.push(request.phase ?? "unknown");
      assert.equal(request.childIntercomTarget, "child-a");
      emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
    });
    const ok = await handoff.deliver({ from: from("a", "child-a"), message: message("q", true), generation: 3, surface: () => order.push("surface"), isCurrent: () => true });
    assert.equal(ok, "delivered");
    assert.deepEqual(order, ["probe", "commit", "surface"]);
  });

  test("receives detach acknowledgements through the production lazy proxy", async () => {
    const emitter = new EventEmitter();
    const rawPi = {
      events: {
        emit(channel: string, payload: object) { emitter.emit(channel, payload); },
        on(channel: string, handler: (payload: object) => void) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
      },
    } as never;
    const captured: CapturedHeavy = {
      tools: new Map(), commands: new Map(), handlers: createForwardedHandlerMap(),
      shortcuts: new Map(), eventHandlers: new Map(),
    };
    const handoff = new ForegroundDetachHandoff(createHeavyProxy(rawPi, captured));
    const order: string[] = [];
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string }) => {
      order.push(request.phase ?? "unknown");
      emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
    });

    assert.equal(await handoff.deliver({
      from: from("a", "child-a"), message: message("proxy", true), generation: 1,
      surface: () => order.push("surface"), isCurrent: () => true,
    }), "delivered");
    assert.deepEqual(order, ["probe", "commit", "surface"]);
    assert.equal(emitter.listenerCount(INTERCOM_DETACH_RESPONSE_EVENT), 0);
    assert.equal(captured.eventHandlers.has(INTERCOM_DETACH_RESPONSE_EVENT), false);
  });

  test("foreground nonblocking delivery also probes and commits promptly", async () => {
    const { emitter, handoff } = fixture();
    const order: string[] = [];
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string }) => {
      order.push(request.phase ?? "unknown");
      emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
    });
    assert.equal(await handoff.deliver({ from: from("a", "child-a"), message: message("p", false), generation: 1, surface: () => order.push("surface"), isCurrent: () => true }), "delivered");
    assert.deepEqual(order, ["probe", "commit", "surface"]);
  });

  test("an unmatched sender falls back without surfacing", async () => {
    const emitter = new EventEmitter();
    const events = {
      emit(channel: string, payload: object) { emitter.emit(channel, payload); },
      on(channel: string, handler: (payload: object) => void) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
    };
    const handoff = new ForegroundDetachHandoff({ events } as never, 5);
    let surfaced = 0;
    assert.equal(await handoff.deliver({ from: from("background", "background-child"), message: message("q", true), generation: 1, surface: () => surfaced++, isCurrent: () => true }), "unclaimed");
    assert.equal(surfaced, 0);
    assert.equal(emitter.listenerCount(INTERCOM_DETACH_RESPONSE_EVENT), 0);
  });
  test("stale and duplicate deliveries cannot resurface or recommit", async () => {
    const { emitter, handoff } = fixture();
    let current = true;
    let surfaced = 0;
    let committed = 0;
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string }) => {
      if (request.phase === "commit") committed++;
      emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
    });
    const input = { from: from("a", "child-a"), message: message("q", true), generation: 2, surface: () => surfaced++, isCurrent: () => current };
    assert.equal(await handoff.deliver(input), "delivered");
    assert.equal(await handoff.deliver(input), "delivered");
    current = false;
    assert.equal(await handoff.deliver({ ...input, message: message("other", true) }), "abandoned");
    assert.equal(surfaced, 1);
    assert.equal(committed, 1);
  });

  test("replacement after acknowledgement cannot surface or commit", async () => {
    const { emitter, handoff } = fixture();
    let current = true;
    let surfaced = 0;
    let committed = 0;
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string }) => {
      if (request.phase === "probe") {
        current = false;
        emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
      } else committed++;
    });
    assert.equal(await handoff.deliver({ from: from("a", "child-a"), message: message("q", true), generation: 1, surface: () => surfaced++, isCurrent: () => current }), "abandoned");
    assert.equal(surfaced, 0);
    assert.equal(committed, 0);
  });

  test("an unacknowledged commit falls back without surfacing a reserved delivery", async () => {
    const emitter = new EventEmitter();
    const events = {
      emit(channel: string, payload: object) { emitter.emit(channel, payload); },
      on(channel: string, handler: (payload: object) => void) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
    };
    const handoff = new ForegroundDetachHandoff({ events } as never, 5);
    let surfaced = 0;
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string }) => {
      if (request.phase === "probe") emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
    });
    assert.equal(await handoff.deliver({ from: from("a", "child-a"), message: message("q", true), generation: 1, surface: () => surfaced++, isCurrent: () => true }), "unclaimed");
    assert.equal(surfaced, 0);
  });
  test("an owner lost before commit re-enters the unclaimed fallback", async () => {
    const emitter = new EventEmitter();
    const events = {
      emit(channel: string, payload: object) { emitter.emit(channel, payload); },
      on(channel: string, handler: (payload: object) => void) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
    };
    const handoff = new ForegroundDetachHandoff({ events } as never, 5);
    let surfaced = 0;
    let queued = 0;
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string }) => {
      if (request.phase === "probe") emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
    });
    await handleForegroundInboundDelivery({
      handoff,
      from: from("a", "child-a"),
      message: message("q", true),
      generation: 1,
      surface: () => surfaced++,
      isCurrent: () => true,
      onUnclaimed: () => queued++,
    });
    assert.equal(surfaced, 0);
    assert.equal(queued, 1);
  });

  test("generation reuse starts a fresh handshake instead of reusing a pending attempt", async () => {
    const { emitter, handoff } = fixture();
    const probes: number[] = [];
    let releaseFirstProbe: (() => void) | undefined;
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string; runtimeGeneration?: number }) => {
      if (request.phase === "probe") {
        probes.push(request.runtimeGeneration ?? -1);
        if (request.runtimeGeneration === 1) {
          releaseFirstProbe = () => emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
          return;
        }
      }
      emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
    });
    const base = { from: from("a", "child-a"), message: message("q", true), surface: () => {}, isCurrent: () => true };
    const first = handoff.deliver({ ...base, generation: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = handoff.deliver({ ...base, generation: 2 });
    assert.equal(await second, "delivered");
    releaseFirstProbe?.();
    assert.equal(await first, "abandoned");
    assert.deepEqual(probes, [1, 2]);
  });
  test("reset immediately abandons and cleans up an in-flight probe", async () => {
    const emitter = new EventEmitter();
    const events = {
      emit(channel: string, payload: object) { emitter.emit(channel, payload); },
      on(channel: string, handler: (payload: object) => void) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
    };
    const handoff = new ForegroundDetachHandoff({ events } as never, 5_000);
    let surfaced = 0;
    let unclaimed = 0;
    let probe: object | undefined;
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string }) => {
      if (request.phase === "probe") probe = request;
    });
    const startedAt = Date.now();
    const delivery = handleForegroundInboundDelivery({
      handoff, from: from("a", "child-a"), message: message("reset-probe", true), generation: 1,
      surface: () => surfaced++, isCurrent: () => true, onUnclaimed: () => unclaimed++,
    });
    await Bun.sleep(0);
    assert.equal(emitter.listenerCount(INTERCOM_DETACH_RESPONSE_EVENT), 1);
    handoff.reset();
    await delivery;
    assert.ok(Date.now() - startedAt < 1_000, "reset must not wait for the acknowledgement timeout");
    assert.equal(emitter.listenerCount(INTERCOM_DETACH_RESPONSE_EVENT), 0);
    assert.equal(surfaced, 0);
    assert.equal(unclaimed, 0);
    emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...probe, accepted: true });
    assert.equal(surfaced, 0);
  });

  test("reset immediately abandons and cleans up an in-flight commit", async () => {
    const emitter = new EventEmitter();
    const events = {
      emit(channel: string, payload: object) { emitter.emit(channel, payload); },
      on(channel: string, handler: (payload: object) => void) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
    };
    const handoff = new ForegroundDetachHandoff({ events } as never, 5_000);
    let surfaced = 0;
    let unclaimed = 0;
    let commit: object | undefined;
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string }) => {
      if (request.phase === "probe") emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
      else if (request.phase === "commit") commit = request;
    });
    const startedAt = Date.now();
    const delivery = handleForegroundInboundDelivery({
      handoff, from: from("a", "child-a"), message: message("reset-commit", true), generation: 1,
      surface: () => surfaced++, isCurrent: () => true, onUnclaimed: () => unclaimed++,
    });
    await Bun.sleep(0);
    assert.ok(commit, "commit wait must be active before reset");
    assert.equal(emitter.listenerCount(INTERCOM_DETACH_RESPONSE_EVENT), 1);
    handoff.reset();
    await delivery;
    assert.ok(Date.now() - startedAt < 1_000, "reset must clear the commit timeout");
    assert.equal(emitter.listenerCount(INTERCOM_DETACH_RESPONSE_EVENT), 0);
    assert.equal(surfaced, 0);
    assert.equal(unclaimed, 0);
    emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...commit, accepted: true });
    assert.equal(surfaced, 0);
  });
  test("reset clears pending bookkeeping before an immediate retry", async () => {
    const { emitter, handoff } = fixture();
    let probes = 0;
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string }) => {
      if (request.phase === "probe") probes++;
      if (probes > 1) emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
    });
    const base = { from: from("a", "child-a"), message: message("retry", true), generation: 1, surface: () => {}, isCurrent: () => true };
    const stale = handoff.deliver(base);
    handoff.reset();
    const retry = handoff.deliver(base);
    assert.equal(await stale, "abandoned");
    assert.equal(await retry, "delivered");
    assert.equal(probes, 2);
  });


  test("reset permits a new generation to deliver the same message identity", async () => {
    const { emitter, handoff } = fixture();
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: { phase?: string }) => {
      emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
    });
    let surfaced = 0;
    const base = { from: from("a", "child-a"), message: message("q", true), surface: () => surfaced++, isCurrent: () => true };
    assert.equal(await handoff.deliver({ ...base, generation: 1 }), "delivered");
    handoff.reset();
    assert.equal(await handoff.deliver({ ...base, generation: 2 }), "delivered");
    assert.equal(surfaced, 2);
  });

  test("duplicate delivered messages release provisional idle-queue ownership", async () => {
    const { emitter, handoff } = fixture();
    emitter.on(INTERCOM_DETACH_REQUEST_EVENT, (request: object) => {
      emitter.emit(INTERCOM_DETACH_RESPONSE_EVENT, { ...request, accepted: true });
    });
    let queued = true;
    const deliver = () => handleForegroundInboundDelivery({
      handoff,
      from: from("a", "child-a"),
      message: message("stable-message", false),
      generation: 1,
      surface: () => { queued = false; },
      isCurrent: () => true,
      onUnclaimed: () => {},
      onDelivered: () => { queued = false; },
    } as never);

    await deliver();
    assert.equal(queued, false);
    queued = true;
    await deliver();
    assert.equal(queued, false, "a broker resend must not remain in the idle queue");
  });
});
