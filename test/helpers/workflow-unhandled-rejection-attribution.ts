/**
 * Runs `test/fixtures/workflow-unhandled-rejection-attribution.ts` in a child process, on Node (through jiti) or on Bun,
 * and reads the report it prints. The attribution suites share it: each case needs a process of its own because it
 * tests what the runtime does with an unhandled rejection (exit code, `--unhandled-rejections` mode), and those files are
 * split by topic so their child processes run in parallel across workers (docs/ci.md, "Why steps are grouped this way").
 */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { bunExecutable, moduleDir, spawnSyncCollect } from "./runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/workflow-unhandled-rejection-attribution.ts");

/** How long one child process may run: the same bound its test's own explicit budget declares. */
const CHILD_TIMEOUT_MS = 120_000;

export interface Runtime {
	readonly name: string;
	readonly command: () => string[];
}

export const RUNTIMES: readonly Runtime[] = [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
];

export interface Outcome {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface Report {
	readonly status: string;
	readonly error?: string;
	readonly exited?: boolean;
	readonly exitReason?: string;
	readonly inspected: { readonly kind: string; readonly status?: string };
	readonly healthy?: { readonly status: string; readonly error?: string };
	readonly runs?: ReadonlyArray<{ readonly workflow: string; readonly status: string; readonly error?: string }>;
}

export function runFixture(
	runtime: Runtime,
	args: readonly string[],
	runtimeFlags: readonly string[] = [],
	env: Record<string, string> = {},
): Outcome {
	const [executable, ...preload] = runtime.command();
	const result = spawnSyncCollect([executable as string, ...runtimeFlags, ...preload, FIXTURE, ...args], {
		cwd: ROOT,
		env: { ...process.env, ...env },
		timeout: CHILD_TIMEOUT_MS,
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function report(outcome: Outcome): Report {
	const line = outcome.stdout.trim().split("\n").at(-1) ?? "";
	return JSON.parse(line) as Report;
}

export function assertContained(outcome: Outcome): Report {
	assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
	const reported = report(outcome);
	assert.equal(reported.status, "failed");
	assert.deepEqual(reported.inspected, { kind: "found", status: "failed" });
	return reported;
}

export function assertExited(outcome: Outcome): Report {
	assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
	const reported = report(outcome);
	assert.equal(reported.status, "completed");
	assert.equal(reported.exited, true);
	assert.equal(reported.exitReason, "pool finished early");
	assert.deepEqual(reported.inspected, { kind: "found", status: "completed" });
	return reported;
}
