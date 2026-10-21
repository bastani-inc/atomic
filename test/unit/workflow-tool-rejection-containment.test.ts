import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/workflow-tool-rejection-pool.ts");
// A real Node child with jiti transpiling the workflow runtime: the default
// unhandled-rejection policy is the behavior under test, so Vitest's own
// rejection handlers must not be present.
const REAL_NODE_CHILD_TIMEOUT_MS = 120_000;

interface FixtureOutcome {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

function runFixture(mode: "pool-fork" | "late-admission" | "unrelated-rejection"): FixtureOutcome {
	const result = spawnSyncCollect([process.execPath, "--import", "jiti/register", FIXTURE, mode], {
		cwd: ROOT,
		timeout: REAL_NODE_CHILD_TIMEOUT_MS,
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function reportedRun(outcome: FixtureOutcome): { status: string; error?: string } {
	const line = outcome.stdout.trim().split("\n").at(-1) ?? "";
	return JSON.parse(line) as { status: string; error?: string };
}

describe("ctx.tool rejection containment", () => {
	test(
		"a rejected ctx.tool in a rolling pool fails its run instead of terminating the process (#3846)",
		() => {
			const outcome = runFixture("pool-fork");
			assert.equal(outcome.exitCode, 0, outcome.stderr);
			const run = reportedRun(outcome);
			assert.equal(run.status, "failed");
			assert.match(run.error ?? "", /ENOENT: no such file or directory, rename/);
		},
		REAL_NODE_CHILD_TIMEOUT_MS,
	);

	test(
		"a ctx.tool call after the run stopped rejects its caller instead of terminating the process (#3846)",
		() => {
			const outcome = runFixture("late-admission");
			assert.equal(outcome.exitCode, 0, outcome.stderr);
			assert.equal(reportedRun(outcome).status, "completed");
		},
		REAL_NODE_CHILD_TIMEOUT_MS,
	);

	test(
		"an unrelated unhandled rejection still terminates the process after a contained tool rejection (#3846)",
		() => {
			const outcome = runFixture("unrelated-rejection");
			assert.equal(outcome.exitCode, 1, outcome.stdout);
			assert.equal(reportedRun(outcome).status, "failed");
			assert.match(outcome.stderr, /unrelated engine bug/);
		},
		REAL_NODE_CHILD_TIMEOUT_MS,
	);
});
