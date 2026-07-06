import { type ChildProcess } from "node:child_process";
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
});
