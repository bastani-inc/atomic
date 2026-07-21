import type { CursorUsableModel } from "./model-mapper.js";
import {
	buildCursorRpcHeaders,
	CURSOR_API_BASE_URL,
	CURSOR_GET_USABLE_MODELS_PATH,
	CURSOR_RUN_PATH,
} from "./config.js";
import { CursorProtobufProtocolCodec } from "./proto/protobuf-codec.js";
import { assertSuccessfulStatus, CursorTransportError, sanitizeCursorTransportError, toError } from "./transport-errors.js";
import { encodeCursorConnectFrame } from "./transport-frame.js";
import { assertCurrentCursorInputIsTextOnly } from "./input-validation.js";
import { createDefaultCursorHttp2Client } from "./transport-native-client.js";
import { Http2CursorRunStream } from "./transport-run-stream.js";
import { runWithDeadline } from "./transport-timeouts.js";
import { assertCursorRouteReference } from "./route-reference.js";
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
			throw new CursorTransportError("Cancelled", "Cursor model discovery was aborted before the request started.");
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
			throw sanitizeCursorTransportError(toError(error), [accessToken], { operation: "discovery" });
		}
	}

	async run(request: CursorRunRequest): Promise<CursorRunStream> {
		assertCursorRouteReference(request.routeReference);
		if (request.signal?.aborted) {
			throw new CursorTransportError("Cancelled", "Cursor stream was aborted before the request started.");
		}
		const headers = {
			...buildCursorRpcHeaders(request.accessToken, request.requestId, "application/connect+proto"),
			"connect-protocol-version": "1",
		};
		try {
			assertCurrentCursorInputIsTextOnly(request.context, request.model.id);
			const initialBody = encodeCursorConnectFrame(this.#codec.encodeRunRequest(request));
			const handle = await runWithDeadline(
				(parentSignal) => this.#client.openStream({ baseUrl: this.#baseUrl, path: CURSOR_RUN_PATH, headers, signal: parentSignal, initialBody, timeoutMs: request.openTimeoutMs ?? this.#streamOpenTimeoutMs }),
				request.openTimeoutMs ?? this.#streamOpenTimeoutMs,
				request.signal,
				"Cursor stream open timed out.",
				(handle) => handle.cancel().catch(() => undefined),
			);
			try {
				assertSuccessfulStatus(handle.statusCode, new Uint8Array(), [request.accessToken]);
			} catch (error) {
				await handle.cancel().catch(() => undefined);
				throw error;
			}
			this.#openStreams += 1;
			return new Http2CursorRunStream(
				request.requestId,
				handle,
				this.#codec,
				[request.accessToken],
				request.routeReference,
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
			throw sanitizeCursorTransportError(toError(error), [request.accessToken], { operation: "request", route: request.routeReference });
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
