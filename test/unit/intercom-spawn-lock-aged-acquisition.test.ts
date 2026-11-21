import assert from "node:assert/strict";
import fsModule from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import {
	acquireSpawnLock,
	isSpawnLockStale,
	releaseSpawnLock,
	renewSpawnLock,
	replaceStaleSpawnLock,
} from "../../packages/intercom/broker/spawn.js";
import {
	fileExistsSync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	writeTextSync,
} from "../helpers/runtime.js";

const tempDir = makeTempDirectory("ic5220-aged-");
afterAll(() => removeTempDirectory(tempDir));

const AGED_HEADER_OFFSET_MS = 61_000;
const LIVE_OTHER_PID = process.platform === "win32" ? 4 : 1;

let lockCounter = 0;

function nextLockPath(): string {
	return join(tempDir, `broker.spawn.lock-${lockCounter++}`);
}

const ACQUISITION_FRESHNESS_MS = 10_000;

function assertFreshOwner(lockPath: string, owner: string | undefined): asserts owner is string {
	assert.ok(owner !== undefined);
	assert.ok(Date.now() - Number(owner.split("\n")[1]) < ACQUISITION_FRESHNESS_MS);
	assert.equal(readTextSync(lockPath, "utf8"), owner);
}

function withFirstNowAged<T>(run: () => T, ageMs = AGED_HEADER_OFFSET_MS): T {
	const realNow = Date.now;
	let firstCall = true;
	Date.now = () => {
		const now = realNow.call(Date);
		if (firstCall) {
			firstCall = false;
			return now - ageMs;
		}
		return now;
	};
	try {
		return run();
	} finally {
		Date.now = realNow;
	}
}

describe("aged spawn lock acquisition (#5220)", () => {
	test("a failed first read-back does not strand a spawner's newly created lock (#5220)", () => {
		const lockPath = nextLockPath();
		const realReadFileSync = fsModule.readFileSync;
		let failedReadBack = false;
		fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
			if (args[0] === lockPath && !failedReadBack) {
				failedReadBack = true;
				throw Object.assign(new Error("lock is being scanned"), { code: "EBUSY" });
			}
			return realReadFileSync(...args);
		}) as typeof fsModule.readFileSync;
		syncBuiltinESMExports();
		try {
			const owner = acquireSpawnLock(lockPath);
			assert.equal(failedReadBack, true);
			assertFreshOwner(lockPath, owner);
			releaseSpawnLock(owner, lockPath);
			assert.equal(fileExistsSync(lockPath), false);
		} finally {
			fsModule.readFileSync = realReadFileSync;
			syncBuiltinESMExports();
		}
	});

	for (const [code, windowMs] of [
		["EBUSY", 5],
		["EBUSY", 50],
		["EPERM", 50],
		["EACCES", 50],
	] as const) {
		test(`a ${windowMs} ms ${code} read-back window does not strand a new spawn lock (#5220)`, () => {
			const lockPath = nextLockPath();
			const realReadFileSync = fsModule.readFileSync;
			let blockedUntil: number | undefined;
			let failedReads = 0;
			fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
				if (args[0] === lockPath) {
					blockedUntil ??= performance.now() + windowMs;
					if (performance.now() < blockedUntil) {
						failedReads++;
						throw Object.assign(new Error("lock is being scanned"), { code });
					}
				}
				return realReadFileSync(...args);
			}) as typeof fsModule.readFileSync;
			syncBuiltinESMExports();
			try {
				const owner = acquireSpawnLock(lockPath);
				assert.ok(failedReads > 0);
				assertFreshOwner(lockPath, owner);
				releaseSpawnLock(owner, lockPath);
				assert.equal(fileExistsSync(lockPath), false);
				const laterOwner = acquireSpawnLock(lockPath);
				assertFreshOwner(lockPath, laterOwner);
				releaseSpawnLock(laterOwner, lockPath);
			} finally {
				fsModule.readFileSync = realReadFileSync;
				syncBuiltinESMExports();
			}
		});
	}

	test("a failed ownership read after deferred renewal still releases the old acquisition before retrying (#5220)", () => {
		const lockPath = nextLockPath();
		const realRenameSync = fsModule.renameSync;
		const realReadFileSync = fsModule.readFileSync;
		let renewalDeferred = false;
		let failedReleaseRead = false;
		fsModule.renameSync = ((from: fsModule.PathLike, to: fsModule.PathLike) => {
			if (String(from).endsWith(".renew") && to === lockPath) {
				renewalDeferred = true;
				throw Object.assign(new Error("lock rename failed"), { code: "EIO" });
			}
			realRenameSync(from, to);
		}) as typeof fsModule.renameSync;
		fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
			if (args[0] === lockPath && renewalDeferred && !failedReleaseRead) {
				failedReleaseRead = true;
				throw Object.assign(new Error("lock is being scanned"), { code: "EBUSY" });
			}
			return realReadFileSync(...args);
		}) as typeof fsModule.readFileSync;
		syncBuiltinESMExports();
		try {
			const owner = withFirstNowAged(() => acquireSpawnLock(lockPath), 30_000);
			assert.equal(renewalDeferred, true);
			assert.equal(failedReleaseRead, true);
			assertFreshOwner(lockPath, owner);
			releaseSpawnLock(owner, lockPath);
			assert.equal(fileExistsSync(lockPath), false);
		} finally {
			fsModule.readFileSync = realReadFileSync;
			fsModule.renameSync = realRenameSync;
			syncBuiltinESMExports();
		}
	});

	test("an ownership read that keeps failing is not retried longer when the clock steps back (#5220)", () => {
		const lockPath = nextLockPath();
		const owner = `${process.pid}\n${Date.now()}\n`;
		writeTextSync(lockPath, owner);
		const realReadFileSync = fsModule.readFileSync;
		const realNow = Date.now.bind(Date);
		let nowCalls = 0;
		let reads = 0;
		fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
			if (String(args[0]) === lockPath) {
				reads++;
				throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${lockPath}'`), { code: "EBUSY" });
			}
			return realReadFileSync(...args);
		}) as typeof fsModule.readFileSync;
		syncBuiltinESMExports();
		Date.now = () => realNow() - (++nowCalls > 1 ? 3_000 : 0);
		try {
			releaseSpawnLock(owner, lockPath);
		} finally {
			Date.now = realNow;
			fsModule.readFileSync = realReadFileSync;
			syncBuiltinESMExports();
		}
		assert.ok(reads <= 26, `${reads} reads`);
		assert.equal(fileExistsSync(lockPath), true);
	});

	test("one acquisition does not keep creating lock files that cannot be read (#5220)", () => {
		const lockPath = nextLockPath();
		const realReadFileSync = fsModule.readFileSync;
		const realStatSync = fsModule.statSync;
		const firstReadAt = new Map<string, number>();
		let failedReads = 0;
		let armed = true;
		fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
			if (armed && String(args[0]) === lockPath) {
				let identity: string | undefined;
				try {
					const stats = realStatSync(lockPath, { bigint: true });
					identity = `${stats.ino}-${stats.birthtimeNs}`;
				} catch {}
				if (identity !== undefined) {
					const first = firstReadAt.get(identity) ?? performance.now();
					firstReadAt.set(identity, first);
					if (performance.now() - first < 2_500) {
						failedReads++;
						throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${lockPath}'`), {
							code: "EBUSY",
						});
					}
				}
			}
			return realReadFileSync(...args);
		}) as typeof fsModule.readFileSync;
		syncBuiltinESMExports();
		let owner: string | undefined;
		try {
			owner = acquireSpawnLock(lockPath);
		} finally {
			armed = false;
			fsModule.readFileSync = realReadFileSync;
			syncBuiltinESMExports();
		}
		const onDisk = fileExistsSync(lockPath) ? readTextSync(lockPath, "utf8") : undefined;
		if (owner !== undefined) {
			assert.equal(onDisk, owner);
			releaseSpawnLock(owner, lockPath);
		} else {
			assert.ok(
				onDisk === undefined || Number.parseInt(onDisk, 10) !== process.pid,
				`left ${JSON.stringify(onDisk)}`,
			);
		}
		assert.ok(firstReadAt.size <= 2, `${firstReadAt.size} lock files created`);
		assert.ok(failedReads <= 52, `${failedReads} failed reads`);
	}, 60_000);

	test("a mismatched first read-back does not strand a spawner's newly created lock (#5220)", () => {
		const lockPath = nextLockPath();
		const realReadFileSync = fsModule.readFileSync;
		let changedReadBack = false;
		fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
			const result = realReadFileSync(...args);
			if (args[0] === lockPath && !changedReadBack) {
				changedReadBack = true;
				return "another owner's header\n";
			}
			return result;
		}) as typeof fsModule.readFileSync;
		syncBuiltinESMExports();
		try {
			const owner = acquireSpawnLock(lockPath);
			assert.equal(changedReadBack, true);
			assertFreshOwner(lockPath, owner);
			releaseSpawnLock(owner, lockPath);
			assert.equal(fileExistsSync(lockPath), false);
		} finally {
			fsModule.readFileSync = realReadFileSync;
			syncBuiltinESMExports();
		}
	});

	test("a deferred renewal of a not-yet-stale acquisition releases its old lease before retrying (#5220)", () => {
		const lockPath = nextLockPath();
		const realRenameSync = fsModule.renameSync;
		fsModule.renameSync = ((from: fsModule.PathLike, to: fsModule.PathLike) => {
			if (String(from).endsWith(".renew") && to === lockPath) {
				throw Object.assign(new Error("lock is being scanned"), { code: "EBUSY" });
			}
			realRenameSync(from, to);
		}) as typeof fsModule.renameSync;
		syncBuiltinESMExports();
		try {
			const owner = withFirstNowAged(() => acquireSpawnLock(lockPath), 30_000);
			assertFreshOwner(lockPath, owner);
			releaseSpawnLock(owner, lockPath);
			assert.equal(fileExistsSync(lockPath), false);
		} finally {
			fsModule.renameSync = realRenameSync;
			syncBuiltinESMExports();
		}
	});

	test("a failed renewal removes its staged file and preserves the held lock (#5220)", () => {
		const lockPath = nextLockPath();
		const owner = `${process.pid}\n${Date.now() - 30_000}\n`;
		writeTextSync(lockPath, owner);
		const staged = `${lockPath}.${process.pid}.renew`;
		const realRenameSync = fsModule.renameSync;
		fsModule.renameSync = ((from: fsModule.PathLike, to: fsModule.PathLike) => {
			if (from === staged && to === lockPath) {
				throw Object.assign(new Error("lock is being scanned"), { code: "EBUSY" });
			}
			realRenameSync(from, to);
		}) as typeof fsModule.renameSync;
		syncBuiltinESMExports();
		try {
			assert.equal(renewSpawnLock(owner, Date.now(), lockPath), owner);
			assert.equal(readTextSync(lockPath, "utf8"), owner);
			assert.equal(fileExistsSync(staged), false);
			releaseSpawnLock(owner, lockPath);
			assert.equal(fileExistsSync(lockPath), false);
		} finally {
			fsModule.renameSync = realRenameSync;
			syncBuiltinESMExports();
		}
	});

	test("a spawner whose initial timestamp aged before read-back renews the lock so a second spawner cannot also take it (#5220)", () => {
		const lockPath = nextLockPath();
		const firstOwner = withFirstNowAged(() => acquireSpawnLock(lockPath));
		assert.ok(firstOwner !== undefined);
		assert.equal(isSpawnLockStale(lockPath), false);

		const secondOwner = acquireSpawnLock(lockPath);
		assert.equal(secondOwner, undefined);
		assert.ok(readTextSync(lockPath, "utf8").startsWith(firstOwner));

		releaseSpawnLock(firstOwner, lockPath);
		assert.equal(fileExistsSync(lockPath), false);
	});

	test("a spawner whose aged lock is replaced before renewal under the takeover mutex does not return as a second owner (#5220)", () => {
		const lockPath = nextLockPath();
		const realReadFileSync = fsModule.readFileSync;
		let replacedAfterReadback = false;
		const competingOwner = `${LIVE_OTHER_PID}\n${Date.now()}\n`;

		fsModule.readFileSync = ((...args: Parameters<typeof fsModule.readFileSync>) => {
			const result = realReadFileSync(...args);
			if (!replacedAfterReadback && args[0] === lockPath && typeof result === "string") {
				replacedAfterReadback = true;
				replaceStaleSpawnLock(result, lockPath);
				writeTextSync(lockPath, competingOwner);
			}
			return result;
		}) as typeof fsModule.readFileSync;
		syncBuiltinESMExports();

		try {
			const acquired = withFirstNowAged(() => acquireSpawnLock(lockPath));
			assert.equal(acquired, undefined);
			assert.equal(readTextSync(lockPath, "utf8"), competingOwner);
		} finally {
			fsModule.readFileSync = realReadFileSync;
			syncBuiltinESMExports();
		}
	});

	test("a spawner whose aged lock cannot be refreshed on disk does not claim the unrefreshed lease (#5220)", () => {
		const lockPath = nextLockPath();
		const realRenameSync = fsModule.renameSync;
		fsModule.renameSync = ((from: fsModule.PathLike, to: fsModule.PathLike) => {
			if (String(from).endsWith(".renew") && to === lockPath) {
				const error = new Error("EBUSY") as NodeJS.ErrnoException;
				error.code = "EBUSY";
				throw error;
			}
			realRenameSync(from, to);
		}) as typeof fsModule.renameSync;
		syncBuiltinESMExports();

		try {
			let attempts = 0;
			const realNow = Date.now;
			Date.now = () => {
				attempts++;
				return attempts === 1 ? realNow.call(Date) - AGED_HEADER_OFFSET_MS : realNow.call(Date);
			};
			try {
				const owner = acquireSpawnLock(lockPath);
				assertFreshOwner(lockPath, owner);
				assert.equal(isSpawnLockStale(lockPath), false);
				assert.equal(acquireSpawnLock(lockPath), undefined);
				releaseSpawnLock(owner, lockPath);
			} finally {
				Date.now = realNow;
			}
		} finally {
			fsModule.renameSync = realRenameSync;
			syncBuiltinESMExports();
		}

		const busyLockPath = nextLockPath();
		fsModule.renameSync = ((from: fsModule.PathLike, to: fsModule.PathLike) => {
			if (to === busyLockPath || from === busyLockPath) {
				const error = new Error("EBUSY") as NodeJS.ErrnoException;
				error.code = "EBUSY";
				throw error;
			}
			realRenameSync(from, to);
		}) as typeof fsModule.renameSync;
		syncBuiltinESMExports();

		try {
			const acquired = withFirstNowAged(() => acquireSpawnLock(busyLockPath));
			assertFreshOwner(busyLockPath, acquired);
			releaseSpawnLock(acquired, busyLockPath);
		} finally {
			fsModule.renameSync = realRenameSync;
			syncBuiltinESMExports();
		}
	});
});
