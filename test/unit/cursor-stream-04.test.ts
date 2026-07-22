import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import { CursorError } from "../../packages/cursor/src/errors.js";
import { encodeCursorConnectFrame } from "../../packages/cursor/src/transport-frame.js";
import { Http2CursorRunStream } from "../../packages/cursor/src/transport-run-stream.js";
import type {
	CursorAgentTransport,
	CursorHttp2StreamHandle,
	CursorProtocolCodec,
	CursorRunRequest,
	CursorRunStream,
} from "../../packages/cursor/src/transport-types.js";
import { cursorRouteAuthority } from "./cursor-test-helpers.js";
import { collectEvents, context, deferred, model } from "./cursor-stream-helpers.js";

interface ProbeCounts {
	rawCancel: number;
	rawClose: number;
	discard: number;
	dispose: number;
	lifecycleCancel: number;
	lifecycleClose: number;
	open: number;
}

class UnterminatedProbeTransport implements CursorAgentTransport {
	readonly counts: ProbeCounts = {
		rawCancel: 0,
		rawClose: 0,
		discard: 0,
		dispose: 0,
		lifecycleCancel: 0,
		lifecycleClose: 0,
		open: 0,
	};

	constructor(
		readonly frames: readonly Uint8Array[] | AsyncIterable<Uint8Array>,
		readonly decodeRunFrame: CursorProtocolCodec["decodeRunFrame"],
		readonly onWrite: () => void = () => undefined,
	) {}

	async getUsableModels() { return []; }

	async run(request: CursorRunRequest): Promise<CursorRunStream> {
		this.counts.open += 1;
		const handle: CursorHttp2StreamHandle = {
			frames: Symbol.asyncIterator in this.frames ? this.frames : (async function* (frames) { for (const frame of frames) yield frame; })(this.frames),
			write: async () => { this.onWrite(); },
			close: async () => { this.counts.rawClose += 1; },
			cancel: async () => { this.counts.rawCancel += 1; },
		};
		const codec: CursorProtocolCodec = {
			encodeGetUsableModelsRequest: () => new Uint8Array(),
			decodeGetUsableModelsResponse: () => [],
			encodeRunRequest: () => new Uint8Array(),
			decodeRunFrame: this.decodeRunFrame,
			encodeToolResult: () => new Uint8Array(),
			encodeCancelRequest: () => new Uint8Array(),
			encodeHeartbeatRequest: () => new Uint8Array(),
			disposeRun: () => { this.counts.dispose += 1; },
			discardRun: () => { this.counts.discard += 1; },
		};
		return new Http2CursorRunStream(
			request.requestId,
			handle,
			codec,
			[],
			request.routeReference,
			0,
			() => { this.counts.lifecycleCancel += 1; },
			() => { this.counts.lifecycleClose += 1; this.counts.open -= 1; },
		);
	}

	async dispose(): Promise<void> {}

	getLifecycleSnapshot() {
		return {
			openStreams: this.counts.open,
			cancelledStreams: this.counts.lifecycleCancel,
			closedStreams: this.counts.lifecycleClose,
		};
	}
}

function assertMalformedEventsAndOwnership(
	transport: UnterminatedProbeTransport,
	adapter: CursorStreamAdapter,
	events: Awaited<ReturnType<typeof collectEvents>>,
): void {
	assert.equal(events.filter((event) => event.type === "done").length, 0);
	const errors = events.filter((event) => event.type === "error");
	assert.equal(errors.length, 1);
	if (errors[0]?.type === "error") {
		assert.equal(errors[0].reason, "error");
		assert.equal(errors[0].error.errorMessage, "Cursor Run stream ended before a Connect end-stream terminal frame.");
	}
	assert.deepEqual(transport.counts, {
		rawCancel: 1, rawClose: 0, discard: 1, dispose: 0,
		lifecycleCancel: 1, lifecycleClose: 1, open: 0,
	});
	assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
}

async function assertMalformedAtomicTerminal(transport: UnterminatedProbeTransport): Promise<void> {
	const adapter = new CursorStreamAdapter({ transport, routeAuthority: cursorRouteAuthority(), uuid: () => "unterminated-run" });
	const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret", timeoutMs: 0 }));
	assertMalformedEventsAndOwnership(transport, adapter, events);
}

describe("Cursor unterminated data-frame EOF", () => {
	test("does not expose a queued provider done as Atomic success", async () => {
		const transport = new UnterminatedProbeTransport(
			[encodeCursorConnectFrame(new Uint8Array([1]))],
			() => [{ type: "done", reason: "stop" }],
		);
		await assertMalformedAtomicTerminal(transport);
	});

	test("lets malformed EOF win during timeout-disabled tool handoff validation", async () => {
		const toolPublished = deferred();
		const eof = deferred();
		const idle = deferred();
		const transport = new UnterminatedProbeTransport(
			(async function* () {
				yield new Uint8Array([
					...encodeCursorConnectFrame(new Uint8Array([1])),
					...encodeCursorConnectFrame(new Uint8Array([2])),
				]);
				await eof.promise;
			})(),
			(frame) => frame.data[0] === 1
				? [{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{}" }]
				: [{ type: "textDelta", text: "boundary" }],
		);
		const adapter = new CursorStreamAdapter({
			transport, routeAuthority: cursorRouteAuthority(), uuid: () => "competing-eof-run",
			toolCallBatchIdleWait: (idleMs) => { assert.equal(idleMs, 100); return idle.promise; },
		});
		const eventsPromise = collectEvents(
			adapter.streamSimple(model(), context(), { apiKey: "access-secret", timeoutMs: 0 }),
			(event) => { if (event.type === "toolcall_end") toolPublished.resolve(); },
		);
		await toolPublished.promise;
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 1);
		eof.resolve();
		assertMalformedEventsAndOwnership(transport, adapter, await eventsPromise);
	});

	test("publishes provider done only after clean terminal teardown", async () => {
		const transport = new UnterminatedProbeTransport(
			[
				encodeCursorConnectFrame(new Uint8Array([1])),
				encodeCursorConnectFrame(new TextEncoder().encode("{}"), 2),
			],
			() => [{ type: "done", reason: "stop" }],
		);
		const adapter = new CursorStreamAdapter({ transport, routeAuthority: cursorRouteAuthority(), uuid: () => "clean-run" });
		const events = await collectEvents(adapter.streamSimple(model(), context(), { apiKey: "access-secret" }));
		assert.deepEqual(events.map((event) => event.type), ["start", "done"]);
		assert.deepEqual(transport.counts, {
			rawCancel: 0,
			rawClose: 1,
			discard: 0,
			dispose: 1,
			lifecycleCancel: 0,
			lifecycleClose: 1,
			open: 0,
		});
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
	});

	test("hands off and resumes provider-open tools when general timeouts are disabled", async () => {
		const toolPublished = deferred();
		const idle = deferred();
		let releaseResume!: () => void;
		const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
		const transport = new UnterminatedProbeTransport(
			(async function* () {
				yield new Uint8Array([
					...encodeCursorConnectFrame(new Uint8Array([1])),
					...encodeCursorConnectFrame(new Uint8Array([2])),
				]);
				await resumeGate;
				yield encodeCursorConnectFrame(new Uint8Array([3]));
				yield encodeCursorConnectFrame(new TextEncoder().encode("{}"), 2);
			})(),
			(frame) => {
				if (frame.data[0] === 1) return [{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{}" }];
				if (frame.data[0] === 2) return [{ type: "textDelta", text: "after tool" }];
				return [{ type: "done", reason: "stop" }];
			},
			() => { releaseResume(); },
		);
		const adapter = new CursorStreamAdapter({
			transport, routeAuthority: cursorRouteAuthority(), uuid: () => "tool-run",
			toolCallBatchIdleWait: (idleMs) => { assert.equal(idleMs, 100); return idle.promise; },
		});
		const firstPromise = collectEvents(
			adapter.streamSimple(model(), context(), { apiKey: "access-secret", sessionId: "tool-session", timeoutMs: 0 }),
			(event) => { if (event.type === "toolcall_end") toolPublished.resolve(); },
		);
		await toolPublished.promise;
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 1);
		idle.resolve();
		const first = await firstPromise;
		assert.deepEqual(first.map((event) => event.type), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
		assert.equal(first.filter((event) => event.type === "done").length, 1);
		const handoffs = first.filter((event) => event.type === "done");
		assert.equal(handoffs[0]?.type, "done");
		if (handoffs[0]?.type === "done") assert.equal(handoffs[0].reason, "toolUse");
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 1);

		const resumedContext = { messages: [{
			role: "toolResult" as const, toolCallId: "tool-1", toolName: "Read",
			content: [{ type: "text" as const, text: "result" }], isError: false, timestamp: 2,
		}] };
		const second = await collectEvents(adapter.streamSimple(model(), resumedContext, { apiKey: "access-secret", sessionId: "tool-session", timeoutMs: 0 }));
		assert.deepEqual(second.map((event) => event.type), ["start", "text_start", "text_delta", "text_end", "done"]);
		assert.deepEqual(second.filter((event) => event.type === "text_delta").map((event) => event.delta), ["after tool"]);
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
	});

	test("rejects a timeout-disabled idle handoff when lease authority becomes stale without signal abort", async () => {
		const idleStarted = deferred();
		const idle = deferred();
		const remainOpen = deferred();
		let current = true;
		const leaseController = new AbortController();
		const transport = new UnterminatedProbeTransport(
			(async function* () {
				yield encodeCursorConnectFrame(new Uint8Array([1]));
				await remainOpen.promise;
			})(),
			() => [{ type: "toolCall", id: "tool-stale", name: "Read", argumentsJson: "{}" }],
		);
		const adapter = new CursorStreamAdapter({
			transport,
			routeAuthority: { acquireRequestLease: () => ({
				signal: leaseController.signal,
				assertCurrent: (operation) => {
					if (!current) throw new CursorError("StaleGeneration", "Cursor request belongs to a stale provider generation.", { operation });
				},
			}) },
			toolCallBatchIdleWait: (idleMs) => {
				assert.equal(idleMs, 100);
				idleStarted.resolve();
				return idle.promise;
			},
		});
		const eventsPromise = collectEvents(
			adapter.streamSimple(model(), context(), { apiKey: "access-secret", timeoutMs: 0 }),
			(event) => {
				if (event.type !== "error") return;
				assert.deepEqual(transport.counts, {
					rawCancel: 1, rawClose: 0, discard: 1, dispose: 0,
					lifecycleCancel: 1, lifecycleClose: 1, open: 0,
				});
				assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
			},
		);
		await idleStarted.promise;
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 1);
		current = false;
		idle.resolve();
		const events = await eventsPromise;
		assert.equal(events.filter((event) => event.type === "done").length, 0);
		const errors = events.filter((event) => event.type === "error");
		assert.equal(errors.length, 1);
		if (errors[0]?.type === "error") assert.equal(errors[0].error.errorMessage, "Cursor request generation became stale.");
		assert.deepEqual(transport.counts, {
			rawCancel: 1, rawClose: 0, discard: 1, dispose: 0,
			lifecycleCancel: 1, lifecycleClose: 1, open: 0,
		});
		assert.equal(adapter.getLifecycleSnapshot().activeTurns, 0);
	});
});
