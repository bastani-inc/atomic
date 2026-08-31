#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import type { BenchmarkMetrics, BenchmarkSample } from "./samples.js";

export interface DistributionSummary {
	readonly count: number;
	readonly median: number;
	readonly p95: number;
	readonly mad: number;
	readonly raw: readonly number[];
}

export interface SampleSummary {
	readonly totalCount: number;
	readonly successCount: number;
	readonly productFailureCount: number;
	readonly invalidCount: number;
	readonly excludedSampleIds: readonly string[];
	readonly failures: readonly {
		readonly id: string;
		readonly state: BenchmarkSample["state"];
		readonly reasons: readonly string[];
	}[];
	readonly metrics: { readonly [K in keyof BenchmarkMetrics]?: DistributionSummary };
}

export interface BootstrapInterval {
	readonly estimate: number;
	readonly lower: number;
	readonly upper: number;
	readonly resamples: number;
}

export interface MetricComparison {
	readonly medianSpeedup: number;
	readonly p95Speedup: number;
	readonly medianRatioBootstrap95: BootstrapInterval;
	readonly p95RatioBootstrap95: BootstrapInterval;
}

export interface ProfileComparison {
	readonly baseline: SampleSummary;
	readonly candidate: SampleSummary;
	readonly metrics: { readonly [K in keyof BenchmarkMetrics]?: MetricComparison };
}

const METRIC_NAMES = [
	"startupCompleteMs",
	"dispatchMs",
	"spawnToDispatchMs",
	"launchToProviderFirstByteMs",
] as const satisfies readonly (keyof BenchmarkMetrics)[];

function sorted(values: readonly number[]): number[] {
	return [...values].sort((left, right) => left - right);
}

export function median(values: readonly number[]): number {
	if (values.length === 0) throw new Error("median requires at least one value");
	const valuesSorted = sorted(values);
	const middle = Math.floor(valuesSorted.length / 2);
	return valuesSorted.length % 2 === 0
		? (valuesSorted[middle - 1]! + valuesSorted[middle]!) / 2
		: valuesSorted[middle]!;
}

export function nearestRank(values: readonly number[], percentile: number): number {
	if (values.length === 0) throw new Error("nearest-rank percentile requires at least one value");
	if (!(percentile > 0 && percentile <= 1)) throw new Error("percentile must be in (0, 1]");
	const valuesSorted = sorted(values);
	return valuesSorted[Math.ceil(percentile * valuesSorted.length) - 1]!;
}

export function summarizeDistribution(values: readonly number[]): DistributionSummary {
	const center = median(values);
	return {
		count: values.length,
		median: center,
		p95: nearestRank(values, 0.95),
		mad: median(values.map((value) => Math.abs(value - center))),
		raw: [...values],
	};
}

export function summarizeSamples(samples: readonly BenchmarkSample[]): SampleSummary {
	for (const sample of samples) {
		if (sample.state === "success" && sample.metricsMs === undefined) {
			throw new Error(`successful sample ${sample.id} is missing metricsMs`);
		}
	}
	const successful = samples.filter(
		(sample): sample is BenchmarkSample & { readonly metricsMs: BenchmarkMetrics } =>
			sample.state === "success" && sample.metricsMs !== undefined,
	);
	for (const sample of successful) {
		for (const name of METRIC_NAMES) {
			if (!Number.isFinite(sample.metricsMs[name])) {
				throw new Error(`successful sample ${sample.id} has a non-finite ${name} metric`);
			}
		}
	}
	const excluded = samples.filter((sample) => sample.state !== "success" || sample.metricsMs === undefined);
	const metrics: Partial<Record<keyof BenchmarkMetrics, DistributionSummary>> = {};
	for (const name of METRIC_NAMES) {
		const values = successful.map((sample) => sample.metricsMs[name]);
		if (values.length > 0) metrics[name] = summarizeDistribution(values);
	}
	return {
		totalCount: samples.length,
		successCount: successful.length,
		productFailureCount: samples.filter((sample) => sample.state === "product-failure").length,
		invalidCount: samples.filter((sample) => sample.state === "invalid").length,
		excludedSampleIds: excluded.map((sample) => sample.id),
		failures: excluded.map((sample) => ({ id: sample.id, state: sample.state, reasons: sample.failures })),
		metrics,
	};
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

function bootstrapRatio(
	baseline: readonly number[],
	candidate: readonly number[],
	statistic: (values: readonly number[]) => number,
	resamples: number,
	seed: number,
): BootstrapInterval {
	if (baseline.length === 0 || candidate.length === 0) throw new Error("bootstrap inputs cannot be empty");
	if (!Number.isSafeInteger(resamples) || resamples < 1) throw new Error("resamples must be a positive integer");
	const random = seededRandom(seed);
	const ratios: number[] = [];
	for (let iteration = 0; iteration < resamples; iteration += 1) {
		const baselineDraw = Array.from(
			{ length: baseline.length },
			() => baseline[Math.floor(random() * baseline.length)]!,
		);
		const candidateDraw = Array.from(
			{ length: candidate.length },
			() => candidate[Math.floor(random() * candidate.length)]!,
		);
		ratios.push(statistic(baselineDraw) / statistic(candidateDraw));
	}
	return {
		estimate: statistic(baseline) / statistic(candidate),
		lower: nearestRank(ratios, 0.025),
		upper: nearestRank(ratios, 0.975),
		resamples,
	};
}

export function bootstrapMedianRatio(
	baseline: readonly number[],
	candidate: readonly number[],
	resamples = 10_000,
	seed = 0x41544f4d,
): BootstrapInterval {
	return bootstrapRatio(baseline, candidate, median, resamples, seed);
}

export function bootstrapP95Ratio(
	baseline: readonly number[],
	candidate: readonly number[],
	resamples = 10_000,
	seed = 0x41544f4d,
): BootstrapInterval {
	return bootstrapRatio(baseline, candidate, (values) => nearestRank(values, 0.95), resamples, seed);
}

export function summarizeComparisons(samples: readonly BenchmarkSample[]): Record<string, ProfileComparison> {
	const grouped = Object.groupBy(samples, (sample) => `${sample.lane}:${sample.profile}`);
	const comparisons: Record<string, ProfileComparison> = {};
	for (const [key, group = []] of Object.entries(grouped)) {
		const baselineSamples = group.filter((sample) => sample.build === "baseline");
		if (baselineSamples.length === 0) continue;
		const baseline = summarizeSamples(baselineSamples);
		for (const candidateBuild of ["candidate", "candidate-bytecode"] as const) {
			const candidateSamples = group.filter((sample) => sample.build === candidateBuild);
			if (candidateSamples.length === 0) continue;
			const candidate = summarizeSamples(candidateSamples);
			const metrics: Partial<Record<keyof BenchmarkMetrics, MetricComparison>> = {};
			for (const name of METRIC_NAMES) {
				const baselineMetric = baseline.metrics[name];
				const candidateMetric = candidate.metrics[name];
				if (!baselineMetric || !candidateMetric) continue;
				metrics[name] = {
					medianSpeedup: baselineMetric.median / candidateMetric.median,
					p95Speedup: baselineMetric.p95 / candidateMetric.p95,
					medianRatioBootstrap95: bootstrapMedianRatio(baselineMetric.raw, candidateMetric.raw),
					p95RatioBootstrap95: bootstrapP95Ratio(baselineMetric.raw, candidateMetric.raw),
				};
			}
			comparisons[`${key}:${candidateBuild}`] = { baseline, candidate, metrics };
		}
	}
	return comparisons;
}

export function parseJsonl(text: string): BenchmarkSample[] {
	return text
		.split(/\r?\n/u)
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as BenchmarkSample);
}

if (import.meta.main) {
	const [input, output] = process.argv.slice(2);
	if (!input) throw new Error("Usage: summarize.ts <samples.jsonl> [summary.json]");
	const samples = parseJsonl(readFileSync(input, "utf8"));
	const grouped = Object.groupBy(samples, (sample) => `${sample.lane}:${sample.build}:${sample.profile}`);
	const builds = Object.fromEntries(
		Object.entries(grouped).map(([key, group]) => [key, summarizeSamples(group ?? [])]),
	);
	const rendered = `${JSON.stringify({ builds, comparisons: summarizeComparisons(samples) }, null, 2)}\n`;
	if (output) writeFileSync(output, rendered, "utf8");
	else process.stdout.write(rendered);
}
