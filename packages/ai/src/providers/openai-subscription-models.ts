import type { Api, Model, ModelCost } from "../types.js";

// Context windows Codex serves on a ChatGPT subscription where they exceed the API's 272K default. Only GPT-6.1 Sol
// also drops the long-context fee there.
const SUBSCRIPTION_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
	"gpt-6.1-sol": 500_000,
	"gpt-6.2-sol": 500_000,
};
const NO_LONG_CONTEXT_FEE_MODEL_IDS: ReadonlySet<string> = new Set(["gpt-6.1-sol"]);

function withoutLongContextPricing(cost: ModelCost): ModelCost {
	const { tiers: _tiers, ...flat } = cost;
	return flat;
}

export function openaiSubscriptionModels<TApi extends Api>(models: readonly Model<TApi>[]): readonly Model<TApi>[] {
	return models.map((model) => {
		const baseModelId = model.fastRoute?.baseModelId ?? model.id;
		const contextWindow = SUBSCRIPTION_CONTEXT_WINDOWS[baseModelId];
		if (contextWindow === undefined) return model;
		if (!NO_LONG_CONTEXT_FEE_MODEL_IDS.has(baseModelId)) return { ...model, contextWindow };
		return {
			...model,
			contextWindow,
			cost: withoutLongContextPricing(model.cost),
			...(model.serviceTiers === undefined
				? {}
				: { serviceTiers: model.serviceTiers.map((tier) => ({ ...tier, cost: withoutLongContextPricing(tier.cost) })) }),
		};
	});
}
