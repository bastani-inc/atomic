import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, onTestFinished, test } from "vitest";
import { endUnansweredBroker, readPsProcessStart, wroteFileAt } from "../../packages/intercom/broker/broker-process.js";
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

	test("a broker that did not answer is not ended by its pid alone when its creation time could not be read", async () => {
		const { recorded } = await liveProcess();

		// broker.pid's write time could not tell either way, and no start was read for the pid.
		await endUnansweredBroker({ pid: recorded.pid, started: undefined, wroteBrokerPid: "unavailable" });
		assert.equal(await stillRuns(recorded), true);
	});

	test("a broker that did not answer is ended while its pid names it, and only the broker, not a process it started", async () => {
		// The stand-in broker starts a child of its own and reports its pid. Detached, so that on Windows it is outside the
		// job object that ends a process's other children with it, as a broker's own detached helpers are.
		const { child, recorded } = await liveProcess(
			`const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
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

describe("telling the broker that wrote broker.pid by its write time", () => {
	/** A process creation time, in nanoseconds since 1970 UTC. */
	const created = 1_795_000_000_000_000_000n;
	const SECOND_NS = 1_000_000_000n;
	const HOUR_NS = 3_600n * SECOND_NS;

	test("a write time a FAT volume kept, rounded up to 2 s in local time, proves nothing either way", () => {
		// broker.pid written 100 ms after the broker started; FAT keeps it rounded up to 2 s, in local time, so read back
		// after the clocks changed it is an hour off one way or the other.
		const kept = ((created + 100_000_000n + 2n * SECOND_NS - 1n) / (2n * SECOND_NS)) * (2n * SECOND_NS);
		for (const readBack of [kept, kept - HOUR_NS, kept + HOUR_NS]) {
			assert.equal(wroteFileAt(created, readBack), "unavailable", String(readBack - created));
		}
	});

	test("a write time an exFAT volume kept, to 10 ms, proves nothing either way", () => {
		assert.equal(wroteFileAt(created, created + 120_000_000n), "unavailable");
		assert.equal(wroteFileAt(created, created - HOUR_NS + 10_000_000n), "unavailable");
	});

	test("a precise write time tells the broker that wrote it from a process created after it", () => {
		const written = created + 123_456_700n;
		assert.equal(wroteFileAt(created, written), "yes");
		assert.equal(wroteFileAt(written, written), "unknown");
		assert.equal(wroteFileAt(written + SECOND_NS, written), "unknown");
		assert.equal(wroteFileAt(written + 2n * SECOND_NS, written), "no");
	});
});

// macOS reads a process's start with `ps`, to the second. The same `ps -o lstart` runs on Linux, so the reader and the
// macOS stop path are checked here with the platform stood in for.
describe.skipIf(process.platform === "win32")("a broker's start as ps reads it", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	afterEach(() => {
		if (platform !== undefined) Object.defineProperty(process, "platform", platform);
	});
	function onMacOS(): void {
		Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
	}

	test("reads the same start for a running process each time, another for a process started earlier, none once it is gone", async () => {
		const { recorded } = await liveProcess();
		const first = await readPsProcessStart(recorded.pid);
		assert.ok(first !== undefined);
		assert.equal(await readPsProcessStart(recorded.pid), first);
		// The first process of the system started long before this test's.
		assert.notEqual(await readPsProcessStart(1), first);
		await signalRecordedProcess(recorded);
		assert.equal(await waitUntilGone(recorded, GONE_WITHIN_MS), true);
		assert.equal(await readPsProcessStart(recorded.pid), undefined);
	});

	test("on macOS a broker that did not answer is not signalled once ps shows its pid names a process started at another time", async () => {
		const { recorded } = await liveProcess();
		const started = await readPsProcessStart(1);
		assert.ok(started !== undefined);
		onMacOS();

		await endUnansweredBroker({ pid: recorded.pid, started, wroteBrokerPid: "unknown" });
		assert.equal(await stillRuns(recorded), true);
	});

	test("on macOS a broker that did not answer is ended while ps shows its pid names it, or cannot tell", async () => {
		const named = await liveProcess();
		const started = await readPsProcessStart(named.recorded.pid);
		assert.ok(started !== undefined);
		const unknown = await liveProcess();
		onMacOS();

		await endUnansweredBroker({ pid: named.recorded.pid, started, wroteBrokerPid: "unknown" });
		await endUnansweredBroker({ pid: unknown.recorded.pid, started: undefined, wroteBrokerPid: "unknown" });
		assert.equal(await waitUntilGone(named.recorded, GONE_WITHIN_MS), true, "the broker its pid names was not ended");
		assert.equal(
			await waitUntilGone(unknown.recorded, GONE_WITHIN_MS),
			true,
			"a broker whose start was not read was not ended, as before",
		);
	});
});
