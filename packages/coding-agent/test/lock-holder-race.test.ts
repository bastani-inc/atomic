import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, it, vi } from "vitest";
import { exitedProcess } from "../../../test/helpers/exited-process.js";

/**
 * Hooks that run once just before the next takeover-mutex creation or lock-directory rename, as another process would
 * act in between (#5161).
 */
const race = vi.hoisted(() => ({
	beforeMutex: undefined as (() => void) | undefined,
	beforeRename: undefined as (() => void) | undefined,
	afterOwner: undefined as (() => void) | undefined,
	afterMutexRefused: undefined as (() => void) | undefined,
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
			try {
				return actual.mkdirSync(path, options as never);
			} catch (error) {
				const after = race.afterMutexRefused;
				race.afterMutexRefused = undefined;
				after?.();
				throw error;
			}
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
const { setNativeLocksForTesting, takeoverMutexPath, takeTakeoverMutex, TAKEOVER_MUTEX_STALE_MS } = await import(
	"../src/core/lock-takeover.ts"
);
const { lockHolder } = await import("../src/core/lock-wait.ts");

const LOCK_HOLDER_MODULE = fileURLToPath(new URL("../src/core/lock-holder.ts", import.meta.url));
const LOCK_TAKEOVER_MODULE = fileURLToPath(new URL("../src/core/lock-takeover.ts", import.meta.url));

/**
 * Whether this process takes over through the native advisory lock. The tests of #5161 cover the directory mutex
 * taken without it (#5193), as do the other processes they start.
 */
let native = false;

/** Another process tries to take over the lock at `lockPath`, and says whether it did. */
function anotherProcessTakesOver(): boolean {
	const script = `import { takeOverDeadHolder } from ${JSON.stringify(LOCK_HOLDER_MODULE)};
		import { setNativeLocksForTesting } from ${JSON.stringify(LOCK_TAKEOVER_MODULE)};
		if (!${native}) setNativeLocksForTesting(null);
		console.log(takeOverDeadHolder(${JSON.stringify(lockPath)}));`;
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
	native = false;
	setNativeLocksForTesting(null);
	mkdirSync(lockPath);
	deadLock = lockHolder(lockPath);
	writeFileSync(lockHolderPath(lockPath), JSON.stringify({ host: hostname(), ...exitedProcess(), lock: deadLock }));
});

afterEach(() => {
	setNativeLocksForTesting(undefined);
	rmSync(directory, { recursive: true, force: true });
});

/** This process, and the others it starts, take over through the native advisory lock. */
function useNativeLock(): void {
	native = true;
	setNativeLocksForTesting(undefined);
}

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

it("without the native lock, leaves a directory it moved that is not the dead holder's, and never puts it back (#5161)", () => {
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

/** A takeover mutex whose owner, a process that has exited, left it behind. */
function deadOwnersMutex(id = "dead"): void {
	mkdirSync(takeoverMutexPath(lockPath));
	writeFileSync(
		join(takeoverMutexPath(lockPath), "owner"),
		JSON.stringify({ host: hostname(), ...exitedProcess(), id }),
	);
}

it("takes the mutex at once when the one it found is gone before it is judged (#5161)", () => {
	mkdirSync(takeoverMutexPath(lockPath));
	race.afterMutexRefused = () => {
		rmSync(takeoverMutexPath(lockPath), { recursive: true });
	};
	const mutex = takeTakeoverMutex(lockPath);
	assert.ok(mutex);
	assert.equal(mutex.owned(), true);
	mutex.release();
});

it("never removes a mutex another process took after a dead owner's was judged (#5161)", () => {
	deadOwnersMutex();
	race.beforeRename = () => {
		// Another process removed the dead owner's mutex and took a new one, made beside it so it has a new inode.
		const fresh = `${takeoverMutexPath(lockPath)}.fresh`;
		mkdirSync(fresh);
		writeFileSync(join(fresh, "owner"), JSON.stringify({ host: hostname(), pid: process.pid, id: "live" }));
		rmSync(takeoverMutexPath(lockPath), { recursive: true });
		race.rename!(fresh, takeoverMutexPath(lockPath));
	};
	assert.equal(takeTakeoverMutex(lockPath), undefined);
	const [aside, ...more] = asideNames();
	assert.deepEqual(more, []);
	assert.equal(
		(JSON.parse(readFileSync(join(directory, aside!, "owner"), "utf8")) as { id: string }).id,
		"live",
		"the live mutex is left aside, not removed",
	);
});

it("never removes a mutex whose owner changed after it was judged (#5161)", () => {
	deadOwnersMutex();
	race.beforeRename = () => {
		writeFileSync(
			join(takeoverMutexPath(lockPath), "owner"),
			JSON.stringify({ host: hostname(), pid: process.pid, id: "live" }),
		);
	};
	assert.equal(takeTakeoverMutex(lockPath), undefined);
	assert.equal(asideNames().length, 1, "the mutex is left aside, not removed");
});

it("puts back a lock it moved that is not the dead holder's while the lock path is free (#5193)", () => {
	useNativeLock();
	let taken: string | undefined;
	// Only a remover outside the mutex can swap the lock this late.
	race.beforeRename = () => {
		taken = anotherProcessTakesTheLock();
	};
	assert.equal(takeOverDeadHolder(lockPath), false);
	assert.ok(taken);
	assert.equal(lockHolder(lockPath), taken, "the other process's lock is back in place");
	assert.deepEqual(asideNames(), []);
});

it("keeps the advisory mutex while paused between judging and moving, so another process cannot take over meanwhile (#5193)", () => {
	useNativeLock();
	let otherTookOver: boolean | undefined;
	race.beforeRename = () => {
		otherTookOver = anotherProcessTakesOver();
	};
	assert.equal(takeOverDeadHolder(lockPath), true);
	assert.equal(otherTookOver, false);
	assert.equal(existsSync(lockPath), false);
	assert.deepEqual(asideNames(), []);
});

it("is not taken over while another process holds the advisory mutex (#5193)", () => {
	useNativeLock();
	const mutex = takeTakeoverMutex(lockPath);
	assert.ok(mutex);
	try {
		assert.equal(anotherProcessTakesOver(), false);
		assert.equal(lockHolder(lockPath), deadLock);
	} finally {
		mutex.release();
	}
	assert.equal(anotherProcessTakesOver(), true);
});
