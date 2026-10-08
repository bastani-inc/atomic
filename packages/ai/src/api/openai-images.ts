import OpenAI, { toFile } from "openai";
import type { ImageEditParamsNonStreaming, ImageGenerateParamsNonStreaming, ImagesResponse } from "openai/resources";
import { calculateCost } from "../models.ts";
import type {
	AssistantImages,
	ImageApi,
	ImageContent,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
	ProviderHeaders,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

/** Request options for OpenAI's Images API. Each field is sent only when set. */
export interface OpenAIImagesOptions extends ImagesOptions {
	/** `auto`, a listed size, or a custom `WIDTHxHEIGHT` where the model supports one. */
	size?: "auto" | "1024x1024" | "1536x1024" | "1024x1536" | (string & {});
	quality?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
	/** Number of images to generate. */
	n?: number;
	/** `transparent` needs a PNG or WebP output format. */
	background?: "transparent" | "opaque" | "auto";
}

type OpenAIImagesRequestParams = ImageGenerateParamsNonStreaming | ImageEditParamsNonStreaming;

const OUTPUT_FORMAT_MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

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

	try {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		const client = createClient(model, apiKey, options?.headers, options?.fetch);
		let params = await buildParams(model, context, options);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			params = nextParams as OpenAIImagesRequestParams;
		}
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: 0,
		};
		const { data: response, response: rawResponse } = await retryProviderRequest(
			() =>
				"image" in params
					? client.images.edit(params, requestOptions).withResponse()
					: client.images.generate(params, requestOptions).withResponse(),
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
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
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

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
	options: OpenAIImagesOptions | undefined,
): Promise<OpenAIImagesRequestParams> {
	const prompt = context.input
		.flatMap((item) => (item.type === "text" ? [sanitizeSurrogates(item.text)] : []))
		.join("\n\n");
	const params = {
		model: model.id,
		prompt,
		...(options?.size !== undefined ? { size: options.size } : {}),
		...(options?.quality !== undefined ? { quality: options.quality } : {}),
		...(options?.n !== undefined ? { n: options.n } : {}),
		...(options?.background !== undefined ? { background: options.background } : {}),
	};

	const images = context.input.filter((item): item is ImageContent => item.type === "image");
	if (images.length === 0) return params satisfies ImageGenerateParamsNonStreaming;
	return {
		...params,
		image: await Promise.all(
			images.map((image, index) =>
				toFile(base64ToBytes(image.data), `image-${index + 1}.${image.mimeType.split("/")[1] ?? "png"}`, {
					type: image.mimeType,
				}),
			),
		),
	} satisfies ImageEditParamsNonStreaming;
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
