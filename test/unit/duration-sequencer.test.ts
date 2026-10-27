import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { test } from "vitest";
import { createVitest } from "vitest/node";
import { testFileDurations } from "../../scripts/test-file-durations.js";
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

/** Structural: each case starts a real Vitest instance on the repository config and globs the integration suite. */
const REAL_VITEST_TIMEOUT_MS = 60_000;

async function integrationSpecifications(shard: string) {
	const vitest = await createVitest("test", { watch: false, run: true, project: ["integration"], shard });
	try {
		return { vitest, specifications: await vitest.globTestSpecifications() };
	} catch (error) {
		await vitest.close();
		throw error;
	}
}

test(
	"the configured sequencer runs every integration file in exactly one of the CI shards",
	async () => {
		const count = 3;
		const shards: string[][] = [];
		let all: string[] = [];
		for (let index = 1; index <= count; index++) {
			const { vitest, specifications } = await integrationSpecifications(`${index}/${count}`);
			try {
				const sequencer = new vitest.config.sequence.sequencer(vitest);
				// The config's own copy of the module, so compare by name rather than by identity.
				assert.equal(sequencer.constructor.name, DurationSequencer.name);
				all = specifications.map((specification) => specification.moduleId).sort();
				shards.push((await sequencer.shard([...specifications])).map((specification) => specification.moduleId));
			} finally {
				await vitest.close();
			}
		}
		assert.ok(all.length > count, "the integration suite globbed no files");
		assert.ok(shards.every((shard) => shard.length > 0));
		assert.deepEqual(shards.flat().sort(), all, "a file ran in no shard or in more than one");
	},
	REAL_VITEST_TIMEOUT_MS,
);

test(
	"the configured sequencer starts a shard's longest recorded files first",
	async () => {
		const { vitest, specifications } = await integrationSpecifications("1/1");
		try {
			const sequencer = new vitest.config.sequence.sequencer(vitest);
			const record = (
				JSON.parse(await readText(join(vitest.config.root, "test/helpers/test-file-durations.json"))) as Record<
					"linux" | "win32",
					Record<string, number>
				>
			)[process.platform === "win32" ? "win32" : "linux"];
			const weights = (await sequencer.sort([...specifications])).map(
				(specification) =>
					record[relative(vitest.config.root, specification.moduleId).replaceAll("\\", "/")] ?? UNKNOWN_FILE_MS,
			);
			assert.equal(weights.length, specifications.length);
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
