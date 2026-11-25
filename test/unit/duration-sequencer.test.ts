import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";
import { createVitest } from "vitest/node";
import { durationDrift, reportBucket, testFileDurations } from "../../scripts/test-file-durations.js";
import {
	DurationSequencer,
	FILE_OVERHEAD_MS,
	SHARD_WORKERS,
	selectRecordedDurations,
	shardByDuration,
	UNKNOWN_FILE_MS,
} from "../helpers/duration-sequencer.js";
import { readText } from "../helpers/runtime.js";

const durations = {
	"test/integration/a.test.ts": 300_000,
	"test/integration/b.test.ts": 280_000,
	"test/integration/c.test.ts": 120_000,
	"test/integration/d.test.ts": 90_000,
	"test/integration/e.test.ts": 60_000,
	"test/integration/f.test.ts": 1_000,
};
const files = [...Object.keys(durations), "test/integration/new.test.ts"];

test("every file runs in exactly one shard, whatever order the shards list the files in", () => {
	const count = 3;
	const shards = Array.from({ length: count }, (_, i) =>
		shardByDuration(i % 2 === 0 ? files : [...files].reverse(), durations, i + 1, count),
	);
	const assigned = shards.flat();
	assert.equal(assigned.length, files.length);
	assert.deepEqual(new Set(assigned), new Set(files));
});

test("the longest files go to different shards", () => {
	const shards = [1, 2, 3].map((index) => shardByDuration(files, durations, index, 3));
	const owner = (path: string) => shards.findIndex((shard) => shard.includes(path));
	assert.equal(new Set(["a", "b", "c"].map((name) => owner(`test/integration/${name}.test.ts`))).size, 3);
});

test("a long file sets its shard's wall time, and short files share that shard's other workers without outlasting it", () => {
	// One long file, plus as many short ones as two shards' workers take in about its time. No assignment finishes
	// before the long file, so the shard holding it should not sit with six idle workers while the other shard runs every
	// short file: a Windows integration shard that ran one 104 s file alone left the other shards seventeen to thirty
	// process-heavy files each, which slowed each other down enough to time a test out.
	const long = "test/integration/long.test.ts";
	const record: Record<string, number> = { [long]: 100_000 };
	for (let i = 0; i < 4 * SHARD_WORKERS; i++)
		record[`test/integration/short-${String(i).padStart(2, "0")}.test.ts`] = 23_000;
	const weight = (path: string) => (record[path] ?? UNKNOWN_FILE_MS) + FILE_OVERHEAD_MS;
	const paths = Object.keys(record);
	const shards = [1, 2].map((index) => shardByDuration(paths, record, index, 2));
	const walls = shards.map((shard) =>
		Math.max(...shard.map(weight), shard.reduce((sum, path) => sum + weight(path), 0) / SHARD_WORKERS),
	);
	const bound = Math.max(weight(long), paths.reduce((sum, path) => sum + weight(path), 0) / SHARD_WORKERS / 2);
	assert.ok(Math.max(...walls) <= 1.1 * bound, `shards outlast the long file: ${walls.join(", ")}`);
	const beside = shards.find((shard) => shard.includes(long))!.filter((path) => path !== long);
	assert.ok(beside.length >= SHARD_WORKERS, `only ${beside.length} short files ran beside the long one`);
});

test("a serial file (run alone after the rest) leaves its shard fewer parallel files", () => {
	// The gate runs after its shard's other files, so its time adds to theirs instead of overlapping them. Placed as
	// if it overlapped them, this fixture's shards would take 195 s and 107 s.
	const gate = "test/integration/gate.test.ts";
	const record: Record<string, number> = { [gate]: 100_000 };
	for (let i = 0; i < 8 * SHARD_WORKERS; i++)
		record[`test/integration/short-${String(i).padStart(2, "0")}.test.ts`] = 23_000;
	const weight = (path: string) => (record[path] ?? UNKNOWN_FILE_MS) + FILE_OVERHEAD_MS;
	const paths = Object.keys(record);
	const walls = [1, 2].map((index) => {
		const shard = shardByDuration(paths, record, index, 2, new Set([gate]));
		const parallel = shard.filter((path) => path !== gate);
		return (
			Math.max(0, ...parallel.map(weight), parallel.reduce((sum, path) => sum + weight(path), 0) / SHARD_WORKERS) +
			(shard.includes(gate) ? weight(gate) : 0)
		);
	});
	assert.ok(Math.max(...walls) <= 1.1 * Math.min(...walls), `unbalanced shards: ${walls.join(", ")}`);
});

test("heavy files that each fit in a shard's share spread across the shards instead of piling onto one", () => {
	// The unit suite's shape on Windows: a dozen files of about a minute, each starting child processes that compete for
	// the runner's CPUs, among hundreds of short ones. Every shard's workers have minutes of work, so no single heavy
	// file sets a shard's wall time, and a shard that drew most of them ran them all at once, half again slower.
	const record: Record<string, number> = {};
	for (const seconds of [81, 78, 77, 73, 72, 66, 64, 63, 61, 57, 56, 54])
		record[`test/unit/heavy-${seconds}.test.ts`] = seconds * 1_000;
	for (let i = 0; i < 400; i++) record[`test/unit/short-${String(i).padStart(3, "0")}.test.ts`] = 3_000;
	const paths = Object.keys(record);
	const heavy = [1, 2, 3, 4].map(
		(index) => shardByDuration(paths, record, index, 4).filter((path) => path.includes("heavy")).length,
	);
	assert.deepEqual(heavy, [3, 3, 3, 3]);
});

test("a serial file lighter than the heaviest parallel files never stacks onto a heavy parallel shard", () => {
	const gate = "test/integration/interactive-event-loop-guard.test.ts";
	const record: Record<string, number> = { [gate]: 70_000 };
	for (let i = 0; i < 8; i++) record[`test/integration/heavy-${i}.test.ts`] = 85_000;
	for (let i = 0; i < 80; i++) record[`test/integration/light-${String(i).padStart(2, "0")}.test.ts`] = 5_000;
	const weight = (path: string) => (record[path] ?? UNKNOWN_FILE_MS) + FILE_OVERHEAD_MS;
	const paths = Object.keys(record);
	const count = 9;
	const walls = Array.from({ length: count }, (_, idx) => {
		const shard = shardByDuration(paths, record, idx + 1, count, new Set([gate]));
		const parallel = shard.filter((path) => path !== gate);
		return (
			Math.max(0, ...parallel.map(weight), parallel.reduce((sum, path) => sum + weight(path), 0) / SHARD_WORKERS) +
			(shard.includes(gate) ? weight(gate) : 0)
		);
	});
	const gateShard = Array.from({ length: count }, (_, idx) =>
		shardByDuration(paths, record, idx + 1, count, new Set([gate])),
	).find((shard) => shard.includes(gate))!;
	assert.equal(
		gateShard.some((path) => path.includes("heavy-")),
		false,
		`serial gate stacked with a heavy parallel file: ${gateShard.join(", ")}`,
	);
	assert.ok(Math.max(...walls) <= 95_000, `serial stacking pushed max shard wall to ${Math.max(...walls)} ms`);
});

test("selectRecordedDurations overlays storage-conformance weights only when server backends are required", () => {
	const sample = {
		linux: {
			"test/integration/storage-conformance-matrix.test.ts": 31_000,
			"test/integration/storage-postgres.test.ts": 0,
			"test/unit/a.test.ts": 5_000,
		},
		win32: {
			"test/integration/storage-conformance-matrix.test.ts": 40_000,
			"test/unit/a.test.ts": 7_000,
		},
		"storage-conformance": {
			"test/integration/storage-conformance-matrix.test.ts": 135_000,
			"test/integration/storage-postgres.test.ts": 73_000,
		},
	};
	assert.equal(
		selectRecordedDurations(sample, "linux", {})["test/integration/storage-conformance-matrix.test.ts"],
		31_000,
	);
	assert.equal(
		selectRecordedDurations(sample, "win32", {})["test/integration/storage-conformance-matrix.test.ts"],
		40_000,
	);
	const server = selectRecordedDurations(sample, "linux", { ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED: "1" });
	assert.equal(server["test/integration/storage-conformance-matrix.test.ts"], 135_000);
	assert.equal(server["test/integration/storage-postgres.test.ts"], 73_000);
	assert.equal(server["test/unit/a.test.ts"], 5_000);
});

test("reportBucket routes storage-conformance reports separately from linux and win32 reports", () => {
	assert.equal(
		reportBucket("/tmp/reports/test-diagnostics-storage-conformance-linux-x64-1/storage.json"),
		"storage-conformance",
	);
	assert.equal(reportBucket("/tmp/reports/test-diagnostics-integration-tests-linux-x64-1/int.json"), "linux");
	assert.equal(reportBucket("/tmp/reports/test-diagnostics-unit-tests-windows-x64-3/unit.json"), "win32");
	assert.equal(reportBucket("/tmp/reports/unknown/report.json"), undefined);
});

/** Structural: each case starts real Vitest instances on a suite's config and globs its files. */
const REAL_VITEST_TIMEOUT_MS = 60_000;

const repository = join(import.meta.dirname, "../..");

/** A suite sharded with the duration sequencer, selected as its CI job selects it. */
interface ShardedSuite {
	readonly name: string;
	/** The Vitest root whose config the suite runs, relative to the repository; the repository's own by default. */
	readonly root?: string;
	readonly projects?: readonly string[];
}

const SHARDED_SUITES: readonly ShardedSuite[] = [
	{ name: "unit", projects: ["unit"] },
	{ name: "integration", projects: ["integration", "integration-ui-gate"] },
	{ name: "coding-agent", root: "packages/coding-agent" },
];

const INTEGRATION = SHARDED_SUITES[1]!;
const CODING_AGENT = SHARDED_SUITES[2]!;

/**
 * Shard counts to split each suite into. CI runs three to seven per suite and OS today; every file must run exactly
 * once for any count, so the check does not follow the workflow's numbers.
 */
const SHARD_COUNTS = [2, 3, 9, 12];

async function suiteSpecifications(suite: ShardedSuite, shard: string) {
	const vitest = await createVitest("test", {
		watch: false,
		run: true,
		...(suite.root === undefined ? {} : { root: join(repository, suite.root) }),
		...(suite.projects === undefined ? {} : { project: [...suite.projects] }),
		shard,
	});
	try {
		return { vitest, specifications: await vitest.globTestSpecifications() };
	} catch (error) {
		await vitest.close();
		throw error;
	}
}

for (const suite of SHARDED_SUITES) {
	test(
		`the configured sequencer runs every ${suite.name} file in exactly one shard, for any shard count`,
		async () => {
			for (const count of SHARD_COUNTS) {
				const shards: string[][] = [];
				let all: string[] = [];
				for (let index = 1; index <= count; index++) {
					const { vitest, specifications } = await suiteSpecifications(suite, `${index}/${count}`);
					try {
						const sequencer = new vitest.config.sequence.sequencer(vitest);
						// The config's own copy of the module, so compare by name rather than by identity.
						assert.equal(sequencer.constructor.name, DurationSequencer.name);
						all = specifications.map((specification) => specification.moduleId).sort();
						shards.push(
							(await sequencer.shard([...specifications])).map((specification) => specification.moduleId),
						);
					} finally {
						await vitest.close();
					}
				}
				assert.ok(all.length > count, `the ${suite.name} suite globbed no files`);
				if (suite === INTEGRATION) {
					assert.ok(
						all.some((file) => file.endsWith("interactive-event-loop-guard.test.ts")),
						"the interactive event-loop guard is not sharded",
					);
				}
				assert.ok(
					shards.every((shard) => shard.length > 0),
					`a shard of ${count} has no files`,
				);
				assert.deepEqual(
					shards.flat().sort(),
					all,
					`with ${count} shards, a file ran in no shard or in more than one`,
				);
			}
		},
		REAL_VITEST_TIMEOUT_MS,
	);
}

test(
	"the coding-agent suite does not collect a scratch suite another test is running under its test directory",
	async () => {
		// test-suite-runner.test.ts runs a suite of its own through the coding-agent config, so for the half minute that test
		// takes, the suite file sits under packages/coding-agent/test/. A run globbing the coding-agent suite meanwhile, as
		// the sharding check above does once per shard, saw it in some shards' file lists and not in others', and on a
		// Windows unit shard 258 files went to two shards while 256 went to none.
		const scratch = mkdtempSync(join(repository, "packages/coding-agent/test/.tmp-test-suite-runner-real-"));
		try {
			writeFileSync(join(scratch, "suite.test.ts"), 'import { test } from "vitest";\ntest("scratch", () => {});\n');
			const { vitest, specifications } = await suiteSpecifications(CODING_AGENT, "1/1");
			await vitest.close();
			assert.ok(specifications.length > 0, "the coding-agent suite globbed no files");
			assert.deepEqual(
				specifications
					.map((specification) => specification.moduleId)
					.filter((file) => file.includes(".tmp-test-suite-runner-real-")),
				[],
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	},
	REAL_VITEST_TIMEOUT_MS,
);

test(
	"the configured sequencer starts a shard's longest recorded files first",
	async () => {
		const { vitest, specifications } = await suiteSpecifications(INTEGRATION, "1/1");
		try {
			const sequencer = new vitest.config.sequence.sequencer(vitest);
			const record = (
				JSON.parse(await readText(join(vitest.config.root, "test/helpers/test-file-durations.json"))) as Record<
					"linux" | "win32",
					Record<string, number>
				>
			)[process.platform === "win32" ? "win32" : "linux"];
			const sorted = await sequencer.sort([...specifications]);
			assert.equal(sorted.length, specifications.length);
			assert.equal(sorted.at(-1)?.project.name, "integration-ui-gate");
			const weights = sorted
				.slice(0, -1)
				.map(
					(specification) =>
						record[relative(vitest.config.root, specification.moduleId).replaceAll("\\", "/")] ?? UNKNOWN_FILE_MS,
				);
			assert.deepEqual(
				weights,
				[...weights].sort((a, b) => b - a),
			);
		} finally {
			await vitest.close();
		}
	},
	REAL_VITEST_TIMEOUT_MS,
);

test("recording durations refuses reports that hold no test file, and averages the rest by repository path", () => {
	assert.throws(() => testFileDurations([{ testResults: [] }]), /no test file/);
	assert.throws(
		() =>
			testFileDurations([
				{ testResults: [{ name: "/runner/work/atomic/scripts/run-test-suite.ts", startTime: 0, endTime: 5_000 }] },
			]),
		/no test file/,
	);
	assert.deepEqual(
		testFileDurations([
			{ testResults: [{ name: "/runner/work/atomic/atomic/test/unit/a.test.ts", startTime: 0, endTime: 4_000 }] },
			{
				testResults: [
					{ name: "D:\\a\\atomic\\atomic\\test\\unit\\a.test.ts", startTime: 10, endTime: 6_010 },
					{
						name: "D:\\a\\atomic\\atomic\\packages\\coding-agent\\test\\b.test.ts",
						startTime: 0,
						endTime: 1_000,
					},
				],
			},
		]),
		{ "test/unit/a.test.ts": 5_000, "packages/coding-agent/test/b.test.ts": 1_000 },
	);
});

test("recording durations leaves out a file that failed, whose time is when it died or timed out", () => {
	const file = (path: string, ms: number, status: string) => ({
		name: `/runner/work/atomic/atomic/${path}`,
		startTime: 0,
		endTime: ms,
		status,
	});
	assert.deepEqual(
		testFileDurations([
			{ testResults: [file("test/unit/a.test.ts", 9_000, "passed"), file("test/unit/b.test.ts", 40_000, "failed")] },
			{
				testResults: [file("test/unit/a.test.ts", 131_000, "failed"), file("test/unit/b.test.ts", 4_000, "passed")],
			},
			{ testResults: [file("test/unit/a.test.ts", 11_000, "passed")] },
		]),
		{ "test/unit/a.test.ts": 10_000, "test/unit/b.test.ts": 4_000 },
	);
	assert.throws(
		() => testFileDurations([{ testResults: [file("test/unit/a.test.ts", 9_000, "failed")] }]),
		/no test file/,
	);
});

test("a file whose measured duration strays far from its recorded weight is reported as drift, noise is not", () => {
	const report = (entries: Record<string, number>) => ({
		testResults: Object.entries(entries).map(([path, ms]) => ({
			name: `/runner/work/atomic/atomic/${path}`,
			startTime: 1_000,
			endTime: 1_000 + ms,
		})),
	});
	const record = {
		"test/unit/grown.test.ts": 25_000,
		"test/unit/shrunk.test.ts": 90_000,
		"test/unit/noisy.test.ts": 60_000,
		"test/unit/small.test.ts": 1_000,
	};
	const drift = durationDrift(
		report({
			// New and far heavier than an unknown file's weight: the shard that drew it runs long.
			"test/unit/new-heavy.test.ts": 121_000,
			// New and light: weighted as unknown, which is close enough.
			"test/unit/new-light.test.ts": 3_000,
			"test/unit/grown.test.ts": 174_000,
			"test/unit/shrunk.test.ts": 20_000,
			// A busy runner's variance, not a stale record.
			"test/unit/noisy.test.ts": 85_000,
			// Ten times its record, but seconds either way.
			"test/unit/small.test.ts": 10_000,
		}),
		record,
	);
	assert.deepEqual(drift, [
		{ path: "test/unit/grown.test.ts", measuredMs: 174_000, recordedMs: 25_000 },
		{ path: "test/unit/new-heavy.test.ts", measuredMs: 121_000, recordedMs: undefined },
		{ path: "test/unit/shrunk.test.ts", measuredMs: 20_000, recordedMs: 90_000 },
	]);
	assert.deepEqual(durationDrift({ testResults: [] }, record), []);
});
