import type { Credential } from "@bastani/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@bastani/pi-ai/api/openai-codex-responses";
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
} from "@bastani/pi-ai/compat";
import {
	CODEX_FAST_MODE_ORIGINATOR,
	CODEX_FAST_MODE_ROUTING_HEADER,
	clearCodexFastModeRequestMarker,
	installCodexFastModeWebSocketIdentity,
	isFirstPartyCodexBaseUrl,
	markCodexFastModeRequest,
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

type CodexFastModeModelIdentity = Pick<Model<Api>, "provider"> & Partial<Pick<Model<Api>, "api" | "id">>;

const CODEX_WEBSOCKET_ROUTING_STATE_IDLE_MS = 6 * 60 * 1000;
const codexWebSocketRoutingState = new Map<string, { signature: string; expiry: ReturnType<typeof setTimeout> }>();

export function isCodexFastModeSupportedProvider(provider: string): boolean {
	return provider === "openai" || provider === "openai-codex";
}

export function isCodexFastModeCandidateModelId(modelId: string | undefined): boolean {
	const provider = modelId?.split("/", 1)[0];
	return provider !== undefined && isCodexFastModeSupportedProvider(provider);
}

export function isGitHubCopilotModel(model: Pick<Model<Api>, "provider">): boolean {
	return model.provider === "github-copilot";
}

export function isGitHubCopilotFastModeSupportedModel(
	model: Pick<Model<Api>, "id" | "provider">,
	credential: Credential | undefined,
): boolean {
	if (!isGitHubCopilotModel(model) || credential?.type !== "oauth") return false;
	const fastModelIds = credential.fastModelIds;
	return (
		Array.isArray(fastModelIds) &&
		fastModelIds.every((modelId) => typeof modelId === "string") &&
		fastModelIds.includes(`${model.id}-fast`)
	);
}

export function isCodexFastModeSupportedModel(
	model: CodexFastModeModelIdentity,
	copilotCredential?: Credential,
): boolean {
	return (
		isCodexFastModeSupportedProvider(model.provider) ||
		model.api === "openai-codex-responses" ||
		(model.id !== undefined &&
			isGitHubCopilotFastModeSupportedModel({ provider: model.provider, id: model.id }, copilotCredential))
	);
}

export function hasSupportedCodexFastModeModel(
	models: readonly CodexFastModeModelIdentity[],
	copilotCredential?: Credential,
): boolean {
	return models.some((model) => isCodexFastModeSupportedModel(model, copilotCredential));
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
	model: CodexFastModeModelIdentity,
	settings: CodexFastModeResolvedSettings,
	scope: CodexFastModeScope,
	copilotCredential?: Credential,
): boolean {
	return isCodexFastModeSupportedModel(model, copilotCredential) && isCodexFastModeEnabledForScope(settings, scope);
}

export function shouldApplyCodexFastMode(
	model: CodexFastModeModelIdentity,
	settings: CodexFastModeResolvedSettings,
	context: OrchestrationContext | undefined,
	copilotCredential?: Credential,
): boolean {
	return shouldApplyCodexFastModeForScope(model, settings, getCodexFastModeScope(context), copilotCredential);
}

/**
 * Preserve the eager first-party header helper for callers that only know a
 * provider and base URL. The shared transport wrapper below recomputes the
 * identity from the final payload and also covers aliases and proxies.
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
	if (!enabled || model.provider === "github-copilot") {
		return options;
	}

	return {
		...(options ?? {}),
		headers: options?.headers,
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
		fetch: wrapCodexFastModeFetch(options.fetch ?? globalThis.fetch),
		onPayload: async (payload, requestModel) => {
			const replacement = await onPayload?.(payload, requestModel);
			const finalPayload = replacement === undefined ? payload : replacement;
			const record = payloadRecord(finalPayload);
			const priority = enabled && record?.service_tier === CODEX_FAST_MODE_SERVICE_TIER;
			const routedModel = typeof record?.model === "string" ? record.model : model.id;
			deleteHeader(headers, CODEX_FAST_MODE_ROUTING_HEADER);
			clearCodexFastModeRequestMarker(headers);
			if (priority) {
				setHeader(
					headers,
					CODEX_FAST_MODE_ROUTING_HEADER,
					`model=${routedModel};tier=${CODEX_FAST_MODE_SERVICE_TIER}`,
				);
			} else {
				for (const [name, value] of Object.entries(headers)) {
					if (name.toLowerCase() === "originator" && value === CODEX_FAST_MODE_ORIGINATOR) delete headers[name];
				}
			}
			markCodexFastModeRequest(headers, priority);
			updateCodexWebSocketRoutingState(model, routedModel, options, priority, closeWebSocketSessions);
			return finalPayload;
		},
	} as TOptions;
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
		if (options?.transport !== "sse" && usesChatGptCodexTransport(model)) {
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

export function withCodexFastModePayload(
	payload: unknown,
	enabled: boolean,
	model?: Pick<Model<Api>, "id" | "provider">,
): unknown {
	if (!enabled || !isObjectPayload(payload)) return payload;
	if (model?.provider === "github-copilot") {
		return payload.model === model.id ? { ...payload, model: `${model.id}-fast` } : payload;
	}
	if (payload.service_tier !== undefined) return payload;

	return {
		...payload,
		service_tier: CODEX_FAST_MODE_SERVICE_TIER,
	};
}

export function formatCodexFastModeModelLabel(modelName: string, enabled: boolean): string {
	return enabled ? `${modelName} fast` : modelName;
}
