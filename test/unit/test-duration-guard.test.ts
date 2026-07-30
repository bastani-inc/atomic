import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	declaredTimeouts,
	evaluateDurations,
	FAIL_RATIO,
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
	assert.equal(builtins.get("coding-agent builtin resources > loads builtin pi package resources"), 60_000);
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
		// Same duration, different budgets, therefore different verdicts.
		assert.equal(byName.get("heavy but declared")?.ratio.toFixed(2), "0.42");
		assert.equal(byName.get("heavy and undeclared")?.ratio.toFixed(2), "0.83");
		assert.deepEqual(
			scored.failures.map((sample) => sample.name),
			["heavy and undeclared"],
		);
		assert.deepEqual(
			scored.warnings.map((sample) => sample.name),
			["heavy but declared"],
		);
		assert.match(renderDurationTable(scored), /60000 ms \(explicit\)/);

		// With no resolvable budget nothing is judged, but the table is still emitted.
		const ungated = evaluateDurations(payload, undefined, directory);
		assert.equal(ungated.enabled, false);
		assert.deepEqual(ungated.failures, []);
		assert.equal(ungated.samples.length, 3);
		assert.match(renderDurationTable(ungated), /not declared \(gate disabled\)/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("guard thresholds keep the observed Windows tail silent and bound a genuine hang", () => {
	// The slowest observed healthy Windows test sat near 30 % of its budget; the
	// thresholds must leave that quiet and still catch a test approaching timeout.
	assert.ok(WARN_RATIO > 0.3, "a healthy Windows tail must not warn on every run");
	assert.ok(FAIL_RATIO > WARN_RATIO && FAIL_RATIO < 1, "failing must precede the timeout, not coincide with it");
});
