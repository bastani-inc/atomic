// @ts-nocheck
import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import { cursorRouteReference } from "./cursor-test-helpers.js";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentClientMessageSchema, AgentServerMessageSchema, ConversationStateStructureSchema } from "../../packages/cursor/src/proto/cursor-protocol.js";
import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import {
	CursorProtobufProtocolCodec,
	decodeCursorConnectFrames,
	encodeCursorConnectFrame,
	Http2CursorAgentTransport,
	type CursorHttp2Client,
	type CursorHttp2StreamHandle,
} from "../../packages/cursor/src/transport.js";
import { cursorProtoTest } from "./cursor-proto-test-helpers.js";

const model: Model<Api> = {
	id: "composer-2",
	name: "Composer 2",
	provider: "cursor",
	api: "cursor-agent" as Api,
	baseUrl: "https://api2.cursor.sh",
	input: ["text"],
	reasoning: false,
	contextWindow: 200_000,
	maxTokens: 64_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function makeKvBlobGetFrame(execId: number, blobId: Uint8Array): Uint8Array {
	return cursorProtoTest.encodeMessageField(
		4,
		cursorProtoTest.concatBytes(
			cursorProtoTest.encodeVarintField(1, BigInt(execId)),
			cursorProtoTest.encodeMessageField(2, cursorProtoTest.encodeMessageField(1, blobId)),
		),
	);
}

function makeKvBlobSetFrame(execId: number, blobId: Uint8Array, blobData: Uint8Array): Uint8Array {
	return cursorProtoTest.encodeMessageField(
		4,
		cursorProtoTest.concatBytes(
			cursorProtoTest.encodeVarintField(1, BigInt(execId)),
			cursorProtoTest.encodeMessageField(3, cursorProtoTest.concatBytes(cursorProtoTest.encodeMessageField(1, blobId), cursorProtoTest.encodeMessageField(2, blobData))),
		),
	);
}

const cleanEndFrame = encodeCursorConnectFrame(new TextEncoder().encode(JSON.stringify({ metadata: {} })), 2);

function checkpointFrame(rootPromptMessagesJson: readonly Uint8Array[], clientName = "server-checkpoint"): Uint8Array {
	const checkpointState = create(ConversationStateStructureSchema, { rootPromptMessagesJson: [...rootPromptMessagesJson], clientName });
	return encodeCursorConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
		message: { case: "conversationCheckpointUpdate", value: checkpointState },
	})));
}

function checkpointBytesFor(rootPromptMessagesJson: readonly Uint8Array[], clientName = "server-checkpoint"): Uint8Array {
	return toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, { rootPromptMessagesJson: [...rootPromptMessagesJson], clientName }));
}

// A recording HTTP/2 stream handle that yields scripted server frames and can
// optionally reset mid-stream (failAfter) or stall (hang) after the last frame.
class RecordingStreamHandle implements CursorHttp2StreamHandle {
	readonly writes: Uint8Array[] = [];
	readonly frames: AsyncIterable<Uint8Array>;

	constructor(frames: readonly Uint8Array[], options: { readonly failAfter?: boolean; readonly hang?: Promise<void> } = {}) {
		const { failAfter = false, hang } = options;
		this.frames = (async function* (): AsyncIterable<Uint8Array> {
			for (const frame of frames) yield frame;
			if (hang) await hang;
			if (failAfter) throw new Error("Cursor stream connection reset mid-stream");
		})();
	}

	async write(data: Uint8Array): Promise<void> { this.writes.push(data); }
	async close(): Promise<void> {}
	async cancel(): Promise<void> {}
}

type StreamScript = readonly Uint8Array[] | { readonly frames: readonly Uint8Array[]; readonly failAfter?: boolean; readonly hang?: Promise<void> };

// A scripted fake HTTP/2 peer that hands each Cursor stream its own frames while
// recording every client write, exercising multi-turn continuity through the
// real transport + protobuf codec.
class ScriptedCursorPeer implements CursorHttp2Client {
	readonly handles: RecordingStreamHandle[] = [];
	readonly #streamScripts: Array<{ readonly frames: readonly Uint8Array[]; readonly failAfter?: boolean; readonly hang?: Promise<void> }>;

	constructor(streamScripts: readonly StreamScript[]) {
		this.#streamScripts = streamScripts.map((script) => Array.isArray(script) ? { frames: [...script] } : { ...script, frames: [...script.frames] });
	}

	async requestUnary(): Promise<{ readonly body: Uint8Array; readonly headers: Record<string, string>; readonly statusCode?: number }> {
		throw new Error("ScriptedCursorPeer does not serve unary requests");
	}

	async openStream(request: { readonly path: string; readonly headers: Record<string, string>; readonly initialBody?: Uint8Array }): Promise<CursorHttp2StreamHandle> {
		const script = this.#streamScripts.shift() ?? { frames: [] };
		const handle = new RecordingStreamHandle(script.frames, { failAfter: script.failAfter, hang: script.hang });
		if (request.initialBody) await handle.write(request.initialBody);
		this.handles.push(handle);
		return handle;
	}

	async dispose(): Promise<void> {}
}

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function decodeClientMessages(handle: RecordingStreamHandle) {
	return handle.writes.flatMap((write) => decodeCursorConnectFrames(write).map((frame) => fromBinary(AgentClientMessageSchema, frame.data)));
}

function resolvedBlobText(messages: ReturnType<typeof decodeClientMessages>): string[] {
	return messages
		.filter((message) => message.message.case === "kvClientMessage" && message.message.value.message.case === "getBlobResult")
		.map((message) => new TextDecoder().decode(message.message.value.message.value.blobData ?? new Uint8Array()));
}

function secondTurnContext(): Context {
	return { systemPrompt: "system prompt", messages: [
		{ role: "user", content: "first question", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "first answer" }], api: "cursor-agent", provider: "cursor", model: "composer-2", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
		{ role: "user", content: "second question", timestamp: 3 },
	] };
}

describe("Cursor multi-turn conversation continuity", () => {
	test("a clean Cursor turn carries prior user and assistant context into the next turn", async () => {
		const codec = new CursorProtobufProtocolCodec();
		const userBlobId = new Uint8Array(32).fill(0xa1);
		const assistantBlobId = new Uint8Array(32).fill(0xb2);
		const checkpointBytes = checkpointBytesFor([userBlobId, assistantBlobId]);
		const peer = new ScriptedCursorPeer([
			[
				encodeCursorConnectFrame(makeKvBlobSetFrame(1, userBlobId, new TextEncoder().encode("first question"))),
				encodeCursorConnectFrame(makeKvBlobSetFrame(2, assistantBlobId, new TextEncoder().encode("first answer"))),
				checkpointFrame([userBlobId, assistantBlobId]),
				cleanEndFrame,
			],
			[
				encodeCursorConnectFrame(makeKvBlobGetFrame(1, userBlobId)),
				encodeCursorConnectFrame(makeKvBlobGetFrame(2, assistantBlobId)),
				cleanEndFrame,
			],
		]);
		const transport = new Http2CursorAgentTransport({ client: peer, codec, heartbeatIntervalMs: 0 });

		const firstTurn = await transport.run({
			accessToken: "secret", requestId: "run-multiturn-1", conversationId: "conv-multiturn", model,
			routeReference: cursorRouteReference("composer-2"),
			context: { systemPrompt: "system prompt", messages: [{ role: "user", content: "first question", timestamp: 1 }] },
		});
		for await (const _message of firstTurn.messages) { void _message; }

		const secondTurn = await transport.run({
			accessToken: "secret", requestId: "run-multiturn-2", conversationId: "conv-multiturn", model,
			routeReference: cursorRouteReference("composer-2"), context: secondTurnContext(),
		});
		for await (const _message of secondTurn.messages) { void _message; }

		const secondClientMessages = decodeClientMessages(peer.handles[1]);
		const runRequest = secondClientMessages.find((message) => message.message.case === "runRequest")?.message.value;
		assert.ok(runRequest, "second turn must send a run request");
		// The second turn reuses the server's retained checkpoint verbatim, not a client rebuild.
		assert.equal(runRequest.conversationState.clientName, "server-checkpoint");
		assert.deepEqual([...toBinary(ConversationStateStructureSchema, runRequest.conversationState)], [...checkpointBytes]);
		// Route/generation semantics are unchanged: the new user turn is still delivered.
		assert.equal(runRequest.action.action.value.userMessage.text, "second question");

		const resolvedText = resolvedBlobText(secondClientMessages);
		assert.ok(resolvedText.includes("first question"), `expected retained user context, saw ${JSON.stringify(resolvedText)}`);
		assert.ok(resolvedText.includes("first answer"), `expected retained assistant context, saw ${JSON.stringify(resolvedText)}`);
	});

	test("a mid-stream transport failure after a checkpoint does not poison the next turn", async () => {
		const codec = new CursorProtobufProtocolCodec();
		const userBlobId = new Uint8Array(32).fill(0xc3);
		const assistantBlobId = new Uint8Array(32).fill(0xd4);
		// Turn 1 emits a checkpoint mid-stream, then the connection resets before a
		// clean Connect end-stream. Turn 2 must NOT reuse that incomplete checkpoint.
		const peer = new ScriptedCursorPeer([
			{
				frames: [
					encodeCursorConnectFrame(makeKvBlobSetFrame(1, userBlobId, new TextEncoder().encode("first question"))),
					encodeCursorConnectFrame(makeKvBlobSetFrame(2, assistantBlobId, new TextEncoder().encode("first answer"))),
					checkpointFrame([userBlobId, assistantBlobId]),
				],
				failAfter: true,
			},
			[
				encodeCursorConnectFrame(makeKvBlobGetFrame(1, userBlobId)),
				encodeCursorConnectFrame(makeKvBlobGetFrame(2, assistantBlobId)),
				cleanEndFrame,
			],
		]);
		const transport = new Http2CursorAgentTransport({ client: peer, codec, heartbeatIntervalMs: 0 });

		const firstTurn = await transport.run({
			accessToken: "secret", requestId: "run-failmid-1", conversationId: "conv-failmid", model,
			routeReference: cursorRouteReference("composer-2"),
			context: { systemPrompt: "system prompt", messages: [{ role: "user", content: "first question", timestamp: 1 }] },
		});
		await assert.rejects(async () => { for await (const _message of firstTurn.messages) { void _message; } });

		const secondTurn = await transport.run({
			accessToken: "secret", requestId: "run-failmid-2", conversationId: "conv-failmid", model,
			routeReference: cursorRouteReference("composer-2"), context: secondTurnContext(),
		});
		for await (const _message of secondTurn.messages) { void _message; }

		const secondClientMessages = decodeClientMessages(peer.handles[1]);
		const runRequest = secondClientMessages.find((message) => message.message.case === "runRequest")?.message.value;
		assert.ok(runRequest);
		// The incomplete checkpoint was discarded: the next turn rebuilds from canonical history.
		assert.equal(runRequest.conversationState.clientName, "pi");
		const resolvedText = resolvedBlobText(secondClientMessages);
		assert.ok(!resolvedText.includes("first question"), `mid-stream failure must drop retained blobs, saw ${JSON.stringify(resolvedText)}`);
		assert.ok(!resolvedText.includes("first answer"), `mid-stream failure must drop retained blobs, saw ${JSON.stringify(resolvedText)}`);
	});

	test("an explicit cancel after a checkpoint does not poison the next turn", async () => {
		const codec = new CursorProtobufProtocolCodec();
		const userBlobId = new Uint8Array(32).fill(0xe5);
		const assistantBlobId = new Uint8Array(32).fill(0xf6);
		let releaseHang: () => void = () => undefined;
		const hang = new Promise<void>((resolve) => { releaseHang = resolve; });
		// Turn 1 emits a checkpoint and then a getBlob (whose response makes checkpoint
		// processing observable), then stalls until the caller cancels the stream.
		const peer = new ScriptedCursorPeer([
			{
				frames: [
					encodeCursorConnectFrame(makeKvBlobSetFrame(1, userBlobId, new TextEncoder().encode("first question"))),
					encodeCursorConnectFrame(makeKvBlobSetFrame(2, assistantBlobId, new TextEncoder().encode("first answer"))),
					checkpointFrame([userBlobId, assistantBlobId]),
					encodeCursorConnectFrame(makeKvBlobGetFrame(3, userBlobId)),
				],
				hang,
			},
			[
				encodeCursorConnectFrame(makeKvBlobGetFrame(1, userBlobId)),
				encodeCursorConnectFrame(makeKvBlobGetFrame(2, assistantBlobId)),
				cleanEndFrame,
			],
		]);
		const transport = new Http2CursorAgentTransport({ client: peer, codec, heartbeatIntervalMs: 0 });

		const firstTurn = await transport.run({
			accessToken: "secret", requestId: "run-cancel-1", conversationId: "conv-cancel", model,
			routeReference: cursorRouteReference("composer-2"),
			context: { systemPrompt: "system prompt", messages: [{ role: "user", content: "first question", timestamp: 1 }] },
		});
		const consuming = (async () => { try { for await (const _message of firstTurn.messages) { void _message; } } catch { /* cancelled */ } })();
		// Wait until turn 1 processed setBlob x2 + getBlob (4 writes incl. initialBody), proving the checkpoint was stored.
		await waitFor(() => peer.handles[0].writes.length >= 4);
		await firstTurn.cancel();
		releaseHang();
		await consuming;

		const secondTurn = await transport.run({
			accessToken: "secret", requestId: "run-cancel-2", conversationId: "conv-cancel", model,
			routeReference: cursorRouteReference("composer-2"), context: secondTurnContext(),
		});
		for await (const _message of secondTurn.messages) { void _message; }

		const secondClientMessages = decodeClientMessages(peer.handles[1]);
		const runRequest = secondClientMessages.find((message) => message.message.case === "runRequest")?.message.value;
		assert.ok(runRequest);
		// Cancellation discarded the continuation: the next turn rebuilds from canonical history.
		assert.equal(runRequest.conversationState.clientName, "pi");
		const resolvedText = resolvedBlobText(secondClientMessages);
		assert.ok(!resolvedText.includes("first question"), `cancel must drop retained blobs, saw ${JSON.stringify(resolvedText)}`);
		assert.ok(!resolvedText.includes("first answer"), `cancel must drop retained blobs, saw ${JSON.stringify(resolvedText)}`);
	});
});
