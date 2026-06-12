import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
	CursorConnectFrameDecoder,
	CursorProtobufProtocolCodec,
	CursorTransportError,
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
import { __cursorProtoTest } from "../../packages/cursor/src/proto/protobuf-codec.js";

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
		return [{ type: "done", reason: "stop" }];
	}

	encodeCancelRequest(): Uint8Array {
		return this.cancelRequest;
	}

	encodeHeartbeatRequest(): Uint8Array {
		return this.heartbeatRequest;
	}
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

describe("Cursor HTTP2 transport boundary", () => {
	test("encodes and decodes Connect frames", () => {
		const encoded = encodeCursorConnectFrame(new Uint8Array([1, 2, 3]), 2);
		assert.deepEqual([...encoded], [2, 0, 0, 0, 3, 1, 2, 3]);
		const decoded = decodeCursorConnectFrames(encoded);
		assert.equal(decoded.length, 1);
		assert.equal(decoded[0]?.endStream, true);
		assert.deepEqual([...(decoded[0]?.data ?? [])], [1, 2, 3]);
	});

	test("buffers split Connect frames across HTTP/2 chunks", () => {
		const encoded = encodeCursorConnectFrame(new Uint8Array([1, 2, 3]));
		const decoder = new CursorConnectFrameDecoder();
		assert.deepEqual(decoder.push(encoded.slice(0, 2)), []);
		assert.deepEqual(decoder.push(encoded.slice(2, 6)), []);
		const frames = decoder.push(encoded.slice(6));
		assert.equal(frames.length, 1);
		assert.deepEqual([...(frames[0]?.data ?? [])], [1, 2, 3]);
		decoder.finish();
	});

	test("protobuf codec decodes Cursor model discovery and text frames", () => {
		const codec = new CursorProtobufProtocolCodec();
		const encodedRun = codec.encodeRunRequest({ accessToken: "secret", requestId: "run-proto", model, resolvedModelId: "composer-2", context: contextWithUserMessage });
		const decodedRunText = new TextDecoder().decode(encodedRun);
		for (const expected of ["system prompt", "first question", "first answer", "tool-1", "README.md", "tool result text", "hello cursor", "Read a file"]) {
			assert.ok(decodedRunText.includes(expected), `encoded run omitted ${expected}`);
		}
		const textDelta = __cursorProtoTest.encodeMessageField(1, __cursorProtoTest.encodeStringField(1, "hello"));
		const interactionUpdate = __cursorProtoTest.encodeMessageField(1, textDelta);
		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: interactionUpdate, endStream: false }), [{ type: "textDelta", text: "hello" }]);
	});

	test("protobuf codec decodes exec server MCP args as tool calls", () => {
		const codec = new CursorProtobufProtocolCodec();
		const argEntry = __cursorProtoTest.concatBytes(
			__cursorProtoTest.encodeStringField(1, "query"),
			__cursorProtoTest.encodeMessageField(2, new TextEncoder().encode("hello")),
		);
		const mcpArgs = __cursorProtoTest.concatBytes(
			__cursorProtoTest.encodeStringField(1, "search"),
			__cursorProtoTest.encodeMessageField(2, argEntry),
			__cursorProtoTest.encodeStringField(3, "tool-1"),
			__cursorProtoTest.encodeStringField(5, "search"),
		);
		const execServer = __cursorProtoTest.encodeMessageField(11, mcpArgs);
		const agentMessage = __cursorProtoTest.encodeMessageField(2, execServer);
		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: agentMessage, endStream: false }), [{ type: "toolCall", id: "tool-1", name: "search", argumentsJson: JSON.stringify({ query: "hello" }) }]);
	});

	test("protobuf codec rejects unsupported exec server messages", () => {
		const codec = new CursorProtobufProtocolCodec();
		const unsupportedExec = __cursorProtoTest.encodeMessageField(2, __cursorProtoTest.encodeStringField(2, "native shell"));
		assert.throws(() => codec.decodeRunFrame({ flags: 0, data: unsupportedExec, endStream: false }), /Unsupported Cursor exec server message/u);
	});

	test("production transport defaults to the isolated protobuf codec", async () => {
		const client = new FakeHttp2Client();
		const modelMessage = __cursorProtoTest.concatBytes(
			__cursorProtoTest.encodeStringField(1, "composer-2"),
			__cursorProtoTest.encodeStringField(4, "Composer 2"),
			__cursorProtoTest.encodeMessageField(2, new Uint8Array()),
		);
		client.unaryBody = __cursorProtoTest.encodeMessageField(1, modelMessage);
		const transport = new Http2CursorAgentTransport({ client });
		const models = await transport.getUsableModels("secret-token", "request-proto");
		assert.equal(models[0]?.id, "composer-2");
		assert.equal(models[0]?.supportsThinking, true);
		assert.ok(client.unaryRequests[0]?.body instanceof Uint8Array);
	});

	test("getUsableModels sends Cursor headers/path/body and decodes response", async () => {
		const client = new FakeHttp2Client();
		const codec = new FakeCodec();
		const transport = new Http2CursorAgentTransport({ client, codec });
		const models = await transport.getUsableModels("secret-token", "request-1");
		assert.equal(models[0]?.id, "composer-2");
		assert.equal(client.unaryRequests[0]?.path, "/agent.v1.AgentService/GetUsableModels");
		assert.equal(client.unaryRequests[0]?.headers.authorization, "Bearer secret-token");
		assert.equal(client.unaryRequests[0]?.headers["content-type"], "application/proto");
		assert.deepEqual([...(client.unaryRequests[0]?.body ?? [])], [9]);
		assert.deepEqual([...(codec.decodedUnary ?? [])], [1, 2, 3]);
	});

	test("run writes a framed request and decodes streamed messages", async () => {
		const client = new FakeHttp2Client([
			encodeCursorConnectFrame(new Uint8Array([1])),
			encodeCursorConnectFrame(new Uint8Array([2])),
			encodeCursorConnectFrame(new Uint8Array([3])),
			encodeCursorConnectFrame(new Uint8Array([4])),
		]);
		const codec = new FakeCodec();
		const transport = new Http2CursorAgentTransport({ client, codec });
		const run = await transport.run({ accessToken: "secret", requestId: "run-1", model, resolvedModelId: "composer-2", context });
		assert.equal(client.streamRequests[0]?.path, "/agent.v1.AgentService/Run");
		assert.equal(client.streamRequests[0]?.headers["connect-protocol-version"], "1");
		assert.deepEqual([...decodeCursorConnectFrames(client.streamHandle.writes[0] ?? new Uint8Array())[0]!.data], [8]);
		const messages: CursorServerMessage[] = [];
		for await (const message of run.messages) messages.push(message);
		assert.deepEqual(messages.map((message) => message.type), ["textDelta", "thinkingDelta", "usage", "done"]);
		await run.close();
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 0, closedStreams: 1 });
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

	test("ignores empty and legacy top-level Connect end-stream frames", async () => {
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
			(error: Error) => error instanceof CursorTransportError && error.message.includes("HTTP 403") && !error.message.includes("secret-token"),
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
