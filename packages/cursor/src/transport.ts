import { connect, constants, type ClientHttp2Session, type ClientHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import type { Context, Model, Api, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	buildCursorRpcHeaders,
	createCursorExperimentalProtocolError,
	CURSOR_API,
	CURSOR_API_BASE_URL,
	CURSOR_GET_USABLE_MODELS_PATH,
	CURSOR_RUN_PATH,
	parseJsonObject,
	parseJsonValue,
	readBooleanField,
	readNumberField,
	readStringField,
	redactHeaders,
	sanitizeDiagnosticText,
	type JsonObject,
	type JsonValue,
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
	readonly model: Model<Api>;
	readonly resolvedModelId: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly context: Context;
	readonly signal?: AbortSignal;
}

export type CursorDoneReason = "stop" | "length" | "toolUse";

export type CursorServerMessage =
	| { readonly type: "textDelta"; readonly text: string }
	| { readonly type: "thinkingDelta"; readonly text: string }
	| { readonly type: "toolCall"; readonly id: string; readonly name: string; readonly argumentsJson: string }
	| { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number }
	| { readonly type: "done"; readonly reason: CursorDoneReason };

export interface CursorRunStream {
	readonly id: string;
	readonly messages: AsyncIterable<CursorServerMessage>;
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
	write(data: Uint8Array): Promise<void>;
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
	}): Promise<CursorHttp2StreamHandle>;
	dispose(): Promise<void>;
}

export interface CursorProtocolCodec {
	encodeGetUsableModelsRequest(): Uint8Array;
	decodeGetUsableModelsResponse(data: Uint8Array): readonly CursorUsableModel[];
	encodeRunRequest(request: CursorRunRequest): Uint8Array;
	decodeRunFrame(frame: CursorConnectFrame): readonly CursorServerMessage[];
	encodeCancelRequest(): Uint8Array;
	encodeHeartbeatRequest(): Uint8Array;
}

export interface Http2CursorAgentTransportOptions {
	readonly baseUrl?: string;
	readonly client?: CursorHttp2Client;
	readonly codec?: CursorProtocolCodec;
}

const CONNECT_END_STREAM_FLAG = 0b10;

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

export class Http2CursorAgentTransport implements CursorAgentTransport {
	readonly #baseUrl: string;
	readonly #client: CursorHttp2Client;
	readonly #codec: CursorProtocolCodec;
	#openStreams = 0;
	#cancelledStreams = 0;
	#closedStreams = 0;

	constructor(baseUrlOrOptions: string | Http2CursorAgentTransportOptions = CURSOR_API_BASE_URL) {
		const options = typeof baseUrlOrOptions === "string" ? { baseUrl: baseUrlOrOptions } : baseUrlOrOptions;
		this.#baseUrl = options.baseUrl ?? CURSOR_API_BASE_URL;
		this.#client = options.client ?? new NodeHttp2CursorClient();
		this.#codec = options.codec ?? new CursorProtobufProtocolCodec();
	}

	async getUsableModels(accessToken: string, requestId: string, signal?: AbortSignal): Promise<readonly CursorUsableModel[]> {
		if (signal?.aborted) {
			throw new CursorTransportError("Aborted", "Cursor model discovery was aborted before the request started.");
		}
		const headers = buildCursorRpcHeaders(accessToken, requestId, "application/proto");
		try {
			const response = await this.#client.requestUnary({
				baseUrl: this.#baseUrl,
				path: CURSOR_GET_USABLE_MODELS_PATH,
				headers,
				body: this.#codec.encodeGetUsableModelsRequest(),
				signal,
			});
			assertSuccessfulStatus(response.statusCode, response.body, [accessToken]);
			const body = unwrapUnaryBody(response.body);
			return this.#codec.decodeGetUsableModelsResponse(body);
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
			const handle = await this.#client.openStream({ baseUrl: this.#baseUrl, path: CURSOR_RUN_PATH, headers, signal: request.signal });
			await handle.write(encodeCursorConnectFrame(this.#codec.encodeRunRequest(request)));
			this.#openStreams += 1;
			return new Http2CursorRunStream(
				request.requestId,
				handle,
				this.#codec,
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
		readonly onCancel: () => void,
		readonly onClose: () => void,
	) {
		this.messages = this.createMessages();
	}

	async cancel(): Promise<void> {
		if (this.#cancelled) return;
		this.#cancelled = true;
		try {
			await this.handle.write(encodeCursorConnectFrame(this.codec.encodeCancelRequest()));
		} finally {
			this.onCancel();
			await this.handle.cancel();
			if (!this.#closed) {
				this.#closed = true;
				this.onClose();
			}
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.handle.close();
		} finally {
			this.onClose();
		}
	}

	private async *createMessages(): AsyncIterable<CursorServerMessage> {
		const decoder = new CursorConnectFrameDecoder();
		for await (const raw of this.handle.frames) {
			for (const frame of decoder.push(raw)) {
				if (frame.endStream) {
					const endMessage = textDecoder.decode(frame.data);
					const parsed = parseJsonObject(endMessage);
					const code = parsed ? readStringField(parsed, "code") : undefined;
					if (code && code !== "ok") throw new CursorTransportError("CursorApiRejected", `Cursor stream ended with ${code}.`);
					continue;
				}
				for (const message of this.codec.decodeRunFrame(frame)) {
					yield message;
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

	async openStream(request: { readonly baseUrl: string; readonly path: string; readonly headers: Record<string, string>; readonly signal?: AbortSignal }): Promise<CursorHttp2StreamHandle> {
		const session = this.openSession(request.baseUrl);
		return new Promise<CursorHttp2StreamHandle>((resolve, reject) => {
			let settled = false;
			const stream = session.request({
				[constants.HTTP2_HEADER_METHOD]: constants.HTTP2_METHOD_POST,
				[constants.HTTP2_HEADER_PATH]: request.path,
				...request.headers,
			});
			const cleanupBeforeResolve = (): void => {
				request.signal?.removeEventListener("abort", onAbort);
				session.removeListener("error", onSessionError);
			};
			const rejectOnce = (error: Error): void => {
				if (settled) return;
				settled = true;
				cleanupBeforeResolve();
				stream.destroy(error);
				this.closeSession(session);
				reject(error);
			};
			const onAbort = (): void => rejectOnce(new CursorTransportError("Aborted", "Cursor stream request aborted."));
			const onSessionError = (error: Error): void => rejectOnce(new CursorTransportError("NetworkError", error.message));
			request.signal?.addEventListener("abort", onAbort, { once: true });
			session.on("error", onSessionError);
			stream.once("response", (headers: IncomingHttpHeaders) => {
				const normalized = normalizeIncomingHeaders(headers);
				const statusCode = Number(normalized[":status"]);
				try {
					assertSuccessfulStatus(statusCode, new Uint8Array(), []);
				} catch (error) {
					rejectOnce(toError(error));
					return;
				}
				if (settled) return;
				settled = true;
				cleanupBeforeResolve();
				resolve(new NodeHttp2CursorStreamHandle(stream, () => this.closeSession(session), request.signal));
			});
			stream.once("error", (error: Error) => rejectOnce(toTransportError(error)));
			stream.once("aborted", () => rejectOnce(new CursorTransportError("NetworkError", "Cursor stream was aborted by the remote endpoint before headers.")));
		});
	}

	async dispose(): Promise<void> {
		for (const session of [...this.#sessions]) {
			this.closeSession(session);
		}
	}

	private openSession(baseUrl: string): ClientHttp2Session {
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

	constructor(readonly stream: ClientHttp2Stream, readonly onClose: () => void, readonly signal?: AbortSignal) {
		this.frames = this.createFrames();
		this.signal?.addEventListener("abort", this.abort, { once: true });
	}

	async write(data: Uint8Array): Promise<void> {
		if (this.#closed) return;
		this.stream.write(Buffer.from(data));
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.signal?.removeEventListener("abort", this.abort);
		this.stream.end();
		this.onClose();
	}

	async cancel(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.signal?.removeEventListener("abort", this.abort);
		this.stream.close();
		this.onClose();
	}

	private readonly abort = (): void => {
		void this.cancel();
	};

	private async *createFrames(): AsyncIterable<Uint8Array> {
		const queue: Uint8Array[] = [];
		let done = false;
		let failure: Error | undefined;
		let notify: (() => void) | undefined;
		const wake = (): void => {
			notify?.();
			notify = undefined;
		};
		const finish = (): void => {
			done = true;
			wake();
		};
		const fail = (error: Error): void => {
			failure = error;
			finish();
		};
		const onData = (chunk: Buffer): void => {
			queue.push(chunk);
			wake();
		};
		const onEnd = (): void => finish();
		const onClose = (): void => finish();
		const onAborted = (): void => fail(new CursorTransportError("NetworkError", "Cursor stream was aborted by the remote endpoint."));
		const onError = (error: Error): void => fail(toTransportError(error));
		this.stream.on("data", onData);
		this.stream.on("end", onEnd);
		this.stream.on("close", onClose);
		this.stream.on("aborted", onAborted);
		this.stream.on("error", onError);
		try {
			while (!done || queue.length > 0) {
				const next = queue.shift();
				if (next) {
					yield next;
					continue;
				}
				if (failure) throw failure;
				if (done) break;
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			}
			if (failure) throw failure;
		} finally {
			this.stream.removeListener("data", onData);
			this.stream.removeListener("end", onEnd);
			this.stream.removeListener("close", onClose);
			this.stream.removeListener("aborted", onAborted);
			this.stream.removeListener("error", onError);
		}
	}
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class JsonCursorProtocolCodec implements CursorProtocolCodec {
	encodeGetUsableModelsRequest(): Uint8Array {
		return new Uint8Array();
	}

	decodeGetUsableModelsResponse(data: Uint8Array): readonly CursorUsableModel[] {
		const json = parseJsonObject(textDecoder.decode(data));
		if (!json) {
			throw createCursorExperimentalProtocolError("Cursor protobuf GetUsableModels decoding is not available; inject a protobuf codec or use a JSON-compatible test codec.");
		}
		return parseCursorModelListFromJsonValue(json);
	}

	encodeRunRequest(request: CursorRunRequest): Uint8Array {
		return textEncoder.encode(JSON.stringify({
			modelId: request.resolvedModelId,
			requestId: request.requestId,
			thinkingLevel: request.thinkingLevel,
			messageCount: request.context.messages.length,
		}));
	}

	decodeRunFrame(frame: CursorConnectFrame): readonly CursorServerMessage[] {
		const parsed = parseJsonValue(textDecoder.decode(frame.data));
		if (!parsed) {
			throw createCursorExperimentalProtocolError("Cursor protobuf Run decoding is not available; inject a protobuf codec or use JSON-compatible test frames.");
		}
		return parseCursorServerMessagesFromJson(parsed);
	}

	encodeCancelRequest(): Uint8Array {
		return textEncoder.encode(JSON.stringify({ type: "cancel" }));
	}

	encodeHeartbeatRequest(): Uint8Array {
		return textEncoder.encode(JSON.stringify({ type: "heartbeat" }));
	}
}

export class CursorMockRunStream implements CursorRunStream {
	readonly id: string;
	readonly messages: AsyncIterable<CursorServerMessage>;
	#onCancel: () => void;
	#onClose: () => void;
	#cancelled = false;
	#closed = false;

	constructor(id: string, messages: AsyncIterable<CursorServerMessage>, onCancel: () => void, onClose: () => void) {
		this.id = id;
		this.messages = messages;
		this.#onCancel = onCancel;
		this.#onClose = onClose;
	}

	get cancelled(): boolean {
		return this.#cancelled;
	}

	get closed(): boolean {
		return this.#closed;
	}

	async cancel(): Promise<void> {
		if (this.#cancelled) return;
		this.#cancelled = true;
		this.#onCancel();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#onClose();
	}
}

export interface CursorMockTransportRun {
	readonly request: CursorRunRequest;
	readonly stream: CursorMockRunStream;
}

export class CursorMockTransport implements CursorAgentTransport {
	readonly runs: CursorMockTransportRun[] = [];
	readonly modelRequests: string[] = [];
	#models: readonly CursorUsableModel[];
	#messages: readonly CursorServerMessage[];
	#openStreams = 0;
	#cancelledStreams = 0;
	#closedStreams = 0;

	constructor(options: { readonly models?: readonly CursorUsableModel[]; readonly messages?: readonly CursorServerMessage[] } = {}) {
		this.#models = options.models ?? [];
		this.#messages = options.messages ?? [];
	}

	setMessages(messages: readonly CursorServerMessage[]): void {
		this.#messages = messages;
	}

	async getUsableModels(accessToken: string, requestId: string, signal?: AbortSignal): Promise<readonly CursorUsableModel[]> {
		if (signal?.aborted) {
			throw new Error("Cursor mock model discovery aborted");
		}
		this.modelRequests.push(`${requestId}:${accessToken.length}`);
		return this.#models;
	}

	async run(request: CursorRunRequest): Promise<CursorRunStream> {
		if (request.signal?.aborted) {
			throw new Error("Cursor mock stream aborted");
		}
		this.#openStreams += 1;
		const stream = new CursorMockRunStream(
			request.requestId,
			this.createMessageIterable(),
			() => {
				this.#cancelledStreams += 1;
			},
			() => {
				this.#closedStreams += 1;
				this.#openStreams = Math.max(0, this.#openStreams - 1);
			},
		);
		this.runs.push({ request, stream });
		return stream;
	}

	async dispose(): Promise<void> {
		for (const run of this.runs) {
			await run.stream.close();
		}
	}

	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot {
		return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams };
	}

	private async *createMessageIterable(): AsyncIterable<CursorServerMessage> {
		for (const message of this.#messages) {
			yield message;
		}
	}
}

export function parseCursorModelFromJson(value: JsonObject): CursorUsableModel | undefined {
	const id = readStringField(value, "id") ?? readStringField(value, "modelId") ?? readStringField(value, "name");
	if (!id) return undefined;
	return {
		id,
		name: readStringField(value, "name"),
		displayName: readStringField(value, "displayName") ?? readStringField(value, "display_name"),
		contextWindow: readNumberField(value, "contextWindow") ?? readNumberField(value, "context_window"),
		maxTokens: readNumberField(value, "maxTokens") ?? readNumberField(value, "max_tokens"),
		supportsReasoning: readBooleanField(value, "supportsReasoning") ?? readBooleanField(value, "supports_reasoning"),
		supportsThinking: readBooleanField(value, "supportsThinking") ?? readBooleanField(value, "supports_thinking"),
	};
}

export function sanitizeCursorTransportError(error: Error, secrets: readonly string[] = []): Error {
	const message = sanitizeDiagnosticText(error.message, secrets);
	return error instanceof CursorTransportError ? new CursorTransportError(error.code, message) : new CursorTransportError("ProtocolError", message);
}

export function parseCursorModelListFromJsonText(text: string): readonly CursorUsableModel[] {
	const parsed = parseJsonObject(text);
	return parsed ? parseCursorModelListFromJsonValue(parsed) : [];
}

function parseCursorModelListFromJsonValue(value: JsonObject): readonly CursorUsableModel[] {
	const models = value.models;
	if (!Array.isArray(models)) return [];
	return models.flatMap((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
		const model = parseCursorModelFromJson(item as JsonObject);
		return model ? [model] : [];
	});
}

function parseCursorServerMessagesFromJson(value: JsonValue): readonly CursorServerMessage[] {
	const items = Array.isArray(value) ? value : [value];
	return items.flatMap((item): CursorServerMessage[] => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
		const object = item as JsonObject;
		const type = readStringField(object, "type");
		if (type === "textDelta") return [{ type, text: readStringField(object, "text") ?? "" }];
		if (type === "thinkingDelta") return [{ type, text: readStringField(object, "text") ?? "" }];
		if (type === "toolCall") return [{ type, id: readStringField(object, "id") ?? "cursor-tool", name: readStringField(object, "name") ?? "cursor_tool", argumentsJson: readStringField(object, "argumentsJson") ?? "{}" }];
		if (type === "usage") return [{ type, inputTokens: readNumberField(object, "inputTokens") ?? 0, outputTokens: readNumberField(object, "outputTokens") ?? 0 }];
		if (type === "done") return [{ type, reason: parseDoneReason(readStringField(object, "reason")) }];
		return [];
	});
}

function parseDoneReason(value: string | undefined): CursorDoneReason {
	return value === "length" || value === "toolUse" ? value : "stop";
}

function unwrapUnaryBody(data: Uint8Array): Uint8Array {
	try {
		const frames = decodeCursorConnectFrames(data);
		const firstMessage = frames.find((frame) => !frame.endStream);
		return firstMessage?.data ?? data;
	} catch {
		return data;
	}
}

function assertSuccessfulStatus(statusCode: number | undefined, body: Uint8Array, secrets: readonly string[]): void {
	if (statusCode === undefined || (statusCode >= 200 && statusCode < 300)) return;
	const detail = sanitizeDiagnosticText(textDecoder.decode(body), secrets);
	const message = `Cursor API rejected request with HTTP ${statusCode}${detail ? `: ${detail}` : ""}`;
	if (statusCode === 401 || statusCode === 403) throw new CursorTransportError("Unauthorized", message);
	throw new CursorTransportError("CursorApiRejected", message);
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

void redactHeaders;
void CURSOR_API;
