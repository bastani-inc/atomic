// @ts-nocheck
import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
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
		for (const inlineText of ["system prompt", "first question", "first answer", "tool-1", "README.md", "tool result text", "Read a file"]) {
			assert.equal(decodedRunText.includes(inlineText), false, `encoded run unexpectedly inlined ${inlineText}`);
		}
		assert.ok(decodedRunText.includes("hello cursor"));
		const runRequest = cursorProtoTest.readFields(encodedRun)[0]?.value;
		assert.ok(runRequest instanceof Uint8Array);
		const runFields = cursorProtoTest.readFields(runRequest);
		assert.equal(runFields.some((field) => field.fieldNumber === 4), false);
		assert.equal(runFields.some((field) => field.fieldNumber === 8), false);
		const conversationState = runFields.find((field) => field.fieldNumber === 1)?.value;
		assert.ok(conversationState instanceof Uint8Array);
		const conversationFields = cursorProtoTest.readFields(conversationState);
		assert.equal(conversationFields.some((field) => field.fieldNumber === 9), false);
		assert.equal(decodedRunText.includes(`file://${process.cwd()}`), false);
		const rootPromptBlobId = conversationFields.find((field) => field.fieldNumber === 1)?.value;
		assert.ok(rootPromptBlobId instanceof Uint8Array);
		assert.equal(rootPromptBlobId.byteLength, 32);
		const turnBlobId = conversationFields.find((field) => field.fieldNumber === 8)?.value;
		assert.ok(turnBlobId instanceof Uint8Array);
		assert.equal(turnBlobId.byteLength, 32);
		const rootPromptRequest = codec.decodeRunFrame({ flags: 0, data: makeKvBlobGetFrame(17, rootPromptBlobId), endStream: false })[0];
		assert.ok(rootPromptRequest);
		const rootPromptResponse = codec.encodeServerResponse(rootPromptRequest, "run-proto");
		assert.ok(rootPromptResponse instanceof Uint8Array);
		const kvClient = cursorProtoTest.readFields(rootPromptResponse).find((field) => field.fieldNumber === 3)?.value;
		assert.ok(kvClient instanceof Uint8Array);
		const kvResult = cursorProtoTest.readFields(kvClient).find((field) => field.fieldNumber === 2)?.value;
		assert.ok(kvResult instanceof Uint8Array);
		const rootPromptBlob = cursorProtoTest.readFields(kvResult).find((field) => field.fieldNumber === 1)?.value;
		assert.ok(rootPromptBlob instanceof Uint8Array);
		assert.match(cursorProtoTest.decodeString(rootPromptBlob), /system prompt/u);
		const textDelta = cursorProtoTest.encodeMessageField(1, cursorProtoTest.encodeStringField(1, "hello"));
		const interactionUpdate = cursorProtoTest.encodeMessageField(1, textDelta);
		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: interactionUpdate, endStream: false }), [{ type: "textDelta", text: "hello" }]);
	});
	test("protobuf codec tolerates orphan and repeated historical tool results like the reference parser", () => {
		const codec = new CursorProtobufProtocolCodec();
		const orphanContext: Context = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "toolResult", toolCallId: "missing", toolName: "Read", content: [{ type: "text", text: "orphan" }], isError: false, timestamp: 2 },
				{ role: "user", content: "next", timestamp: 3 },
			],
		};
		assert.doesNotThrow(() => codec.encodeRunRequest({ accessToken: "secret", requestId: "run-orphan", model, resolvedModelId: "composer-2", context: orphanContext }));
		const duplicateContext: Context = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "assistant", content: [{ type: "toolCall", id: "tool-dup", name: "Read", arguments: { path: "README.md" } }], api: "cursor-agent", provider: "cursor", model: "composer-2", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
				{ role: "toolResult", toolCallId: "tool-dup", toolName: "Read", content: [{ type: "text", text: "first result" }], isError: false, timestamp: 3 },
				{ role: "toolResult", toolCallId: "tool-dup", toolName: "Read", content: [{ type: "text", text: "second result" }], isError: false, timestamp: 4 },
				{ role: "user", content: "next", timestamp: 5 },
			],
		};
		assert.doesNotThrow(() => codec.encodeRunRequest({ accessToken: "secret", requestId: "run-duplicate", model, resolvedModelId: "composer-2", context: duplicateContext }));
	});
	test("protobuf codec uses stable conversation ids separately from request ids", () => {
		const codec = new CursorProtobufProtocolCodec();
		const encodedRun = codec.encodeRunRequest({ accessToken: "secret", requestId: "request-a", conversationId: "session-stable", model, resolvedModelId: "composer-2", context });
		const top = cursorProtoTest.readFields(encodedRun);
		const runRequest = top[0]?.value;
		assert.ok(runRequest instanceof Uint8Array);
		const conversationField = cursorProtoTest.readFields(runRequest).find((field) => field.fieldNumber === 5)?.value;
		assert.ok(conversationField instanceof Uint8Array);
		assert.equal(cursorProtoTest.decodeString(conversationField), "session-stable");
	});
	test("protobuf codec wraps MCP tool definitions with Cursor schema field numbers", () => {
		const codec = new CursorProtobufProtocolCodec();
		const encodedRun = codec.encodeRunRequest({
			accessToken: "secret",
			requestId: "run-tools",
			model,
			resolvedModelId: "composer-2",
			context: {
				messages: [{ role: "user", content: "use tools", timestamp: 1 }],
				tools: [
					{ name: "Read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
					{ name: "Write", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
				],
			},
		});
		const top = cursorProtoTest.readFields(encodedRun);
		assert.equal(top.length, 1);
		const runRequest = top[0]?.value;
		assert.ok(runRequest instanceof Uint8Array);
		const runFields = cursorProtoTest.readFields(runRequest);
		assert.equal(runFields.some((field) => field.fieldNumber === 4), false);
		const requestContext = codec.decodeRunFrame({ flags: 0, data: makeRequestContextExecFrame(31, "request_context_args"), endStream: false })[0];
		assert.ok(requestContext);
		const response = codec.encodeServerResponse(requestContext, "run-tools");
		assert.ok(response instanceof Uint8Array);
		const execClient = cursorProtoTest.readFields(response).find((field) => field.fieldNumber === 2)?.value;
		assert.ok(execClient instanceof Uint8Array);
		const execResult = cursorProtoTest.readFields(execClient).find((field) => field.fieldNumber === 10)?.value;
		assert.ok(execResult instanceof Uint8Array);
		const successPayload = cursorProtoTest.readFields(execResult).find((field) => field.fieldNumber === 1)?.value;
		assert.ok(successPayload instanceof Uint8Array);
		const contextPayload = cursorProtoTest.readFields(successPayload).find((field) => field.fieldNumber === 1)?.value;
		assert.ok(contextPayload instanceof Uint8Array);
		const definitions = cursorProtoTest.readFields(contextPayload).filter((field) => field.fieldNumber === 7);
		assert.equal(definitions.length, 2);
		const firstDefinition = definitions[0]?.value;
		assert.ok(firstDefinition instanceof Uint8Array);
		const definitionFields = new Map(cursorProtoTest.readFields(firstDefinition).map((field) => [field.fieldNumber, field.value]));
		assert.equal(cursorProtoTest.decodeString(definitionFields.get(1) as Uint8Array), "Read");
		assert.equal(cursorProtoTest.decodeString(definitionFields.get(2) as Uint8Array), "Read a file");
		assert.deepEqual(cursorProtoTest.decodeValue(definitionFields.get(3) as Uint8Array), { type: "object", properties: { path: { type: "string" } } });
		assert.equal(cursorProtoTest.decodeString(definitionFields.get(4) as Uint8Array), "pi");
		assert.equal(cursorProtoTest.decodeString(definitionFields.get(5) as Uint8Array), "Read");
	});
	test("protobuf codec encodes tool results as exec client MCP results", () => {
		const codec = new CursorProtobufProtocolCodec();
		const encoded = codec.encodeToolResult({ toolCallId: "tool-1", toolName: "Read", text: "file contents", isError: false, execId: "exec-1", execNumericId: 7 });
		const agentFields = cursorProtoTest.readFields(encoded);
		assert.equal(agentFields[0]?.fieldNumber, 2);
		const execMessage = agentFields[0]?.value;
		assert.ok(execMessage instanceof Uint8Array);
		const execFields = cursorProtoTest.readFields(execMessage);
		assert.equal(execFields.find((field) => field.fieldNumber === 1)?.value, 7n);
		assert.equal(cursorProtoTest.decodeString(execFields.find((field) => field.fieldNumber === 15)?.value as Uint8Array), "exec-1");
		const result = execFields.find((field) => field.fieldNumber === 11)?.value;
		assert.ok(result instanceof Uint8Array);
		assert.equal(new TextDecoder().decode(encoded).includes("toolResult:tool-1"), false);
		assert.equal(new TextDecoder().decode(encoded).includes("file contents"), true);
	});
	test("protobuf codec skips unknown fixed32 fields while decoding known messages", () => {
		const codec = new CursorProtobufProtocolCodec();
		const textDelta = cursorProtoTest.encodeMessageField(1, cursorProtoTest.encodeStringField(1, "hello"));
		const interactionUpdate = cursorProtoTest.encodeMessageField(1, textDelta);
		const frame = cursorProtoTest.concatBytes(cursorProtoTest.encodeFixed32Field(99, 123), interactionUpdate);

		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: frame, endStream: false }), [{ type: "textDelta", text: "hello" }]);
	});
	test("protobuf codec decodes checkpoint token details without treating max tokens as output", () => {
		const codec = new CursorProtobufProtocolCodec();
		const tokenDetails = cursorProtoTest.concatBytes(cursorProtoTest.encodeVarintField(1, 120n), cursorProtoTest.encodeVarintField(2, 2000n));
		const checkpoint = cursorProtoTest.concatBytes(
			cursorProtoTest.encodeMessageField(1, cursorProtoTest.encodeStringField(1, "prompt json should be ignored")),
			cursorProtoTest.encodeMessageField(5, tokenDetails),
		);
		const agentMessage = cursorProtoTest.encodeMessageField(3, checkpoint);
		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: agentMessage, endStream: false }), [
			{ type: "conversationCheckpoint", checkpoint },
			{ type: "usage", kind: "checkpoint", usedTokens: 120 },
		]);
	});
});
