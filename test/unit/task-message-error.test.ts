import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	findTaskMessageError,
	isTaskMessageError,
	isTaskMessageTimeoutError,
	rehydrateTaskMessageError,
	TaskMessageError,
	TaskMessageTimeoutError,
} from "../../packages/coding-agent/src/core/tasks/message-error.js";
import type {
	TaskMessageDelivery,
	TaskTranscriptSource,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	sendTaskTranscriptMessage,
	TASK_MESSAGE_ACKNOWLEDGEMENT_TIMEOUT_MS,
} from "../../packages/subagents/src/intercom/task-message.js";
import {
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../../packages/subagents/src/shared/types.js";
import { taskFixture } from "../helpers/task-projection.js";

afterEach(() => {
	vi.useRealTimers();
});

/** Sends through the public task view of a task whose transcript is `transcript`. */
async function sendThroughOwner(transcript: TaskTranscriptSource | undefined, text = "keep going") {
	const fixture = taskFixture();
	try {
		await fixture.start("Message target");
		if (transcript) fixture.runners[0].context.bindTranscript(transcript);
		const taskId = fixture.store.tasks[0]!.ref.taskId;
		const source = ownerTaskViewSource(fixture.store);
		try {
			await source.sendTaskMessage!(taskId, text);
			return { taskId, error: undefined };
		} catch (error) {
			return { taskId, error };
		}
	} finally {
		await fixture.dispose();
	}
}

function intercomTranscript(send?: (text: string) => Promise<TaskMessageDelivery>): TaskTranscriptSource {
	const session = SessionManager.inMemory();
	return {
		getSessionId: () => session.getSessionId(),
		getEntries: () => session.getEntries(),
		completionSource: { runId: "run-1", intercomTarget: "worker-1" },
		...(send === undefined ? {} : { sendMessage: send }),
	};
}

test("a delivered message resolves and reaches the task's channel verbatim (#4521)", async () => {
	const sent: string[] = [];
	const result = await sendThroughOwner(
		intercomTranscript(async (text) => {
			sent.push(text);
			return { delivered: true };
		}),
		"  /steer exactly as typed  ",
	);
	assert.equal(result.error, undefined);
	assert.deepEqual(sent, ["  /steer exactly as typed  "]);
});

test("an unknown task is task-unavailable (#4521)", async () => {
	const fixture = taskFixture();
	try {
		const source = ownerTaskViewSource(fixture.store);
		const error = await source.sendTaskMessage!("missing" as TaskId, "hello").then(
			() => undefined,
			(failure: unknown) => failure,
		);
		assert.ok(error instanceof TaskMessageError);
		assert.equal(error.code, "task-unavailable");
		assert.equal(error.taskId, "missing");
		assert.equal(error.retryable, false);
		assert.equal(error.hint, "Run /tasks to see the current tasks");
	} finally {
		await fixture.dispose();
	}
});

test("a task without an Intercom channel is messages-unsupported (#4521)", async () => {
	const session = SessionManager.inMemory();
	const cases: Array<TaskTranscriptSource | undefined> = [
		undefined,
		session,
		{ ...intercomTranscript(), completionSource: undefined },
		intercomTranscript(),
		{
			getSessionId: () => session.getSessionId(),
			getEntries: () => session.getEntries(),
			sendMessage: async () => ({ delivered: true }),
		},
	];
	for (const transcript of cases) {
		const { error, taskId } = await sendThroughOwner(transcript);
		assert.ok(isTaskMessageError(error));
		assert.equal(error.code, "messages-unsupported");
		assert.equal(error.taskId, taskId);
		assert.equal(error.target, undefined);
		assert.equal(error.retryable, false);
	}
});

test("a refusal is delivery-refused, retryable, and names the target and the channel's reason (#4521)", async () => {
	const { error, taskId } = await sendThroughOwner(
		intercomTranscript(async () => ({ delivered: false, reason: "refused", detail: "Session may not exist" })),
	);
	assert.ok(error instanceof TaskMessageError);
	assert.equal(error.code, "delivery-refused");
	assert.equal(error.retryable, true);
	assert.equal(error.target, "worker-1");
	assert.equal(error.detail, "Session may not exist");
	assert.equal(error.taskId, taskId);
	assert.equal(
		error.message,
		"Intercom did not deliver the message: worker-1 (delivery-refused): Session may not exist. Check that the agent is still available, then send the message again.",
	);
	const bare = await sendThroughOwner(intercomTranscript(async () => ({ delivered: false, reason: "refused" })));
	assert.ok(bare.error instanceof TaskMessageError);
	assert.equal(bare.error.detail, undefined);
});

test("a channel that throws is delivery-refused with the failure as its cause (#4521)", async () => {
	const failure = new Error("relay unavailable");
	const { error } = await sendThroughOwner(
		intercomTranscript(async () => {
			throw failure;
		}),
	);
	assert.ok(error instanceof TaskMessageError);
	assert.equal(error.code, "delivery-refused");
	assert.equal(error.cause, failure);
	assert.equal(findTaskMessageError(new Error("wrapper", { cause: error })), error);
	assert.equal(findTaskMessageError(new Error("unrelated")), undefined);
});

test("an unacknowledged message is a typed timeout that is not retryable (#4521)", async () => {
	const { error, taskId } = await sendThroughOwner(
		intercomTranscript(async () => ({
			delivered: false,
			reason: "unconfirmed",
			timeoutMs: 10_000,
			elapsedMs: 10_004,
		})),
	);
	assert.ok(error instanceof TaskMessageTimeoutError);
	assert.ok(isTaskMessageTimeoutError(error));
	assert.ok(isTaskMessageError(error));
	assert.equal(error.name, "TaskMessageTimeoutError");
	assert.equal(error.code, "delivery-unconfirmed");
	assert.equal(error.retryable, false);
	assert.equal(error.timeoutMs, 10_000);
	assert.equal(error.elapsedMs, 10_004);
	assert.equal(error.phase, "delivery-acknowledgement");
	assert.equal(error.target, "worker-1");
	assert.equal(error.taskId, taskId);
});

test("task message errors cross a process boundary as data and come back typed (#4521)", () => {
	const refused = new TaskMessageError(
		"delivery-refused",
		{ taskId: "task-1", target: "worker-1", detail: "gone" },
		{ cause: new Error("socket closed") },
	);
	const back = rehydrateTaskMessageError(JSON.parse(JSON.stringify(refused)));
	assert.ok(back instanceof TaskMessageError);
	assert.ok(!(back instanceof TaskMessageTimeoutError));
	assert.equal(back.code, "delivery-refused");
	assert.equal(back.taskId, "task-1");
	assert.equal(back.target, "worker-1");
	assert.equal(back.detail, "gone");
	assert.equal(back.retryable, true);
	assert.equal(back.message, refused.message);
	assert.equal((back.cause as Error).message, "socket closed");

	const timeout = new TaskMessageTimeoutError({ taskId: "task-2", target: "worker-2", timeoutMs: 50, elapsedMs: 51 });
	const timeoutBack = rehydrateTaskMessageError(JSON.parse(JSON.stringify(timeout)));
	assert.ok(timeoutBack instanceof TaskMessageTimeoutError);
	assert.equal(timeoutBack.timeoutMs, 50);
	assert.equal(timeoutBack.elapsedMs, 51);
	assert.equal(timeoutBack.target, "worker-2");
	assert.equal(timeoutBack.cause, undefined);

	const plain = JSON.parse(JSON.stringify(new TaskMessageError("messages-unsupported", { taskId: "task-3" })));
	assert.ok(isTaskMessageError(plain), "the guard recognizes a copy by name and code");
	assert.ok(!isTaskMessageTimeoutError(plain));
	assert.equal(rehydrateTaskMessageError(plain)?.code, "messages-unsupported");
	assert.equal(rehydrateTaskMessageError({ ...plain, code: "invented" }), undefined);
	assert.equal(rehydrateTaskMessageError({ ...plain, fields: {} }), undefined);
	assert.equal(rehydrateTaskMessageError(null), undefined);
	assert.equal(rehydrateTaskMessageError("TaskMessageError"), undefined);
	assert.ok(!isTaskMessageError({ name: "TaskMessageError", code: "invented" }));
	assert.ok(!isTaskMessageError({ name: "Error", code: "delivery-refused" }));
});

test("the Intercom relay delivers a typed message to the child target and reports its acknowledgement (#4521)", async () => {
	const events = createEventBus();
	const requests: Array<{ to: string; message: string; requestId: string }> = [];
	events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
		const request = payload as { to: string; message: string; requestId: string };
		requests.push(request);
		events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: "someone-else", delivered: false });
		events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: request.requestId, delivered: true });
	});
	assert.deepEqual(await sendTaskTranscriptMessage(events, "worker-1", "hello child"), { delivered: true });
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.to, "worker-1");
	assert.equal(requests[0]?.message, "hello child");
	assert.match(requests[0]?.requestId ?? "", /^[0-9a-f-]{36}$/);
});

test("the Intercom relay reports a refusal with its reason (#4521)", async () => {
	const events = createEventBus();
	events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
		const { requestId } = payload as { requestId: string };
		events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, null);
		events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId, delivered: false, error: "not connected" });
	});
	assert.deepEqual(await sendTaskTranscriptMessage(events, "worker-1", "hello"), {
		delivered: false,
		reason: "refused",
		detail: "not connected",
	});
	const quiet = createEventBus();
	quiet.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
		quiet.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
			requestId: (payload as { requestId: string }).requestId,
			delivered: "yes",
		});
	});
	assert.deepEqual(await sendTaskTranscriptMessage(quiet, "worker-1", "hello"), {
		delivered: false,
		reason: "refused",
	});
});

test("an Intercom relay that never answers is unconfirmed after the acknowledgement bound (#4521)", async () => {
	vi.useFakeTimers();
	const events = createEventBus();
	let now = 100;
	const pending = sendTaskTranscriptMessage(events, "worker-1", "hello", { now: () => now });
	now = 100 + TASK_MESSAGE_ACKNOWLEDGEMENT_TIMEOUT_MS + 3;
	await vi.advanceTimersByTimeAsync(TASK_MESSAGE_ACKNOWLEDGEMENT_TIMEOUT_MS);
	assert.deepEqual(await pending, {
		delivered: false,
		reason: "unconfirmed",
		timeoutMs: TASK_MESSAGE_ACKNOWLEDGEMENT_TIMEOUT_MS,
		elapsedMs: TASK_MESSAGE_ACKNOWLEDGEMENT_TIMEOUT_MS + 3,
	});
	const late = createEventBus();
	const answered = sendTaskTranscriptMessage(late, "worker-1", "hello", { timeoutMs: 5 });
	await vi.advanceTimersByTimeAsync(4);
	late.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: "other", delivered: true });
	await vi.advanceTimersByTimeAsync(1);
	assert.equal((await answered).delivered, false);
});

test("a relay that cannot take the message rejects and stops listening (#4521)", async () => {
	const failure = new Error("event bus closed");
	let listeners = 0;
	const events = {
		on: () => {
			listeners++;
			return () => {
				listeners--;
			};
		},
		emit: () => {
			throw failure;
		},
	};
	await assert.rejects(sendTaskTranscriptMessage(events, "worker-1", "hello"), (error) => error === failure);
	assert.equal(listeners, 0);
});
