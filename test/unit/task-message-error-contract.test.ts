import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import {
	isTaskMessageError,
	isTaskMessageTimeoutError,
	rehydrateTaskMessageError,
	TaskMessageError,
	TaskMessageTimeoutError,
} from "../../packages/coding-agent/src/core/tasks/message-error.js";
import { sendTaskTranscriptMessage } from "../../packages/subagents/src/intercom/task-message.js";
import {
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../../packages/subagents/src/shared/types.js";

afterEach(() => {
	vi.useRealTimers();
});

const timeoutFields = { taskId: "task-1", target: "worker-1", timeoutMs: 100, elapsedMs: 120 };

test("every task message error code words its message and hint exactly (#4521)", () => {
	assert.equal(
		new TaskMessageError("task-unavailable", { taskId: "t" }).message,
		"Could not message the task: t (task-unavailable). Run /tasks to see the current tasks.",
	);
	assert.equal(
		new TaskMessageError("messages-unsupported", { taskId: "t" }).message,
		"This task cannot receive messages: t (messages-unsupported). Only agent tasks that have an Intercom target accept messages from their transcript.",
	);
	assert.equal(
		new TaskMessageError("delivery-refused", { taskId: "t", target: "w", detail: "offline" }).message,
		"Intercom did not deliver the message: w (delivery-refused): offline. Check that the agent is still available, then send the message again.",
	);
	assert.equal(
		new TaskMessageError("delivery-unconfirmed", { taskId: "t" }).message,
		"Intercom did not confirm the message: t (delivery-unconfirmed). The agent may still receive it; check its transcript before sending it again.",
	);
});

test("a task message error sets only the fields it was given and names itself (#4521)", () => {
	const bare = new TaskMessageError("task-unavailable", { taskId: "t" });
	assert.equal(bare.name, "TaskMessageError");
	assert.equal(bare.retryable, false);
	assert.equal(bare.target, undefined);
	assert.equal(bare.detail, undefined);
	assert.equal(new TaskMessageError("delivery-refused", { taskId: "t" }).retryable, true);
	const full = new TaskMessageError("delivery-refused", { taskId: "t", target: "w", detail: "d" });
	assert.equal(full.target, "w");
	assert.equal(full.detail, "d");
});

test("toJSON omits absent target, detail and cause and keeps present ones (#4521)", () => {
	const bare = new TaskMessageError("task-unavailable", { taskId: "t" });
	assert.deepEqual(bare.toJSON(), {
		name: "TaskMessageError",
		code: "task-unavailable",
		message: bare.message,
		hint: "Run /tasks to see the current tasks",
		retryable: false,
		fields: { taskId: "t" },
	});
	const cause = new Error("boom");
	const full = new TaskMessageError("delivery-refused", { taskId: "t", target: "w", detail: "d" }, { cause }).toJSON();
	assert.deepEqual(full.fields, { taskId: "t", target: "w", detail: "d" });
	assert.deepEqual(full.cause, { name: "Error", message: "boom" });
});

test("a timeout error serializes its timing and phase after the base fields (#4521)", () => {
	const serialized = new TaskMessageTimeoutError({ ...timeoutFields, detail: "slow" }).toJSON();
	assert.equal(serialized.name, "TaskMessageTimeoutError");
	assert.deepEqual(serialized.fields, {
		taskId: "task-1",
		target: "worker-1",
		detail: "slow",
		timeoutMs: 100,
		elapsedMs: 120,
		phase: "delivery-acknowledgement",
	});
});

test("guards accept structural copies that keep name and code and reject others (#4521)", () => {
	assert.equal(isTaskMessageError({ name: "TaskMessageError", code: "task-unavailable" }), true);
	assert.equal(isTaskMessageError({ name: "TaskMessageTimeoutError", code: "delivery-unconfirmed" }), true);
	assert.equal(isTaskMessageError({ name: "Error", code: "task-unavailable" }), false);
	assert.equal(isTaskMessageError({ name: "TaskMessageError", code: "other" }), false);
	assert.equal(isTaskMessageTimeoutError({ name: "TaskMessageTimeoutError", code: "delivery-unconfirmed" }), true);
	assert.equal(isTaskMessageTimeoutError({ name: "TaskMessageError", code: "delivery-unconfirmed" }), false);
	assert.equal(isTaskMessageTimeoutError({ name: "TaskMessageTimeoutError", code: "delivery-refused" }), false);
	assert.equal(isTaskMessageTimeoutError({ name: "TaskMessageTimeoutError", code: "" }), false);
	assert.equal(isTaskMessageTimeoutError(new TaskMessageTimeoutError(timeoutFields)), true);
	assert.equal(isTaskMessageTimeoutError(new TaskMessageError("delivery-unconfirmed", { taskId: "t" })), false);
	assert.equal(isTaskMessageTimeoutError(null), false);
});

test("rehydrate gives undefined for non-objects, unknown codes and a missing task id (#4521)", () => {
	assert.equal(rehydrateTaskMessageError(null), undefined);
	assert.equal(rehydrateTaskMessageError("task-unavailable"), undefined);
	assert.equal(rehydrateTaskMessageError({ code: "nope", fields: { taskId: "t" } }), undefined);
	assert.equal(rehydrateTaskMessageError({ code: 7, fields: { taskId: "t" } }), undefined);
	assert.equal(rehydrateTaskMessageError({ code: "task-unavailable" }), undefined);
	assert.equal(rehydrateTaskMessageError({ code: "task-unavailable", fields: null }), undefined);
	assert.equal(rehydrateTaskMessageError({ code: "task-unavailable", fields: { taskId: 5 } }), undefined);
});

test("rehydrate keeps present fields, drops absent and non-string ones, and carries the cause (#4521)", () => {
	const bare = rehydrateTaskMessageError({
		code: "task-unavailable",
		fields: { taskId: "t", target: 3, detail: false },
	});
	assert.ok(bare instanceof TaskMessageError);
	assert.equal(bare.target, undefined);
	assert.equal(bare.detail, undefined);
	assert.equal(Object.hasOwn(bare, "cause"), false);
	const full = rehydrateTaskMessageError({
		code: "delivery-refused",
		fields: { taskId: "t", target: "w", detail: "d" },
		cause: { name: "RangeError", message: "bad", code: "E1" },
	});
	assert.ok(full instanceof TaskMessageError);
	assert.equal(full.target, "w");
	assert.equal(full.detail, "d");
	assert.equal((full.cause as Error).name, "RangeError");
	assert.equal((full.cause as Error).message, "bad");
});

test("rehydrate rebuilds a timeout error only with a target and a valid timeout (#4521)", () => {
	const timeout = rehydrateTaskMessageError({
		code: "delivery-unconfirmed",
		fields: { taskId: "t", target: "w", detail: "slow", timeoutMs: 50, elapsedMs: 70 },
		cause: { name: "Error", message: "late" },
	});
	assert.ok(timeout instanceof TaskMessageTimeoutError);
	assert.equal(timeout.target, "w");
	assert.equal(timeout.detail, "slow");
	assert.equal(timeout.timeoutMs, 50);
	assert.equal(timeout.elapsedMs, 70);
	assert.equal((timeout.cause as Error).message, "late");

	const noDetail = rehydrateTaskMessageError({
		code: "delivery-unconfirmed",
		fields: { taskId: "t", target: "w", timeoutMs: 50 },
	});
	assert.ok(noDetail instanceof TaskMessageTimeoutError);
	assert.equal(noDetail.detail, undefined);
	assert.equal(Object.hasOwn(noDetail, "cause"), false);
	assert.equal(noDetail.elapsedMs, 50);
});

test("rehydrate accepts zero milliseconds and rejects negative, NaN, infinite and non-number ones (#4521)", () => {
	const zero = rehydrateTaskMessageError({
		code: "delivery-unconfirmed",
		fields: { taskId: "t", target: "w", timeoutMs: 0, elapsedMs: 0 },
	}) as TaskMessageTimeoutError;
	assert.ok(zero instanceof TaskMessageTimeoutError);
	assert.equal(zero.timeoutMs, 0);
	assert.equal(zero.elapsedMs, 0);
	for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
		const plain = rehydrateTaskMessageError({
			code: "delivery-unconfirmed",
			fields: { taskId: "t", target: "w", timeoutMs: bad },
		});
		assert.equal(plain instanceof TaskMessageTimeoutError, false, `timeoutMs ${String(bad)}`);
		assert.ok(plain instanceof TaskMessageError);
		const fallback = rehydrateTaskMessageError({
			code: "delivery-unconfirmed",
			fields: { taskId: "t", target: "w", timeoutMs: 40, elapsedMs: bad },
		}) as TaskMessageTimeoutError;
		assert.equal(fallback.elapsedMs, 40, `elapsedMs ${String(bad)}`);
	}
});

test("a delivery-unconfirmed copy without target or timeout falls back to a plain error (#4521)", () => {
	const noTarget = rehydrateTaskMessageError({
		code: "delivery-unconfirmed",
		fields: { taskId: "t", timeoutMs: 5, detail: "d" },
	});
	assert.equal(noTarget instanceof TaskMessageTimeoutError, false);
	assert.equal(noTarget?.detail, "d");
	assert.equal(noTarget?.target, undefined);
	const noTimeout = rehydrateTaskMessageError({ code: "delivery-unconfirmed", fields: { taskId: "t", target: "w" } });
	assert.equal(noTimeout instanceof TaskMessageTimeoutError, false);
	assert.equal(noTimeout?.target, "w");
	const otherCode = rehydrateTaskMessageError({
		code: "delivery-refused",
		fields: { taskId: "t", target: "w", timeoutMs: 5 },
	});
	assert.equal(otherCode instanceof TaskMessageTimeoutError, false);
	assert.equal(otherCode?.code, "delivery-refused");
});

function relay() {
	const events = createEventBus();
	const sent: Array<{ requestId: string; to: string; message: string }> = [];
	events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (data) => sent.push(data as (typeof sent)[number]));
	return { events, sent };
}

test("a task transcript message ignores malformed and foreign acknowledgements and settles once (#4521)", async () => {
	const { events, sent } = relay();
	const pending = sendTaskTranscriptMessage(events, "worker-1", "hi");
	const requestId = sent[0]!.requestId;
	events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, null);
	events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, "text");
	events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: "other", delivered: true });
	events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId, delivered: false, error: "gone" });
	events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId, delivered: true });
	assert.deepEqual(await pending, { delivered: false, reason: "refused", detail: "gone" });
});

test("a task transcript message maps acknowledgements and unsubscribes after settling (#4521)", async () => {
	const { events, sent } = relay();
	const delivered = sendTaskTranscriptMessage(events, "worker-1", "hi");
	events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: sent[0]!.requestId, delivered: true });
	assert.deepEqual(await delivered, { delivered: true });
	assert.deepEqual(sent[0], { to: "worker-1", message: "hi", requestId: sent[0]!.requestId });

	const lost = sendTaskTranscriptMessage(events, "worker-1", "hi");
	events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
		requestId: sent[1]!.requestId,
		delivered: false,
		unconfirmed: true,
		error: 5,
	});
	assert.deepEqual(await lost, { delivered: false, reason: "lost" });

	let listeners = 0;
	const counting = {
		emit: events.emit.bind(events),
		on: (event: string, handler: (data: unknown) => void) => {
			listeners++;
			const off = events.on(event, handler);
			return () => {
				listeners--;
				off();
			};
		},
	};
	const third = sendTaskTranscriptMessage(counting, "worker-1", "hi");
	assert.equal(listeners, 1);
	events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: sent[2]!.requestId, delivered: true });
	await third;
	assert.equal(listeners, 0);
});

test("an unanswered task transcript message resolves unconfirmed with elapsed time from the injected clock (#4521)", async () => {
	vi.useFakeTimers();
	const { events, sent } = relay();
	let clock = 1000;
	const pending = sendTaskTranscriptMessage(events, "worker-1", "hi", { timeoutMs: 250, now: () => clock });
	clock = 1400;
	await vi.advanceTimersByTimeAsync(250);
	assert.deepEqual(await pending, { delivered: false, reason: "unconfirmed", timeoutMs: 250, elapsedMs: 400 });
	events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: sent[0]!.requestId, delivered: true });
});

test("a late timer after an acknowledgement does not resolve again, and an emit failure rejects once (#4521)", async () => {
	vi.useFakeTimers();
	const { events, sent } = relay();
	const acked = sendTaskTranscriptMessage(events, "worker-1", "hi", { timeoutMs: 50, now: () => 0 });
	events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: sent[0]!.requestId, delivered: true });
	await vi.advanceTimersByTimeAsync(100);
	assert.deepEqual(await acked, { delivered: true });

	const failure = new Error("no relay");
	const failing = {
		on: events.on.bind(events),
		emit: () => {
			throw failure;
		},
	};
	await assert.rejects(sendTaskTranscriptMessage(failing, "worker-1", "hi"), failure);
});

test("a task transcript message defaults its clock and works without timer unref (#4521)", async () => {
	vi.useFakeTimers();
	const { events } = relay();
	const pending = sendTaskTranscriptMessage(events, "worker-1", "hi", { timeoutMs: 10 });
	await vi.advanceTimersByTimeAsync(10);
	const result = await pending;
	assert.equal(result.delivered, false);
	assert.equal(typeof (result as { elapsedMs: number }).elapsedMs, "number");
});
