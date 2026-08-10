import assert from "node:assert/strict";
import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { describe, test } from "vitest";
import {
	applyTranscriptProgress,
	applyTranscriptSnapshot,
	createTranscriptState,
	selectTranscript,
} from "../../src/client/transcript.ts";

function snapshot(revision: number, text = "saved"): SessionSnapshot {
	return {
		id: "session-1",
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: revision + 1,
		phase: "turn",
		model: { provider: "faux", id: "faux-1" },
		thinkingLevel: "off",
		attached: true,
		locked: true,
		revision,
		transcript: [
			{
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "text", text }],
				status: "streaming",
				model: { provider: "faux", id: "faux-1" },
				timestamp: 1,
			},
		],
		queuedSteer: [],
		queuedSteerCount: 0,
	};
}

describe("remote transcript projection", () => {
	test("projects progress without mutating the authoritative snapshot", () => {
		let state = createTranscriptState(snapshot(1));
		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: " response",
		});

		assert.deepEqual(state.snapshot.transcript[0]?.content, [{ type: "text", text: "saved" }]);
		assert.deepEqual(selectTranscript(state)[0]?.content, [{ type: "text", text: "saved response" }]);
	});

	test("applies streamed tool-call argument deltas", () => {
		let state = createTranscriptState({
			...snapshot(1),
			transcript: [
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: null }],
					status: "streaming",
					model: { provider: "faux", id: "faux-1" },
					timestamp: 1,
				},
			],
		});
		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "toolCall",
			delta: '{"command":',
		});
		const firstItem = selectTranscript(state)[0];
		assert.equal(firstItem?.role, "assistant");
		if (firstItem?.role === "assistant")
			assert.deepEqual(firstItem.content, [
				{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: '{"command":' },
			]);

		state = applyTranscriptProgress(state, {
			type: "item_updated",
			item: {
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: null }],
				status: "streaming",
				model: { provider: "faux", id: "faux-1" },
				timestamp: 1,
			},
		});
		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "toolCall",
			delta: '"pwd"}',
		});
		const finalItem = selectTranscript(state)[0];
		assert.equal(finalItem?.role, "assistant");
		if (finalItem?.role === "assistant")
			assert.deepEqual(finalItem.content, [
				{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "pwd" } },
			]);
	});

	test("appends tool-call deltas to a partial input restored from a snapshot", () => {
		let state = createTranscriptState({
			...snapshot(1),
			transcript: [
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: '{"command":' }],
					status: "streaming",
					model: { provider: "faux", id: "faux-1" },
					timestamp: 1,
				},
			],
		});

		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "toolCall",
			delta: '"pwd"}',
		});

		const item = selectTranscript(state)[0];
		assert.equal(item?.role, "assistant");
		if (item?.role === "assistant")
			assert.deepEqual(item.content, [
				{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "pwd" } },
			]);
	});

	test("appends transient tool progress and replaces it by id", () => {
		let state = createTranscriptState(snapshot(1));
		state = applyTranscriptProgress(state, {
			type: "item_started",
			item: {
				id: "tool-call-1",
				role: "tool",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "printf hi" },
				content: [],
				status: "running",
				isError: false,
				timestamp: 2,
			},
		});
		assert.deepEqual(selectTranscript(state).at(-1), {
			id: "tool-call-1",
			role: "tool",
			toolCallId: "call-1",
			toolName: "bash",
			input: { command: "printf hi" },
			content: [],
			status: "running",
			isError: false,
			timestamp: 2,
		});
		state = applyTranscriptProgress(state, {
			type: "item_updated",
			item: {
				id: "tool-call-1",
				role: "tool",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "printf hi" },
				content: [{ type: "text", text: "hi" }],
				status: "running",
				isError: false,
				timestamp: 2,
			},
		});

		const transcript = selectTranscript(state);
		assert.equal(transcript.length, 2);
		assert.deepEqual(transcript[1], {
			id: "tool-call-1",
			role: "tool",
			toolCallId: "call-1",
			toolName: "bash",
			input: { command: "printf hi" },
			content: [{ type: "text", text: "hi" }],
			status: "running",
			isError: false,
			timestamp: 2,
		});
	});

	test("resets revision history when the same session runtime is reacquired", () => {
		// `applyTranscriptSnapshot` is the unit under test: it drops a snapshot whose
		// revision moved BACKWARDS for the same session id, treating it as stale,
		// unless the runtime was reacquired. Calling `createTranscriptState` twice
		// would assert nothing — a state built from a revision-0 snapshot trivially
		// reports revision 0 — so the reacquire path has to go through apply.
		const previous = createTranscriptState(snapshot(50, "old runtime"));
		const state = applyTranscriptSnapshot(previous, { ...snapshot(0, "new runtime"), id: "session-2" });

		assert.equal(state.snapshot.revision, 0);
		assert.deepEqual(selectTranscript(state)[0]?.content, [{ type: "text", text: "new runtime" }]);
	});

	test("accepts a lower revision when switching to a different session", () => {
		let state = createTranscriptState(snapshot(50, "old session"));
		state = applyTranscriptSnapshot(state, { ...snapshot(0, "new session"), id: "session-2" });

		assert.equal(state.snapshot.id, "session-2");
		assert.deepEqual(selectTranscript(state)[0]?.content, [{ type: "text", text: "new session" }]);
	});

	test("renders accepted steering messages from authoritative queued state", () => {
		const state = createTranscriptState({
			...snapshot(2),
			queuedSteerCount: 1,
			queuedSteer: [
				{
					id: "user-steer",
					role: "user",
					content: [{ type: "text", text: "adjust the approach" }],
					timestamp: 2,
				},
			],
		});

		assert.deepEqual(selectTranscript(state).at(-1), {
			id: "user-steer",
			role: "user",
			content: [{ type: "text", text: "adjust the approach" }],
			timestamp: 2,
		});
	});

	test("a newer snapshot is authoritative and stale snapshots are ignored", () => {
		let state = createTranscriptState(snapshot(3, "new"));
		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: " transient",
		});
		state = applyTranscriptSnapshot(state, snapshot(4, "authoritative"));
		state = applyTranscriptSnapshot(state, snapshot(2, "stale"));

		assert.equal(state.snapshot.revision, 4);
		assert.deepEqual(selectTranscript(state)[0]?.content, [{ type: "text", text: "authoritative" }]);
	});
});
