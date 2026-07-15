import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { CursorConversationStateStore } from "../../packages/cursor/src/conversation-state.js";
import type { CursorAuthorizedRoute } from "../../packages/cursor/src/execution-authority.js";
import type { CursorRunStream, CursorServerMessage, CursorToolResultMessage, CursorTransportLifecycleSnapshot, CursorWriteOptions } from "../../packages/cursor/src/transport.js";

const toolCall: Extract<CursorServerMessage, { readonly type: "toolCall" }> = {
	type: "toolCall",
	id: "tool-1",
	name: "Read",
	argumentsJson: "{\"path\":\"README.md\"}",
};
const secondToolCall: Extract<CursorServerMessage, { readonly type: "toolCall" }> = {
	type: "toolCall",
	id: "tool-2",
	name: "Read",
	argumentsJson: "{\"path\":\"AGENTS.md\"}",
};

function emptyMessages(): AsyncIterable<CursorServerMessage> {
	return (async function* (): AsyncIterable<CursorServerMessage> {})();
}

function toolResult(toolCallId = "tool-1"): CursorToolResultMessage {
	return { toolCallId, toolName: "Read", text: "file contents", isError: false };
}

const authoritySignal = new AbortController().signal;
const authority: CursorAuthorizedRoute = {
	modelId: "composer-2",
	maxMode: false,
	supportsImages: false,
	authorityLease: Symbol("conversation-test-authority"),
	authoritySignal,
	credentialScope: "conversation-test-scope",
	catalogGeneration: 1,
	assertCurrent() {},
};

function revocableAuthority(onValidCheck?: (count: number, revoke: (reason?: Error) => void) => void): {
	readonly route: CursorAuthorizedRoute;
	revoke(reason?: Error): void;
} {
	let valid = true;
	let checks = 0;
	const controller = new AbortController();
	const revoke = (reason = new Error("test authority revoked")): void => {
		valid = false;
		if (!controller.signal.aborted) controller.abort(reason);
	};
	return {
		route: {
			modelId: "composer-2",
			maxMode: false,
			supportsImages: false,
			authorityLease: Symbol("revocable-conversation-authority"),
			authoritySignal: controller.signal,
			credentialScope: "conversation-test-scope",
			catalogGeneration: 1,
			assertCurrent() {
				if (!valid) throw new Error("test authority is no longer current");
				checks += 1;
				onValidCheck?.(checks, revoke);
			},
		},
		revoke,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class CountingStream implements CursorRunStream {
	readonly messages = emptyMessages();
	cancelCalls = 0;
	closeCalls = 0;
	writeCalls = 0;
	constructor(readonly id: string, readonly rejectCancel = false) {}
	async writeToolResult(_result: CursorToolResultMessage, _options?: CursorWriteOptions): Promise<void> {
		this.writeCalls += 1;
	}
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

class StalledCancelStream extends CountingStream {
	readonly cancelStarted = Promise.withResolvers<void>();
	readonly releaseCancel = Promise.withResolvers<void>();
	override async cancel(): Promise<void> {
		this.cancelCalls += 1;
		this.cancelStarted.resolve();
		await this.releaseCancel.promise;
	}
}

class RevokingWriteStream extends CountingStream {
	readonly written: string[] = [];
	constructor(id: string, readonly revoke: () => void) { super(id); }
	override async writeToolResult(result: CursorToolResultMessage, _options?: CursorWriteOptions): Promise<void> {
		this.written.push(result.toolCallId);
		if (this.written.length === 1) this.revoke();
	}
}

describe("CursorConversationStateStore", () => {
	test("keeps paused-turn cleanup armed while tool-result resume writes are pending", async () => {
		const store = new CursorConversationStateStore();
		const stream = new StalledWriteStream("stalled-resume");
		store.registerTurn("conversation-1", stream, authority);
		store.pauseTurnForTools("conversation-1", stream, [toolCall], { authority, idleTimeoutMs: 1 });

		await assert.rejects(
			() => store.resumeTurnWithToolResults("conversation-1", [toolResult()], { authority }),
			/write cancelled by cleanup/u,
		);
		assert.equal(stream.cancelCalls, 1);
		assert.equal(store.activeTurns, 0);
	});

	test("live authority invalidation after resume authorization blocks the first tool-result write", async () => {
		const lease = revocableAuthority((count, revoke) => { if (count === 2) revoke(); });
		const store = new CursorConversationStateStore();
		const stream = new CountingStream("before-first-write");
		store.registerTurn("conversation-first", stream, lease.route);
		store.pauseTurnForTools("conversation-first", stream, [toolCall], { authority: lease.route, signal: lease.route.authoritySignal });

		await assert.rejects(
			() => store.resumeTurnWithToolResults("conversation-first", [toolResult()], { authority: lease.route, signal: lease.route.authoritySignal }),
			/no longer current|revoked/u,
		);
		assert.equal(stream.cancelCalls, 1);
		assert.equal(store.activeTurns, 0);
	});

	test("authority revocation during one tool-result write prevents every subsequent write", async () => {
		const lease = revocableAuthority();
		const store = new CursorConversationStateStore();
		const stream = new RevokingWriteStream("between-writes", () => lease.revoke());
		store.registerTurn("conversation-multi", stream, lease.route);
		store.pauseTurnForTools("conversation-multi", stream, [toolCall, secondToolCall], { authority: lease.route, signal: lease.route.authoritySignal });

		await assert.rejects(
			() => store.resumeTurnWithToolResults("conversation-multi", [toolResult(), toolResult("tool-2")], { authority: lease.route, signal: lease.route.authoritySignal }),
			/revoked|no longer current/u,
		);
		assert.deepEqual(stream.written, ["tool-1"]);
		assert.equal(stream.cancelCalls, 1);
		assert.equal(store.activeTurns, 0);
	});

	test("clears pending tool calls after a successful resume", async () => {
		const store = new CursorConversationStateStore();
		const stream = new CountingStream("resume-once");
		store.registerTurn("conversation-resume", stream, authority);
		store.pauseTurnForTools("conversation-resume", stream, [toolCall], { authority });

		await store.resumeTurnWithToolResults("conversation-resume", [toolResult()], { authority });
		await assert.rejects(
			() => store.resumeTurnWithToolResults("conversation-resume", [toolResult()], { authority }),
			/does not match a paused tool call/u,
		);
		assert.equal(store.activeTurns, 0);
		assert.equal(stream.cancelCalls, 1);
	});

	test("registerTurn disarms and cancels an existing same-conversation turn before replacing it", async () => {
		const store = new CursorConversationStateStore();
		const oldStream = new CountingStream("old");
		const newStream = new CountingStream("new");
		store.registerTurn("conversation-2", oldStream, authority);
		store.pauseTurnForTools("conversation-2", oldStream, [toolCall], { authority, idleTimeoutMs: 1 });

		store.registerTurn("conversation-2", newStream, authority);
		await sleep(10);
		assert.equal(oldStream.cancelCalls, 1);
		assert.equal(newStream.cancelCalls, 0);
		assert.equal(store.activeTurns, 1);
	});

	test("a stalled old-turn cancellation cannot suppress replacement cancellation", async () => {
		const oldAuthority = revocableAuthority();
		const replacementAuthority = revocableAuthority();
		const store = new CursorConversationStateStore();
		const oldStream = new StalledCancelStream("old-stalled-cancel");
		const replacementStream = new CountingStream("replacement-aborted");
		store.registerTurn("conversation-replacement-race", oldStream, oldAuthority.route);

		oldAuthority.revoke();
		await oldStream.cancelStarted.promise;
		store.registerTurn("conversation-replacement-race", replacementStream, replacementAuthority.route);
		replacementAuthority.revoke();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(replacementStream.cancelCalls, 1);
		assert.equal(store.activeTurns, 0);
		oldStream.releaseCancel.resolve();
		await Promise.resolve();
		assert.equal(store.activeTurns, 0);
	});

	test("completion detaches only the exact turn and cannot delete its replacement", () => {
		const store = new CursorConversationStateStore();
		const oldStream = new CountingStream("completed-old");
		const replacementStream = new CountingStream("completed-replacement");
		const oldTurn = store.registerTurn("conversation-completion-race", oldStream, authority);
		store.completeTurn("conversation-completion-race", oldTurn);
		store.registerTurn("conversation-completion-race", replacementStream, authority);

		store.completeTurn("conversation-completion-race", oldTurn);
		assert.equal(store.activeTurns, 1);
	});

	test("late cancellation for an old stream cannot cancel its replacement", async () => {
		const store = new CursorConversationStateStore();
		const oldStream = new CountingStream("cancelled-old");
		const replacementStream = new CountingStream("cancelled-replacement");
		const oldTurn = store.registerTurn("conversation-late-cancel", oldStream, authority);
		store.registerTurn("conversation-late-cancel", replacementStream, authority);

		await store.cancelTurn("conversation-late-cancel", oldTurn);
		assert.equal(replacementStream.cancelCalls, 0);
		assert.equal(store.activeTurns, 1);
	});

	test("paused authority abort and disposal finalize message iterators exactly once", async () => {
		for (const trigger of ["authority", "dispose"] as const) {
			const lease = revocableAuthority();
			const store = new CursorConversationStateStore();
			const stream = new CountingStream(`finalize-${trigger}`);
			let finalizeCalls = 0;
			store.registerTurn(`conversation-finalize-${trigger}`, stream, lease.route, () => { finalizeCalls += 1; });
			store.pauseTurnForTools(`conversation-finalize-${trigger}`, stream, [toolCall], { authority: lease.route, signal: lease.route.authoritySignal });

			if (trigger === "authority") {
				lease.revoke();
				await Promise.resolve();
				await Promise.resolve();
			} else {
				await store.dispose();
			}

			assert.equal(finalizeCalls, 1);
			assert.equal(store.activeTurns, 0);
		}
	});

	test("paused turns cancel when either caller or authority aborts", async () => {
		for (const source of ["caller", "authority"] as const) {
			const lease = revocableAuthority();
			const caller = new AbortController();
			const store = new CursorConversationStateStore();
			const stream = new CountingStream(`dual-signal-${source}`);
			let finalizeCalls = 0;
			store.registerTurn(`conversation-dual-${source}`, stream, lease.route, () => { finalizeCalls += 1; });
			store.pauseTurnForTools(`conversation-dual-${source}`, stream, [toolCall], {
				authority: lease.route,
				signal: caller.signal,
			});

			if (source === "caller") caller.abort(new Error("caller stopped"));
			else lease.revoke();
			await Promise.resolve();
			await Promise.resolve();

			assert.equal(source === "authority" ? caller.signal.aborted : lease.route.authoritySignal.aborted, false);
			assert.equal(stream.cancelCalls, 1);
			assert.equal(stream.writeCalls, 0);
			assert.equal(finalizeCalls, 1);
			assert.equal(store.activeTurns, 0);
			await assert.rejects(
				() => store.resumeTurnWithToolResults(`conversation-dual-${source}`, [toolResult()], { authority: lease.route, signal: caller.signal }),
				/no paused tool turn/u,
			);
		}
	});

	test("paused-turn abort idle and replacement cleanup catch cancel rejections", async () => {
		const unhandledReasons: string[] = [];
		const onUnhandled = (reason: {} | null | undefined): void => { unhandledReasons.push(String(reason)); };
		process.on("unhandledRejection", onUnhandled);
		try {
			const store = new CursorConversationStateStore();
			const abortController = new AbortController();
			const abortStream = new CountingStream("abort", true);
			store.registerTurn("abort-conversation", abortStream, authority);
			store.pauseTurnForTools("abort-conversation", abortStream, [toolCall], { authority, signal: abortController.signal });
			abortController.abort();

			const idleStream = new CountingStream("idle", true);
			store.registerTurn("idle-conversation", idleStream, authority);
			store.pauseTurnForTools("idle-conversation", idleStream, [toolCall], { authority, idleTimeoutMs: 1 });

			const replacedStream = new CountingStream("replaced", true);
			const replacementStream = new CountingStream("replacement");
			store.registerTurn("replace-conversation", replacedStream, authority);
			store.pauseTurnForTools("replace-conversation", replacedStream, [toolCall], { authority, idleTimeoutMs: 50 });
			store.registerTurn("replace-conversation", replacementStream, authority);

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
