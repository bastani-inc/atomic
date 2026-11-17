import assert from "node:assert/strict";
import { test, vi } from "vitest";

const containment = vi.hoisted(() => ({
	events: [] as string[],
	enabled: false,
	unavailable: false,
	terminateResult: true,
	onTerminate: undefined as (() => void) | undefined,
}));

vi.mock("@bastani/atomic", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bastani/atomic")>();
	return {
		...actual,
		killProcessTree: (pid: number) => {
			if (containment.enabled || containment.unavailable) {
				containment.events.push(`killProcessTree:${pid > 0}`);
			}
			return actual.killProcessTree(pid);
		},
		containProcessTree: (pid: number) => {
			if (containment.unavailable) return undefined;
			if (!containment.enabled) {
				const fn = (actual as { containProcessTree?: (p: number) => unknown }).containProcessTree;
				return fn?.(pid);
			}
			containment.events.push(`contain:${pid > 0}`);
			return {
				terminate: () => {
					containment.events.push("terminate");
					containment.onTerminate?.();
					return containment.terminateResult;
				},
				activeProcesses: () => 0,
				release: () => {
					containment.events.push("release");
					return true;
				},
				close: () => {
					containment.events.push("close");
				},
			};
		},
	};
});

import { spawnCollect } from "../../packages/workflows/src/runs/shared/spawn-collect.js";

const node = process.execPath;
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

	const ignoredSigterm = await within(
		spawnCollect(
			node,
			[
				"-e",
				"const { spawn } = require('node:child_process'); process.on('SIGTERM', () => {}); const g = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);\"], { stdio: 'inherit' }); process.stdout.write(String(g.pid)); setTimeout(() => {}, 30000);",
			],
			{ cwd: process.cwd(), env: process.env, timeout: 150, maxBuffer: 1024 },
		),
		1_500,
	);
	assert.equal(errorCode(ignoredSigterm.error), "ETIMEDOUT");
	assert.equal(ignoredSigterm.status, null);
	const grandchildPid = Number(ignoredSigterm.stdout.trim());
	if (Number.isInteger(grandchildPid) && grandchildPid > 0 && process.platform !== "win32") {
		for (let i = 0; i < 50; i++) {
			try {
				process.kill(grandchildPid, 0);
			} catch {
				break;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
		assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
	}
});

test("uses process-tree containment to terminate descendants when root already exited and releases on normal exit (#5377)", async () => {
	containment.enabled = true;
	containment.events = [];
	containment.onTerminate = undefined;
	try {
		const ok = await spawnCollect(node, ["-e", "process.stdout.write('done')"], {
			cwd: process.cwd(),
			env: process.env,
			timeout: GENEROUS_TIMEOUT_MS,
			maxBuffer: 1024,
		});
		assert.equal(ok.stdout, "done");
		assert.deepEqual(containment.events, ["contain:true", "release", "close"]);

		containment.events = [];
		let grandchildPid = 0;
		containment.onTerminate = () => {
			if (grandchildPid > 0 && process.platform !== "win32") {
				try {
					process.kill(grandchildPid, "SIGKILL");
				} catch {}
			}
		};
		const rootExitedTimeout = await spawnCollect(
			node,
			[
				"-e",
				"const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);\"], { stdio: 'inherit', detached: true }); process.stdout.write(String(g.pid)); process.exit(0);",
			],
			{ cwd: process.cwd(), env: process.env, timeout: 150, maxBuffer: 1024 },
		);
		grandchildPid = Number(rootExitedTimeout.stdout.trim());
		if (grandchildPid > 0 && process.platform !== "win32") {
			try {
				process.kill(grandchildPid, "SIGKILL");
			} catch {}
		}
		assert.equal(errorCode(rootExitedTimeout.error), "ETIMEDOUT");
		assert.deepEqual(containment.events, ["contain:true", "terminate", "close"]);

		containment.enabled = false;
		containment.unavailable = true;
		containment.events = [];
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			const winNoJobExited = await spawnCollect(
				node,
				[
					"-e",
					"const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'inherit', detached: true }); process.stdout.write(String(g.pid)); process.exit(0);",
				],
				{ cwd: process.cwd(), env: process.env, timeout: 150, maxBuffer: 1024 },
			);
			const orphanPid = Number(winNoJobExited.stdout.trim());
			if (orphanPid > 0 && originalPlatform !== "win32") {
				try {
					process.kill(orphanPid, "SIGKILL");
				} catch {}
			}
			assert.equal(errorCode(winNoJobExited.error), "ETIMEDOUT");
			assert.deepEqual(containment.events, []);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
			containment.unavailable = false;
		}
	} finally {
		containment.enabled = false;
		containment.unavailable = false;
		containment.onTerminate = undefined;
	}
});
