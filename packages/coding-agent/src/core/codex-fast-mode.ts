import {
	clampThinkingLevel,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type OpenAICodexResponsesOptions,
	streamOpenAICodexResponses,
	streamOpenAIResponses,
	streamSimple,
	type OpenAIResponsesOptions,
	type SimpleStreamOptions,
	type StreamOptions,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
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
	streamSimple: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
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

export function withCodexFastModeStreamOptions(
	options: SimpleStreamOptions | undefined,
	enabled: boolean,
): CodexFastModeStreamOptions | undefined {
	if (!enabled) {
		return options;
	}

	return {
		...(options ?? {}),
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
	options: CodexFastModeStreamOptions | undefined,
): StreamOptions {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens,
		signal: options?.signal,
		apiKey: options?.apiKey,
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
		...buildCodexFastModeBaseProviderOptions(options),
		reasoningEffort: mapCodexFastModeReasoningEffort(model, options?.reasoning),
		serviceTier: options?.serviceTier,
	};
}

export function buildOpenAICodexResponsesCodexFastModeOptions(
	model: Model<Api>,
	options: CodexFastModeStreamOptions | undefined,
): OpenAICodexResponsesOptions {
	return {
		...buildCodexFastModeBaseProviderOptions(options),
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
