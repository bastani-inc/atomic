import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { describe, onTestFinished, test } from "vitest";
import { endUnansweredBroker } from "../../packages/intercom/broker/broker-process.js";
import { waitForBrokerExit } from "../../packages/intercom/broker/broker-stop.js";
import {
	currentProcessStart,
	isGone,
	READS_PROCESS_STARTS,
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../helpers/recorded-process.js";

/**
 * A broker found by its pid is told apart from a later process the OS gives that pid. Windows gives the pid of an exited
 * process to another within seconds; a test cannot make the OS reuse a pid on demand, so a later process is stood in for
 * by a live process whose start differs from the one the broker was found with, which is how a reused pid looks.
 */

/** The bound a stop waits for the broker to exit: a wait that does not see the later process ends at it, with an error. */
const STOP_WAIT_MS = 10_000;
/** How long a signalled stand-in broker may take to be gone, on a loaded machine. */
const GONE_WITHIN_MS = 15_000;

/** A live process standing in for whatever holds the pid now, recorded while it runs and stopped after the test. */
async function liveProcess(
	script = "setInterval(() => {}, 1000)",
): Promise<{ child: ChildProcess; recorded: RecordedProcess }> {
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	await once(child, "spawn");
	assert.ok(child.pid !== undefined);
	const recorded = await recordProcess(child.pid);
	onTestFinished(async () => {
		await signalRecordedProcess(recorded);
	});
	return { child, recorded };
}

/** A start that is not the process `pid`'s: the start of this test's own process. */
async function anotherStart(): Promise<string> {
	const started = await currentProcessStart(process.pid);
	assert.ok(started !== undefined);
	return started;
}

describe.skipIf(!READS_PROCESS_STARTS)("a broker pid that names a later process", () => {
	test("the stop wait ends once the broker's pid names a process that started at another time", async () => {
		const { recorded } = await liveProcess();
		const found = { pid: recorded.pid, started: await anotherStart(), wroteBrokerPid: "unknown" as const };

		await waitForBrokerExit(recorded.pid, STOP_WAIT_MS, undefined, found);
		assert.equal(await stillRuns(recorded), true, "the wait signalled the process");
	});

	test("the stop wait keeps waiting while the pid still names the process it found", async () => {
		const { recorded } = await liveProcess();
		const found = { pid: recorded.pid, started: recorded.started, wroteBrokerPid: "unknown" as const };

		await assert.rejects(() => waitForBrokerExit(recorded.pid, 300, undefined, found), {
			name: "IntercomBrokerStopTimeoutError",
		});
	});

	test("a broker that did not answer is not signalled once its pid names a process that started at another time", async () => {
		const { recorded } = await liveProcess();

		await endUnansweredBroker({ pid: recorded.pid, started: await anotherStart(), wroteBrokerPid: "yes" });
		assert.equal(await stillRuns(recorded), true);
	});

	test("a broker that did not answer is ended while its pid names it, and only the broker, not a process it started", async () => {
		// The stand-in broker starts a child of its own and reports its pid.
		const { child, recorded } = await liveProcess(
			`const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			process.stdout.write(String(c.pid) + "\\n"); setInterval(() => {}, 1000);`,
		);
		const [line] = (await once(child.stdout!, "data")) as [Buffer];
		const grandchild = await recordProcess(Number.parseInt(line.toString(), 10));
		onTestFinished(async () => {
			await signalRecordedProcess(grandchild);
		});

		await endUnansweredBroker({ pid: recorded.pid, started: recorded.started, wroteBrokerPid: "yes" });
		assert.equal(await waitUntilGone(recorded, GONE_WITHIN_MS), true, "the broker was not ended");
		assert.equal(await isGone(grandchild), false, "a process the broker started was ended too");
	});
});
