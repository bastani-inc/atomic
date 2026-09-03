import { closeOpenAICodexWebSocketSessions } from "@bastani/pi-ai/api/openai-codex-responses";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	clampThinkingLevel,
	type Model,
	type ModelFastRoute,
	type OpenAICodexResponsesOptions,
	type OpenAIResponsesOptions,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
	streamOpenAICodexResponses,
	streamOpenAIResponses,
	streamSimple,
	type ThinkingLevel,
} from "@bastani/pi-ai/compat";
import {
	CODEX_FAST_ROUTE_HEADER,
	CODEX_FAST_ROUTE_ORIGINATOR,
	clearCodexFastRouteRequestMarker,
	installCodexFastRouteWebSocketIdentity,
	isFirstPartyCodexBaseUrl,
	markCodexFastRouteRequest,
	wrapCodexFastRouteFetch,
} from "./fast-model-routing-transport.ts";
import { FAST_MODEL_SERVICE_TIER, isNativeFastRouteApi } from "./fast-model-variants.ts";

export interface FastRouteStreamOptions extends SimpleStreamOptions {
	serviceTier?: typeof FAST_MODEL_SERVICE_TIER;
}

export interface FastRouteStreamers {
	streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	streamOpenAIResponses: (
		model: Model<"openai-responses">,
		context: Context,
		options?: OpenAIResponsesOptions,
	) => AssistantMessageEventStream;
	streamOpenAICodexResponses: (
		model: Model<"openai-codex-responses">,
		context: Context,
		options?: OpenAICodexResponsesOptions,
	) => AssistantMessageEventStream;
}

const DEFAULT_FAST_ROUTE_STREAMERS: FastRouteStreamers = {
	streamSimple,
	streamOpenAIResponses,
	streamOpenAICodexResponses,
};

const CODEX_WEBSOCKET_ROUTING_STATE_IDLE_MS = 6 * 60 * 1000;
const codexWebSocketRoutingState = new Map<string, { signature: string; expiry: ReturnType<typeof setTimeout> }>();

/**
 * Explicit route metadata is the only source of fast semantics. A model whose ID merely ends in
 * `-fast` — a provider, `models.json`, or extension model that owns that exact ID — routes normally.
 */
export function getModelFastRoute(model: Pick<Model<Api>, "fastRoute">): ModelFastRoute | undefined {
	return model.fastRoute;
}

/**
 * The model ID this request sends upstream. An OpenAI-style fast route sends the base model and
 * carries a priority service tier instead; a provider with real fast siblings sends its own
 * advertised ID, which is already the canonical one. The canonical `-fast` identity always stays on
 * the model object Atomic selected, persisted, and records — only the serialized request differs.
 */
export function resolveUpstreamModelId(model: Pick<Model<Api>, "fastRoute" | "id">): string {
	return model.fastRoute?.upstreamModelId ?? model.id;
}

/**
 * Preserve the eager first-party header helper for callers that only know a provider and base URL.
 * The shared transport wrapper below recomputes the identity from the final payload and also covers
 * aliases and proxies.
 */
export function usesFirstPartyCodexRouting(model: Pick<Model<Api>, "baseUrl" | "provider">): boolean {
	return model.provider === "openai-codex" && isFirstPartyCodexBaseUrl(model.baseUrl);
}

/** A provider alias or proxy still uses the shared ChatGPT Codex protocol when its API does. */
export function usesChatGptCodexTransport(model: Pick<Model<Api>, "api">): boolean {
	return model.api === "openai-codex-responses";
}

function deleteHeader(headers: ProviderHeaders, name: string): void {
	for (const existingName of Object.keys(headers)) {
		if (existingName.toLowerCase() === name.toLowerCase()) delete headers[existingName];
	}
}

function setHeader(headers: ProviderHeaders, name: string, value: string): void {
	deleteHeader(headers, name);
	headers[name] = value;
}

/**
 * Eager first-party routing headers for a request that is already resolved to its upstream model ID.
 * `enabled` reflects the model's own route metadata, never a session toggle.
 */
export function withCodexFastRouteHeaders(
	model: Pick<Model<Api>, "baseUrl" | "id" | "provider">,
	headers: ProviderHeaders | undefined,
	enabled: boolean,
): ProviderHeaders | undefined {
	if (!enabled || !usesFirstPartyCodexRouting(model)) return headers;
	const fastHeaders: ProviderHeaders = { ...(headers ?? {}) };
	setHeader(fastHeaders, "originator", CODEX_FAST_ROUTE_ORIGINATOR);
	setHeader(fastHeaders, CODEX_FAST_ROUTE_HEADER, `model=${model.id};tier=${FAST_MODEL_SERVICE_TIER}`);
	return fastHeaders;
}

/** Attach the route's service tier to the outgoing stream options. */
export function withFastRouteStreamOptions(
	fastRoute: ModelFastRoute | undefined,
	options: SimpleStreamOptions | undefined,
): FastRouteStreamOptions | undefined {
	if (fastRoute?.serviceTier === undefined) return options;
	return { ...(options ?? {}), headers: options?.headers, serviceTier: fastRoute.serviceTier };
}

/** A service-tier route needs pi-ai's native adapters; `streamSimple` drops `serviceTier`. */
export function shouldUseNativeFastRoute(
	model: Pick<Model<Api>, "api">,
	options: FastRouteStreamOptions | undefined,
): boolean {
	return isNativeFastRouteApi(model.api) && options?.serviceTier === FAST_MODEL_SERVICE_TIER;
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: undefined;
}

function codexEnvironmentScope(env: StreamOptions["env"]): string {
	if (!env) return "none";
	const serialized = JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right)));
	let hash = 2166136261;
	for (let index = 0; index < serialized.length; index += 1) {
		hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619);
	}
	return (hash >>> 0).toString(16);
}

type CloseCodexWebSocketSessions = typeof closeOpenAICodexWebSocketSessions;
function updateCodexWebSocketRoutingState(
	model: Pick<Model<Api>, "baseUrl" | "provider">,
	routedModel: string,
	options: Pick<StreamOptions, "env" | "sessionId" | "transport">,
	priority: boolean,
	closeWebSocketSessions: CloseCodexWebSocketSessions,
): void {
	if (options.transport === "sse" || !options.sessionId) return;
	const signature = `${model.provider}\0${model.baseUrl}\0${codexEnvironmentScope(options.env)}\0${priority ? `priority:${routedModel}` : "normal"}`;
	const previous = codexWebSocketRoutingState.get(options.sessionId);
	if (previous?.signature !== undefined && previous.signature !== signature) {
		closeWebSocketSessions(options.sessionId);
	}
	if (previous) clearTimeout(previous.expiry);
	const expiry = setTimeout(() => {
		if (codexWebSocketRoutingState.get(options.sessionId!)?.signature === signature) {
			codexWebSocketRoutingState.delete(options.sessionId!);
		}
	}, CODEX_WEBSOCKET_ROUTING_STATE_IDLE_MS);
	expiry.unref?.();
	codexWebSocketRoutingState.set(options.sessionId, { signature, expiry });
}

export function withChatGptCodexTransportRouting<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions,
	enabled = true,
	closeWebSocketSessions: CloseCodexWebSocketSessions = closeOpenAICodexWebSocketSessions,
): TOptions {
	const headers: ProviderHeaders = { ...(options.headers ?? {}) };
	const onPayload = options.onPayload;
	return {
		...options,
		headers,
		fetch: wrapCodexFastRouteFetch(options.fetch ?? globalThis.fetch),
		onPayload: async (payload, requestModel) => {
			const replacement = await onPayload?.(payload, requestModel);
			const finalPayload = replacement === undefined ? payload : replacement;
			const record = payloadRecord(finalPayload);
			const priority = enabled && record?.service_tier === FAST_MODEL_SERVICE_TIER;
			// The hint names the model the request actually routes to, so it matches the serialized
			// payload rather than the canonical `-fast` identity the caller selected.
			const routedModel = typeof record?.model === "string" ? record.model : resolveUpstreamModelId(model);
			deleteHeader(headers, CODEX_FAST_ROUTE_HEADER);
			clearCodexFastRouteRequestMarker(headers);
			if (priority) {
				setHeader(headers, CODEX_FAST_ROUTE_HEADER, `model=${routedModel};tier=${FAST_MODEL_SERVICE_TIER}`);
			} else {
				for (const [name, value] of Object.entries(headers)) {
					if (name.toLowerCase() === "originator" && value === CODEX_FAST_ROUTE_ORIGINATOR) delete headers[name];
				}
			}
			markCodexFastRouteRequest(headers, priority);
			updateCodexWebSocketRoutingState(model, routedModel, options, priority, closeWebSocketSessions);
			return finalPayload;
		},
	} as TOptions;
}

function buildFastRouteBaseProviderOptions(
	model: Model<Api>,
	options: FastRouteStreamOptions | undefined,
): StreamOptions {
	// Native fast-route streams bypass pi-ai's streamSimple base-options merge.
	const samplingParams =
		model.samplingParams || options?.samplingParams
			? { ...model.samplingParams, ...options?.samplingParams }
			: undefined;
	const providerOptions: StreamOptions = {
		samplingParams,
		temperature: options?.temperature,
		maxTokens: options?.maxTokens,
		signal: options?.signal,
		apiKey: options?.apiKey,
		fetch: options?.fetch,
		env: options?.env,
		telemetryContext: options?.telemetryContext,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		headers: options?.headers,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		streamDeadlineMs: options?.streamDeadlineMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};
	return usesChatGptCodexTransport(model) ? withChatGptCodexTransportRouting(model, providerOptions) : providerOptions;
}

export function mapFastRouteReasoningEffort(
	model: Model<Api>,
	reasoning: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
	const clampedReasoning = reasoning ? clampThinkingLevel(model, reasoning) : undefined;
	return clampedReasoning === "off" ? undefined : clampedReasoning;
}

export function buildOpenAIResponsesFastRouteOptions(
	model: Model<Api>,
	options: FastRouteStreamOptions | undefined,
): OpenAIResponsesOptions {
	return {
		...buildFastRouteBaseProviderOptions(model, options),
		reasoningEffort: mapFastRouteReasoningEffort(model, options?.reasoning),
		serviceTier: options?.serviceTier,
	};
}

export function buildOpenAICodexResponsesFastRouteOptions(
	model: Model<Api>,
	options: FastRouteStreamOptions | undefined,
): OpenAICodexResponsesOptions {
	return {
		...buildFastRouteBaseProviderOptions(model, options),
		reasoningEffort: mapFastRouteReasoningEffort(model, options?.reasoning),
		serviceTier: options?.serviceTier,
	};
}

/**
 * Stream a request whose model resolved to a service-tier fast route. `model` must already be the
 * upstream request model, so the payload and the routing hint both carry the base upstream ID.
 */
export function streamWithFastRoute(
	model: Model<Api>,
	context: Context,
	options: FastRouteStreamOptions | undefined,
	streamers: FastRouteStreamers = DEFAULT_FAST_ROUTE_STREAMERS,
): AssistantMessageEventStream {
	if (shouldUseNativeFastRoute(model, options)) {
		if (model.api === "openai-responses") {
			return streamers.streamOpenAIResponses(
				model as Model<"openai-responses">,
				context,
				buildOpenAIResponsesFastRouteOptions(model, options),
			);
		}

		// The WebSocket handshake builds its headers inside pi-ai, and the runtime
		// constructor can be cached before the first turn, so repair the identity
		// through the global constructor rather than per-request options.
		if (options?.transport !== "sse" && usesChatGptCodexTransport(model)) {
			installCodexFastRouteWebSocketIdentity();
		}

		return streamers.streamOpenAICodexResponses(
			model as Model<"openai-codex-responses">,
			context,
			buildOpenAICodexResponsesFastRouteOptions(model, options),
		);
	}

	return streamers.streamSimple(model, context, options);
}
