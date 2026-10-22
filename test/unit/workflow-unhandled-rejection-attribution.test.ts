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

function runFixture(runtime: Runtime, args: readonly string[], runtimeFlags: readonly string[] = []): Outcome {
	const [executable, ...preload] = runtime.command();
	const result = spawnSyncCollect([executable as string, ...runtimeFlags, ...preload, FIXTURE, ...args], {
		cwd: ROOT,
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

		test(
			"an error the author throws while child workflows of the same module run fails the parent and cancels the children (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["author-error-during-child", "rolling"]));
				assert.equal(reported.error, "author error while child runs");
				const parent = reported.runs?.find((entry) => entry.workflow === "parent-of-slow-child");
				const child = reported.runs?.find((entry) => entry.workflow === "slow-child");
				assert.equal(parent?.error, "author error while child runs");
				assert.equal(child?.status, "killed");
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a primitive reason the author already caught does not fail its run when an unrelated rejection repeats it later (#3846)",
			() => {
				const outcome = runFixture(runtime, ["caught-primitive", "rolling"], ["--unhandled-rejections=warn"]);
				assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
				assert.equal(report(outcome).status, "completed");
				assert.match(outcome.stderr, /shared-reason/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an error the author throws after the run ended and its grace period passed ends the process as before (#3846)",
			() => {
				const outcome = runFixture(runtime, ["late-author-error-after-grace", "rolling"]);
				assert.equal(outcome.exitCode, 1, `${outcome.stdout}\n${outcome.stderr}`);
				assert.match(outcome.stderr, /author error after the run ended/);
				assert.doesNotMatch(outcome.stderr, /run-rejection-boundary/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a failing ctx call in a pool leaves a concurrent run from the same module untouched (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["tool-foreign-error", "tolerant", "same-module"]));
				assert.deepEqual(reported.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a failing pool leaves a concurrent run in another module untouched (#3846)",
			() => {
				const reported = assertContained(
					runFixture(runtime, ["author-error-after-workflow", "rolling", "healthy"]),
				);
				assert.deepEqual(reported.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an unrelated rejection after a contained one still ends the process and reports its own origin (#3846)",
			() => {
				const outcome = runFixture(runtime, ["tool-string", "tolerant", "unrelated"]);
				assert.equal(outcome.exitCode, 1, outcome.stdout);
				assert.equal(report(outcome).status, "failed");
				assert.match(outcome.stderr, /unrelated engine bug/);
				assert.match(outcome.stderr, /workflow-unhandled-rejection-unrelated\.ts:3/);
				assert.doesNotMatch(outcome.stderr, /run-rejection-boundary/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"--unhandled-rejections=warn keeps an unrelated rejection non-fatal and reports it (#3846)",
			() => {
				const outcome = runFixture(
					runtime,
					["tool-string", "tolerant", "unrelated"],
					["--unhandled-rejections=warn"],
				);
				assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
				assert.equal(report(outcome).status, "failed");
				assert.match(outcome.stderr, /unrelated engine bug/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"--unhandled-rejections=none keeps an unrelated rejection non-fatal and silent (#3846)",
			() => {
				const outcome = runFixture(
					runtime,
					["tool-string", "tolerant", "unrelated"],
					["--unhandled-rejections=none"],
				);
				assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
				assert.equal(report(outcome).status, "failed");
				assert.doesNotMatch(outcome.stderr, /unrelated engine bug/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"--unhandled-rejections=warn-with-error-code sets the error code for an unrelated rejection only (#3846)",
			() => {
				const flags = ["--unhandled-rejections=warn-with-error-code"];
				const contained = runFixture(runtime, ["tool-string", "tolerant"], flags);
				assert.equal(contained.exitCode, 0, `${contained.stdout}\n${contained.stderr}`);
				assert.equal(report(contained).status, "failed");
				const unrelated = runFixture(runtime, ["tool-string", "tolerant", "unrelated"], flags);
				assert.equal(unrelated.exitCode, 1, `${unrelated.stdout}\n${unrelated.stderr}`);
				assert.match(unrelated.stderr, /unrelated engine bug/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}

const [NODE, BUN] = RUNTIMES;

describe("workflow unhandled rejection attribution through async context", () => {
	test(
		"a string the author throws after ctx.workflow in a pool fork fails its run on a runtime that exposes async context (#3846)",
		() => {
			const reported = assertContained(runFixture(NODE as Runtime, ["author-string-after-workflow", "rolling"]));
			assert.match(reported.error ?? "", /author string after child/);
		},
		REAL_CHILD_TIMEOUT_MS,
	);

	test(
		"a failing pool leaves a concurrent run from the same module untouched where async context identifies the run (#3846)",
		() => {
			const reported = assertContained(
				runFixture(NODE as Runtime, ["author-string-after-workflow", "rolling", "same-module"]),
			);
			assert.deepEqual(reported.healthy, { status: "completed" });
		},
		REAL_CHILD_TIMEOUT_MS,
	);

	test(
		"an error an ended run's fire-and-forget function throws leaves a concurrent run from the same module untouched where async context identifies the run (#3846)",
		() => {
			const outcome = runFixture(NODE as Runtime, ["late-author-error", "rolling", "same-module"]);
			assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
			assert.deepEqual(report(outcome).healthy, { status: "completed" });
		},
		REAL_CHILD_TIMEOUT_MS,
	);
});

describe("workflow unhandled rejection attribution when two runs of one module could have thrown the error", () => {
	for (const [failure, poolStyle] of [
		["late-author-error", "rolling"],
		["author-error-after-workflow", "tolerant"],
	] as const) {
		test(
			`an author error from ${failure} fails neither run of the same module and is handed back to the runtime (#3846)`,
			() => {
				const outcome = runFixture(
					BUN as Runtime,
					[failure, poolStyle, "same-module"],
					["--unhandled-rejections=warn"],
				);
				assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
				assert.deepEqual(report(outcome).healthy, { status: "completed" });
				assert.match(outcome.stderr, /author error/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	}
});
