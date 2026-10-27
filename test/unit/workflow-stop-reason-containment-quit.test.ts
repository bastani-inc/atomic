import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/workflow-stop-reason-containment.ts");
const REAL_CHILD_TIMEOUT_MS = 120_000;

interface Runtime {
	readonly name: string;
	readonly command: () => string[];
}

const RUNTIMES: readonly Runtime[] = [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
];

interface Outcome {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface Report {
	readonly status: string;
	readonly error?: string;
	readonly exited?: boolean;
	readonly exitReason?: string;
	readonly storeStatus?: string;
	readonly inspected: { readonly kind: string; readonly status?: string };
	readonly healthy?: { readonly status: string; readonly error?: string };
}

interface Expectation {
	readonly status: string;
	readonly inspected: string;
	readonly error?: string;
	readonly exitReason?: string;
	readonly exited?: boolean;
}

const KILLED: Expectation = { status: "killed", inspected: "cancelled", error: "workflow killed" };
const QUIT: Expectation = { status: "paused", inspected: "paused", exitReason: "quit" };

function runFixture(runtime: Runtime, args: readonly string[]): Outcome {
	const [executable, ...preload] = runtime.command();
	const result = spawnSyncCollect([executable as string, ...preload, FIXTURE, ...args], {
		cwd: ROOT,
		timeout: REAL_CHILD_TIMEOUT_MS,
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function assertStopped(outcome: Outcome, expected: Expectation): Report {
	assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
	const reported = JSON.parse(outcome.stdout.trim().split("\n").at(-1) ?? "") as Report;
	assert.equal(reported.status, expected.status);
	assert.equal(reported.storeStatus, expected.status);
	assert.deepEqual(reported.inspected, { kind: "found", status: expected.inspected });
	assert.equal(reported.error, expected.error);
	assert.equal(reported.exitReason, expected.exitReason);
	assert.equal(reported.exited, expected.exited);
	return reported;
}

for (const runtime of RUNTIMES) {
	describe(`stopped workflow runs with dropped pool branches on ${runtime.name}`, () => {
		test(
			"a pool branch calling ctx.stage long after /workflow quit paused the run does not end the process (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["quit", "stage", "late"]), QUIT);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a pool branch calling ctx.stage while /workflow quit is still settling does not end the process (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["quit", "stage", "during"]), QUIT);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a quit pool leaves a concurrent healthy run completed (#3846)",
			() => {
				const reported = assertStopped(runFixture(runtime, ["quit", "stage", "after", "healthy"]), QUIT);
				assert.deepEqual(reported.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a pool branch calling ctx.stage after the caller aborted the run does not end the process (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["caller-abort", "stage", "after"]), KILLED);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a pool branch calling ctx.exit while the run is paused ends the run as exited once it resumes (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["paused-exit", "exit", "during"]), {
					status: "completed",
					inspected: "completed",
					exitReason: "pool finished early",
					exited: true,
				});
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a pool branch calling ctx.exit while the run is paused does not turn a later kill into a failure (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["paused-exit-then-kill", "exit", "during"]), KILLED);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
