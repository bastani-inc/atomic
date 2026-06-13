import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Context, Model, Api, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	buildCursorRpcHeaders,
	CURSOR_API_BASE_URL,
	CURSOR_CLIENT_VERSION,
	CURSOR_GET_USABLE_MODELS_PATH,
	CURSOR_RUN_PATH,
	readStringField,
	sanitizeDiagnosticText,
	type JsonObject,
} from "./config.js";
import type { CursorUsableModel } from "./model-mapper.js";
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
	}): Promise<CursorHttp2UnaryResponse>;
	openStream(request: {
		readonly baseUrl: string;
		readonly path: string;
		readonly headers: Record<string, string>;
		readonly signal?: AbortSignal;
		readonly initialBody?: Uint8Array;
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
	const onAbort = (): void => controller.abort();
	parentSignal?.addEventListener("abort", onAbort, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = timeoutMs > 0 ? new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(new CursorTransportError("NetworkError", timeoutMessage));
		}, timeoutMs);
		timeout.unref?.();
	}) : undefined;
	try {
		return await Promise.race([operation(controller.signal), ...(timeoutPromise ? [timeoutPromise] : [])]);
	} finally {
		if (timeout) clearTimeout(timeout);
		parentSignal?.removeEventListener("abort", onAbort);
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
		this.#client = options.client ?? new BridgeHttp2CursorClient();
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
				(parentSignal) => this.#client.openStream({ baseUrl: this.#baseUrl, path: CURSOR_RUN_PATH, headers, signal: parentSignal, initialBody }),
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
			this.codec.disposeRun?.(this.id);
			this.onClose();
		}
	}

	private clearHeartbeat(): void {
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
	}

	private async *createMessages(): AsyncIterable<CursorServerMessage> {
		const decoder = new CursorConnectFrameDecoder();
		for await (const raw of this.handle.frames) {
			for (const frame of decoder.push(raw)) {
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
					const response = this.codec.encodeServerResponse?.(message, this.id);
					if (response) {
						await this.handle.write(encodeCursorConnectFrame(response));
						continue;
					}
					if (!isCursorControlMessage(message)) yield message;
				}
			}
		}
		decoder.finish();
	}
}

const CURSOR_H2_BRIDGE_PATH = fileURLToPath(new URL("./h2-bridge.mjs", import.meta.url));
const CURSOR_H2_BRIDGE_NODE = process.env.ATOMIC_CURSOR_H2_BRIDGE_NODE?.trim() || "node";

class BridgeHttp2CursorClient implements CursorHttp2Client {
	readonly #nodeCommand: string;

	constructor(nodeCommand = CURSOR_H2_BRIDGE_NODE) {
		this.#nodeCommand = nodeCommand;
	}

	async requestUnary(request: { readonly baseUrl: string; readonly path: string; readonly headers: Record<string, string>; readonly body: Uint8Array; readonly signal?: AbortSignal }): Promise<CursorHttp2UnaryResponse> {
		const bridge = new CursorH2BridgeProcess(this.#nodeCommand, request.signal);
		try {
			await bridge.writeJson({ baseUrl: request.baseUrl, path: request.path, headers: request.headers, unary: true }, request.signal);
			await bridge.write(request.body, { signal: request.signal });
			await bridge.finishInput();
			const chunks: Uint8Array[] = [];
			for await (const chunk of bridge.frames) chunks.push(chunk);
			return { body: concatBytes(...chunks), headers: {} };
		} catch (error) {
			await bridge.cancel();
			throw toTransportError(error);
		}
	}

	async openStream(request: { readonly baseUrl: string; readonly path: string; readonly headers: Record<string, string>; readonly signal?: AbortSignal; readonly initialBody?: Uint8Array }): Promise<CursorHttp2StreamHandle> {
		const bridge = new CursorH2BridgeProcess(this.#nodeCommand, request.signal);
		try {
			await bridge.writeJson({ baseUrl: request.baseUrl, path: request.path, headers: request.headers, unary: false }, request.signal);
			if (request.initialBody) await bridge.write(request.initialBody, { signal: request.signal });
			return new BridgeCursorStreamHandle(bridge);
		} catch (error) {
			await bridge.cancel();
			throw toTransportError(error);
		}
	}

	async dispose(): Promise<void> {
		// Bridge processes are request-scoped and are disposed by their handles.
	}
}

class BridgeCursorStreamHandle implements CursorHttp2StreamHandle {
	readonly frames: AsyncIterable<Uint8Array>;
	#closed = false;

	constructor(readonly bridge: CursorH2BridgeProcess) {
		this.frames = bridge.frames;
	}

	async write(data: Uint8Array, options?: CursorWriteOptions): Promise<void> {
		if (this.#closed) throw new CursorTransportError("ProtocolError", "Cannot write to a closed Cursor bridge stream.");
		await this.bridge.write(data, options);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.bridge.finishInput();
	}

	async cancel(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.bridge.cancel();
	}
}

class CursorH2BridgeProcess {
	readonly #process: ChildProcessWithoutNullStreams;
	readonly #signal?: AbortSignal;
	readonly #stderr: Buffer[] = [];
	readonly #queue: Uint8Array[] = [];
	#stdoutBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
	#done = false;
	#cancelled = false;
	#failure: Error | undefined;
	#notify: (() => void) | undefined;
	#inputFinished = false;
	readonly frames: AsyncIterable<Uint8Array>;

	constructor(nodeCommand: string, signal?: AbortSignal) {
		this.#signal = signal;
		this.#process = spawn(nodeCommand, [CURSOR_H2_BRIDGE_PATH], { stdio: "pipe" });
		this.frames = this.createFrames();
		this.#process.stdout.on("data", this.onStdout);
		this.#process.stderr.on("data", this.onStderr);
		this.#process.on("error", this.onProcessError);
		this.#process.on("close", this.onProcessClose);
		this.#signal?.addEventListener("abort", this.abort, { once: true });
	}

	async writeJson(value: object, signal?: AbortSignal): Promise<void> {
		await this.write(new TextEncoder().encode(JSON.stringify(value)), { signal });
	}

	async write(data: Uint8Array, options: CursorWriteOptions = {}): Promise<void> {
		if (this.#inputFinished) throw new CursorTransportError("ProtocolError", "Cannot write to a finished Cursor bridge input.");
		if (this.#failure) throw this.#failure;
		if (this.#done) throw new CursorTransportError("NetworkError", "Cursor HTTP/2 bridge exited before accepting input.");
		if (options.signal?.aborted || this.#signal?.aborted) {
			await this.cancel();
			throw new CursorTransportError("Aborted", "Cursor bridge write aborted.");
		}
		const frame = encodeBridgeMessage(data);
		await this.writeRaw(frame, options);
	}

	async finishInput(): Promise<void> {
		if (this.#inputFinished) return;
		this.#inputFinished = true;
		if (!this.#process.stdin.destroyed) {
			this.#process.stdin.end();
		}
	}

	async cancel(): Promise<void> {
		if (this.#cancelled) return;
		this.#cancelled = true;
		this.#signal?.removeEventListener("abort", this.abort);
		this.#process.kill("SIGTERM");
		this.finish(new CursorTransportError("Aborted", "Cursor HTTP/2 bridge was cancelled."));
	}

	private async writeRaw(data: Uint8Array, options: CursorWriteOptions): Promise<void> {
		let abortListener: (() => void) | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		try {
			await new Promise<void>((resolve, reject) => {
				const rejectAndCancel = (error: Error): void => {
					if (settled) return;
					settled = true;
					this.cancel().catch(() => undefined);
					reject(error);
				};
				abortListener = () => rejectAndCancel(new CursorTransportError("Aborted", "Cursor bridge write aborted."));
				options.signal?.addEventListener("abort", abortListener, { once: true });
				if (options.timeoutMs && options.timeoutMs > 0) {
					timeout = setTimeout(() => rejectAndCancel(new CursorTransportError("NetworkError", "Cursor bridge write timed out.")), options.timeoutMs);
					timeout.unref?.();
				}
				this.#process.stdin.write(Buffer.from(data), (error?: Error | null) => {
					if (settled) return;
					settled = true;
					if (error) reject(toTransportError(error));
					else resolve();
				});
			});
		} finally {
			if (abortListener) options.signal?.removeEventListener("abort", abortListener);
			if (timeout) clearTimeout(timeout);
		}
	}

	private readonly abort = (): void => {
		this.cancel().catch(() => undefined);
	};

	private readonly onStdout = (chunk: Buffer): void => {
		this.#stdoutBuffer = concatBytes(this.#stdoutBuffer, chunk);
		let offset = 0;
		while (this.#stdoutBuffer.byteLength - offset >= 4) {
			const view = new DataView(this.#stdoutBuffer.buffer, this.#stdoutBuffer.byteOffset + offset, this.#stdoutBuffer.byteLength - offset);
			const length = view.getUint32(0, false);
			const bodyStart = offset + 4;
			const bodyEnd = bodyStart + length;
			if (bodyEnd > this.#stdoutBuffer.byteLength) break;
			this.#queue.push(this.#stdoutBuffer.slice(bodyStart, bodyEnd));
			offset = bodyEnd;
		}
		this.#stdoutBuffer = this.#stdoutBuffer.slice(offset);
		this.wake();
	};

	private readonly onStderr = (chunk: Buffer): void => {
		this.#stderr.push(chunk);
	};

	private readonly onProcessError = (error: Error): void => {
		this.finish(toTransportError(error));
	};

	private readonly onProcessClose = (code: number | null): void => {
		if (this.#cancelled) {
			this.finish();
			return;
		}
		if (code && code !== 0) {
			const stderr = sanitizeDiagnosticText(Buffer.concat(this.#stderr).toString("utf8"));
			this.finish(new CursorTransportError("NetworkError", `Cursor HTTP/2 bridge exited with code ${code}${stderr ? `: ${stderr}` : ""}.`));
			return;
		}
		this.finish();
	};

	private finish(error?: Error): void {
		if (error) this.#failure = error;
		this.#done = true;
		this.#signal?.removeEventListener("abort", this.abort);
		this.wake();
	}

	private wake(): void {
		this.#notify?.();
		this.#notify = undefined;
	}

	private async *createFrames(): AsyncIterable<Uint8Array> {
		while (!this.#done || this.#queue.length > 0) {
			const next = this.#queue.shift();
			if (next) {
				yield next;
				continue;
			}
			if (this.#failure) throw this.#failure;
			if (this.#done) break;
			await new Promise<void>((resolve) => {
				this.#notify = resolve;
			});
		}
		if (this.#failure) throw this.#failure;
	}
}

function encodeBridgeMessage(data: Uint8Array): Uint8Array {
	const frame = new Uint8Array(4 + data.byteLength);
	new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(0, data.byteLength, false);
	frame.set(data, 4);
	return frame;
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
