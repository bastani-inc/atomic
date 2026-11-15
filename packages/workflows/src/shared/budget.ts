/** Pure workflow run-budget declarations and resolution. */

export type BudgetDimension = "duration" | "tokens" | "cost";
export interface BudgetReport {
	readonly dimension: BudgetDimension;
	readonly reading: number;
	readonly ceiling: number;
	readonly percent: number;
}
export type DurationBudgetReport = BudgetReport & { readonly dimension: "duration" };
export type UsageBudgetReport = BudgetReport & { readonly dimension: "tokens" | "cost" };
export interface WorkflowBudget {
	readonly maxDurationMs?: number;
	readonly maxTokens?: number;
	readonly maxCost?: number;
	readonly warnAtPercent?: number;
}

/** Exact threshold test: floating `reading / ceiling * 100` can round below `warnAtPercent` at the threshold. */
function reachesWarnThreshold(reading: number, ceiling: number, warnAtPercent: number): boolean {
	return ceiling > 0 && warnAtPercent > 0 && reading * 100 >= warnAtPercent * ceiling;
}

export type DurationBudgetCheck =
	| { readonly kind: "continue"; readonly report: DurationBudgetReport; readonly warning: boolean }
	| { readonly kind: "exhausted"; readonly report: DurationBudgetReport };
export function enforceDurationBudget(
	reading: number,
	budget: EffectiveBudget,
	options: { readonly warned?: boolean } = {},
): DurationBudgetCheck {
	const ceiling = budget.maxDurationMs;
	const report: DurationBudgetReport = {
		dimension: "duration",
		reading,
		ceiling,
		percent: ceiling === 0 ? 0 : (reading / ceiling) * 100,
	};
	if (ceiling > 0 && reading >= ceiling) return { kind: "exhausted", report };
	const warning = options.warned !== true && reachesWarnThreshold(reading, ceiling, budget.warnAtPercent);
	return { kind: "continue", report, warning };
}
export type UsageBudgetCheck =
	| { readonly kind: "continue"; readonly report: UsageBudgetReport; readonly warning: boolean }
	| { readonly kind: "exhausted"; readonly report: UsageBudgetReport };
export function enforceUsageBudget(
	dimension: "tokens" | "cost",
	reading: number,
	ceiling: number,
	warnAtPercent: number,
	options: { readonly warned?: boolean } = {},
): UsageBudgetCheck {
	const report: UsageBudgetReport = { dimension, reading, ceiling, percent: ceiling ? (reading / ceiling) * 100 : 0 };
	if (ceiling > 0 && reading >= ceiling) return { kind: "exhausted", report };
	const warning = options.warned !== true && reachesWarnThreshold(reading, ceiling, warnAtPercent);
	return { kind: "continue", report, warning };
}
/** A fully resolved budget. Create one only with {@link resolve_budget}. */
class ResolvedWorkflowBudget {
	private declare readonly brand: undefined;
	readonly maxDurationMs: number;
	readonly maxTokens: number;
	readonly maxCost: number;
	readonly warnAtPercent: number;

	private constructor(maxDurationMs: number, maxTokens: number, maxCost: number, warnAtPercent: number) {
		this.maxDurationMs = maxDurationMs;
		this.maxTokens = maxTokens;
		this.maxCost = maxCost;
		this.warnAtPercent = warnAtPercent;
	}

	static resolve(layers: ResolveBudgetLayers): ResolvedWorkflowBudget {
		assertWorkflowBudget(layers.config, "config budget");
		assertWorkflowBudget(layers.definition, "definition budget");
		assertWorkflowBudget(layers.run, "run budget");

		return new ResolvedWorkflowBudget(
			layers.run?.maxDurationMs ?? layers.definition?.maxDurationMs ?? layers.config?.maxDurationMs ?? 0,
			layers.run?.maxTokens ?? layers.definition?.maxTokens ?? layers.config?.maxTokens ?? 0,
			layers.run?.maxCost ?? layers.definition?.maxCost ?? layers.config?.maxCost ?? 0,
			layers.run?.warnAtPercent ?? layers.definition?.warnAtPercent ?? layers.config?.warnAtPercent ?? 80,
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

/** Return a reason when a budget declaration is invalid. */
export function validateWorkflowBudget(value: unknown, label = "budget"): string | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return `"${label}" must be a JSON object, got ${JSON.stringify(typeof value)}`;
	}

	const budget = value as Record<string, unknown>;
	for (const field of ["maxDurationMs", "maxTokens"] as const) {
		const limit = budget[field];
		if (
			field in budget &&
			(typeof limit !== "number" || !Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0)
		) {
			return `"${label}.${field}" must be a non-negative finite integer, got ${JSON.stringify(limit)}`;
		}
	}
	for (const field of ["maxCost", "warnAtPercent"] as const) {
		const limit = budget[field];
		if (field in budget && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)) {
			return `"${label}.${field}" must be a non-negative finite number, got ${JSON.stringify(limit)}`;
		}
	}
	return null;
}

/** Reject an invalid optional budget declaration. */
export function assertWorkflowBudget(value: WorkflowBudget | undefined, label = "budget"): void {
	if (value === undefined) return;
	const reason = validateWorkflowBudget(value, label);
	if (reason !== null) throw new TypeError(reason);
}

/** Resolve budget declarations, with later layers winning independently per field. */
export function resolve_budget(layers: ResolveBudgetLayers): EffectiveBudget {
	return ResolvedWorkflowBudget.resolve(layers);
}
