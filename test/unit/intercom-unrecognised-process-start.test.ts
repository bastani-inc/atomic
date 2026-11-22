import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { afterAll, describe, onTestFinished, test } from "vitest";
import { endUnansweredBroker, laterProcessProbe } from "../../packages/intercom/broker/broker-process.js";
import { isSpawnLockStale } from "../../packages/intercom/broker/spawn.js";
import { processState, processStateAsync } from "../../packages/intercom/broker/stale-lock-file.js";
import { type RecordedProcess, recordProcess, signalRecordedProcess, stillRuns } from "../helpers/recorded-process.js";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

/**
 * On Windows and macOS a record names a process by its pid and its start, the decimal count the native module reads. A
 * start in any other form, which no version writes there, proves nothing: the holder is judged as one recorded with no
 * start, by its pid alone, and never taken over or signalled because of it.
 */
const UNRECOGNISED = ["Sun Nov 22 07:05:57 2026", "zz-9", "0133998", "18446744073709551616", "9".repeat(100_000)];

const tempDir = makeTempDirectory("unrecognised-start-");
afterAll(() => removeTempDirectory(tempDir));

let locks = 0;
function lockWith(content: string): string {
	const path = join(tempDir, `broker.spawn.lock-${locks++}`);
	writeTextSync(path, content);
	return path;
}

/** How long a process sent SIGTERM may take to exit. */
const ENDED_WITHIN_MS = 10_000;

async function liveChild(): Promise<{ recorded: RecordedProcess; endsWithin: (ms: number) => Promise<boolean> }> {
	const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
		windowsHide: true,
	});
	const exited = once(child, "exit").then(() => true);
	await once(child, "spawn");
	assert.ok(child.pid !== undefined);
	const recorded = await recordProcess(child.pid);
	onTestFinished(async () => {
		await signalRecordedProcess(recorded);
	});
	const endsWithin = (ms: number) =>
		Promise.race([exited, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
	return { recorded, endsWithin };
}

async function liveProcess(): Promise<RecordedProcess> {
	return (await liveChild()).recorded;
}

describe.runIf(process.platform === "win32" || process.platform === "darwin")(
	"a recorded start in a form the reader does not recognise",
	() => {
		test("leaves a spawn lock with its live holder, as a lock that records no start", async () => {
			const holder = await liveProcess();
			for (const start of UNRECOGNISED) {
				assert.equal(isSpawnLockStale(lockWith(`${holder.pid} ${start}\n${Date.now()}\n`)), false, start);
				assert.equal(
					isSpawnLockStale(lockWith(`${process.pid}\n${Date.now()}\n${holder.pid} ${start}\n`)),
					false,
					`a broker line with ${start}`,
				);
			}
		});

		test("leaves a socket lock held by its live holder, as a lock that records no start", async () => {
			const holder = await liveProcess();
			for (const start of UNRECOGNISED) {
				assert.equal(processState(holder.pid, start, "", false), "held", start);
				assert.equal(await processStateAsync(holder.pid, start, "", false), "held", start);
			}
		});

		test("does not take a found broker for a later process given its pid", async () => {
			for (const start of UNRECOGNISED) {
				// The pid now names a process that started at a time this reader can read.
				const isLater = laterProcessProbe(
					{ pid: 4242, started: start, wroteBrokerPid: "unknown" },
					async () => "1234",
				);
				// The probe takes the broker it was given, then reads the pid's start, and says so the call after.
				for (let call = 0; call < 3; call++) {
					assert.equal(isLater(), false, start);
					await new Promise((resolve) => setImmediate(resolve));
				}
				assert.equal(isLater(), false, start);
			}
		});

		test("ends a broker that did not answer as one whose start was never read", async () => {
			const without = await liveChild();
			const withThem = await Promise.all(UNRECOGNISED.map(() => liveChild()));
			await endUnansweredBroker({ pid: without.recorded.pid, started: undefined, wroteBrokerPid: "yes" });
			for (const [index, start] of UNRECOGNISED.entries()) {
				const withIt = withThem[index];
				assert.ok(withIt);
				await endUnansweredBroker({ pid: withIt.recorded.pid, started: start, wroteBrokerPid: "yes" });
			}
			// Where a broker whose start was never read is ended (macOS, by its pid), so is each of these; where it is not
			// (Windows), none of these is.
			const ended = await without.endsWithin(ENDED_WITHIN_MS);
			const endedWithThem = await Promise.all(
				withThem.map(async (withIt) =>
					ended ? withIt.endsWithin(ENDED_WITHIN_MS) : !(await stillRuns(withIt.recorded)),
				),
			);
			assert.deepEqual(
				endedWithThem,
				UNRECOGNISED.map(() => ended),
			);
		});
	},
);
