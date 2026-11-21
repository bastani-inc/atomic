import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "vitest";
import {
	isGone,
	READS_PROCESS_STARTS,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
} from "../helpers/recorded-process.js";

/** A process this test started and holds the handle of, so its pid names it until the test ends it. */
async function liveProcess() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	const pid = child.pid;
	assert.ok(pid !== undefined);
	return {
		pid,
		exited: () => child.exitCode !== null || child.signalCode !== null,
		async end() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		},
	};
}

const readsStartsTest = READS_PROCESS_STARTS ? test : test.skip;

test("a recorded process runs, may be signalled, and is gone once it has exited (#6125)", async () => {
	const live = await liveProcess();
	try {
		const recorded = await recordProcess(live.pid);
		assert.equal(await stillRuns(recorded), true);
		assert.equal(await isGone(recorded), false);

		assert.equal(await signalRecordedProcess(recorded), true);
		await live.end();
		assert.equal(await isGone(recorded), true);
		assert.equal(await stillRuns(recorded), false);
	} finally {
		await live.end();
	}
});

readsStartsTest(
	"a pid that now names a process started at another time is never signalled, and counts as gone (#6125)",
	async () => {
		const live = await liveProcess();
		try {
			const earlier = { pid: live.pid, started: "a start no process of this host has" };

			assert.equal(await stillRuns(earlier), false);
			assert.equal(await signalRecordedProcess(earlier), false);
			assert.equal(live.exited(), false, "the cleanup signalled a process it did not start");
			assert.equal(await isGone(earlier), true);
		} finally {
			await live.end();
		}
	},
);

readsStartsTest(
	"a running process recorded without its start is never signalled, and is not taken for gone (#6125)",
	async () => {
		const live = await liveProcess();
		try {
			const unknown = { pid: live.pid, started: undefined };

			assert.equal(await signalRecordedProcess(unknown), false);
			assert.equal(live.exited(), false, "the cleanup signalled a process it could not identify");
			assert.equal(await isGone(unknown), false, "a process that still runs was taken for gone");
		} finally {
			await live.end();
		}
	},
);
