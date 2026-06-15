import type { Context, Model, Api, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	buildCursorRpcHeaders,
	CURSOR_API_BASE_URL,
	CURSOR_CLIENT_VERSION,
	CURSOR_GET_USABLE_MODELS_PATH,
	CURSOR_RUN_PATH,
	readStringField,
	sanitizeDiagnosticText,
	parseJsonObject,
	type JsonObject,
} from "./config.js";
import type { CursorUsableModel } from "./model-mapper.js";
import {
	formatCursorH2NativeLoadFailure,
	loadCursorH2NativeBinding,
	type CursorH2NativeBinding,
	type CursorH2NativeStream,
} from "./native-loader.js";
import { CursorProtobufProtocolCodec } from "./proto/protobuf-codec.js";
export { CursorProtobufProtocolCodec } from "./proto/protobuf-codec.js";

export type CursorTransportErrorCode = "Unauthorized" | "CursorApiRejected" | "Aborted" | "NetworkError" | "ProtocolError";

export class CursorTransportError extends Error {
	constructor(
		readonly code: CursorTransportErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CursorTransportError";
	}
}

export interface CursorTransportLifecycleSnapshot {
	readonly openStreams: number;
	readonly cancelledStreams: number;
	readonly closedStreams: number;
}

export interface CursorRunRequest {
	readonly accessToken: string;
	readonly requestId: string;
	readonly conversationId?: string;
	readonly model: Model<Api>;
	readonly resolvedModelId: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly context: Context;
	readonly signal?: AbortSignal;
	readonly openTimeoutMs?: number;
}

export type CursorDoneReason = "stop" | "length" | "toolUse";

export interface CursorToolCallMessage {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly argumentsJson: string;
	readonly execId?: string;
	readonly execNumericId?: number;
}

export type CursorServerMessage =
	| { readonly type: "textDelta"; readonly text: string }
	| { readonly type: "thinkingDelta"; readonly text: string }
	| CursorToolCallMessage
	| { readonly type: "usage"; readonly kind?: "checkpoint"; readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly usedTokens?: number }
	| { readonly type: "usage"; readonly kind: "outputDelta"; readonly outputTokens: number }
	| { readonly type: "nonMcpExec"; readonly fieldNumber: number; readonly execId?: string; readonly execNumericId?: number }
	| { readonly type: "done"; readonly reason: CursorDoneReason };

export type CursorControlMessage =
	| { readonly type: "kvGetBlob"; readonly id: number; readonly blobId: Uint8Array }
	| { readonly type: "kvSetBlob"; readonly id: number; readonly blobId: Uint8Array; readonly blobData: Uint8Array }
	| { readonly type: "conversationCheckpoint"; readonly checkpoint: Uint8Array }
	| { readonly type: "requestContext"; readonly execNumericId?: number; readonly execId?: string };

export type CursorProtocolMessage = CursorServerMessage | CursorControlMessage;

export interface CursorToolResultMessage {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly text: string;
	readonly isError: boolean;
	readonly execId?: string;
	readonly execNumericId?: number;
}

export interface CursorWriteOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface CursorRunStream {
	readonly id: string;
	readonly messages: AsyncIterable<CursorServerMessage>;
	writeToolResult(result: CursorToolResultMessage, options?: CursorWriteOptions): Promise<void>;
	cancel(): Promise<void>;
	close(): Promise<void>;
}

export interface CursorAgentTransport {
	getUsableModels(accessToken: string, requestId: string, signal?: AbortSignal): Promise<readonly CursorUsableModel[]>;
	run(request: CursorRunRequest): Promise<CursorRunStream>;
	dispose(): Promise<void>;
	discardConversation?(conversationId: string): void;
	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot;
}

export interface CursorConnectFrame {
	readonly flags: number;
	readonly data: Uint8Array;
	readonly endStream: boolean;
}

export interface CursorHttp2UnaryResponse {
	readonly statusCode?: number;
	readonly body: Uint8Array;
	readonly headers: Record<string, string>;
}

export interface CursorHttp2StreamHandle {
	readonly frames: AsyncIterable<Uint8Array>;
	write(data: Uint8Array, options?: CursorWriteOptions): Promise<void>;
	close(): Promise<void>;
	cancel(): Promise<void>;
}

export interface CursorHttp2Client {
	requestUnary(request: {
		readonly baseUrl: string;
		readonly path: string;
		readonly headers: Record<string, string>;
		readonly body: Uint8Array;
		readonly signal?: AbortSignal;
		readonly timeoutMs?: number;
	}): Promise<CursorHttp2UnaryResponse>;
	openStream(request: {
		readonly baseUrl: string;
		readonly path: string;
		readonly headers: Record<string, string>;
		readonly signal?: AbortSignal;
		readonly initialBody?: Uint8Array;
		readonly timeoutMs?: number;
	}): Promise<CursorHttp2StreamHandle>;
	dispose(): Promise<void>;
}

export interface CursorProtocolCodec {
	encodeGetUsableModelsRequest(): Uint8Array;
	decodeGetUsableModelsResponse(data: Uint8Array): readonly CursorUsableModel[];
	encodeRunRequest(request: CursorRunRequest): Uint8Array;
	decodeRunFrame(frame: CursorConnectFrame): readonly CursorProtocolMessage[];
	encodeToolResult(result: CursorToolResultMessage): Uint8Array;
	encodeCancelRequest(): Uint8Array;
	encodeHeartbeatRequest(): Uint8Array;
	encodeServerResponse?(message: CursorProtocolMessage, requestId: string): Uint8Array | undefined;
	disposeRun?(requestId: string): void;
	discardRun?(requestId: string): void;
	discardConversation?(conversationId: string): void;
}

export interface Http2CursorAgentTransportOptions {
	readonly baseUrl?: string;
	readonly client?: CursorHttp2Client;
	readonly codec?: CursorProtocolCodec;
	readonly requestTimeoutMs?: number;
	readonly streamOpenTimeoutMs?: number;
	readonly heartbeatIntervalMs?: number;
}

const CONNECT_END_STREAM_FLAG = 0b10;
const DEFAULT_CANCEL_WRITE_TIMEOUT_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export function encodeCursorConnectFrame(data: Uint8Array, flags = 0): Uint8Array {
	const frame = new Uint8Array(5 + data.length);
	frame[0] = flags;
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	view.setUint32(1, data.length, false);
	frame.set(data, 5);
	return frame;
}

export function decodeCursorConnectFrames(data: Uint8Array): readonly CursorConnectFrame[] {
	const decoder = new CursorConnectFrameDecoder();
	const frames = decoder.push(data);
	decoder.finish();
	return frames;
}

export class CursorConnectFrameDecoder {
	#buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

	push(data: Uint8Array): readonly CursorConnectFrame[] {
		this.#buffer = concatBytes(this.#buffer, data);
		const frames: CursorConnectFrame[] = [];
		let offset = 0;
		while (this.#buffer.length - offset >= 5) {
			const flags = this.#buffer[offset] ?? 0;
			const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + offset, this.#buffer.byteLength - offset);
			const length = view.getUint32(1, false);
			const bodyStart = offset + 5;
			const bodyEnd = bodyStart + length;
			if (bodyEnd > this.#buffer.length) break;
			frames.push({ flags, data: this.#buffer.slice(bodyStart, bodyEnd), endStream: (flags & CONNECT_END_STREAM_FLAG) !== 0 });
			offset = bodyEnd;
		}
		this.#buffer = this.#buffer.slice(offset);
		return frames;
	}

	finish(): void {
		if (this.#buffer.length === 0) return;
		if (this.#buffer.length < 5) throw new Error("Incomplete Cursor Connect frame header.");
		throw new Error("Incomplete Cursor Connect frame body.");
	}
}

function isCursorControlMessage(message: CursorProtocolMessage): message is CursorControlMessage {
	return message.type === "kvGetBlob" || message.type === "kvSetBlob" || message.type === "conversationCheckpoint" || message.type === "requestContext";
}


async function runWithDeadline<T>(operation: (signal: AbortSignal | undefined) => Promise<T>, timeoutMs: number, parentSignal: AbortSignal | undefined, timeoutMessage: string): Promise<T> {
	if (parentSignal?.aborted) throw new CursorTransportError("Aborted", "Cursor request aborted.");
	const controller = new AbortController();
	let rejectAbort: ((error: CursorTransportError) => void) | undefined;
	const onAbort = (): void => {
		controller.abort();
		rejectAbort?.(new CursorTransportError("Aborted", "Cursor request aborted."));
	};
	parentSignal?.addEventListener("abort", onAbort, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const abortPromise = parentSignal ? new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	}) : undefined;
	const timeoutPromise = timeoutMs > 0 ? new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(new CursorTransportError("NetworkError", timeoutMessage));
		}, timeoutMs);
		timeout.unref?.();
	}) : undefined;
	try {
		return await Promise.race([operation(controller.signal), ...(abortPromise ? [abortPromise] : []), ...(timeoutPromise ? [timeoutPromise] : [])]);
	} finally {
		if (timeout) clearTimeout(timeout);
		parentSignal?.removeEventListener("abort", onAbort);
		rejectAbort = undefined;
	}
}

let nativeOperationCounter = 0;

function nextNativeOperationId(): string {
	nativeOperationCounter = (nativeOperationCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `cursor-h2-${Date.now().toString(36)}-${nativeOperationCounter.toString(36)}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, timeoutMessage: string): Promise<T> {
	if (!timeoutMs || timeoutMs <= 0) return promise;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new CursorTransportError("NetworkError", timeoutMessage)), timeoutMs);
		timeout.unref?.();
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string, onLateResolve?: (value: T) => void | Promise<void>, onAbort?: () => void | Promise<void>): Promise<T> {
	if (signal?.aborted) throw new CursorTransportError("Aborted", message);
	if (!signal) return promise;
	let settled = false;
	let rejectAbort: ((error: CursorTransportError) => void) | undefined;
	const abortPromise = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const abort = (): void => {
		void onAbort?.();
		rejectAbort?.(new CursorTransportError("Aborted", message));
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([
			promise.then(async (value) => {
				settled = true;
				if (signal.aborted) {
					if (onLateResolve) await onLateResolve(value);
					throw new CursorTransportError("Aborted", message);
				}
				return value;
			}),
			abortPromise,
		]);
	} finally {
		signal.removeEventListener("abort", abort);
		rejectAbort = undefined;
		if (!settled) {
			promise.then((value) => {
				if (signal.aborted) void onLateResolve?.(value);
			}).catch(() => undefined);
		}
	}
}

export class Http2CursorAgentTransport implements CursorAgentTransport {
	readonly #baseUrl: string;
	readonly #client: CursorHttp2Client;
	readonly #codec: CursorProtocolCodec;
	readonly #requestTimeoutMs: number;
	readonly #streamOpenTimeoutMs: number;
	readonly #heartbeatIntervalMs: number;
	#openStreams = 0;
	#cancelledStreams = 0;
	#closedStreams = 0;

	constructor(baseUrlOrOptions: string | Http2CursorAgentTransportOptions = CURSOR_API_BASE_URL) {
		const options = typeof baseUrlOrOptions === "string" ? { baseUrl: baseUrlOrOptions } : baseUrlOrOptions;
		this.#baseUrl = options.baseUrl ?? CURSOR_API_BASE_URL;
		this.#client = options.client ?? createDefaultCursorHttp2Client();
		this.#codec = options.codec ?? new CursorProtobufProtocolCodec();
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
		this.#streamOpenTimeoutMs = options.streamOpenTimeoutMs ?? 60_000;
		this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	}

	async getUsableModels(accessToken: string, requestId: string, signal?: AbortSignal): Promise<readonly CursorUsableModel[]> {
		if (signal?.aborted) {
			throw new CursorTransportError("Aborted", "Cursor model discovery was aborted before the request started.");
		}
		const headers = buildCursorRpcHeaders(accessToken, requestId, "application/proto");
		try {
			const response = await runWithDeadline(
				(parentSignal) => this.#client.requestUnary({
					baseUrl: this.#baseUrl,
					path: CURSOR_GET_USABLE_MODELS_PATH,
					headers,
					body: this.#codec.encodeGetUsableModelsRequest(),
					signal: parentSignal,
					timeoutMs: this.#requestTimeoutMs,
				}),
				this.#requestTimeoutMs,
				signal,
				"Cursor model discovery timed out.",
			);
			assertSuccessfulStatus(response.statusCode, response.body, [accessToken]);
			// GetUsableModels uses application/proto unary bodies, not Connect
			// stream envelopes; pass the raw protobuf response to the codec.
			return this.#codec.decodeGetUsableModelsResponse(response.body);
		} catch (error) {
			throw sanitizeCursorTransportError(toError(error), [accessToken]);
		}
	}

	async run(request: CursorRunRequest): Promise<CursorRunStream> {
		if (request.signal?.aborted) {
			throw new CursorTransportError("Aborted", "Cursor stream was aborted before the request started.");
		}
		const headers = {
			...buildCursorRpcHeaders(request.accessToken, request.requestId, "application/connect+proto"),
			"connect-protocol-version": "1",
		};
		try {
			const initialBody = encodeCursorConnectFrame(this.#codec.encodeRunRequest(request));
			const handle = await runWithDeadline(
				(parentSignal) => this.#client.openStream({ baseUrl: this.#baseUrl, path: CURSOR_RUN_PATH, headers, signal: parentSignal, initialBody, timeoutMs: request.openTimeoutMs ?? this.#streamOpenTimeoutMs }),
				request.openTimeoutMs ?? this.#streamOpenTimeoutMs,
				request.signal,
				"Cursor stream open timed out.",
			);
			this.#openStreams += 1;
			return new Http2CursorRunStream(
				request.requestId,
				handle,
				this.#codec,
				[request.accessToken],
				this.#heartbeatIntervalMs,
				() => {
					this.#cancelledStreams += 1;
				},
				() => {
					this.#closedStreams += 1;
					this.#openStreams = Math.max(0, this.#openStreams - 1);
				},
			);
		} catch (error) {
			throw sanitizeCursorTransportError(toError(error), [request.accessToken]);
		}
	}

	async dispose(): Promise<void> {
		await this.#client.dispose();
	}

	discardConversation(conversationId: string): void {
		this.#codec.discardConversation?.(conversationId);
	}

	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot {
		return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams };
	}
}

class Http2CursorRunStream implements CursorRunStream {
	readonly messages: AsyncIterable<CursorServerMessage>;
	#closed = false;
	#cancelled = false;
	readonly #heartbeatTimer?: ReturnType<typeof setInterval>;
	readonly #messageQueue: CursorServerMessage[] = [];
	readonly #messageReaders: Array<{
		readonly resolve: (value: IteratorResult<CursorServerMessage>) => void;
		readonly reject: (error: unknown) => void;
	}> = [];
	#messageQueueFinished = false;
	#messageQueueError: Error | undefined;

	constructor(
		readonly id: string,
		readonly handle: CursorHttp2StreamHandle,
		readonly codec: CursorProtocolCodec,
		readonly secrets: readonly string[],
		heartbeatIntervalMs: number,
		readonly onCancel: () => void,
		readonly onClose: () => void,
	) {
		this.messages = this.createMessages();
		void this.pumpMessages();
		if (heartbeatIntervalMs > 0) {
			this.#heartbeatTimer = setInterval(() => {
				this.handle.write(encodeCursorConnectFrame(this.codec.encodeHeartbeatRequest())).catch(() => {
					this.cancel().catch(() => undefined);
				});
			}, heartbeatIntervalMs);
			this.#heartbeatTimer.unref?.();
		}
	}

	async writeToolResult(result: CursorToolResultMessage, options?: CursorWriteOptions): Promise<void> {
		if (this.#closed) throw new CursorTransportError("ProtocolError", "Cannot write Cursor tool result to a closed stream.");
		try {
			await this.handle.write(encodeCursorConnectFrame(this.codec.encodeToolResult(result)), options);
		} catch (error) {
			await this.cancel().catch(() => undefined);
			throw error;
		}
	}

	async cancel(): Promise<void> {
		if (this.#cancelled) return;
		this.#cancelled = true;
		this.clearHeartbeat();
		let cancelError: Error | undefined;
		try {
			await this.handle.write(encodeCursorConnectFrame(this.codec.encodeCancelRequest()), { timeoutMs: DEFAULT_CANCEL_WRITE_TIMEOUT_MS }).catch(() => undefined);
		} finally {
			this.onCancel();
			try {
				await this.handle.cancel();
			} catch (error) {
				cancelError = toError(error);
			} finally {
				this.finishMessageQueue();
				if (!this.#closed) {
					this.#closed = true;
					this.codec.disposeRun?.(this.id);
					this.onClose();
				}
			}
		}
		if (cancelError) throw cancelError;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.clearHeartbeat();
		try {
			await this.handle.close();
		} finally {
			this.finishMessageQueue();
			this.codec.disposeRun?.(this.id);
			this.onClose();
		}
	}

	private clearHeartbeat(): void {
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
	}

	private async pumpMessages(): Promise<void> {
		const decoder = new CursorConnectFrameDecoder();
		try {
			for await (const raw of this.handle.frames) {
				if (this.#closed || this.#cancelled) break;
				for (const frame of decoder.push(raw)) {
					if (this.#closed || this.#cancelled) break;
					if (frame.endStream) {
						try {
							throwIfCursorEndStreamError(frame.data, this.secrets);
						} catch (error) {
							this.codec.discardRun?.(this.id);
							throw error;
						}
						continue;
					}
					for (const message of this.codec.decodeRunFrame(frame)) {
						if (this.#closed || this.#cancelled) break;
						const response = this.codec.encodeServerResponse?.(message, this.id);
						if (response) {
							await this.handle.write(encodeCursorConnectFrame(response));
							continue;
						}
						if (!isCursorControlMessage(message)) this.enqueueMessage(message);
					}
				}
			}
			decoder.finish();
			this.finishMessageQueue();
		} catch (error) {
			this.finishMessageQueue(toError(error));
		}
	}

	private enqueueMessage(message: CursorServerMessage): void {
		if (this.#messageQueueFinished) return;
		this.#messageQueue.push(message);
		this.flushMessageReaders();
	}

	private finishMessageQueue(error?: Error): void {
		if (this.#messageQueueFinished) return;
		this.#messageQueueFinished = true;
		this.#messageQueueError = error;
		this.flushMessageReaders();
	}

	private flushMessageReaders(): void {
		while (this.#messageReaders.length > 0) {
			const reader = this.#messageReaders.shift();
			if (!reader) return;
			const message = this.#messageQueue.shift();
			if (message !== undefined) {
				reader.resolve({ value: message, done: false });
			} else if (this.#messageQueueError) {
				reader.reject(this.#messageQueueError);
			} else if (this.#messageQueueFinished) {
				reader.resolve({ value: undefined, done: true });
			} else {
				this.#messageReaders.unshift(reader);
				return;
			}
		}
	}

	private nextMessage(): Promise<IteratorResult<CursorServerMessage>> {
		const message = this.#messageQueue.shift();
		if (message !== undefined) return Promise.resolve({ value: message, done: false });
		if (this.#messageQueueError) return Promise.reject(this.#messageQueueError);
		if (this.#messageQueueFinished) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve, reject) => {
			this.#messageReaders.push({ resolve, reject });
		});
	}

	private async *createMessages(): AsyncIterable<CursorServerMessage> {
		while (true) {
			const next = await this.nextMessage();
			if (next.done) return;
			yield next.value;
		}
	}
}

export function createDefaultCursorHttp2Client(): CursorHttp2Client {
	return new LazyNativeHttp2CursorClient();
}

class LazyNativeHttp2CursorClient implements CursorHttp2Client {
	#client: NativeHttp2CursorClient | undefined;

	private get client(): NativeHttp2CursorClient {
		if (this.#client) return this.#client;
		const native = loadCursorH2NativeBinding();
		if (!native.ok) throw new CursorTransportError("NetworkError", formatCursorH2NativeLoadFailure(native));
		this.#client = new NativeHttp2CursorClient(native.binding);
		return this.#client;
	}

	async requestUnary(request: { readonly baseUrl: string; readonly path: string; readonly headers: Record<string, string>; readonly body: Uint8Array; readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<CursorHttp2UnaryResponse> {
		return this.client.requestUnary(request);
	}

	async openStream(request: { readonly baseUrl: string; readonly path: string; readonly headers: Record<string, string>; readonly signal?: AbortSignal; readonly initialBody?: Uint8Array; readonly timeoutMs?: number }): Promise<CursorHttp2StreamHandle> {
		return this.client.openStream(request);
	}

	async dispose(): Promise<void> {
		await this.#client?.dispose();
	}
}

class NativeHttp2CursorClient implements CursorHttp2Client {
	constructor(readonly binding: CursorH2NativeBinding) {}

	async requestUnary(request: { readonly baseUrl: string; readonly path: string; readonly headers: Record<string, string>; readonly body: Uint8Array; readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<CursorHttp2UnaryResponse> {
		if (request.signal?.aborted) throw new CursorTransportError("Aborted", "Cursor native HTTP/2 request aborted before start.");
		const operationId = nextNativeOperationId();
		try {
			const response = await raceWithAbort(
				this.binding.cursorH2RequestUnary(JSON.stringify({ baseUrl: request.baseUrl, path: request.path, headers: request.headers, operationId, timeoutMs: request.timeoutMs }), Buffer.from(request.body)),
				request.signal,
				"Cursor native HTTP/2 request aborted.",
				undefined,
				() => this.binding.cursorH2CancelOperation(operationId),
			);
			return {
				statusCode: nativeStatusCode(response.statusCode ?? response.status_code),
				headers: parseNativeHeaders(response.headersJson ?? response.headers_json),
				body: new Uint8Array(response.body),
			};
		} catch (error) {
			throw toTransportError(error);
		}
	}

	async openStream(request: { readonly baseUrl: string; readonly path: string; readonly headers: Record<string, string>; readonly signal?: AbortSignal; readonly initialBody?: Uint8Array; readonly timeoutMs?: number }): Promise<CursorHttp2StreamHandle> {
		if (request.signal?.aborted) throw new CursorTransportError("Aborted", "Cursor native HTTP/2 stream aborted before start.");
		const operationId = nextNativeOperationId();
		try {
			const stream = await raceWithAbort(
				this.binding.cursorH2OpenStream(
					JSON.stringify({ baseUrl: request.baseUrl, path: request.path, headers: request.headers, operationId, timeoutMs: request.timeoutMs }),
					request.initialBody ? Buffer.from(request.initialBody) : null,
				),
				request.signal,
				"Cursor native HTTP/2 stream aborted while opening.",
				(lateStream) => lateStream.cancel().catch(() => undefined),
				() => this.binding.cursorH2CancelOperation(operationId),
			);
			return new NativeCursorStreamHandle(stream);
		} catch (error) {
			throw toTransportError(error);
		}
	}

	async dispose(): Promise<void> {
		// Native streams own their HTTP/2 sessions and dispose when closed/cancelled.
	}
}

export function createNativeCursorHttp2ClientForTest(binding: CursorH2NativeBinding): CursorHttp2Client {
	return new NativeHttp2CursorClient(binding);
}

class NativeCursorStreamHandle implements CursorHttp2StreamHandle {
	readonly frames: AsyncIterable<Uint8Array>;
	#closed = false;

	constructor(readonly stream: CursorH2NativeStream) {
		this.frames = this.createFrames();
	}

	async write(data: Uint8Array, options: CursorWriteOptions = {}): Promise<void> {
		if (this.#closed) throw new CursorTransportError("ProtocolError", "Cannot write to a closed Cursor native stream.");
		if (options.signal?.aborted) throw new CursorTransportError("Aborted", "Cursor native stream write aborted before start.");
		try {
			await raceWithAbort(
				withTimeout(
					this.stream.write(Buffer.from(data), options.timeoutMs ?? null),
					options.timeoutMs,
					"Cursor native stream write timed out.",
				),
				options.signal,
				"Cursor native stream write aborted.",
				undefined,
				() => this.cancel().catch(() => undefined),
			);
		} catch (error) {
			await this.cancel().catch(() => undefined);
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.stream.finishInput();
	}

	async cancel(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.stream.cancel();
	}

	private async *createFrames(): AsyncIterable<Uint8Array> {
		while (true) {
			const frame = await this.stream.nextFrame();
			if (!frame) break;
			yield new Uint8Array(frame);
		}
	}
}

function nativeStatusCode(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseNativeHeaders(headersJson: string | undefined): Record<string, string> {
	if (!headersJson) return {};
	const parsed = parseJsonObject(headersJson);
	if (!parsed) return {};
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "string") headers[key] = value;
	}
	return headers;
}

const textDecoder = new TextDecoder();

export function sanitizeCursorTransportError(error: Error, secrets: readonly string[] = []): Error {
	const message = sanitizeDiagnosticText(error.message, secrets);
	return error instanceof CursorTransportError ? new CursorTransportError(error.code, message) : new CursorTransportError("ProtocolError", message);
}

function throwIfCursorEndStreamError(data: Uint8Array, secrets: readonly string[]): void {
	let parsed: JsonObject;
	try {
		const value = JSON.parse(textDecoder.decode(data)) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		parsed = value as JsonObject;
	} catch {
		throw new CursorTransportError("ProtocolError", "Failed to parse Cursor Connect end stream.");
	}
	const errorValue = parsed.error;
	if (!errorValue) return;
	if (typeof errorValue !== "object" || Array.isArray(errorValue)) {
		throw new CursorTransportError("CursorApiRejected", `Cursor stream ended with unknown: ${sanitizeDiagnosticText(String(errorValue), secrets)}.`);
	}
	const error = errorValue as JsonObject;
	const code = readStringField(error, "code") ?? "unknown";
	const message = readStringField(error, "message") ?? "Unknown error";
	throw new CursorTransportError(classifyConnectErrorCode(code), `Cursor stream ended with ${code}: ${sanitizeDiagnosticText(message, secrets)}.`);
}

function classifyConnectErrorCode(code: string): CursorTransportErrorCode {
	if (code === "unauthenticated") return "Unauthorized";
	if (code === "canceled") return "Aborted";
	if (code === "resource_exhausted" || code === "unavailable") return "NetworkError";
	return "CursorApiRejected";
}

function assertSuccessfulStatus(statusCode: number | undefined, body: Uint8Array, secrets: readonly string[]): void {
	if (statusCode === undefined || (statusCode >= 200 && statusCode < 300)) return;
	const detail = sanitizeDiagnosticText(textDecoder.decode(body), secrets);
	const versionHint = cursorClientVersionHint(statusCode);
	const message = `Cursor API rejected request with HTTP ${statusCode}${detail ? `: ${detail}` : ""}${versionHint}`;
	if (statusCode === 401 || statusCode === 403) throw new CursorTransportError("Unauthorized", message);
	throw new CursorTransportError("CursorApiRejected", message);
}

function cursorClientVersionHint(statusCode: number): string {
	if (statusCode !== 403 && statusCode !== 426) return "";
	return ` Cursor may be rejecting the bundled Cursor CLI-compatible client version (${CURSOR_CLIENT_VERSION}); refresh CURSOR_CLIENT_VERSION from current Cursor CLI traffic if authentication still succeeds in Cursor itself.`;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function toTransportError(error: unknown): CursorTransportError {
	if (error instanceof CursorTransportError) return error;
	return new CursorTransportError("NetworkError", toError(error).message);
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}
