import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { spawnProcess, waitForChildProcess } from "../../../src/utils/child-process.ts";

// Regression test for https://github.com/earendil-works/pi/issues/8992

function createSyntheticChildProcess(): ChildProcess {
	const events = new EventEmitter();
	return Object.assign(events, {
		stdout: null,
		stderr: null,
		stdin: null,
		stdio: [null, null, null, null, null],
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
}
// Windows does not expose Unix signal exit-status semantics.
test.skipIf(process.platform === "win32")("maps a signal-killed child to a non-zero exit code", async () => {
	const child = spawnProcess("/bin/sh", ["-c", "kill -9 $$"], { stdio: "ignore" });

	const exitCode = await waitForChildProcess(child);

	expect(exitCode).toBe(137);
});

test("preserves an explicit exit code even when an exit signal is reported", async () => {
	const child = createSyntheticChildProcess();
	const wait = waitForChildProcess(child, { platform: "linux" });

	child.emit("exit", 23, "SIGKILL");

	expect(await wait).toBe(23);
});

test("preserves a null signal exit code on Windows", async () => {
	const child = createSyntheticChildProcess();
	const wait = waitForChildProcess(child, { platform: "win32" });

	child.emit("exit", null, "SIGKILL");

	expect(await wait).toBeNull();
});

test("preserves a null exit code for an unknown Unix signal", async () => {
	const child = createSyntheticChildProcess();
	const wait = waitForChildProcess(child, { platform: "linux" });

	child.emit("exit", null, "SIGUNKNOWN" as NodeJS.Signals);

	expect(await wait).toBeNull();
});
