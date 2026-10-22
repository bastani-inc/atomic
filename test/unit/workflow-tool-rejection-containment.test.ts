import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/workflow-tool-rejection-pool.ts");
const REAL_CHILD_TIMEOUT_MS = 120_000;

interface Runtime {
	readonly name: string;
	readonly command: () => string[];
}

const RUNTIMES: readonly Runtime[] = [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
];

interface FixtureOutcome {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

function runFixture(runtime: Runtime, mode: "pool-fork" | "late-admission" | "unrelated-rejection"): FixtureOutcome {
	const result = spawnSyncCollect([...runtime.command(), FIXTURE, mode], {
		cwd: ROOT,
		timeout: REAL_CHILD_TIMEOUT_MS,
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function reportedRun(outcome: FixtureOutcome): { status: string; error?: string } {
	const line = outcome.stdout.trim().split("\n").at(-1) ?? "";
	return JSON.parse(line) as { status: string; error?: string };
}

for (const runtime of RUNTIMES) {
	describe(`ctx.tool rejection containment on ${runtime.name}`, () => {
		test(
			"a rejected ctx.tool in a rolling pool fails its run instead of terminating the process (#3846)",
			() => {
				const outcome = runFixture(runtime, "pool-fork");
				assert.equal(outcome.exitCode, 0, outcome.stderr);
				const run = reportedRun(outcome);
				assert.equal(run.status, "failed");
				assert.match(run.error ?? "", /ENOENT: no such file or directory, rename/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a ctx.tool call after the run stopped rejects its caller instead of terminating the process (#3846)",
			() => {
				const outcome = runFixture(runtime, "late-admission");
				assert.equal(outcome.exitCode, 0, outcome.stderr);
				assert.equal(reportedRun(outcome).status, "completed");
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an unrelated unhandled rejection still terminates the process after a contained tool rejection (#3846)",
			() => {
				const outcome = runFixture(runtime, "unrelated-rejection");
				assert.equal(outcome.exitCode, 1, outcome.stdout);
				assert.equal(reportedRun(outcome).status, "failed");
				assert.match(outcome.stderr, /unrelated engine bug/);
				assert.match(outcome.stderr, /workflow-unhandled-rejection-unrelated\.ts:3/);
				assert.doesNotMatch(outcome.stderr, /run-rejection-boundary/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
