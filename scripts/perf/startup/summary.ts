import { type DistributionSummary, summarizeDistribution } from "../windows-startup/summarize.js";

export interface StartupSample {
	readonly id: string;
	readonly target: string;
	readonly mode: string;
	readonly profile: string;
	/** False for the untimed start that fills a warm profile's caches. */
	readonly recorded: boolean;
	readonly state: "success" | "failure";
	readonly startedAt: string;
	readonly platform: string;
	readonly pageCacheDropped: boolean;
	readonly metricsMs?: Readonly<Record<string, number>>;
	/** The tools the first provider request carried. */
	readonly toolNames?: readonly string[];
	/** The product's startup trace in milliseconds after launch, keyed `<process depth>:<mark>`. */
	readonly traceMs?: Readonly<Record<string, number>>;
	readonly failures: readonly string[];
}

export interface MetricSummary extends DistributionSummary {
	readonly target: string;
	readonly profile: string;
	readonly mode: string;
	readonly metric: string;
	readonly min: number;
	readonly failures: number;
}

/** One distribution per target, profile, mode and metric, over the recorded successful samples. */
export function summarizeStartupSamples(samples: readonly StartupSample[]): MetricSummary[] {
	const groups = new Map<string, { sample: StartupSample; values: Map<string, number[]>; failures: number }>();
	for (const sample of samples) {
		if (!sample.recorded) continue;
		const key = `${sample.target}\0${sample.profile}\0${sample.mode}`;
		let group = groups.get(key);
		if (!group) {
			group = { sample, values: new Map(), failures: 0 };
			groups.set(key, group);
		}
		if (sample.state !== "success" || !sample.metricsMs) {
			group.failures += 1;
			continue;
		}
		for (const [metric, value] of Object.entries(sample.metricsMs)) {
			if (!Number.isFinite(value)) throw new Error(`sample ${sample.id} has a non-finite ${metric}`);
			const values = group.values.get(metric) ?? [];
			values.push(value);
			group.values.set(metric, values);
		}
	}
	const summaries: MetricSummary[] = [];
	for (const { sample, values, failures } of groups.values()) {
		for (const [metric, metricValues] of values) {
			summaries.push({
				target: sample.target,
				profile: sample.profile,
				mode: sample.mode,
				metric,
				...summarizeDistribution(metricValues),
				min: Math.min(...metricValues),
				failures,
			});
		}
	}
	return summaries;
}

/**
 * Modes whose successful samples did not all send the same tools. Within a mode, every start of every target must send
 * the tool set an eager start sends, so a target that defers work must not change it. Modes legitimately differ
 * (print mode has no one to ask a question, for example).
 */
export function toolSetDisagreements(samples: readonly StartupSample[]): string[] {
	const byMode = new Map<string, Set<string>>();
	for (const sample of samples) {
		if (sample.state !== "success" || !sample.toolNames) continue;
		const sets = byMode.get(sample.mode) ?? new Set<string>();
		sets.add([...sample.toolNames].sort().join(","));
		byMode.set(sample.mode, sets);
	}
	return [...byMode].filter(([, sets]) => sets.size > 1).map(([mode, sets]) => `${mode}: ${[...sets].join(" | ")}`);
}

export function formatSummaryTable(summaries: readonly MetricSummary[]): string {
	const lines = [
		"| Mode | Metric | Profile | Target | n | Median ms | p95 ms | Min ms | Failures |",
		"| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
	];
	const sorted = [...summaries].sort(
		(left, right) =>
			left.mode.localeCompare(right.mode) ||
			left.metric.localeCompare(right.metric) ||
			left.profile.localeCompare(right.profile) ||
			left.target.localeCompare(right.target),
	);
	for (const row of sorted) {
		lines.push(
			`| ${row.mode} | ${row.metric} | ${row.profile} | ${row.target} | ${row.count} | ${row.median.toFixed(0)} | ${row.p95.toFixed(0)} | ${row.min.toFixed(0)} | ${row.failures} |`,
		);
	}
	return lines.join("\n");
}

/**
 * Median milliseconds after launch of each product trace mark, per target, profile and mode, in the order the marks
 * happen: where a start spent its time.
 */
export function formatTraceTable(samples: readonly StartupSample[]): string {
	const groups = new Map<string, Map<string, number[]>>();
	for (const sample of samples) {
		if (!sample.recorded || sample.state !== "success" || !sample.traceMs) continue;
		const key = `${sample.mode} | ${sample.profile} | ${sample.target}`;
		const marks = groups.get(key) ?? new Map<string, number[]>();
		for (const [mark, value] of Object.entries(sample.traceMs)) marks.set(mark, [...(marks.get(mark) ?? []), value]);
		groups.set(key, marks);
	}
	const lines = [
		"| Mode | Profile | Target | Mark | n | Median ms after launch |",
		"| --- | --- | --- | --- | ---: | ---: |",
	];
	for (const [key, marks] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
		const rows = [...marks].map(([mark, values]) => ({ mark, values, median: summarizeDistribution(values).median }));
		for (const row of rows.sort((left, right) => left.median - right.median)) {
			lines.push(`| ${key} | ${row.mark} | ${row.values.length} | ${row.median.toFixed(0)} |`);
		}
	}
	return lines.join("\n");
}
