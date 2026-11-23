import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	waitUntilGone,
} from "../../../../../test/helpers/recorded-process.js";
import { spawnProcess, waitForChildProcess } from "../../../src/utils/child-process.ts";

const EXIT_STDIO_IDLE_GRACE_MS = 100;
const ACTIVE_DRAIN_HARD_CAP_MS = 5_000;
const ACTIVE_STREAM_DURATION_MS = 350;
const ACTIVE_STREAM_TICK_INTERVAL_MS = 10;
const QUIET_EXIT_BUDGET_MS = 3_000;
const QUIET_DESCENDANT_HOLD_MS = 30_000;
const LOOP_HOLD_MS = 150;

/**
 * Detached descendant that publishes its PID atomically, streams ticks on stdout
 * at a steady interval without per-tick process spawns, continues for at least
 * `durationMs` after `exitFile` appears, then writes `FINAL_TICK` and keeps
 * stdout open silently until terminated.
 */
const ACTIVE_DESCENDANT_SCRIPT = `
const fs = require("node:fs");
const [pidFile, exitFile, durationMsRaw, tickMsRaw] = process.argv.slice(1);
const durationMs = Number(durationMsRaw);
const tickMs = Number(tickMsRaw);
const tmpPid = pidFile + ".tmp";
fs.writeFileSync(tmpPid, String(process.pid));
fs.renameSync(tmpPid, pidFile);
const safety = setTimeout(() => process.exit(0), 15_000);
let tick = 0;
let postExitStart = -1;
const writeLine = (line) => {
	try {
		fs.writeSync(1, line);
	} catch {
		clearInterval(interval);
		clearTimeout(safety);
		process.exit(0);
	}
};
const interval = setInterval(() => {
	tick += 1;
	if (postExitStart < 0 && fs.existsSync(exitFile)) {
		postExitStart = performance.now();
	}
	if (postExitStart >= 0 && performance.now() - postExitStart >= durationMs) {
		clearInterval(interval);
		writeLine("FINAL_TICK\\n");
		return;
	}
	writeLine("TICK" + tick + "\\n");
}, tickMs);
`;

/**
 * Detached descendant that publishes its PID atomically and keeps stdout open
 * without writing any further output until terminated or `holdMs` elapses.
 */
const QUIET_DESCENDANT_SCRIPT = `
const fs = require("node:fs");
const [pidFile, holdMsRaw] = process.argv.slice(1);
const tmpPid = pidFile + ".tmp";
fs.writeFileSync(tmpPid, String(process.pid));
fs.renameSync(tmpPid, pidFile);
setTimeout(() => {}, Number(holdMsRaw));
`;

/**
 * Direct child that starts a detached descendant inheriting stdout/stderr,
 * waits until that descendant is running (published its PID file), writes its
 * own banner synchronously, and exits immediately with status 0.
 */
const PARENT_SPAWNER_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [banner, descendantScript, pidFile, ...descendantArgs] = process.argv.slice(1);
const descendant = spawn(process.execPath, ["-e", descendantScript, pidFile, ...descendantArgs], {
	stdio: ["ignore", 1, 2],
	detached: true,
	windowsHide: true,
});
const waitReady = setInterval(() => {
	if (!fs.existsSync(pidFile)) return;
	clearInterval(waitReady);
	fs.writeSync(1, banner + "\\n");
	descendant.unref();
	process.exit(0);
}, 5);
`;

function createSyntheticChildProcess(): { child: ChildProcess; stdout: PassThrough; stderr: PassThrough } {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const events = new EventEmitter();
	const child = Object.assign(events, {
		stdout,
		stderr,
		stdin: null,
		stdio: [null, stdout, stderr, null, null],
		pid: 0,
		connected: false,
		killed: false,
		exitCode: null,
		signalCode: null,
		spawnargs: [],
		spawnfile: "synthetic-child",
		kill: () => true,
		ref: () => events as ChildProcess,
		unref: () => events as ChildProcess,
		send: () => false,
		disconnect: () => undefined,
	}) as ChildProcess;

	return { child, stdout, stderr };
}

function holdEventLoop(durationMs: number): void {
	const end = performance.now() + durationMs;
	while (performance.now() < end) {
		// Simulate a loaded host holding the event loop past a timer boundary.
	}
}

/**
 * Regression tests for https://github.com/earendil-works/pi/issues/5303
 *
 * waitForChildProcess used to arm a fixed 100ms timer on `exit` and destroy the
 * stdio streams when it fired. When a short-lived detached descendant kept the
 * stdout pipe open, `close` never fired, so that timer was the only thing that
 * resolved the wait, and any output written more than 100ms after exit was
 * binned. Likewise, firing the idle or hard-cap cutoff directly inside the
 * timer phase before a poll cycle discards ready pipe output queued during an
 * event-loop hold.
 */
describe("issue #5303 bash output truncation past exit", () => {
	const tempDirs: string[] = [];
	const pendingRecords: Array<Promise<RecordedProcess | undefined>> = [];

	const createTempDir = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-5303-"));
		tempDirs.push(dir);
		return dir;
	};

	const recordDescendantFromFile = (pidFile: string): void => {
		pendingRecords.push(
			(async () => {
				if (!existsSync(pidFile)) return undefined;
				const pid = Number(readFileSync(pidFile, "utf8").trim());
				if (!Number.isInteger(pid) || pid <= 0) return undefined;
				return await recordProcess(pid);
			})(),
		);
	};

	afterEach(async () => {
		vi.useRealTimers();
		const recorded = await Promise.all(pendingRecords.splice(0));
		for (const proc of recorded) {
			if (!proc) continue;
			await signalRecordedProcess(proc, "SIGKILL");
			await waitUntilGone(proc, 5_000);
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("captures output emitted after exit while a detached child holds stdout open", async () => {
		const dir = createTempDir();
		const pidFile = join(dir, "descendant.pid");
		const exitFile = join(dir, "parent.exited");

		const child = spawnProcess(
			process.execPath,
			[
				"-e",
				PARENT_SPAWNER_SCRIPT,
				"HEAD",
				ACTIVE_DESCENDANT_SCRIPT,
				pidFile,
				exitFile,
				String(ACTIVE_STREAM_DURATION_MS),
				String(ACTIVE_STREAM_TICK_INTERVAL_MS),
			],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		) as ChildProcessByStdio<null, Readable, Readable>;

		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.once("exit", () => {
			recordDescendantFromFile(pidFile);
			writeFileSync(exitFile, "1");
		});

		const exitCode = await waitForChildProcess(child);
		recordDescendantFromFile(pidFile);

		expect(exitCode).toBe(0);
		expect(output).toContain("HEAD");
		expect(output).toContain("FINAL_TICK");
	});

	it("resolves promptly when a detached child holds stdout open but stays quiet", async () => {
		const dir = createTempDir();
		const pidFile = join(dir, "quiet.pid");

		const child = spawnProcess(
			process.execPath,
			["-e", PARENT_SPAWNER_SCRIPT, "DONE", QUIET_DESCENDANT_SCRIPT, pidFile, String(QUIET_DESCENDANT_HOLD_MS)],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		) as ChildProcessByStdio<null, Readable, Readable>;

		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		let exitObservedAt = -1;
		child.once("exit", () => {
			exitObservedAt = performance.now();
			recordDescendantFromFile(pidFile);
		});

		const exitCode = await waitForChildProcess(child);
		const postExitElapsedMs = exitObservedAt >= 0 ? performance.now() - exitObservedAt : Number.POSITIVE_INFINITY;
		recordDescendantFromFile(pidFile);

		expect(exitCode).toBe(0);
		expect(output).toContain("DONE");
		expect(exitObservedAt).toBeGreaterThanOrEqual(0);
		expect(postExitElapsedMs).toBeLessThan(QUIET_EXIT_BUDGET_MS);
	});

	it("re-arms the default idle grace on post-exit stdout and stderr data and resolves once quiet", async () => {
		// The clock is fake; the turn the fallback waits for after the grace is a real one.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const synthetic = createSyntheticChildProcess();

		let stdoutText = "";
		let stderrText = "";
		synthetic.stdout.on("data", (chunk: Buffer) => {
			stdoutText += chunk.toString();
		});
		synthetic.stderr.on("data", (chunk: Buffer) => {
			stderrText += chunk.toString();
		});

		let resolved = false;
		const wait = waitForChildProcess(synthetic.child).then((code) => {
			resolved = true;
			return code;
		});

		synthetic.child.emit("exit", 0, null);
		for (let i = 1; i <= 6; i += 1) {
			await vi.advanceTimersByTimeAsync(EXIT_STDIO_IDLE_GRACE_MS - 1);
			expect(resolved).toBe(false);
			if (i % 2 === 1) {
				synthetic.stdout.emit("data", Buffer.from(`OUT_${i}\n`));
			} else {
				synthetic.stderr.emit("data", Buffer.from(`ERR_${i}\n`));
			}
		}

		await vi.advanceTimersByTimeAsync(EXIT_STDIO_IDLE_GRACE_MS - 1);
		expect(resolved).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		const exitCode = await wait;

		expect(exitCode).toBe(0);
		expect(stdoutText).toContain("OUT_5");
		expect(stderrText).toContain("ERR_6");
		expect(resolved).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("enforces an active-drain hard cap when a detached child keeps writing after exit", async () => {
		// The clock is fake; the turn the fallback waits for after the cap is a real one.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const synthetic = createSyntheticChildProcess();

		let output = "";
		synthetic.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		let resolved = false;
		const wait = waitForChildProcess(synthetic.child).then((code) => {
			resolved = true;
			return code;
		});
		synthetic.child.emit("exit", 0, null);
		synthetic.stdout.emit("data", Buffer.from("HEAD\n"));

		const noiseInterval = setInterval(() => {
			synthetic.stdout.emit("data", Buffer.from("NOISE\n"));
		}, 50);

		await vi.advanceTimersByTimeAsync(ACTIVE_DRAIN_HARD_CAP_MS - 1);
		expect(resolved).toBe(false);
		clearInterval(noiseInterval);

		await vi.advanceTimersByTimeAsync(1);
		const exitCode = await wait;

		expect(exitCode).toBe(0);
		expect(output).toContain("HEAD");
		expect(output).toContain("NOISE");
		expect(resolved).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps post-exit output queued during an event-loop hold past the idle grace and continues draining", async () => {
		const synthetic = createSyntheticChildProcess();
		let stdoutText = "";
		let stderrText = "";
		synthetic.stdout.on("data", (chunk: Buffer) => {
			stdoutText += chunk.toString();
		});
		synthetic.stderr.on("data", (chunk: Buffer) => {
			stderrText += chunk.toString();
		});

		// Deliver chunks during the loop's poll phase, as OS pipe reads do.
		const channel = new MessageChannel();
		let followupTimer: NodeJS.Timeout | undefined;
		channel.port1.on("message", (message: string) => {
			if (message === "first") {
				synthetic.stdout.write("QUEUED_DURING_HOLD\n");
				// Schedule a second chunk shortly after; if the idle fallback immediate
				// was not canceled by the first chunk, this follow-up chunk is lost.
				followupTimer = setTimeout(() => {
					synthetic.stderr.write("FOLLOWUP_AFTER_REARM\n");
				}, 20);
			}
		});

		try {
			const wait = waitForChildProcess(synthetic.child);
			synthetic.child.emit("exit", 0, null);

			// In the check phase right after exit, queue a poll-phase chunk and hold
			// the loop past EXIT_STDIO_IDLE_GRACE_MS so the timer phase runs first.
			setImmediate(() => {
				channel.port2.postMessage("first");
				holdEventLoop(LOOP_HOLD_MS);
			});

			const exitCode = await wait;
			expect(exitCode).toBe(0);
			expect(stdoutText).toContain("QUEUED_DURING_HOLD");
			expect(stderrText).toContain("FOLLOWUP_AFTER_REARM");
		} finally {
			if (followupTimer) clearTimeout(followupTimer);
			channel.port1.close();
			channel.port2.close();
		}
	});

	it("drains already-queued output before finalizing at the active-drain hard cap without letting noisy writes postpone it", async () => {
		// Fake timers control the 5s hard cap while setImmediate and MessageChannel use the real loop.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const synthetic = createSyntheticChildProcess();
		let output = "";
		synthetic.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		const channel = new MessageChannel();
		channel.port1.on("message", (message: string) => {
			if (message === "cap-chunk") {
				synthetic.stdout.write("READY_BEFORE_CAP\n");
			}
		});

		try {
			const wait = waitForChildProcess(synthetic.child);
			synthetic.child.emit("exit", 0, null);

			const noiseInterval = setInterval(() => {
				synthetic.stdout.emit("data", Buffer.from("NOISE\n"));
			}, 50);

			vi.advanceTimersByTime(ACTIVE_DRAIN_HARD_CAP_MS - 1);
			clearInterval(noiseInterval);

			// Queue a poll-phase chunk, then fire the hard-cap timer before poll runs.
			// Poll must deliver READY_BEFORE_CAP, and its data event must NOT cancel
			// or postpone the hard-cap settlement (no further fake-timer advance).
			channel.port2.postMessage("cap-chunk");
			vi.advanceTimersByTime(1);

			const exitCode = await wait;
			expect(exitCode).toBe(0);
			expect(output).toContain("READY_BEFORE_CAP");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			channel.port1.close();
			channel.port2.close();
		}
	});

	it("clears pending post-exit fallback immediates when stdio ends before the check phase", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate"] });
		const synthetic = createSyntheticChildProcess();

		const wait = waitForChildProcess(synthetic.child);
		synthetic.child.emit("exit", 0, null);

		// Fire only the idle setTimeout, leaving its fallback immediate pending.
		vi.advanceTimersToNextTimer();
		expect(vi.getTimerCount()).toBeGreaterThan(0);

		synthetic.stdout.emit("end");
		synthetic.stderr.emit("end");

		const exitCode = await wait;
		expect(exitCode).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
