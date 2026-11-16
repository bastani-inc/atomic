import assert from "node:assert/strict";
import fsModule from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import {
	acquireSpawnLock,
	isSpawnLockStale,
	releaseSpawnLock,
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

function withFirstNowAged<T>(run: () => T): T {
	const realNow = Date.now;
	let firstCall = true;
	Date.now = () => {
		const now = realNow.call(Date);
		if (firstCall) {
			firstCall = false;
			return now - AGED_HEADER_OFFSET_MS;
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
				assert.ok(owner !== undefined);
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
			assert.equal(acquired, undefined);
		} finally {
			fsModule.renameSync = realRenameSync;
			syncBuiltinESMExports();
		}
	});
});
