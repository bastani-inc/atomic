import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForChildProcess } from "../../../src/utils/child-process.ts";

function createSyntheticChildProcess(pid: number): { child: ChildProcess; stdout: PassThrough; stderr: PassThrough } {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const events = new EventEmitter();
	const child = Object.assign(events, {
		stdout,
		stderr,
		stdin: null,
		stdio: [null, stdout, stderr, null, null],
		pid,
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

describe("issue #1647 Windows exit poll", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits for the real exit code when the Windows alive check wins the exit event race", async () => {
		vi.useFakeTimers();
		const synthetic = createSyntheticChildProcess(1647);
		let resolved = false;
		let aliveChecks = 0;
		const reportProcessDead = () => {
			aliveChecks += 1;
			return false;
		};

		const wait = waitForChildProcess(synthetic.child, {
			platform: "win32",
			isWindowsProcessAlive: reportProcessDead,
			windowsExitPollIntervalMs: 1,
			windowsExitCodeGraceMs: 1_000,
		}).then((code) => {
			resolved = true;
			return code;
		});

		synthetic.stdout.emit("end");
		synthetic.stderr.emit("end");
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);
		expect(aliveChecks).toBe(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(resolved).toBe(false);
		expect(aliveChecks).toBe(1);

		synthetic.child.emit("exit", 1, null);

		await expect(wait).resolves.toBe(1);
		expect(resolved).toBe(true);
	});

	it("reports an exit that never arrives as 0 once the grace has passed, and not before", async () => {
		// The clock is fake; the turn the fallback waits for after the grace is a real one.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const synthetic = createSyntheticChildProcess(1649);
		let resolved = false;

		const wait = waitForChildProcess(synthetic.child, {
			platform: "win32",
			isWindowsProcessAlive: () => false,
			windowsExitPollIntervalMs: 1,
			windowsExitCodeGraceMs: 1_000,
		}).then((code) => {
			resolved = true;
			return code;
		});

		synthetic.stdout.emit("end");
		synthetic.stderr.emit("end");
		// The poll finds the process gone after 1 ms; its exit is never reported.
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(resolved).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await expect(wait).resolves.toBe(0);
	});

	it.each(["before", "after"] as const)(
		"keeps a stopped process's exit code when a loaded machine holds the loop past the grace with its exit already queued (output ended %s it)",
		async (outputEnds) => {
			const synthetic = createSyntheticChildProcess(1648);
			const endOutput = () => {
				synthetic.stdout.emit("end");
				synthetic.stderr.emit("end");
			};
			// The exit arrives as an event of the loop's poll phase, as a real child's does.
			const exitReport = new MessageChannel();
			exitReport.port1.once("message", () => {
				synthetic.child.emit("exit", 1, null);
				// Output that ends later does so after anything else that turn has queued.
				if (outputEnds === "after") setImmediate(endOutput);
			});
			let stalled = false;
			const reportProcessDeadAndStall = () => {
				if (!stalled) {
					stalled = true;
					setImmediate(() => {
						// The exit is reported while the loop is held, for longer than the grace: when the loop goes on, the
						// grace's timer is due and the exit is queued behind it.
						exitReport.port2.postMessage("exit");
						const end = performance.now() + 150;
						while (performance.now() < end) {
							// A loaded machine holds the loop.
						}
					});
				}
				return false;
			};

			const wait = waitForChildProcess(synthetic.child, {
				platform: "win32",
				isWindowsProcessAlive: reportProcessDeadAndStall,
				windowsExitPollIntervalMs: 1,
				windowsExitCodeGraceMs: 100,
			});
			if (outputEnds === "before") endOutput();

			try {
				await expect(wait).resolves.toBe(1);
			} finally {
				exitReport.port1.close();
			}
		},
	);
});
