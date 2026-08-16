import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	clampThinkingLevel,
	type Model,
	type OpenAICodexResponsesOptions,
	type OpenAIResponsesOptions,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
	streamOpenAICodexResponses,
	streamOpenAIResponses,
	streamSimple,
	type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import {
	CODEX_FAST_MODE_ORIGINATOR,
	CODEX_FAST_MODE_ROUTING_HEADER,
	installCodexFastModeWebSocketIdentity,
	isFirstPartyCodexBaseUrl,
	wrapCodexFastModeFetch,
} from "./codex-fast-mode-transport.ts";
import type { OrchestrationContext } from "./extensions/index.ts";

export const CODEX_FAST_MODE_SERVICE_TIER = "priority" as const;

export interface CodexFastModeResolvedSettings {
	chat: boolean;
	workflow: boolean;
}

export type CodexFastModeScope = "chat" | "workflow";

export interface CodexFastModeStreamOptions extends SimpleStreamOptions {
	serviceTier?: typeof CODEX_FAST_MODE_SERVICE_TIER;
}

export interface CodexFastModeStreamers {
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

const DEFAULT_CODEX_FAST_MODE_STREAMERS: CodexFastModeStreamers = {
	streamSimple,
	streamOpenAIResponses,
	streamOpenAICodexResponses,
};

export function isCodexFastModeSupportedProvider(provider: string): boolean {
	return provider === "openai" || provider === "openai-codex";
}

export function isCodexFastModeCandidateModelId(modelId: string | undefined): boolean {
	const provider = modelId?.split("/", 1)[0];
	return provider !== undefined && isCodexFastModeSupportedProvider(provider);
}

export function isCodexFastModeSupportedModel(model: Pick<Model<Api>, "provider">): boolean {
	return isCodexFastModeSupportedProvider(model.provider);
}

export function hasSupportedCodexFastModeModel(models: readonly Pick<Model<Api>, "provider">[]): boolean {
	return models.some(isCodexFastModeSupportedModel);
}

export function isWorkflowStageOrchestrationContext(context: OrchestrationContext | undefined): boolean {
	return context?.kind === "workflow-stage";
}

export function getCodexFastModeScope(context: OrchestrationContext | undefined): CodexFastModeScope {
	return isWorkflowStageOrchestrationContext(context) ? "workflow" : "chat";
}

export function isCodexFastModeEnabledForScope(
	settings: CodexFastModeResolvedSettings,
	scope: CodexFastModeScope,
): boolean {
	return settings[scope];
}

export function isCodexFastModeEnabledForSession(
	settings: CodexFastModeResolvedSettings,
	context: OrchestrationContext | undefined,
): boolean {
	return isCodexFastModeEnabledForScope(settings, getCodexFastModeScope(context));
}

export function shouldApplyCodexFastModeForScope(
	model: Pick<Model<Api>, "provider">,
	settings: CodexFastModeResolvedSettings,
	scope: CodexFastModeScope,
): boolean {
	return isCodexFastModeSupportedModel(model) && isCodexFastModeEnabledForScope(settings, scope);
}

export function shouldApplyCodexFastMode(
	model: Pick<Model<Api>, "provider">,
	settings: CodexFastModeResolvedSettings,
	context: OrchestrationContext | undefined,
): boolean {
	return shouldApplyCodexFastModeForScope(model, settings, getCodexFastModeScope(context));
}

/**
 * The Codex backend gates priority routing on the first-party harness identity,
 * not on `service_tier` alone. Send `originator` and the routing hint only for
 * ChatGPT-backed `openai-codex` requests, so custom endpoints, proxies, and the
 * standard OpenAI API keep their own identity.
 */
export function usesFirstPartyCodexRouting(model: Pick<Model<Api>, "baseUrl" | "provider">): boolean {
	return model.provider === "openai-codex" && isFirstPartyCodexBaseUrl(model.baseUrl);
}

function setHeader(headers: ProviderHeaders, name: string, value: string): void {
	for (const existingName of Object.keys(headers)) {
		if (existingName.toLowerCase() === name.toLowerCase()) delete headers[existingName];
	}
	headers[name] = value;
}

export function withCodexFastModeHeaders(
	model: Pick<Model<Api>, "baseUrl" | "id" | "provider">,
	headers: ProviderHeaders | undefined,
	enabled: boolean,
): ProviderHeaders | undefined {
	if (!enabled || !usesFirstPartyCodexRouting(model)) return headers;
	const fastHeaders: ProviderHeaders = { ...(headers ?? {}) };
	setHeader(fastHeaders, "originator", CODEX_FAST_MODE_ORIGINATOR);
	setHeader(fastHeaders, CODEX_FAST_MODE_ROUTING_HEADER, `model=${model.id};tier=${CODEX_FAST_MODE_SERVICE_TIER}`);
	return fastHeaders;
}

export function withCodexFastModeStreamOptions(
	model: Pick<Model<Api>, "baseUrl" | "id" | "provider">,
	options: SimpleStreamOptions | undefined,
	enabled: boolean,
): CodexFastModeStreamOptions | undefined {
	if (!enabled) {
		return options;
	}

	return {
		...(options ?? {}),
		headers: withCodexFastModeHeaders(model, options?.headers, enabled),
		serviceTier: CODEX_FAST_MODE_SERVICE_TIER,
	};
}

export function isCodexFastModeNativeApi(api: Api): api is "openai-responses" | "openai-codex-responses" {
	return api === "openai-responses" || api === "openai-codex-responses";
}

export function shouldUseNativeCodexFastMode(
	model: Pick<Model<Api>, "api" | "provider">,
	options: CodexFastModeStreamOptions | undefined,
): boolean {
	return (
		isCodexFastModeSupportedModel(model) &&
		isCodexFastModeNativeApi(model.api) &&
		options?.serviceTier === CODEX_FAST_MODE_SERVICE_TIER
	);
}

function buildCodexFastModeBaseProviderOptions(
	model: Model<Api>,
	options: CodexFastModeStreamOptions | undefined,
): StreamOptions {
	// Native fast-mode streams bypass pi-ai's streamSimple base-options merge.
	const samplingParams =
		model.samplingParams || options?.samplingParams
			? { ...model.samplingParams, ...options?.samplingParams }
			: undefined;
	return {
		samplingParams,
		temperature: options?.temperature,
		maxTokens: options?.maxTokens,
		signal: options?.signal,
		apiKey: options?.apiKey,
		// pi-ai sets `originator: pi` after this call, so repair the first-party
		// Codex identity on the request it actually dispatches.
		fetch: usesFirstPartyCodexRouting(model)
			? wrapCodexFastModeFetch(options?.fetch ?? globalThis.fetch)
			: options?.fetch,
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
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};
}

export function mapCodexFastModeReasoningEffort(
	model: Model<Api>,
	reasoning: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
	const clampedReasoning = reasoning ? clampThinkingLevel(model, reasoning) : undefined;
	return clampedReasoning === "off" ? undefined : clampedReasoning;
}

export function buildOpenAIResponsesCodexFastModeOptions(
	model: Model<Api>,
	options: CodexFastModeStreamOptions | undefined,
): OpenAIResponsesOptions {
	return {
		...buildCodexFastModeBaseProviderOptions(model, options),
		reasoningEffort: mapCodexFastModeReasoningEffort(model, options?.reasoning),
		serviceTier: options?.serviceTier,
	};
}

export function buildOpenAICodexResponsesCodexFastModeOptions(
	model: Model<Api>,
	options: CodexFastModeStreamOptions | undefined,
): OpenAICodexResponsesOptions {
	return {
		...buildCodexFastModeBaseProviderOptions(model, options),
		reasoningEffort: mapCodexFastModeReasoningEffort(model, options?.reasoning),
		serviceTier: options?.serviceTier,
	};
}

export function streamWithCodexFastMode(
	model: Model<Api>,
	context: Context,
	options: CodexFastModeStreamOptions | undefined,
	streamers: CodexFastModeStreamers = DEFAULT_CODEX_FAST_MODE_STREAMERS,
): AssistantMessageEventStream {
	if (shouldUseNativeCodexFastMode(model, options)) {
		if (model.api === "openai-responses") {
			return streamers.streamOpenAIResponses(
				model as Model<"openai-responses">,
				context,
				buildOpenAIResponsesCodexFastModeOptions(model, options),
			);
		}

		// The WebSocket handshake builds its headers inside pi-ai, and the runtime
		// constructor can be cached before the first turn, so repair the identity
		// through the global constructor rather than per-request options.
		if (options?.transport !== "sse" && usesFirstPartyCodexRouting(model)) {
			installCodexFastModeWebSocketIdentity();
		}

		return streamers.streamOpenAICodexResponses(
			model as Model<"openai-codex-responses">,
			context,
			buildOpenAICodexResponsesCodexFastModeOptions(model, options),
		);
	}

	return streamers.streamSimple(model, context, options);
}

function isObjectPayload(payload: unknown): payload is Record<string, unknown> {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

export function withCodexFastModePayload(payload: unknown, enabled: boolean): unknown {
	if (!enabled || !isObjectPayload(payload) || payload.service_tier !== undefined) {
		return payload;
	}

	return {
		...payload,
		service_tier: CODEX_FAST_MODE_SERVICE_TIER,
	};
}

export function formatCodexFastModeModelLabel(modelName: string, enabled: boolean): string {
	return enabled ? `${modelName} fast` : modelName;
}
