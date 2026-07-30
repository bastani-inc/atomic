/**
 * The migration's own coverage gate, tested.
 *
 * This script was committed unreferenced: no package script, no workflow step,
 * no test, and not matched by `scripts/*.test.mjs`. Its `--expect-skipped` flag
 * exists precisely to catch a test that ran before and skips now -- which is
 * exactly what happened to the bun:sqlite suites when they moved to Node, and
 * nothing ran the script at them. A verification tool nobody runs is worth
 * less than no tool, because it reads as though the property was checked.
 *
 * `node --test scripts/*.test.mjs` runs in the static-checks CI job, so the
 * rules below are executed on every push. The comparison itself is still a
 * migration-time gate: it needs a baseline captured from the runner being
 * replaced, and after this change there is no such runner left to capture from.
 * AGENTS.md records the four invocations that produced this PR's evidence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	compareInventories,
	parseArgs,
	readInventory,
	unionInventories,
} from "./compare-test-inventory.mjs";

/** A vitest JSON report with the statuses spelled out. */
function vitestReport(tests) {
	return JSON.stringify({
		numTotalTests: tests.length,
		testResults: [
			{
				name: "/repo/test/unit/a.test.ts",
				assertionResults: tests.map(([title, status = "passed", scopes = []]) => ({
					ancestorTitles: scopes,
					title,
					status,
				})),
			},
		],
	});
}

/** Bun's stdout, in the shape its reporter actually prints. */
function bunLog(records) {
	return records.map(([status, name, duration]) => `(${status}) ${name}${duration ? ` [${duration}ms]` : ""}`).join("\n");
}

test("a bun log and a vitest report are read without being declared", () => {
	const bun = readInventory(bunLog([["pass", "alpha", 12], ["skip", "beta"], ["fail", "gamma", 3]]));
	assert.equal(bun.format, "bun");
	assert.deepEqual([...bun.names].sort(), ["alpha", "beta", "gamma"]);
	assert.deepEqual([...bun.skipped], ["beta"]);

	const vitest = readInventory(vitestReport([["alpha"], ["beta", "skipped"], ["gamma", "failed"]]));
	assert.equal(vitest.format, "vitest");
	assert.deepEqual([...vitest.names].sort(), ["alpha", "beta", "gamma"]);
	assert.deepEqual([...vitest.skipped], ["beta"]);
});

test("a vitest name carries its describe scope, so same-named tests stay distinct", () => {
	const inventory = readInventory(
		vitestReport([["shared", "passed", ["slow group"]], ["shared", "passed", ["fast group"]]]),
	);
	assert.deepEqual([...inventory.names].sort(), ["fast group > shared", "slow group > shared"]);
});

test("ANSI colour in a bun log does not hide a test name", () => {
	const inventory = readInventory("\u001b[32m(pass)\u001b[0m alpha \u001b[2m[12ms]\u001b[0m");
	assert.deepEqual([...inventory.names], ["alpha"]);
});

test("a test that ran in the baseline and only skips now fails the comparison", () => {
	const before = readInventory(bunLog([["pass", "reads writes and searches SQLite selectors", 40]]));
	const after = readInventory(vitestReport([["reads writes and searches SQLite selectors", "skipped"]]));
	const result = compareInventories(before, after);
	// The name is still present, and the suite is still green. Only the skip set
	// tells the truth, which is the whole point of the check.
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.newlySkipped, ["reads writes and searches SQLite selectors"]);
	assert.equal(result.failed, true);
	assert.match(result.report, /ran in the baseline and only skip now/);
});

test("a skip that was already a skip is not reported as a regression", () => {
	const before = readInventory(bunLog([["skip", "windows only", 0], ["pass", "alpha", 1]]));
	const after = readInventory(vitestReport([["windows only", "skipped"], ["alpha"]]));
	const result = compareInventories(before, after);
	assert.deepEqual(result.newlySkipped, []);
	assert.equal(result.failed, false);
});

test("a dropped test fails even when the totals are made up elsewhere", () => {
	const before = readInventory(bunLog([["pass", "alpha", 1], ["pass", "beta", 1]]));
	const after = readInventory(vitestReport([["alpha"], ["brand new"]]));
	const result = compareInventories(before, after);
	assert.deepEqual(result.missing, ["beta"]);
	assert.deepEqual(result.added, ["brand new"]);
	assert.equal(result.failed, true);
});

test("a rename passes only when it is declared, and is echoed for review", () => {
	const before = readInventory(bunLog([["pass", "old name", 1]]));
	const after = readInventory(vitestReport([["new name"]]));
	assert.equal(compareInventories(before, after).failed, true);

	const reviewed = compareInventories(before, after, { renames: new Map([["old name", "new name"]]) });
	assert.equal(reviewed.failed, false);
	assert.match(reviewed.report, /~ old name => new name/);
});

test("a suite split across runtimes is compared as the union of its parts", () => {
	const before = readInventory(bunLog([["pass", "node side", 1], ["pass", "sqlite side", 1]]));
	const node = readInventory(vitestReport([["node side"]]));
	const bun = readInventory(vitestReport([["sqlite side"]]));

	// Either half alone looks like a loss, which is how a split would hide one.
	assert.equal(compareInventories(before, node).failed, true);
	assert.equal(compareInventories(before, bun).failed, true);
	assert.equal(compareInventories(before, unionInventories([node, bun])).failed, false);
});

test("the frozen floor, the skip ceiling and --expect-skipped all fail closed", () => {
	const before = readInventory(bunLog([["pass", "alpha", 1]]));
	const after = readInventory(vitestReport([["alpha"]]));
	assert.equal(compareInventories(before, after, { min: 2 }).failed, true);
	assert.match(compareInventories(before, after, { min: 2 }).report, /below the frozen floor of 2/);

	const skipped = readInventory(vitestReport([["alpha", "skipped"]]));
	assert.equal(compareInventories(before, skipped, { maxSkipped: 0 }).failed, true);

	// A skip that vanished is as much a change as one that appeared: it means the
	// declaration was deleted or silently enabled.
	const bothSkipped = readInventory(bunLog([["skip", "alpha"]]));
	const enabled = readInventory(vitestReport([["alpha"]]));
	const result = compareInventories(bothSkipped, enabled, { expectSkipped: ["alpha"] });
	assert.equal(result.failed, true);
	assert.match(result.report, /must still be skipped, not dropped or silently enabled/);
});

test("arguments are parsed strictly, and a single candidate is not assumed", () => {
	const options = parseArgs([
		"--baseline", "base.log",
		"--candidate", "agent.json",
		"--candidate", "agent-bun.json",
		"--min", "47",
		"--max-skipped", "0",
		"--expect-skipped", "windows only",
		"--allow-renamed", "old => new",
	]);
	assert.equal(options.baseline, "base.log");
	assert.deepEqual(options.candidates, ["agent.json", "agent-bun.json"]);
	assert.equal(options.min, 47);
	assert.equal(options.maxSkipped, 0);
	assert.deepEqual(options.expectSkipped, ["windows only"]);
	assert.equal(options.renames.get("old"), "new");

	assert.throws(() => parseArgs(["--baseline", "base.log"]), /at least one --candidate/);
	assert.throws(() => parseArgs(["--candidate", "a.json"]), /--baseline/);
	assert.throws(() => parseArgs(["--nope", "x"]), /Unknown argument/);
	assert.throws(
		() => parseArgs(["--baseline", "b", "--candidate", "c", "--allow-renamed", "no arrow"]),
		/expects "old => new"/,
	);
});
