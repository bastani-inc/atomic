import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { afterAll, describe, onTestFinished, test } from "vitest";
import {
	acquireSpawnLockAsync,
	isSpawnLockStale,
	releaseSpawnLockAsync,
} from "../../packages/intercom/broker/spawn.js";
import { keptExitedPid } from "../helpers/exited-process.js";
import {
	currentProcessStart,
	READS_PROCESS_STARTS,
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
} from "../helpers/recorded-process.js";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

/**
 * The broker spawn lock names a live process (its spawner, or the broker it was handed to) by pid. Windows gives the pid
 * of an exited process to another within seconds, so the lock also records when that process started, and a pid that
 * names a process with another start no longer holds it. A test cannot make the OS reuse a pid on demand, so a later
 * process is stood in for by a live process whose start differs from the one the lock records, which is how a reused
 * pid looks.
 */

const tempDir = makeTempDirectory("spawn-lock-start-");
afterAll(() => removeTempDirectory(tempDir));

let locks = 0;
function lockWith(content: string): string {
	const path = join(tempDir, `broker.spawn.lock-${locks++}`);
	writeTextSync(path, content);
	return path;
}

async function liveProcess(): Promise<RecordedProcess> {
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
	assert.ok(recorded.started !== undefined, "the stand-in's start was read");
	return recorded;
}

/** A start that is not the stand-in's: the start of this test's own process. */
async function anotherStart(): Promise<string> {
	const started = await currentProcessStart(process.pid);
	assert.ok(started !== undefined);
	return started;
}

describe.skipIf(!READS_PROCESS_STARTS)("a spawn lock whose pid now names a later process", () => {
	test("a spawner the lock names is gone once its pid names a process that started at another time", async () => {
		const later = await liveProcess();
		const path = lockWith(`${later.pid} ${await anotherStart()}\n${Date.now()}\n`);

		assert.equal(isSpawnLockStale(path), true);
		const owner = await acquireSpawnLockAsync(path);
		assert.ok(owner !== undefined, "the lock was not taken while a later process held the spawner's pid");
		await releaseSpawnLockAsync(owner, path);
	});

	test("a broker the lock was handed to is gone once its pid names a process that started at another time", async () => {
		const later = await liveProcess();
		const spawner = await keptExitedPid();
		onTestFinished(() => spawner.release());
		const path = lockWith(`${spawner.pid}\n${Date.now()}\n${later.pid} ${await anotherStart()}\n`);

		assert.equal(isSpawnLockStale(path), true);
	});

	test("the process the lock names keeps it while its pid names the process that started when recorded", async () => {
		const holder = await liveProcess();
		const spawner = await keptExitedPid();
		onTestFinished(() => spawner.release());

		assert.equal(isSpawnLockStale(lockWith(`${holder.pid} ${holder.started}\n${Date.now()}\n`)), false);
		assert.equal(
			isSpawnLockStale(lockWith(`${spawner.pid}\n${Date.now()}\n${holder.pid} ${holder.started}\n`)),
			false,
		);
		assert.equal(
			isSpawnLockStale(lockWith(`${holder.pid}\n${Date.now()}\n`)),
			false,
			"a lock an earlier version wrote, without a start, follows its live pid as before",
		);
	});
});

describe("a spawn lock read by a spawner of an earlier version", () => {
	const previousSpawn = join(resolve(import.meta.dirname, "../fixtures/intercom-0.9.71"), "broker/spawn.ts");

	test("names the same live spawner and broker an earlier version would wait for, and nothing once they are gone", async () => {
		const { isSpawnLockStale: previousIsSpawnLockStale } = (await import(previousSpawn)) as {
			isSpawnLockStale: (lockPath: string) => boolean;
		};
		const path = join(tempDir, "broker.spawn.lock-previous");
		const owner = await acquireSpawnLockAsync(path);
		assert.ok(owner !== undefined);
		onTestFinished(() => releaseSpawnLockAsync(owner, path));
		assert.equal(
			previousIsSpawnLockStale(path),
			false,
			"this live spawner's lock looked stale to an earlier version",
		);

		const broker = await liveProcess();
		const handed = lockWith(`${owner}${broker.pid} ${broker.started}\n`);
		assert.equal(previousIsSpawnLockStale(handed), false, "a live broker's lock looked stale to an earlier version");
		const exited = await keptExitedPid();
		onTestFinished(() => exited.release());
		const gone = lockWith(`${owner}${exited.pid} ${broker.started}\n`);
		assert.equal(previousIsSpawnLockStale(gone), true);
	});
});
