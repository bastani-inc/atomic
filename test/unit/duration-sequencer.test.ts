import assert from "node:assert/strict";
import { test } from "vitest";
import { shardByDuration, UNKNOWN_FILE_MS } from "../helpers/duration-sequencer.js";

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
