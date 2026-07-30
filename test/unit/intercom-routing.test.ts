/**
 * Unit tests — intercom/intercom-routing.ts
 *
 * Tests the buildIntercomCallbacks factory in isolation.
 * No full pi surface needed — only mock store + emit + confirm deps.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { IntercomRoutingDeps } from "../../packages/workflows/src/intercom/intercom-routing.js";
import { buildIntercomCallbacks } from "../../packages/workflows/src/intercom/intercom-routing.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

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
		fn: (event, payload) => {
			calls.push({ event, payload });
		},
	};
}

function makeConfirm(result: boolean): {
	calls: { title: string; message: string }[];
	fn: IntercomRoutingDeps["confirm"];
} {
	const calls: { title: string; message: string }[] = [];
	return {
		calls,
		fn: async (title, message) => {
			calls.push({ title, message });
			return result;
		},
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
		assert.equal(notices.length, 1);
		assert.equal(notices[0]!.requiresAck, true);
		assert.equal(notices[0]!.message, "approve this?");
		assert.equal(notices[0]!.level, "warning");
	});

	test("calls confirm with title 'Subagent needs decision' and payload message", async () => {
		const store = makeStore();
		const emit = makeEmit();
		const confirm = makeConfirm(true);
		const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: confirm.fn });

		await cb.onNeedDecision!({ type: "need_decision", message: "proceed?" });

		assert.equal(confirm.calls.length, 1);
		assert.equal(confirm.calls[0]!.title, "Subagent needs decision");
		assert.equal(confirm.calls[0]!.message, "proceed?");
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

		assert.equal(emit.calls.length, 1);
		assert.equal(emit.calls[0]!.event, "subagent:control-intercom:response");
		const p = emit.calls[0]!.payload;
		assert.equal(p.requestId, "req-abc");
		assert.equal(p.runId, "run-1");
		assert.equal(p.stageId, "stage-2");
		assert.equal(p.accepted, true);
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

		assert.equal(emit.calls[0]!.payload.accepted, false);
		assert.equal(emit.calls[0]!.payload.requestId, "req-xyz");
	});

	test("emits empty string for missing requestId/runId/stageId", async () => {
		const store = makeStore();
		const emit = makeEmit();
		const confirm = makeConfirm(true);
		const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: confirm.fn });

		await cb.onNeedDecision!({ type: "need_decision", message: "hi" });

		const p = emit.calls[0]!.payload;
		assert.equal(p.requestId, "");
		assert.equal(p.runId, "");
		assert.equal(p.stageId, "");
	});

	test("acks notice after confirm", async () => {
		const store = makeStore();
		const emit = makeEmit();
		const confirm = makeConfirm(true);
		const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: confirm.fn });

		await cb.onNeedDecision!({ type: "need_decision", message: "approve?" });

		const notices = store.notices();
		assert.notEqual(notices[0]!.ackedAt, undefined);
		assert.equal(typeof notices[0]!.ackedAt, "number");
	});

	test("emits response even when confirm absent (accepted=false)", async () => {
		const store = makeStore();
		const emit = makeEmit();
		const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

		await cb.onNeedDecision!({ type: "need_decision", message: "hi", requestId: "req-no-confirm" });

		assert.equal(emit.calls.length, 1);
		assert.equal(emit.calls[0]!.payload.accepted, false);
		assert.equal(emit.calls[0]!.payload.requestId, "req-no-confirm");
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
		assert.equal(n.runId, "run-99");
		assert.equal(n.stageId, "stage-7");
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
		assert.equal(notices.length, 1);
		assert.equal(notices[0]!.level, "info");
		assert.equal(notices[0]!.message, "stage complete");
		assert.equal(notices[0]!.requiresAck, undefined);
	});

	test("records warning notice when payload.level is warning", () => {
		const store = makeStore();
		const emit = makeEmit();
		const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

		cb.onNotify!({ type: "notify", message: "something suspicious", level: "warning" });

		assert.equal(store.notices()[0]!.level, "warning");
	});

	test("records error notice when payload.level is error", () => {
		const store = makeStore();
		const emit = makeEmit();
		const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

		cb.onNotify!({ type: "notify", message: "fatal", level: "error" });

		assert.equal(store.notices()[0]!.level, "error");
	});

	test("does not emit response event for notify", () => {
		const store = makeStore();
		const emit = makeEmit();
		const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

		cb.onNotify!({ type: "notify", message: "info" });

		assert.equal(emit.calls.length, 0);
	});

	test("stores runId and stageId on notify notice", () => {
		const store = makeStore();
		const emit = makeEmit();
		const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

		cb.onNotify!({ type: "notify", message: "done", runId: "run-5", stageId: "stage-1" });

		const n = store.notices()[0]!;
		assert.equal(n.runId, "run-5");
		assert.equal(n.stageId, "stage-1");
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
		assert.equal(notices.length, 1);
		assert.equal(notices[0]!.level, "warning");
		assert.ok(notices[0]!.message.includes("future_type"));
		assert.ok(notices[0]!.message.includes("something"));
	});

	test("does not emit response event for unknown type", () => {
		const store = makeStore();
		const emit = makeEmit();
		const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

		cb.onUnknown!({ type: "future_type", message: "noop" });

		assert.equal(emit.calls.length, 0);
	});

	test("does not ack notice for unknown type", () => {
		const store = makeStore();
		const emit = makeEmit();
		const cb = buildIntercomCallbacks({ store, emit: emit.fn, confirm: undefined });

		cb.onUnknown!({ type: "future_type", message: "noop" });

		assert.equal(store.notices()[0]!.ackedAt, undefined);
	});
});
