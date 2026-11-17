import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
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
import { afterEach, beforeEach, describe, it } from "vitest";
import { HOLDER_TEMP_STALE_MS } from "../src/core/lock-holder.ts";
import {
	guardLockRemoval,
	guardLockRemovalSync,
	putBack,
	removeStaleLock,
	setNativeLocksForTesting,
	TAKEOVER_MUTEX_STALE_MS,
	takeoverLockPath,
	takeoverMutexPath,
	takeTakeoverMutex,
} from "../src/core/lock-takeover.ts";
import { lockHolder } from "../src/core/lock-wait.ts";
import { processStartToken } from "../src/core/process-start-token.ts";
import { FileSettingsStorage } from "../src/core/settings-storage.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

const STALE_MS = 10_000;
const LOCK_TAKEOVER_MODULE = fileURLToPath(new URL("../src/core/lock-takeover.ts", import.meta.url));

let directory: string;
let lockPath: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-lock-takeover-")));
	lockPath = join(directory, "settings.json.lock");
});

afterEach(() => {
	setNativeLocksForTesting(undefined);
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

	it("keeps a stale lock while another takeover holds the advisory mutex (#5193)", () => {
		staleLock(lockPath);
		const mutex = takeTakeoverMutex(lockPath);
		assert.ok(mutex);
		try {
			removeStaleLock(lockPath, STALE_MS);
			assert.equal(existsSync(lockPath), true);
		} finally {
			mutex.release();
		}
		removeStaleLock(lockPath, STALE_MS);
		assert.equal(existsSync(lockPath), false, "once the mutex is released, the stale lock is removed");
	});

	it("without the native lock, keeps a stale lock while another process holds the takeover mutex (#5161)", () => {
		setNativeLocksForTesting(null);
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
		const first = guardLockRemovalSync(lockPath, STALE_MS);
		const second = guardLockRemovalSync(lockPath, STALE_MS);
		// Both judged the lock stale; the first removes it and another process takes the lock.
		first.fs.rmdirSync(lockPath);
		assert.equal(existsSync(lockPath), false);
		const taken = anotherProcessTakesTheLock();
		second.fs.rmdirSync(lockPath);
		assert.equal(lockHolder(lockPath), taken, "the second removal leaves the live lock");
		const third = guardLockRemoval(lockPath, STALE_MS);
		const done = new Promise<NodeJS.ErrnoException | null>((settle) => third.fs.rmdir(lockPath, settle));
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
		const syncGuard = guardLockRemovalSync(lockPath, STALE_MS);
		mkdirSync(lockPath);
		syncGuard.done();
		syncGuard.fs.rmdirSync(lockPath);
		assert.equal(existsSync(lockPath), false);
		const guard = guardLockRemoval(lockPath, STALE_MS);
		mkdirSync(lockPath);
		guard.done();
		const error = await new Promise<NodeJS.ErrnoException | null>((settle) => guard.fs.rmdir(lockPath, settle));
		assert.equal(error, null);
		assert.equal(existsSync(lockPath), false);
	});

	it("removes other directories directly (#5161)", async () => {
		const guard = guardLockRemoval(lockPath, STALE_MS);
		const other = join(directory, "other");
		mkdirSync(other);
		guardLockRemovalSync(lockPath, STALE_MS).fs.rmdirSync(other);
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

describe("the directory takeover mutex, without the native lock (#5161)", () => {
	beforeEach(() => setNativeLocksForTesting(null));

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

describe("the advisory takeover mutex (#5193)", () => {
	it("is held by one taker at a time until released, and its file is kept (#5193)", () => {
		const mutex = takeTakeoverMutex(lockPath);
		assert.ok(mutex);
		assert.equal(mutex.owned(), true);
		assert.equal(takeTakeoverMutex(lockPath, 0), undefined, "a held mutex is not taken again");
		mutex.release();
		assert.equal(mutex.owned(), false);
		mutex.release();
		assert.equal(existsSync(takeoverLockPath(lockPath)), true, "the lock file is never removed");
		assert.equal(existsSync(takeoverMutexPath(lockPath)), false, "no directory mutex is made");
		const again = takeTakeoverMutex(lockPath, 0);
		assert.ok(again, "a released mutex is taken at once");
		again.release();
	});

	it("waits for a held mutex only as long as it is given (#5193)", () => {
		const mutex = takeTakeoverMutex(lockPath);
		assert.ok(mutex);
		try {
			const started = Date.now();
			assert.equal(takeTakeoverMutex(lockPath, 100), undefined);
			const waited = Date.now() - started;
			assert.ok(waited >= 90 && waited < 5_000, `waited ${waited} ms`);
		} finally {
			mutex.release();
		}
	});

	it("is not taken while a process without the native lock holds the directory mutex (#5193)", () => {
		mutexOf({ host: hostname(), pid: process.pid, started: processStartToken(process.pid), id: "fallback" });
		assert.equal(takeTakeoverMutex(lockPath, 0), undefined, "a live fallback holder keeps it");
		const again = takeTakeoverMutex(lockPath, 0);
		assert.equal(again, undefined, "and the advisory lock is not kept by the refused taker");
	});

	it("removes the staging directories a killed native taker left, and never leaves a mutex without its owner (#5193)", () => {
		const leftover = `${takeoverMutexPath(lockPath)}.left-by-a-killed-taker.tmp`;
		mkdirSync(leftover);
		writeFileSync(join(leftover, "owner"), "{}");
		const mutex = takeTakeoverMutex(lockPath, 0);
		assert.ok(mutex);
		assert.equal(existsSync(leftover), false, "the leftover staging directory is removed");
		assert.ok(readFileSync(join(takeoverMutexPath(lockPath), "owner"), "utf8").includes(String(process.pid)));
		mutex.release();
		assert.deepEqual(
			readdirSync(directory).filter((name) => name.includes(".takeover") && !name.endsWith(".takeover.lock")),
			[],
			"nothing is left beside the advisory lock file",
		);
	});

	it("also holds the owner-checked directory mutex, freed once its owner is dead (#5193)", () => {
		const mutex = takeTakeoverMutex(lockPath, 0);
		assert.ok(mutex);
		assert.equal(
			existsSync(join(takeoverMutexPath(lockPath), "owner")),
			true,
			"the directory mutex names this process",
		);
		mutex.release();
		assert.equal(existsSync(takeoverMutexPath(lockPath)), false);
		mutexOf({ host: hostname(), pid: exitedPid(), id: "killed" });
		const after = takeTakeoverMutex(lockPath, 0);
		assert.ok(after, "a killed holder's directory mutex is freed by its owner check");
		after.release();
	});

	it("is not taken when its file cannot be opened (#5193)", () => {
		assert.equal(takeTakeoverMutex(join(directory, "gone", "settings.json.lock"), 0), undefined);
	});

	it("without the native lock, warns once and takes the directory mutex (#5193)", async () => {
		// Warnings earlier tests raised are delivered first.
		await new Promise((resolve) => setTimeout(resolve, 50));
		setNativeLocksForTesting(null);
		const warnings: string[] = [];
		const listen = (warning: Error) => warnings.push(warning.message);
		process.on("warning", listen);
		try {
			const first = takeTakeoverMutex(lockPath);
			assert.ok(first);
			assert.equal(existsSync(takeoverMutexPath(lockPath)), true);
			first.release();
			takeTakeoverMutex(lockPath)?.release();
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off("warning", listen);
		}
		assert.equal(warnings.filter((message) => message.includes("#5193")).length, 1);
	});
});

/**
 * Another process whose native module is `binding`, as Bun loads it in place of the real one (`undefined`: it fails to
 * load), takes the takeover mutex twice and reports what it saw.
 */
function anotherProcessWithBinding(binding: string | undefined): { directory: boolean; warnings: number } {
	const module =
		binding === undefined
			? `() => { throw new Error("no binding"); }`
			: `() => ({ exports: ${binding}, loader: "object" })`;
	const script = `
		Bun.plugin({ setup(build) { build.module("@bastani/atomic-natives", ${module}); } });
		let warnings = 0;
		process.on("warning", (warning) => { if (warning.message.includes("#5193")) warnings++; });
		const { existsSync } = await import("node:fs");
		const { takeTakeoverMutex, takeoverMutexPath } = await import(${JSON.stringify(LOCK_TAKEOVER_MODULE)});
		const lockPath = ${JSON.stringify(lockPath)};
		const mutex = takeTakeoverMutex(lockPath);
		const directory = existsSync(takeoverMutexPath(lockPath));
		mutex?.release();
		takeTakeoverMutex(lockPath)?.release();
		setImmediate(() => console.log(JSON.stringify({ directory, warnings })));
	`;
	const result = spawnSync("bun", ["--eval", script], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { directory: boolean; warnings: number };
}

describe("a native module without the advisory lock (#5193)", () => {
	it("built before the lock, falls back to the directory mutex with one warning (#5193)", () => {
		assert.deepEqual(anotherProcessWithBinding("{ processCreationTime: () => null }"), {
			directory: true,
			warnings: 1,
		});
	});

	it("with only one of the lock's functions, falls back to the directory mutex (#5193)", () => {
		const lock = "tryAdvisoryLock: () => ({ release() {} })";
		const rename =
			'renameNoReplace: (from, to) => { const fs = require("node:fs"); if (fs.existsSync(to)) return false; fs.renameSync(from, to); return true; }';
		assert.deepEqual(anotherProcessWithBinding(`{ ${lock} }`), { directory: true, warnings: 1 });
		assert.deepEqual(anotherProcessWithBinding(`{ ${rename} }`), { directory: true, warnings: 1 });
		assert.deepEqual(anotherProcessWithBinding(`{ ${lock}, ${rename} }`), { directory: true, warnings: 0 });
	});

	it("that fails to load, falls back to the directory mutex with one warning (#5193)", () => {
		assert.deepEqual(anotherProcessWithBinding(undefined), { directory: true, warnings: 1 });
	});
});

describe("an advisory lock file that cannot be opened (#5193)", () => {
	it("falls back to the directory mutex, so a stale lock is still removed, and warns once naming the file (#5193)", async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		staleLock(lockPath);
		// As left by one `sudo atomic`: a lock file this user may not open for writing.
		writeFileSync(takeoverLockPath(lockPath), "");
		chmodSync(takeoverLockPath(lockPath), 0o444);
		const warnings: string[] = [];
		const listen = (warning: Error) => warnings.push(warning.message);
		process.on("warning", listen);
		try {
			removeStaleLock(lockPath, STALE_MS);
			assert.equal(existsSync(lockPath), false, "the stale lock is removed under the directory mutex");
			const mutex = takeTakeoverMutex(lockPath, 0);
			assert.ok(mutex, "the takeover mutex is taken");
			mutex.release();
			assert.equal(existsSync(takeoverMutexPath(lockPath)), false, "the directory mutex is released");
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off("warning", listen);
			chmodSync(takeoverLockPath(lockPath), 0o644);
		}
		const named = warnings.filter((message) => message.includes(takeoverLockPath(lockPath)));
		assert.equal(named.length, 1, JSON.stringify(warnings));
		assert.match(named[0]!, /remove|chown/i);
	});
});

describe("a moved-aside mutex that cannot be removed (#5193)", () => {
	// Windows ignores a directory's mode, and root may remove anything: neither can make the directory unremovable here.
	const cannotProtect = process.platform === "win32" || process.getuid?.() === 0;

	it.skipIf(cannotProtect)(
		"never fails the takeover, and warns once naming the directory and the fix (#5193)",
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			staleLock(lockPath);
			// A fallback holder run as another user, then killed: its owner file is in a directory this user cannot change.
			mutexOf({ host: hostname(), pid: exitedPid(), id: "root" });
			chmodSync(takeoverMutexPath(lockPath), 0o555);
			const warnings: string[] = [];
			const listen = (warning: Error) => warnings.push(warning.message);
			process.on("warning", listen);
			let asides: string[] = [];
			try {
				assert.doesNotThrow(() => removeStaleLock(lockPath, STALE_MS));
				assert.equal(existsSync(lockPath), false, "the stale lock is removed");
				asides = readdirSync(directory).filter((name) => name.endsWith(".dead"));
				const mutex = takeTakeoverMutex(lockPath, 0);
				assert.ok(mutex, "the takeover mutex is taken again");
				mutex.release();
				removeStaleLock(lockPath, STALE_MS);
				await new Promise((resolve) => setImmediate(resolve));
			} finally {
				process.off("warning", listen);
				for (const name of readdirSync(directory)) {
					if (name.includes(".takeover")) chmodSync(join(directory, name), 0o755);
				}
			}
			assert.equal(asides.length, 1, "the dead mutex is left aside");
			const named = warnings.filter((message) => message.includes(asides[0]!));
			assert.equal(named.length, 1, JSON.stringify(warnings));
			assert.match(named[0]!, /remove|chown/i);
		},
	);
});

describe("putting back a moved item that is not the one judged (#5193)", () => {
	it("links a file back only while nothing is at its path (#5193)", () => {
		const path = join(directory, "claim.json");
		const aside = `${path}.moved.dead`;
		writeFileSync(aside, "live");
		assert.equal(putBack(aside, path), true);
		assert.equal(readFileSync(path, "utf8"), "live");
		assert.equal(existsSync(aside), false);
		writeFileSync(aside, "moved");
		assert.equal(putBack(aside, path), false, "a file at the path is never replaced");
		assert.equal(readFileSync(path, "utf8"), "live");
		assert.equal(readFileSync(aside, "utf8"), "moved");
	});

	it("renames a directory back only while nothing is at its path (#5193)", () => {
		const aside = `${lockPath}.moved.dead`;
		mkdirSync(aside);
		const moved = lockHolder(aside);
		assert.equal(putBack(aside, lockPath), true);
		assert.equal(lockHolder(lockPath), moved);
		assert.equal(existsSync(aside), false);
		mkdirSync(aside);
		assert.equal(putBack(aside, lockPath), false, "an empty directory at the path is never replaced");
		assert.equal(lockHolder(lockPath), moved);
		assert.equal(existsSync(aside), true);
	});

	it("links a file back without the native module (#5193)", () => {
		setNativeLocksForTesting(null);
		const path = join(directory, "claim.json");
		writeFileSync(`${path}.moved.dead`, "live");
		assert.equal(putBack(`${path}.moved.dead`, path), true);
		assert.equal(readFileSync(path, "utf8"), "live");
	});

	it("leaves a directory aside without the native rename (#5193)", () => {
		setNativeLocksForTesting(null);
		const aside = `${lockPath}.moved.dead`;
		mkdirSync(aside);
		assert.equal(putBack(aside, lockPath), false);
		assert.equal(existsSync(aside), true);
		assert.equal(existsSync(lockPath), false);
	});

	it("puts back nothing that is gone (#5193)", () => {
		assert.equal(putBack(join(directory, "missing.dead"), lockPath), false);
	});
});
