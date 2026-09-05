import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { jobBlock, jobBlocks, jobSteps, namedStep, readText, stepIndex } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const testPath = join(root, ".github/workflows/test.yml");

/** The work jobs the result gate must depend on, in file and `needs` order. */
const WORK_JOBS = ["unit-tests", "integration-tests", "agent-suite", "release-archive", "static-checks"] as const;

/** Job blocks keyed by job id, in file order. */
async function jobs(): Promise<Map<string, string>> {
	return new Map(jobBlocks(await readText(testPath)));
}

/**
 * The two required contexts of repository ruleset 9310196 are produced by the
 * `test` job's matrix and nothing else. Splitting work into new jobs silently
 * un-protects every step that leaves `test`, and a `needs:` job without
 * `if: always()` is *skipped* when a dependency fails — which GitHub counts as a
 * satisfied required check. This contract is the guard against both.
 */
test("the test job is a fail-closed result gate carrying both required contexts", async () => {
	const workflow = await readText(testPath);
	const gate = jobBlock(workflow, "test");
	assert.match(gate, /^[ \t]+name: test \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.binary_platform \}\}\)$/mu);

	const contexts = [...gate.matchAll(/^[ \t]+- os: (\S+)\s+binary_platform: (\S+)$/gmu)].map(
		([, os, platform]) => `test (${os}, ${platform})`,
	);
	assert.deepEqual(contexts, [
		"test (blacksmith-4vcpu-ubuntu-2404, linux-x64)",
		"test (blacksmith-4vcpu-windows-2025, windows-x64)",
	]);

	assert.match(gate, /^[ \t]+if: always\(\)$/mu, "a skipped required check counts as passed");
	assert.match(gate, new RegExp(`^[ \\t]+needs: \\[${WORK_JOBS.join(", ")}\\]$`, "mu"));

	const steps = jobSteps(gate);
	assert.equal(steps.length, 1, "the gate must do no work of its own");
	const guard = steps[0] as string;
	assert.match(guard, /join\(needs\.\*\.result, ','\)/u);
	assert.match(guard, /\*,failure,\*\|\*,cancelled,\*\|\*,skipped,\*/u);
	assert.match(guard, /exit 1/u);
	assert.doesNotMatch(guard, /checkout|setup-bun|bun run/u);
	// The gate is pure bookkeeping, so both legs run on Linux; a Windows runner
	// would add its measured 33s queue for nothing.
	assert.match(gate, /^[ \t]+runs-on: blacksmith-4vcpu-ubuntu-2404$/mu);
});

/**
 * `push: branches: [main, "release/**", "prerelease/**"]` sitting next to an
 * unfiltered `pull_request:` made every release and prerelease pull request run
 * this workflow twice for one SHA. Both runs publish the same two required
 * context names, GitHub keeps the latest result per name, and the duplicate load
 * doubles contention on the shared runner pool. On sha 772a373 the push run
 * 31047506585 lost its Linux `suites` leg to its own cap and published FAILURE
 * for both contexts, while the pull_request run 31047542976 for the identical
 * SHA was green throughout: the pull request stayed blocked with nothing wrong
 * in it.
 *
 * A `concurrency` group is not the remedy. Cancelling an in-flight run that has
 * already published `test (...)` strands a cancelled required context on a SHA
 * with no superseding successful run, which is the exact state being fixed.
 */
test("one SHA runs this workflow once, and no group can cancel a run mid-flight", async () => {
	const workflow = await readText(testPath);
	const onIndex = workflow.indexOf("\non:\n");
	const jobsIndex = workflow.indexOf("\njobs:\n");
	assert.ok(onIndex >= 0 && jobsIndex > onIndex, "test.yml must declare `on:` above `jobs:`");
	const triggers = workflow.slice(onIndex + 1, jobsIndex + 1);

	// Scoped to the `push` mapping rather than the whole trigger block. A bare
	// four-space `branches:` search can be satisfied by a filter belonging to some
	// other trigger, which would leave "only main runs on push" asserted by
	// nothing at all -- including in the case this test exists to catch, where
	// `push:` is dropped or re-widened while another trigger carries `[main]`.
	const pushIndex = triggers.indexOf("  push:");
	assert.ok(pushIndex >= 0, "the workflow must still run on pushes to main");
	const afterPush = triggers.slice(pushIndex);
	const pushBodyStart = afterPush.indexOf("\n") + 1;
	const pushBodyEnd = afterPush.slice(pushBodyStart).search(/^ {0,2}\S/mu);
	const push = pushBodyEnd >= 0 ? afterPush.slice(0, pushBodyStart + pushBodyEnd) : afterPush;

	const branches = /^ {4}branches: \[([^\]]*)\]$/mu.exec(push);
	assert.ok(branches, "the push trigger must carry an explicit branch filter");
	assert.deepEqual(
		(branches[1] as string).split(",").map((branch) => branch.trim().replace(/^"|"$/gu, "")),
		["main"],
		"only main runs on push; every other branch reaches CI through its pull request",
	);

	const pullRequestIndex = triggers.indexOf("  pull_request:");
	assert.ok(pullRequestIndex >= 0, "pull requests must keep producing the two required contexts");
	const pullRequest = triggers.slice(pullRequestIndex);
	assert.match(pullRequest, /^ {2}pull_request:[ \t]*$/mu);
	assert.doesNotMatch(pullRequest, /^ {4}\S/mu, "the pull_request trigger stays unfiltered");

	assert.doesNotMatch(workflow, /^[ \t]*concurrency:/mu, "a cancelled run can strand a failing required context");
	assert.doesNotMatch(workflow, /cancel-in-progress/u);
});

test("every work job the gate names exists and is otherwise independent", async () => {
	const blocks = await jobs();
	assert.deepEqual([...blocks.keys()], [...WORK_JOBS, "test"]);
	for (const job of WORK_JOBS) {
		const block = blocks.get(job) as string;
		assert.doesNotMatch(block, /^[ \t]+needs:/mu, `${job} must not serialize behind another job`);
	}
});

/** Ceil the slower job duration from runs 33997174167 / 33997819241 plus 50% headroom. */
test("each split job retains its measured timeout hang detector", async () => {
	const workflow = await readText(testPath);
	const blocks = await jobs();
	const caps: Record<string, [number, number]> = {
		"unit-tests": [Math.ceil((371 * 1.5) / 60), Math.ceil((526 * 1.5) / 60)],
		"integration-tests": [Math.ceil((118 * 1.5) / 60), Math.ceil((195 * 1.5) / 60)],
		"agent-suite": [Math.ceil((226 * 1.5) / 60), Math.ceil((331 * 1.5) / 60)],
		"release-archive": [Math.ceil((80 * 1.5) / 60), Math.ceil((138 * 1.5) / 60)],
	};
	for (const [job, [linux, windows]] of Object.entries(caps)) {
		const block = blocks.get(job) as string;
		assert.match(
			block,
			new RegExp(`blacksmith-4vcpu-ubuntu-2404\\s+binary_platform: linux-x64\\s+timeout_minutes: ${linux}`, "u"),
			job,
		);
		assert.match(
			block,
			new RegExp(
				`blacksmith-4vcpu-windows-2025\\s+binary_platform: windows-x64\\s+timeout_minutes: ${windows}`,
				"u",
			),
			job,
		);
		assert.match(block, /timeout-minutes: \$\{\{ matrix\.timeout_minutes \}\}/u, job);
		assert.match(block, /fail-fast: false/u, job);
	}
	assert.match(blocks.get("static-checks") as string, /^[ \t]+timeout-minutes: 3$/mu);
	assert.match(blocks.get("test") as string, /^[ \t]+timeout-minutes: 1$/mu);
	// A cap is still a hang detector: it must bound a stuck job to minutes rather
	// than GitHub's six-hour default. The bound is the largest cap the current
	// measurements justify, so raising one further has to come with new numbers.
	for (const [, value] of workflow.matchAll(/^\s+timeout_minutes: (\d+)$/gmu)) {
		assert.ok(Number(value) <= 14, `cap ${value} is too loose to detect a hang`);
	}
});

/**
 * Steps that consume a previous step's output stay in one job. Moving them apart
 * would not fail: test/unit/pi-0.82.1-artifacts.test.ts degrades to `test.skip`
 * without packages/coding-agent/dist, so the coverage would vanish quietly.
 */
test("build-consuming steps stay in the job that produced the build", async () => {
	const blocks = await jobs();

	for (const [job, suite] of [
		["unit-tests", "Unit tests"],
		["integration-tests", "Integration tests"],
	]) {
		const block = blocks.get(job) as string;
		const steps = jobSteps(block);
		assert.ok(stepIndex(steps, "Build @bastani/atomic package") < stepIndex(steps, suite));
		assert.ok(stepIndex(steps, "Build native bindings for the root suites") < stepIndex(steps, suite));
		assert.match(block, /uses: actions\/setup-node@/u);
		assert.match(block, /uses: dtolnay\/rust-toolchain@/u);
	}
	const unit = blocks.get("unit-tests") as string;
	const integration = blocks.get("integration-tests") as string;
	assert.match(unit, /--no-retry-file flaky-test-suite-runner\.test\.ts/u);
	assert.match(unit, /-- npm run test:unit/u);
	assert.doesNotMatch(unit, /npm run test:integration/u);
	assert.match(integration, /-- npm run test:integration/u);
	assert.doesNotMatch(integration, /npm run test:unit/u);
	for (const block of [unit, integration]) {
		assert.equal(block.split("run-flaky-test-suite.ts").length - 1, 1);
		const setup = jobSteps(block);
		for (const [before, after] of [
			["Install dependencies", "Alias @earendil-works/pi-ai"],
			["Alias @earendil-works/pi-ai", "Build @bastani/pi-ai"],
			["Build @bastani/pi-ai", "Build native bindings"],
			["Build native bindings", "Build @bastani/atomic package"],
		]) {
			assert.ok(stepIndex(setup, before) < stepIndex(setup, after));
		}
	}
	assert.match(
		namedStep(jobSteps(blocks.get("integration-tests") as string), "Integration tests"),
		/ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE: "1"/u,
	);

	const agent = jobSteps(blocks.get("agent-suite") as string);
	assert.ok(
		stepIndex(agent, "Build native bindings for package tests") < stepIndex(agent, "coding-agent vitest suite"),
	);
	assert.match(namedStep(agent, "coding-agent vitest suite"), /ATOMIC_REQUIRE_NATIVE_BINDING_SMOKE: "1"/u);
	assert.match(blocks.get("agent-suite") as string, /uses: dtolnay\/rust-toolchain@/u);

	const archive = jobSteps(blocks.get("release-archive") as string);
	assert.ok(stepIndex(archive, "Build @bastani/atomic package") < stepIndex(archive, "Build native release binary"));
	assert.ok(
		stepIndex(archive, "Build native release binary") < stepIndex(archive, "Smoke test Linux release archive"),
	);
	assert.ok(
		stepIndex(archive, "Build native release binary") < stepIndex(archive, "Smoke test Windows release archive"),
	);
	// build-binaries.sh rebuilds packages/natives/native/*.node when they are
	// absent, so this job needs Rust rather than a dependency on agent-suite.
	assert.match(blocks.get("release-archive") as string, /uses: dtolnay\/rust-toolchain@/u);

	const staticChecks = blocks.get("static-checks") as string;
	assert.match(staticChecks, /^[ \t]+runs-on: blacksmith-4vcpu-ubuntu-2404$/mu);
	assert.doesNotMatch(staticChecks, /rust-toolchain/u);
	for (const step of [
		"Check",
		"Docs link validation",
		"Mintlify docs validation",
		"Script tests",
		"Deterministic CI and release contracts",
	]) {
		namedStep(jobSteps(staticChecks), step);
	}
	assert.match(
		namedStep(jobSteps(staticChecks), "Deterministic CI and release contracts"),
		/run: npm run test:ci-contracts/u,
	);
	// pi parity: repository scripts Node can run are covered by `node --test`.
	assert.match(namedStep(jobSteps(staticChecks), "Script tests"), /run: npm run test:scripts/u);
});

/**
 * Dependencies install with `npm ci --ignore-scripts` everywhere, so every work
 * job needs Node. Bun is still set up wherever a `scripts/*.ts`, the release
 * binary compiler, or a Bun-hosted test fixture runs -- which is all five. A job
 * that installs with npm but never sets Node up would fall back to whatever the
 * runner image happens to ship, which is the drift this guards against.
 */
test("every work job installs with npm ci and sets up both runtimes it uses", async () => {
	const blocks = await jobs();
	for (const job of WORK_JOBS) {
		const block = blocks.get(job) as string;
		assert.match(block, /uses: actions\/setup-node@/u, `${job} installs with npm and must pin Node`);
		assert.match(block, /^[ \t]+cache: npm$/mu, `${job} must cache the npm download`);
		assert.match(block, /uses: oven-sh\/setup-bun@/u, `${job} runs Bun scripts, binaries, or fixtures`);
		assert.match(namedStep(jobSteps(block), "Install dependencies"), /run: npm ci --ignore-scripts/u, job);
		assert.doesNotMatch(block, /bun install/u, `${job} must not install with Bun`);
	}
	const workflow = await readText(testPath);
	// The lockfile npm ci verifies is the only one left; bun.lock was deleted.
	assert.doesNotMatch(workflow, /bun\.lock/u);
});

/**
 * `actions/upload-artifact@v4+` fails the entire run when two jobs upload the
 * same artifact name, and three jobs previously emitted the identical
 * `test-diagnostics-<platform>` name.
 */
function assertDiagnosticsPath(step: string): void {
	assert.match(step, /^\s+path: \.ci-diagnostics\/\s*$/mu);
	assert.match(step, /^\s+include-hidden-files: true\s*$/mu);
}

test("every diagnostics upload has a job-unique artifact name", async () => {
	const uploads = [...(await jobs())].flatMap(([job, block]) =>
		jobSteps(block)
			.filter((step) => step.includes("actions/upload-artifact@"))
			.map((step) => {
				assert.match(step, /if: always\(\)/u);
				assert.match(step, /retention-days: 14/u);
				assert.match(step, /if-no-files-found: ignore/u);
				assertDiagnosticsPath(step);
				assert.throws(() => assertDiagnosticsPath(step.replace(/^\s+include-hidden-files: true\s*$/mu, "")));
				assert.throws(() => assertDiagnosticsPath(step.replace("path: .ci-diagnostics/", "path: .")));
				const name = /^\s+name: (.+)$/mu.exec(step);
				assert.ok(name, `${job}: upload-artifact step declares no artifact name`);
				return (name[1] as string).trim();
			}),
	);
	assert.equal(uploads.length, 3, "unit, integration and package jobs must each preserve diagnostics");
	assert.equal(new Set(uploads).size, uploads.length, `duplicate artifact names: ${uploads.join(", ")}`);
	for (const name of uploads) assert.match(name, /^test-diagnostics-[a-z-]+-\$\{\{ matrix\.binary_platform \}\}$/u);
});

/**
 * The duration-headroom guard reads vitest's JSON reporter, and the wrapper adds
 * those reporter flags itself. Every suite must keep reaching it through the
 * unmodified `npm run <script>` command a developer also runs: a bare `vitest`
 * invocation would bypass the script the budget is resolved through.
 *
 * The `--parallel|--shard|--concurrent|--max-concurrency` prohibition stays, and
 * matters more than before. vitest parallelises by default, so sharding is the
 * tempting way to "fix" a test that assumes an idle machine. It is not a fix; it
 * hides the test that needs one, and it double-scores tests reached through an
 * aggregator file, once under contention.
 */
test("every retried suite still runs through the duration guard unmodified", async () => {
	const workflow = await readText(testPath);
	const invocations = [...workflow.matchAll(/-- (npm run [^\n]+)$/gmu)].map(([, command]) =>
		(command as string).trim(),
	);
	assert.deepEqual(invocations, [
		"npm run test:unit",
		"npm run test:integration",
		"npm run test --workspace=@bastani/atomic",
	]);
	assert.equal(workflow.split("run-flaky-test-suite.ts").length - 1, invocations.length);
	assert.doesNotMatch(workflow, /--parallel|--shard|--concurrent|--max-concurrency/u);
	// The wrapper owns the reporter flags; a workflow that spelled them out would
	// drift from the command developers run locally.
	assert.doesNotMatch(workflow, /--reporter=json|--outputFile/u);
});

/**
 * `bun run test:ci-contracts` used to run on both platforms; it now runs only in
 * the Linux-only static-checks job. The one thing the Windows leg contributed
 * was a CRLF checkout, which `.gitattributes` now forecloses by pinning `*.yml`
 * to `eol=lf`. Routing every workflow read through the newline-normalizing
 * reader keeps that trap closed from the test side too, so neither a relaxed
 * attribute nor a stray CRLF can quietly change what these patterns match.
 */
test("CI contract suites read workflow text through the normalizing reader", async () => {
	const dir = join(root, "test/ci");
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".ts") || entry === "workflow-text.ts") continue;
		const source = await readText(join(dir, entry));
		assert.doesNotMatch(
			source,
			/Bun\.file\([^)]*\)\.text\(\)/u,
			`${entry}: read workflow text with readText() so a CRLF checkout cannot change the match`,
		);
	}
});
