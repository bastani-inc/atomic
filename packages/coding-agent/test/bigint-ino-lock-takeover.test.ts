import assert from "node:assert/strict";
import type * as nodeFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { exitedProcess } from "../../../test/helpers/exited-process.js";

/** Real 64-bit NTFS file reference numbers whose IEEE-754 Numbers collide (both 70087269201190380). */
const COLLIDING_INO_A = 0x00f9_0000_0003_9deen;
const COLLIDING_INO_B = 0x00f9_0000_0003_9defn;
/** A 64-bit NTFS file reference number that equals its own rounded Number (70087269201190384). */
const EXACT_MULTIPLE_INO = 0x00f9_0000_0003_9df0n;
const COLLIDING_DEV = 0x0000_0000_0000_002an;
const SAME_BIRTHTIME_NS = 1_795_343_551_522_500_700n;
const SUB_MS_NEXT_BIRTHTIME_NS = 1_795_343_551_522_500_800n;

interface FakeStatOverride {
	dev: bigint;
	ino: bigint;
	birthtimeNs: bigint;
	mtimeNs?: bigint;
}

const fakeStats = vi.hoisted(() => ({
	overrides: new Map<string, FakeStatOverride>(),
	beforeRename: undefined as (() => void) | undefined,
}));

function applyStatOverride(
	base: nodeFs.Stats | nodeFs.BigIntStats,
	override: FakeStatOverride,
	bigint: boolean,
): nodeFs.Stats | nodeFs.BigIntStats {
	const birthtimeMs =
		Number(override.birthtimeNs / 1_000_000_000n) * 1000 + Number(override.birthtimeNs % 1_000_000_000n) / 1_000_000;
	const mtimeNs = override.mtimeNs;
	const mtimeMs =
		mtimeNs === undefined
			? Number(base.mtimeMs)
			: Number(mtimeNs / 1_000_000_000n) * 1000 + Number(mtimeNs % 1_000_000_000n) / 1_000_000;
	if (bigint) {
		return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
			dev: override.dev,
			ino: override.ino,
			birthtimeNs: override.birthtimeNs,
			birthtimeMs: override.birthtimeNs / 1_000_000n,
			...(mtimeNs === undefined ? {} : { mtimeNs, mtimeMs: mtimeNs / 1_000_000n }),
		});
	}
	return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
		dev: Number(override.dev),
		ino: Number(override.ino),
		birthtimeMs,
		...(mtimeNs === undefined ? {} : { mtimeMs }),
	});
}

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const statSync = ((path: nodeFs.PathLike, options?: nodeFs.StatSyncOptions) => {
		const result = actual.statSync(path, options as never);
		if (result === undefined) return undefined;
		const override = fakeStats.overrides.get(resolve(String(path)));
		if (override === undefined) return result;
		return applyStatOverride(result, override, options?.bigint === true);
	}) as typeof actual.statSync;
	const renameSync: typeof actual.renameSync = (from, to) => {
		const hook = fakeStats.beforeRename;
		fakeStats.beforeRename = undefined;
		hook?.();
		const fromKey = resolve(String(from));
		const toKey = resolve(String(to));
		actual.renameSync(from, to);
		const moved = fakeStats.overrides.get(fromKey);
		if (moved !== undefined) {
			fakeStats.overrides.delete(fromKey);
			fakeStats.overrides.set(toKey, moved);
		}
	};
	return {
		...actual,
		default: { ...actual, statSync, renameSync },
		statSync,
		renameSync,
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const stat = (async (path: nodeFs.PathLike, options?: { bigint?: boolean }) => {
		const result = await actual.stat(path, options as never);
		const override = fakeStats.overrides.get(resolve(String(path)));
		if (override === undefined) return result;
		return applyStatOverride(result, override, options?.bigint === true);
	}) as typeof actual.stat;
	const rename: typeof actual.rename = async (from, to) => {
		const hook = fakeStats.beforeRename;
		fakeStats.beforeRename = undefined;
		hook?.();
		const fromKey = resolve(String(from));
		const toKey = resolve(String(to));
		await actual.rename(from, to);
		const moved = fakeStats.overrides.get(fromKey);
		if (moved !== undefined) {
			fakeStats.overrides.delete(fromKey);
			fakeStats.overrides.set(toKey, moved);
		}
	};
	return {
		...actual,
		default: { ...actual, stat, rename },
		stat,
		rename,
	};
});

const {
	lockHolder,
	lockHolderAsync,
	lockHolderPath,
	setNativeLocksForTesting,
	TAKEOVER_MUTEX_STALE_MS,
	takeoverMutexPath,
	takeTakeoverMutex,
} = await import("../src/core/lock-takeover.js");
const { recordLockHolder, recordLockHolderAsync, takeOverDeadHolder, takeOverDeadHolderAsync } = await import(
	"../src/core/lock-holder.js"
);

let directory: string;
let lockPath: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-bigint-lock-")));
	lockPath = join(directory, "settings.json.lock");
	fakeStats.overrides.clear();
	fakeStats.beforeRename = undefined;
	setNativeLocksForTesting(null);
});

afterEach(() => {
	fakeStats.overrides.clear();
	fakeStats.beforeRename = undefined;
	setNativeLocksForTesting(undefined);
	rmSync(directory, { recursive: true, force: true });
});

describe("64-bit BigInt file identity in lock-takeover and lock-holder", () => {
	test("lockHolder and lockHolderAsync distinguish colliding 64-bit inodes and sub-ms birthtimes", async () => {
		assert.equal(Number(COLLIDING_INO_A), Number(COLLIDING_INO_B), "test precondition: Numbers collide");
		mkdirSync(lockPath);

		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: COLLIDING_INO_A,
			birthtimeNs: SAME_BIRTHTIME_NS,
		});
		const syncA = lockHolder(lockPath);
		const asyncA = await lockHolderAsync(lockPath);
		assert.equal(syncA, asyncA);
		assert.equal(syncA, `${COLLIDING_DEV}:${COLLIDING_INO_A}:${SAME_BIRTHTIME_NS}`);

		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: COLLIDING_INO_B,
			birthtimeNs: SAME_BIRTHTIME_NS,
		});
		const syncB = lockHolder(lockPath);
		const asyncB = await lockHolderAsync(lockPath);
		assert.equal(syncB, asyncB);
		assert.notEqual(syncA, syncB, "distinct 64-bit inodes must not collide");

		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: COLLIDING_INO_A,
			birthtimeNs: SUB_MS_NEXT_BIRTHTIME_NS,
		});
		assert.notEqual(lockHolder(lockPath), syncA, "sub-millisecond birthtimeNs differences must not collide");
		assert.notEqual(await lockHolderAsync(lockPath), asyncA);
	});

	test("takeOverDeadHolder (sync and async) never steals a live lock whose 64-bit inode collides with the dead holder's", async () => {
		mkdirSync(lockPath);
		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: COLLIDING_INO_A,
			birthtimeNs: SAME_BIRTHTIME_NS,
		});
		const deadIdentity = lockHolder(lockPath);
		assert.ok(deadIdentity !== undefined);
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({ host: hostname(), ...exitedProcess(), lock: deadIdentity }),
		);

		// A live successor replaced lockPath with a new directory whose 64-bit ino collides as Number
		// and shares the same creation time, before overwriting .holder.
		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: COLLIDING_INO_B,
			birthtimeNs: SAME_BIRTHTIME_NS,
		});

		assert.equal(takeOverDeadHolder(lockPath), false, "sync takeover must not steal colliding live lock");
		assert.equal(existsSync(lockPath), true);
		assert.equal(await takeOverDeadHolderAsync(lockPath), false, "async takeover must not steal colliding live lock");
		assert.equal(existsSync(lockPath), true);

		// A valid dead-holder record with the exact same 64-bit identity IS still taken over.
		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: COLLIDING_INO_A,
			birthtimeNs: SAME_BIRTHTIME_NS,
		});
		assert.equal(takeOverDeadHolder(lockPath), true, "dead holder with exact matching 64-bit identity is taken over");
		assert.equal(existsSync(lockPath), false);

		// Same check for the asynchronous path.
		mkdirSync(lockPath);
		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: COLLIDING_INO_A,
			birthtimeNs: SAME_BIRTHTIME_NS,
		});
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({ host: hostname(), ...exitedProcess(), lock: deadIdentity }),
		);
		assert.equal(await takeOverDeadHolderAsync(lockPath), true);
		assert.equal(existsSync(lockPath), false);
	});

	test("malformed holder record without a string lock field is ignored even when lockPath cannot be stat'ed", async () => {
		writeFileSync(lockHolderPath(lockPath), JSON.stringify({ host: hostname(), ...exitedProcess() }));
		assert.equal(takeOverDeadHolder(lockPath), false);
		assert.equal(await takeOverDeadHolderAsync(lockPath), false);
	});

	test("mixed-version compatibility: legacy Number(ino) holder records are read safely and never stolen, even at birthtime 0", async () => {
		mkdirSync(lockPath);
		// Legacy format had 2 colon-separated fields: `${Number(ino)}:${birthtimeMs}`.
		// Even when birthtime is 0 and the live successor's exact ino equals the rounded Number(ino)
		// of the dead older process's lock, a 3-field identity is disjoint and never matches.
		const deadLegacyBirthtimeMs = 0;
		const legacyRecord = {
			host: hostname(),
			...exitedProcess(),
			lock: `${Number(EXACT_MULTIPLE_INO)}:${deadLegacyBirthtimeMs}`,
		};
		writeFileSync(lockHolderPath(lockPath), JSON.stringify(legacyRecord));

		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: EXACT_MULTIPLE_INO,
			birthtimeNs: 0n,
		});

		assert.equal(takeOverDeadHolder(lockPath), false, "must treat legacy 2-field format as unknown and conservative");
		assert.equal(await takeOverDeadHolderAsync(lockPath), false);
		assert.equal(existsSync(lockPath), true);

		// Conversely, a newly written .holder record never matches an older process's 2-field identity.
		recordLockHolder(lockPath);
		const syncRecorded = JSON.parse((await import("node:fs")).readFileSync(lockHolderPath(lockPath), "utf8")) as {
			lock: string;
		};
		assert.notEqual(syncRecorded.lock, `${Number(EXACT_MULTIPLE_INO)}:0`);

		await recordLockHolderAsync(lockPath);
		const asyncRecorded = JSON.parse((await import("node:fs")).readFileSync(lockHolderPath(lockPath), "utf8")) as {
			lock: string;
		};
		assert.equal(asyncRecorded.lock, syncRecorded.lock);
	});

	test("removeStaleMutex does not delete a live replacement directory mutex with a colliding 64-bit inode", () => {
		const mutexPath = takeoverMutexPath(lockPath);
		mkdirSync(mutexPath);
		const staleDate = new Date(Date.now() - TAKEOVER_MUTEX_STALE_MS - 5_000);
		utimesSync(mutexPath, staleDate, staleDate);
		const staleMtimeNs = BigInt(staleDate.getTime()) * 1_000_000n;

		fakeStats.overrides.set(resolve(mutexPath), {
			dev: COLLIDING_DEV,
			ino: COLLIDING_INO_A,
			birthtimeNs: SAME_BIRTHTIME_NS,
			mtimeNs: staleMtimeNs,
		});

		// Between judging the ownerless mutex stale and renaming it aside, another live process
		// replaces the mutex directory with a new one whose 64-bit inode collides as Number.
		fakeStats.beforeRename = () => {
			fakeStats.overrides.set(resolve(mutexPath), {
				dev: COLLIDING_DEV,
				ino: COLLIDING_INO_B,
				birthtimeNs: SAME_BIRTHTIME_NS,
				mtimeNs: staleMtimeNs,
			});
		};

		const acquired = takeTakeoverMutex(lockPath);
		assert.equal(acquired, undefined, "must not remove a live replacement mutex with a colliding 64-bit inode");
	});
});
