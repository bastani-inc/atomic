import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createProcessSuspender } from "../helpers/process-suspension.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

/** Appends one byte to the file it is given every 20 ms, in a synchronous write: nothing is buffered in a pipe. */
const TICK_SCRIPT =
	'const { appendFileSync } = require("node:fs"); setInterval(() => appendFileSync(process.argv[1], "."), 20);';
/** The same ticks, from a process that also reads the stdin pipe its parent gave it, as a journal writer waits for "go". */
const READING_TICK_SCRIPT = `${TICK_SCRIPT} process.stdin.resume();`;
const CONTROLLER_AND_CHILD_TIMEOUT_MS = 60_000;

test(
	"a process reading its stdin pipe is reported suspended as soon as it is suspended (#4383)",
	async () => {
		const directory = makeTempDirectory("process-suspension-");
		const tickFile = join(directory, "ticks");
		const ticks = () => (existsSync(tickFile) ? statSync(tickFile).size : 0);
		const suspender = await createProcessSuspender();
		const child = spawn(process.execPath, ["-e", READING_TICK_SCRIPT, tickFile], {
			stdio: ["pipe", "ignore", "inherit"],
		});
		try {
			const pid = child.pid;
			assert.ok(pid !== undefined);
			while (ticks() < 3) await sleep(20);

			await suspender.suspend(pid);
			assert.equal(await suspender.isSuspended(pid), true, "a suspended process is reported suspended");
			const frozen = ticks();
			await sleep(200);
			assert.equal(ticks(), frozen, "a suspended process makes no progress");

			await suspender.resume(pid);
			while (ticks() < frozen + 3) await sleep(20);
			assert.equal(await suspender.isSuspended(pid), false, "a resumed process is not reported suspended");
		} finally {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGKILL");
			await exited;
			await suspender.close();
			removeTempDirectory(directory);
		}
	},
	CONTROLLER_AND_CHILD_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"on POSIX, suspend resolves only once the process is stopped, when the stop lands after the signal is sent (#4383)",
	async () => {
		const suspender = await createProcessSuspender();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 20)"], { stdio: "ignore" });
		// SIGSTOP stops a process only once it is next scheduled; on a loaded host that can come after `ps` looks.
		const kill = process.kill.bind(process);
		const lateStop = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (signal !== "SIGSTOP") return kill(pid, signal);
			setTimeout(() => kill(pid, signal), 150);
			return true;
		});
		try {
			const pid = child.pid;
			assert.ok(pid !== undefined);
			await suspender.suspend(pid);
			assert.equal(await suspender.isSuspended(pid), true, "a suspended process is reported suspended");
		} finally {
			lateStop.mockRestore();
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGKILL");
			await exited;
			await suspender.close();
		}
	},
	CONTROLLER_AND_CHILD_TIMEOUT_MS,
);

test.each([true, false])(
	"a suspended process stops until resumed and exits during cleanup, resume=%s (#4313)",
	async (resumeBeforeCleanup) => {
		const directory = makeTempDirectory("process-suspension-");
		const tickFile = join(directory, "ticks");
		const ticks = () => (existsSync(tickFile) ? statSync(tickFile).size : 0);
		const suspender = await createProcessSuspender();
		const child = spawn(process.execPath, ["-e", TICK_SCRIPT, tickFile], { stdio: ["ignore", "ignore", "inherit"] });
		try {
			const pid = child.pid;
			assert.ok(pid !== undefined);
			while (ticks() < 3) await sleep(20);
			assert.equal(await suspender.isSuspended(pid), false, "a running process is not reported suspended");

			await suspender.suspend(pid);
			while (!(await suspender.isSuspended(pid))) await sleep(20);
			const frozen = ticks();
			assert.equal(await suspender.isSuspended(pid), true, "a suspended process stays suspended");
			assert.equal(ticks(), frozen, "a suspended process makes no progress");

			if (resumeBeforeCleanup) {
				await suspender.resume(pid);
				while (ticks() < frozen + 3) await sleep(20);
				assert.equal(await suspender.isSuspended(pid), false, "a resumed process is not reported suspended");
			}
		} finally {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGKILL");
			await exited;
			await suspender.close();
			removeTempDirectory(directory);
		}
	},
	CONTROLLER_AND_CHILD_TIMEOUT_MS,
);

test(
	"suspending a process that does not exist rejects (#4313)",
	async () => {
		const suspender = await createProcessSuspender();
		try {
			const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
			const pid = child.pid;
			assert.ok(pid !== undefined);
			await new Promise((resolve) => child.once("exit", resolve));
			await assert.rejects(suspender.suspend(pid));
		} finally {
			await suspender.close();
		}
	},
	CONTROLLER_AND_CHILD_TIMEOUT_MS,
);
