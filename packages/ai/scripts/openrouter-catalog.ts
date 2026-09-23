import type { ImageModel, Model, ModelCost } from "../src/types.ts";
import { getOpenRouterThinkingLevelMap, type OpenRouterReasoningMetadata } from "./openrouter-reasoning-options.ts";

export interface OpenRouterModelListItem {
	id: string;
	name: string;
	supported_parameters?: string[];
	architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
		overrides?: Array<{
			min_prompt_tokens?: number;
			prompt?: string;
			completion?: string;
			input_cache_read?: string;
			input_cache_write?: string;
		}>;
	};
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
	context_length?: number;
	reasoning?: OpenRouterReasoningMetadata;
}

export interface OpenRouterCatalog {
	chat: Model<"anthropic-messages" | "openai-completions">[];
	images: ImageModel<"openrouter-images">[];
}

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

function modalities(values: string[] | undefined): ("text" | "image")[] {
	return Array.from(
		new Set((values ?? []).filter((value): value is "text" | "image" => value === "text" || value === "image")),
	);
}

function cost(model: OpenRouterModelListItem): ModelCost {
	// OpenRouter overrides apply to the entire request once its input threshold is crossed.
	const rates = model.pricing;
	const toPrice = (value: string | undefined): number => roundCost(parseFloat(value || "0") * 1_000_000);
	const tiers = rates?.overrides?.flatMap((override) =>
		override.min_prompt_tokens === undefined
			? []
			: [{
				inputTokensAbove: override.min_prompt_tokens,
				input: toPrice(override.prompt ?? rates.prompt),
				output: toPrice(override.completion ?? rates.completion),
				cacheRead: toPrice(override.input_cache_read ?? rates.input_cache_read),
				cacheWrite: toPrice(override.input_cache_write ?? rates.input_cache_write),
			}],
	);
	return {
		input: toPrice(rates?.prompt),
		output: toPrice(rates?.completion),
		cacheRead: toPrice(rates?.input_cache_read),
		cacheWrite: toPrice(rates?.input_cache_write),
		...(tiers?.length ? { tiers } : {}),
	};
}

/**
 * Build the OpenRouter catalog from the default listing and the
 * `output_modalities=image` listing. The default listing omits image-only
 * models, so image models come from the second one. An upstream model may
 * appear in both results; it then gets separate chat and image entries.
 */
export function buildOpenRouterCatalog(
	listed: readonly OpenRouterModelListItem[],
	imageListed: readonly OpenRouterModelListItem[],
): OpenRouterCatalog {
	const chat: OpenRouterCatalog["chat"] = [];

	for (const model of listed) {
		// Only include models that support tools
		if (!model.supported_parameters?.includes("tools")) continue;
		// Parse input modalities
		const input: ("text" | "image")[] = ["text"];
		if (model.architecture?.modality?.includes("image")) {
			input.push("image");
		}

		const thinkingLevelMap = getOpenRouterThinkingLevelMap(model.reasoning);
		const useAnthropicMessages = /^anthropic\//.test(model.id) && !model.id.endsWith(":batch");
		chat.push({
			type: "chat",
			id: model.id,
			name: model.name,
			api: useAnthropicMessages ? "anthropic-messages" : "openai-completions",
			baseUrl: useAnthropicMessages ? "https://openrouter.ai/api" : "https://openrouter.ai/api/v1",
			provider: "openrouter",
			reasoning: model.supported_parameters?.includes("reasoning") || false,
			...(thinkingLevelMap && { thinkingLevelMap }),
			input,
			cost: cost(model),
			contextWindow: model.top_provider?.context_length || model.context_length || 4096,
			maxTokens: model.top_provider?.max_completion_tokens || 4096,
		});
	}

	const images: OpenRouterCatalog["images"] = [];
	for (const model of imageListed) {
		if (images.some((entry) => entry.id === model.id)) continue;
		const output = modalities(model.architecture?.output_modalities);
		if (!output.includes("image")) continue;
		const input = modalities(model.architecture?.input_modalities);
		images.push({
			type: "image",
			id: model.id,
			name: model.name,
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: input.length > 0 ? input : ["text"],
			output,
			cost: cost(model),
		});
	}

	return { chat, images };
}
