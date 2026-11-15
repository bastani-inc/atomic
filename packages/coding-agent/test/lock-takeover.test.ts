import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { HOLDER_TEMP_STALE_MS } from "../src/core/lock-holder.ts";
import {
	guardLockRemoval,
	removeStaleLock,
	TAKEOVER_MUTEX_STALE_MS,
	takeoverMutexPath,
	takeTakeoverMutex,
} from "../src/core/lock-takeover.ts";
import { lockHolder } from "../src/core/lock-wait.ts";
import { processStartToken } from "../src/core/process-start-token.ts";
import { FileSettingsStorage } from "../src/core/settings-storage.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

const STALE_MS = 10_000;

let directory: string;
let lockPath: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-lock-takeover-")));
	lockPath = join(directory, "settings.json.lock");
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

/** A lock directory whose holder stopped refreshing it `ageMs` ago. */
function staleLock(path: string, ageMs = STALE_MS + 5_000): void {
	mkdirSync(path);
	const old = new Date(Date.now() - ageMs);
	utimesSync(path, old, old);
}

/** Another process removed the stale lock and took a new one; made beside the old one so it never reuses its inode. */
function anotherProcessTakesTheLock(): string | undefined {
	mkdirSync(`${lockPath}.fresh`);
	rmSync(lockPath, { recursive: true, force: true });
	const fresh = `${lockPath}.fresh`;
	mkdirSync(lockPath);
	rmSync(fresh, { recursive: true });
	return lockHolder(lockPath);
}

describe("removing a stale lock (#5161)", () => {
	it("removes a lock that is still stale, and releases the takeover mutex (#5161)", () => {
		staleLock(lockPath);
		removeStaleLock(lockPath, STALE_MS);
		assert.equal(existsSync(lockPath), false);
		assert.equal(existsSync(takeoverMutexPath(lockPath)), false);
	});

	it("removes the holder-record temporary files killed writers left when it removes a stale lock (#5161)", () => {
		staleLock(lockPath);
		const old = `${lockPath}.holder.123.old.tmp`;
		const recent = `${lockPath}.holder.456.recent.tmp`;
		const unrelated = join(directory, "settings.json.789.other.tmp");
		const notTemporary = `${lockPath}.holder.backup`;
		for (const path of [old, recent, unrelated, notTemporary]) writeFileSync(path, "{");
		const past = new Date(Date.now() - HOLDER_TEMP_STALE_MS - 1_000);
		for (const path of [old, unrelated, notTemporary]) utimesSync(path, past, past);
		removeStaleLock(lockPath, STALE_MS);
		assert.equal(existsSync(lockPath), false);
		assert.equal(existsSync(old), false);
		assert.equal(existsSync(recent), true, "a recent one may still be written");
		assert.equal(existsSync(unrelated), true, "another file's temporary file is not a holder record's");
		assert.equal(existsSync(notTemporary), true, "only temporary files are removed");
	});

	it("keeps a lock taken since it was judged stale (#5161)", () => {
		mkdirSync(lockPath);
		removeStaleLock(lockPath, STALE_MS);
		assert.equal(existsSync(lockPath), true, "a fresh lock is never removed");
		assert.equal(existsSync(takeoverMutexPath(lockPath)), false);
	});

	it("keeps a stale lock while another process holds the takeover mutex (#5161)", () => {
		staleLock(lockPath);
		mkdirSync(takeoverMutexPath(lockPath));
		removeStaleLock(lockPath, STALE_MS);
		assert.equal(existsSync(lockPath), true);
		assert.equal(existsSync(takeoverMutexPath(lockPath)), true, "another process's mutex is left alone");
	});

	it("does nothing when the lock's directory is gone, and the mutex cannot be made (#5161)", () => {
		const missing = join(directory, "gone", "settings.json.lock");
		assert.doesNotThrow(() => removeStaleLock(missing, STALE_MS));
		assert.equal(existsSync(join(directory, "gone")), false);
	});

	it("does nothing for a lock that is already gone (#5161)", () => {
		removeStaleLock(lockPath, STALE_MS);
		assert.equal(existsSync(lockPath), false);
		assert.equal(existsSync(takeoverMutexPath(lockPath)), false);
	});
});

describe("proper-lockfile's removal of a stale lock (#5161)", () => {
	it("never removes the lock another process took after both judged the old one stale (#5161)", () => {
		staleLock(lockPath);
		const first = guardLockRemoval(lockPath, STALE_MS);
		const second = guardLockRemoval(lockPath, STALE_MS);
		// Both judged the lock stale; the first removes it and another process takes the lock.
		first.fs.rmdirSync(lockPath);
		assert.equal(existsSync(lockPath), false);
		const taken = anotherProcessTakesTheLock();
		second.fs.rmdirSync(lockPath);
		assert.equal(lockHolder(lockPath), taken, "the second removal leaves the live lock");
		const done = new Promise<NodeJS.ErrnoException | null>((settle) => second.fs.rmdir(lockPath, settle));
		return done.then((error) => {
			assert.equal(error, null);
			assert.equal(lockHolder(lockPath), taken, "so does an asynchronous removal");
		});
	});

	it("removes a stale lock through the asynchronous removal too (#5161)", async () => {
		staleLock(lockPath);
		const guard = guardLockRemoval(lockPath, STALE_MS);
		const error = await new Promise<NodeJS.ErrnoException | null>((settle) => guard.fs.rmdir(lockPath, settle));
		assert.equal(error, null);
		assert.equal(existsSync(lockPath), false);
	});

	it("reports an asynchronous removal that fails (#5161)", async () => {
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "occupied"), "");
		const old = new Date(Date.now() - STALE_MS - 5_000);
		utimesSync(lockPath, old, old);
		const guard = guardLockRemoval(lockPath, STALE_MS);
		const error = await new Promise<NodeJS.ErrnoException | null>((settle) => guard.fs.rmdir(lockPath, settle));
		assert.ok(error);
		assert.equal(existsSync(takeoverMutexPath(lockPath)), false);
	});

	it("lets the holder release its own fresh lock once it is taken (#5161)", async () => {
		const guard = guardLockRemoval(lockPath, STALE_MS);
		mkdirSync(lockPath);
		guard.done();
		guard.fs.rmdirSync(lockPath);
		assert.equal(existsSync(lockPath), false);
		mkdirSync(lockPath);
		const error = await new Promise<NodeJS.ErrnoException | null>((settle) => guard.fs.rmdir(lockPath, settle));
		assert.equal(error, null);
		assert.equal(existsSync(lockPath), false);
	});

	it("removes other directories directly (#5161)", async () => {
		const guard = guardLockRemoval(lockPath, STALE_MS);
		const other = join(directory, "other");
		mkdirSync(other);
		guard.fs.rmdirSync(other);
		assert.equal(existsSync(other), false);
		mkdirSync(other);
		const error = await new Promise<NodeJS.ErrnoException | null>((settle) => guard.fs.rmdir(other, settle));
		assert.equal(error, null);
		assert.equal(existsSync(other), false);
	});

	it("saves settings over a stale lock whose holder left no record, through the mutex (#5161)", () => {
		const agentDir = join(directory, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), "{}");
		staleLock(join(agentDir, "settings.json.lock"));
		new FileSettingsStorage(join(directory, "project"), agentDir).withPrimaryWriteLock(
			"global",
			() => '{"theme":"dark"}',
		);
		assert.equal(existsSync(join(agentDir, "settings.json.lock")), false);
		assert.equal(existsSync(takeoverMutexPath(join(agentDir, "settings.json.lock"))), false);
	});

	it("saves a trust decision over a stale trust store lock, through the mutex (#5161)", () => {
		const agentDir = join(directory, "agent");
		mkdirSync(agentDir);
		staleLock(join(agentDir, "trust.json.lock"));
		new ProjectTrustStore(agentDir).set(join(directory, "project"), true);
		assert.equal(new ProjectTrustStore(agentDir).get(join(directory, "project")), true);
		assert.equal(existsSync(join(agentDir, "trust.json.lock")), false);
		assert.equal(existsSync(takeoverMutexPath(join(agentDir, "trust.json.lock"))), false);
	});
});

/** A pid that named a process which has exited. */
function exitedPid(): number {
	return Number(
		spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout,
	);
}

/** A takeover mutex another process took and named itself the owner of, `ageMs` ago. */
function mutexOf(owner: Record<string, unknown> | undefined, ageMs = 0): void {
	const mutex = takeoverMutexPath(lockPath);
	mkdirSync(mutex);
	if (owner !== undefined) writeFileSync(join(mutex, "owner"), JSON.stringify(owner));
	const at = new Date(Date.now() - ageMs);
	utimesSync(mutex, at, at);
}

describe("the takeover mutex (#5161)", () => {
	it("is owned by the process that took it until it gives it up (#5161)", () => {
		const mutex = takeTakeoverMutex(lockPath);
		assert.ok(mutex);
		assert.equal(mutex.owned(), true);
		assert.equal(takeTakeoverMutex(lockPath), undefined, "a mutex is taken once");
		mutex.release();
		assert.equal(existsSync(takeoverMutexPath(lockPath)), false);
		assert.equal(mutex.owned(), false);
	});

	it("is taken over at once from an owner that has exited, however fresh (#5161)", () => {
		mutexOf({ host: hostname(), pid: exitedPid(), id: "dead" });
		const mutex = takeTakeoverMutex(lockPath);
		assert.ok(mutex);
		assert.equal(mutex.owned(), true);
		mutex.release();
		assert.deepEqual(
			readdirSync(directory).filter((name) => name.endsWith(".dead")),
			[],
		);
	});

	it("is kept by a live owner however old, and by an owner on another host (#5161)", () => {
		mutexOf(
			{ host: hostname(), pid: process.pid, started: processStartToken(process.pid), id: "live" },
			TAKEOVER_MUTEX_STALE_MS * 3,
		);
		assert.equal(takeTakeoverMutex(lockPath), undefined);
		rmSync(takeoverMutexPath(lockPath), { recursive: true });
		mutexOf({ host: `${hostname()}-other`, pid: exitedPid(), id: "remote" }, TAKEOVER_MUTEX_STALE_MS * 3);
		assert.equal(takeTakeoverMutex(lockPath), undefined);
	});

	it("is judged by its age only when it names no owner (#5161)", () => {
		mutexOf(undefined);
		assert.equal(takeTakeoverMutex(lockPath), undefined, "a fresh mutex that names no owner is kept");
		rmSync(takeoverMutexPath(lockPath), { recursive: true });
		mutexOf({ host: hostname(), pid: "1", id: "malformed" }, TAKEOVER_MUTEX_STALE_MS + 1_000);
		const mutex = takeTakeoverMutex(lockPath);
		assert.ok(mutex, "an old mutex whose owner cannot be read is stale");
		mutex.release();
		mutexOf({ host: hostname(), pid: exitedPid(), started: 1, id: "malformed" });
		assert.equal(takeTakeoverMutex(lockPath), undefined, "a malformed owner is no owner: the mutex is fresh");
		rmSync(takeoverMutexPath(lockPath), { recursive: true });
		mutexOf({ host: hostname(), pid: String(exitedPid()), id: "malformed" });
		assert.equal(takeTakeoverMutex(lockPath), undefined, "an owner whose pid is not a number is no owner");
		rmSync(takeoverMutexPath(lockPath), { recursive: true });
		mutexOf({ host: hostname(), pid: exitedPid() });
		assert.equal(takeTakeoverMutex(lockPath), undefined, "an owner without an id is no owner");
	});

	it("is not given up by a process that no longer owns it (#5161)", () => {
		const mutex = takeTakeoverMutex(lockPath);
		assert.ok(mutex);
		writeFileSync(
			join(takeoverMutexPath(lockPath), "owner"),
			JSON.stringify({ host: hostname(), pid: 1, id: "other" }),
		);
		assert.equal(mutex.owned(), false);
		mutex.release();
		assert.equal(existsSync(takeoverMutexPath(lockPath)), true);
	});

	it("removes a stale lock though a process that exited left the takeover mutex behind (#5161)", () => {
		staleLock(lockPath);
		mutexOf({ host: hostname(), pid: exitedPid(), id: "dead" });
		removeStaleLock(lockPath, STALE_MS);
		assert.equal(existsSync(lockPath), false, "a dead owner's mutex does not stop the removal");
	});
});
