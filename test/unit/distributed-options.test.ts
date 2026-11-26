import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseOptions, plan, replayOptions, shuffled } from "../distributed/harness/options.mjs";

const fixedRandom = () => 0.5;

describe("distributed run options", () => {
	test("by default every suite runs, the security gate first, with the replica and every fault", () => {
		const options = parseOptions([], fixedRandom);
		const planned = plan(options);
		assert.deepEqual(
			planned.suites.map((suite) => [suite.name, suite.action]),
			[
				["security", "run"],
				["intercom-routing", "run"],
				["broker-failover", "run"],
				["session-handoff", "run"],
				["resume", "run"],
				["fork", "run"],
				["wake-ups", "run"],
				["replica", "run"],
				["database-faults", "run"],
			],
		);
		assert.deepEqual(planned.services, ["primary", "pgbouncer", "replica"]);
		assert.equal(planned.faults.length, 10);
		assert.equal(options.seed, 1073741824);
	});

	test("the security gate runs even when only other suites are chosen", () => {
		const planned = plan(parseOptions(["--suite", "fork,resume"], fixedRandom));
		assert.deepEqual(
			planned.suites.map((suite) => suite.name),
			["security", "resume", "fork"],
		);
		assert.deepEqual(planned.faults, [], "no faults without database-faults");
	});

	test("without the replica the replica suite is skipped, and without faults so is database-faults", () => {
		const planned = plan(parseOptions(["--no-replica", "--faults", "none"], fixedRandom));
		assert.deepEqual(planned.services, ["primary", "pgbouncer"]);
		assert.deepEqual(
			planned.suites.filter((suite) => suite.action === "skip").map((suite) => [suite.name, suite.reason]),
			[
				["replica", "the run has no replica (--no-replica)"],
				["database-faults", "no faults chosen (--faults none)"],
			],
		);
	});

	test("unknown suites and faults, too few nodes, and a malformed run id are refused", () => {
		assert.throws(() => parseOptions(["--suite", "smoke"]), /unknown suite: smoke/);
		assert.throws(() => parseOptions(["--faults", "full-disk"]), /unknown fault: full-disk/);
		assert.throws(() => parseOptions(["--nodes", "2"]), /at least 3/);
		assert.throws(() => parseOptions(["--reuse", "../elsewhere"]), /needs a run id/);
		assert.throws(() => parseOptions(["--seed"]), /--seed needs a value/);
		assert.throws(() => parseOptions(["--chaos", "partition"]), /unknown option --chaos/);
	});

	test("one seed always puts the faults in the same order, and another seed in another", () => {
		const faults = ["a", "b", "c", "d", "e", "f"];
		assert.deepEqual(shuffled(faults, 42), shuffled(faults, 42));
		assert.deepEqual([...shuffled(faults, 42)].sort(), faults);
		assert.notDeepEqual(shuffled(faults, 42), shuffled(faults, 43));
	});

	test("a replay takes the suites, faults, nodes, replica and seed a report recorded", () => {
		const replayed = replayOptions(parseOptions(["--out", "/tmp/runs"], fixedRandom), {
			options: {
				suites: ["fork"],
				faults: ["disk-full", "primary-pause"],
				nodes: 4,
				replica: false,
				seed: 7,
				diskMb: 512,
			},
		});
		assert.deepEqual(
			{
				suites: replayed.suites,
				faults: replayed.faults,
				nodes: replayed.nodes,
				replica: replayed.replica,
				seed: replayed.seed,
				diskMb: replayed.diskMb,
				out: replayed.out,
			},
			{
				suites: ["fork"],
				faults: ["disk-full", "primary-pause"],
				nodes: 4,
				replica: false,
				seed: 7,
				diskMb: 512,
				out: "/tmp/runs",
			},
		);
		assert.throws(() => replayOptions(parseOptions([]), {}), /records no options/);
	});
});
