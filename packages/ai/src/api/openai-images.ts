import OpenAI, {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
	toFile,
	type Uploadable,
} from "openai";
import type { ImageEditParamsNonStreaming, ImageGenerateParamsNonStreaming, ImagesResponse } from "openai/resources";
import {
	findImageGenerationError,
	ImageGenerationApiError,
	type ImageGenerationError,
	ImageGenerationQuotaError,
	ImageGenerationRateLimitError,
	ImageGenerationServerError,
	ImageGenerationTimeoutError,
	ImageGenerationUserError,
	ImageModerationBlockedError,
} from "../image-generation-error.ts";
import { calculateCost } from "../models.ts";
import type {
	AssistantImages,
	ImageApi,
	ImageContent,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ProviderHeaders,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
	type OpenAIImagesOptions,
	type OpenAIImagesWireParams,
	partitionInputImages,
	validateOpenAIImagesRequest,
} from "./openai-images-options.ts";

export type { OpenAIImagesOptions, OpenAIImagesOutputFormat, OpenAIImagesSvgOptions } from "./openai-images-options.ts";

const OUTPUT_FORMAT_MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	svg: "image/svg+xml",
};

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/** Request options and the API fields they are sent as. */
const OPTION_WIRE_FIELDS = [
	["size", "size"],
	["quality", "quality"],
	["n", "n"],
	["background", "background"],
	["outputFormat", "output_format"],
	["svg", "svg"],
	["outputCompression", "output_compression"],
	["frameCount", "frame_count"],
	["frameDurationMs", "frame_duration_ms"],
	["complexity", "complexity"],
	["moderation", "moderation"],
	["safetyIdentifier", "safety_identifier"],
] as const satisfies readonly (readonly [keyof OpenAIImagesOptions, keyof OpenAIImagesWireParams])[];

/**
 * Image generation over OpenAI's Images API: `/images/generations` for text-only
 * input and `/images/edits` when the context includes image blocks.
 */
export const generateImages: ImagesFunction<OpenAIImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: OpenAIImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const startedAt = Date.now();

	try {
		if (!options?.apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		const client = createClient(model, options.apiKey, options.headers, options.fetch);
		let params = await buildParams(model, context, options);
		validateOpenAIImagesRequest(model, params);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) params = nextParams as OpenAIImagesWireParams;
		validateOpenAIImagesRequest(model, params);
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: 0,
		};
		const { data: response, response: rawResponse } = await retryProviderRequest(
			() =>
				params.image !== undefined
					? client.images.edit(params as ImageEditParamsNonStreaming, requestOptions).withResponse()
					: client.images.generate(params as ImageGenerateParamsNonStreaming, requestOptions).withResponse(),
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
				noRetry: (error) => classifyImageApiError(error)?.retryable === false,
			},
		);
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);

		if (response.usage) {
			output.usage = parseUsage(response.usage, model);
		}
		const mimeType = OUTPUT_FORMAT_MIME_TYPES[response.output_format ?? params.output_format ?? "png"] ?? "image/png";
		for (const image of response.data ?? []) {
			if (!image.b64_json) continue;
			output.output.push({ type: "image", mimeType, data: image.b64_json } satisfies ImageContent);
		}

		return output;
	} catch (error) {
		const aborted = options?.signal?.aborted === true;
		output.stopReason = aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		if (!aborted) {
			const typed =
				findImageGenerationError(error) ??
				classifyImageApiError(error, { timeoutMs: options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, startedAt });
			if (typed) output.error = typed.toData();
		}
		return output;
	}
};

interface ImageErrorTiming {
	timeoutMs: number;
	startedAt: number;
}

/** Provider types, codes, request IDs and moderation categories are short identifiers. */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/;

function safeToken(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
}

/**
 * The provider's error message can quote the prompt, so typed errors carry only the HTTP status and
 * identifier-shaped fields, and a cause rebuilt from them instead of the SDK error.
 */
function safeSummary(status: number | undefined, apiType?: string, apiCode?: string, requestId?: string): string {
	return [
		status === undefined ? "no HTTP response" : `HTTP ${status}`,
		...(apiType ? [`type ${apiType}`] : []),
		...(apiCode ? [`code ${apiCode}`] : []),
		...(requestId ? [`request ${requestId}`] : []),
	].join(", ");
}

function safeCause(sdkError: APIError, summary: string): Error {
	const cause = new Error(summary);
	cause.name =
		sdkError instanceof APIConnectionTimeoutError
			? "APIConnectionTimeoutError"
			: sdkError instanceof APIConnectionError
				? "APIConnectionError"
				: "APIError";
	return cause;
}

/** Translate an OpenAI SDK failure, also when wrapped in a retry-delay error, into the typed family. */
function classifyImageApiError(error: unknown, timing?: ImageErrorTiming): ImageGenerationError | undefined {
	const cause = error instanceof Error ? error.cause : undefined;
	const sdkError = [error, cause].find((candidate): candidate is APIError => candidate instanceof APIError);
	if (!sdkError || sdkError instanceof APIUserAbortError) return undefined;
	if (sdkError instanceof APIConnectionTimeoutError) {
		const timeoutMs = timing?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		return new ImageGenerationTimeoutError({
			timeoutMs,
			elapsedMs: timing ? Date.now() - timing.startedAt : timeoutMs,
			cause: safeCause(sdkError, "no HTTP response, the request timed out"),
		});
	}

	const status = sdkError.status;
	const apiType = safeToken(sdkError.type);
	const apiCode = safeToken(sdkError.code);
	const requestId = safeToken(sdkError.requestID);
	const detail = safeSummary(status, apiType, apiCode, requestId);
	const init = { detail, status, apiCode, apiType, requestId, cause: safeCause(sdkError, detail) };
	if (apiType === "image_generation_user_error") {
		if (apiCode === "moderation_blocked") {
			const details = (sdkError.error as ImageApiErrorBody).moderation_details;
			const stage = details?.moderation_stage;
			return new ImageModerationBlockedError({
				...init,
				moderationStage: stage === "input" || stage === "output" || stage === "unknown" ? stage : undefined,
				categories: Array.isArray(details?.categories)
					? details.categories.filter((category): category is string => safeToken(category) !== undefined)
					: [],
			});
		}
		return new ImageGenerationUserError(init);
	}
	if (apiCode === "insufficient_quota" || apiType === "insufficient_quota") {
		return new ImageGenerationQuotaError(init);
	}
	if (status === 429) return new ImageGenerationRateLimitError(init);
	if ((status ?? 0) >= 500) return new ImageGenerationServerError(init);
	return new ImageGenerationApiError({ ...init, retryable: status === undefined || status === 408 || status === 409 });
}

interface ImageApiErrorBody {
	moderation_details?: { moderation_stage?: string; categories?: unknown[] };
}

function createClient(
	model: ImageModel<ImageApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
): OpenAI {
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: providerHeadersToRecord({ ...model.headers, ...optionsHeaders }),
	});
}

async function buildParams(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options: OpenAIImagesOptions,
): Promise<OpenAIImagesWireParams> {
	const prompt = context.input
		.flatMap((item) => (item.type === "text" ? [sanitizeSurrogates(item.text)] : []))
		.join("\n\n");
	const params: OpenAIImagesWireParams = {
		model: model.id,
		prompt,
		...Object.fromEntries(
			OPTION_WIRE_FIELDS.flatMap(([option, field]) =>
				options[option] === undefined ? [] : [[field, options[option]]],
			),
		),
	};

	const { images, markup, mask } = partitionInputImages(model, context.input);
	if (images.length === 0) return params;
	return {
		...params,
		image: await Promise.all(images.map((image, index) => toUpload(image, `image-${index + 1}`))),
		...(markup ? { markup: await toUpload(markup, "markup") } : {}),
		...(mask ? { mask: await toUpload(mask, "mask") } : {}),
	};
}

function toUpload(image: ImageContent, name: string): Promise<Uploadable> {
	return toFile(base64ToBytes(image.data), `${name}.${image.mimeType.split("/")[1] ?? "png"}`, {
		type: image.mimeType,
	});
}

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

function parseUsage(rawUsage: ImagesResponse.Usage, model: ImageModel<ImageApi>): Usage {
	const input = rawUsage.input_tokens || 0;
	const output = rawUsage.output_tokens || 0;
	const usage: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: rawUsage.total_tokens || input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}
