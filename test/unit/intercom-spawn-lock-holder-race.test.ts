/**
 * A spawn-lock holder that writes its lock again (renews it) or removes it races a spawner replacing the lock as stale
 * once it has aged out (#5220). Each test pauses one process between its check and its write, as the operating system
 * can, and lets the others act meanwhile; afterwards at most one spawner may hold the lock, and a holder that lost it
 * must find that out at its next renewal. Spawners are in-process calls; the takeover mutex conflicts between them as it
 * does between processes.
 */

import assert from "node:assert/strict";
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
	return { ...actual, default: { ...actual, renameSync, linkSync }, renameSync, linkSync };
});

const { acquireSpawnLock, BROKER_SPAWN_LOCK_MAX_AGE_MS, renewSpawnLock } = await import(
	"../../packages/intercom/broker/spawn.js"
);

const tempDir = makeTempDirectory("ic5220-holder-");
afterAll(() => removeTempDirectory(tempDir));
afterEach(() => {
	race.lockPath = undefined;
	race.beforeRenameOnto = undefined;
	race.beforeRenameAway = undefined;
	race.beforePutBack = undefined;
	race.linkError = undefined;
});

let lockCount = 0;

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

	test("a lock still being written, its last line unterminated, is not replaced as stale (#5220)", () => {
		const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
		// A live spawner created the lock and has written only part of when it took it.
		const partial = `${process.pid}\n17`;
		writeTextSync(path, partial);

		assert.equal(acquireSpawnLock(path), undefined, "another spawner waits");
		assert.equal(readTextSync(path, "utf8"), partial, "the lock being written is left alone");
	});
});
