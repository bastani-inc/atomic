import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { afterAll, onTestFinished, test, vi } from "vitest";
import { recordProcess, signalRecordedProcess } from "../helpers/recorded-process.js";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

/**
 * Intercom's files can be loaded by an Atomic host older than them, as by a session still running while an update
 * replaces the package. Such a host has none of the process start readers the broker spawn lock and the broker's
 * identity use. Without them Intercom still starts its broker, and a pid decides alone, as before.
 */
vi.mock("@bastani/atomic", async (importOriginal) => {
	const host = await importOriginal<Record<string, unknown>>();
	// Absent from the older host: read as undefined, as the module loader of such a host reads a missing export.
	return {
		...host,
		processStartToken: undefined,
		readProcessStartToken: undefined,
		readProcessCreationTime: undefined,
		nativeProcessCreationTime: undefined,
		nativeTerminateProcess: undefined,
	};
});

const { acquireSpawnLockAsync, isSpawnLockStale, releaseSpawnLockAsync } = await import(
	"../../packages/intercom/broker/spawn.js"
);
const { identifyBrokerProcessAsync } = await import("../../packages/intercom/broker/broker-process.js");

const tempDir = makeTempDirectory("older-host-starts-");
afterAll(() => removeTempDirectory(tempDir));

async function liveProcess(): Promise<number> {
	const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
		windowsHide: true,
	});
	await once(child, "spawn");
	assert.ok(child.pid !== undefined);
	const recorded = await recordProcess(child.pid);
	onTestFinished(async () => {
		await signalRecordedProcess(recorded);
	});
	return child.pid;
}

test("with a host older than Intercom, a session takes the spawn lock, which names its pid alone", async () => {
	const path = join(tempDir, "broker.spawn.lock-own");
	const owner = await acquireSpawnLockAsync(path);
	assert.ok(owner !== undefined);
	onTestFinished(() => releaseSpawnLockAsync(owner, path));
	assert.equal(owner.split("\n")[0], String(process.pid));
});

test("with a host older than Intercom, a lock naming a live process stays held whatever start it records", async () => {
	const pid = await liveProcess();
	const path = join(tempDir, "broker.spawn.lock-live");
	writeTextSync(path, `${pid} another-start\n${Date.now()}\n`);
	assert.equal(isSpawnLockStale(path), false);
});

test("with a host older than Intercom, a broker is found by its pid alone", async () => {
	const pid = await liveProcess();
	const found = await identifyBrokerProcessAsync(pid, join(tempDir, "broker.pid"));
	assert.deepEqual(found, { pid, started: undefined, wroteBrokerPid: "unknown" });
});
