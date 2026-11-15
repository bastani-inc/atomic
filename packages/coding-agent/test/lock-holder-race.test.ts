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
import { afterEach, beforeEach, it, vi } from "vitest";

/**
 * Hooks that run once just before the next takeover-mutex creation or lock-directory rename, as another process would
 * act in between (#5161).
 */
const race = vi.hoisted(() => ({
	beforeMutex: undefined as (() => void) | undefined,
	beforeRename: undefined as (() => void) | undefined,
	rename: undefined as ((from: string, to: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	race.rename = actual.renameSync;
	const renameSync: typeof actual.renameSync = (from, to) => {
		const before = race.beforeRename;
		race.beforeRename = undefined;
		before?.();
		actual.renameSync(from, to);
	};
	const mkdirSync = ((path: string, options?: unknown) => {
		if (String(path).endsWith(".takeover")) {
			const before = race.beforeMutex;
			race.beforeMutex = undefined;
			before?.();
		}
		return actual.mkdirSync(path, options as never);
	}) as typeof actual.mkdirSync;
	return { ...actual, default: { ...actual, renameSync, mkdirSync }, renameSync, mkdirSync };
});

const { lockHolderPath, takeOverDeadHolder, takeoverMutexPath, TAKEOVER_MUTEX_STALE_MS } = await import(
	"../src/core/lock-holder.ts"
);
const { lockHolder } = await import("../src/core/lock-wait.ts");

let directory: string;
let lockPath: string;
let deadLock: string | undefined;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-lock-holder-race-")));
	lockPath = join(directory, "settings.json.lock");
	race.beforeMutex = undefined;
	race.beforeRename = undefined;
	mkdirSync(lockPath);
	deadLock = lockHolder(lockPath);
	const exited = Number(
		spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout,
	);
	writeFileSync(lockHolderPath(lockPath), JSON.stringify({ host: hostname(), pid: exited, lock: deadLock }));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

/**
 * Another process frees the dead holder's lock and takes a new one. The new lock directory is made while the old one
 * still exists, so it never reuses its inode.
 */
function anotherProcessTakesTheLock(): string | undefined {
	const fresh = `${lockPath}.fresh`;
	mkdirSync(fresh);
	rmSync(lockPath, { recursive: true });
	race.rename!(fresh, lockPath);
	return lockHolder(lockPath);
}

function asideNames(): string[] {
	return readdirSync(directory).filter((name) => name.endsWith(".dead"));
}

it("never moves a lock another process took after the dead holder's was judged (#5161)", () => {
	let taken: string | undefined;
	race.beforeMutex = () => {
		taken = anotherProcessTakesTheLock();
	};
	assert.equal(takeOverDeadHolder(lockPath), false);
	assert.ok(taken);
	assert.notEqual(taken, deadLock);
	assert.equal(lockHolder(lockPath), taken, "the other process's lock stays in place");
	assert.deepEqual(asideNames(), []);
	assert.equal(existsSync(takeoverMutexPath(lockPath)), false, "the takeover mutex is released");
});

it("never moves a lock whose holder record changed after it was judged (#5161)", () => {
	race.beforeMutex = () => {
		writeFileSync(
			lockHolderPath(lockPath),
			JSON.stringify({ host: hostname(), pid: process.pid, lock: lockHolder(lockPath) }),
		);
	};
	assert.equal(takeOverDeadHolder(lockPath), false);
	assert.equal(lockHolder(lockPath), deadLock);
	assert.deepEqual(asideNames(), []);
});

it("does not take over while another process takes it over (#5161)", () => {
	mkdirSync(takeoverMutexPath(lockPath));
	assert.equal(takeOverDeadHolder(lockPath), false);
	assert.equal(lockHolder(lockPath), deadLock);
	assert.equal(existsSync(takeoverMutexPath(lockPath)), true, "another process's mutex is left alone");
});

it("removes a takeover mutex left by a killed process once it is stale, then takes over (#5161)", () => {
	mkdirSync(takeoverMutexPath(lockPath));
	const old = new Date(Date.now() - TAKEOVER_MUTEX_STALE_MS - 1_000);
	utimesSync(takeoverMutexPath(lockPath), old, old);
	assert.equal(takeOverDeadHolder(lockPath), true);
	assert.equal(existsSync(lockPath), false);
	assert.equal(existsSync(takeoverMutexPath(lockPath)), false);
});

it("leaves a directory it moved that is not the dead holder's, and never puts it back (#5161)", () => {
	let taken: string | undefined;
	// Only a remover outside the mutex, such as proper-lockfile's stale check, can swap the lock this late.
	race.beforeRename = () => {
		taken = anotherProcessTakesTheLock();
	};
	assert.equal(takeOverDeadHolder(lockPath), false);
	assert.equal(existsSync(lockPath), false, "nothing is put back over the lock path");
	const [aside, ...more] = asideNames();
	assert.deepEqual(more, []);
	assert.equal(lockHolder(join(directory, aside!)), taken, "the moved lock is not removed");
});

it("does not take over a lock that is gone before it is moved aside (#5161)", () => {
	race.beforeRename = () => {
		rmSync(lockPath, { recursive: true });
	};
	assert.equal(takeOverDeadHolder(lockPath), false);
	assert.equal(existsSync(lockPath), false);
	assert.deepEqual(asideNames(), []);
});
