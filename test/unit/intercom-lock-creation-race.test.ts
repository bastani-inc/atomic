/**
 * Intercom's spawn lock and broker socket-replacement lock are taken by creating a file that records the holder (#5220).
 * A file created and then written is seen empty in between, and an empty lock reads as one left by a crashed process:
 * another process judged it stale and replaced it while its creator, paused between the two steps, went on to believe
 * it held the lock. On a loaded Windows runner that pause is long enough for two spawners to own one lock. These
 * tests pause a creator at that point, as the operating system can, and let another process take the lock meanwhile.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

/** The lock being made, and what another process does while this one is paused making it (#5220). */
const race = vi.hoisted(() => ({
	lockPath: undefined as string | undefined,
	whileMaking: undefined as (() => void) | undefined,
}));

/** Runs the pause hook once, when this process makes the lock at `path`. */
function pauseMaking(path: unknown): void {
	if (race.lockPath === undefined || String(path) !== race.lockPath) return;
	const hook = race.whileMaking;
	race.whileMaking = undefined;
	hook?.();
}

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	// A file created with "wx" exists empty until it is written: the pause falls between the two.
	const writeFileSync = ((path, data, options) => {
		const flag = typeof options === "object" && options !== null ? options.flag : undefined;
		if (flag !== "wx" || race.whileMaking === undefined || String(path) !== race.lockPath) {
			actual.writeFileSync(path, data, options);
			return;
		}
		const fd = actual.openSync(String(path), "wx");
		try {
			pauseMaking(path);
			actual.writeSync(fd, String(data));
		} finally {
			actual.closeSync(fd);
		}
	}) as typeof actual.writeFileSync;
	// A lock linked into place appears complete: the pause falls just after it appears.
	const linkSync = ((existing, path) => {
		actual.linkSync(existing, path);
		pauseMaking(path);
	}) as typeof actual.linkSync;
	// Where no hard link can be made (FAT), a lock is created and then written: the pause falls between the two.
	const openSync = ((path: import("fs").PathLike, flags?: import("fs").OpenMode, mode?: import("fs").Mode | null) => {
		const fd = (actual.openSync as (...args: unknown[]) => number)(path, flags, mode);
		if (flags === "wx") pauseMaking(path);
		return fd;
	}) as typeof actual.openSync;
	return {
		...actual,
		default: { ...actual, writeFileSync, linkSync, openSync },
		writeFileSync,
		linkSync,
		openSync,
	};
});

const { acquireSpawnLock } = await import("../../packages/intercom/broker/spawn.js");
const { acquireSocketReplacementLock } = await import("../../packages/intercom/broker/socket-replacement-lock.js");
const { existsSync, utimesSync } = await import("node:fs");

const tempDir = makeTempDirectory("ic5220-");
afterAll(() => removeTempDirectory(tempDir));
afterEach(() => {
	race.lockPath = undefined;
	race.whileMaking = undefined;
});

let lockCount = 0;

/** A spawn lock whose spawner is long gone: no live process has a pid this large. */
function staleSpawnLock(): string {
	const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
	writeTextSync(path, `2147483646\n${Date.now()}\n`);
	return path;
}

/** Longer than the grace an unreadable broker lock gets before it counts as left by a crashed process. */
const LONG_PAUSE_MS = 5_000;

describe("a lock is never taken from the process making it (#5220)", () => {
	test("a spawner paused while making the spawn lock is its only owner: another spawner waits (#5220)", () => {
		const path = staleSpawnLock();
		race.lockPath = path;
		let other: string | undefined;
		race.whileMaking = () => {
			other = acquireSpawnLock(path);
		};

		const owner = acquireSpawnLock(path);
		const owners = [owner, other].filter((held) => held !== undefined);
		assert.equal(owners.length, 1, `exactly one spawner owns the lock: ${JSON.stringify([owner, other])}`);
	});

	test("a spawner paused while making the spawn lock with none there is its only owner (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		race.lockPath = path;
		let other: string | undefined;
		race.whileMaking = () => {
			other = acquireSpawnLock(path);
		};

		const owner = acquireSpawnLock(path);
		const owners = [owner, other].filter((held) => held !== undefined);
		assert.equal(owners.length, 1, `exactly one spawner owns the lock: ${JSON.stringify([owner, other])}`);
	});

	test("a broker paused for seconds while making the socket-replacement lock keeps it: another broker waits (#5220)", async () => {
		const path = join(tempDir, `broker.socket.lock-${lockCount++}`);
		race.lockPath = path;
		const holders = new Set<string>();
		const take = async (broker: string) => {
			const release = await acquireSocketReplacementLock(path);
			holders.add(broker);
			return () => {
				holders.delete(broker);
				release();
			};
		};
		let other: Promise<() => void> | undefined;
		race.whileMaking = () => {
			// The pause outlasts the grace an unreadable lock gets, as a stalled process on a loaded runner can.
			const paused = new Date(Date.now() - LONG_PAUSE_MS);
			if (existsSync(path)) utimesSync(path, paused, paused);
			other = take("other");
		};

		const mine = take("this");
		assert.ok(other !== undefined, "the other broker tried while this one was paused");
		const first = await Promise.race([mine, other]);
		// Give the broker still waiting time to poll the lock again and take it if it ever judges it stale.
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(holders.size, 1, `one broker holds the lock: ${[...holders].join(",")}`);
		first();
		const releases = await Promise.all([mine, other]);
		assert.equal(holders.size, 1, "the other broker takes the lock once it is released");
		for (const release of releases) release();
	});
});
