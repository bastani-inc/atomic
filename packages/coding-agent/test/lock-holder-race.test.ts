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
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, it, vi } from "vitest";

/**
 * Hooks that run once just before the next takeover-mutex creation or lock-directory rename, as another process would
 * act in between (#5161).
 */
const race = vi.hoisted(() => ({
	beforeMutex: undefined as (() => void) | undefined,
	beforeRename: undefined as (() => void) | undefined,
	afterOwner: undefined as (() => void) | undefined,
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
	const writeFileSync = ((path: string, ...rest: unknown[]) => {
		actual.writeFileSync(path, ...(rest as [string]));
		if (String(path).endsWith("owner")) {
			const after = race.afterOwner;
			race.afterOwner = undefined;
			after?.();
		}
	}) as typeof actual.writeFileSync;
	return {
		...actual,
		default: { ...actual, renameSync, mkdirSync, writeFileSync },
		renameSync,
		mkdirSync,
		writeFileSync,
	};
});

const { lockHolderPath, takeOverDeadHolder } = await import("../src/core/lock-holder.ts");
const { takeoverMutexPath, TAKEOVER_MUTEX_STALE_MS } = await import("../src/core/lock-takeover.ts");
const { lockHolder } = await import("../src/core/lock-wait.ts");

const LOCK_HOLDER_MODULE = fileURLToPath(new URL("../src/core/lock-holder.ts", import.meta.url));

/** Another process tries to take over the lock at `lockPath`, and says whether it did. */
function anotherProcessTakesOver(): boolean {
	const script = `import { takeOverDeadHolder } from ${JSON.stringify(LOCK_HOLDER_MODULE)}; console.log(takeOverDeadHolder(${JSON.stringify(lockPath)}));`;
	const result = spawnSync("bun", ["--eval", script], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim() === "true";
}

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
	let heldWhileMoving = false;
	race.beforeRename = () => {
		heldWhileMoving = existsSync(takeoverMutexPath(lockPath));
	};
	assert.equal(takeOverDeadHolder(lockPath), true);
	assert.equal(heldWhileMoving, true, "the lock is moved while this process holds a fresh mutex");
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

it("keeps the mutex of a takeover paused past its stale age, so no other process takes the lock over meanwhile (#5161)", () => {
	let otherTookOver: boolean | undefined;
	race.beforeRename = () => {
		// This process is paused between its check and its move for longer than a mutex's stale age.
		const old = new Date(Date.now() - TAKEOVER_MUTEX_STALE_MS - 1_000);
		utimesSync(takeoverMutexPath(lockPath), old, old);
		otherTookOver = anotherProcessTakesOver();
	};
	assert.equal(takeOverDeadHolder(lockPath), true);
	assert.equal(otherTookOver, false, "a live process's mutex is never judged stale by its age");
	assert.deepEqual(asideNames(), []);
	assert.equal(existsSync(takeoverMutexPath(lockPath)), false);
});

it("moves nothing once another process owns the mutex it took (#5161)", () => {
	race.afterOwner = () => {
		writeFileSync(
			join(takeoverMutexPath(lockPath), "owner"),
			JSON.stringify({ host: hostname(), pid: 1, id: "other" }),
		);
	};
	assert.equal(takeOverDeadHolder(lockPath), false);
	assert.equal(lockHolder(lockPath), deadLock, "the lock stays in place");
	assert.equal(existsSync(takeoverMutexPath(lockPath)), true, "another process's mutex is not released");
});
