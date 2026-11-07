import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskMessageError } from "../../packages/coding-agent/src/core/tasks/message-error.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { parseInteractiveEngineCommand } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { PooledStageTaskSource } from "../../packages/workflows/src/workers/pooled-stage-task-source.js";
import { runStageTaskAction } from "../../packages/workflows/src/workers/stage-watch-tasks.js";
import type { PooledTaskReply } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { taskFixture } from "../helpers/task-projection.js";

const TASK = "task-1" as TaskId;

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function withTaskView(
	transcript: TaskTranscriptSource,
	check: (view: TaskViewSource, taskId: TaskId) => Promise<void> | void,
) {
	const fixture = taskFixture();
	try {
		await fixture.start("Transcript wiring");
		fixture.runners[0].context.bindTranscript(transcript);
		await check(ownerTaskViewSource(fixture.store), fixture.store.tasks[0]!.ref.taskId);
	} finally {
		await fixture.dispose();
	}
}

async function failureOf(promise: Promise<void>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

test("a page that cuts an assistant message keeps only the content blocks inside the page (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({
		role: "assistant",
		content: Array.from({ length: 101 }, (_, index) => ({ type: "text" as const, text: `block-${index}` })),
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		stopReason: "stop",
		timestamp: 1,
		usage,
	});
	await withTaskView(
		{ getSessionId: () => session.getSessionId(), getEntries: () => session.getEntries() },
		(view, taskId) => {
			const page = view.readTaskTranscript(taskId);
			assert.ok(!(page instanceof Promise) && page.ok);
			const [message] = page.value.messages;
			assert.ok(message?.role === "assistant");
			assert.equal(message.content.length, 100);
			assert.deepEqual(message.content[0], { type: "text", text: "block-1" });
		},
	);
});

test("a transcript that cannot report a compaction reason carries no compactionReason key (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	await withTaskView(
		{ getSessionId: () => session.getSessionId(), getEntries: () => session.getEntries() },
		(view, taskId) => {
			const page = view.readTaskTranscript(taskId);
			assert.ok(!(page instanceof Promise) && page.ok);
			assert.equal(Object.hasOwn(page.value, "compactionReason"), false);
			assert.equal(Object.hasOwn(page.value, "nextCursor"), false);
		},
	);
});

test("an unknown assistant content block is not referenced as a transcript item (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({
		role: "assistant",
		content: [{ type: "mystery" }, { type: "text", text: "kept" }] as never,
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		stopReason: "stop",
		timestamp: 1,
		usage,
	});
	await withTaskView(
		{ getSessionId: () => session.getSessionId(), getEntries: () => session.getEntries() },
		(view, taskId) => {
			const page = view.readTaskTranscript(taskId);
			assert.ok(!(page instanceof Promise) && page.ok);
			const [message] = page.value.messages;
			assert.ok(message?.role === "assistant");
			assert.deepEqual(message.content, [{ type: "text", text: "kept" }]);
		},
	);
});

test("a refused or lost delivery keeps the channel's detail and leaves it out when there is none (#4521)", async () => {
	const session = SessionManager.inMemory();
	for (const [delivery, code, detail] of [
		[{ delivered: false, reason: "refused", detail: "gone" }, "delivery-refused", "gone"],
		[{ delivered: false, reason: "lost" }, "delivery-unconfirmed", undefined],
	] as const) {
		await withTaskView(
			{
				getSessionId: () => session.getSessionId(),
				getEntries: () => session.getEntries(),
				completionSource: { runId: "run-1", intercomTarget: "worker-1" },
				sendMessage: async () => delivery,
			},
			async (view, taskId) => {
				const error = await failureOf(view.sendTaskMessage!(taskId, "hi"));
				assert.ok(error instanceof TaskMessageError);
				assert.equal(error.code, code);
				assert.equal(error.detail, detail);
				assert.equal(error.target, "worker-1");
				assert.equal(error.toJSON().fields.detail, detail);
			},
		);
	}
});

test("render requests accept a wheel step of exactly one line (#4521)", () => {
	for (const lines of [1, 1.5]) {
		const parsed = parseInteractiveEngineCommand(
			JSON.stringify({
				type: "engine_custom_render",
				componentId: "c",
				requestId: 1,
				width: 80,
				rows: 24,
				renderSettings: {
					hideThinkingBlock: false,
					toolOutputExpanded: false,
					fullscreenScrollbar: "auto",
					fullscreenWheelScrollLines: lines,
				},
			}),
		);
		assert.ok(parsed?.type === "engine_custom_render");
		assert.equal(parsed.renderSettings?.fullscreenWheelScrollLines, lines);
	}
});

test("a pooled stage task names the task in a refusal or a missing reply (#4521)", async () => {
	const refusal = new Error("paused");
	const refused = await failureOf(
		new PooledStageTaskSource(
			async () => {
				throw refusal;
			},
			() => true,
		).sendTaskMessage(TASK, "hi"),
	);
	assert.ok(refused instanceof TaskMessageError);
	assert.equal(refused.taskId, TASK);
	assert.equal(refused.toJSON().fields.taskId, TASK);
	assert.match(refused.message, /task-1/);
	const missing = await failureOf(new PooledStageTaskSource(async () => undefined).sendTaskMessage(TASK, "hi"));
	assert.ok(missing instanceof TaskMessageError);
	assert.equal(missing.taskId, TASK);
	assert.match(missing.message, /task-1/);
});

test("a pooled stage task reports an unrefused worker failure as unconfirmed (#4521)", async () => {
	const unretried = await failureOf(
		new PooledStageTaskSource(async () => {
			throw new Error("closed");
		}).sendTaskMessage(TASK, "hi"),
	);
	assert.ok(unretried instanceof TaskMessageError);
	assert.equal(unretried.code, "delivery-unconfirmed");
});

test("the worker names the task when messages are unsupported or the failure is untyped (#4521)", async () => {
	const unsupported = (await runStageTaskAction({} as TaskViewSource, TASK, {
		kind: "message",
		text: "hi",
	})) as Extract<PooledTaskReply, { kind: "message" }>;
	assert.equal(unsupported.error?.code, "messages-unsupported");
	assert.equal(unsupported.error?.fields.taskId, TASK);
	const crash = new Error("relay crashed");
	const untyped = (await runStageTaskAction(
		{
			sendTaskMessage: async () => {
				throw crash;
			},
		} as unknown as TaskViewSource,
		TASK,
		{ kind: "message", text: "hi" },
	)) as Extract<PooledTaskReply, { kind: "message" }>;
	assert.equal(untyped.error?.code, "delivery-unconfirmed");
	assert.equal(untyped.error?.fields.taskId, TASK);
	assert.deepEqual(untyped.error?.cause, { name: "Error", message: "relay crashed" });
});
