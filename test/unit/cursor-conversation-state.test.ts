import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { CursorConversationStateStore } from "../../packages/cursor/src/conversation-state.js";
import type { CursorRunStream, CursorServerMessage, CursorToolResultMessage, CursorTransportLifecycleSnapshot, CursorWriteOptions } from "../../packages/cursor/src/transport.js";

const toolCall: Extract<CursorServerMessage, { readonly type: "toolCall" }> = {
	type: "toolCall",
	id: "tool-1",
	name: "Read",
	argumentsJson: "{\"path\":\"README.md\"}",
};

function emptyMessages(): AsyncIterable<CursorServerMessage> {
	return (async function* (): AsyncIterable<CursorServerMessage> {})();
}

function toolResult(toolCallId = "tool-1"): CursorToolResultMessage {
	return { toolCallId, toolName: "Read", text: "file contents", isError: false };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class CountingStream implements CursorRunStream {
	readonly messages = emptyMessages();
	cancelCalls = 0;
	closeCalls = 0;
	constructor(readonly id: string, readonly rejectCancel = false) {}
	async writeToolResult(_result: CursorToolResultMessage, _options?: CursorWriteOptions): Promise<void> {}
	async cancel(): Promise<void> {
		this.cancelCalls += 1;
		if (this.rejectCancel) throw new Error(`cancel failed ${this.id}`);
	}
	async close(): Promise<void> {
		this.closeCalls += 1;
	}
}

class StalledWriteStream extends CountingStream {
	#rejectWrite: ((error: Error) => void) | undefined;
	override async writeToolResult(_result: CursorToolResultMessage, _options?: CursorWriteOptions): Promise<void> {
		await new Promise<void>((_resolve, reject) => {
			this.#rejectWrite = reject;
		});
	}
	override async cancel(): Promise<void> {
		await super.cancel();
		this.#rejectWrite?.(new Error("write cancelled by cleanup"));
		this.#rejectWrite = undefined;
	}
}

describe("CursorConversationStateStore", () => {
	test("keeps paused-turn cleanup armed while tool-result resume writes are pending", async () => {
		const store = new CursorConversationStateStore();
		const stream = new StalledWriteStream("stalled-resume");
		store.registerTurn("conversation-1", stream);
		store.pauseTurnForTools("conversation-1", stream, [toolCall], { idleTimeoutMs: 1 });

		await assert.rejects(
			() => store.resumeTurnWithToolResults("conversation-1", [toolResult()]),
			/write cancelled by cleanup/u,
		);

		assert.equal(stream.cancelCalls, 1);
		assert.equal(store.activeTurns, 0);
	});

	test("clears pending tool calls after a successful resume", async () => {
		const store = new CursorConversationStateStore();
		const stream = new CountingStream("resume-once");
		store.registerTurn("conversation-resume", stream);
		store.pauseTurnForTools("conversation-resume", stream, [toolCall]);

		await store.resumeTurnWithToolResults("conversation-resume", [toolResult()]);

		await assert.rejects(
			() => store.resumeTurnWithToolResults("conversation-resume", [toolResult()]),
			/does not match a paused tool call/u,
		);
		assert.equal(store.activeTurns, 0);
		assert.equal(stream.cancelCalls, 1);
	});

	test("registerTurn disarms and cancels an existing same-conversation turn before replacing it", async () => {
		const store = new CursorConversationStateStore();
		const oldStream = new CountingStream("old");
		const newStream = new CountingStream("new");
		store.registerTurn("conversation-2", oldStream);
		store.pauseTurnForTools("conversation-2", oldStream, [toolCall], { idleTimeoutMs: 1 });

		store.registerTurn("conversation-2", newStream);
		await sleep(10);

		assert.equal(oldStream.cancelCalls, 1);
		assert.equal(newStream.cancelCalls, 0);
		assert.equal(store.activeTurns, 1);
	});

	test("paused-turn abort idle and replacement cleanup catch cancel rejections", async () => {
		const unhandledReasons: string[] = [];
		const onUnhandled = (reason: {} | null | undefined): void => {
			unhandledReasons.push(String(reason));
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const store = new CursorConversationStateStore();
			const abortController = new AbortController();
			const abortStream = new CountingStream("abort", true);
			store.registerTurn("abort-conversation", abortStream);
			store.pauseTurnForTools("abort-conversation", abortStream, [toolCall], { signal: abortController.signal });
			abortController.abort();

			const idleStream = new CountingStream("idle", true);
			store.registerTurn("idle-conversation", idleStream);
			store.pauseTurnForTools("idle-conversation", idleStream, [toolCall], { idleTimeoutMs: 1 });

			const replacedStream = new CountingStream("replaced", true);
			const replacementStream = new CountingStream("replacement");
			store.registerTurn("replace-conversation", replacedStream);
			store.pauseTurnForTools("replace-conversation", replacedStream, [toolCall], { idleTimeoutMs: 50 });
			store.registerTurn("replace-conversation", replacementStream);

			await sleep(20);

			assert.equal(abortStream.cancelCalls, 1);
			assert.equal(idleStream.cancelCalls, 1);
			assert.equal(replacedStream.cancelCalls, 1);
			assert.deepEqual(unhandledReasons, []);
			const snapshot: CursorTransportLifecycleSnapshot = { openStreams: 0, cancelledStreams: 0, closedStreams: 0 };
			assert.equal(store.snapshot(snapshot).activeTurns, 1);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
