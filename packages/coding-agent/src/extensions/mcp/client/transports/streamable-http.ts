import type { AuthProvider, McpFetch } from "../auth-provider.js";
import {
	extractHeaderSecrets,
	redactOAuthErrorText,
	redactWwwAuthenticateHeader,
	scrubUnknownErrorData,
} from "../oauth/redact.js";
import {
	isJsonRpcRequest,
	isJsonRpcResponse,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	type JsonRpcMessage,
	McpAbortError,
	McpConnectionClosedError,
	parseJsonRpcMessage,
	toError,
} from "../protocol/jsonrpc.js";
import {
	DEFAULT_MAX_MESSAGE_BYTES,
	type McpTransport,
	type McpTransportSendOptions,
	TransportEvents,
} from "./transport.js";

const MAX_ERROR_BODY_BYTES = 8 * 1024;
/** Extra lookahead read before redaction so a secret straddling `MAX_ERROR_BODY_BYTES` is caught whole. */
const ERROR_BODY_REDACTION_LOOKAHEAD_BYTES = 512;
const ERROR_MESSAGE_BODY_CHARS = 500;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_MAX_RETRIES = 5;

export interface SseEvent {
	event?: string;
	data: string;
	id?: string;
}

export interface ConsumeSseOptions {
	maxEventBytes?: number;
	/**
	 * Called for every event with data. `terminated` is false for the event pending when the stream ended, which
	 * lacks its terminating blank line and may be cut off.
	 */
	onEvent(event: SseEvent, terminated: boolean): void;
	/**
	 * Called with the ID of every event terminated by a blank line, including events without data (for example
	 * resumption priming events). An event cut off by the end of the stream never reports its ID.
	 */
	onId?(id: string): void;
	/** Called for every valid `retry` field, in milliseconds. */
	onRetry?(delayMs: number): void;
	/** Cancels the stream and rejects with an abort error, even when the stream's source ignores aborts. */
	signal?: AbortSignal;
}

export async function consumeSseStream(stream: ReadableStream<Uint8Array>, options: ConsumeSseOptions): Promise<void> {
	const reader = stream.getReader();
	const { signal } = options;
	const onAbort = () => {
		reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort);
	const decoder = new TextDecoder();
	// The incomplete line received so far, kept as pieces and joined once when its line break arrives, so a long
	// line that arrives in many chunks is scanned and copied only once.
	let pendingPieces: string[] = [];
	let pendingBytes = 0;
	let eventName: string | undefined;
	let eventId: string | undefined;
	let dataLines: string[] = [];
	// Bytes of the pending event's data, including the "\n" joins, so events streamed as many
	// short `data:` lines without a terminating blank line cannot grow without bound.
	let dataBytes = 0;
	const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

	const dispatch = (terminated: boolean) => {
		// An event's ID counts as received only once the whole event has arrived.
		if (terminated && eventId !== undefined) options.onId?.(eventId);
		if (dataLines.length === 0) {
			eventName = undefined;
			eventId = undefined;
			return;
		}
		const data = dataLines.join("\n");
		options.onEvent(
			{ ...(eventName ? { event: eventName } : {}), data, ...(eventId ? { id: eventId } : {}) },
			terminated,
		);
		eventName = undefined;
		eventId = undefined;
		dataLines = [];
		dataBytes = 0;
	};

	const processLine = (line: string) => {
		if (line === "") {
			dispatch(true);
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") {
			dataBytes += Buffer.byteLength(value) + (dataLines.length > 0 ? 1 : 0);
			if (dataBytes > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
			dataLines.push(value);
		} else if (field === "event") eventName = value;
		else if (field === "id" && !value.includes("\0")) eventId = value;
		else if (field === "retry" && /^\d+$/.test(value)) options.onRetry?.(Number(value));
	};

	// SSE lines end with CRLF, LF, or a lone CR.
	let skipLeadingLf = false;
	const takePendingLine = (rest: string) => {
		pendingPieces.push(rest);
		const line = pendingPieces.join("");
		pendingPieces = [];
		pendingBytes = 0;
		return line;
	};
	// Scans only the newly decoded text; the incomplete line before it is never rescanned.
	const consumeLines = (text: string) => {
		let start = 0;
		for (const lineBreak of text.matchAll(/\r\n?|\n/g)) {
			processLine(takePendingLine(text.slice(start, lineBreak.index)));
			start = lineBreak.index + lineBreak[0].length;
			// A CR that ends the text may be the first half of a CRLF.
			if (lineBreak[0] === "\r" && start === text.length) skipLeadingLf = true;
		}
		const rest = text.slice(start);
		pendingPieces.push(rest);
		pendingBytes += Buffer.byteLength(rest);
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			// A cancelled read ends like the stream; the partial event must not be dispatched.
			if (signal?.aborted) throw new McpAbortError();
			if (done) break;
			let text = decoder.decode(value, { stream: true });
			// A CRLF split across chunks: the CR already ended the line, so drop the LF.
			if (skipLeadingLf && text.length > 0) {
				if (text.startsWith("\n")) text = text.slice(1);
				skipLeadingLf = false;
			}
			consumeLines(text);
			if (pendingBytes > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
		}
		let tail = decoder.decode();
		if (skipLeadingLf && tail.startsWith("\n")) tail = tail.slice(1);
		consumeLines(tail);
		// The last line needs no line break, and the end of the stream ends the pending event.
		processLine(takePendingLine(""));
		dispatch(false);
	} catch (error) {
		// Releasing the lock alone leaves the response open; the original error wins over a failed cancel.
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

export interface StreamableHttpReconnectOptions {
	/** Delay before the first reconnection attempt, unless the server sent a `retry` field. Default: 1000. */
	initialDelayMs?: number;
	/** Upper bound for the exponential backoff. Default: 30000. */
	maxDelayMs?: number;
	/** Consecutive failed attempts before giving up on a stream. Default: 5. */
	maxRetries?: number;
}

export interface StreamableHttpTransportOptions {
	url: string | URL;
	headers?: Record<string, string>;
	fetch?: McpFetch;
	/** Open the server-to-client GET stream after initialization. Default: true. */
	openGetStream?: boolean;
	maxMessageBytes?: number;
	authProvider?: AuthProvider;
	/** Reconnection of dropped SSE streams (the GET stream, and response streams that carry event IDs). */
	reconnect?: StreamableHttpReconnectOptions;
}

export class McpHttpError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, message: string, body = "") {
		super(message);
		this.name = "McpHttpError";
		this.status = status;
		this.body = body;
	}
}

export class McpAuthRequiredError extends McpHttpError {
	readonly wwwAuthenticate: string | null;

	constructor(response: Response, body = "", secrets: readonly string[] = []) {
		super(401, "MCP server requires authentication", body);
		this.name = "McpAuthRequiredError";
		const raw = response.headers.get("www-authenticate");
		this.wwwAuthenticate = raw === null ? null : redactWwwAuthenticateHeader(raw, secrets);
	}
}

export class McpSessionExpiredError extends McpHttpError {
	constructor(body = "") {
		super(404, "MCP session expired", body);
		this.name = "McpSessionExpiredError";
	}
}

function contentType(response: Response): string | undefined {
	return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

/** 401, or 403 with an `insufficient_scope` bearer challenge (step-up authorization). */
function needsAuthorization(response: Response): boolean {
	if (response.status === 401) return true;
	if (response.status !== 403) return false;
	return /(?:^|[\s,])error="?insufficient_scope"?/i.test(response.headers.get("www-authenticate") ?? "");
}

/** Statuses worth retrying when a stream fails to (re)open. */
function isTransientStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function discard(response: Response): Promise<void> {
	return response.body?.cancel().catch(() => {}) ?? Promise.resolve();
}

/**
 * Reads a response body as text, decoding chunks as they arrive. Once the body exceeds `maxBytes`, the rest is
 * cancelled and the text holds only the first `maxBytes` bytes.
 */
async function readBodyText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
	if (!response.body) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let remaining = maxBytes;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return { text: text + decoder.decode(), truncated: false };
			if (value.byteLength > remaining) {
				await reader.cancel().catch(() => {});
				// Decoding a subarray copies only the kept bytes, so the result never references the dropped rest.
				return { text: text + decoder.decode(value.subarray(0, remaining), { stream: true }), truncated: true };
			}
			remaining -= value.byteLength;
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

/** Standard non-secret HTTP headers that never carry credentials; all other configured headers are treated as sensitive. */
const NON_SECRET_HTTP_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"accept-language",
	"cache-control",
	"content-type",
	"mcp-protocol-version",
	"origin",
	"pragma",
	"referer",
	"user-agent",
]);

function describeHttpFailure(status: number, body: string): string {
	const text = body.trim();
	const snippet = text.length > ERROR_MESSAGE_BODY_CHARS ? `${text.slice(0, ERROR_MESSAGE_BODY_CHARS - 3)}...` : text;
	return `MCP HTTP request failed with status ${status}${snippet ? `: ${snippet}` : ""}`;
}

interface StreamCursor {
	lastEventId: string | undefined;
	retryMs: number | undefined;
	/** Whether the stream delivered a new resumable event ID since it was (re)opened. */
	advanced: boolean;
}

export class StreamableHttpTransport extends TransportEvents implements McpTransport {
	readonly url: URL;
	readonly options: Readonly<StreamableHttpTransportOptions>;
	private fetch: McpFetch;
	private controller = new AbortController();
	private started = false;
	private closed = false;
	private sessionIdValue: string | undefined;
	private protocolVersion: string | undefined;
	private getStreamStarted = false;
	/** Access token of the latest request, which `close()` reuses instead of asking the auth provider. */
	private lastToken: string | undefined;

	constructor(options: StreamableHttpTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
		this.url = new URL(options.url);
		const fetch = options.fetch ?? globalThis.fetch;
		// Call fetch without a receiver. `this.fetch(...)` and `context.fetch(...)` would pass the transport or
		// the auth context as `this`, which Cloudflare Workers reject for the platform fetch ("Illegal invocation").
		this.fetch = (input, init) => fetch(input, init);
	}

	get sessionId(): string | undefined {
		return this.sessionIdValue;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP Streamable HTTP transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
	}

	setProtocolVersion(version: string): void {
		this.protocolVersion = version;
	}

	async send(message: JsonRpcMessage, { signal }: McpTransportSendOptions = {}): Promise<void> {
		if (!this.started || this.closed) throw new McpConnectionClosedError();
		const { response, token } = await this.authorizedFetch(
			"POST",
			{
				headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
				body: JSON.stringify(message),
			},
			signal,
		);
		await this.checkResponse(response, token);
		this.captureSession(response);

		if (!isJsonRpcRequest(message)) {
			// Notifications and responses are acknowledged with 202 and carry no reply; ignore any body.
			await discard(response);
			// The server-to-client stream may only open once the session is initialized.
			if ("method" in message && message.method === "notifications/initialized") this.startGetStream();
			return;
		}
		if (response.status === 202 || response.status === 204) {
			throw new McpHttpError(response.status, `MCP server accepted request ${message.method} without a response`);
		}
		const type = contentType(response);
		if (type === "application/json") {
			const maxBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
			const { text, truncated } = await readBodyText(response, maxBytes);
			if (truncated) throw new Error(`MCP JSON response exceeds ${maxBytes} bytes`);
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				throw new Error("Invalid MCP JSON response");
			}
			for (const item of Array.isArray(body) ? body : [body]) {
				this.emitMessage(this.scrubIncomingMessage(parseJsonRpcMessage(item), token));
			}
			return;
		}
		if (type === "text/event-stream" && response.body) {
			void this.consumeResponseStream(response.body, message.id, signal, token);
			return;
		}
		await discard(response);
		throw new McpHttpError(response.status, `Unsupported MCP response content type: ${type ?? "missing"}`);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		if (this.started && this.sessionIdValue) {
			// Best effort: the session expires on the server anyway. The auth provider may refresh tokens
			// over the network, so it is not asked here and closing never waits for a refresh.
			try {
				const response = await this.fetch(this.url, {
					method: "DELETE",
					headers: this.buildHeaders({}, this.lastToken),
					signal: AbortSignal.timeout(1_000),
				});
				await discard(response);
			} catch {}
		}
		this.emitClose();
	}

	/**
	 * Fetch with auth headers. A 401 (or a 403 asking for more scope) is handed to the auth provider
	 * once, and the request is retried with whatever credentials it left behind.
	 */
	private async authorizedFetch(
		method: "GET" | "POST",
		init: { headers: Record<string, string>; body?: string },
		signal?: AbortSignal,
	): Promise<{ response: Response; token: string | undefined }> {
		const onUnauthorized = this.options.authProvider?.onUnauthorized?.bind(this.options.authProvider);
		// Aborting the request ends its fetch and response body, as closing the transport does.
		const fetchSignal = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
		for (let attempt = 0; ; attempt++) {
			const { headers, token } = await this.headers(init.headers);
			if (signal?.aborted) throw new McpAbortError();
			const response = await this.fetch(this.url, {
				method,
				headers,
				body: init.body,
				signal: fetchSignal,
			});
			if (attempt > 0 || !onUnauthorized || !needsAuthorization(response)) return { response, token };
			try {
				await onUnauthorized({ response, serverUrl: this.url, fetch: this.fetch, token });
			} finally {
				await discard(response);
			}
		}
	}

	private async headers(extra: Record<string, string> = {}): Promise<{ headers: Headers; token?: string }> {
		const token = await this.options.authProvider?.token();
		this.lastToken = token;
		return { headers: this.buildHeaders(extra, token), ...(token ? { token } : {}) };
	}

	private buildHeaders(extra: Record<string, string>, token: string | undefined): Headers {
		const headers = new Headers(this.options.headers);
		for (const [name, value] of Object.entries(extra)) headers.set(name, value);
		if (this.sessionIdValue) headers.set("Mcp-Session-Id", this.sessionIdValue);
		if (this.protocolVersion) headers.set("MCP-Protocol-Version", this.protocolVersion);
		if (token) headers.set("Authorization", `Bearer ${token}`);
		return headers;
	}

	private captureSession(response: Response): void {
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.sessionIdValue = sessionId;
	}

	/** Active credentials associated with this transport (for redacting error/log output). */
	activeSecrets(requestToken?: string): string[] {
		const secrets: string[] = [];
		const token = requestToken ?? this.lastToken;
		if (token) secrets.push(token);
		if (this.lastToken && this.lastToken !== token) secrets.push(this.lastToken);
		if (this.url.password) secrets.push(this.url.password);
		for (const value of this.url.searchParams.values()) {
			if (value) secrets.push(value);
		}
		if (this.options.headers) {
			for (const [name, value] of Object.entries(this.options.headers)) {
				if (!NON_SECRET_HTTP_HEADERS.has(name.toLowerCase())) {
					secrets.push(...extractHeaderSecrets(name, value));
				}
			}
		}
		return secrets;
	}

	private scrubIncomingMessage(message: JsonRpcMessage, requestToken?: string): JsonRpcMessage {
		if (!isJsonRpcResponse(message) || !("error" in message)) return message;
		const secrets = this.activeSecrets(requestToken);
		return {
			...message,
			error: {
				...message.error,
				message: redactOAuthErrorText(message.error.message, secrets),
				...(message.error.data === undefined ? {} : { data: scrubUnknownErrorData(message.error.data, secrets) }),
			},
		};
	}

	private async checkResponse(response: Response, requestToken?: string): Promise<void> {
		if (response.ok) return;
		const secrets = this.activeSecrets(requestToken);
		// Read past the cap by at least the longest encoded active secret so a secret straddling the boundary is caught whole.
		let maxSecretBytes = 0;
		for (const secret of secrets) {
			const encodedUpperBound = Buffer.byteLength(secret) * 3;
			if (encodedUpperBound > maxSecretBytes) maxSecretBytes = encodedUpperBound;
		}
		const lookahead = Math.max(ERROR_BODY_REDACTION_LOOKAHEAD_BYTES, Math.min(maxSecretBytes, MAX_ERROR_BODY_BYTES));
		const { text: rawBody, truncated } = await readBodyText(response, MAX_ERROR_BODY_BYTES + lookahead).catch(() => ({
			text: "",
			truncated: false,
		}));
		let body = redactOAuthErrorText(rawBody, secrets);
		if ((truncated || rawBody.length > MAX_ERROR_BODY_BYTES) && body.length > MAX_ERROR_BODY_BYTES) {
			body = body.slice(0, MAX_ERROR_BODY_BYTES);
		}
		if (response.status === 401) throw new McpAuthRequiredError(response, body, secrets);
		if (response.status === 404 && this.sessionIdValue) throw new McpSessionExpiredError(body);
		throw new McpHttpError(response.status, describeHttpFailure(response.status, body), body);
	}

	private async consumeSse(
		stream: ReadableStream<Uint8Array>,
		cursor: StreamCursor,
		onMessage?: (message: JsonRpcMessage) => void,
		signal?: AbortSignal,
		requestToken?: string,
	): Promise<void> {
		await consumeSseStream(stream, {
			maxEventBytes: this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
			signal,
			onId: (id) => {
				if (id !== cursor.lastEventId) cursor.advanced = true;
				cursor.lastEventId = id;
			},
			onRetry: (delayMs) => {
				cursor.retryMs = delayMs;
			},
			onEvent: (event, terminated) => {
				// Events without data prime resumption; other event types are not JSON-RPC.
				if (!event.data.trim() || (event.event !== undefined && event.event !== "message")) return;
				let message: JsonRpcMessage;
				try {
					message = this.scrubIncomingMessage(parseJsonRpcMessage(JSON.parse(event.data)), requestToken);
				} catch (error) {
					// An event the stream ended in the middle of is discarded; a resume replays it.
					if (terminated) {
						this.emitError(
							new Error(redactOAuthErrorText(toError(error).message, this.activeSecrets(requestToken))),
						);
					}
					return;
				}
				onMessage?.(message);
				this.emitMessage(message);
			},
		});
	}

	/**
	 * Read the SSE stream answering one request. When the stream ends or breaks before the response
	 * arrives and the server assigned event IDs, resume it with GET and `Last-Event-ID`, as the
	 * server may close response streams at will. Otherwise only this request fails. Once the request settles
	 * (`signal` aborts on answer, cancellation, or timeout), the stream is cancelled and never resumed.
	 */
	private async consumeResponseStream(
		body: ReadableStream<Uint8Array>,
		requestId: JsonRpcId,
		signal: AbortSignal | undefined,
		initialToken: string | undefined,
	): Promise<void> {
		const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, advanced: false };
		let answered = false;
		const onMessage = (message: JsonRpcMessage) => {
			if (isJsonRpcResponse(message) && message.id === requestId) answered = true;
		};
		let stream: ReadableStream<Uint8Array> | undefined = body;
		let token = initialToken;
		let failure: unknown;
		for (let attempt = 0; ; ) {
			if (stream) {
				try {
					await this.consumeSse(stream, cursor, onMessage, signal, token);
					failure = undefined;
				} catch (error) {
					failure = error;
				}
			}
			if (answered || this.closed) return;
			if (failure !== undefined && !this.isRetryable(failure)) break;
			if (cursor.lastEventId === undefined || attempt >= this.maxRetries()) break;
			if (cursor.advanced) attempt = 0;
			cursor.advanced = false;
			if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
			try {
				const reopened = await this.openSseStream(cursor.lastEventId, signal);
				stream = reopened?.stream;
				token = reopened?.token ?? token;
			} catch (error) {
				failure = error;
				if (!this.isRetryable(error)) break;
				stream = undefined;
			}
		}
		if (this.closed || signal?.aborted) return;
		const reason =
			failure === undefined
				? "stream ended without a response"
				: redactOAuthErrorText(toError(failure).message, this.activeSecrets(token));
		this.emitMessage({
			jsonrpc: "2.0",
			id: requestId,
			error: { code: JSON_RPC_ERROR_CODES.internalError, message: `MCP response stream failed: ${reason}` },
		});
	}

	private startGetStream(): void {
		if (this.options.openGetStream === false || this.getStreamStarted || this.closed) return;
		this.getStreamStarted = true;
		void this.runGetStream();
	}

	/** Keep the server-to-client stream open, reconnecting with backoff when it drops. */
	private async runGetStream(): Promise<void> {
		const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, advanced: false };
		for (let attempt = 0; !this.closed; ) {
			try {
				const opened = await this.openSseStream(cursor.lastEventId);
				// The server does not offer a GET stream.
				if (!opened) return;
				const openedAt = Date.now();
				await this.consumeSse(opened.stream, cursor, undefined, undefined, opened.token);
				// Resumable progress, or a stream that stayed up for a while, counts as healthy.
				if (cursor.advanced || Date.now() - openedAt > this.maxDelay()) attempt = 0;
			} catch (error) {
				if (this.closed) return;
				if (!this.isRetryable(error)) {
					this.emitError(error);
					return;
				}
			}
			cursor.advanced = false;
			if (attempt >= this.maxRetries()) {
				this.emitError(new Error("MCP server-to-client stream dropped and could not be reopened"));
				return;
			}
			if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
		}
	}

	/** Open a GET SSE stream. Resolves to undefined when the server answers 405 (no GET stream). */
	private async openSseStream(
		lastEventId: string | undefined,
		signal?: AbortSignal,
	): Promise<{ stream: ReadableStream<Uint8Array>; token: string | undefined } | undefined> {
		const { response, token } = await this.authorizedFetch(
			"GET",
			{
				headers: {
					accept: "text/event-stream",
					...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
				},
			},
			signal,
		);
		if (response.status === 405) {
			await discard(response);
			return undefined;
		}
		await this.checkResponse(response, token);
		this.captureSession(response);
		const type = contentType(response);
		if (type !== "text/event-stream" || !response.body) {
			await discard(response);
			throw new McpHttpError(response.status, `Unsupported MCP GET response content type: ${type ?? "missing"}`);
		}
		return { stream: response.body, token };
	}

	/**
	 * Network failures and transient statuses are retried; auth, session, and protocol errors are not.
	 * `fetch` reports network failures, including a connection dropped mid-body, as `TypeError`.
	 */
	private isRetryable(error: unknown): boolean {
		if (error instanceof McpHttpError) return isTransientStatus(error.status);
		if (error instanceof TypeError) return true;
		const code = (error as { code?: unknown } | undefined)?.code;
		return typeof code === "string" && (code.startsWith("E") || code.startsWith("UND_ERR"));
	}

	private reconnectDelay(attempt: number, serverDelayMs: number | undefined): number {
		if (serverDelayMs !== undefined) return serverDelayMs;
		const initial = this.options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
		return Math.min(initial * 2 ** attempt, this.maxDelay());
	}

	private maxDelay(): number {
		return this.options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
	}

	private maxRetries(): number {
		return this.options.reconnect?.maxRetries ?? DEFAULT_RECONNECT_MAX_RETRIES;
	}

	/** Resolves false when the transport closed while waiting. */
	private sleep(ms: number): Promise<boolean> {
		const signal = this.controller.signal;
		if (signal.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			const onAbort = () => {
				clearTimeout(timer);
				resolve(false);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve(true);
			}, ms);
			// A reconnect wait alone does not keep the process alive.
			timer.unref?.();
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}
