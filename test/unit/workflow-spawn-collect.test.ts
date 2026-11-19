import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
import { test, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

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

import { killTrackedDetachedChildren } from "../../packages/coding-agent/src/utils/shell.js";
import { spawnCollect } from "../../packages/workflows/src/runs/shared/spawn-collect.js";
import { toJsLiteral } from "../helpers/js-literal.js";

const node = process.execPath;
const GENEROUS_TIMEOUT_MS = 20_000;
/** Deliberately longer than the old 150 ms assumption that a newly spawned root had already exited. */
const ROOT_EXIT_DELAY_MS = 300;
/** Real child startup and exit, independent of the timeout that the scenario triggers only after exit. */
const ROOT_EXIT_BOUND_MS = 5_000;
/** Keep inherited pipes open past the whole real exit wait, with headroom, until the test drives the timeout. */
const DESCENDANT_HOLD_MS = ROOT_EXIT_BOUND_MS * 2;

function errorCode(error: Error | undefined): string | undefined {
	return (error as (Error & { readonly code?: string }) | undefined)?.code;
}

async function collectAfterRootExit(script: string) {
	const deadline = AbortSignal.timeout(ROOT_EXIT_BOUND_MS);
	let child: ReturnType<typeof spawn> | undefined;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const collected = spawnCollect(node, ["-e", script], {
			cwd: process.cwd(),
			env: process.env,
			timeout: GENEROUS_TIMEOUT_MS,
			maxBuffer: 1024,
		});
		child = vi.mocked(spawn).mock.results.at(-1)?.value;
		assert.ok(child, "the real root child was spawned");
		await once(child, "exit", { signal: deadline });
		assert.equal(child.exitCode, 0, "the root exited normally before its timeout");
		await vi.advanceTimersByTimeAsync(GENEROUS_TIMEOUT_MS);
		return await collected;
	} finally {
		child?.kill("SIGKILL");
		child?.stdout?.destroy();
		child?.stderr?.destroy();
		vi.useRealTimers();
	}
}

test("collects a process's output and exit status, as spawnSync reports them", async () => {
	const result = await spawnCollect(
		node,
		["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
		{ cwd: process.cwd(), env: process.env, timeout: GENEROUS_TIMEOUT_MS, maxBuffer: 1024 },
	);
	assert.deepEqual(result, { stdout: "out", stderr: "err", status: 3, signal: null });
});

// A hangup reaches only the terminal's foreground process group: a command in its own group must be stopped by Atomic.
test.skipIf(process.platform === "win32")(
	"a command running in its own process group is stopped with Atomic's other detached children on hangup (#5377)",
	async () => {
		const running = spawnCollect(node, ["-e", "setTimeout(() => {}, 60_000)"], {
			cwd: process.cwd(),
			env: process.env,
			timeout: 60_000,
			maxBuffer: 1024,
		});
		killTrackedDetachedChildren();
		const result = await running;
		assert.equal(result.signal, "SIGKILL");
	},
	GENEROUS_TIMEOUT_MS,
);

// Once the command exited, its pid may name another process: a hangup signals only its process group (#5377).
test.skipIf(process.platform === "win32")(
	"a hangup after the command exited while a process it started still holds its output never signals the command's pid (#5377)",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "spawn-collect-exited-root-"));
		const pids = join(directory, "pids");
		const running = spawnCollect(
			node,
			[
				"-e",
				`const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit", detached: true }); require("node:fs").writeFileSync(${toJsLiteral(pids)}, process.pid + " " + g.pid); process.exit(0);`,
			],
			{ cwd: process.cwd(), env: process.env, timeout: GENEROUS_TIMEOUT_MS, maxBuffer: 1024 },
		);
		let rootPid = 0;
		let outputHolderPid = 0;
		try {
			while (!existsSync(pids) || readFileSync(pids, "utf8").split(" ").length < 2) await realSleep(10);
			[rootPid, outputHolderPid] = readFileSync(pids, "utf8").split(" ").map(Number) as [number, number];
			while (processExists(rootPid)) await realSleep(10);
			const signalled: number[] = [];
			const kill = process.kill.bind(process);
			const spy = vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
				signalled.push(pid);
				return kill(pid, signal);
			});
			try {
				killTrackedDetachedChildren();
			} finally {
				spy.mockRestore();
			}
			assert.ok(signalled.includes(-rootPid), "its process group is signalled");
			assert.equal(signalled.includes(rootPid), false, "the exited command's pid is not");
		} finally {
			if (outputHolderPid > 0) process.kill(outputHolderPid, "SIGKILL");
			await running;
			rmSync(directory, { recursive: true, force: true });
		}
	},
	GENEROUS_TIMEOUT_MS,
);

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

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

test("uses process-tree containment to terminate descendants when root already exited and releases on normal exit (#5377, #5533)", async () => {
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
		const rootExitedTimeout = await collectAfterRootExit(
			`const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, ${DESCENDANT_HOLD_MS});"], { stdio: 'inherit', detached: true }); process.stdout.write(String(g.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ROOT_EXIT_DELAY_MS}); process.exit(0);`,
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
			const winNoJobExited = await collectAfterRootExit(
				`const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${DESCENDANT_HOLD_MS})'], { stdio: 'inherit', detached: true }); process.stdout.write(String(g.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ROOT_EXIT_DELAY_MS}); process.exit(0);`,
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

test("a timeout that stops a running command terminates its process tree once, also when the command's exit follows (#5601)", async () => {
	containment.enabled = true;
	containment.events = [];
	let child: ReturnType<typeof spawn> | undefined;
	// Terminating the job ends every process in it, the command included, whose exit is reported afterwards.
	containment.onTerminate = () => child?.kill("SIGKILL");
	try {
		const running = spawnCollect(node, ["-e", "setTimeout(() => {}, 60_000)"], {
			cwd: process.cwd(),
			env: process.env,
			timeout: 200,
			maxBuffer: 1024,
		});
		child = vi.mocked(spawn).mock.results.at(-1)?.value;
		assert.ok(child, "the command was spawned");
		const result = await running;
		assert.equal(errorCode(result.error), "ETIMEDOUT");
		assert.deepEqual(containment.events, ["contain:true", "terminate", "close"]);
	} finally {
		child?.kill("SIGKILL");
		containment.enabled = false;
		containment.onTerminate = undefined;
	}
});

test("an output overflow that stops a running command terminates its process tree once, also when the timeout and then the command's exit follow (#5601)", async () => {
	containment.enabled = true;
	containment.events = [];
	containment.onTerminate = undefined;
	let child: ReturnType<typeof spawn> | undefined;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const running = spawnCollect(
			node,
			["-e", "process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 60_000)"],
			{ cwd: process.cwd(), env: process.env, timeout: GENEROUS_TIMEOUT_MS, maxBuffer: 1024 },
		);
		child = vi.mocked(spawn).mock.results.at(-1)?.value;
		assert.ok(child, "the command was spawned");
		const deadline = Date.now() + ROOT_EXIT_BOUND_MS;
		while (!containment.events.includes("terminate") && Date.now() < deadline) await realSleep(10);
		assert.deepEqual(containment.events, ["contain:true", "terminate"], "the overflow terminated the tree");
		assert.equal(child.exitCode, null, "the command still runs");
		await vi.advanceTimersByTimeAsync(GENEROUS_TIMEOUT_MS);
		child.kill("SIGKILL");
		const result = await running;
		assert.equal(errorCode(result.error), "ENOBUFS");
		assert.deepEqual(containment.events, ["contain:true", "terminate", "close"]);
	} finally {
		child?.kill("SIGKILL");
		vi.useRealTimers();
		containment.enabled = false;
	}
});
