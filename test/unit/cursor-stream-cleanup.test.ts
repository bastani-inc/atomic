import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { CursorAgentTransport, CursorRunRequest, CursorRunStream, CursorServerMessage, CursorToolResultMessage, CursorTransportLifecycleSnapshot, CursorWriteOptions } from "../../packages/cursor/src/transport.js";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import { collectEventsWithTimeout, context, model, testAuthorizedRoute } from "./cursor-stream-helpers.js";
import { CursorMessageReader } from "../../packages/cursor/src/stream-reader.js";

class ThresholdAbortSignal extends EventTarget implements AbortSignal {
	readonly reason = new Error("authority expired during timeout handling");
	onabort: ((this: AbortSignal, event: Event) => void) | null = null;
	readonly [Symbol.toStringTag] = "AbortSignal";
	#reads = 0;
	constructor(readonly abortAfterRead: number) { super(); }
	get aborted(): boolean {
		this.#reads += 1;
		return this.#reads > this.abortAfterRead;
	}
	throwIfAborted(): void {
		if (this.aborted) throw this.reason;
	}
}

class FinalizableMessages implements AsyncIterable<CursorServerMessage>, AsyncIterator<CursorServerMessage> {
	readonly returnStarted = Promise.withResolvers<void>();
	readonly releaseReturn = Promise.withResolvers<void>();
	returnCalls = 0;
	#nextCalls = 0;
	[Symbol.asyncIterator](): AsyncIterator<CursorServerMessage> { return this; }
	async next(): Promise<IteratorResult<CursorServerMessage>> {
		this.#nextCalls += 1;
		if (this.#nextCalls === 1) return { done: false, value: { type: "done", reason: "stop" } };
		return { done: true, value: undefined };
	}
	async return(): Promise<IteratorResult<CursorServerMessage>> {
		this.returnCalls += 1;
		this.returnStarted.resolve();
		await this.releaseReturn.promise;
		return { done: true, value: undefined };
	}
}

class HangingFinalizableMessages implements AsyncIterable<CursorServerMessage>, AsyncIterator<CursorServerMessage> {
	returnCalls = 0;
	[Symbol.asyncIterator](): AsyncIterator<CursorServerMessage> { return this; }
	async next(): Promise<IteratorResult<CursorServerMessage>> { return new Promise(() => {}); }
	async return(): Promise<IteratorResult<CursorServerMessage>> {
		this.returnCalls += 1;
		return { done: true, value: undefined };
	}
}

class RejectingFinalizableMessages extends HangingFinalizableMessages {
	override async next(): Promise<IteratorResult<CursorServerMessage>> { throw new Error("iterator failed"); }
}

class CleanupStream implements CursorRunStream {
	readonly closeStarted = Promise.withResolvers<void>();
	readonly releaseClose = Promise.withResolvers<void>();
	cancelCalls = 0;
	closeCalls = 0;
	#released = false;
	constructor(readonly id: string, readonly messages: AsyncIterable<CursorServerMessage>, readonly onRelease: () => void) {}
	async writeToolResult(_result: CursorToolResultMessage, _options?: CursorWriteOptions): Promise<void> {}
	async cancel(): Promise<void> { this.cancelCalls += 1; this.releaseLocal(); }
	async close(): Promise<void> {
		this.closeCalls += 1;
		this.releaseLocal();
		this.closeStarted.resolve();
		await this.releaseClose.promise;
	}
	protected releaseLocal(): void {
		if (this.#released) return;
		this.#released = true;
		this.onRelease();
	}
}

class StalledCleanupMessages implements AsyncIterable<CursorServerMessage>, AsyncIterator<CursorServerMessage> {
	readonly releaseReturn = Promise.withResolvers<void>();
	returnCalls = 0;
	[Symbol.asyncIterator](): AsyncIterator<CursorServerMessage> { return this; }
	async next(): Promise<IteratorResult<CursorServerMessage>> { return new Promise(() => {}); }
	async return(): Promise<IteratorResult<CursorServerMessage>> {
		this.returnCalls += 1;
		await this.releaseReturn.promise;
		return { done: true, value: undefined };
	}
}

class StalledCleanupStream extends CleanupStream {
	readonly releaseCancel = Promise.withResolvers<void>();
	override async cancel(): Promise<void> {
		this.cancelCalls += 1;
		this.releaseLocal();
		await this.releaseCancel.promise;
	}
}

class CleanupTransport implements CursorAgentTransport {
	readonly requests: CursorRunRequest[] = [];
	readonly streams: CleanupStream[] = [];
	#openStreams = 0;
	constructor(readonly streamFactory: (request: CursorRunRequest, onRelease: () => void) => CleanupStream) {}
	async getUsableModels(): Promise<readonly []> { return []; }
	async run(request: CursorRunRequest): Promise<CursorRunStream> {
		this.requests.push(request);
		this.#openStreams += 1;
		const stream = this.streamFactory(request, () => { this.#openStreams = Math.max(0, this.#openStreams - 1); });
		this.streams.push(stream);
		return stream;
	}
	async dispose(): Promise<void> {}
	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot {
		return { openStreams: this.#openStreams, cancelledStreams: this.streams.reduce((sum, stream) => sum + stream.cancelCalls, 0), closedStreams: this.streams.reduce((sum, stream) => sum + stream.closeCalls, 0) };
	}
}

describe("Cursor stream terminal cleanup", () => {
	test("iterator finalization contains synchronous return failures and is idempotent", async () => {
		let returnCalls = 0;
		const messages: AsyncIterable<CursorServerMessage> = {
			[Symbol.asyncIterator](): AsyncIterator<CursorServerMessage> {
				return {
					next: async () => new Promise(() => {}),
					return: () => {
						returnCalls += 1;
						throw new Error("synchronous iterator return failure");
					},
				};
			},
		};
		const reader = new CursorMessageReader(messages);

		await reader.finalize();
		await reader.finalize();
		assert.equal(returnCalls, 1);
	});

	test("authority abort wins over a pending-tool timeout without stale terminal output", async () => {
		const authoritySignal = new ThresholdAbortSignal(4);
		const messages = (async function* (): AsyncIterable<CursorServerMessage> {
			yield { type: "toolCall", id: "tool-timeout-race", name: "Read", argumentsJson: "{}" };

			await new Promise<void>(() => {});
		})();
		const transport = new CleanupTransport((request, onRelease) => new CleanupStream(request.requestId, messages, onRelease));
		const route = testAuthorizedRoute({ authoritySignal });
		const adapter = new CursorStreamAdapter({ transport, executionAuthorizer: async () => route, streamReadTimeoutMs: 1 });

		const events = await collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }), 250);

		assert.equal(events.some((event) => event.type === "done"), false);
		assert.equal(events.at(-1)?.type, "error");
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
		await adapter.dispose();
	});

	test("terminal cleanup finalizes the iterator and detaches before stalled close settles", async () => {
		const messages = new FinalizableMessages();
		const transport = new CleanupTransport((request, onRelease) => new CleanupStream(request.requestId, messages, onRelease));
		const adapter = new CursorStreamAdapter({ transport, executionAuthorizer: async () => testAuthorizedRoute() });

		const events = await collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }), 250);
		const stream = transport.streams[0];
		if (!stream) throw new Error("Expected Cursor cleanup stream");
		await messages.returnStarted.promise;
		await stream.closeStarted.promise;

		assert.equal(events.at(-1)?.type, "done");
		assert.equal(messages.returnCalls, 1);
		assert.equal(stream.closeCalls, 1);
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
		messages.releaseReturn.resolve();
		stream.releaseClose.resolve();
		await adapter.dispose();
	});

	for (const source of ["caller", "authority"] as const) {
		test(`${source} abort finalizes the active message iterator`, async () => {
			const messages = new HangingFinalizableMessages();
			const transport = new CleanupTransport((request, onRelease) => new CleanupStream(request.requestId, messages, onRelease));
			const callerController = new AbortController();
			const authorityController = new AbortController();
			const route = testAuthorizedRoute({ authoritySignal: authorityController.signal });
			const adapter = new CursorStreamAdapter({ transport, executionAuthorizer: async () => route });
			const eventsPromise = collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret", signal: callerController.signal }), 250);
			while (transport.streams.length === 0) await Promise.resolve();

			if (source === "caller") callerController.abort();
			else authorityController.abort();
			const events = await eventsPromise;

			assert.equal(events.at(-1)?.type, "error");
			assert.equal(messages.returnCalls, 1);
			assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
			await adapter.dispose();
		});
	}

	test("iterator failure finalizes the message iterator", async () => {
		const messages = new RejectingFinalizableMessages();
		const transport = new CleanupTransport((request, onRelease) => new CleanupStream(request.requestId, messages, onRelease));
		const adapter = new CursorStreamAdapter({ transport, executionAuthorizer: async () => testAuthorizedRoute() });

		const events = await collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }), 250);

		assert.equal(events.at(-1)?.type, "error");
		assert.equal(messages.returnCalls, 1);
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
		await adapter.dispose();
	});

	test("dispose detaches permanently stalled iterator and stream cleanup bookkeeping", async () => {
		const messages = new StalledCleanupMessages();
		const transport = new CleanupTransport((request, onRelease) => new StalledCleanupStream(request.requestId, messages, onRelease));
		const adapter = new CursorStreamAdapter({
			transport,
			executionAuthorizer: async () => testAuthorizedRoute(),
			disposeGraceMs: 5,
		});
		const eventsPromise = collectEventsWithTimeout(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }), 250);
		while (transport.streams.length === 0) await Promise.resolve();

		await Promise.race([
			adapter.dispose(),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("dispose did not respect its cleanup bound")), 100)),
		]);
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
		assert.equal(adapter.getPendingCleanupCount(), 0);
		assert.equal(adapter.getLifecycleSnapshot().openStreams, 0);
		assert.equal(messages.returnCalls, 1);
		const stream = transport.streams[0];
		assert.ok(stream instanceof StalledCleanupStream);
		assert.equal(stream.cancelCalls, 1);
		const events = await eventsPromise;
		assert.equal(events.at(-1)?.type, "error");
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
	});
});
