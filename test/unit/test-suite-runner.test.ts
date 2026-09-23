import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";
import { test } from "vitest";
import { bunExecutable, fileExists, readStreamText, readText, spawnProcess } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runner = join(root, "scripts/run-test-suite.ts");

type Mode = "success" | "failure" | "headroom" | "blind" | "no-report";

/**
 * A stand-in for vitest that the wrapper cannot tell from the real thing.
 *
 * The scenarios need reports no real suite could produce -- a 25 s sample, a run
 * that reports tests but no durations -- and the wrapper resolves the per-test
 * budget from the *config* the command selects, not from a flag. So the fixture
 * is a file literally named `vitest`, sitting beside a `vitest.config.ts`: the
 * budget therefore resolves through exactly the code path CI uses, while the
 * report itself is scripted.
 */
const FAKE_VITEST = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const outputFile = argv.find((arg) => arg.startsWith("--outputFile.json="))?.slice("--outputFile.json=".length);
const mode = process.env.FIXTURE_MODE;
const counter = process.env.FIXTURE_COUNTER;
writeFileSync(counter, "1");
console.log("fixture run");

const testFile = (name, tests) => ({ name, assertionResults: tests });
const passed = (title, duration) => ({ ancestorTitles: [], title, status: "passed", duration });
const failed = (title) => ({ ancestorTitles: [], title, status: "failed", duration: 1 });

let report = { numTotalTests: 1, testResults: [testFile("test/unit/fixture.test.ts", [passed("fixture", 12)])] };
let code = 0;

if (mode === "headroom") {
  report = { numTotalTests: 2, testResults: [testFile("test/unit/drift.test.ts", [passed("drifting test", 25000), passed("healthy test", 120)])] };
} else if (mode === "blind") {
  // Tests ran, yet the report carries none of them: the harness broke.
  report = { numTotalTests: 2, testResults: [] };
} else if (mode === "no-report") {
  // The suite exits green having written nothing at all. A gate that cannot
  // see must say so rather than score an empty sample set as healthy.
  report = undefined;
} else if (mode === "failure") {
  report = { numTotalTests: 1, testResults: [testFile("test/unit/unrelated.test.ts", [failed("unrelated failure")])] };
  code = 7;
}

if (outputFile && report !== undefined) writeFileSync(outputFile, typeof report === "string" ? report : JSON.stringify(report));
process.exit(code);
`;

/** A config in the shape the guard reads: one named project, one budget. */
const FIXTURE_CONFIG = `export default { test: { projects: [{ test: { name: "unit", testTimeout: 30000 } }] } };\n`;

interface FixtureResult {
	code: number;
	output: string;
	files: string[];
	summary: string;
	durations: string;
}

async function fixture(mode: Mode, options: { declareBudget?: boolean } = {}): Promise<FixtureResult> {
	const dir = mkdtempSync(join(tmpdir(), "atomic-test-suite-runner-"));
	const counter = join(dir, "counter");
	const diagnostics = join(dir, "diagnostics");
	const summary = join(dir, "summary.md");
	const fake = join(dir, "vitest");
	writeFileSync(fake, FAKE_VITEST);
	chmodSync(fake, 0o755);
	// Omitting the config is how a suite declares no budget: the command still
	// runs, and the gate must stay off rather than invent a ceiling.
	if (options.declareBudget !== false) writeFileSync(join(dir, "vitest.config.ts"), FIXTURE_CONFIG);
	try {
		const child = spawnProcess(
			[
				bunExecutable(),
				runner,
				"--label",
				"fixture suite",
				"--diagnostics-dir",
				diagnostics,
				"--",
				// Run the fake suite through Bun rather than relying on the shebang in
				// an extensionless file: Windows has no shebang support, so Node cannot
				// exec it. The duration guard steps over a leading Bun runtime and then
				// matches `basename` against `vitest`, so the budget still resolves.
				bunExecutable(),
				"./vitest",
				"--run",
				"--project",
				"unit",
			],
			{
				cwd: dir,
				env: { ...process.env, GITHUB_STEP_SUMMARY: summary, FIXTURE_MODE: mode, FIXTURE_COUNTER: counter },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			readStreamText(child.stdout),
			readStreamText(child.stderr),
			child.exited,
		]);
		const files = await glob("*", { cwd: diagnostics, onlyFiles: true }).catch(() => []);
		const summaryText = (await fileExists(summary)) ? await readText(summary) : "";
		const durationsPath = join(diagnostics, "fixture-suite-durations.md");
		const durations = (await fileExists(durationsPath)) ? await readText(durationsPath) : "";
		return { code, output: stdout + stderr, files, summary: summaryText, durations };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Diagnostics minus the JSON reports, which are an implementation detail. */
function logArtifacts(files: string[]): string[] {
	return files.filter((name) => !name.endsWith(".json")).sort();
}

/**
 * Structural: every fixture run spawns the real wrapper as a Bun child, which
 * itself spawns the fake vitest as a second Bun child. Two Bun cold starts plus
 * the wrapper's transform can exceed the suite default under full vitest file
 * parallelism on a loaded machine, so the budget is named here per the
 * per-test timeout policy in AGENTS.md.
 */
const WRAPPER_FIXTURE_TIMEOUT_MS = 60_000;

test(
	"green suite exits immediately with only the duration table",
	async () => {
		const result = await fixture("success");
		assert.equal(result.code, 0);
		assert.deepEqual(logArtifacts(result.files), ["fixture-suite-durations.md"]);
	},
	WRAPPER_FIXTURE_TIMEOUT_MS,
);

/** A failing run is never retried: the wrapper invokes the command exactly once and propagates its exit code. */
test(
	"a failing run is not retried and its exit code propagates",
	async () => {
		const result = await fixture("failure");
		assert.equal(result.code, 7);
		assert.match(result.output, /fixture run/);
		assert.doesNotMatch(result.output, /fixture run[\s\S]*fixture run/);
		assert.deepEqual(logArtifacts(result.files), [
			"fixture-suite-debug.txt",
			"fixture-suite-durations.md",
			"fixture-suite.log",
		]);
	},
	WRAPPER_FIXTURE_TIMEOUT_MS,
);

test(
	"a green suite still fails when one test exhausts its timeout headroom",
	async () => {
		const gated = await fixture("headroom");
		assert.equal(gated.code, 1);
		assert.match(
			gated.output,
			/::error title=Timeout headroom exhausted[\s\S]*drifting test took 25000ms of its 30000ms budget \(83%\)/,
		);
		assert.doesNotMatch(gated.output, /::(?:warning|error)[^\n]*healthy test/);
		assert.match(gated.summary, /Timeout headroom exhausted/);
		assert.match(gated.durations, /drifting test/);
	},
	WRAPPER_FIXTURE_TIMEOUT_MS,
);

test(
	"the headroom gate stays disabled for a suite that declares no timeout budget",
	async () => {
		const ungated = await fixture("headroom", { declareBudget: false });
		assert.equal(ungated.code, 0);
		assert.doesNotMatch(ungated.output, /Timeout headroom exhausted/);
		assert.match(ungated.durations, /not declared \(gate disabled\)[\s\S]*drifting test/);
	},
	WRAPPER_FIXTURE_TIMEOUT_MS,
);

test(
	"a suite whose tests ran without printing durations fails instead of passing blind",
	async () => {
		const result = await fixture("blind");
		assert.equal(result.code, 1);
		assert.match(
			result.output,
			/::error title=Duration guard blind[^\n]*2 test\(s\) ran but the report carried no durations/,
		);
		assert.match(result.summary, /Duration guard blind/);
		assert.match(result.durations, /Samples: 0 of 2 test\(s\) run/);
	},
	WRAPPER_FIXTURE_TIMEOUT_MS,
);

/**
 * The other half of blindness: not an empty report, but no report at all.
 *
 * A suite that exits green having written nothing is the shape a reporter
 * misconfiguration takes -- the step passes, the table is empty, and nobody
 * learns the gate stopped measuring. `missing` exists for this, and until now
 * only the empty-but-present report was covered.
 */
test(
	"a suite that writes no report at all fails instead of passing unmeasured",
	async () => {
		const result = await fixture("no-report");
		assert.equal(result.code, 1);
		assert.match(result.output, /::error title=Duration guard blind[^\n]*the suite wrote no readable JSON report/);
		assert.match(result.summary, /Duration guard blind/);
		assert.match(result.durations, /no duration samples parsed/);
	},
	WRAPPER_FIXTURE_TIMEOUT_MS,
);

/**
 * Structural: each of the two tests below starts a real vitest process, which
 * transforms and imports the runner, its guard and a scratch suite before a
 * single assertion runs. Named and kept at the call site, per the per-test
 * timeout policy in AGENTS.md -- a bare literal there says nothing about why
 * the cost is structural rather than a slow test nobody fixed.
 */
const REAL_VITEST_SUITE_TIMEOUT_MS = 120_000;

/** A real two-test vitest suite: one on the project budget, one explicit. */
const REAL_SUITE = [
	'import { test, expect } from "vitest";',
	'test("inherits the suite budget", () => { expect(1).toBe(1); });',
	'test("declares its own budget", async () => {',
	"  await new Promise((resolve) => setTimeout(resolve, 30));",
	"}, 2_000);",
].join("\n");

const REAL_CONFIG = [
	'import { defineConfig } from "vitest/config";',
	"export default defineConfig({",
	'  test: { projects: [{ test: { name: "unit", root: import.meta.dirname, include: ["suite.test.ts"], testTimeout: 30_000 } }] },',
	"});",
].join("\n");

/**
 * Drive the real wrapper over a real vitest run.
 *
 * The scratch directory lives under the repository root so `vitest` and its
 * `node_modules` resolve by the ordinary upward walk, which is also how a
 * developer's own nested package would find them.
 */
async function realVitestSuite(
	files: Record<string, string>,
	command: string[],
): Promise<{ code: number; output: string; durations: string }> {
	const dir = mkdtempSync(join(root, ".tmp-test-suite-runner-real-"));
	const diagnostics = join(dir, "diagnostics");
	for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
	try {
		const spawned = spawnProcess(
			[bunExecutable(), runner, "--label", "real suite", "--diagnostics-dir", diagnostics, "--", ...command],
			{ cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: undefined }, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, code] = await Promise.all([
			readStreamText(spawned.stdout),
			readStreamText(spawned.stderr),
			spawned.exited,
		]);
		return {
			code,
			output: stdout + stderr,
			durations: await readText(join(diagnostics, "real-suite-durations.md")),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Every real sample must carry the budget it was actually scored against. */
function assertScoredRealSuite(result: { code: number; output: string; durations: string }): void {
	assert.equal(result.code, 0, result.output);
	assert.doesNotMatch(result.output, /Duration guard blind/);
	assert.match(result.durations, /Samples: 2 of 2 test\(s\) run/);
	assert.match(result.durations, /\| 30000 ms \| suite\.test\.ts \| inherits the suite budget \|/);
	assert.match(result.durations, /\| 2000 ms \(explicit\) \| suite\.test\.ts \| declares its own budget \|/);
}

/**
 * The gate is only as good as the report it reads, so this drives the real
 * vitest runner through the real wrapper. A populated table with the explicit
 * budget attached, produced alongside readable step output, is the proof.
 */
test(
	"the wrapper scores a real vitest run through the JSON reporter it requests",
	async () => {
		const result = await realVitestSuite({ "suite.test.ts": REAL_SUITE, "vitest.config.ts": REAL_CONFIG }, [
			"vitest",
			"--run",
			"--project",
			"unit",
		]);
		assertScoredRealSuite(result);
		// The default reporter must survive alongside the JSON one, or a cancelled
		// step loses every clue about which test stalled.
		assert.match(result.output, /suite\.test\.ts/);
	},
	REAL_VITEST_SUITE_TIMEOUT_MS,
);

/**
 * CI never invokes `vitest` directly -- every suite goes through `npm run
 * <script>`, where the budget lives in the config that script selects and must
 * be read back out through both indirections. Scoring that form against a real
 * run closes the gap between what the guard is unit-tested on and the command it
 * is actually pointed at.
 */
test(
	"the wrapper scores a real vitest run behind the `npm run <script>` form CI uses",
	async () => {
		assertScoredRealSuite(
			await realVitestSuite(
				{
					"suite.test.ts": REAL_SUITE,
					"vitest.config.ts": REAL_CONFIG,
					"package.json": JSON.stringify({
						name: "real-suite",
						private: true,
						scripts: { "test:unit": "vitest --run --project unit" },
					}),
				},
				["npm", "run", "test:unit"],
			),
		);
	},
	REAL_VITEST_SUITE_TIMEOUT_MS,
);
