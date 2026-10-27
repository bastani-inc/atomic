import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/workflow-unhandled-rejection-attribution.ts");
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
	readonly inspected: { readonly kind: string; readonly status?: string };
	readonly healthy?: { readonly status: string; readonly error?: string };
	readonly runs?: ReadonlyArray<{ readonly workflow: string; readonly status: string; readonly error?: string }>;
}

function runFixture(
	runtime: Runtime,
	args: readonly string[],
	runtimeFlags: readonly string[] = [],
	env: Record<string, string> = {},
): Outcome {
	const [executable, ...preload] = runtime.command();
	const result = spawnSyncCollect([executable as string, ...runtimeFlags, ...preload, FIXTURE, ...args], {
		cwd: ROOT,
		env: { ...process.env, ...env },
		timeout: REAL_CHILD_TIMEOUT_MS,
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function report(outcome: Outcome): Report {
	const line = outcome.stdout.trim().split("\n").at(-1) ?? "";
	return JSON.parse(line) as Report;
}

function assertContained(outcome: Outcome): Report {
	assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
	const reported = report(outcome);
	assert.equal(reported.status, "failed");
	assert.deepEqual(reported.inspected, { kind: "found", status: "failed" });
	return reported;
}

function assertExited(outcome: Outcome): Report {
	assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
	const reported = report(outcome);
	assert.equal(reported.status, "completed");
	assert.equal(reported.exited, true);
	assert.equal(reported.exitReason, "pool finished early");
	assert.deepEqual(reported.inspected, { kind: "found", status: "completed" });
	return reported;
}

for (const runtime of RUNTIMES) {
	describe(`workflow unhandled rejection attribution on ${runtime.name}`, () => {
		for (const [failure, reason] of [
			["tool-string", /boom-string/],
			["tool-undefined", /undefined/],
			["tool-number", /4242/],
		] as const) {
			test(
				`a ctx.tool rejecting with ${failure} left unhandled by a pool fork fails its run instead of the process (#3846)`,
				() => {
					const reported = assertContained(runFixture(runtime, [failure, "tolerant"]));
					assert.match(reported.error ?? "", reason);
				},
				REAL_CHILD_TIMEOUT_MS,
			);
		}

		test(
			"a ctx.tool rejecting with an error from another module left unhandled by a pool fork fails its run (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["tool-foreign-error", "tolerant"]));
				assert.match(reported.error ?? "", /tool failed outside the workflow module/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an error the author throws after ctx.workflow in a pool fork fails its run instead of the process (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["author-error-after-workflow", "rolling"]));
				assert.match(reported.error ?? "", /author error after child/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a direct fs failure after ctx.tool in a pool fork fails its run instead of the process (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["fs-error-after-tool", "rolling"]));
				assert.match(reported.error ?? "", /ENOENT: no such file or directory, rename/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an error from a helper module awaited by a pool fork after ctx.tool fails its run instead of the process (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["helper-error-after-tool", "rolling"]));
				assert.match(reported.error ?? "", /helper failed outside the workflow module/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"ctx.exit called in a pool fork with a dropped finally promise ends the run as exited, not the process (#3846)",
			() => {
				assertExited(runFixture(runtime, ["exit-after-workflow", "rolling"]));
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a child workflow fork that calls ctx.stage after its parent exited does not end the process (#3846)",
			() => {
				const reported = assertExited(runFixture(runtime, ["exit-during-child-fork", "rolling"]));
				assert.equal(reported.runs?.find((entry) => entry.workflow === "forking-child")?.status, "cancelled");
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"ctx.exit called in a pool fork leaves a concurrent run from the same module untouched (#3846)",
			() => {
				const reported = assertExited(runFixture(runtime, ["exit-after-workflow", "rolling", "same-module"]));
				assert.deepEqual(reported.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a ctx.task rejection left unhandled by a pool fork fails its run instead of the process (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["task-rejects", "tolerant"]));
				assert.match(reported.error ?? "", /prompt failed outside the workflow module/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a stage prompt rejection left unhandled by a pool fork fails its run instead of the process (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["stage-rejects", "tolerant"]));
				assert.match(reported.error ?? "", /prompt failed outside the workflow module/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an error thrown by a fire-and-forget function after the run ended does not terminate the process (#3846)",
			() => {
				const outcome = runFixture(runtime, ["late-author-error", "rolling"]);
				assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
