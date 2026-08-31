import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type BuildTarget,
	createBalancedOrder,
	createBenchmarkMetrics,
	validateComparisonIdentity,
} from "../../scripts/perf/windows-startup/benchmark.js";
import { benchmarkEnvironment, environmentHash } from "../../scripts/perf/windows-startup/fixtures.js";
import type { BenchmarkSample } from "../../scripts/perf/windows-startup/samples.js";
import { summarizeComparisons, summarizeSamples } from "../../scripts/perf/windows-startup/summarize.js";

function sample(
	id: string,
	startupCompleteMs: number | undefined,
	state: BenchmarkSample["state"],
	build: BenchmarkSample["build"] = "baseline",
): BenchmarkSample {
	return {
		schemaVersion: 1,
		id,
		lane: "release",
		build,
		profile: "warm",
		state,
		command: "atomic --session-dir run --provider benchmark-loopback --model benchmark-model",
		startedAt: "2026-01-01T00:00:00.000Z",
		marksNs: {},
		metricsMs:
			startupCompleteMs === undefined
				? undefined
				: {
						startupCompleteMs,
						dispatchMs: startupCompleteMs / 2,
						spawnToDispatchMs: startupCompleteMs * 1.5,
						launchToProviderFirstByteMs: startupCompleteMs * 2,
					},
		artifactHashes: {},
		rawArtifactDirectory: `raw/${id}`,
		failures: state === "success" ? [] : [state],
	};
}

function target(
	build: BuildTarget["build"],
	productSha: string,
	launcherMode: "non-bytecode" | "bytecode",
	appHash = "sha256:shared-app",
): BuildTarget {
	return {
		build,
		executableDirectory: `C:/artifacts/${build}`,
		metadata: {
			artifactHashes: { "app.js": appHash, "atomic.exe": `sha256:${build}` },
			runtime: { productSha, launcherMode, bun: "1.4.0" },
		},
	};
}

test("spawn-to-dispatch is settled startup plus Enter-to-provider dispatch", () => {
	const metrics = createBenchmarkMetrics({
		processLaunch: 1_000_000n,
		startupComplete: 11_000_000n,
		enter: 31_000_000n,
		providerFirstByte: 36_000_000n,
	});

	assert.ok(metrics);
	assert.equal(metrics.startupCompleteMs, 10);
	assert.equal(metrics.dispatchMs, 5);
	assert.equal(metrics.spawnToDispatchMs, metrics.startupCompleteMs + metrics.dispatchMs);
	assert.equal(metrics.launchToProviderFirstByteMs, 35);
	assert.notEqual(metrics.spawnToDispatchMs, metrics.launchToProviderFirstByteMs);
});
test("p95 uses nearest-rank selection", () => {
	const samples = Array.from({ length: 20 }, (_, index) => sample(String(index), index + 1, "success"));
	const summary = summarizeSamples(samples);
	assert.equal(summary.metrics.startupCompleteMs?.median, 10.5);
	assert.equal(summary.metrics.startupCompleteMs?.p95, 19);
});

test("balanced execution order is deterministic and alternates AB/BA pairs", () => {
	const order = createBalancedOrder(["baseline", "candidate"], 4, 17);
	assert.deepEqual(order, createBalancedOrder(["baseline", "candidate"], 4, 17));
	assert.deepEqual(order.slice(0, 4), [order[0], order[1], order[1], order[0]]);
	assert.equal(order.filter((build) => build === "baseline").length, 4);
	assert.equal(order.filter((build) => build === "candidate").length, 4);
});

test("three-arm execution order gives every build one serial slot per round", () => {
	const order = createBalancedOrder(["baseline", "candidate", "candidate-bytecode"], 4, 23);
	assert.equal(order.length, 12);
	for (let offset = 0; offset < order.length; offset += 3) {
		assert.deepEqual(
			new Set(order.slice(offset, offset + 3)),
			new Set(["baseline", "candidate", "candidate-bytecode"]),
		);
	}
	for (const build of ["baseline", "candidate", "candidate-bytecode"] as const) {
		assert.equal(order.filter((entry) => entry === build).length, 4);
	}
});

test("three-arm identity requires origin/main plus same-SHA non-bytecode and Bun 1.4.0 bytecode", () => {
	const targets = [
		target("baseline", "main-sha", "non-bytecode", "sha256:baseline-app"),
		target("candidate", "optimized-sha", "non-bytecode"),
		target("candidate-bytecode", "optimized-sha", "bytecode"),
	];
	assert.doesNotThrow(() => validateComparisonIdentity(targets, "main-sha", "optimized-sha"));
	assert.throws(
		() => validateComparisonIdentity(targets, "wrong-main", "optimized-sha"),
		/baseline product SHA mismatch/u,
	);
	assert.throws(
		() =>
			validateComparisonIdentity(
				[targets[0]!, targets[1]!, target("candidate-bytecode", "different-sha", "bytecode")],
				"main-sha",
				"optimized-sha",
			),
		/candidate-bytecode product SHA mismatch/u,
	);
	assert.throws(
		() =>
			validateComparisonIdentity(
				[targets[0]!, targets[1]!, target("candidate-bytecode", "optimized-sha", "bytecode", "sha256:other-app")],
				"main-sha",
				"optimized-sha",
			),
		/share the exact app\.js hash/u,
	);
});

test("benchmark environment forces the ordinary fullscreen path and strips diagnostic controls", () => {
	const base = {
		PATH: "/usr/bin",
		CI: "1",
		ATOMIC_REDUCED_MOTION: "1",
		ATOMIC_STARTUP_BENCHMARK: "1",
		ATOMIC_TIMING: "1",
	};
	const baseline = benchmarkEnvironment("/agent-a", "/baseline-bin", base);
	const candidate = benchmarkEnvironment("/agent-b", "/candidate-bin", base);
	assert.equal(baseline.CI, "0");
	assert.equal(baseline.ATOMIC_REDUCED_MOTION, "0");
	assert.equal(baseline.ATOMIC_STARTUP_BENCHMARK, undefined);
	assert.equal(baseline.ATOMIC_TIMING, undefined);
	assert.equal(environmentHash(baseline), environmentHash(candidate));
});

test("environment hashes include every inherited child variable", () => {
	const base = benchmarkEnvironment("/agent-a", "/baseline-bin", { PATH: "/usr/bin", NODE_OPTIONS: "--no-warnings" });
	const changed = { ...base, NODE_OPTIONS: "--trace-warnings" };
	assert.notEqual(environmentHash(base), environmentHash(changed));
});

test("invalid samples and product failures remain counted and never enter successful statistics", () => {
	const samples = [
		sample("good-a", 10, "success"),
		sample("good-b", 20, "success"),
		sample("bad", 1, "invalid"),
		sample("crash", undefined, "product-failure"),
	];
	const summary = summarizeSamples(samples);
	assert.equal(summary.totalCount, 4);
	assert.equal(summary.successCount, 2);
	assert.equal(summary.invalidCount, 1);
	assert.equal(summary.productFailureCount, 1);
	assert.equal(summary.metrics.startupCompleteMs?.median, 15);
	assert.deepEqual([...summary.excludedSampleIds].sort(), ["bad", "crash"]);
});

test("malformed successful metrics are rejected instead of silently omitted", () => {
	const malformed = sample("malformed", Number.NaN, "success");
	assert.throws(() => summarizeSamples([malformed]), /malformed.*non-finite startupCompleteMs/u);
	assert.throws(() => summarizeSamples([sample("missing", undefined, "success")]), /missing.*metricsMs/u);
});

test("paired summaries emit median and p95 speedups with 10,000-resample intervals", () => {
	const samples = [
		sample("baseline-a", 20, "success"),
		sample("baseline-b", 40, "success"),
		sample("candidate-a", 10, "success", "candidate"),
		sample("candidate-b", 20, "success", "candidate"),
	];
	const comparisons = summarizeComparisons(samples);
	const startup = comparisons["release:warm:candidate"]?.metrics.startupCompleteMs;
	assert.equal(startup?.medianSpeedup, 2);
	assert.equal(startup?.p95Speedup, 2);
	assert.equal(startup?.medianRatioBootstrap95.resamples, 10_000);
	assert.equal(startup?.p95RatioBootstrap95.resamples, 10_000);
});
