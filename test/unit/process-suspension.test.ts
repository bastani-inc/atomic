import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { createProcessSuspender } from "../helpers/process-suspension.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

/** Appends one byte to the file it is given every 20 ms, in a synchronous write: nothing is buffered in a pipe. */
const TICK_SCRIPT =
	'const { appendFileSync } = require("node:fs"); setInterval(() => appendFileSync(process.argv[1], "."), 20);';
const CONTROLLER_AND_CHILD_TIMEOUT_MS = 60_000;

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
