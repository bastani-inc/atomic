import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionManager, type SessionMessageEntry } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskMessageError } from "../../packages/coding-agent/src/core/tasks/message-error.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { parseInteractiveEngineCommand } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";

import { taskFixture } from "../helpers/task-projection.js";

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

test("a reopened task includes shell output, displayed notices and the error of an unreadable reply (#5613)", async () => {
	const shell = {
		role: "bashExecution" as const,
		command: "echo hello",
		output: "hello",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	};
	const warning = {
		role: "custom" as const,
		customType: "warning",
		content: "retry notice",
		display: true,
		timestamp: 2,
	};
	const summary = { role: "branchSummary" as const, summary: "previous turn", fromId: null, timestamp: 3 };
	const failure = {
		role: "assistant" as const,
		content: [{ type: "unrecognized" }] as never,
		api: "openai-completions" as const,
		provider: "fixture",
		model: "fixture",
		errorMessage: "529 overloaded",
		stopReason: "error" as const,
		timestamp: 4,
		usage,
	};
	const entries = [shell, warning, { ...warning, display: false }, summary, failure].map(
		(message, index): SessionMessageEntry => ({
			type: "message",
			id: `m${index}`,
			parentId: index ? `m${index - 1}` : null,
			timestamp: new Date(index).toISOString(),
			message,
		}),
	);
	await withTaskView({ getSessionId: () => "saved", getEntries: () => entries }, async (view, taskId) => {
		const page = await view.readTaskTranscript(taskId);
		assert.ok(page.ok);
		assert.deepEqual(page.value.messages, [shell, warning, summary, { ...failure, content: [] }]);
	});
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
				queueMessage: async () => delivery,
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
