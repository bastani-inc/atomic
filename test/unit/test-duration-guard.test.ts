import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	declaredBudgets,
	declaredTimeouts,
	evaluateDurations,
	parseVitestReport,
	renderDurationTable,
	reportedTestCount,
	resolveDefaultTimeoutMs,
	WARN_RATIO,
} from "../../scripts/test-duration-guard.js";
import { readText } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** A vitest JSON report, in the shape its reporter emits. */
function report(
	files: { file: string; tests: { scopes?: string[]; title: string; status: string; duration?: number | null }[] }[],
	rootDir = root,
): string {
	const testResults = files.map((entry) => ({
		name: resolve(rootDir, entry.file),
		assertionResults: entry.tests.map((assertion) => ({
			ancestorTitles: assertion.scopes ?? [],
			title: assertion.title,
			fullName: [...(assertion.scopes ?? []), assertion.title].join(" "),
			status: assertion.status,
			duration: assertion.duration ?? null,
		})),
	}));
	const numTotalTests = files.reduce((total, entry) => total + entry.tests.length, 0);
	return JSON.stringify({ numTotalTests, testResults });
}

const SAMPLE_REPORT = report([
	{
		file: "test/unit/alpha.test.ts",
		tests: [
			{ scopes: ["group"], title: "quick assertion", status: "passed", duration: 0.28 },
			{ scopes: ["group"], title: "slow child process", status: "failed", duration: 5001.1 },
			{ scopes: ["group"], title: "skipped case", status: "pending" },
		],
	},
	{
		file: "test/unit/beta.test.ts",
		tests: [{ title: "loads builtin pi package resources", status: "passed", duration: 10672 }],
	},
]);

test("duration parsing attributes each sample to its file and skips tests that never ran", () => {
	const samples = parseVitestReport(SAMPLE_REPORT, root);
	assert.deepEqual(
		samples.map((sample) => [sample.file, sample.fullName, sample.status, sample.durationMs]),
		[
			["test/unit/alpha.test.ts", "group > quick assertion", "pass", 0.28],
			["test/unit/alpha.test.ts", "group > slow child process", "fail", 5001.1],
			["test/unit/beta.test.ts", "loads builtin pi package resources", "pass", 10672],
		],
	);
	// A pending test carries no duration; scoring a zero against a budget would
	// pad the table with rows that can never drift.
	assert.equal(reportedTestCount(SAMPLE_REPORT), 4);
	assert.deepEqual(parseVitestReport('{"numTotalTests":0,"testResults":[]}', root), []);
});

/**
 * The reporter names files absolutely. Left alone, no source file would ever be
 * found relative to the repository root, and every explicit per-test timeout
 * would silently degrade to the suite default -- the same class of failure the
 * old parser hit when an Actions log-group marker was left in the path.
 */
test("reported absolute file paths are normalised to repository-relative posix paths", () => {
	const absolute = JSON.stringify({
		numTotalTests: 1,
		testResults: [
			{
				name: join(root, "test", "unit", "win.test.ts"),
				assertionResults: [{ ancestorTitles: [], title: "a", status: "passed", duration: 1 }],
			},
		],
	});
	assert.equal(parseVitestReport(absolute, root)[0]?.file, "test/unit/win.test.ts");
	// A report from another checkout stays usable rather than becoming a path
	// traversal out of the root.
	const relative = JSON.stringify({
		numTotalTests: 1,
		testResults: [
			{ name: "test/unit/win.test.ts", assertionResults: [{ title: "a", status: "passed", duration: 1 }] },
		],
	});
	assert.equal(parseVitestReport(relative, root)[0]?.file, "test/unit/win.test.ts");
});

test("an explicit budget still resolves from the file path the report names", () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-duration-paths-"));
	try {
		writeFileSync(join(directory, "suite.test.ts"), ['test("declared", async () => {', "}, 60_000);"].join("\n"));
		const scored = evaluateDurations(
			report(
				[{ file: "suite.test.ts", tests: [{ title: "declared", status: "passed", duration: 100 }] }],
				directory,
			),
			30_000,
			directory,
		);
		assert.equal(scored.samples[0]?.timeoutMs, 60_000);
		assert.equal(scored.samples[0]?.explicit, true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a run that reports no per-test durations is reported blind, not clean", () => {
	const blind = JSON.stringify({ numTotalTests: 3, testResults: [] });
	const scored = evaluateDurations(blind, 30_000, root);
	assert.equal(scored.ranTests, 3);
	assert.equal(scored.blind, true);
	assert.match(renderDurationTable(scored), /tests ran but the reporter emitted no durations/);
	// Nothing ran at all is not blindness, and must not be reported as such.
	const empty = evaluateDurations('{"numTotalTests":0,"testResults":[]}', 30_000, root);
	assert.equal(empty.blind, false);
	// Without a resolvable budget the gate is off, and an unmeasured run is not
	// escalated into a failure the suite never opted into.
	assert.equal(evaluateDurations(blind, undefined, root).blind, false);
});

/**
 * The old parser read Bun's stdout, where 127 of 4417 unit tests printed a
 * `(pass)` line with no `[Nms]` and were therefore never scored. The JSON
 * reporter emits a record for every completed test, so coverage is total: this
 * is the concrete improvement the rewrite claims, asserted rather than assumed.
 */
test("every reported test is scored, including ones that printed no duration under Bun", () => {
	const scored = evaluateDurations(SAMPLE_REPORT, 30_000, root);
	assert.equal(scored.samples.length, 3);
	assert.equal(scored.ranTests, 4);
	assert.equal(scored.blind, false);
	assert.match(renderDurationTable(scored), /Samples: 3 of 4 test\(s\) run/);
});

test("explicit timeouts are resolved from both declaration shapes and never from nested callbacks", () => {
	const source = [
		'test("one line", async () => {',
		"  await wait();",
		"}, 60_000);",
		"",
		'test("multi line", async () => {',
		"  setTimeout(() => {",
		"  }, 25);",
		"},",
		"  240_000,",
		");",
		"",
		"const SLOW = 90_000;",
		'test("named constant", async () => {',
		"}, SLOW);",
		"",
		'test("no explicit budget", async () => {',
		"  const poll = () => new Promise((resolve) => {",
		"    setTimeout(resolve, 10);",
		"  }, 5);",
		"});",
	].join("\n");
	const declared = declaredTimeouts(source);
	assert.equal(declared.get("one line"), 60_000);
	assert.equal(declared.get("multi line"), 240_000);
	assert.equal(declared.get("named constant"), 90_000);
	assert.equal(declared.get("no explicit budget"), undefined);
	assert.equal(declared.size, 3);
});

/**
 * A declaration bound to a local alias is still a declaration.
 *
 * `declarationPattern` reads local `const <name> = ... test` bindings for
 * exactly this shape, which several suites use to make a whole file conditional.
 * Missing it does not fail anything: the alias's tests silently fall back to the
 * suite default, so an explicit structural budget stops being honoured and the
 * gate starts scoring those tests against a ceiling they never had. Both
 * argument shapes are covered because the alias path and the tail parser are
 * independent.
 */
test("a test declared through a local alias keeps its explicit budget", () => {
	const source = [
		"const built = existsSync(dist);",
		"const runTest = built ? test : test.skip;",
		"const describeIf = built ? describe : describe.skip;",
		"",
		'runTest("aliased one line", async () => {',
		"}, 60_000);",
		"",
		'runTest("aliased multi line", async () => {',
		"  await build();",
		"},",
		"  240_000,",
		");",
		"",
		"const runIt = built ? it : it.skip;",
		'runIt("aliased it", async () => {',
		"}, 90_000);",
		"",
		'runTest("aliased without a budget", async () => {',
		"});",
	].join("\n");
	const declared = declaredTimeouts(source);
	assert.equal(declared.get("aliased one line"), 60_000);
	assert.equal(declared.get("aliased multi line"), 240_000);
	assert.equal(declared.get("aliased it"), 90_000);
	assert.equal(declared.get("aliased without a budget"), undefined);
	assert.equal(declared.size, 3);
});

test("a scoped explicit budget stays in its own scope and never leaks to a same name", () => {
	const source = [
		'describe("slow group", () => {',
		'  test("shared name", async () => {',
		"  }, 90_000);",
		"});",
		"",
		'describe("fast group", () => {',
		'  test("shared name", async () => {',
		"  });",
		"});",
	].join("\n");
	const declared = declaredTimeouts(source);
	assert.equal(declared.get("slow group > shared name"), 90_000);
	assert.equal(declared.get("fast group > shared name"), undefined);
	assert.equal(declared.get("shared name"), undefined);

	const directory = mkdtempSync(join(tmpdir(), "atomic-duration-scope-"));
	try {
		writeFileSync(join(directory, "scoped.test.ts"), source);
		const scored = evaluateDurations(
			report(
				[
					{
						file: "scoped.test.ts",
						tests: [
							{ scopes: ["slow group"], title: "shared name", status: "passed", duration: 40_000 },
							{ scopes: ["fast group"], title: "shared name", status: "passed", duration: 40_000 },
						],
					},
				],
				directory,
			),
			30_000,
			directory,
		);
		const budgets = new Map(scored.samples.map((sample) => [sample.fullName, sample.timeoutMs]));
		assert.equal(budgets.get("slow group > shared name"), 90_000);
		assert.equal(budgets.get("fast group > shared name"), 30_000);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("repository declarations resolve to their real budgets", async () => {
	const builtins = declaredTimeouts(await readText(join(root, "test/unit/coding-agent-builtin-workflows.test.ts")));
	// Keyed by the qualified name the reporter emits, never by the bare terminal name.
	assert.equal(builtins.get("coding-agent builtin resources > loads builtin pi package resources"), 120_000);
	assert.equal(builtins.get("loads builtin pi package resources"), undefined);
	const installed = declaredTimeouts(
		await readText(join(root, "test/integration/installed-package-node-extensions.test.ts")),
	);
	assert.equal(installed.get("installed @bastani/atomic loads builtin extensions under Node"), 240_000);
	const notification = declaredTimeouts(
		await readText(join(root, "test/unit/subagents-notification-content.test.ts")),
	);
	assert.equal(notification.size, 0, "no test may restate the suite default as an explicit lower budget");
});

test("the real sequential workflow reload declaration keeps its explicit timeout budget", () => {
	const file = "test/unit/workflow-run-state-real-reload.test.ts";
	const name =
		"user-global agent launch keeps its real publish watcher through resource and installed full reload (#3864)";
	const scored = evaluateDurations(
		report([{ file, tests: [{ title: name, status: "passed", duration: 21_611 }] }]),
		30_000,
		root,
	);
	const sample = scored.samples[0];
	assert.equal(sample?.timeoutMs, 120_000);
	assert.equal(sample?.explicit, true);
	assert.equal(sample?.ratio, 21_611 / 120_000);
	assert.deepEqual(scored.warnings, []);
});

// #3129: the test passed on Windows; the gate ignored its existing 60s + 5s budget.
test("built Node MCP ownership is scored against its declared timeout expression", () => {
	const scored = evaluateDurations(
		report([
			{
				file: "test/integration/sdk-builtin-host-parity-mcp-web.test.ts",
				tests: [{ title: "built Node lazy MCP HTTP ownership", status: "passed", duration: 25_265 }],
			},
		]),
		30_000,
		root,
	);
	assert.equal(scored.samples[0]?.timeoutMs, 65_000);
	assert.equal(scored.samples[0]?.explicit, true);
	assert.deepEqual(scored.warnings, []);
});

// #3129: a curried test.each call still has a per-test third-argument budget.
test("built Node table cases retain their existing structural budgets", () => {
	const cases = [
		[
			"built Node shared-subclass sibling reload and disposal preserve a pending workflow and exit naturally",
			28_140,
			60_000,
		],
		["built Node MCP diagnostics are quiet withoutSink=false", 23_414, 65_000],
		["built Node MCP diagnostics are quiet withoutSink=true", 23_328, 65_000],
	] as const;
	const scored = evaluateDurations(
		report([
			{
				file: "test/integration/sdk-builtin-host-parity-shared-siblings.test.ts",
				tests: [{ title: cases[0][0], duration: cases[0][1], status: "passed" }],
			},
			{
				file: "test/integration/sdk-builtin-host-parity-mcp-web.test.ts",
				tests: cases.slice(1).map(([title, duration]) => ({ title, duration, status: "passed" })),
			},
		]),
		30_000,
		root,
	);
	for (const [name, duration, budget] of cases) {
		const sample = scored.samples.find((entry) => entry.name === name);
		assert.equal(sample?.timeoutMs, budget);
		assert.equal(sample?.explicit, true);
		assert.equal(sample?.ratio, duration / budget);
	}
});

test("literal table budgets stay scoped and dynamic tables cannot borrow them", () => {
	const source = [
		"const PROCESS_TIMEOUT = 60_000;",
		'describe("explicit", () => {',
		"  test.each(",
		'    ["node", "bun"] as const,',
		"  )(",
		'    "host %s",',
		"    async () => {",
		"    },",
		"    PROCESS_TIMEOUT + 5_000,",
		"  );",
		"});",
		'describe("default", () => {',
		'  test.each(["node", "bun"])("host %s", async () => {});',
		"});",
		'test.each(computeRows())("dynamic %s", async () => {',
		"}, 90_000);",
		'test("unresolved sum", async () => {',
		"}, PROCESS_TIMEOUT + UNKNOWN);",
	].join("\n");
	assert.deepEqual(
		[...declaredTimeouts(source)],
		[
			["explicit > host node", 65_000],
			["explicit > host bun", 65_000],
		],
	);
});

test("real edited-flow CLI cases keep their structural budgets without lending them to other tests", () => {
	const file = "test/integration/workflow-tool-node-quit-cli.test.ts";
	const titles = [
		"built Node runtime refuses return after changed flow omits the interrupted tool",
		"built Node runtime refuses completed after changed flow omits the interrupted tool",
	];
	// Windows run 34249560629: both cases passed, but their curried declarations
	// hid the existing 240s budget from the guard, which falsely used 30s.
	const durations = [22_625.2187, 24_011.3266];
	const scored = evaluateDurations(
		report([
			{ file, tests: titles.map((title, index) => ({ title, status: "passed", duration: durations[index] })) },
		]),
		30_000,
		root,
	);
	assert.equal(scored.samples.length, 2);
	for (const [index, title] of titles.entries()) {
		const sample = scored.samples.find((entry) => entry.name === title);
		assert.equal(sample?.timeoutMs, 240_000);
		assert.equal(sample?.explicit, true);
		assert.equal(sample?.ratio, durations[index]! / 240_000);
	}
	assert.deepEqual(scored.warnings, []);

	const unbudgeted = evaluateDurations(
		report([
			{
				file,
				tests: [
					{ title: "the driver and the fixture agree on the state file name", status: "passed", duration: 24_000 },
					{ scopes: ["unrelated scope"], title: titles[0]!, status: "passed", duration: 24_000 },
				],
			},
			{
				file: "test/unit/grok-4-6-provider-migration.test.ts",
				tests: titles.map((title) => ({ title, status: "passed", duration: 24_000 })),
			},
		]),
		30_000,
		root,
	);
	assert.equal(unbudgeted.samples.length, 4);
	for (const sample of unbudgeted.samples) {
		assert.equal(sample.timeoutMs, 30_000);
		assert.equal(sample.explicit, false);
		assert.equal(sample.ratio, 0.8);
	}
	assert.deepEqual(unbudgeted.warnings, unbudgeted.samples);
});

test("foreign members, lookalike modifiers and dynamic tables do not donate timeout budgets", () => {
	const source = [
		"test.each(dynamicRows)(",
		'  "table wrapper",',
		"  async () => {",
		"  },",
		"  90_000,",
		");",
		"",
		'helper.test.sequential("foreign member", async () => {',
		"}, 180_000);",
		'test.sequentially("lookalike member", async () => {',
		"}, 240_000);",
		'test.skipIfNot(true)("lookalike condition", async () => {',
		"}, 240_000);",
	].join("\n");
	assert.deepEqual([...declaredTimeouts(source)], []);
});

// CI reported interactive-no-mcp-startup at "76.8 s of its 30 s budget (256%)" although it
// declares a 570 s budget: the guard read neither `test.skipIf(cond)(` nor `3 * (A + B + C)`.
test("conditional and chained declarations keep their explicit budgets", () => {
	const source = [
		"const TMUX_AVAILABLE = true;",
		"test.skipIf(!TMUX_AVAILABLE)(",
		'  "skip if",',
		"  async () => {",
		"  },",
		"  90_000,",
		");",
		'test.runIf(process.platform !== "win32")("run if", async () => {',
		"}, 60_000);",
		'it.skipIf(false).concurrent("it skip if, then concurrent", async () => {',
		"}, 45_000);",
		'test.concurrent.runIf(true)("concurrent, then run if", async () => {',
		"}, 50_000);",
		'test.runIf(true).each(["a", "b"] as const)("table %s", async () => {',
		"}, 55_000);",
		'describe.skipIf(false)("conditional scope", () => {',
		'  test("inside", async () => {',
		"  }, 70_000);",
		"});",
		'describe.runIf(true).concurrent("chained scope", () => {',
		'  it.runIf(true)("inside", async () => {',
		"  }, 75_000);",
		"});",
	].join("\n");
	assert.deepEqual(
		new Map(declaredTimeouts(source)),
		new Map([
			["skip if", 90_000],
			["run if", 60_000],
			["it skip if, then concurrent", 45_000],
			["concurrent, then run if", 50_000],
			["table a", 55_000],
			["table b", 55_000],
			["conditional scope > inside", 70_000],
			["chained scope > inside", 75_000],
		]),
	);
});

test("an options-object timeout applies to the test and a suite's timeout to the tests it encloses", () => {
	const source = [
		'test("own options", { timeout: 80_000 }, async () => {',
		"});",
		'describe("budgeted scope", { timeout: 85_000 }, () => {',
		'  test("inherits", async () => {',
		"  });",
		'  test("overrides", async () => {',
		"  }, 20_000);",
		'  describe("nested", () => {',
		'    test("inherits from its ancestor", async () => {',
		"    });",
		"  });",
		"});",
		'describe("numeric scope budget", () => {',
		'  test("inherits", async () => {',
		"  });",
		"}, 95_000);",
	].join("\n");
	assert.deepEqual(
		new Map(declaredTimeouts(source)),
		new Map([
			["own options", 80_000],
			["budgeted scope > inherits", 85_000],
			["budgeted scope > overrides", 20_000],
			["budgeted scope > nested > inherits from its ancestor", 85_000],
			["numeric scope budget > inherits", 95_000],
		]),
	);
});

test("timeouts written as constant expressions resolve to their value", () => {
	const source = [
		"const CLI_SCENARIO_TIMEOUT_MS = 120_000;",
		"const CLI_EXIT_TIMEOUT_MS = 60_000;",
		"const SCENARIO_OVERHEAD_MS = 10_000;",
		"const TOTAL_MS = 3 * (CLI_SCENARIO_TIMEOUT_MS + CLI_EXIT_TIMEOUT_MS + SCENARIO_OVERHEAD_MS);",
		"const TYPED: number = (TOTAL_MS / 2) as number;",
		'test("product of a sum", async () => {',
		"}, TOTAL_MS);",
		'test("inline arithmetic", async () => {',
		"}, 2 * CLI_SCENARIO_TIMEOUT_MS - CLI_EXIT_TIMEOUT_MS / 2);",
		'test("annotated and asserted", async () => {',
		"}, TYPED);",
	].join("\n");
	assert.deepEqual(
		new Map(declaredTimeouts(source)),
		new Map([
			["product of a sum", 570_000],
			["inline arithmetic", 210_000],
			["annotated and asserted", 285_000],
		]),
	);
});

test("a timeout built from constants imported from a sibling module resolves", () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-duration-import-"));
	try {
		writeFileSync(
			join(directory, "budgets.ts"),
			[
				"export const SHARED_MS = 45_000;",
				"const BASE_MS = 10_000;",
				"export const DERIVED_MS = SHARED_MS + BASE_MS;",
			].join("\n"),
		);
		writeFileSync(
			join(directory, "imported.test.ts"),
			[
				'import { DERIVED_MS as RENAMED_MS, SHARED_MS } from "./budgets.js";',
				'test("imported", async () => {',
				"}, SHARED_MS + 5_000);",
				'test("renamed", async () => {',
				"}, RENAMED_MS);",
			].join("\n"),
		);
		const scored = evaluateDurations(
			report(
				[
					{
						file: "imported.test.ts",
						tests: [
							{ title: "imported", status: "passed", duration: 40_000 },
							{ title: "renamed", status: "passed", duration: 40_000 },
						],
					},
				],
				directory,
			),
			30_000,
			directory,
		);
		const budgets = new Map(scored.samples.map((sample) => [sample.name, sample.timeoutMs]));
		assert.deepEqual(
			budgets,
			new Map([
				["imported", 50_000],
				["renamed", 55_000],
			]),
		);
		assert.deepEqual(scored.unresolved, []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an explicit timeout the guard cannot evaluate is reported unresolved, not scored against the default", () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-duration-unresolved-"));
	try {
		writeFileSync(
			join(directory, "unresolved.test.ts"),
			[
				"const PROCESS_TIMEOUT = 60_000;",
				'test("unresolved sum", async () => {',
				"}, PROCESS_TIMEOUT + UNKNOWN);",
				'test("computed", async () => {',
				"}, computeBudget());",
				'test("undeclared", async () => {',
				"});",
			].join("\n"),
		);
		const scored = evaluateDurations(
			report(
				[
					{
						file: "unresolved.test.ts",
						tests: [
							{ title: "unresolved sum", status: "passed", duration: 40_000 },
							{ title: "computed", status: "passed", duration: 40_000 },
							{ title: "undeclared", status: "passed", duration: 40_000 },
						],
					},
				],
				directory,
			),
			30_000,
			directory,
		);
		assert.deepEqual(scored.unresolved.map((sample) => sample.name).sort(), ["computed", "unresolved sum"]);
		// Only the test with no explicit budget is judged against the suite default.
		assert.deepEqual(
			scored.warnings.map((sample) => sample.name),
			["undeclared"],
		);
		assert.match(
			renderDurationTable(scored),
			/\| n\/a \| 40000\.00 ms \| unresolved \(explicit\) \| unresolved\.test\.ts \| computed \|/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

// Greptile PRRT_kwDOQHh8ns6wfPjy: with a named callback in the third slot, the
// options object still carries the budget; the callback is not a timeout.
test("an options-object timeout is read even when the body is a named callback", () => {
	const source = [
		"async function body() {}",
		"const arrow = async () => {};",
		'test("named function body", { timeout: 80_000 }, body);',
		'test("named arrow body", { timeout: 85_000 }, arrow);',
		'test("numeric budget after a named body", body, 90_000);',
	].join("\n");
	assert.deepEqual(
		new Map(declaredTimeouts(source)),
		new Map([
			["named function body", 80_000],
			["named arrow body", 85_000],
			["numeric budget after a named body", 90_000],
		]),
	);
	assert.deepEqual([...declaredBudgets(source).unresolved], []);
});

// Greptile PRRT_kwDOQHh8ns6wfPj5: a dynamic table's title pattern must not lend
// its budget to a plain test whose exact declaration carries none.
test("a declared test without a budget never borrows a dynamic table's budget", () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-duration-exact-first-"));
	try {
		writeFileSync(
			join(directory, "mixed.test.ts"),
			[
				'test.each(computeRows())("case %s", async () => {',
				"}, 120_000);",
				'test("case plain", async () => {',
				"});",
			].join("\n"),
		);
		const scored = evaluateDurations(
			report(
				[
					{
						file: "mixed.test.ts",
						tests: [
							{ title: "case dynamic", status: "passed", duration: 20_000 },
							{ title: "case plain", status: "passed", duration: 20_000 },
						],
					},
				],
				directory,
			),
			30_000,
			directory,
		);
		const budgets = new Map(scored.samples.map((sample) => [sample.name, [sample.timeoutMs, sample.explicit]]));
		assert.deepEqual(budgets.get("case dynamic"), [120_000, true]);
		assert.deepEqual(budgets.get("case plain"), [30_000, false]);
		assert.deepEqual(
			scored.warnings.map((sample) => sample.name),
			["case plain"],
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

// Dozens of repository suites name tests through template literals and dynamic
// tables (`on ${runtime.name}`, `test.each(rows)("%s ...")`). The reported names
// are only known at run time, so the declared budget is matched by its shape.
test("templated and dynamic-table titles keep their budgets by matching the reported name", () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-duration-template-"));
	try {
		writeFileSync(
			join(directory, "templated.test.ts"),
			[
				"const PROCESS_TIMEOUT_MS = 120_000;",
				"for (const runtime of runtimes) {",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text declaring a templated title
				"  describe(`containment on ${runtime.name}`, () => {",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text declaring a templated title
				"    test(`a ${runtime.label} rejection fails its run`, async () => {",
				"    }, PROCESS_TIMEOUT_MS);",
				"  });",
				"}",
				"test.each(computeRows())(",
				'  "%s: every message is delivered once",',
				"  async () => {",
				"  },",
				"  90_000,",
				");",
				'test("on windows only", async () => {',
				'}, process.platform === "win32" ? 60_000 : undefined);',
				'test("off windows only", async () => {',
				'}, process.platform !== "win32" ? 70_000 : undefined);',
			].join("\n"),
		);
		const scored = evaluateDurations(
			report(
				[
					{
						file: "templated.test.ts",
						tests: [
							{
								scopes: ["containment on node"],
								title: "a ctx.task rejection fails its run",
								status: "passed",
								duration: 40_000,
							},
							{ title: "idle: every message is delivered once", status: "passed", duration: 40_000 },
							{ title: "a ctx.task rejection fails its run", status: "passed", duration: 40_000 },
							{ title: "on windows only", status: "passed", duration: 40_000 },
							{ title: "off windows only", status: "passed", duration: 40_000 },
						],
					},
				],
				directory,
			),
			30_000,
			directory,
		);
		const budgets = new Map(scored.samples.map((sample) => [sample.fullName, sample.timeoutMs]));
		const windows = process.platform === "win32";
		assert.deepEqual(
			budgets,
			new Map([
				["containment on node > a ctx.task rejection fails its run", 120_000],
				["idle: every message is delivered once", 90_000],
				// Outside the templated scope the same terminal name borrows nothing.
				["a ctx.task rejection fails its run", 30_000],
				["on windows only", windows ? 60_000 : 30_000],
				["off windows only", windows ? 30_000 : 70_000],
			]),
		);
		assert.deepEqual(scored.unresolved, []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

/**
 * Score a scratch suite that imports a verbatim copy of the shared pool budget
 * helper (`test/helpers/pool-budget.ts`), with each test reported once.
 */
function scorePoolSuite(lines: string[], titles: string[]): Map<string, { timeoutMs: number; unresolved: boolean }> {
	const directory = mkdtempSync(join(tmpdir(), "atomic-duration-pool-"));
	try {
		mkdirSync(join(directory, "helpers"));
		mkdirSync(join(directory, "integration"));
		copyFileSync(
			join(root, "test/fixtures/duration-guard-pool-budget.ts"),
			join(directory, "helpers/pool-budget.ts"),
		);
		writeFileSync(join(directory, "integration/pool.test.ts"), lines.join("\n"));
		const scored = evaluateDurations(
			report(
				[
					{
						file: "integration/pool.test.ts",
						tests: titles.map((title) => ({ title, status: "passed", duration: 40_000 })),
					},
				],
				directory,
			),
			30_000,
			directory,
		);
		return new Map(
			scored.samples.map((sample) => [sample.name, { timeoutMs: sample.timeoutMs, unresolved: sample.unresolved }]),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

// The pool suites (#4043, #4051) declare budgets through `poolTestBudgetMs(pools)`
// and member reads of its result or of object literals built from it.
test("budgets from an imported pure helper and constant object members are scored", () => {
	const budgets = scorePoolSuite(
		[
			'import { POOL_CLEANUP_HEADROOM_MS, poolTestBudgetMs } from "../helpers/pool-budget.js";',
			"const BUDGET = poolTestBudgetMs(2);",
			"const SINGLE_POOL = poolTestBudgetMs(3);",
			"const TWO_POOLS = {",
			"\twaitMs: 2 * SINGLE_POOL.waitMs,",
			"\ttimeoutMs: 2 * SINGLE_POOL.waitMs + POOL_CLEANUP_HEADROOM_MS,",
			"} as const;",
			"const QUIT_RESUME_TIMEOUT_MS = 2 * SINGLE_POOL.waitMs + POOL_CLEANUP_HEADROOM_MS;",
			"const LOCAL_BUDGETS = { slow: 90_000, nested: { slower: 95_000 } };",
			"const twice = (ms: number) => 2 * ms;",
			"function padded(ms: number) {",
			"\tconst pad = 5_000;",
			"\treturn ms + pad;",
			"}",
			'test("helper result member", async () => {',
			"}, BUDGET.timeoutMs);",
			'test("object built from helper members", async () => {',
			"}, TWO_POOLS.timeoutMs);",
			'test("constant built from helper members", async () => {',
			"}, QUIT_RESUME_TIMEOUT_MS);",
			'test("inline helper call", async () => {',
			"}, poolTestBudgetMs(1).timeoutMs);",
			'test("local object member", async () => {',
			"}, LOCAL_BUDGETS.slow);",
			'test("nested object member", async () => {',
			"}, LOCAL_BUDGETS.nested.slower);",
			'test("local arrow helper", async () => {',
			"}, twice(30_000));",
			'test("local function helper with a const", async () => {',
			"}, padded(60_000));",
		],
		[
			"helper result member",
			"object built from helper members",
			"constant built from helper members",
			"inline helper call",
			"local object member",
			"nested object member",
			"local arrow helper",
			"local function helper with a const",
		],
	);
	assert.deepEqual(
		budgets,
		new Map([
			["helper result member", { timeoutMs: 165_000, unresolved: false }],
			["object built from helper members", { timeoutMs: 465_000, unresolved: false }],
			["constant built from helper members", { timeoutMs: 465_000, unresolved: false }],
			["inline helper call", { timeoutMs: 90_000, unresolved: false }],
			["local object member", { timeoutMs: 90_000, unresolved: false }],
			["nested object member", { timeoutMs: 95_000, unresolved: false }],
			["local arrow helper", { timeoutMs: 60_000, unresolved: false }],
			["local function helper with a const", { timeoutMs: 65_000, unresolved: false }],
		]),
	);
});

// #4051 wraps the pool helper in a local `testBudget(coldStarts)` that caps the
// budget with `Math.min` against a named constant.
test("a local helper capping the pool budget with Math.min is scored", () => {
	const budgets = scorePoolSuite(
		[
			'import { POOL_CLEANUP_HEADROOM_MS, poolTestBudgetMs } from "../helpers/pool-budget.js";',
			"const TEST_BUDGET_CAP_MS = 600_000;",
			"function testBudget(coldStarts: number): { readonly waitMs: number; readonly timeoutMs: number } {",
			"\tconst waitMs = Math.min(poolTestBudgetMs(coldStarts).waitMs, TEST_BUDGET_CAP_MS - POOL_CLEANUP_HEADROOM_MS);",
			"\treturn { waitMs, timeoutMs: waitMs + POOL_CLEANUP_HEADROOM_MS };",
			"}",
			"const ROOT_PROCESS_COLD_STARTS = 4;",
			"const POOL_COLD_STARTS = 3;",
			"const RESUMES = 4;",
			"const LEASE_STALL = testBudget(ROOT_PROCESS_COLD_STARTS);",
			"const RESUME_CYCLES = testBudget((RESUMES + 1) * POOL_COLD_STARTS + 1);",
			"const LARGEST = Math.max(LEASE_STALL.timeoutMs, 1_000);",
			'test("under the cap", async () => {',
			"}, LEASE_STALL.timeoutMs);",
			'test("capped", async () => {',
			"}, RESUME_CYCLES.timeoutMs);",
			'test("Math.max of constants", async () => {',
			"}, LARGEST);",
		],
		["under the cap", "capped", "Math.max of constants"],
	);
	assert.deepEqual(
		budgets,
		new Map([
			["under the cap", { timeoutMs: 315_000, unresolved: false }],
			["capped", { timeoutMs: 600_000, unresolved: false }],
			["Math.max of constants", { timeoutMs: 315_000, unresolved: false }],
		]),
	);
});

test("Math members are only evaluated when Math is the global and the method is a pure numeric one", () => {
	const budgets = scorePoolSuite(
		[
			"const Clamp = { min: (a: number) => a };",
			'test("random", async () => {',
			"}, Math.random() * 1_000);",
			'test("min of a non-constant", async () => {',
			"}, Math.min(rows.length, 1_000));",
			'test("not the Math global", async () => {',
			"}, Clamp.min(1_000));",
		],
		["random", "min of a non-constant", "not the Math global"],
	);
	for (const [name, budget] of budgets) assert.deepEqual(budget, { timeoutMs: 0, unresolved: true }, name);
	assert.equal(budgets.size, 3);
});

test("a shadowed Math is not treated as the global", () => {
	const budgets = scorePoolSuite(
		[
			"const Math = { min: (a: number, b: number) => a + b };",
			'test("shadowed", async () => {',
			"}, Math.min(1_000, 2_000));",
		],
		["shadowed"],
	);
	assert.deepEqual(budgets.get("shadowed"), { timeoutMs: 0, unresolved: true });
});

test("helper calls and member reads that are genuinely dynamic stay unresolved", () => {
	const budgets = scorePoolSuite(
		[
			'import { poolTestBudgetMs } from "../helpers/pool-budget.js";',
			"const pools = rows.length;",
			"const DYNAMIC = poolTestBudgetMs(pools);",
			"const KNOWN = poolTestBudgetMs(2);",
			"function jitter(ms: number) {",
			"\treturn ms + Math.random();",
			"}",
			"function branchy(ms: number) {",
			"\tif (ms > 1) return ms;",
			"\treturn 0;",
			"}",
			"function loop(ms: number): number {",
			"\treturn loop(ms);",
			"}",
			"let mutable = { timeoutMs: 1_000 };",
			'test("non-constant argument", async () => {',
			"}, DYNAMIC.timeoutMs);",
			'test("missing member", async () => {',
			"}, KNOWN.missingMs);",
			'test("impure helper", async () => {',
			"}, jitter(1_000));",
			'test("helper with control flow", async () => {',
			"}, branchy(1_000));",
			'test("recursive helper", async () => {',
			"}, loop(1_000));",
			'test("mutable binding", async () => {',
			"}, mutable.timeoutMs);",
			'test("unknown helper", async () => {',
			"}, computeBudget(2));",
		],
		[
			"non-constant argument",
			"missing member",
			"impure helper",
			"helper with control flow",
			"recursive helper",
			"mutable binding",
			"unknown helper",
		],
	);
	for (const [name, budget] of budgets) assert.deepEqual(budget, { timeoutMs: 0, unresolved: true }, name);
	assert.equal(budgets.size, 7);
});

test("the no-MCP startup scenario is scored against its declared 570 s budget", () => {
	const name =
		"built interactive CLI waits for startup before testing --no-mcp and pending /mcp shutdown (#10249) (#3470)";
	const scored = evaluateDurations(
		report([
			{
				file: "test/integration/interactive-no-mcp-startup.test.ts",
				tests: [{ title: name, status: "passed", duration: 76_800 }],
			},
		]),
		30_000,
		root,
	);
	assert.equal(scored.samples[0]?.timeoutMs, 570_000);
	assert.equal(scored.samples[0]?.explicit, true);
	assert.deepEqual(scored.warnings, []);
});

/**
 * The budget now lives in the resolved vitest config rather than a `--timeout`
 * flag, so resolution follows the same one indirection CI uses: `npm run
 * <script>` into package.json, then into the config that script selects.
 */
test("the suite budget is read from the command or the package script it runs", async () => {
	assert.equal(await resolveDefaultTimeoutMs(["npm", "run", "test:unit"], root), 30_000);
	assert.equal(await resolveDefaultTimeoutMs(["npm", "run", "test:integration"], root), 30_000);
	assert.equal(await resolveDefaultTimeoutMs(["npm", "run", "test:ci-contracts"], root), 30_000);
	assert.equal(await resolveDefaultTimeoutMs(["vitest", "--run", "--project", "unit"], root), 30_000);
	// The coding-agent project keeps its own config and its own platform branch.
	assert.equal(
		await resolveDefaultTimeoutMs(["npm", "run", "test", "--workspace=@bastani/atomic"], root),
		process.platform === "win32" ? 90_000 : 30_000,
	);
	// A command that is not vitest has no testTimeout, so the gate stays off
	// rather than scoring unrelated output against a budget nothing enforced.
	assert.equal(await resolveDefaultTimeoutMs(["npm", "run", "typecheck"], root), undefined);
	assert.equal(await resolveDefaultTimeoutMs(["npm", "run", "check"], root), undefined);
	assert.equal(await resolveDefaultTimeoutMs(["node", "--test", "scripts/x.test.mjs"], root), undefined);
	assert.equal(await resolveDefaultTimeoutMs(["bun", "test", "--timeout", "30000", "test/unit"], root), undefined);
	assert.equal(await resolveDefaultTimeoutMs(["npm", "run", "does-not-exist"], root), undefined);

	// A leading `bun`/`bunx` is the runtime, not the command, and stripping it
	// must still resolve the budget. The coding-agent suite is the one the gate
	// can least afford to lose: it exercises the SQLite selector paths of the
	// shipped binary on whichever runtime it is launched with.
	const agent = join(root, "packages/coding-agent");
	const agentBudget = process.platform === "win32" ? 90_000 : 30_000;
	assert.equal(
		await resolveDefaultTimeoutMs(["npm", "run", "test", "--workspace=@bastani/atomic"], root),
		agentBudget,
	);
	assert.equal(await resolveDefaultTimeoutMs(["bun", "--bun", "vitest", "--run"], agent), agentBudget);
	assert.equal(
		await resolveDefaultTimeoutMs(["bun", "--bun", "run", "vitest", "--run", "--project", "agent"], agent),
		agentBudget,
	);
	assert.equal(
		await resolveDefaultTimeoutMs(["bunx", "--bun", "vitest", "--run", "--project", "agent"], agent),
		agentBudget,
	);
	// Stripping the runtime must not swallow the `--project` that selects the
	// budget: an unknown project has none, and the gate must stay off rather than
	// fall back to whichever projects happen to agree.
	assert.equal(
		await resolveDefaultTimeoutMs(["bun", "--bun", "vitest", "--run", "--project", "nope"], root),
		undefined,
	);
	// Bun running something that is not vitest is still not a budget.
	assert.equal(await resolveDefaultTimeoutMs(["bun", "run", "scripts/cut-release.ts"], root), undefined);
	// Windows resolves executables through uppercase PATHEXT entries, so the
	// command head arrives as `...\bun.EXE` or `npm.CMD`. Its filesystems match
	// case-insensitively; the binary checks must too, or the gate goes dark.
	assert.equal(
		await resolveDefaultTimeoutMs(["/tools/bun.EXE", "./vitest", "--run", "--project", "unit"], root),
		30_000,
	);
	assert.equal(await resolveDefaultTimeoutMs(["npm.CMD", "run", "test:unit"], root), 30_000);
});

test("headroom is scored against the effective timeout, not a fixed ceiling", () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-duration-guard-"));
	try {
		writeFileSync(
			join(directory, "suite.test.ts"),
			[
				'test("heavy but declared", async () => {',
				"}, 60_000);",
				'test("heavy and undeclared", async () => {',
				"});",
			].join("\n"),
		);
		const payload = report(
			[
				{
					file: "suite.test.ts",
					tests: [
						{ title: "heavy but declared", status: "passed", duration: 25_000 },
						{ title: "heavy and undeclared", status: "passed", duration: 25_000 },
						{ title: "comfortable", status: "passed", duration: 1_000 },
					],
				},
			],
			directory,
		);

		const scored = evaluateDurations(payload, 30_000, directory);
		assert.equal(scored.enabled, true);
		assert.equal(scored.defaultTimeoutMs, 30_000);
		const byName = new Map(scored.samples.map((sample) => [sample.name, sample]));
		assert.equal(byName.get("heavy but declared")?.ratio.toFixed(2), "0.42");
		assert.equal(byName.get("heavy and undeclared")?.ratio.toFixed(2), "0.83");
		assert.deepEqual(
			scored.warnings.map((sample) => sample.name),
			["heavy and undeclared", "heavy but declared"],
		);
		assert.match(renderDurationTable(scored), /60000 ms \(explicit\)/);

		// With no resolvable budget nothing is judged, but the table is still emitted.
		const ungated = evaluateDurations(payload, undefined, directory);
		assert.equal(ungated.enabled, false);
		assert.deepEqual(ungated.warnings, []);
		assert.equal(ungated.samples.length, 3);
		assert.match(renderDurationTable(ungated), /not declared \(gate disabled\)/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the advisory threshold leaves the observed healthy Windows tail quiet", () => {
	assert.ok(WARN_RATIO > 0.3 && WARN_RATIO < 1);
});
