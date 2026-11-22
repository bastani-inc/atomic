import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, onTestFinished, test } from "vitest";
import {
	endUnansweredBroker,
	readProcessStart,
	readProcessStartWithoutProcess,
} from "../../packages/intercom/broker/broker-process.js";
import { isSpawnLockStale } from "../../packages/intercom/broker/spawn.js";
import { processStart, processStartAsync } from "../../packages/intercom/broker/stale-lock-file.js";
import { processCreationTimeOf } from "../../packages/intercom/broker/start-announcement.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * On macOS the broker tells a process from a later one given its pid by its start, read by the native module (as on
 * Windows, in the same form), and every record of a process (the spawn lock, the socket lock, a broker found to be
 * stopped) reads and writes it the same way. Run on macOS.
 */

/** How long a process that was sent SIGKILL may take to be reaped. */
const REAPED_WITHIN_MS = 10_000;

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

async function sleeper() {
	const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
	await once(child, "spawn");
	assert.ok(child.pid !== undefined);
	const pid = child.pid;
	const exited = once(child, "exit");
	onTestFinished(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	});
	return { child, pid, exited };
}

describe.runIf(process.platform === "darwin")("a process's start on macOS", () => {
	test("is read the same way each time, by every reader, and differs for a process started at another time", async () => {
		const { pid } = await sleeper();
		const started = processCreationTimeOf(pid);
		assert.match(started ?? "", /^[1-9]\d*$/u);
		assert.equal(processCreationTimeOf(pid), started);
		// The spawn and socket locks and a found broker read it the same way, so a record one writes another reads.
		assert.equal(processStart(pid), started);
		assert.equal(await processStartAsync(pid), started);
		assert.equal(await readProcessStart(pid), started);
		assert.equal(await readProcessStartWithoutProcess(pid), started);
		// This test's own process started before it.
		const own = processCreationTimeOf(process.pid);
		assert.match(own ?? "", /^[1-9]\d*$/u);
		assert.ok(BigInt(own ?? "0") < BigInt(started ?? "0"));
	});

	test("is read for a process another user owns, as ps reads it", () => {
		// launchd runs as root.
		const started = processCreationTimeOf(1);
		assert.match(started ?? "", /^[1-9]\d*$/u);
		const printed = execFileSync("/bin/ps", ["-o", "lstart=", "-p", "1"], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
		}).trim();
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const parts = /^\w{3} (\w{3}) +(\d+) (\d+):(\d+):(\d+) (\d+)$/u.exec(printed);
		assert.ok(parts, printed);
		const [, month = "", day, hours, minutes, seconds, year] = parts;
		const unixSeconds =
			Date.UTC(Number(year), months.indexOf(month), Number(day), Number(hours), Number(minutes), Number(seconds)) /
			1000;
		assert.equal(Number(BigInt(started ?? "0") / 10_000_000n) - 11_644_473_600, unixSeconds, printed);
	});

	test("tells a broker's pid that now names another user's process from the broker, and signals neither", async () => {
		const own = processCreationTimeOf(process.pid);
		assert.ok(own !== undefined);
		// The broker found exited, and macOS gave its pid to a process of another user: launchd stands in for it.
		await endUnansweredBroker({ pid: 1, started: own, wroteBrokerPid: "unknown" });
		const directory = makeTempDirectory("macos-other-user-");
		directories.push(directory);
		const lock = join(directory, "broker.spawn.lock");
		writeFileSync(lock, `${process.pid}\n${Date.now()}\n1 ${own}\n`);
		assert.equal(isSpawnLockStale(lock), true, "the lock's broker is gone");
		assert.equal(processStart(1), processCreationTimeOf(1));
	});

	test("is not read once the process has exited", async () => {
		const { child, pid, exited } = await sleeper();
		child.kill("SIGKILL");
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, REAPED_WITHIN_MS))]);

		assert.equal(processCreationTimeOf(pid), undefined);
	});

	test("a broker that did not answer is ended while its pid names the process it was found as, and not once it names another", async () => {
		const named = await sleeper();
		const other = await sleeper();
		const otherStarted = processCreationTimeOf(other.pid);

		// Found as a process that started at another time: this test's own.
		await endUnansweredBroker({
			pid: other.pid,
			started: processCreationTimeOf(process.pid),
			wroteBrokerPid: "unknown",
		});
		await endUnansweredBroker({
			pid: named.pid,
			started: processCreationTimeOf(named.pid),
			wroteBrokerPid: "unknown",
		});
		await Promise.race([named.exited, new Promise((resolve) => setTimeout(resolve, REAPED_WITHIN_MS))]);

		assert.equal(named.child.signalCode, "SIGTERM", "the broker its pid names was ended");
		// A signal sent to it would have ended it by now, as it ended the other.
		assert.equal(processCreationTimeOf(other.pid), otherStarted, "another process was not");
	});

	test("a spawn lock names its broker by pid and start: one an earlier version wrote by pid alone still holds", async () => {
		const directory = makeTempDirectory("macos-spawn-lock-");
		directories.push(directory);
		const lock = join(directory, "broker.spawn.lock");
		const broker = await sleeper();
		const write = (brokerLine: string) => writeFileSync(lock, `${process.pid}\n${Date.now()}\n${brokerLine}\n`);

		write(String(broker.pid));
		assert.equal(isSpawnLockStale(lock), false, "an earlier version's lock, by pid alone");
		write(`${broker.pid} ${processCreationTimeOf(broker.pid)}`);
		assert.equal(isSpawnLockStale(lock), false, "this version's lock, while its broker runs");
		const another = processCreationTimeOf(process.pid);
		assert.ok(another !== undefined);
		write(`${broker.pid} ${another}`);
		assert.equal(isSpawnLockStale(lock), true, "its pid names a process started at another time");
	});
});
