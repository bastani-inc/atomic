import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { createStreamDeadline, withStreamDeadline } from "../utils/stream-deadline.ts";
import { getDeclaredTools, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	preserveCopilotIntegrationHeader,
} from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	appendServiceTierRejectedWarning,
	applyServiceTierPricing,
	assertPayloadPreservesFastRoute,
	convertResponsesMessages,
	convertResponsesTools,
	isChatGPTSubscriptionToken,
	isServiceTierRejection,
	openAIServiceTierForRequest,
	processResponsesStream,
	type ResponsesServiceTier,
	resolveChatGPTBackendServiceTier,
	resolveRequestedServiceTier,
} from "./openai-responses-shared.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-api", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

function isChatGPTSignIn(model: Model<"openai-responses">, apiKey: string | undefined): boolean {
	return (
		model.provider === "openai" &&
		model.baseUrl === "https://api.openai.com/v1" &&
		apiKey !== undefined &&
		!apiKey.startsWith("sk-")
	);
}

function headerValue(headers: ProviderHeaders | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	return headerValue(headers, name) !== undefined;
}

function bearerToken(apiKey: string | undefined, headers: ProviderHeaders | undefined): string | undefined {
	return apiKey ?? headerValue(headers, "authorization")?.replace(/^Bearer\s+/i, "");
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
	};
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

function getPromptCacheOptions(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): ResponseCreateParamsStreaming["prompt_cache_options"] {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
	return undefined;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponsesServiceTier;
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	// Start async processing
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		const streamDeadline = createStreamDeadline(options?.streamDeadlineMs, options?.signal);

		try {
			// Create OpenAI client
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const chatGPTBackend = isChatGPTSubscriptionToken(bearerToken(options?.apiKey, options?.headers));
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				options?.fetch,
				cacheSessionId,
				options?.apiKey,
			);
			let params = buildParams(model, normalizedContext, options, compat, grammarToolInputProperties);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			assertPayloadPreservesFastRoute(model, params);
			const requestOptions = {
				...(streamDeadline.signal ? { signal: streamDeadline.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const sendRequest = (requestParams: ResponseCreateParamsStreaming) =>
				retryProviderRequest(() => client.responses.create(requestParams, requestOptions).withResponse(), {
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: streamDeadline.signal,
				});
			let startEmitted = false;
			// Every attempt reports its HTTP response before its body is consumed, and the message stream starts
			// once. A streamed request reports a rejected service_tier as an `error` event after HTTP 200, so the
			// response preamble is read before the request counts as accepted.
			const openStream = async (requestParams: ResponseCreateParamsStreaming) => {
				const { data, response } = await sendRequest(requestParams);
				await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
				if (!startEmitted) {
					startEmitted = true;
					stream.push({ type: "start", partial: output });
				}
				return readResponsePreamble(withStreamDeadline(data, streamDeadline.deadlineMs, streamDeadline.abort));
			};
			let requestedServiceTier = resolveOpenAIRequestServiceTier(model, options?.serviceTier);
			let openaiStream: Awaited<ReturnType<typeof openStream>>;
			try {
				openaiStream = await openStream(params);
			} catch (error) {
				if (params.service_tier == null || !isServiceTierRejection(error)) throw error;
				const rejectedServiceTier = params.service_tier;
				const { service_tier: _rejectedServiceTier, ...defaultTierParams } = params;
				openaiStream = await openStream(defaultTierParams);
				requestedServiceTier = undefined;
				appendServiceTierRejectedWarning(output, model, rejectedServiceTier);
			}

			await processResponsesStream(openaiStream, output, stream, model, {
				onProviderStreamEvent: options?.onProviderStreamEvent,
				serviceTier: requestedServiceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
				...(chatGPTBackend
					? { resolveServiceTier: resolveChatGPTBackendServiceTier }
					: { warnOnServiceTierDowngrade: true }),
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const errorMessage = formatProviderError(
				normalizeProviderError(error),
				`${model.provider === "openai" || model.provider === "openai-api" ? "OpenAI" : model.provider} API error`,
			);
			output.errorMessage = errorMessage.includes("subscription_sharing_usage_limit_exceeded")
				? `${errorMessage}\nCheck your ChatGPT usage: ${CHATGPT_USAGE_URL}`
				: errorMessage;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			streamDeadline.cleanup();
		}
	})();

	return stream;
};

const RESPONSE_PREAMBLE_EVENT_TYPES = new Set(["response.created", "response.in_progress", "response.queued"]);

function failedResponseTierRejection(event: { type: string } | undefined): Error | undefined {
	if (event?.type !== "response.failed") return undefined;
	const failure = (event as { response?: { error?: { code?: string | null; message?: string } | null } }).response
		?.error;
	if (!failure?.message) return undefined;
	const error = new Error(failure.message);
	return isServiceTierRejection(error) ? error : undefined;
}

/**
 * Read a stream up to its first event after the response preamble, so an error the server raises
 * before producing output is thrown here. Returns a stream that replays every event read.
 */
async function readResponsePreamble<T extends { type: string }>(events: AsyncIterable<T>): Promise<AsyncIterable<T>> {
	const iterator = events[Symbol.asyncIterator]();
	const preamble: T[] = [];
	let done = false;
	try {
		for (;;) {
			const next = await iterator.next();
			if (next.done) {
				done = true;
				break;
			}
			preamble.push(next.value);
			if (!RESPONSE_PREAMBLE_EVENT_TYPES.has(next.value.type)) break;
		}
	} catch (error) {
		await iterator.return?.();
		throw error;
	}
	const tierRejection = failedResponseTierRejection(preamble.at(-1));
	if (tierRejection) {
		await iterator.return?.();
		throw tierRejection;
	}
	return (async function* () {
		try {
			yield* preamble;
			if (done) return;
			for (;;) {
				const next = await iterator.next();
				if (next.done) return;
				yield next.value;
			}
		} finally {
			await iterator.return?.();
		}
	})();
}

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
	copilotApiKey?: string,
) {
	const compat = getCompat(model);
	const headers: ProviderHeaders = { "User-Agent": getPiUserAgent(), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = preserveCopilotIntegrationHeader(
			model.headers,
			buildCopilotDynamicHeaders({
				messages: context.messages,
				hasImages,
				apiKey: copilotApiKey,
			}),
		);
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

function buildParams(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat> = getCompat(model),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		compat.supportsOpenAIGrammarTools,
	),
) {
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		compat.supportsAdditionalTools || compat.supportsToolSearch,
	);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
	const params: ResponseCreateParamsStreaming = {
		// A fast variant keeps its canonical `-fast` id on the model object — that is the identity the
		// caller selected and records — while routing to the base upstream model plus a service tier.
		model: model.fastRoute?.upstreamModelId ?? model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: omitUnsupportedFields ? undefined : getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: omitUnsupportedFields ? undefined : getPromptCacheOptions(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens && compat.supportsMaxOutputTokens && !omitUnsupportedFields) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined && !omitUnsupportedFields) {
		params.temperature = options?.temperature;
	}

	const requestedServiceTier = resolveOpenAIRequestServiceTier(model, options?.serviceTier);
	if (requestedServiceTier !== undefined) {
		params.service_tier = requestedServiceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	if (model.reasoning) {
		if (reasoningEffort) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: reasoningEffort;
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}

	// Last so model and request sampling parameters override named request fields.
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}

function resolveOpenAIRequestServiceTier(
	model: Model<"openai-responses">,
	optionsServiceTier: ResponsesServiceTier | undefined,
): ResponsesServiceTier | undefined {
	return openAIServiceTierForRequest(model, resolveRequestedServiceTier(model, optionsServiceTier));
}
