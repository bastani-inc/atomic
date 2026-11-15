import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { guardLockRemoval, removeStaleLock, takeoverMutexPath } from "../src/core/lock-takeover.ts";
import { lockHolder } from "../src/core/lock-wait.ts";
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
