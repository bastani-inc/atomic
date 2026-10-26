import type { Api, Model, ModelCost } from "../types.js";

// ChatGPT subscriptions serve these models with a 500k context. Only GPT-6.1 Sol also drops the long-context fee.
const SUBSCRIPTION_500K_CONTEXT_MODEL_IDS = new Set(["gpt-6.1-sol", "gpt-6.1-terra"]);
const SUBSCRIPTION_NO_LONG_CONTEXT_FEE_MODEL_IDS = new Set(["gpt-6.1-sol"]);

function withoutLongContextPricing(cost: ModelCost): ModelCost {
	const { tiers: _tiers, ...flat } = cost;
	return flat;
}

export function openaiSubscriptionModels<TApi extends Api>(models: readonly Model<TApi>[]): readonly Model<TApi>[] {
	return models.map((model) => {
		const baseModelId = model.fastRoute?.baseModelId ?? model.id;
		if (!SUBSCRIPTION_500K_CONTEXT_MODEL_IDS.has(baseModelId)) return model;
		if (!SUBSCRIPTION_NO_LONG_CONTEXT_FEE_MODEL_IDS.has(baseModelId)) return { ...model, contextWindow: 500_000 };
		return {
			...model,
			contextWindow: 500_000,
			cost: withoutLongContextPricing(model.cost),
			...(model.serviceTiers === undefined
				? {}
				: { serviceTiers: model.serviceTiers.map((tier) => ({ ...tier, cost: withoutLongContextPricing(tier.cost) })) }),
		};
	});
}
