import {
	type Api,
	getModels,
	getProviders,
	type BuiltinProvider,
	type Model,
	type OpenAICompletionsCompat,
} from "@earendil-works/pi-ai/compat";
import { normalizeGrammarToolCapability } from "./model-capabilities.ts";
import type { ModelOverride } from "./model-registry-schemas.ts";
import type { ProviderCompat, ProviderOverride } from "./model-registry-types.ts";


export function mergeCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: ModelOverride["compat"] | Model<Api>["compat"],
): Model<Api>["compat"] | undefined {
	if (!overrideCompat) return normalizeGrammarToolCapability(baseCompat);

	const base = baseCompat as ProviderCompat | undefined;
	const override = overrideCompat as ProviderCompat;
	const merged = { ...base, ...override } as ProviderCompat;

	const baseCompletions = base as OpenAICompletionsCompat | undefined;
	const overrideCompletions = override as OpenAICompletionsCompat;
	const mergedCompletions = merged as OpenAICompletionsCompat;

	if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
		mergedCompletions.openRouterRouting = {
			...baseCompletions?.openRouterRouting,
			...overrideCompletions.openRouterRouting,
		};
	}

	if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
		mergedCompletions.vercelGatewayRouting = {
			...baseCompletions?.vercelGatewayRouting,
			...overrideCompletions.vercelGatewayRouting,
		};
	}

	if (baseCompletions?.chatTemplateKwargs || overrideCompletions.chatTemplateKwargs) {
		mergedCompletions.chatTemplateKwargs = {
			...baseCompletions?.chatTemplateKwargs,
			...overrideCompletions.chatTemplateKwargs,
		};
	}

	return normalizeGrammarToolCapability(merged);
}

export function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };

	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.thinkingLevelMap !== undefined) {
		result.thinkingLevelMap = { ...model.thinkingLevelMap, ...override.thinkingLevelMap };
	}
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;

	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
			...(override.cost.tiers !== undefined
				? { tiers: override.cost.tiers }
				: model.cost.tiers !== undefined
					? { tiers: model.cost.tiers }
					: {}),
		};
	}

	result.compat = mergeCompat(model.compat, override.compat);
	return result;
}

export function loadBuiltInModels(
	overrides: Map<string, ProviderOverride>,
	modelOverrides: Map<string, Map<string, ModelOverride>>,
	baseModels?: readonly Model<Api>[],
): Model<Api>[] {
	const providers = baseModels
		? [...new Set(baseModels.map((model) => model.provider))]
		: getProviders();
	return providers.flatMap((provider) => {
		const providerModels = baseModels
			? baseModels.filter((model) => model.provider === provider)
			: getModels(provider as BuiltinProvider) as Model<Api>[];
		const models = [...providerModels];
		const providerOverride = overrides.get(provider);
		const perModelOverrides = modelOverrides.get(provider);

		return models.map((candidate) => {
			let model: Model<Api> = {
				...candidate,
				compat: normalizeGrammarToolCapability(candidate.compat),
			};
			if (providerOverride) {
				model = {
					...model,
					baseUrl: providerOverride.baseUrl ?? model.baseUrl,
					compat: mergeCompat(model.compat, providerOverride.compat),
				};
			}
			const modelOverride = perModelOverrides?.get(candidate.id);
			return modelOverride ? applyModelOverride(model, modelOverride) : model;
		});
	});
}

export function mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
	const merged = [...builtInModels];
	for (const customModel of customModels) {
		const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
		if (existingIndex >= 0) {
			merged[existingIndex] = customModel;
		} else {
			merged.push(customModel);
		}
	}
	return merged;
}
