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
}

/** Finished stages from which a checkpoint is compared with the baseline. */
export const LONG_RUN_STAGES = 200;
/** How much worse than the warm baseline a metric may get at {@link LONG_RUN_STAGES} or more finished stages. */
export const MAX_REGRESSION_RATIO = 0.2;
/**
 * Timer resolution of the benchmark: the milliseconds it records are rounded to a thousandth and come from windows of
 * a few dozen frames, so a difference of a few hundredths is not a measurement. It is a small fraction of every
 * baseline the benchmark records, never the margin that lets a regression through.
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

const METRICS: readonly Metric[] = [
	["widget frame p50", (checkpoint) => checkpoint.idle.engineRenderMs.widget.p50],
	["graph overlay frame p50", (checkpoint) => checkpoint.idle.engineRenderMs.pane.p50],
	["key latency p50, idle", (checkpoint) => checkpoint.idle.keyLatencyMs.p50],
	["key latency p50, with stages starting and reopening", (checkpoint) => checkpoint.busy.keyLatencyMs.p50],
];

/** The middle value, or the mean of the two middle ones; NaN when any value is NaN, so it never passes a comparison. */
function median(values: readonly number[]): number {
	if (values.some(Number.isNaN)) return Number.NaN;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Checks, against the first checkpoint (measured after a discarded warm-up window):
 * - frame time and key latency, both as the median over the checkpoints from {@link LONG_RUN_STAGES} finished stages
 *   on and at the last of them, stay within {@link MAX_REGRESSION_RATIO} of it, plus {@link NOISE_FLOOR_MS}. Work that
 *   grows with the stage count moves the largest checkpoint most, so the last one shows it even when the median does
 *   not; one middle checkpoint that the host's scheduler disturbed does not fail the run;
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
			if (long.length > 1) bounded(read(lastLong), `at ${lastLong.finished} finished stages`);
		}
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
	const last = long.at(-1);
	let heapBytesPerFinishedStage: number | undefined;
	if (from !== undefined && last !== undefined && last.finished > from.finished) {
		heapBytesPerFinishedStage =
			(last.sample.heapUsedBytes - from.sample.heapUsedBytes) / (last.finished - from.finished);
		const allowedPerStage = heapBytesPerFinishedStageMax(options.resultBytes);
		if (heapBytesPerFinishedStage > allowedPerStage)
			failures.push(
				`heap grows ${Math.round(heapBytesPerFinishedStage)} bytes per finished stage from ${from.finished} to ${last.finished}; at most ${allowedPerStage} is allowed for results of ${options.resultBytes} bytes`,
			);
	} else
		failures.push(
			`fewer than two checkpoints from ${LONG_RUN_STAGES} finished stages on, so heap growth per stage cannot be measured`,
		);
	return { passed: failures.length === 0, baselineFinished: baseline.finished, failures, heapBytesPerFinishedStage };
}
