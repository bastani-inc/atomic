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
	test("production codec decodes Connect-framed model discovery responses", async () => {
		const client = new FakeHttp2Client();
		const modelMessage = cursorProtoTest.concatBytes(cursorProtoTest.encodeStringField(1, "gpt-5.4-high"), cursorProtoTest.encodeStringField(4, "GPT-5.4 High"));
		client.unaryBody = encodeCursorConnectFrame(cursorProtoTest.encodeMessageField(1, modelMessage));
		const transport = new Http2CursorAgentTransport({ client });

		const models = await transport.getUsableModels("secret-token", "request-connect-proto");

		assert.equal(models[0]?.id, "gpt-5.4-high");
		assert.equal(models[0]?.displayName, "GPT-5.4 High");
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
	test("transport aborts promptly while native-like model discovery and stream opening are pending", async () => {
		class SignalIgnoringClient implements CursorHttp2Client {
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
		const client = new SignalIgnoringClient();
		const transport = new Http2CursorAgentTransport({ client, codec: new FakeCodec(), requestTimeoutMs: 60_000, streamOpenTimeoutMs: 60_000 });

		const unaryController = new AbortController();
		const unaryPromise = transport.getUsableModels("secret", "request-abort", unaryController.signal);
		await new Promise((resolve) => setTimeout(resolve, 0));
		unaryController.abort();
		await assert.rejects(
			() => Promise.race([
				unaryPromise,
				new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("still-pending-after-abort")), 25)),
			]),
			(error) => error instanceof CursorTransportError && error.code === "Aborted",
		);
		assert.equal(client.unarySignal?.aborted, true);

		const streamController = new AbortController();
		const streamPromise = transport.run({ accessToken: "secret", requestId: "run-abort", model, resolvedModelId: "composer-2", context, signal: streamController.signal });
		await new Promise((resolve) => setTimeout(resolve, 0));
		streamController.abort();
		await assert.rejects(
			() => Promise.race([
				streamPromise,
				new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("still-pending-after-abort")), 25)),
			]),
			(error) => error instanceof CursorTransportError && error.code === "Aborted",
		);
		assert.equal(client.streamSignal?.aborted, true);
		assert.deepEqual(transport.getLifecycleSnapshot(), { openStreams: 0, cancelledStreams: 0, closedStreams: 0 });
	});
	test("native client passes operation deadlines to Rust and cancels pending native operations", async () => {
		const cancelled: string[] = [];
		let unaryConfig: { operationId?: string; timeoutMs?: number } | undefined;
		let streamConfig: { operationId?: string; timeoutMs?: number } | undefined;
		const binding: CursorH2NativeBinding = {
			cursorH2RequestUnary(configJson: string): Promise<CursorH2NativeUnaryResponse> {
				unaryConfig = JSON.parse(configJson) as { operationId?: string; timeoutMs?: number };
				return new Promise(() => {});
			},
			cursorH2OpenStream(configJson: string): Promise<CursorH2NativeStream> {
				streamConfig = JSON.parse(configJson) as { operationId?: string; timeoutMs?: number };
				return new Promise(() => {});
			},
			cursorH2CancelOperation(operationId: string): void {
				cancelled.push(operationId);
			},
		};
		const client = createNativeCursorHttp2ClientForTest(binding);

		const unaryController = new AbortController();
		const unary = client.requestUnary({ baseUrl: "https://api2.cursor.sh", path: "/unary", headers: {}, body: new Uint8Array(), signal: unaryController.signal, timeoutMs: 123 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		unaryController.abort();
		await assert.rejects(() => unary, (error) => error instanceof CursorTransportError && error.code === "Aborted");
		assert.equal(unaryConfig?.timeoutMs, 123);
		assert.equal(typeof unaryConfig?.operationId, "string");
		assert.ok(cancelled.includes(unaryConfig?.operationId ?? ""));

		const streamController = new AbortController();
		const stream = client.openStream({ baseUrl: "https://api2.cursor.sh", path: "/stream", headers: {}, signal: streamController.signal, timeoutMs: 456 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		streamController.abort();
		await assert.rejects(() => stream, (error) => error instanceof CursorTransportError && error.code === "Aborted");
		assert.equal(streamConfig?.timeoutMs, 456);
		assert.equal(typeof streamConfig?.operationId, "string");
		assert.ok(cancelled.includes(streamConfig?.operationId ?? ""));
	});
	test("native stream handle honors write abort and timeout options", async () => {
		const writes: Array<{ data: Uint8Array; timeoutMs?: number | null }> = [];
		let cancelled = false;
		const nativeStream: CursorH2NativeStream = {
			write(data: Uint8Array, timeoutMs?: number | null): Promise<void> {
				writes.push({ data, timeoutMs });
				return new Promise(() => {});
			},
			async finishInput(): Promise<void> {},
			async nextFrame(): Promise<Uint8Array | null> { return null; },
			async cancel(): Promise<void> { cancelled = true; },
		};
		const binding: CursorH2NativeBinding = {
			async cursorH2RequestUnary(): Promise<CursorH2NativeUnaryResponse> {
				return { headersJson: "{}", body: new Uint8Array() };
			},
			async cursorH2OpenStream(): Promise<CursorH2NativeStream> {
				return nativeStream;
			},
			cursorH2CancelOperation(): void {},
		};
		const handle = await createNativeCursorHttp2ClientForTest(binding).openStream({ baseUrl: "https://api2.cursor.sh", path: "/stream", headers: {}, timeoutMs: 1000 });
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(
			() => handle.write(new Uint8Array([1]), { signal: aborted.signal }),
			(error) => error instanceof CursorTransportError && error.code === "Aborted",
		);
		assert.equal(writes.length, 0);

		await assert.rejects(
			() => handle.write(new Uint8Array([2]), { timeoutMs: 1 }),
			(error) => error instanceof CursorTransportError && error.code === "NetworkError" && /timed out/u.test(error.message),
		);
		assert.equal(writes[0]?.timeoutMs, 1);
		assert.equal(cancelled, true);
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
	test("writes reference Cursor heartbeats while a Run stream is open", async () => {
		const client = new FakeHttp2Client();
		const transport = new Http2CursorAgentTransport({ client, codec: new FakeCodec(), heartbeatIntervalMs: 1 });
		const run = await transport.run({ accessToken: "secret", requestId: "run-heartbeat", model, resolvedModelId: "composer-2", context });

		await new Promise((resolve) => setTimeout(resolve, 5));

		const writtenPayloads = client.streamHandle.writes.map((write) => [...decodeCursorConnectFrames(write)[0]!.data]);
		assert.deepEqual(writtenPayloads[0], [8]);
		assert.ok(writtenPayloads.slice(1).some((payload) => payload.length === 1 && payload[0] === 6));
		await run.close();
		const writesAfterClose = client.streamHandle.writes.length;
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(client.streamHandle.writes.length, writesAfterClose);
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
});
