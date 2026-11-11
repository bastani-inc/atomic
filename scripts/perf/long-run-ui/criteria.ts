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
 * Timer and scheduler noise the milliseconds of one window carry on a shared host. A p50 of a fraction of a millisecond
 * would otherwise fail on a quarter-millisecond jitter that no code caused.
 */
export const NOISE_FLOOR_MS = 0.5;
/**
 * Heap one finished stage may add once the stages in use are released, per stage: its entry in the workflow store (the
 * stage snapshot with its result text), its share of the graph and activity indexes, and rendered lines the collector has
 * not freed yet. The benchmark measures about 17 KB under Bun; a live session costs hundreds of KB, so a stage that
 * keeps one fails this by an order of magnitude.
 */
export const HEAP_BYTES_PER_FINISHED_STAGE_MAX = 24 * 1024;

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

/**
 * Checks, against the first checkpoint (measured after a discarded warm-up window):
 * - frame time and key latency at {@link LONG_RUN_STAGES} or more finished stages stay within
 *   {@link MAX_REGRESSION_RATIO} of it, plus {@link NOISE_FLOOR_MS};
 * - no checkpoint holds a live session or a registry entry, since nothing is open then;
 * - heap grows by at most {@link HEAP_BYTES_PER_FINISHED_STAGE_MAX} per finished stage between the first and the last
 *   checkpoint from {@link LONG_RUN_STAGES} finished stages on, after the code and its caches have warmed up.
 */
export function evaluateCriteria(checkpoints: readonly MeasuredCheckpoint[]): CriteriaReport {
	const [baseline, ...later] = checkpoints;
	if (baseline === undefined) throw new Error("the benchmark measured no checkpoint to evaluate");
	const failures: string[] = [];
	const long = later.filter((checkpoint) => checkpoint.finished >= LONG_RUN_STAGES);
	if (long.length === 0)
		failures.push(`no checkpoint reached ${LONG_RUN_STAGES} finished stages, so nothing can be compared`);
	for (const checkpoint of long) {
		for (const [name, read] of METRICS) {
			const allowed = read(baseline) * (1 + MAX_REGRESSION_RATIO) + NOISE_FLOOR_MS;
			const measured = read(checkpoint);
			if (!(measured <= allowed))
				failures.push(
					`${name} is ${measured} ms at ${checkpoint.finished} finished stages; the ${baseline.finished}-stage baseline ${read(baseline)} ms allows ${allowed.toFixed(3)} ms`,
				);
		}
	}
	for (const checkpoint of checkpoints) {
		if (checkpoint.sample.liveSessions !== 0)
			failures.push(`${checkpoint.sample.liveSessions} live sessions at ${checkpoint.finished} finished stages`);
		if (checkpoint.sample.registryEntries !== 0)
			failures.push(
				`${checkpoint.sample.registryEntries} registry entries at ${checkpoint.finished} finished stages`,
			);
	}
	const [from] = long;
	const last = long.at(-1);
	let heapBytesPerFinishedStage: number | undefined;
	if (from !== undefined && last !== undefined && last.finished > from.finished) {
		heapBytesPerFinishedStage =
			(last.sample.heapUsedBytes - from.sample.heapUsedBytes) / (last.finished - from.finished);
		if (heapBytesPerFinishedStage > HEAP_BYTES_PER_FINISHED_STAGE_MAX)
			failures.push(
				`heap grows ${Math.round(heapBytesPerFinishedStage)} bytes per finished stage from ${from.finished} to ${last.finished}; at most ${HEAP_BYTES_PER_FINISHED_STAGE_MAX} is allowed`,
			);
	} else
		failures.push(
			`fewer than two checkpoints from ${LONG_RUN_STAGES} finished stages on, so heap growth per stage cannot be measured`,
		);
	return { passed: failures.length === 0, baselineFinished: baseline.finished, failures, heapBytesPerFinishedStage };
}
