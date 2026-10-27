import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { test } from "vitest";
import { createVitest } from "vitest/node";
import { integrationFileDurations } from "../../scripts/integration-file-durations.js";
import { DurationSequencer, shardByDuration, UNKNOWN_FILE_MS } from "../helpers/duration-sequencer.js";
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

test("the longest files go to different shards and the totals stay balanced", () => {
	const weight = (path: string) => durations[path as keyof typeof durations] ?? UNKNOWN_FILE_MS;
	const shards = [1, 2, 3].map((index) => shardByDuration(files, durations, index, 3));
	const owner = (path: string) => shards.findIndex((shard) => shard.includes(path));
	assert.equal(new Set(["a", "b", "c"].map((name) => owner(`test/integration/${name}.test.ts`))).size, 3);
	const totals = shards.map((shard) => shard.reduce((sum, path) => sum + weight(path), 0));
	// 851 s over three shards: the heaviest file alone (300 s) bounds the best possible split.
	assert.ok(Math.max(...totals) <= 300_000, `unbalanced shards: ${totals.join(", ")}`);
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
		const count = 4;
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
			const record = JSON.parse(
				await readText(join(vitest.config.root, "test/helpers/integration-file-durations.json")),
			) as Record<string, number>;
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

test("recording durations refuses reports that hold no integration file, and averages the rest", () => {
	assert.throws(() => integrationFileDurations([{ testResults: [] }]), /no integration test file/);
	assert.throws(
		() =>
			integrationFileDurations([
				{ testResults: [{ name: "/runner/work/atomic/test/unit/a.test.ts", startTime: 0, endTime: 5_000 }] },
			]),
		/no integration test file/,
	);
	assert.deepEqual(
		integrationFileDurations([
			{ testResults: [{ name: "/runner/work/atomic/test/integration/a.test.ts", startTime: 0, endTime: 4_000 }] },
			{ testResults: [{ name: "C:\\work\\atomic\\test\\integration\\a.test.ts", startTime: 10, endTime: 6_010 }] },
		]),
		{ "test/integration/a.test.ts": 5_000 },
	);
});
