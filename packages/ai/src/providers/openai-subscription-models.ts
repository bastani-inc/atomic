import type { Api, Model, ModelCost } from "../types.js";

function withoutLongContextPricing(cost: ModelCost): ModelCost {
	const { tiers: _tiers, ...flat } = cost;
	return flat;
}

export function openaiSubscriptionModels<TApi extends Api>(models: readonly Model<TApi>[]): readonly Model<TApi>[] {
	return models.map((model) => {
		if (model.id !== "gpt-6.1-sol" && model.fastRoute?.baseModelId !== "gpt-6.1-sol") return model;
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
