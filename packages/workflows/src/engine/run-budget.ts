import {
	type BudgetReport,
	costFromUnits,
	costUnits,
	type EffectiveBudget,
	enforceDurationBudget,
	enforceUsageBudget,
} from "../shared/budget.js";
import {
	meter_replayed_stages,
	meter_run,
	meter_stages,
	type RunMeters,
	type RunUsageTree,
	stage_replay_keys,
	type UsageCounters,
} from "../shared/budget-meter.js";
import type {
	RunBudgetAccountingState,
	RunBudgetState,
	RunBudgetUsageBaseline,
	RunSnapshot,
} from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import type { WorkflowModelUsage } from "../shared/types.js";
export const BUDGET_WRAP_UP_PROMPT =
	"The workflow budget is exhausted. Stop substantive work, summarize useful progress, identify remaining work or blockers, and leave a clear next step. Do not start any new stages.";
export interface BudgetExceededReport extends BudgetReport {
	readonly frontierStage: string;
	readonly wrapUpSummary?: string;
	readonly wrapUpUsage?: WorkflowModelUsage;
}
export class WorkflowBudgetExceededError extends Error {
	readonly report: BudgetExceededReport;
	constructor(report: BudgetExceededReport) {
		const unit = report.dimension === "duration" ? "ms" : report.dimension;
		super(
			`atomic-workflows: ${report.dimension} budget exceeded (${report.reading}${unit} / ${report.ceiling}${unit}) at ${report.frontierStage}`,
		);
		this.name = "WorkflowBudgetExceededError";
		this.report = report;
	}
}
export interface BudgetCheckpointContinue {
	readonly kind: "continue";
}
export interface BudgetCheckpointWarning {
	readonly kind: "warn";
	readonly report: BudgetReport;
}
export interface BudgetCheckpointWrapUp {
	readonly kind: "wrap_up";
	readonly report: BudgetReport;
}
export interface BudgetCheckpointExhausted {
	readonly kind: "exhausted";
	readonly report: BudgetExceededReport;
}
export type BudgetCheckpoint =
	| BudgetCheckpointContinue
	| BudgetCheckpointWarning
	| BudgetCheckpointWrapUp
	| BudgetCheckpointExhausted;
export interface RunBudgetController {
	readonly enabled: boolean;
	readonly checkpoint: (frontierStage?: string) => BudgetCheckpoint;
	readonly registerWrapUp: (frontierStage: string, handler: () => Promise<never>) => () => void;
	readonly deliverWrapUp: (frontierStage: string) => Promise<never>;
	readonly finishWrapUp: (
		frontierStage: string | undefined,
		summary?: string,
		usage?: WorkflowModelUsage,
		delivered?: boolean,
	) => WorkflowBudgetExceededError;
	readonly rethrowIfSystemOwnedStop: (frontierStage?: string) => void;
	readonly stopAtBoundary: (frontierStage?: string) => void;
	readonly stopAtBoundaryAsync: (frontierStage?: string) => Promise<void>;
	readonly awaitPendingWrapUp: () => Promise<WorkflowBudgetExceededError | undefined>;
	/** Whether this budget, or its root's, would be exhausted once `pending` usage not yet in the run is charged. */
	readonly exhaustedWith: (pending: WorkflowModelUsage) => boolean;
}
const withFrontier = (
	report: BudgetReport,
	frontierStage: string | undefined,
	summary?: string,
	usage?: WorkflowModelUsage,
): BudgetExceededReport =>
	Object.assign(
		{ ...report, frontierStage: frontierStage ?? "workflow frontier" },
		summary === undefined ? {} : { wrapUpSummary: summary },
		usage === undefined ? {} : { wrapUpUsage: usage },
	);
const usageFields = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const,
	counterFields = ["input", "output", "cacheRead", "cacheWrite"] as const;
const withoutWorkerUsage = (tree: RunUsageTree): RunUsageTree => {
	const run = "run" in tree ? tree.run : tree;
	const local = { ...run, stages: run.stages.filter((stage) => stage.workerExecution === undefined) };
	const children = tree.children?.map(withoutWorkerUsage);
	return children === undefined ? { run: local } : { run: local, children };
};
const mapFields = <F extends string>(fields: readonly F[], fn: (field: F) => number = () => 0): Record<F, number> =>
	Object.fromEntries(fields.map((field) => [field, fn(field)])) as Record<F, number>;
export function createRunBudgetController(input: {
	readonly run: RunSnapshot;
	readonly budget: EffectiveBudget;
	readonly usageTree?: () => RunUsageTree;
	readonly onWarning?: (report: BudgetReport) => void;
	readonly rootBudget?: RunBudgetController;
	readonly externalUsage?: () => RunBudgetUsageBaseline | undefined;
}) {
	const { run, budget } = input;
	const localUsageTree = (): RunUsageTree => withoutWorkerUsage(input.usageTree?.() ?? { run });
	const ownEnabled = budget.maxDurationMs > 0 || budget.maxTokens > 0 || budget.maxCost > 0;
	const usageEnabled = budget.maxTokens > 0 || budget.maxCost > 0;
	const root = input.rootBudget?.enabled === true ? input.rootBudget : undefined;
	const enabled = ownEnabled || root !== undefined;
	let state: RunBudgetState | undefined = run.budgetState === undefined ? undefined : { ...run.budgetState };
	const previousAccounting = state?.accounting;
	// #4859: charge each stage's growth, not the tree total. Replayed stages leave
	// the meter on resume, so a total can fall below its baseline and hide new spend.
	const stageMarks = new Map<string, UsageCounters>();
	/** Growth per field since the last mark; `cost` is in whole cost units so many small charges sum exactly. */
	const stageGrowth = (tree: RunUsageTree): Record<(typeof usageFields)[number], number> => {
		const growth = mapFields(usageFields);
		for (const [key, usage] of meter_stages(tree)) {
			const mark = stageMarks.get(key);
			for (const field of counterFields) growth[field] += Math.max(0, usage[field] - (mark?.[field] ?? 0));
			growth.cost += Math.max(0, costUnits(usage.cost) - costUnits(mark?.cost ?? 0));
			stageMarks.set(
				key,
				mark === undefined ? usage : mapFields(usageFields, (field) => Math.max(mark[field], usage[field])),
			);
		}
		return growth;
	};
	// #5053: what each stage was charged, by replay key, persisted with the accounting. A replayed stage is charged only
	// the spend its record lacks: a crash between a stage's completion record and the next accounting record would
	// otherwise leave its spend uncharged. Records from before this keep the old rule: replayed stages are charged.
	const chargesReplays = previousAccounting === undefined || previousAccounting.stageCharges !== undefined;
	const stageCharges = new Map<string, UsageCounters>(Object.entries(previousAccounting?.stageCharges ?? {}));
	const replayGrowth = (tree: RunUsageTree): Record<(typeof usageFields)[number], number> => {
		const growth = mapFields(usageFields);
		if (!chargesReplays) return growth;
		for (const [replayKey, usage] of meter_replayed_stages(tree)) {
			const mark = stageCharges.get(replayKey);
			for (const field of counterFields) growth[field] += Math.max(0, usage[field] - (mark?.[field] ?? 0));
			growth.cost += Math.max(0, costUnits(usage.cost) - costUnits(mark?.cost ?? 0));
			stageCharges.set(
				replayKey,
				mark === undefined ? usage : mapFields(usageFields, (field) => Math.max(mark[field], usage[field])),
			);
		}
		return growth;
	};
	/** A live stage's charges so far, under its replay key, so its replay after a crash charges only the rest. */
	const recordLiveCharges = (tree: RunUsageTree): void => {
		for (const [key, replayKey] of stage_replay_keys(tree)) {
			const mark = stageMarks.get(key);
			if (mark !== undefined) stageCharges.set(replayKey, mark);
		}
	};
	const initialTree = previousAccounting && usageEnabled ? localUsageTree() : undefined;
	// Stages already in the tree were charged by the execution being resumed.
	if (initialTree !== undefined) stageGrowth(initialTree);
	const initial = initialTree === undefined ? undefined : meter_run(initialTree, Date.now());
	const initialAccounting = initial === undefined ? undefined : { ...initial.perCounter, cost: initial.cost };
	let baseline = mapFields(usageFields, (field) => initialAccounting?.[field] ?? 0);
	let externalBaseline: RunBudgetUsageBaseline = {
		...mapFields(usageFields),
		...previousAccounting?.externalBaseline,
	};
	let charged: RunBudgetAccountingState = {
		baseline,
		tokens: previousAccounting?.tokens ?? 0,
		cost: previousAccounting?.cost ?? 0,
		perCounter: { ...(previousAccounting?.perCounter ?? mapFields(counterFields)) },
	};
	let exhaustedReport: BudgetReport | undefined;
	let lastReports: readonly BudgetReport[] = [];
	let wrapUpPromise: Promise<never> | undefined;
	let rootWrapUpPending = false;
	const handlers: Array<{ readonly frontierStage: string; readonly handler: () => Promise<never> }> = [];
	const updateState = (patch: Partial<RunBudgetState>): void => {
		state = { ...(state ?? {}), ...patch };
		run.budgetState = state;
	};
	const accountUsage = (tree: RunUsageTree): RunMeters => {
		const meters = meter_run(tree, Date.now());
		const current = { ...meters.perCounter, cost: meters.cost };
		const delta = stageGrowth(tree);
		const replayed = replayGrowth(tree);
		for (const field of usageFields) delta[field] += replayed[field];
		recordLiveCharges(tree);
		baseline = mapFields(usageFields, (field) => Math.max(baseline[field], current[field]));
		const external = input.externalUsage?.();
		if (external !== undefined) {
			const growth = mapFields(usageFields, (field) => Math.max(0, external[field] - externalBaseline[field]));
			const costGrowth = Math.max(0, costUnits(external.cost) - costUnits(externalBaseline.cost));
			externalBaseline = mapFields(usageFields, (field) => Math.max(externalBaseline[field], external[field]));
			for (const field of counterFields) delta[field] += growth[field];
			delta.cost += costGrowth;
		}
		charged = {
			baseline,
			tokens: charged.tokens + delta.input + delta.output,
			cost: costFromUnits(costUnits(charged.cost) + delta.cost),
			perCounter: mapFields(counterFields, (field) => charged.perCounter[field] + delta[field]),
			...(external !== undefined || previousAccounting?.externalBaseline !== undefined ? { externalBaseline } : {}),
			...(chargesReplays ? { stageCharges: Object.fromEntries(stageCharges) } : {}),
		};
		updateState({ accounting: charged });
		return Object.assign(meters, { tokens: charged.tokens, cost: charged.cost, perCounter: charged.perCounter });
	};
	const measure = (): RunMeters => {
		const durationMs = elapsedRunMs(run);
		if (!usageEnabled) return { durationMs, tokens: 0, cost: 0, perCounter: mapFields(counterFields) };
		return { ...accountUsage(localUsageTree()), durationMs };
	};
	const warningWasSent = (report: BudgetReport): boolean =>
		report.dimension === "duration" ? state?.warned === true : state?.warnings?.[report.dimension] !== undefined;
	const recordWarning = (report: BudgetReport): void => {
		updateState({
			...(report.dimension === "duration" ? { warned: true } : {}),
			warnings: { ...(state?.warnings ?? {}), [report.dimension]: report },
		});
		input.onWarning?.(report);
	};
	const ceilings = { duration: budget.maxDurationMs, tokens: budget.maxTokens, cost: budget.maxCost };
	const setReports = (reports: readonly BudgetReport[]): void => {
		for (const report of reports) {
			if (ceilings[report.dimension] <= 0) continue;
			updateState({ [report.dimension]: report } as Partial<RunBudgetState>);
		}
	};
	const finishWrapUp = (
		frontierStage: string | undefined,
		summary?: string,
		usage?: WorkflowModelUsage,
		delivered = true,
	): WorkflowBudgetExceededError => {
		// Charge the growth since the last checkpoint, such as a delivered wrap-up turn, before the stop is
		// persisted: a resume treats every stage in the tree as already charged (#5053).
		measure();
		updateState({
			systemOwnedStop: true,
			...(delivered ? { wrapUpDelivered: true, wrapUpCompleted: true } : {}),
			...(delivered && summary !== undefined ? { wrapUpSummary: summary } : {}),
			...(delivered && usage !== undefined ? { wrapUpUsage: usage } : {}),
		});
		const report =
			exhaustedReport ??
			lastReports[0] ??
			state?.duration ??
			state?.tokens ??
			state?.cost ??
			enforceDurationBudget(elapsedRunMs(run), budget).report;
		setReports([report]);
		return new WorkflowBudgetExceededError(
			withFrontier(report, frontierStage, state?.wrapUpSummary, state?.wrapUpUsage),
		);
	};
	const ownCheckpoint = (frontierStage?: string): BudgetCheckpoint => {
		const usageCheck = (dimension: "tokens" | "cost", reading: number, ceiling: number, warned: boolean) =>
			ceiling > 0 ? enforceUsageBudget(dimension, reading, ceiling, budget.warnAtPercent, { warned }) : undefined;
		if (!ownEnabled) return { kind: "continue" };
		const meters = measure();
		const checks = [
			enforceDurationBudget(meters.durationMs, budget, { warned: state?.warned }),
			usageCheck("tokens", meters.tokens, budget.maxTokens, state?.warnings?.tokens !== undefined),
			usageCheck("cost", meters.cost, budget.maxCost, state?.warnings?.cost !== undefined),
		].filter((check): check is Exclude<typeof check, undefined> => check !== undefined);
		lastReports = checks.map((check) => check.report);
		setReports(lastReports);
		let warning: BudgetReport | undefined;
		for (const check of checks)
			if (check.kind === "continue" && check.warning && !warningWasSent(check.report)) {
				warning ??= check.report;
				recordWarning(check.report);
			}
		const exhausted = checks.find((check) => check.kind === "exhausted");
		if (exhausted === undefined)
			return warning === undefined ? { kind: "continue" } : { kind: "warn", report: warning };
		exhaustedReport ??= exhausted.report;
		if (state?.wrapUpCompleted !== true) return { kind: "wrap_up", report: exhausted.report };
		return {
			kind: "exhausted",
			report: withFrontier(exhaustedReport, frontierStage, state.wrapUpSummary, state.wrapUpUsage),
		};
	};
	const boundaryCheckpoint = (
		frontierStage?: string,
	): { readonly check: BudgetCheckpoint; readonly owner?: RunBudgetController } => {
		const rootCheck = root?.checkpoint(frontierStage);
		if (rootCheck?.kind === "wrap_up") rootWrapUpPending = true;
		if (rootCheck?.kind === "wrap_up" || rootCheck?.kind === "exhausted") return { check: rootCheck, owner: root };
		return { check: ownCheckpoint(frontierStage) };
	};
	const checkpoint = (frontierStage?: string): BudgetCheckpoint => boundaryCheckpoint(frontierStage).check;
	const finishBoundary = (owner: RunBudgetController | undefined, frontierStage: string | undefined): never => {
		throw (
			owner?.finishWrapUp(frontierStage, undefined, undefined, false) ??
			finishWrapUp(frontierStage, undefined, undefined, false)
		);
	};
	const deliverBoundary = (owner: RunBudgetController | undefined, frontierStage: string): void => {
		void (owner?.deliverWrapUp(frontierStage) ?? deliverWrapUp(frontierStage));
	};
	const stopAtBoundary = (frontierStage?: string): void => {
		const resolvedFrontierStage = frontierStage ?? handlers.at(-1)?.frontierStage;
		const { check, owner } = boundaryCheckpoint(resolvedFrontierStage);
		if (check.kind === "wrap_up") {
			deliverBoundary(owner, resolvedFrontierStage ?? "workflow frontier");
			finishBoundary(owner, resolvedFrontierStage);
		}
		if (check.kind === "exhausted") finishBoundary(owner, resolvedFrontierStage);
	};
	const rethrowIfSystemOwnedStop = (frontierStage?: string): void => {
		root?.rethrowIfSystemOwnedStop(frontierStage);
		if (state?.systemOwnedStop === true)
			throw finishWrapUp(frontierStage, state.wrapUpSummary, state.wrapUpUsage, state.wrapUpCompleted === true);
	};
	const registerLocalWrapUp = (registration: {
		readonly frontierStage: string;
		readonly handler: () => Promise<never>;
	}): (() => void) => {
		handlers.push(registration);
		return () => {
			const index = handlers.indexOf(registration);
			if (index >= 0) handlers.splice(index, 1);
		};
	};
	const registerWrapUp = (frontierStage: string, handler: () => Promise<never>): (() => void) => {
		const registration = { frontierStage, handler };
		const unregisterOwn = ownEnabled ? registerLocalWrapUp(registration) : undefined;
		const unregisterRoot = root
			? root.registerWrapUp(frontierStage, async () => {
					try {
						return await handler();
					} catch (error) {
						if (!(error instanceof WorkflowBudgetExceededError)) throw error;
						throw root.finishWrapUp(
							error.report.frontierStage,
							error.report.wrapUpSummary,
							error.report.wrapUpUsage,
							error.report.wrapUpSummary !== undefined,
						);
					}
				})
			: undefined;
		return () => {
			unregisterOwn?.();
			unregisterRoot?.();
		};
	};
	const deliverWrapUp = (frontierStage: string): Promise<never> => {
		if (handlers.length === 0 && root === undefined) {
			throw finishWrapUp(frontierStage, undefined, undefined, false);
		}
		if (wrapUpPromise !== undefined) return wrapUpPromise;
		if (rootWrapUpPending && root !== undefined) return root.deliverWrapUp(frontierStage);
		if (state?.systemOwnedStop === true && state.wrapUpCompleted !== true)
			throw finishWrapUp(frontierStage, undefined, undefined, false);
		const registration = handlers.findLast((entry) => entry.frontierStage === frontierStage) ?? handlers.at(-1);
		if (registration === undefined) {
			// This budget's own exhaustion with no live stage to wrap up stops here; the root's is the root's (#5053).
			if (root !== undefined && !ownEnabled) return root.deliverWrapUp(frontierStage);
			throw finishWrapUp(frontierStage, undefined, undefined, false);
		}
		wrapUpPromise = registration.handler();
		return wrapUpPromise;
	};
	const stopAtBoundaryAsync = async (frontierStage?: string): Promise<void> => {
		if (root !== undefined) await root.stopAtBoundaryAsync(frontierStage);
		const check = ownCheckpoint(frontierStage);
		if (check.kind === "continue" || check.kind === "warn") return;
		if (check.kind === "wrap_up") {
			await deliverWrapUp(frontierStage ?? "workflow frontier");
		}
		throw finishWrapUp(frontierStage, state?.wrapUpSummary, state?.wrapUpUsage, state?.wrapUpCompleted === true);
	};
	const awaitPendingWrapUp = async (): Promise<WorkflowBudgetExceededError | undefined> => {
		const rootError = await root?.awaitPendingWrapUp();
		if (rootError !== undefined) return rootError;
		if (wrapUpPromise === undefined) return undefined;
		try {
			await wrapUpPromise;
		} catch (error) {
			if (error instanceof WorkflowBudgetExceededError) return error;
			throw error;
		}
		return undefined;
	};
	const exhaustedWith = (pending: WorkflowModelUsage): boolean => {
		if (root?.exhaustedWith(pending) === true) return true;
		const meters = measure();
		const tokens = meters.tokens + (pending.input ?? 0) + (pending.output ?? 0);
		const cost = costFromUnits(costUnits(meters.cost) + costUnits(pending.cost ?? 0));
		return (
			enforceUsageBudget("tokens", tokens, budget.maxTokens, 0).kind === "exhausted" ||
			enforceUsageBudget("cost", cost, budget.maxCost, 0).kind === "exhausted"
		);
	};
	return {
		enabled,
		checkpoint,
		registerWrapUp,
		deliverWrapUp,
		finishWrapUp,
		rethrowIfSystemOwnedStop,
		stopAtBoundary,
		stopAtBoundaryAsync,
		awaitPendingWrapUp,
		exhaustedWith,
	};
}
