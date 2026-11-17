import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnCollect } from "../../packages/workflows/src/runs/shared/spawn-collect.js";

const node = process.execPath;
/** Long enough that a loaded runner still starts the child well inside it. */
const GENEROUS_TIMEOUT_MS = 20_000;

function errorCode(error: Error | undefined): string | undefined {
	return (error as (Error & { readonly code?: string }) | undefined)?.code;
}

test("collects a process's output and exit status, as spawnSync reports them", async () => {
	const result = await spawnCollect(
		node,
		["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
		{ cwd: process.cwd(), env: process.env, timeout: GENEROUS_TIMEOUT_MS, maxBuffer: 1024 },
	);
	assert.deepEqual(result, { stdout: "out", stderr: "err", status: 3, signal: null });
});

test("hands the process its input on stdin", async () => {
	const result = await spawnCollect(node, ["-e", "process.stdin.pipe(process.stdout)"], {
		cwd: process.cwd(),
		env: process.env,
		timeout: GENEROUS_TIMEOUT_MS,
		maxBuffer: 1024,
		input: '{"version":1}',
	});
	assert.equal(result.stdout, '{"version":1}');
	assert.equal(result.status, 0);
});

test("ends a process that outlives its timeout and reports ETIMEDOUT", async () => {
	const result = await spawnCollect(node, ["-e", "setTimeout(() => {}, 60_000)"], {
		cwd: process.cwd(),
		env: process.env,
		timeout: 200,
		maxBuffer: 1024,
	});
	assert.equal(errorCode(result.error), "ETIMEDOUT");
	assert.equal(result.status, null);
	assert.equal(result.signal, "SIGTERM");
});

test("ends a process whose output exceeds maxBuffer and reports ENOBUFS", async () => {
	const result = await spawnCollect(
		node,
		["-e", "process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 60_000)"],
		{ cwd: process.cwd(), env: process.env, timeout: GENEROUS_TIMEOUT_MS, maxBuffer: 1024 },
	);
	assert.equal(errorCode(result.error), "ENOBUFS");
	assert.equal(result.stdout.length, 1024);
});

test("reports a command that cannot start by its spawn error, with no status", async () => {
	const result = await spawnCollect("atomic-command-that-does-not-exist", [], {
		cwd: process.cwd(),
		env: process.env,
		timeout: GENEROUS_TIMEOUT_MS,
		maxBuffer: 1024,
	});
	assert.equal(errorCode(result.error), "ENOENT");
	assert.equal(result.status, null);
});

test("settles promptly on timeout and maxBuffer when a background grandchild holds stdio (#5377)", async () => {
	const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("spawnCollect hung on grandchild pipe")), ms);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
	const timedOut = await within(
		spawnCollect(
			node,
			[
				"-e",
				"const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' }); setTimeout(() => {}, 30000);",
			],
			{ cwd: process.cwd(), env: process.env, timeout: 150, maxBuffer: 1024 },
		),
		1_500,
	);
	assert.equal(errorCode(timedOut.error), "ETIMEDOUT");
	assert.equal(timedOut.status, null);
	assert.equal(timedOut.signal, "SIGTERM");

	const overflow = await within(
		spawnCollect(
			node,
			[
				"-e",
				"const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' }); process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 30000);",
			],
			{ cwd: process.cwd(), env: process.env, timeout: GENEROUS_TIMEOUT_MS, maxBuffer: 1024 },
		),
		1_500,
	);
	assert.equal(errorCode(overflow.error), "ENOBUFS");
	assert.equal(overflow.stdout.length, 1024);
});
