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
/**
 * Usage of every stage a running run replays, keyed by run and replay key. A replayed stage's spend was charged by the
 * execution that ran it, as far as that execution's accounting recorded it (#5053). A run that ended, such as a
 * completed child a resume replays whole, recorded all of its charges when it ended, so it is left out.
 */
export function meter_replayed_stages(tree: RunUsageTree): ReadonlyMap<string, UsageCounters> {
	const stages = new Map<string, UsageCounters>();
	const visit = (node: RunUsageTree): void => {
		const run = "run" in node ? node.run : node;
		for (const stage of run.status === "running" ? run.stages : [])
			if (stage.replayed === true && stage.replayKey !== undefined)
				stages.set(
					`${run.id}\u0000${stage.replayKey}`,
					fold_usage([{ stageName: stage.name, text: stage.result ?? "", modelAttempts: stage.modelAttempts }]),
				);
		for (const child of node.children ?? []) visit(child);
	};
	visit(tree);
	return stages;
}
/** Run and replay key of every non-replayed stage in a run tree, by the key `meter_stages` reports it under. */
export function stage_replay_keys(tree: RunUsageTree): ReadonlyMap<string, string> {
	const keys = new Map<string, string>();
	const visit = (node: RunUsageTree): void => {
		const run = "run" in node ? node.run : node;
		for (const stage of run.stages)
			if (stage.replayed !== true && stage.replayKey !== undefined)
				keys.set(`${run.id}\u0000${stage.id}`, `${run.id}\u0000${stage.replayKey}`);
		for (const child of node.children ?? []) visit(child);
	};
	visit(tree);
	return keys;
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
