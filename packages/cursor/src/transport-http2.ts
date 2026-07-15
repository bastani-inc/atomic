import type { CursorUsableModel } from "./model-mapper.js";
import type { CursorAvailableModel } from "./proto/cursor-available-models-codec.js";
import {
	buildCursorRpcHeaders,
	CURSOR_API_BASE_URL,
	CURSOR_AVAILABLE_MODELS_PATH,
	CURSOR_GET_USABLE_MODELS_PATH,
	CURSOR_RUN_PATH,
} from "./config.js";
import { CursorProtobufProtocolCodec } from "./proto/protobuf-codec.js";
import { assertSuccessfulStatus, CursorTransportError, sanitizeCursorTransportError, toError } from "./transport-errors.js";
import { encodeCursorConnectFrame } from "./transport-frame.js";
import { createDefaultCursorHttp2Client } from "./transport-native-client.js";
import { Http2CursorRunStream } from "./transport-run-stream.js";
import { runWithDeadline } from "./transport-timeouts.js";
import type {
	CursorAgentTransport,
	CursorHttp2Client,
	CursorProtocolCodec,
	CursorRunRequest,
	CursorRunStream,
	CursorTransportLifecycleSnapshot,
	Http2CursorAgentTransportOptions,
} from "./transport-types.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

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
		try {
			const response = await this.#requestModelCatalog(
				CURSOR_GET_USABLE_MODELS_PATH,
				this.#codec.encodeGetUsableModelsRequest(),
				accessToken,
				requestId,
				signal,
			);
			return this.#codec.decodeGetUsableModelsResponse(response.body);
		} catch (error) {
			throw sanitizeCursorTransportError(toError(error), [accessToken]);
		}
	}

	async getAvailableModels(accessToken: string, requestId: string, signal?: AbortSignal): Promise<readonly CursorAvailableModel[]> {
		if (signal?.aborted) {
			throw new CursorTransportError("Aborted", "Cursor image metadata discovery was aborted before the request started.");
		}
		const encode = this.#codec.encodeAvailableModelsRequest;
		const decode = this.#codec.decodeAvailableModelsResponse;
		if (!encode || !decode) return [];
		try {
			const response = await this.#requestModelCatalog(
				CURSOR_AVAILABLE_MODELS_PATH,
				encode.call(this.#codec),
				accessToken,
				requestId,
				signal,
			);
			return decode.call(this.#codec, response.body);
		} catch (error) {
			throw sanitizeCursorTransportError(toError(error), [accessToken]);
		}
	}

	async #requestModelCatalog(
		path: string,
		body: Uint8Array,
		accessToken: string,
		requestId: string,
		signal?: AbortSignal,
	) {
		const headers = buildCursorRpcHeaders(accessToken, requestId, "application/proto");
		const response = await runWithDeadline(
			(parentSignal) => this.#client.requestUnary({
				baseUrl: this.#baseUrl,
				path,
				headers,
				body,
				signal: parentSignal,
				timeoutMs: this.#requestTimeoutMs,
			}),
			this.#requestTimeoutMs,
			signal,
			"Cursor model discovery timed out.",
		);
		assertSuccessfulStatus(response.statusCode, response.body, [accessToken]);
		return response;
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
