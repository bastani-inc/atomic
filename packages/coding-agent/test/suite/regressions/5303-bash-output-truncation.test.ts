import { type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnProcess, waitForChildProcess } from "../../../src/utils/child-process.ts";

function createSyntheticChildProcess(): { child: ChildProcess; stdout: PassThrough } {
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

	return { child, stdout };
}

/**
 * Regression test for https://github.com/earendil-works/pi/issues/5303
 *
 * waitForChildProcess armed a fixed 100ms timer on `exit` and destroyed the
 * stdio streams when it fired. When a short-lived detached descendant kept the
 * stdout pipe open, `close` never fired, so that timer was the only thing that
 * resolved the wait, and any output written more than 100ms after exit was
 * binned.
 */
describe.skipIf(process.platform === "win32")("issue #5303 bash output truncation past exit", () => {
	let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

	afterEach(() => {
		vi.useRealTimers();
		if (child?.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		child = undefined;
	});

	it("captures output emitted after exit while a detached child holds stdout open", async () => {
		const command =
			'printf "HEAD\\n"; ( i=1; while [ "$i" -le 30 ]; do sleep 0.05; printf "TICK$i\\n"; i=$((i + 1)); done ) &';
		child = spawnProcess("/bin/sh", ["-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;

		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		const exitCode = await waitForChildProcess(child);

		expect(exitCode).toBe(0);
		expect(output).toContain("HEAD");
		expect(output).toContain("TICK30");
	});

	it("resolves promptly when a detached child holds stdout open but stays quiet", async () => {
		const command = 'printf "DONE\\n"; ( sleep 30 ) &';
		child = spawnProcess("/bin/sh", ["-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;

		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		const start = Date.now();
		const exitCode = await waitForChildProcess(child);
		const elapsed = Date.now() - start;

		expect(exitCode).toBe(0);
		expect(output).toContain("DONE");
		expect(elapsed).toBeLessThan(2000);
	});

	it("enforces an active-drain hard cap when a detached child keeps writing after exit", async () => {
		vi.useFakeTimers();
		const activeDrainCapMs = 5_000;
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

		vi.advanceTimersByTime(activeDrainCapMs - 1);
		await Promise.resolve();
		expect(resolved).toBe(false);
		clearInterval(noiseInterval);

		vi.advanceTimersByTime(1);
		const exitCode = await wait;

		expect(exitCode).toBe(0);
		expect(output).toContain("HEAD");
		expect(output).toContain("NOISE");
		expect(resolved).toBe(true);
	});
});
