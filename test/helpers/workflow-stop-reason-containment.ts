/**
 * Runs `test/fixtures/workflow-stop-reason-containment.ts` in a child process, on Node (through jiti) or on Bun, and
 * checks how the stopped run settled. The stop-reason containment suites share it: each case needs a process of its own
 * because it tests that a dropped pool branch's late ctx call does not end that process, and those files are split by
 * the kind of stop so their child processes run in parallel across workers (docs/ci.md, "Why steps are grouped this
 * way").
 */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { bunExecutable, moduleDir, spawnSyncCollect } from "./runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/workflow-stop-reason-containment.ts");

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
	readonly storeStatus?: string;
	readonly inspected: { readonly kind: string; readonly status?: string };
	readonly healthy?: { readonly status: string; readonly error?: string };
}

export interface Expectation {
	readonly status: string;
	readonly inspected: string;
	readonly error?: string;
	readonly exitReason?: string;
	readonly exited?: boolean;
}

export const KILLED: Expectation = { status: "killed", inspected: "cancelled", error: "workflow killed" };
export const QUIT: Expectation = { status: "paused", inspected: "paused", exitReason: "quit" };

export function runFixture(runtime: Runtime, args: readonly string[]): Outcome {
	const [executable, ...preload] = runtime.command();
	const result = spawnSyncCollect([executable as string, ...preload, FIXTURE, ...args], {
		cwd: ROOT,
		timeout: CHILD_TIMEOUT_MS,
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function assertStopped(outcome: Outcome, expected: Expectation): Report {
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
