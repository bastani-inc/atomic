import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type * as nodeFs from "node:fs";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { exitedProcess } from "../../../test/helpers/exited-process.js";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { SettingsManager } from "../src/core/settings-manager.js";

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

const LOCK_HOLDER_MODULE = fileURLToPath(new URL("../src/core/lock-holder.ts", import.meta.url));
const MAX_SAFE_INO = BigInt(Number.MAX_SAFE_INTEGER);

/** Plain `statSync` legacy lock token exactly as pre-BigInt releases computed it. */
function legacyLockToken(path: string): string {
	const stats = statSync(path);
	return `${stats.ino}:${stats.birthtimeMs}`;
}

let directory: string;
let settingsPath: string;
let lockPath: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-bigint-lock-")));
	settingsPath = join(directory, "settings.json");
	writeFileSync(settingsPath, "{}");
	lockPath = `${settingsPath}.lock`;
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

	test("mixed-version compatibility: legacy Number(ino) holder records fail closed when ino > MAX_SAFE_INTEGER, even at birthtime 0", async () => {
		mkdirSync(lockPath);
		// Legacy format had 2 colon-separated fields: `${Number(ino)}:${birthtimeMs}`.
		// When the live directory's inode exceeds Number.MAX_SAFE_INTEGER, even when birthtime is 0
		// and its exact ino equals the rounded Number(ino), a legacy record without lockId fails closed.
		const legacyRecord = {
			host: hostname(),
			...exitedProcess(),
			lock: `${Number(EXACT_MULTIPLE_INO)}:0`,
		};
		writeFileSync(lockHolderPath(lockPath), JSON.stringify(legacyRecord));

		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: EXACT_MULTIPLE_INO,
			birthtimeNs: 0n,
		});

		assert.equal(
			takeOverDeadHolder(lockPath),
			false,
			"must fail closed on legacy record when ino > MAX_SAFE_INTEGER",
		);
		assert.equal(await takeOverDeadHolderAsync(lockPath), false);
		assert.equal(existsSync(lockPath), true);

		// When ino > MAX_SAFE_INTEGER, a newly written .holder record also avoids writing a lossy
		// Number(ino) into `lock`, so an older process cannot match a colliding live successor either.
		recordLockHolder(lockPath);
		const syncRecorded = JSON.parse(readFileSync(lockHolderPath(lockPath), "utf8")) as {
			lock: string;
			lockId?: string;
		};
		assert.equal(syncRecorded.lockId, `${COLLIDING_DEV}:${EXACT_MULTIPLE_INO}:0`);
		assert.notEqual(syncRecorded.lock, `${Number(EXACT_MULTIPLE_INO)}:0`);

		await recordLockHolderAsync(lockPath);
		const asyncRecorded = JSON.parse(readFileSync(lockHolderPath(lockPath), "utf8")) as {
			lock: string;
			lockId?: string;
		};
		assert.deepEqual(asyncRecorded, syncRecorded);
	});

	test("mixed-version dead-holder takeover (OLD -> NEW and NEW -> OLD) succeeds immediately on safe inodes with real processes", async () => {
		// Deterministic safe inode (<= Number.MAX_SAFE_INTEGER) so both directions run on every
		// filesystem, including Windows NTFS volumes whose sequence numbers are >= 32.
		const safeIno = 50n;
		const setSafeStat = () =>
			fakeStats.overrides.set(resolve(lockPath), {
				dev: COLLIDING_DEV,
				ino: safeIno,
				birthtimeNs: SAME_BIRTHTIME_NS,
			});

		// 1. OLD(dead) -> NEW (sync, async, and real SettingsManager save).
		mkdirSync(lockPath);
		setSafeStat();
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({ host: hostname(), ...exitedProcess(), lock: legacyLockToken(lockPath) }),
		);
		assert.equal(takeOverDeadHolder(lockPath), true, "NEW sync takeover must reclaim dead OLD lock on safe inode");
		assert.equal(existsSync(lockPath), false);

		mkdirSync(lockPath);
		setSafeStat();
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({ host: hostname(), ...exitedProcess(), lock: legacyLockToken(lockPath) }),
		);
		assert.equal(
			await takeOverDeadHolderAsync(lockPath),
			true,
			"NEW async takeover must reclaim dead OLD lock on safe inode",
		);
		assert.equal(existsSync(lockPath), false);

		mkdirSync(lockPath);
		setSafeStat();
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({ host: hostname(), ...exitedProcess(), lock: legacyLockToken(lockPath) }),
		);
		const manager = SettingsManager.create(directory, directory);
		manager.setTheme("dark");
		await manager.flush();
		assert.deepEqual(manager.drainErrors(), [], "SettingsManager save must reclaim dead OLD lock immediately");
		assert.equal(existsSync(lockPath), false);

		// 2. NEW(dead) -> OLD: recordLockHolder and recordLockHolderAsync write byte-identical legacy `lock`
		// on safe inodes alongside exact `lockId`, so older processes take over immediately too.
		mkdirSync(lockPath);
		setSafeStat();
		recordLockHolder(lockPath);
		const syncRecord = JSON.parse(readFileSync(lockHolderPath(lockPath), "utf8")) as {
			lock: string;
			lockId?: string;
		};
		assert.equal(syncRecord.lock, legacyLockToken(lockPath));
		assert.equal(syncRecord.lockId, lockHolder(lockPath));
		await recordLockHolderAsync(lockPath);
		const asyncRecord = JSON.parse(readFileSync(lockHolderPath(lockPath), "utf8")) as {
			lock: string;
			lockId?: string;
		};
		assert.deepEqual(asyncRecord, syncRecord);
		rmSync(lockPath, { recursive: true, force: true });

		// 3. Real OS filesystem + real exited child process (no fake stat overrides).
		fakeStats.overrides.clear();
		mkdirSync(lockPath);
		const realIno = statSync(lockPath, { bigint: true }).ino;
		const child = spawnSync(
			bunExecutable(),
			[
				"--eval",
				`import { recordLockHolder } from ${JSON.stringify(LOCK_HOLDER_MODULE)}; recordLockHolder(${JSON.stringify(lockPath)});`,
			],
			{ encoding: "utf8" },
		);
		assert.equal(child.status, 0, child.stderr);
		const written = JSON.parse(readFileSync(lockHolderPath(lockPath), "utf8")) as {
			host: string;
			pid: number;
			started?: string;
			lock: string;
			lockId?: string;
		};
		assert.equal(written.lockId, lockHolder(lockPath), "real child record must carry exact 64-bit `lockId`");
		if (realIno <= MAX_SAFE_INO) {
			assert.equal(
				written.lock,
				legacyLockToken(lockPath),
				"real child record must carry legacy 2-field `lock` on safe inodes so OLD processes take it over",
			);
		} else {
			assert.equal(
				written.lock,
				written.lockId,
				"real child record above MAX_SAFE_INTEGER must write exact `lockId` into `lock` so older processes cannot collide",
			);
		}
		assert.equal(takeOverDeadHolder(lockPath), true, "NEW immediately reclaims dead real child's dual-field lock");
		assert.equal(existsSync(lockPath), false);

		// Measure the second lock directory's own inode after creating it: deleting the first
		// directory can advance an NTFS MFT slot from sequence 31 (<= MAX_SAFE_INTEGER) to 32 (> MAX_SAFE_INTEGER).
		mkdirSync(lockPath);
		const secondRealIno = statSync(lockPath, { bigint: true }).ino;
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({ host: hostname(), ...exitedProcess(), lock: legacyLockToken(lockPath) }),
		);
		const realManager = SettingsManager.create(directory, directory);
		realManager.setTheme("light");
		await realManager.flush();
		if (secondRealIno <= MAX_SAFE_INO) {
			assert.deepEqual(realManager.drainErrors(), [], "real SettingsManager save reclaims dead OLD lock");
			assert.equal(existsSync(lockPath), false);
		} else {
			const errors = realManager.drainErrors();
			assert.equal(errors.length, 1, "legacy 2-field lock above MAX_SAFE_INTEGER fails closed");
			assert.equal((errors[0]?.error as NodeJS.ErrnoException | undefined)?.code, "ELOCKED");
			assert.equal(existsSync(lockPath), true);
		}
	});

	test("reusing a deleted NTFS MFT slot across sequence 31 -> 32 fails closed on legacy records and reclaims dual-field records", async () => {
		const seq31Ino = 0x001f_0000_0005_33een;
		const seq32Ino = 0x0020_0000_0005_33een;
		assert.ok(seq31Ino <= MAX_SAFE_INO, "sequence 31 is within Number.MAX_SAFE_INTEGER");
		assert.ok(seq32Ino > MAX_SAFE_INO, "sequence 32 exceeds Number.MAX_SAFE_INTEGER");

		// First lock directory lands on sequence 31 (safe) and is reclaimed.
		mkdirSync(lockPath);
		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: seq31Ino,
			birthtimeNs: SAME_BIRTHTIME_NS,
		});
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({ host: hostname(), ...exitedProcess(), lock: legacyLockToken(lockPath) }),
		);
		assert.equal(takeOverDeadHolder(lockPath), true);
		assert.equal(existsSync(lockPath), false);

		// Second lock directory reuses the MFT slot at sequence 32 (unsafe): a legacy 2-field
		// record without lockId fails closed conservatively, while a dual-field record is reclaimed.
		mkdirSync(lockPath);
		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: seq32Ino,
			birthtimeNs: SAME_BIRTHTIME_NS,
		});
		const dead = exitedProcess();
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({ host: hostname(), ...dead, lock: legacyLockToken(lockPath) }),
		);
		const legacyManager = SettingsManager.create(directory, directory);
		legacyManager.setTheme("light");
		await legacyManager.flush();
		const legacyErrors = legacyManager.drainErrors();
		assert.equal(legacyErrors.length, 1);
		assert.equal((legacyErrors[0]?.error as NodeJS.ErrnoException | undefined)?.code, "ELOCKED");
		assert.equal(existsSync(lockPath), true);

		const exactId = lockHolder(lockPath)!;
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({ host: hostname(), ...dead, lock: exactId, lockId: exactId }),
		);
		const dualManager = SettingsManager.create(directory, directory);
		dualManager.setTheme("dark");
		await dualManager.flush();
		assert.deepEqual(dualManager.drainErrors(), []);
		assert.equal(existsSync(lockPath), false);
	});

	test("dual-field record with mismatched lock vs lockId or non-string lockId fails closed conservatively", async () => {
		mkdirSync(lockPath);
		const safeIno = 50n;
		fakeStats.overrides.set(resolve(lockPath), {
			dev: COLLIDING_DEV,
			ino: safeIno,
			birthtimeNs: SAME_BIRTHTIME_NS,
		});
		const legacy = legacyLockToken(lockPath);
		const exact = lockHolder(lockPath)!;

		// `lock` matches legacy, but `lockId` names a different directory -> conservative false.
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({
				host: hostname(),
				...exitedProcess(),
				lock: legacy,
				lockId: `${COLLIDING_DEV}:99:${SAME_BIRTHTIME_NS}`,
			}),
		);
		assert.equal(takeOverDeadHolder(lockPath), false);
		assert.equal(await takeOverDeadHolderAsync(lockPath), false);

		// `lockId` matches exact, but `lock` names a different directory -> conservative false.
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({
				host: hostname(),
				...exitedProcess(),
				lock: "99:0",
				lockId: exact,
			}),
		);
		assert.equal(takeOverDeadHolder(lockPath), false);
		assert.equal(await takeOverDeadHolderAsync(lockPath), false);

		// Non-string `lockId` -> conservative false.
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({
				host: hostname(),
				...exitedProcess(),
				lock: legacy,
				lockId: 12345,
			}),
		);
		assert.equal(takeOverDeadHolder(lockPath), false);
		assert.equal(await takeOverDeadHolderAsync(lockPath), false);
		assert.equal(existsSync(lockPath), true);
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
