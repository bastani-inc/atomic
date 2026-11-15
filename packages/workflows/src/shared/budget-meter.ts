import { fold_usage } from "../../builtin/verification-usage.js";
import type { RunSnapshot } from "./store-types.js";
import { elapsedRunMs } from "./timing.js";
export type RunMeterCounters = Readonly<Record<"input" | "output" | "cacheRead" | "cacheWrite", number>>;
export type RunMeters = Readonly<{ durationMs: number; tokens: number; cost: number; perCounter: RunMeterCounters }>;
/** A run and its nested child scopes, used by the tree-wide usage meter. */
export type RunUsageTree =
	| { readonly run: RunSnapshot; readonly children?: readonly RunUsageTree[] }
	| (RunSnapshot & { readonly children?: readonly RunUsageTree[] });
export type UsageCounters = RunMeterCounters & { readonly cost: number };
const usageFields = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
const addUsage = (left: UsageCounters, right: UsageCounters): UsageCounters =>
	Object.fromEntries(usageFields.map((field) => [field, left[field] + right[field]])) as unknown as UsageCounters;
function foldTreeUsage(tree: RunUsageTree): UsageCounters {
	const run = "run" in tree ? tree.run : tree;
	const folded = fold_usage(
		run.stages
			.filter((stage) => stage.replayed !== true)
			.map((stage) => ({ stageName: stage.name, text: stage.result ?? "", modelAttempts: stage.modelAttempts })),
	);
	return (tree.children ?? []).reduce<UsageCounters>((total, child) => addUsage(total, foldTreeUsage(child)), folded);
}
/**
 * Usage of every non-replayed stage in a run tree, keyed by run and stage id.
 * Budget accounting charges each stage's growth, so replay never hides new spend.
 */
export function meter_stages(tree: RunUsageTree): ReadonlyMap<string, UsageCounters> {
	const stages = new Map<string, UsageCounters>();
	const visit = (node: RunUsageTree): void => {
		const run = "run" in node ? node.run : node;
		for (const stage of run.stages)
			if (stage.replayed !== true)
				stages.set(
					`${run.id}\u0000${stage.id}`,
					fold_usage([{ stageName: stage.name, text: stage.result ?? "", modelAttempts: stage.modelAttempts }]),
				);
		for (const child of node.children ?? []) visit(child);
	};
	visit(tree);
	return stages;
}
/** Measure one run scope without mutating it or charging a budget. */
export function meter_run(tree: RunUsageTree, now: number): RunMeters {
	const usage = foldTreeUsage(tree);
	return {
		durationMs: elapsedRunMs("run" in tree ? tree.run : tree, now),
		tokens: usage.input + usage.output,
		cost: usage.cost,
		perCounter: Object.fromEntries(
			usageFields.filter((field) => field !== "cost").map((field) => [field, usage[field]]),
		) as RunMeterCounters,
	};
}
