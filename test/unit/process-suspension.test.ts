import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "vitest";
import { createProcessSuspender } from "../helpers/process-suspension.js";
import { sleep } from "../helpers/runtime.js";

const TICK_SCRIPT = 'let n = 0; setInterval(() => process.stdout.write(++n + "\\n"), 20);';
const SETTLE_MS = 300;
const OBSERVE_MS = 600;
const CONTROLLER_AND_CHILD_TIMEOUT_MS = 60_000;

test(
	"a suspended process stops running until it is resumed (#4313)",
	async () => {
		const suspender = await createProcessSuspender();
		const child = spawn(process.execPath, ["-e", TICK_SCRIPT], { stdio: ["ignore", "pipe", "inherit"] });
		let ticks = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			ticks += chunk.toString().split("\n").length - 1;
		});
		try {
			const pid = child.pid;
			assert.ok(pid !== undefined);
			while (ticks < 3) await sleep(20);

			await suspender.suspend(pid);
			await sleep(SETTLE_MS);
			const frozen = ticks;
			await sleep(OBSERVE_MS);
			assert.equal(ticks, frozen, "a suspended process produces no output");

			await suspender.resume(pid);
			while (ticks < frozen + 3) await sleep(20);
		} finally {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill();
			await exited;
			await suspender.close();
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
