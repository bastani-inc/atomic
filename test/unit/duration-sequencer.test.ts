import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { test } from "vitest";
import { createVitest } from "vitest/node";
import { durationDrift, testFileDurations } from "../../scripts/test-file-durations.js";
import {
	DurationSequencer,
	FILE_OVERHEAD_MS,
	SHARD_WORKERS,
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

test("shards balance their expected wall time: the longest file or the total over the shard's workers", () => {
	// One long file, plus as many short ones as two shards' workers take in about its time: summing weights alone
	// (plain longest-processing-time-first) would put a share of the short files beside the long one and finish
	// that shard last.
	const record: Record<string, number> = { "test/integration/long.test.ts": 100_000 };
	for (let i = 0; i < 4 * SHARD_WORKERS; i++)
		record[`test/integration/short-${String(i).padStart(2, "0")}.test.ts`] = 23_000;
	const weight = (path: string) => (record[path] ?? UNKNOWN_FILE_MS) + FILE_OVERHEAD_MS;
	const paths = Object.keys(record);
	const walls = [1, 2].map((index) => {
		const shard = shardByDuration(paths, record, index, 2);
		return Math.max(...shard.map(weight), shard.reduce((sum, path) => sum + weight(path), 0) / SHARD_WORKERS);
	});
	assert.ok(Math.max(...walls) <= 1.1 * Math.min(...walls), `unbalanced shards: ${walls.join(", ")}`);
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
	{ name: "integration", projects: ["integration", "integration-load-gate"] },
	{ name: "coding-agent", root: "packages/coding-agent" },
];

const INTEGRATION = SHARDED_SUITES[1]!;

/**
 * Shard counts to split each suite into. CI runs three or four per suite today; every file must run exactly once for
 * any count, so the check does not follow the workflow's numbers.
 */
const SHARD_COUNTS = [2, 3, 4, 5];

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
						all.some((file) => file.endsWith("workflow-pool-load-gate.test.ts")),
						"the load gate is not sharded",
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
			// The load gate's project runs after the rest (its later groupOrder), so it comes last.
			assert.equal(sorted.at(-1)?.project.name, "integration-load-gate");
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
