/**
 * A spawn-lock holder that writes its lock again (renews it) or removes it races a spawner replacing the lock as stale
 * once it has aged out (#5220). Each test pauses one process between its check and its write, as the operating system
 * can, and lets the others act meanwhile; afterwards at most one spawner may hold the lock, and a holder that lost it
 * must find that out at its next renewal. Spawners are in-process calls; the takeover mutex conflicts between them as it
 * does between processes.
 */

import assert from "node:assert/strict";
import { closeSync, openSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";
import { makeTempDirectory, readTextSync, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

/** The spawn lock under test, and what other processes do while this one is paused (#5220). */
const race = vi.hoisted(() => ({
	lockPath: undefined as string | undefined,
	/** Just before a file is renamed onto the lock: a renewal writing it again. */
	beforeRenameOnto: undefined as (() => void) | undefined,
	/** Just before the lock is renamed aside: a stale replacement moving it. */
	beforeRenameAway: undefined as (() => void) | undefined,
	/** Just before a file moved aside is linked back to the lock's path. */
	beforePutBack: undefined as (() => void) | undefined,
	/** The error a hard link to the lock's path fails with, as on a file system without hard links. */
	linkError: undefined as string | undefined,
	/** How often `/proc` was listed, as a scan of other processes' open files does. */
	procListings: 0,
	/** A user id reported for the lock instead of its own, as for a lock another user left. */
	foreignUid: undefined as number | undefined,
}));

function once(take: () => (() => void) | undefined, clear: () => void): void {
	const hook = take();
	if (hook === undefined) return;
	clear();
	hook();
}

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	const renameSync = ((from, to) => {
		if (race.lockPath !== undefined && String(to) === race.lockPath) {
			once(
				() => race.beforeRenameOnto,
				() => {
					race.beforeRenameOnto = undefined;
				},
			);
		}
		if (race.lockPath !== undefined && String(from) === race.lockPath) {
			once(
				() => race.beforeRenameAway,
				() => {
					race.beforeRenameAway = undefined;
				},
			);
		}
		actual.renameSync(from, to);
	}) as typeof actual.renameSync;
	const linkSync = ((existing, path) => {
		if (race.lockPath !== undefined && String(path) === race.lockPath) {
			if (race.linkError !== undefined) {
				throw Object.assign(new Error(`${race.linkError}: link not permitted`), { code: race.linkError });
			}
			if (String(existing).endsWith(".stale")) {
				once(
					() => race.beforePutBack,
					() => {
						race.beforePutBack = undefined;
					},
				);
			}
		}
		actual.linkSync(existing, path);
	}) as typeof actual.linkSync;
	const readdirSync = ((path: import("fs").PathLike, options?: unknown) => {
		if (String(path) === "/proc" || String(path).startsWith("/proc/")) race.procListings++;
		return (actual.readdirSync as (path: import("fs").PathLike, options?: unknown) => unknown)(path, options);
	}) as typeof actual.readdirSync;
	const statSync = ((path, options) => {
		const stats = actual.statSync(path, options);
		if (race.foreignUid === undefined || String(path) !== race.lockPath || stats === undefined) return stats;
		return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: race.foreignUid });
	}) as typeof actual.statSync;
	return {
		...actual,
		default: { ...actual, renameSync, linkSync, readdirSync, statSync },
		renameSync,
		linkSync,
		readdirSync,
		statSync,
	};
});

const { acquireSpawnLock, BROKER_SPAWN_LOCK_MAX_AGE_MS, renewSpawnLock } = await import(
	"../../packages/intercom/broker/spawn.js"
);
const staleLockFile: Record<string, unknown> = await import("../../packages/intercom/broker/stale-lock-file.js");
const { statSync: realStat } = await vi.importActual<typeof import("node:fs")>("node:fs");

/** This host as the lock files record it; absent from versions that did not record it. */
const ownHost = () => (staleLockFile.hostIdentity as (() => string) | undefined)?.() ?? "unknown-host";

/**
 * The intent marker a writer creates before the first byte of a lock it cannot link into place whole: its name holds the
 * lock's file identity and the writer's pid, start and host (#5220).
 */
function writingMarker(path: string, pid: number, host = ownHost()): string {
	const marker = `${path}.writing.${realStat(path, { bigint: true }).ino}.${pid}.x.${host}`;
	writeTextSync(marker, "");
	return marker;
}

/** The warnings this process emitted while `act` ran. */
function warningsDuring(act: () => void): string[] {
	const warnings: string[] = [];
	const spy = vi.spyOn(process, "emitWarning").mockImplementation((warning) => {
		warnings.push(String(warning));
	});
	try {
		act();
	} finally {
		spy.mockRestore();
	}
	return warnings;
}

/** The wait on a holder that cannot be checked, shortened for a test where this version has one. */
function shortenUnknownHolderWait(): void {
	(staleLockFile.setUnknownHolderWaitForTesting as ((ms: number | undefined) => void) | undefined)?.(0);
}

const tempDir = makeTempDirectory("ic5220-holder-");
afterAll(() => removeTempDirectory(tempDir));
afterEach(() => {
	race.lockPath = undefined;
	race.beforeRenameOnto = undefined;
	race.beforeRenameAway = undefined;
	race.beforePutBack = undefined;
	race.linkError = undefined;
	race.procListings = 0;
	race.foreignUid = undefined;
	(staleLockFile.setUnknownHolderWaitForTesting as ((ms: number | undefined) => void) | undefined)?.(undefined);
});

let lockCount = 0;

/** Longer than the 1 s grace after which earlier versions took a lock that stayed part-written. */
const WRITER_STALL_MS = 1_500;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A spawn lock this process holds but has not renewed for longer than the backstop, as a holder paused that long
 * leaves it: any spawner judges it stale. Returns the lock's path and the header that proves the holder owns it.
 */
function agedOwnLock(): { readonly path: string; readonly owner: string } {
	const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
	const owner = `${process.pid}\n${Date.now() - BROKER_SPAWN_LOCK_MAX_AGE_MS - 1_000}\n`;
	writeTextSync(path, owner);
	race.lockPath = path;
	return { path, owner };
}

/** Whether the holder still holds the lock by its own account: its next renewal does not report it lost. */
function holderStillOwns(owner: string | undefined, path: string): boolean {
	if (owner === undefined) return false;
	return renewSpawnLock(owner, Date.now() + BROKER_SPAWN_LOCK_MAX_AGE_MS, path) !== undefined;
}

describe("a spawn-lock holder and a spawner replacing its aged lock (#5220)", () => {
	test("a holder paused between checking its lock and renewing it never writes over a lock another spawner took (#5220)", () => {
		const { path, owner } = agedOwnLock();
		let taker: string | undefined;
		race.beforeRenameOnto = () => {
			taker = acquireSpawnLock(path);
		};

		const renewed = renewSpawnLock(owner, Date.now(), path);
		const owners = [holderStillOwns(renewed, path) ? "holder" : undefined, taker === undefined ? undefined : "taker"];
		assert.equal(
			owners.filter((held) => held !== undefined).length,
			1,
			`exactly one spawner owns the lock: ${owners.join(",")}; lock ${JSON.stringify(readTextSync(path, "utf8"))}`,
		);
	});

	test("a holder renewing while a spawner moves its aged lock aside never loses it to a third spawner unawares (#5220)", () => {
		const { path, owner } = agedOwnLock();
		let renewed: string | undefined = owner;
		let third: string | undefined;
		race.beforeRenameAway = () => {
			// The taker has judged the lock stale and is about to move it aside; the holder wakes up and renews it.
			renewed = renewSpawnLock(owner, Date.now(), path);
		};
		race.beforePutBack = () => {
			// The taker found it moved the holder's fresh lock and puts it back; a third spawner gets there first.
			third = acquireSpawnLock(path);
		};

		const taker = acquireSpawnLock(path);
		const owners = [
			holderStillOwns(renewed, path) ? "holder" : undefined,
			taker === undefined ? undefined : "taker",
			third === undefined ? undefined : "third",
		];
		assert.equal(
			owners.filter((held) => held !== undefined).length,
			1,
			`exactly one spawner owns the lock: ${owners.join(",")}; lock ${JSON.stringify(readTextSync(path, "utf8"))}`,
		);
	});

	test("a holder whose aged lock another spawner replaced is told at its next renewal that it lost it (#5220)", () => {
		const { path, owner } = agedOwnLock();
		const taker = acquireSpawnLock(path);
		assert.ok(taker !== undefined, "another spawner replaces the aged lock");

		assert.equal(renewSpawnLock(owner, Date.now(), path), undefined, "the holder learns the lock is no longer its");
		assert.ok(readTextSync(path, "utf8").startsWith(taker), "the other spawner's lock is left in place");
	});
});

describe("a spawn lock on a file system without hard links (#5220)", () => {
	for (const code of ["EPERM", "ENOTSUP"]) {
		test(`a spawner takes the lock when linking fails with ${code}, and a second one waits (#5220)`, () => {
			const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
			race.lockPath = path;
			race.linkError = code;

			const owner = acquireSpawnLock(path);
			assert.ok(owner !== undefined, "the spawner takes the lock");
			assert.ok(readTextSync(path, "utf8").startsWith(owner), "the lock records its spawner");
			assert.equal(acquireSpawnLock(path), undefined, "a second spawner finds the lock held");
		});
	}

	test("a lock still being written is not replaced, however long its writer stalls and however old FAT makes it look (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		// A live spawner on FAT created the lock and has written only part of it, and stalls there for longer than any
		// grace. FAT keeps times to two seconds, so the lock can look two seconds old as it is created.
		const writer = openSync(path, "wx");
		try {
			writingMarker(path, process.pid);
			writeSync(writer, `${process.pid}\n17`);
			const coarse = new Date(Math.floor((Date.now() - 2_000) / 2_000) * 2_000);
			utimesSync(path, coarse, coarse);
			sleepSync(WRITER_STALL_MS);

			assert.equal(acquireSpawnLock(path), undefined, "another spawner waits");
			assert.equal(readTextSync(path, "utf8"), `${process.pid}\n17`, "the lock being written is left to its writer");
		} finally {
			closeSync(writer);
		}
	});

	test("a lock left part-written by a spawner killed while writing it is replaced (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		writeTextSync(path, "2147483646\n17");
		writingMarker(path, 2147483646);

		const owner = acquireSpawnLock(path);
		assert.ok(owner !== undefined, "the spawner takes the abandoned lock");
		assert.ok(readTextSync(path, "utf8").startsWith(owner));
	});

	test("judging a part-written lock never scans other processes' open files (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		writeTextSync(path, `${process.pid}\n17`);
		writingMarker(path, process.pid);

		for (let attempt = 0; attempt < 5; attempt++) assert.equal(acquireSpawnLock(path), undefined);
		assert.equal(race.procListings, 0, "no process's descriptors were listed");
	});

	test("a lock being written in another container or on another host is never taken, and is refused with advice (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		// Written part-way by a process this one cannot see: its pid here is no process at all.
		writeTextSync(path, "2147483646\n17");
		writingMarker(path, 2147483646, "0123456789ab");
		shortenUnknownHolderWait();

		const warnings = warningsDuring(() => {
			for (let attempt = 0; attempt < 3; attempt++) assert.equal(acquireSpawnLock(path), undefined, "never taken");
		});
		assert.equal(readTextSync(path, "utf8"), "2147483646\n17", "the lock is left to its writer");
		assert.ok(
			warnings.some((warning) => warning.includes(path) && warning.includes("remove")),
			`the refusal names the lock and the fix: ${warnings.join(" | ")}`,
		);
	});

	test("a part-written lock another user left is refused with advice instead of waited on forever (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		// Left part-written by a process of another user, as a broker run under sudo killed mid-write.
		writeTextSync(path, "2147483646\n17");
		race.lockPath = path;
		race.foreignUid = 0;
		shortenUnknownHolderWait();

		const warnings = warningsDuring(() => {
			for (let attempt = 0; attempt < 3; attempt++) assert.equal(acquireSpawnLock(path), undefined, "never taken");
		});
		assert.ok(
			warnings.some((warning) => warning.includes(path) && warning.includes("chown")),
			`the refusal names the lock and the fix: ${warnings.join(" | ")}`,
		);
	});
});
