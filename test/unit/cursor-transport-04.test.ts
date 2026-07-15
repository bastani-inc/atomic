// @ts-nocheck
import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import {
	CursorConnectFrameDecoder,
	CursorProtobufProtocolCodec,
	CursorTransportError,
	createNativeCursorHttp2ClientForTest,
	decodeCursorConnectFrames,
	encodeCursorConnectFrame,
	Http2CursorAgentTransport,
	type CursorConnectFrame,
	type CursorHttp2Client,
	type CursorHttp2StreamHandle,
	type CursorProtocolCodec,
	type CursorRunRequest,
	type CursorServerMessage,
} from "../../packages/cursor/src/transport.js";
import type { CursorH2NativeBinding, CursorH2NativeStream, CursorH2NativeUnaryResponse } from "../../packages/cursor/src/native-loader.js";
import { cursorProtoTest } from "./cursor-proto-test-helpers.js";

class FakeStreamHandle implements CursorHttp2StreamHandle {
	readonly writes: Uint8Array[] = [];
	readonly frames: AsyncIterable<Uint8Array>;
	closed = false;
	cancelled = false;

	constructor(frames: readonly Uint8Array[]) {
		this.frames = (async function* (): AsyncIterable<Uint8Array> {
			for (const frame of frames) yield frame;
		})();
	}

	async write(data: Uint8Array): Promise<void> {
		this.writes.push(data);
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	async cancel(): Promise<void> {
		this.cancelled = true;
	}
}

class NeverSettlingStreamHandle extends FakeStreamHandle {
	override cancel(): Promise<void> {
		this.cancelled = true;
		return new Promise(() => {});
	}
	override close(): Promise<void> {
		this.closed = true;
		return new Promise(() => {});
	}
}

class FakeHttp2Client implements CursorHttp2Client {
	unaryRequests: Array<{ path: string; headers: Record<string, string>; body: Uint8Array }> = [];
	streamRequests: Array<{ path: string; headers: Record<string, string> }> = [];
	streamHandle: FakeStreamHandle;
	unaryBody: Uint8Array<ArrayBufferLike> = new Uint8Array([1, 2, 3]);
	unaryStatus = 200;
	disposed = false;

	constructor(frames: readonly Uint8Array[] = []) {
		this.streamHandle = new FakeStreamHandle(frames);
	}

	async requestUnary(request: { readonly path: string; readonly headers: Record<string, string>; readonly body: Uint8Array }): Promise<{ readonly body: Uint8Array; readonly headers: Record<string, string>; readonly statusCode?: number }> {
		this.unaryRequests.push({ path: request.path, headers: request.headers, body: request.body });
		return { statusCode: this.unaryStatus, body: this.unaryBody, headers: {} };
	}

	async openStream(request: { readonly path: string; readonly headers: Record<string, string>; readonly initialBody?: Uint8Array }): Promise<CursorHttp2StreamHandle> {
		this.streamRequests.push({ path: request.path, headers: request.headers });
		if (request.initialBody) await this.streamHandle.write(request.initialBody);
		return this.streamHandle;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

class FakeCodec implements CursorProtocolCodec {
	readonly modelRequest = new Uint8Array([9]);
	readonly runRequest = new Uint8Array([8]);
	readonly cancelRequest = new Uint8Array([7]);
	readonly heartbeatRequest = new Uint8Array([6]);
	readonly toolResultRequest = new Uint8Array([5]);
	decodedUnary: Uint8Array | undefined;
	decodedFrames: CursorConnectFrame[] = [];

	encodeGetUsableModelsRequest(): Uint8Array {
		return this.modelRequest;
	}

	decodeGetUsableModelsResponse(data: Uint8Array) {
		this.decodedUnary = data;
		return [{ id: "composer-2", displayName: "Composer 2", supportsThinking: true }];
	}

	encodeRunRequest(_request: CursorRunRequest): Uint8Array {
		return this.runRequest;
	}

	decodeRunFrame(frame: CursorConnectFrame): readonly CursorServerMessage[] {
		this.decodedFrames.push(frame);
		const value = frame.data[0];
		if (value === 1) return [{ type: "textDelta", text: "hi" }];
		if (value === 2) return [{ type: "thinkingDelta", text: "think" }];
		if (value === 3) return [{ type: "usage", kind: "checkpoint", inputTokens: 4, outputTokens: 5 }];
		if (value === 9) return [{ type: "nonMcpExec", fieldNumber: 10, execId: "request_context_args", execNumericId: 9 }];
		return [{ type: "done", reason: "stop" }];
	}

	encodeServerResponse(message: CursorServerMessage): Uint8Array | undefined {
		return message.type === "nonMcpExec" && message.fieldNumber === 10 ? new Uint8Array([4]) : undefined;
	}

	encodeToolResult(): Uint8Array {
		return this.toolResultRequest;
	}

	encodeCancelRequest(): Uint8Array {
		return this.cancelRequest;
	}

	encodeHeartbeatRequest(): Uint8Array {
		return this.heartbeatRequest;
	}
}

function makeRequestContextExecFrame(execId: number, commandId: string): Uint8Array {
	return cursorProtoTest.encodeMessageField(
		2,
		cursorProtoTest.concatBytes(
			cursorProtoTest.encodeVarintField(1, BigInt(execId)),
			cursorProtoTest.encodeMessageField(10, new Uint8Array()),
			cursorProtoTest.encodeStringField(15, commandId),
		),
	);
}

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

const context: Context = { messages: [], systemPrompt: "" };

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

const contextWithUserMessage: Context = {
	systemPrompt: "system prompt",
	messages: [
		{ role: "user", content: "first question", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "first answer" }, { type: "toolCall", id: "tool-1", name: "Read", arguments: { path: "README.md" } }], api: "cursor-agent", provider: "cursor", model: "composer-2", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
		{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "tool result text" }], isError: false, timestamp: 3 },
		{ role: "user", content: "hello cursor", timestamp: 4 },
	],
	tools: [{ name: "Read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
};

function valueString(value: string): Uint8Array {
	return cursorProtoTest.encodeStringField(3, value);
}

function valueNumber(value: number): Uint8Array {
	return cursorProtoTest.encodeDoubleField(2, value);
}

function valueBool(value: boolean): Uint8Array {
	return cursorProtoTest.encodeVarintField(4, value ? 1n : 0n);
}

function valueNull(): Uint8Array {
	return cursorProtoTest.encodeVarintField(1, 0n);
}

function valueStruct(entries: readonly [string, Uint8Array][]): Uint8Array {
	return cursorProtoTest.encodeMessageField(5, cursorProtoTest.concatBytes(...entries.map(([key, value]) => cursorProtoTest.encodeMessageField(1, cursorProtoTest.concatBytes(cursorProtoTest.encodeStringField(1, key), cursorProtoTest.encodeMessageField(2, value))))));
}

function valueList(values: readonly Uint8Array[]): Uint8Array {
	return cursorProtoTest.encodeMessageField(6, cursorProtoTest.concatBytes(...values.map((value) => cursorProtoTest.encodeMessageField(1, value))));
}

function mcpArgEntry(key: string, value: Uint8Array): Uint8Array {
	return cursorProtoTest.concatBytes(cursorProtoTest.encodeStringField(1, key), cursorProtoTest.encodeMessageField(2, value));
}

describe("Cursor HTTP2 transport boundary", () => {
	test("answers internal Cursor control frames before public messages are consumed", async () => {
		const client = new FakeHttp2Client([encodeCursorConnectFrame(new Uint8Array([9])), encodeCursorConnectFrame(new Uint8Array([1]))]);
		const transport = new Http2CursorAgentTransport({ client, codec: new FakeCodec() });
		const run = await transport.run({ accessToken: "secret", requestId: "run-background-control", model, resolvedModelId: "composer-2", context });

		await waitFor(() => client.streamHandle.writes.length >= 2);

		assert.deepEqual([...decodeCursorConnectFrames(client.streamHandle.writes[1] ?? new Uint8Array())[0]!.data], [4]);
		const iterator = run.messages[Symbol.asyncIterator]();
		const first = await iterator.next();
		assert.equal(first.done, false);
		assert.deepEqual(first.value, { type: "textDelta", text: "hi" });
		await run.close();
	});
	test("cancel writes a framed cancel request and updates lifecycle", async () => {
		const client = new FakeHttp2Client();
		const codec = new FakeCodec();
		const transport = new Http2CursorAgentTransport({ client, codec });
		const run = await transport.run({ accessToken: "secret", requestId: "run-2", model, resolvedModelId: "composer-2", context });
		await run.cancel();
		assert.deepEqual([...decodeCursorConnectFrames(client.streamHandle.writes[1] ?? new Uint8Array())[0]!.data], [7]);
		assert.equal(client.streamHandle.cancelled, true);
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1 });
	});
	test("releases transport bookkeeping synchronously before underlying cancel or close settles", async () => {
		const cancelClient = new FakeHttp2Client();
		cancelClient.streamHandle = new NeverSettlingStreamHandle([]);
		const cancelTransport = new Http2CursorAgentTransport({ client: cancelClient, codec: new FakeCodec() });
		const cancelling = await cancelTransport.run({ accessToken: "secret", requestId: "run-never-cancel", model, resolvedModelId: "composer-2", context });
		void cancelling.cancel().catch(() => undefined);
		assert.deepEqual(cancelTransport.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 1, closedStreams: 1 });

		const closeClient = new FakeHttp2Client();
		closeClient.streamHandle = new NeverSettlingStreamHandle([]);
		const closeTransport = new Http2CursorAgentTransport({ client: closeClient, codec: new FakeCodec() });
		const closing = await closeTransport.run({ accessToken: "secret", requestId: "run-never-close", model, resolvedModelId: "composer-2", context });
		void closing.close().catch(() => undefined);
		assert.deepEqual(closeTransport.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 0, closedStreams: 1 });
		await cancelTransport.dispose();
		await closeTransport.dispose();
	});
	test("classifies Connect end-stream errors", async () => {
		const cases: Array<{ code: string; expected: string }> = [
			{ code: "resource_exhausted", expected: "NetworkError" },
			{ code: "unavailable", expected: "NetworkError" },
			{ code: "unauthenticated", expected: "Unauthorized" },
			{ code: "canceled", expected: "Aborted" },
			{ code: "permission_denied", expected: "CursorApiRejected" },
		];
		for (const item of cases) {
			const client = new FakeHttp2Client([encodeCursorConnectFrame(new TextEncoder().encode(JSON.stringify({ error: { code: item.code, message: "secret-token problem" } })), 2)]);
			const transport = new Http2CursorAgentTransport({ client, codec: new FakeCodec() });
			const run = await transport.run({ accessToken: "secret-token", requestId: `run-${item.code}`, model, resolvedModelId: "composer-2", context });
			await assert.rejects(
				async () => { for await (const _message of run.messages) {} },
				(error: Error) => error instanceof CursorTransportError && error.code === item.expected && !error.message.includes("secret-token"),
			);
		}
	});
	test("classifies malformed and code-less Connect end-stream errors", async () => {
		const cases = [
			{
				name: "malformed",
				body: new TextEncoder().encode("not-json"),
				predicate: (error: Error) => error instanceof CursorTransportError && error.code === "ProtocolError" && /Failed to parse/u.test(error.message),
			},
			{
				name: "unknown",
				body: new TextEncoder().encode(JSON.stringify({ error: { message: "missing code secret" } })),
				predicate: (error: Error) => error instanceof CursorTransportError && error.code === "CursorApiRejected" && /unknown/u.test(error.message) && !error.message.includes("secret"),
			},
		];
		for (const item of cases) {
			const client = new FakeHttp2Client([encodeCursorConnectFrame(item.body, 2)]);
			const transport = new Http2CursorAgentTransport({ client, codec: new FakeCodec() });
			const run = await transport.run({ accessToken: "secret", requestId: `run-end-${item.name}`, model, resolvedModelId: "composer-2", context });
			await assert.rejects(async () => { for await (const _message of run.messages) {} }, item.predicate);
		}
	});
	test("ignores legacy top-level Connect end-stream frames", async () => {
		const client = new FakeHttp2Client([
			encodeCursorConnectFrame(new TextEncoder().encode(JSON.stringify({ metadata: {} })), 2),
			encodeCursorConnectFrame(new TextEncoder().encode(JSON.stringify({ code: "resource_exhausted" })), 2),
		]);
		const transport = new Http2CursorAgentTransport({ client, codec: new FakeCodec() });
		const run = await transport.run({ accessToken: "secret", requestId: "run-end-ok", model, resolvedModelId: "composer-2", context });
		const messages: CursorServerMessage[] = [];
		for await (const message of run.messages) messages.push(message);
		assert.deepEqual(messages, []);
	});
	test("classifies non-2xx Cursor responses without leaking credentials", async () => {
		const client = new FakeHttp2Client();
		client.unaryStatus = 403;
		client.unaryBody = new TextEncoder().encode("access token secret-token rejected");
		const transport = new Http2CursorAgentTransport({ client, codec: new FakeCodec() });
		await assert.rejects(
			() => transport.getUsableModels("secret-token", "request-403"),
			(error: Error) => error instanceof CursorTransportError
				&& error.message.includes("HTTP 403")
				&& error.message.includes("Cursor CLI-compatible client version")
				&& !error.message.includes("secret-token"),
		);
	});
	test("aborted requests fail without the previous unconditional stub message", async () => {
		const controller = new AbortController();
		controller.abort();
		const transport = new Http2CursorAgentTransport({ client: new FakeHttp2Client(), codec: new FakeCodec() });
		await assert.rejects(
			() => transport.run({ accessToken: "secret", requestId: "run-3", model, resolvedModelId: "composer-2", context, signal: controller.signal }),
			(error: Error) => !error.message.includes("deferred; no proxy or child-process bridge"),
		);
	});
});
