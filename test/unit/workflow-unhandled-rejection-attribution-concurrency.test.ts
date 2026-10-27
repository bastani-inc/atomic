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

for (const runtime of RUNTIMES) {
	describe(`workflow unhandled rejection attribution on ${runtime.name}`, () => {
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
			"an unhandled rejection fails its run while the body is still waiting on a child workflow (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["dropped-error-while-waiting", "rolling"]));
				assert.equal(reported.error, "dropped while the body waits");
				assert.equal(reported.runs?.find((entry) => entry.workflow === "stalled-child")?.status, "killed");
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a shared adapter error one run caught and another dropped fails only the run that dropped it (#3846)",
			() => {
				const reported = assertContained(
					runFixture(runtime, ["shared-error-dropped", "rolling", "shared-catcher"]),
				);
				assert.equal(reported.error, "shared prompt adapter error");
				assert.deepEqual(reported.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"--unhandled-rejections on the command line wins over NODE_OPTIONS for an unrelated rejection (#3846)",
			() => {
				const outcome = runFixture(
					runtime,
					["tool-string", "tolerant", "unrelated"],
					["--unhandled-rejections=throw"],
					{ NODE_OPTIONS: "--unhandled-rejections=warn" },
				);
				assert.equal(outcome.exitCode, 1, `${outcome.stdout}\n${outcome.stderr}`);
				assert.match(outcome.stderr, /unrelated engine bug/);
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
