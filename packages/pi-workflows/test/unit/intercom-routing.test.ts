/**
 * Unit tests — integrations/intercom/intercom-routing.ts
 *
 * Tests the buildIntercomCallbacks factory in isolation.
 * No full pi surface needed — only mock store + emit + confirm deps.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { createStore } from "../../src/store.js";
import { buildIntercomCallbacks } from "../../src/integrations/intercom/intercom-routing.js";
import type { Store } from "../../src/store.js";
import type { IntercomRoutingDeps } from "../../src/integrations/intercom/intercom-routing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): Store {
  return createStore();
}

function makeEmit(): { calls: { event: string; payload: Record<string, unknown> }[]; fn: IntercomRoutingDeps["emit"] } {
  const calls: { event: string; payload: Record<string, unknown> }[] = [];
  return {
    calls,
    fn: (event, payload) => { calls.push({ event, payload }); },
  };
}

function makeConfirm(result: boolean): { calls: { title: string; message: string }[]; fn: IntercomRoutingDeps["confirm"] } {
  const calls: { title: string; message: string }[] = [];
  return {
    calls,
    fn: async (title, message) => { calls.push({ title, message }); return result; },
  };
}

// ---------------------------------------------------------------------------
// need_decision
// ---------------------------------------------------------------------------

describe("buildIntercomCallbacks — need_decision", () => {
  test("records notice with requiresAck=true", async () => {
    const store = makeStore();
    const emit = makeEmit();
    const confirm = makeConfirm(true);
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: confirm.fn });

    await cb.onNeedDecision!({ type: "need_decision", message: "approve this?" });

    const notices = store.notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.requiresAck).toBe(true);
    expect(notices[0]!.message).toBe("approve this?");
    expect(notices[0]!.level).toBe("warning");
  });

  test("calls confirm with title 'Subagent needs decision' and payload message", async () => {
    const store = makeStore();
    const emit = makeEmit();
    const confirm = makeConfirm(true);
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: confirm.fn });

    await cb.onNeedDecision!({ type: "need_decision", message: "proceed?" });

    expect(confirm.calls).toHaveLength(1);
    expect(confirm.calls[0]!.title).toBe("Subagent needs decision");
    expect(confirm.calls[0]!.message).toBe("proceed?");
  });

  test("emits subagent:control-intercom:response with requestId when accepted", async () => {
    const store = makeStore();
    const emit = makeEmit();
    const confirm = makeConfirm(true);
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: confirm.fn });

    await cb.onNeedDecision!({
      type: "need_decision",
      message: "approve?",
      requestId: "req-abc",
      runId: "run-1",
      stageId: "stage-2",
    });

    expect(emit.calls).toHaveLength(1);
    expect(emit.calls[0]!.event).toBe("subagent:control-intercom:response");
    const p = emit.calls[0]!.payload;
    expect(p["requestId"]).toBe("req-abc");
    expect(p["runId"]).toBe("run-1");
    expect(p["stageId"]).toBe("stage-2");
    expect(p["accepted"]).toBe(true);
  });

  test("emits accepted=false when confirm returns false", async () => {
    const store = makeStore();
    const emit = makeEmit();
    const confirm = makeConfirm(false);
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: confirm.fn });

    await cb.onNeedDecision!({
      type: "need_decision",
      message: "approve?",
      requestId: "req-xyz",
      runId: "run-2",
      stageId: "stage-3",
    });

    expect(emit.calls[0]!.payload["accepted"]).toBe(false);
    expect(emit.calls[0]!.payload["requestId"]).toBe("req-xyz");
  });

  test("emits empty string for missing requestId/runId/stageId", async () => {
    const store = makeStore();
    const emit = makeEmit();
    const confirm = makeConfirm(true);
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: confirm.fn });

    await cb.onNeedDecision!({ type: "need_decision", message: "hi" });

    const p = emit.calls[0]!.payload;
    expect(p["requestId"]).toBe("");
    expect(p["runId"]).toBe("");
    expect(p["stageId"]).toBe("");
  });

  test("acks notice after confirm", async () => {
    const store = makeStore();
    const emit = makeEmit();
    const confirm = makeConfirm(true);
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: confirm.fn });

    await cb.onNeedDecision!({ type: "need_decision", message: "approve?" });

    const notices = store.notices();
    expect(notices[0]!.ackedAt).toBeDefined();
    expect(typeof notices[0]!.ackedAt).toBe("number");
  });

  test("emits response even when confirm absent (accepted=false)", async () => {
    const store = makeStore();
    const emit = makeEmit();
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

    await cb.onNeedDecision!({ type: "need_decision", message: "hi", requestId: "req-no-confirm" });

    expect(emit.calls).toHaveLength(1);
    expect(emit.calls[0]!.payload["accepted"]).toBe(false);
    expect(emit.calls[0]!.payload["requestId"]).toBe("req-no-confirm");
  });

  test("stores runId and stageId on the notice", async () => {
    const store = makeStore();
    const emit = makeEmit();
    const confirm = makeConfirm(true);
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: confirm.fn });

    await cb.onNeedDecision!({
      type: "need_decision",
      message: "ok?",
      runId: "run-99",
      stageId: "stage-7",
    });

    const n = store.notices()[0]!;
    expect(n.runId).toBe("run-99");
    expect(n.stageId).toBe("stage-7");
  });
});

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------

describe("buildIntercomCallbacks — notify", () => {
  test("records info notice for notify without level", () => {
    const store = makeStore();
    const emit = makeEmit();
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

    cb.onNotify!({ type: "notify", message: "stage complete" });

    const notices = store.notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("info");
    expect(notices[0]!.message).toBe("stage complete");
    expect(notices[0]!.requiresAck).toBeUndefined();
  });

  test("records warning notice when payload.level is warning", () => {
    const store = makeStore();
    const emit = makeEmit();
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

    cb.onNotify!({ type: "notify", message: "something suspicious", level: "warning" });

    expect(store.notices()[0]!.level).toBe("warning");
  });

  test("records error notice when payload.level is error", () => {
    const store = makeStore();
    const emit = makeEmit();
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

    cb.onNotify!({ type: "notify", message: "fatal", level: "error" });

    expect(store.notices()[0]!.level).toBe("error");
  });

  test("does not emit response event for notify", () => {
    const store = makeStore();
    const emit = makeEmit();
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

    cb.onNotify!({ type: "notify", message: "info" });

    expect(emit.calls).toHaveLength(0);
  });

  test("stores runId and stageId on notify notice", () => {
    const store = makeStore();
    const emit = makeEmit();
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

    cb.onNotify!({ type: "notify", message: "done", runId: "run-5", stageId: "stage-1" });

    const n = store.notices()[0]!;
    expect(n.runId).toBe("run-5");
    expect(n.stageId).toBe("stage-1");
  });
});

// ---------------------------------------------------------------------------
// unknown / malformed
// ---------------------------------------------------------------------------

describe("buildIntercomCallbacks — unknown type", () => {
  test("records warning notice for unknown type", () => {
    const store = makeStore();
    const emit = makeEmit();
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

    cb.onUnknown!({ type: "future_type", message: "something" });

    const notices = store.notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("warning");
    expect(notices[0]!.message).toContain("future_type");
    expect(notices[0]!.message).toContain("something");
  });

  test("does not emit response event for unknown type", () => {
    const store = makeStore();
    const emit = makeEmit();
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

    cb.onUnknown!({ type: "future_type", message: "noop" });

    expect(emit.calls).toHaveLength(0);
  });

  test("does not ack notice for unknown type", () => {
    const store = makeStore();
    const emit = makeEmit();
    const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

    cb.onUnknown!({ type: "future_type", message: "noop" });

    expect(store.notices()[0]!.ackedAt).toBeUndefined();
  });
});
