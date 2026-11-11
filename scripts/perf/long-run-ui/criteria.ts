/**
 * The pass/fail criteria of the long-run UI benchmark (#4642), kept apart from the harness so they can be tested with
 * plain numbers. `--assert` evaluates them on the checkpoints a run measured.
 */

export interface MeasuredCheckpoint {
	readonly finished: number;
	readonly sample: {
		readonly heapUsedBytes: number;
		readonly liveSessions: number;
		readonly registryEntries: number;
	};
	readonly idle: {
		readonly engineRenderMs: { readonly widget: { readonly p50: number }; readonly pane: { readonly p50: number } };
		readonly keyLatencyMs: { readonly p50: number };
	};
	readonly busy: { readonly keyLatencyMs: { readonly p50: number } };
	/** Keys sent while the lanes start and finish stages, the median of each statistic over the checkpoint's windows. */
	readonly churn: { readonly keyLatencyMs: { readonly p50: number; readonly p95: number } };
}

/** CPU time one store change costs the engine's workflow surfaces with `finished` finished stages (`store-change-cost.ts`). */
export interface StoreChangeCostSample {
	readonly finished: number;
	/** The median over windows of the mean per change, in microseconds. */
	readonly usPerChange: number;
	/** The mean per change of each window, in microseconds; windows of different counts alternate, so the i-th ones pair up. */
	readonly windows: readonly number[];
}

/** Finished stages from which a checkpoint is compared with the baseline. */
export const LONG_RUN_STAGES = 200;
/** How much worse than the warm baseline a metric may get at {@link LONG_RUN_STAGES} or more finished stages. */
export const MAX_REGRESSION_RATIO = 0.2;
/**
 * Timer and scheduler noise of the benchmark: the milliseconds it records are rounded to a thousandth and come from
 * windows of a few dozen frames on a shared host, where a middle checkpoint can read tens of percent high on every
 * metric at once. It is added to the 20%, and is the only slack besides it.
 */
export const NOISE_FLOOR_MS = 0.05;
/**
 * Heap one finished stage may add once the stages in use are released, apart from its result: its entry in the
 * workflow store (the stage snapshot), its share of the graph and activity indexes, its checkpoint, and rendered lines
 * the collector has not freed yet. The benchmark measures about 14 KB under Bun; a live session costs hundreds of KB,
 * so a stage that keeps one fails this by an order of magnitude.
 */
export const HEAP_BYTES_PER_FINISHED_STAGE_FIXED = 20 * 1024;
/**
 * How many times a stage's result text may be in memory: one string, shared by the workflow store and the journal's
 * checkpoint. A journal that decodes every field into a string of its own would make a second copy, which fails.
 */
export const RESULT_COPIES_PER_FINISHED_STAGE_MAX = 1;

export function heapBytesPerFinishedStageMax(resultBytes: number): number {
	return HEAP_BYTES_PER_FINISHED_STAGE_FIXED + RESULT_COPIES_PER_FINISHED_STAGE_MAX * resultBytes;
}

export interface CriteriaReport {
	readonly passed: boolean;
	readonly baselineFinished: number;
	readonly failures: readonly string[];
	readonly heapBytesPerFinishedStage: number | undefined;
}

type Metric = readonly [name: string, read: (checkpoint: MeasuredCheckpoint) => number];

/**
 * Key latency while stages start and finish, compared at the last checkpoint with the baseline as measured: no noise
 * floor is added. Each is the median over several windows, after a warm-up window at the baseline.
 */
const CHURN_METRICS: readonly Metric[] = [
	["churn key latency p50", (checkpoint) => checkpoint.churn.keyLatencyMs.p50],
	["churn key latency p95", (checkpoint) => checkpoint.churn.keyLatencyMs.p95],
];

const METRICS: readonly Metric[] = [
	["widget frame p50", (checkpoint) => checkpoint.idle.engineRenderMs.widget.p50],
	["graph overlay frame p50", (checkpoint) => checkpoint.idle.engineRenderMs.pane.p50],
	["key latency p50, idle", (checkpoint) => checkpoint.idle.keyLatencyMs.p50],
	["key latency p50, with stages reopening", (checkpoint) => checkpoint.busy.keyLatencyMs.p50],
];

/** The middle value, or the mean of the two middle ones; NaN when any value is NaN, so it never passes a comparison. */
function median(values: readonly number[]): number {
	if (values.some(Number.isNaN)) return Number.NaN;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The median of the ratios of `sample`'s windows to the baseline's windows they ran back to back with. */
export function pairedCostRatio(baseline: StoreChangeCostSample, sample: StoreChangeCostSample): number {
	return median(sample.windows.map((cost, index) => cost / baseline.windows[index]!));
}

/**
 * Checks, against the first checkpoint (measured after a discarded warm-up window):
 * - frame time and key latency, both as the median over the checkpoints from {@link LONG_RUN_STAGES} finished stages
 *   on and as the median of the largest half of them, stay within {@link MAX_REGRESSION_RATIO} of it, plus
 *   {@link NOISE_FLOOR_MS}. Work that grows with the stage count moves the largest checkpoints most, so they show it
 *   even when the median over all does not; one checkpoint that the host's scheduler disturbed does not fail the run;
 * - key latency while stages start and finish (the churn windows), its p50 and its p95, stay within
 *   {@link MAX_REGRESSION_RATIO} of it at the last checkpoint, with no noise floor;
 * - the CPU time one store change costs the engine's workflow surfaces (`store-change-cost.ts`) at the last
 *   checkpoint's finished-stage count stays within {@link MAX_REGRESSION_RATIO} of its cost at the first one's, as the
 *   median of the ratios of windows measured back to back, so a load change on the host moves both sides of a ratio;
 * - no checkpoint holds more live sessions or registry entries than the stages a workflow body still holds;
 * - heap grows by at most {@link heapBytesPerFinishedStageMax} per finished stage between the first and the last
 *   checkpoint from {@link LONG_RUN_STAGES} finished stages on, after the code and its caches have warmed up.
 */
export function evaluateCriteria(
	checkpoints: readonly MeasuredCheckpoint[],
	options: {
		readonly resultBytes: number;
		/** Stages a workflow body may still hold live, one per concurrent lane (`ctx.stage` keeps its session). */
		readonly heldStagesMax: number;
		/** The store-change cost at the first and the last checkpoint's finished-stage counts. */
		readonly storeChangeCost: readonly StoreChangeCostSample[];
	},
): CriteriaReport {
	const [baseline, ...later] = checkpoints;
	if (baseline === undefined) throw new Error("the benchmark measured no checkpoint to evaluate");
	const failures: string[] = [];
	const long = later.filter((checkpoint) => checkpoint.finished >= LONG_RUN_STAGES);
	if (long.length === 0)
		failures.push(`no checkpoint reached ${LONG_RUN_STAGES} finished stages, so nothing can be compared`);
	const first = long[0];
	const lastLong = long.at(-1);
	if (first !== undefined && lastLong !== undefined) {
		for (const [name, read] of METRICS) {
			const allowed = read(baseline) * (1 + MAX_REGRESSION_RATIO) + NOISE_FLOOR_MS;
			const bounded = (measured: number, where: string): void => {
				if (!(measured <= allowed))
					failures.push(
						`${name} is ${measured} ms, ${where}; the ${baseline.finished}-stage baseline ${read(baseline)} ms allows ${allowed.toFixed(3)} ms`,
					);
			};
			bounded(median(long.map(read)), `the median from ${first.finished} to ${lastLong.finished} finished stages`);
			if (long.length > 1) {
				const largest = long.slice(-Math.max(2, Math.ceil(long.length / 2)));
				bounded(
					median(largest.map(read)),
					`the median of the ${largest.length} largest, from ${largest[0]!.finished} finished stages`,
				);
			}
		}
	}
	if (lastLong !== undefined) {
		for (const [name, read] of CHURN_METRICS) {
			const allowed = read(baseline) * (1 + MAX_REGRESSION_RATIO);
			if (!(read(lastLong) <= allowed))
				failures.push(
					`${name} is ${read(lastLong)} ms at ${lastLong.finished} finished stages; the ${baseline.finished}-stage baseline ${read(baseline)} ms allows ${allowed.toFixed(3)} ms`,
				);
		}
	}
	const last = checkpoints.at(-1);
	const costAt = (finished: number | undefined) =>
		options.storeChangeCost.find((sample) => sample.finished === finished);
	const baselineCost = costAt(baseline.finished);
	const lastCost = costAt(last?.finished);
	if (
		baselineCost === undefined ||
		lastCost === undefined ||
		last === baseline ||
		baselineCost.windows.length === 0 ||
		baselineCost.windows.length !== lastCost.windows.length
	)
		failures.push(
			"the store-change cost was not measured in paired windows at both the first and the last checkpoint",
		);
	else {
		const ratio = pairedCostRatio(baselineCost, lastCost);
		if (!(ratio <= 1 + MAX_REGRESSION_RATIO))
			failures.push(
				`a store change costs ${ratio.toFixed(3)} times as much CPU at ${last?.finished} finished stages as at ${baseline.finished} (median of ${lastCost.windows.length} paired windows, ${lastCost.usPerChange} µs against ${baselineCost.usPerChange} µs); at most ${1 + MAX_REGRESSION_RATIO} times is allowed`,
			);
	}
	for (const checkpoint of checkpoints) {
		if (checkpoint.sample.liveSessions > options.heldStagesMax)
			failures.push(
				`${checkpoint.sample.liveSessions} live sessions at ${checkpoint.finished} finished stages; at most ${options.heldStagesMax} are held`,
			);
		if (checkpoint.sample.registryEntries > options.heldStagesMax)
			failures.push(
				`${checkpoint.sample.registryEntries} registry entries at ${checkpoint.finished} finished stages; at most ${options.heldStagesMax} are held`,
			);
	}
	const [from] = long;
	let heapBytesPerFinishedStage: number | undefined;
	if (from !== undefined && lastLong !== undefined && lastLong.finished > from.finished) {
		heapBytesPerFinishedStage =
			(lastLong.sample.heapUsedBytes - from.sample.heapUsedBytes) / (lastLong.finished - from.finished);
		const allowedPerStage = heapBytesPerFinishedStageMax(options.resultBytes);
		if (heapBytesPerFinishedStage > allowedPerStage)
			failures.push(
				`heap grows ${Math.round(heapBytesPerFinishedStage)} bytes per finished stage from ${from.finished} to ${lastLong.finished}; at most ${allowedPerStage} is allowed for results of ${options.resultBytes} bytes`,
			);
	} else
		failures.push(
			`fewer than two checkpoints from ${LONG_RUN_STAGES} finished stages on, so heap growth per stage cannot be measured`,
		);
	return { passed: failures.length === 0, baselineFinished: baseline.finished, failures, heapBytesPerFinishedStage };
}
