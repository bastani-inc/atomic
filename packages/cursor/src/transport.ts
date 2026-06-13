import { connect, constants, type ClientHttp2Session, type ClientHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import type { Context, Model, Api, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	buildCursorRpcHeaders,
	CURSOR_API_BASE_URL,
	CURSOR_CLIENT_VERSION,
	CURSOR_GET_USABLE_MODELS_PATH,
	CURSOR_RUN_PATH,
	parseJsonObject,
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
}

export interface Http2CursorAgentTransportOptions {
	readonly baseUrl?: string;
	readonly client?: CursorHttp2Client;
	readonly codec?: CursorProtocolCodec;
	readonly requestTimeoutMs?: number;
	readonly streamOpenTimeoutMs?: number;
}

const CONNECT_END_STREAM_FLAG = 0b10;
const DEFAULT_CANCEL_WRITE_TIMEOUT_MS = 1_000;

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
	return message.type === "kvGetBlob" || message.type === "kvSetBlob" || message.type === "requestContext";
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
	#openStreams = 0;
	#cancelledStreams = 0;
	#closedStreams = 0;

	constructor(baseUrlOrOptions: string | Http2CursorAgentTransportOptions = CURSOR_API_BASE_URL) {
		const options = typeof baseUrlOrOptions === "string" ? { baseUrl: baseUrlOrOptions } : baseUrlOrOptions;
		this.#baseUrl = options.baseUrl ?? CURSOR_API_BASE_URL;
		this.#client = options.client ?? new NodeHttp2CursorClient();
		this.#codec = options.codec ?? new CursorProtobufProtocolCodec();
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
		this.#streamOpenTimeoutMs = options.streamOpenTimeoutMs ?? 60_000;
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

	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot {
		return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams };
	}
}

class Http2CursorRunStream implements CursorRunStream {
	readonly messages: AsyncIterable<CursorServerMessage>;
	#closed = false;
	#cancelled = false;

	constructor(
		readonly id: string,
		readonly handle: CursorHttp2StreamHandle,
		readonly codec: CursorProtocolCodec,
		readonly secrets: readonly string[],
		readonly onCancel: () => void,
		readonly onClose: () => void,
	) {
		this.messages = this.createMessages();
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
		try {
			await this.handle.close();
		} finally {
			this.codec.disposeRun?.(this.id);
			this.onClose();
		}
	}

	private async *createMessages(): AsyncIterable<CursorServerMessage> {
		const decoder = new CursorConnectFrameDecoder();
		for await (const raw of this.handle.frames) {
			for (const frame of decoder.push(raw)) {
				if (frame.endStream) {
					throwIfCursorEndStreamError(frame.data, this.secrets);
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

class NodeHttp2CursorClient implements CursorHttp2Client {
	readonly #sessions = new Set<ClientHttp2Session>();

	async requestUnary(request: { readonly baseUrl: string; readonly path: string; readonly headers: Record<string, string>; readonly body: Uint8Array; readonly signal?: AbortSignal }): Promise<CursorHttp2UnaryResponse> {
		const session = this.openSession(request.baseUrl);
		return new Promise<CursorHttp2UnaryResponse>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let responseHeaders: Record<string, string> = {};
			let settled = false;
			const stream = session.request({
				[constants.HTTP2_HEADER_METHOD]: constants.HTTP2_METHOD_POST,
				[constants.HTTP2_HEADER_PATH]: request.path,
				...request.headers,
			});
			const finishReject = (error: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const cleanup = (): void => {
				request.signal?.removeEventListener("abort", onAbort);
				session.removeListener("error", onSessionError);
				this.closeSession(session);
			};
			const onAbort = (): void => {
				stream.destroy(new CursorTransportError("Aborted", "Cursor request aborted."));
			};
			const onSessionError = (error: Error): void => finishReject(new CursorTransportError("NetworkError", error.message));
			request.signal?.addEventListener("abort", onAbort, { once: true });
			session.on("error", onSessionError);
			stream.on("response", (headers: IncomingHttpHeaders) => {
				responseHeaders = normalizeIncomingHeaders(headers);
			});
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("aborted", () => finishReject(new CursorTransportError("NetworkError", "Cursor unary request was aborted by the remote endpoint.")));
			stream.on("error", (error: Error) => finishReject(toTransportError(error)));
			stream.on("end", () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve({ statusCode: Number(responseHeaders[":status"]), body: Buffer.concat(chunks), headers: responseHeaders });
			});
			stream.end(Buffer.from(request.body));
		});
	}

	async openStream(request: { readonly baseUrl: string; readonly path: string; readonly headers: Record<string, string>; readonly signal?: AbortSignal; readonly initialBody?: Uint8Array }): Promise<CursorHttp2StreamHandle> {
		const session = this.openSession(request.baseUrl);
		const stream = session.request({
			[constants.HTTP2_HEADER_METHOD]: constants.HTTP2_METHOD_POST,
			[constants.HTTP2_HEADER_PATH]: request.path,
			...request.headers,
		});
		const handle = new NodeHttp2CursorStreamHandle(stream, session, () => this.closeSession(session), request.signal);
		try {
			if (request.initialBody) await handle.write(request.initialBody, { signal: request.signal });
			return handle;
		} catch (error) {
			await handle.cancel();
			throw toTransportError(error);
		}
	}

	async dispose(): Promise<void> {
		for (const session of [...this.#sessions]) {
			this.closeSession(session);
		}
	}

	private openSession(baseUrl: string): ClientHttp2Session {
		// Cursor's private API is experimental and streams must clean up
		// predictably in one-shot CLI/workflow runs, so each request owns its
		// session for now. Pooling can be added once protocol stability is known.
		const session = connect(baseUrl);
		this.#sessions.add(session);
		session.on("close", () => this.#sessions.delete(session));
		return session;
	}

	private closeSession(session: ClientHttp2Session): void {
		this.#sessions.delete(session);
		if (!session.closed && !session.destroyed) session.close();
	}
}

class NodeHttp2CursorStreamHandle implements CursorHttp2StreamHandle {
	readonly frames: AsyncIterable<Uint8Array>;
	#closed = false;
	#done = false;
	#failure: Error | undefined;
	#notify: (() => void) | undefined;
	readonly #queue: Uint8Array[] = [];

	constructor(readonly stream: ClientHttp2Stream, readonly session: ClientHttp2Session, readonly onClose: () => void, readonly signal?: AbortSignal) {
		this.frames = this.createFrames();
		this.stream.on("response", this.onResponse);
		this.stream.on("data", this.onData);
		this.stream.on("end", this.onEnd);
		this.stream.on("close", this.onCloseEvent);
		this.stream.on("aborted", this.onAborted);
		this.stream.on("error", this.onError);
		this.session.on("error", this.onSessionError);
		this.signal?.addEventListener("abort", this.abort, { once: true });
	}

	async write(data: Uint8Array, options: CursorWriteOptions = {}): Promise<void> {
		if (this.#closed) return;
		if (options.signal?.aborted) {
			await this.cancel();
			throw new CursorTransportError("Aborted", "Cursor stream write aborted.");
		}
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
				abortListener = () => rejectAndCancel(new CursorTransportError("Aborted", "Cursor stream write aborted."));
				options.signal?.addEventListener("abort", abortListener, { once: true });
				if (options.timeoutMs && options.timeoutMs > 0) {
					timeout = setTimeout(() => rejectAndCancel(new CursorTransportError("NetworkError", "Cursor stream write timed out.")), options.timeoutMs);
					timeout.unref?.();
				}
				try {
					this.stream.write(Buffer.from(data), (error?: Error | null) => {
						if (settled) return;
						settled = true;
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					rejectAndCancel(toTransportError(error));
				}
			});
		} finally {
			if (abortListener) options.signal?.removeEventListener("abort", abortListener);
			if (timeout) clearTimeout(timeout);
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.cleanup();
		this.stream.end();
		this.finish();
		this.onClose();
	}

	async cancel(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.cleanup();
		this.stream.close();
		this.finish();
		this.onClose();
	}

	private readonly abort = (): void => {
		this.fail(new CursorTransportError("Aborted", "Cursor stream request aborted."));
		this.cancel().catch(() => undefined);
	};

	private readonly onResponse = (headers: IncomingHttpHeaders): void => {
		const normalized = normalizeIncomingHeaders(headers);
		try {
			assertSuccessfulStatus(Number(normalized[":status"]), new Uint8Array(), []);
		} catch (error) {
			this.fail(toError(error));
		}
	};

	private readonly onData = (chunk: Buffer): void => {
		this.#queue.push(chunk);
		this.wake();
	};
	private readonly onEnd = (): void => this.finish();
	private readonly onCloseEvent = (): void => this.finish();
	private readonly onAborted = (): void => this.fail(new CursorTransportError("NetworkError", "Cursor stream was aborted by the remote endpoint."));
	private readonly onError = (error: Error): void => this.fail(toTransportError(error));
	private readonly onSessionError = (error: Error): void => this.fail(new CursorTransportError("NetworkError", error.message));

	private wake(): void {
		this.#notify?.();
		this.#notify = undefined;
	}

	private finish(): void {
		this.#done = true;
		this.wake();
	}

	private fail(error: Error): void {
		this.#failure = error;
		this.finish();
	}

	private cleanup(): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.stream.removeListener("response", this.onResponse);
		this.stream.removeListener("data", this.onData);
		this.stream.removeListener("end", this.onEnd);
		this.stream.removeListener("close", this.onCloseEvent);
		this.stream.removeListener("aborted", this.onAborted);
		this.stream.removeListener("error", this.onError);
		this.session.removeListener("error", this.onSessionError);
	}

	private async *createFrames(): AsyncIterable<Uint8Array> {
		try {
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
		} finally {
			this.cleanup();
		}
	}
}

const textDecoder = new TextDecoder();

export function sanitizeCursorTransportError(error: Error, secrets: readonly string[] = []): Error {
	const message = sanitizeDiagnosticText(error.message, secrets);
	return error instanceof CursorTransportError ? new CursorTransportError(error.code, message) : new CursorTransportError("ProtocolError", message);
}

function throwIfCursorEndStreamError(data: Uint8Array, secrets: readonly string[]): void {
	const parsed = parseJsonObject(textDecoder.decode(data));
	if (!parsed) return;
	const errorValue = parsed.error;
	if (!errorValue || typeof errorValue !== "object" || Array.isArray(errorValue)) return;
	const error = errorValue as JsonObject;
	const code = readStringField(error, "code");
	if (!code) return;
	const message = readStringField(error, "message");
	throw new CursorTransportError(classifyConnectErrorCode(code), `Cursor stream ended with ${code}${message ? `: ${sanitizeDiagnosticText(message, secrets)}` : ""}.`);
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

function normalizeIncomingHeaders(headers: IncomingHttpHeaders): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") normalized[key] = value;
		else if (typeof value === "number") normalized[key] = String(value);
		else if (Array.isArray(value)) normalized[key] = value.join(", ");
	}
	return normalized;
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
