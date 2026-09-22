import { DECISION_MODELS } from "./decision-models.generated.ts";
import type { ModelCostRates } from "./types.ts";

/**
 * A System One decision model as models.dev lists it under a provider. Decision models
 * answer typed questions about a state instead of generating text, so they are never
 * chat `Model` entries and never enter the chat catalog. Callers pair a row with their
 * own transport; models.dev records only identity, limits, and pricing.
 */
export interface DecisionModel {
	/** models.dev provider key, for example `opencode` or `vercel`. */
	readonly provider: string;
	/** Model ID as the provider accepts it on the wire. */
	readonly id: string;
	readonly name: string;
	/** Largest request the provider accepts, in tokens. */
	readonly contextWindow: number;
	/** Nonzero `cacheWrite` is unpublished for decision models and always 0. */
	readonly cost: ModelCostRates;
}

export function getDecisionModels(): readonly DecisionModel[] {
	return DECISION_MODELS;
}

export function getDecisionModel(provider: string, id: string): DecisionModel | undefined {
	return DECISION_MODELS.find((model) => model.provider === provider && model.id === id);
}
