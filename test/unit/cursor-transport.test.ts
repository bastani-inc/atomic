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

	test("protobuf codec rejects orphan and duplicate historical tool results", () => {
		const codec = new CursorProtobufProtocolCodec();
		const orphanContext: Context = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "toolResult", toolCallId: "missing", toolName: "Read", content: [{ type: "text", text: "orphan" }], isError: false, timestamp: 2 },
				{ role: "user", content: "next", timestamp: 3 },
			],
		};
		assert.throws(() => codec.encodeRunRequest({ accessToken: "secret", requestId: "run-orphan", model, resolvedModelId: "composer-2", context: orphanContext }), /Orphan historical Cursor tool result/u);
		const duplicateContext: Context = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "assistant", content: [{ type: "toolCall", id: "tool-dup", name: "Read", arguments: { path: "README.md" } }], api: "cursor-agent", provider: "cursor", model: "composer-2", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
				{ role: "toolResult", toolCallId: "tool-dup", toolName: "Read", content: [{ type: "text", text: "first result" }], isError: false, timestamp: 3 },
				{ role: "toolResult", toolCallId: "tool-dup", toolName: "Read", content: [{ type: "text", text: "second result" }], isError: false, timestamp: 4 },
				{ role: "user", content: "next", timestamp: 5 },
			],
		};
		assert.throws(() => codec.encodeRunRequest({ accessToken: "secret", requestId: "run-duplicate", model, resolvedModelId: "composer-2", context: duplicateContext }), /Orphan historical Cursor tool result/u);
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
		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: agentMessage, endStream: false }), [{ type: "usage", kind: "checkpoint", usedTokens: 120 }]);
	});

	test("protobuf codec decodes exec server MCP args as tool calls", () => {
		const codec = new CursorProtobufProtocolCodec();
		const mcpArgs = cursorProtoTest.concatBytes(
			cursorProtoTest.encodeStringField(1, "search"),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("query", valueString("hello"))),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("count", valueNumber(42.5))),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("enabled", valueBool(true))),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("nothing", valueNull())),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("nested", valueStruct([["key", valueString("value")]]))),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("items", valueList([valueString("a"), valueNumber(2)]))),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("path", new TextEncoder().encode("README.md"))),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("rawNumber", new TextEncoder().encode("2024"))),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("rawBoolean", new TextEncoder().encode("true"))),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("rawNull", new TextEncoder().encode("null"))),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("options", new TextEncoder().encode("{\"limit\":3}"))),
			cursorProtoTest.encodeStringField(5, "search"),
		);
		const execServer = cursorProtoTest.concatBytes(
			cursorProtoTest.encodeMessageField(11, mcpArgs),
			cursorProtoTest.encodeVarintField(1, 99n),
			cursorProtoTest.encodeStringField(15, "exec-99"),
		);
		const agentMessage = cursorProtoTest.encodeMessageField(2, execServer);
		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: agentMessage, endStream: false }), [{
			type: "toolCall",
			id: "exec-99",
			name: "search",
			execId: "exec-99",
			execNumericId: 99,
			argumentsJson: JSON.stringify({ query: "hello", count: 42.5, enabled: true, nothing: null, nested: { key: "value" }, items: ["a", 2], path: "README.md", rawNumber: "2024", rawBoolean: "true", rawNull: "null", options: "{\"limit\":3}" }),
		}]);
	});

	test("protobuf codec rejects invalid raw MCP argument bytes", () => {
		const codec = new CursorProtobufProtocolCodec();
		const mcpArgs = cursorProtoTest.concatBytes(
			cursorProtoTest.encodeStringField(1, "search"),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("bad", new Uint8Array([0xff]))),
			cursorProtoTest.encodeStringField(5, "search"),
		);
		const execServer = cursorProtoTest.encodeMessageField(11, mcpArgs);
		const agentMessage = cursorProtoTest.encodeMessageField(2, execServer);
		assert.throws(() => codec.decodeRunFrame({ flags: 0, data: agentMessage, endStream: false }), /neither protobuf Value nor valid UTF-8/u);
	});

	test("protobuf codec decodes non-MCP exec server messages as safe notifications", () => {
		const codec = new CursorProtobufProtocolCodec();
		const requestContextExec = cursorProtoTest.encodeMessageField(2, cursorProtoTest.concatBytes(
			cursorProtoTest.encodeVarintField(1, 55n),
			cursorProtoTest.encodeMessageField(10, new Uint8Array()),
			cursorProtoTest.encodeStringField(15, "exec-context"),
		));
		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: requestContextExec, endStream: false }), [{
			type: "requestContext",
			execId: "exec-context",
			execNumericId: 55,
		}]);

		const nativeExec = cursorProtoTest.encodeMessageField(2, cursorProtoTest.encodeStringField(2, "native shell"));
		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: nativeExec, endStream: false }), [{ type: "nonMcpExec", fieldNumber: 2 }]);
	});

	test("production transport defaults to the isolated protobuf codec", async () => {
		const client = new FakeHttp2Client();
		const modelMessage = cursorProtoTest.concatBytes(
			cursorProtoTest.encodeStringField(1, "composer-2"),
			cursorProtoTest.encodeStringField(4, "Composer 2"),
			cursorProtoTest.encodeMessageField(2, new Uint8Array()),
		);
		client.unaryBody = cursorProtoTest.encodeMessageField(1, modelMessage);
		const transport = new Http2CursorAgentTransport({ client });
		const models = await transport.getUsableModels("secret-token", "request-proto");
		assert.equal(models[0]?.id, "composer-2");
		assert.equal(models[0]?.supportsThinking, true);
		assert.ok(client.unaryRequests[0]?.body instanceof Uint8Array);
	});

	test("transport request deadlines abort hung model discovery and stream opening", async () => {
		class NeverClient implements CursorHttp2Client {
			unarySignal: AbortSignal | undefined;
			streamSignal: AbortSignal | undefined;
			async requestUnary(request: { readonly signal?: AbortSignal }): Promise<{ readonly body: Uint8Array; readonly headers: Record<string, string>; readonly statusCode?: number }> {
				this.unarySignal = request.signal;
				return await new Promise(() => {});
			}
			async openStream(request: { readonly signal?: AbortSignal }): Promise<CursorHttp2StreamHandle> {
				this.streamSignal = request.signal;
				return await new Promise(() => {});
			}
			async dispose(): Promise<void> {}
		}
		const client = new NeverClient();
		const transport = new Http2CursorAgentTransport({ client, codec: new FakeCodec(), requestTimeoutMs: 1, streamOpenTimeoutMs: 60_000 });

		await assert.rejects(
			() => transport.getUsableModels("secret", "request-timeout"),
			(error) => error instanceof CursorTransportError && error.code === "NetworkError" && /timed out/u.test(error.message),
		);
		assert.equal(client.unarySignal?.aborted, true);
		await assert.rejects(
			() => transport.run({ accessToken: "secret", requestId: "run-timeout", model, resolvedModelId: "composer-2", context, openTimeoutMs: 1 }),
			(error) => error instanceof CursorTransportError && error.code === "NetworkError" && /timed out/u.test(error.message),
		);
		assert.equal(client.streamSignal?.aborted, true);
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

	test("answers internal Cursor control frames on the same stream", async () => {
		const client = new FakeHttp2Client([encodeCursorConnectFrame(new Uint8Array([9])), encodeCursorConnectFrame(new Uint8Array([1]))]);
		const transport = new Http2CursorAgentTransport({ client, codec: new FakeCodec() });
		const run = await transport.run({ accessToken: "secret", requestId: "run-control", model, resolvedModelId: "composer-2", context });
		const messages: CursorServerMessage[] = [];
		for await (const message of run.messages) messages.push(message);
		assert.deepEqual(messages, [{ type: "textDelta", text: "hi" }]);
		assert.deepEqual([...decodeCursorConnectFrames(client.streamHandle.writes[1] ?? new Uint8Array())[0]!.data], [4]);
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
