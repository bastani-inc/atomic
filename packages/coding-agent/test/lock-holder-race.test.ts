import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it, vi } from "vitest";

/** Runs once just before the next rename of a lock directory, as another process would act in between. */
const race = vi.hoisted(() => ({
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
	return { ...actual, default: { ...actual, renameSync }, renameSync };
});

const { lockHolderPath, takeOverDeadHolder } = await import("../src/core/lock-holder.ts");
const { lockHolder } = await import("../src/core/lock-wait.ts");

let directory: string;
let lockPath: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-lock-holder-race-")));
	lockPath = join(directory, "settings.json.lock");
	race.beforeRename = undefined;
	mkdirSync(lockPath);
	const exited = Number(
		spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout,
	);
	writeFileSync(
		lockHolderPath(lockPath),
		JSON.stringify({ host: hostname(), pid: exited, lock: lockHolder(lockPath) }),
	);
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

/**
 * Another process frees the dead holder's lock and takes a new one, before this one moves it aside. The new lock
 * directory is made while the old one still exists, so it never reuses its inode.
 */
function anotherProcessTakesTheLock(): string | undefined {
	const fresh = `${lockPath}.fresh`;
	mkdirSync(fresh);
	rmSync(lockPath, { recursive: true });
	race.rename!(fresh, lockPath);
	return lockHolder(lockPath);
}

it("puts back a lock another process took after the dead holder's (#5161)", () => {
	let taken: string | undefined;
	race.beforeRename = () => {
		taken = anotherProcessTakesTheLock();
	};
	assert.equal(takeOverDeadHolder(lockPath), false);
	assert.ok(taken);
	assert.equal(lockHolder(lockPath), taken, "the other process's lock is back in place");
	assert.deepEqual(
		readdirSync(directory).filter((name) => name.endsWith(".dead")),
		[],
	);
});

it("drops the lock it moved aside when the other process's lock cannot be put back (#5161)", () => {
	race.beforeRename = () => {
		anotherProcessTakesTheLock();
		// When the lock is put back, a third process holds the path again.
		race.beforeRename = () => {
			mkdirSync(join(lockPath, "occupied"), { recursive: true });
		};
	};
	assert.equal(takeOverDeadHolder(lockPath), false);
	assert.equal(existsSync(join(lockPath, "occupied")), true);
	assert.deepEqual(
		readdirSync(directory).filter((name) => name.endsWith(".dead")),
		[],
	);
});

it("does not take over a lock that is gone before it is moved aside (#5161)", () => {
	race.beforeRename = () => {
		rmSync(lockPath, { recursive: true });
	};
	assert.equal(takeOverDeadHolder(lockPath), false);
	assert.equal(existsSync(lockPath), false);
});
