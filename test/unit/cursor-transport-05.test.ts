import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { cursorRouteReference } from "./cursor-test-helpers.js";
import { CursorTransportError } from "../../packages/cursor/src/transport-errors.js";
import { Http2CursorRunStream } from "../../packages/cursor/src/transport-run-stream.js";
import { encodeCursorConnectFrame } from "../../packages/cursor/src/transport-frame.js";
import type { CursorHttp2StreamHandle, CursorProtocolCodec } from "../../packages/cursor/src/transport-types.js";

const cleanEnd = encodeCursorConnectFrame(new TextEncoder().encode(JSON.stringify({ metadata: {} })), 2);

function codec(onDispose: () => void, onDiscard: () => void = () => undefined): CursorProtocolCodec {
	return {
		encodeGetUsableModelsRequest: () => new Uint8Array(),
		decodeGetUsableModelsResponse: () => [],
		encodeRunRequest: () => new Uint8Array(),
		decodeRunFrame: () => [],
		encodeToolResult: () => new Uint8Array(),
		encodeCancelRequest: () => new Uint8Array(),
		encodeHeartbeatRequest: () => new Uint8Array([6]),
		disposeRun: onDispose,
		discardRun: onDiscard,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("Cursor clean-success terminal ownership", () => {
	test("waits for an already-started heartbeat write before exposing clean EOF", async () => {
		let releaseFrame!: () => void;
		const frameGate = new Promise<void>((resolve) => { releaseFrame = resolve; });
		let releaseWrite!: () => void;
		const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
		let activeWrites = 0;
		let closeCount = 0;
		let disposeCount = 0;
		const handle: CursorHttp2StreamHandle = {
			frames: (async function* () { await frameGate; yield cleanEnd; })(),
			write: async () => { activeWrites += 1; await writeGate; activeWrites -= 1; },
			close: async () => { closeCount += 1; },
			cancel: async () => undefined,
		};
		const run = new Http2CursorRunStream("heartbeat-pending", handle, codec(() => { disposeCount += 1; }), [], cursorRouteReference(), 1, () => undefined, () => undefined);
		await waitFor(() => activeWrites > 0);
		let completed = false;
		const consuming = (async () => { for await (const _ of run.messages) {} })().then(() => { completed = true; });
		releaseFrame();
		await waitFor(() => closeCount === 1);
		await new Promise((resolve) => setTimeout(resolve, 2));
		assert.equal(completed, false);
		assert.ok(activeWrites > 0);
		releaseWrite();
		await consuming;
		assert.equal(activeWrites, 0);
		assert.equal(disposeCount, 1);
	});

	test("abandons the handle when graceful close rejects before clean success", async () => {
		let owned = true;
		let closeCount = 0;
		let cancelCount = 0;
		let disposeCount = 0;
		let onClose = 0;
		let onCancel = 0;
		const handle: CursorHttp2StreamHandle = {
			frames: (async function* () { yield cleanEnd; })(),
			write: async () => undefined,
			close: async () => { closeCount += 1; throw new Error("close rejected before release"); },
			cancel: async () => { cancelCount += 1; owned = false; },
		};
		const run = new Http2CursorRunStream("close-fallback", handle, codec(() => { disposeCount += 1; }), [], cursorRouteReference(), 0, () => { onCancel += 1; }, () => { onClose += 1; });
		const messages = [];
		for await (const message of run.messages) messages.push(message);
		assert.deepEqual(messages, []);
		assert.equal(owned, false);
		assert.equal(closeCount, 1);
		assert.equal(cancelCount, 1);
		assert.equal(disposeCount, 1);
		assert.equal(onClose, 1);
		assert.equal(onCancel, 0);
		await run.cancel();
		assert.equal(cancelCount, 1);
	});

	test("rejects bare EOF once after releasing all terminal ownership", async () => {
		let releaseFrames!: () => void;
		const frameGate = new Promise<void>((resolve) => { releaseFrames = resolve; });
		let releaseWrite!: () => void;
		const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
		let activeWrites = 0;
		let releaseCancel!: () => void;
		const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
		let cancelCount = 0;
		let disposeCount = 0;
		let discardCount = 0;
		let onCancel = 0;
		let owned = true;
		let onClose = 0;
		const handle: CursorHttp2StreamHandle = {
			frames: (async function* () { await frameGate; })(),
			write: async () => { activeWrites += 1; await writeGate; activeWrites -= 1; },
			close: async () => undefined,
			cancel: async () => { cancelCount += 1; await cancelGate; owned = false; },
		};
		const run = new Http2CursorRunStream(
			"bare-eof",
			handle,
			codec(() => { disposeCount += 1; }, () => { discardCount += 1; }),
			[],
			cursorRouteReference(),
			1,
			() => { onCancel += 1; },
			() => { onClose += 1; },
		);
		await waitFor(() => activeWrites > 0);
		const iterator = run.messages[Symbol.asyncIterator]();
		let rejected = false;
		const first = iterator.next().catch((error: Error) => { rejected = true; throw error; });
		releaseFrames();
		await waitFor(() => cancelCount === 1);
		await new Promise((resolve) => setTimeout(resolve, 2));
		assert.equal(rejected, false);
		assert.equal(owned, true);
		releaseCancel();
		await waitFor(() => !owned);
		assert.equal(rejected, false);
		assert.ok(activeWrites > 0);
		releaseWrite();
		await assert.rejects(first, (error: Error) => error instanceof CursorTransportError
			&& error.code === "ProtocolMalformed"
			&& error.message === "Cursor Run stream ended before a Connect end-stream terminal frame.");
		assert.equal(activeWrites, 0);
		assert.equal(cancelCount, 1);
		assert.equal(disposeCount, 0);
		assert.equal(discardCount, 1);
		assert.equal(onCancel, 1);
		assert.equal(onClose, 1);
		assert.deepEqual(await iterator.next(), { value: undefined, done: true });
		await run.close();
		await run.cancel();
		assert.deepEqual({ cancelCount, disposeCount, discardCount, onCancel, onClose },
			{ cancelCount: 1, disposeCount: 0, discardCount: 1, onCancel: 1, onClose: 1 });
	});
});
