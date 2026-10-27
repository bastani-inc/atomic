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
		"a shared adapter error one run caught fails only the run whose dropped fork rethrew it where async context identifies the run (#3846)",
		() => {
			const reported = assertContained(
				runFixture(NODE as Runtime, ["shared-error-dropped-in-fork", "rolling", "shared-catcher"]),
			);
			assert.deepEqual(reported.healthy, { status: "completed" });
		},
		REAL_CHILD_TIMEOUT_MS,
	);

	test(
		"an error an ended run's fire-and-forget function throws leaves the next run from the same module untouched where async context identifies the run (#3846)",
		() => {
			const outcome = runFixture(NODE as Runtime, ["late-author-error", "rolling", "sequential-same-module"]);
			assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
			assert.deepEqual(report(outcome).healthy, { status: "completed" });
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
	for (const [failure, poolStyle, companion] of [
		["late-author-error", "rolling", "same-module"],
		["author-error-after-workflow", "tolerant", "same-module"],
		["late-author-error", "rolling", "sequential-same-module"],
	] as const) {
		test(
			`an author error from ${failure} fails neither ${companion === "same-module" ? "run of the same module" : "its run nor the next run of the same module"} and is handed back to the runtime (#3846)`,
			() => {
				const outcome = runFixture(
					BUN as Runtime,
					[failure, poolStyle, companion],
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
