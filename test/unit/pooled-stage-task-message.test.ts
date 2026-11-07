import assert from "node:assert/strict";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskMessageError, TaskMessageTimeoutError } from "../../packages/coding-agent/src/core/tasks/message-error.js";
import type { TaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { PooledStageTaskSource } from "../../packages/workflows/src/workers/pooled-stage-task-source.js";
import { runStageTaskAction } from "../../packages/workflows/src/workers/stage-watch-tasks.js";
import type { PooledTaskAction, PooledTaskReply } from "../../packages/workflows/src/workers/stage-watch-types.js";

const TASK = "task-1" as TaskId;

async function failureOf(promise: Promise<void>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

test("a message typed into a worker stage's task transcript runs on the worker and resolves once delivered (#4521)", async () => {
	const actions: Array<{ taskId: TaskId; action: PooledTaskAction }> = [];
	const source = new PooledStageTaskSource(async (taskId, action) => {
		actions.push({ taskId, action });
		return { kind: "message" };
	});
	assert.equal(await failureOf(source.sendTaskMessage(TASK, "continue with the tests")), undefined);
	assert.deepEqual(actions, [{ taskId: TASK, action: { kind: "message", text: "continue with the tests" } }]);
});

test("the worker's typed refusal comes back to the root as the same error (#4521)", async () => {
	const refused = new TaskMessageError("delivery-refused", { taskId: TASK, target: "worker-1", detail: "gone" });
	const timeout = new TaskMessageTimeoutError({
		taskId: TASK,
		target: "worker-1",
		timeoutMs: 10_000,
		elapsedMs: 10_001,
	});
	for (const sent of [refused, timeout]) {
		const source = new PooledStageTaskSource(async () => ({
			kind: "message",
			error: JSON.parse(JSON.stringify(sent.toJSON())),
		}));
		const error = await failureOf(source.sendTaskMessage(TASK, "hello"));
		assert.ok(error instanceof TaskMessageError);
		assert.equal(error.constructor, sent.constructor);
		assert.equal(error.code, sent.code);
		assert.equal(error.target, "worker-1");
		assert.equal(error.message, sent.message);
	}
	const unknown = new PooledStageTaskSource(async () => ({
		kind: "message",
		error: { ...refused.toJSON(), code: "invented" } as unknown as ReturnType<TaskMessageError["toJSON"]>,
	}));
	const fallback = await failureOf(unknown.sendTaskMessage(TASK, "hello"));
	assert.ok(fallback instanceof TaskMessageError);
	assert.equal(fallback.code, "delivery-unconfirmed", "an unreadable answer may follow a delivered message");
	assert.equal(fallback.retryable, false);
	assert.equal(fallback.detail, "unreadable reply from the local worker");
});

test("a worker that lost the task, answered something else, or failed to answer is a typed failure (#4521)", async () => {
	const refusal = new Error("the pool is paused");
	const refusedSource = new PooledStageTaskSource(
		async () => {
			throw refusal;
		},
		(error) => error === refusal,
	);
	const refused = await failureOf(refusedSource.sendTaskMessage(TASK, "hello"));
	assert.ok(refused instanceof TaskMessageError);
	assert.equal(refused.code, "delivery-refused", "a refusal before the worker ran the action can be sent again");
	assert.equal(refused.retryable, true);
	assert.equal(refused.cause, refusal);
	const missing = await failureOf(new PooledStageTaskSource(async () => undefined).sendTaskMessage(TASK, "hello"));
	assert.ok(missing instanceof TaskMessageError);
	assert.equal(missing.code, "task-unavailable");
	const wrong = await failureOf(
		new PooledStageTaskSource(async () => ({ kind: "detail", detail: {} }) as PooledTaskReply).sendTaskMessage(
			TASK,
			"hello",
		),
	);
	assert.ok(wrong instanceof TaskMessageError);
	assert.equal(wrong.code, "delivery-unconfirmed");
	assert.equal(wrong.detail, "unexpected reply from the local worker");
	const cause = new Error("worker connection closed");
	const broken = await failureOf(
		new PooledStageTaskSource(async () => {
			throw cause;
		}).sendTaskMessage(TASK, "hello"),
	);
	assert.ok(broken instanceof TaskMessageError);
	assert.equal(broken.code, "delivery-unconfirmed", "a lost answer may follow a delivered message");
	assert.equal(broken.retryable, false);
	assert.equal(broken.detail, "the local worker did not answer");
	assert.equal(broken.cause, cause);
});

function workerSource(overrides: Partial<TaskViewSource>): TaskViewSource {
	return overrides as TaskViewSource;
}

test("the worker answers a message action with nothing, or with the task's typed failure as data (#4521)", async () => {
	const delivered: string[] = [];
	assert.deepEqual(
		await runStageTaskAction(
			workerSource({
				sendTaskMessage: async (_id, text) => {
					delivered.push(text);
				},
			}),
			TASK,
			{ kind: "message", text: "hello" },
		),
		{ kind: "message" },
	);
	assert.deepEqual(delivered, ["hello"]);

	const refused = new TaskMessageError("delivery-refused", { taskId: TASK, target: "worker-1" });
	const reply = await runStageTaskAction(
		workerSource({
			sendTaskMessage: async () => {
				throw new Error("wrapped", { cause: refused });
			},
		}),
		TASK,
		{ kind: "message", text: "hello" },
	);
	assert.deepEqual(reply, { kind: "message", error: refused.toJSON() });

	const untyped = await runStageTaskAction(
		workerSource({
			sendTaskMessage: async () => {
				throw new Error("relay crashed");
			},
		}),
		TASK,
		{ kind: "message", text: "hello" },
	);
	assert.equal(untyped.kind, "message");
	assert.equal(untyped.kind === "message" ? untyped.error?.code : undefined, "delivery-unconfirmed");
	assert.equal(untyped.kind === "message" ? untyped.error?.cause?.message : undefined, "relay crashed");

	const unsupported = await runStageTaskAction(workerSource({}), TASK, { kind: "message", text: "hello" });
	assert.equal(unsupported.kind === "message" ? unsupported.error?.code : undefined, "messages-unsupported");
});

test("a worker stage's latest transcript page carries the streaming reply with its thinking (#4521)", async () => {
	const streaming = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "planning the fix" },
			{ type: "text", text: "Working on it" },
		],
	} as AssistantMessage;
	const reply = await runStageTaskAction(
		workerSource({
			readTaskTranscript: () => ({ ok: true, value: { messages: [] } }),
			followTaskTranscript: () => ({
				historyOnly: false,
				session: { getSessionId: () => "s", getEntries: () => [], getStreamingMessage: () => streaming },
			}),
		}),
		TASK,
		{ kind: "transcript" },
	);
	assert.equal(reply.kind, "transcript");
	assert.deepEqual(reply.kind === "transcript" && reply.result.ok ? reply.result.value.messages : [], [streaming]);
});
