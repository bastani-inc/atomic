/** Pure workflow run-budget declarations and resolution. */

/**
 * Optional budget limits for a workflow run. A present `0` disables that
 * dimension; absent fields inherit from the prior layer.
 */
export interface WorkflowBudget {
	readonly maxDurationMs?: number;
	readonly maxTokens?: number;
	readonly maxCost?: number;
	readonly warnAtPercent?: number;
}

/** A fully resolved budget. Create one only with {@link resolve_budget}. */
class ResolvedWorkflowBudget {
	private constructor(
		readonly maxDurationMs: number,
		readonly maxTokens: number,
		readonly maxCost: number,
		readonly warnAtPercent: number,
	) {}

	static resolve(layers: ResolveBudgetLayers): ResolvedWorkflowBudget {
		return new ResolvedWorkflowBudget(
			layers.run?.maxDurationMs ?? layers.definition?.maxDurationMs ?? layers.config?.maxDurationMs ?? 0,
			layers.run?.maxTokens ?? layers.definition?.maxTokens ?? layers.config?.maxTokens ?? 0,
			layers.run?.maxCost ?? layers.definition?.maxCost ?? layers.config?.maxCost ?? 0,
			layers.run?.warnAtPercent ?? layers.definition?.warnAtPercent ?? layers.config?.warnAtPercent ?? 0,
		);
	}
}

/** A validated, fully resolved workflow budget. */
export type EffectiveBudget = ResolvedWorkflowBudget;

/** Budget declarations in precedence order: run > definition > config. */
export interface ResolveBudgetLayers {
	readonly config?: WorkflowBudget;
	readonly definition?: WorkflowBudget;
	readonly run?: WorkflowBudget;
}

/** Resolve budget declarations, with later layers winning independently per field. */
export function resolve_budget(layers: ResolveBudgetLayers): EffectiveBudget {
	return ResolvedWorkflowBudget.resolve(layers);
}
