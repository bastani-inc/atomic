// @ts-nocheck
import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import { cursorRouteReference } from "./cursor-test-helpers.js";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentClientMessageSchema, ConversationStateStructureSchema } from "../../packages/cursor/src/proto/cursor-protocol.js";
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
	test("protobuf codec ignores Cursor turn-ended updates until the stream actually closes", () => {
		const codec = new CursorProtobufProtocolCodec();
		const turnEnded = cursorProtoTest.encodeMessageField(1, cursorProtoTest.encodeMessageField(14, new Uint8Array()));

		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: turnEnded, endStream: false }), []);
	});
	test("transport discards persisted Cursor conversation state on end-stream errors", async () => {
		const codec = new CursorProtobufProtocolCodec();
		const checkpoint = cursorProtoTest.concatBytes(cursorProtoTest.encodeStringField(13, "stale-checkpoint"));
		const client = new FakeHttp2Client([
			encodeCursorConnectFrame(cursorProtoTest.encodeMessageField(3, checkpoint)),
			encodeCursorConnectFrame(new TextEncoder().encode(JSON.stringify({ error: { code: "not_found", message: "Error" } })), 2),
		]);
		const transport = new Http2CursorAgentTransport({ client, codec });
		const run = await transport.run({ accessToken: "secret", requestId: "run-error-state-1", conversationId: "session-error-state", model, routeReference: cursorRouteReference("composer-2"), context: contextWithUserMessage });

		await assert.rejects(
			async () => { for await (const _message of run.messages) {} },
			(error: Error) => error instanceof CursorTransportError && /not_found/u.test(error.message),
		);

		const encodedSecondRun = codec.encodeRunRequest({ accessToken: "secret", requestId: "run-error-state-2", conversationId: "session-error-state", model, routeReference: cursorRouteReference("composer-2"), context: { messages: [{ role: "user", content: "retry", timestamp: 6 }] } });
		const runRequest = cursorProtoTest.readFields(encodedSecondRun)[0]?.value;
		assert.ok(runRequest instanceof Uint8Array);
		const conversationState = cursorProtoTest.readFields(runRequest).find((field) => field.fieldNumber === 1)?.value;
		assert.ok(conversationState instanceof Uint8Array);
		assert.notDeepEqual([...conversationState], [...checkpoint]);
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
		const [decoded] = codec.decodeRunFrame({ flags: 0, data: agentMessage, endStream: false });
		assert.equal(decoded?.type, "toolCall");
		if (decoded?.type !== "toolCall") throw new Error("expected tool call");
		assert.match(decoded.id, /^[0-9a-f-]{36}$/iu);
		assert.notEqual(decoded.id, "exec-99");
		assert.equal(decoded.name, "search");
		assert.equal(decoded.execId, "exec-99");
		assert.equal(decoded.execNumericId, 99);
		assert.equal(decoded.argumentsJson, JSON.stringify({ query: "hello", count: 42.5, enabled: true, nothing: null, nested: { key: "value" }, items: ["a", 2], path: "README.md", rawNumber: "2024", rawBoolean: "true", rawNull: "null", options: "{\"limit\":3}" }));
	});
	test("protobuf codec preserves Cursor MCP toolCallId and generates unique reference fallbacks", () => {
		const codec = new CursorProtobufProtocolCodec();
		const withToolCallId = cursorProtoTest.encodeMessageField(2, cursorProtoTest.concatBytes(
			cursorProtoTest.encodeMessageField(11, cursorProtoTest.concatBytes(cursorProtoTest.encodeStringField(1, "Read"), cursorProtoTest.encodeStringField(3, "tool-from-cursor"))),
			cursorProtoTest.encodeStringField(15, "exec-with-tool-id"),
		));
		const [preserved] = codec.decodeRunFrame({ flags: 0, data: withToolCallId, endStream: false });
		assert.equal(preserved?.type, "toolCall");
		if (preserved?.type === "toolCall") assert.equal(preserved.id, "tool-from-cursor");

		const idlessMcp = cursorProtoTest.encodeMessageField(2, cursorProtoTest.encodeMessageField(11, cursorProtoTest.encodeStringField(1, "Read")));
		const [first] = codec.decodeRunFrame({ flags: 0, data: idlessMcp, endStream: false });
		const [second] = codec.decodeRunFrame({ flags: 0, data: idlessMcp, endStream: false });
		assert.equal(first?.type, "toolCall");
		assert.equal(second?.type, "toolCall");
		if (first?.type === "toolCall" && second?.type === "toolCall") {
			assert.match(first.id, /^[0-9a-f-]{36}$/iu);
			assert.match(second.id, /^[0-9a-f-]{36}$/iu);
			assert.notEqual(first.id, second.id);
		}
	});
	test("protobuf codec decodes raw MCP argument bytes like the reference parser", () => {
		const codec = new CursorProtobufProtocolCodec();
		const mcpArgs = cursorProtoTest.concatBytes(
			cursorProtoTest.encodeStringField(1, "search"),
			cursorProtoTest.encodeMessageField(2, mcpArgEntry("bad", new Uint8Array([0xff]))),
			cursorProtoTest.encodeStringField(5, "search"),
		);
		const execServer = cursorProtoTest.encodeMessageField(11, mcpArgs);
		const agentMessage = cursorProtoTest.encodeMessageField(2, execServer);
		const [decoded] = codec.decodeRunFrame({ flags: 0, data: agentMessage, endStream: false });
		assert.equal(decoded?.type, "toolCall");
		if (decoded?.type === "toolCall") assert.equal(decoded.argumentsJson, JSON.stringify({ bad: "�" }));
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

		const nativeExec = cursorProtoTest.encodeMessageField(2, cursorProtoTest.encodeMessageField(2, new Uint8Array()));
		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: nativeExec, endStream: false }), [{ type: "nonMcpExec", fieldNumber: 2, execNumericId: 0 }]);
	});
	test("protobuf codec ignores Cursor exec span context metadata", () => {
		const codec = new CursorProtobufProtocolCodec();
		const spanContextExec = cursorProtoTest.encodeMessageField(2, cursorProtoTest.concatBytes(
			cursorProtoTest.encodeVarintField(1, 7n),
			cursorProtoTest.encodeMessageField(19, cursorProtoTest.encodeStringField(1, "trace")),
			cursorProtoTest.encodeStringField(15, "exec-span"),
		));

		assert.deepEqual(codec.decodeRunFrame({ flags: 0, data: spanContextExec, endStream: false }), []);
		assert.equal(codec.encodeServerResponse({ type: "nonMcpExec", fieldNumber: 19, execId: "exec-span", execNumericId: 7 }, "run-span"), undefined);
		assert.equal(codec.encodeServerResponse({ type: "nonMcpExec", fieldNumber: 99 }, "run-unknown"), undefined);
	});
	test("every native exec case encodes a typed safe rejection", () => {
		const codec = new CursorProtobufProtocolCodec();
		const reason = "Tool not available in this environment. Use the MCP tools provided instead.";
		for (const fieldNumber of [2, 3, 4, 5, 7, 8, 9, 14, 16, 17, 18, 20, 21, 22, 23]) {
			const bytes = codec.encodeServerResponse({ type: "nonMcpExec", fieldNumber, execId: "native", execNumericId: 1 }, "run-native");
			const message = fromBinary(AgentClientMessageSchema, bytes).message;
			assert.equal(message.case, "execClientMessage");
			if (message.case !== "execClientMessage") throw new Error("expected exec client message");
			if (fieldNumber === 9) assert.equal(message.value.message.case, "mcpResult");
			assert.match(JSON.stringify(message.value.message), new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
		}
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
		assert.equal(models[0]?.modelId, "composer-2");
		assert.equal(models[0]?.maxMode, undefined);
		assert.ok(client.unaryRequests[0]?.body instanceof Uint8Array);
	});
});
