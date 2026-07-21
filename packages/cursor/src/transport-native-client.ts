import { parseJsonObject } from "./config.js";
import {
	formatCursorH2NativeLoadFailure,
	loadCursorH2NativeBinding,
	type CursorH2NativeBinding,
	type CursorH2NativeStream,
} from "./native-loader.js";
import { CursorTransportError, toTransportError } from "./transport-errors.js";
import { nextNativeOperationId, raceWithAbort, withTimeout } from "./transport-timeouts.js";
import type {
	CursorHttp2Client,
	CursorHttp2StreamHandle,
	CursorHttp2UnaryResponse,
	CursorWriteOptions,
} from "./transport-types.js";

export function createDefaultCursorHttp2Client(): CursorHttp2Client {
	return new LazyNativeHttp2CursorClient();
}

class LazyNativeHttp2CursorClient implements CursorHttp2Client {
	#client: NativeHttp2CursorClient | undefined;

	private get client(): NativeHttp2CursorClient {
		if (this.#client) return this.#client;
		const native = loadCursorH2NativeBinding();
		if (!native.ok) throw new CursorTransportError("TransportError", formatCursorH2NativeLoadFailure(native));
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
		if (request.signal?.aborted) throw new CursorTransportError("Cancelled", "Cursor native HTTP/2 request aborted before start.");
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
		if (request.signal?.aborted) throw new CursorTransportError("Cancelled", "Cursor native HTTP/2 stream aborted before start.");
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
	readonly statusCode: number | undefined;
	readonly frames: AsyncIterable<Uint8Array>;
	#closed = false;

	constructor(readonly stream: CursorH2NativeStream) {
		this.statusCode = nativeStatusCode(stream.statusCode ?? stream.status_code);
		this.frames = this.createFrames();
	}

	async write(data: Uint8Array, options: CursorWriteOptions = {}): Promise<void> {
		if (this.#closed) throw new CursorTransportError("ProtocolError", "Cannot write to a closed Cursor native stream.");
		if (options.signal?.aborted) throw new CursorTransportError("Cancelled", "Cursor native stream write aborted before start.");
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
function nativeStatusCode(value: number | null | undefined): number | undefined {
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
