import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import {
	isStorageUnsupportedOperationError,
	isStorageWriterQueueDegradedError,
	isStorageWriterQueueUnusableError,
	type StorageWriterQueueDegradedError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { databaseNow, freezeDatabaseClock } from "../helpers/database-clock.js";
import { areaRecords, withDebugLog } from "../helpers/debug-mode.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		watch: vi.fn(actual.watch),
		existsSync: vi.fn(actual.existsSync),
		mkdirSync: vi.fn(actual.mkdirSync),
		openSync: vi.fn(actual.openSync),
		utimesSync: vi.fn(actual.utimesSync),
		readdirSync: vi.fn(actual.readdirSync),
		statSync: vi.fn(actual.statSync),
		unlinkSync: vi.fn(actual.unlinkSync),
		writeSync: vi.fn(actual.writeSync),
	};
});

// A waiting writer writes and refreshes its own ticket and notice off the event loop.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		mkdir: vi.fn(actual.mkdir),
		readdir: vi.fn(actual.readdir),
		stat: vi.fn(actual.stat),
		utimes: vi.fn(actual.utimes),
		writeFile: vi.fn(actual.writeFile),
		unlink: vi.fn(actual.unlink),
	};
});

// The adapter asks `platform()` whether it runs on Windows; this file's copy can be told so without touching the
// process-wide `process.platform`.
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, platform: vi.fn(actual.platform) };
});

// The setup files already loaded the adapter with the real node:fs; load a copy that imports the mocked one.
vi.resetModules();
const { getWriterQueueDegradation, getWriterQueueStats, openNodeSqliteDatabase, wrapNodeSqliteDatabase } = await import(
	"../../packages/coding-agent/src/core/storage/node-sqlite.js"
);
// The adapter loads debug output at its first degradation. Load it now, in the same module graph, so each test's
// degradations are reported while that test runs rather than when a slow first load finishes.
await import("../../packages/coding-agent/src/core/debug.js");

/** Debug records follow a degradation asynchronously; on a loaded machine they can take far longer than a turn. */
const DEBUG_RECORD_WAIT_MS = 10_000;
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const actualPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
const watch = vi.mocked(fs.watch);
const existsSync = vi.mocked(fs.existsSync);
const mkdirSync = vi.mocked(fs.mkdirSync);
const openSync = vi.mocked(fs.openSync);
const utimesSync = vi.mocked(fs.utimesSync);
const readdirSync = vi.mocked(fs.readdirSync);
const statSync = vi.mocked(fs.statSync);
const unlinkSync = vi.mocked(fs.unlinkSync);
const writeSync = vi.mocked(fs.writeSync);
const mkdir = vi.mocked(fsPromises.mkdir);
const readdir = vi.mocked(fsPromises.readdir);
const stat = vi.mocked(fsPromises.stat);
const utimes = vi.mocked(fsPromises.utimes);
const writeFile = vi.mocked(fsPromises.writeFile);
const unlink = vi.mocked(fsPromises.unlink);
const platform = vi.mocked(os.platform);

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	vi.useRealTimers();
	watch.mockImplementation(actual.watch);
	existsSync.mockImplementation(actual.existsSync);
	mkdirSync.mockImplementation(actual.mkdirSync);
	openSync.mockImplementation(actual.openSync);
	utimesSync.mockImplementation(actual.utimesSync);
	readdirSync.mockImplementation(actual.readdirSync);
	statSync.mockImplementation(actual.statSync);
	unlinkSync.mockImplementation(actual.unlinkSync);
	writeSync.mockImplementation(actual.writeSync);
	mkdir.mockImplementation(actualPromises.mkdir);
	readdir.mockImplementation(actualPromises.readdir);
	stat.mockImplementation(actualPromises.stat);
	utimes.mockImplementation(actualPromises.utimes);
	writeFile.mockImplementation(actualPromises.writeFile);
	unlink.mockImplementation(actualPromises.unlink);
	platform.mockImplementation(actualOs.platform);
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function failure(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: injected`), { code });
}

/** Makes listing the queue directory fail with `code`, as an unreadable directory or exhausted descriptors would. */
function failListing(writers: string, code: string): void {
	const listing = (path: fs.PathLike): string[] => {
		if (String(path) === writers) throw failure(code);
		return actual.readdirSync(path);
	};
	readdirSync.mockImplementation(listing as typeof fs.readdirSync);
}

/** Makes a waiting writer's listing of the queue, off the event loop, fail with `code`. */
function failListingOffLoop(writers: string, code: string): void {
	readdir.mockImplementation((async (path: fs.PathLike) => {
		if (String(path) === writers) throw failure(code);
		return actualPromises.readdir(path);
	}) as typeof fsPromises.readdir);
}

/** Makes reading the named queue entries fail with `code`, as a directory without search permission would. */
function failTicketStat(writers: string, code: string, names?: readonly string[]): void {
	statSync.mockImplementation(((path: fs.PathLike, options?: Parameters<typeof actual.statSync>[1]) => {
		const entry = String(path);
		if (dirname(entry) === writers && (names === undefined || names.includes(basename(entry)))) throw failure(code);
		return actual.statSync(path, options);
	}) as typeof fs.statSync);
}

/** Makes removing the named queue entries fail with `code`, as another user's entries in a shared directory would. */
function failUnlink(writers: string, code: string): void {
	unlinkSync.mockImplementation(((path: fs.PathLike) => {
		if (dirname(String(path)) === writers) throw failure(code);
		actual.unlinkSync(path);
	}) as typeof fs.unlinkSync);
}

/** A ticket its writer abandoned long ago: stale for longer than the queue keeps tickets before removing them. */
function abandonedTicket(writers: string, pid: number): string {
	const name = liveTicket(writers, pid);
	const old = new Date(databaseNow() - 30_000);
	actual.utimesSync(join(writers, name), old, old);
	return name;
}

/** What Atomic's own entry points do before anything else loads: process warnings go nowhere. */
function suppressWarnings(): void {
	const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	cleanups.push(() => spy.mockRestore());
}

function wakes(writers: string): string {
	return writers.replace(/-writers$/, "-wakes");
}

/** When every release notice a test makes was last touched, until a releasing writer touches it. */
const NOTICE_UNTOUCHED_MS = Date.UTC(2000, 0, 1);

/** Whether a releasing writer has touched the release notice of the ticket `name` since it was made. */
function noticeTouched(writers: string, name: string): boolean {
	return actual.statSync(join(wakes(writers), name)).mtimeMs > NOTICE_UNTOUCHED_MS;
}

/** A ticket its writer has just refreshed, on the database clock, and a notice nobody has touched. */
function liveTicket(writers: string, pid: number, offsetMs = 0): string {
	fs.mkdirSync(writers, { recursive: true });
	fs.mkdirSync(wakes(writers), { recursive: true });
	const name = `${String(Date.now() + offsetMs).padStart(15, "0")}-${pid}-1`;
	fs.writeFileSync(join(writers, name), "");
	fs.writeFileSync(join(wakes(writers), name), "");
	const refreshed = new Date(databaseNow());
	actual.utimesSync(join(writers, name), refreshed, refreshed);
	const untouched = new Date(NOTICE_UNTOUCHED_MS);
	actual.utimesSync(join(wakes(writers), name), untouched, untouched);
	return name;
}

/**
 * The writers'-queue degradations emitted as process warnings for the database at `location` until the test ends:
 * only that database's, since any other connection in the process may emit its own, and emits them later.
 */
function degradationWarnings(location: string): StorageWriterQueueDegradedError[] {
	const warnings: StorageWriterQueueDegradedError[] = [];
	const onWarning = (warning: Error) => {
		if (isStorageWriterQueueDegradedError(warning) && warning.location === location) warnings.push(warning);
	};
	process.on("warning", onWarning);
	cleanups.push(() => {
		process.off("warning", onWarning);
	});
	return warnings;
}

/**
 * A database and a raw connection to it. The database clock stands still for the test, so a ticket's age is whatever
 * the test sets: neither a loaded runner nor a step of the system clock can age a live ticket into a stale one.
 */
async function fixture() {
	const clock = freezeDatabaseClock(Math.floor(databaseNow() / 1000) * 1000);
	cleanups.push(() => clock.restore());
	const directory = makeTempDirectory("atomic-writer-queue-degraded-");
	const path = join(directory, "queue.sqlite");
	const database = await openNodeSqliteDatabase(path);
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const holder = new DatabaseSync(path);
	const warnings = degradationWarnings(path);
	cleanups.push(async () => {
		if (holder.isTransaction) holder.exec("ROLLBACK");
		holder.close();
		await releaseWaiters(`${path}-writers`);
		await database.close();
		removeTempDirectory(directory);
	});
	return { path, database, holder, warnings, writers: `${path}-writers` };
}

/**
 * Tells every writer still queued that the lock is free, as a releasing writer would. A raw holder's rollback
 * announces nothing, so a writer left waiting by a failed assertion, its fake timers already gone, would otherwise
 * keep the database from closing.
 */
async function releaseWaiters(writers: string): Promise<void> {
	const notices = wakes(writers);
	for (let attempt = 0; attempt < 100 && fs.existsSync(notices) && actual.readdirSync(notices).length > 0; attempt++) {
		for (const name of actual.readdirSync(notices)) {
			try {
				const now = new Date();
				actual.utimesSync(join(notices, name), now, now);
			} catch (error) {
				// A notice its writer is removing: gone, or on Windows going while another process still has it open.
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && !(code === "EPERM" && process.platform === "win32")) throw error;
			}
		}
		await turn();
	}
}

async function turn(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

async function untilWaiting(): Promise<void> {
	while (vi.getTimerCount() === 0) await turn();
}

test("a writer that cannot watch its release notice polls for the lock and reports the fallback once (#4316)", async () => {
	const { database, holder, warnings } = await fixture();
	watch.mockImplementation(() => {
		throw Object.assign(new Error("ENOSPC: System limit for number of file watchers reached"), { code: "ENOSPC" });
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	for (const value of ["first", "second"]) {
		holder.exec("BEGIN IMMEDIATE");
		const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value));
		await untilWaiting();
		holder.exec("COMMIT");
		await vi.advanceTimersByTimeAsync(20);
		await write;
	}
	await turn();
	const [degraded, ...more] = warnings;
	assert.ok(degraded, "the fallback was reported");
	assert.deepEqual(more, [], "once per connection");
	assert.equal(degraded.reason, "watch-unavailable");
	assert.equal(degraded.code, "writer-queue-degraded");
	assert.equal((degraded.cause as NodeJS.ErrnoException).code, "ENOSPC");
	assert.deepEqual(
		(await database.all<{ value: string }>("SELECT value FROM items")).map((row) => row.value),
		["first", "second"],
	);
});

test("a watch that fails while the writer waits leaves it polling instead (#4316)", async () => {
	const { database, holder, warnings } = await fixture();
	watch.mockImplementation(((path: fs.PathLike, listener: fs.WatchListener<string>) => {
		const watcher = actual.watch(path, listener);
		setImmediate(() => watcher.emit("error", Object.assign(new Error("EPERM"), { code: "EPERM" })));
		return watcher;
	}) as typeof fs.watch);
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('after error')"));
	await untilWaiting();
	while (warnings.length === 0) await turn();
	// The wait in progress still ends at its 250 ms recheck; from then on the writer retries every 20 ms.
	await vi.advanceTimersByTimeAsync(250);
	holder.exec("COMMIT");
	await vi.advanceTimersByTimeAsync(20);
	await write;
	assert.equal(warnings[0]!.reason, "watch-unavailable");
});

test("a writer keeps one watch on its release notice for its whole wait and closes it once it holds the lock (#4316)", async () => {
	const { database, holder, writers } = await fixture();
	let watches = 0;
	let closes = 0;
	watch.mockImplementation(((path: fs.PathLike, listener: fs.WatchListener<string>) => {
		watches += 1;
		const watcher = actual.watch(path, listener);
		const close = watcher.close.bind(watcher);
		watcher.close = () => {
			closes += 1;
			close();
		};
		return watcher;
	}) as typeof fs.watch);
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('one watch')"));
	await untilWaiting();
	// Four rechecks and two refreshes of the ticket.
	await vi.advanceTimersByTimeAsync(1_000);
	assert.equal(watches, 1);
	assert.equal(closes, 0);
	holder.exec("COMMIT");
	const [name] = fs.readdirSync(writers);
	const time = new Date();
	actual.utimesSync(join(wakes(writers), name!), time, time);
	await write;
	assert.deepEqual([watches, closes], [1, 1]);
	assert.deepEqual(fs.readdirSync(wakes(writers)), [], "its release notice left with it");
});

test("connections without a writers' queue report no fallback when they let go of the lock (#4316)", async () => {
	const memory = await openNodeSqliteDatabase(":memory:");
	const warnings = degradationWarnings(memory.descriptor.location);
	await memory.transaction((tx) => tx.exec("CREATE TABLE items (value TEXT)"));
	assert.deepEqual(getWriterQueueDegradation(memory), []);
	await memory.close();
	await turn();
	assert.deepEqual(warnings, []);
});

test("a writer that cannot hand the turn on still commits, and reports the fallback once (#4316)", async () => {
	const { database, warnings, writers } = await fixture();
	let ticket = "";
	utimesSync.mockImplementation(((path: fs.PathLike, atime: fs.TimeLike, mtime: fs.TimeLike) => {
		if (ticket !== "" && basename(String(path)) === ticket)
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		actual.utimesSync(path, atime, mtime);
	}) as typeof fs.utimesSync);
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('committed')");
		ticket = liveTicket(writers, 999_999_984);
	});
	await turn();
	const [degraded, ...more] = warnings;
	assert.ok(degraded, "the fallback was reported");
	assert.equal(degraded.reason, "wake-failed");
	assert.equal((degraded.cause as NodeJS.ErrnoException).code, "EACCES");
	assert.deepEqual(more, []);
	assert.deepEqual(await database.all("SELECT value FROM items"), [{ value: "committed" }]);
});

test("a releasing writer whose oldest waiter left as it looked hands the turn to the next one, and reports nothing (#4316)", async () => {
	const { database, warnings, writers } = await fixture();
	let gone = "";
	let next = "";
	let mtimeMs = 0;
	utimesSync.mockImplementation(((path: fs.PathLike, atime: fs.TimeLike, mtime: fs.TimeLike) => {
		if (gone !== "" && basename(String(path)) === gone)
			throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
		actual.utimesSync(path, atime, mtime);
	}) as typeof fs.utimesSync);
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('handed on')");
		gone = liveTicket(writers, 999_999_985);
		next = liveTicket(writers, 999_999_986, 1);
		const old = new Date(databaseNow() - 1_000);
		for (const name of [gone, next]) actual.utimesSync(join(writers, name), old, old);
		mtimeMs = actual.statSync(join(writers, next)).mtimeMs;
	});
	await turn();
	assert.ok(noticeTouched(writers, next), "the next notice was touched");
	assert.equal(actual.statSync(join(writers, next)).mtimeMs, mtimeMs, "and its ticket left with its owner's liveness");
	assert.deepEqual(warnings, []);
});

test("a waiting writer that cannot refresh its own ticket fails the transaction as an unusable writers' queue (#4316)", async () => {
	const { database, holder, writers } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const failure = database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('never')"))
		.then(
			() => assert.fail("wrote under a held lock"),
			(error: unknown) => error,
		);
	await untilWaiting();
	utimes.mockImplementation((async (path: fs.PathLike) => {
		if (String(path).startsWith(writers))
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
	}) as typeof fsPromises.utimes);
	// Each recheck reads the queue off the event loop; the refresh is due at the second.
	await vi.advanceTimersByTimeAsync(250);
	await untilWaiting();
	await vi.advanceTimersByTimeAsync(250);
	const error = await failure;
	assert.ok(isStorageWriterQueueUnusableError(error), String(error));
	assert.equal(error.code, "writer-queue-unusable");
	assert.equal(error.errno, "EACCES");
	assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
});

test("a release that cannot list the queue still commits and reports one wake-failed fallback (#4316)", async () => {
	const { database, warnings, writers } = await fixture();
	for (const value of ["first", "second"]) {
		await database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES (?)", value);
			fs.mkdirSync(writers, { recursive: true });
			failListing(writers, "EMFILE");
		});
		readdirSync.mockImplementation(actual.readdirSync);
	}
	await turn();
	const [degraded, ...more] = warnings;
	assert.ok(degraded, "the failed handoff was reported");
	assert.deepEqual(more, [], "once per connection");
	assert.equal(degraded.reason, "wake-failed");
	assert.equal((degraded.cause as NodeJS.ErrnoException).code, "EMFILE");
	assert.deepEqual(
		(await database.all<{ value: string }>("SELECT value FROM items")).map((row) => row.value),
		["first", "second"],
	);
});

test("a release that cannot read the queue's entries reports the wake-failed fallback with that cause (#4316)", async () => {
	const { database, warnings, writers } = await fixture();
	let waiting = "";
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('committed')");
		waiting = liveTicket(writers, 999_999_971);
		failTicketStat(writers, "EACCES");
	});
	statSync.mockImplementation(actual.statSync);
	fs.unlinkSync(join(writers, waiting));
	await turn();
	const [degraded] = warnings;
	assert.ok(degraded, "the failed handoff was reported");
	assert.equal(degraded.reason, "wake-failed");
	assert.equal((degraded.cause as NodeJS.ErrnoException).code, "EACCES");
	assert.deepEqual(await database.all("SELECT value FROM items"), [{ value: "committed" }]);
});

test("a waiting writer that cannot list the queue fails as an unusable writers' queue, keeping the cause (#4316)", async () => {
	const { database, holder, path, writers } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const failed = database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('never')"))
		.then(
			() => assert.fail("wrote under a held lock"),
			(error: unknown) => error,
		);
	await untilWaiting();
	failListingOffLoop(writers, "EACCES");
	await vi.advanceTimersByTimeAsync(250);
	const error = await failed;
	assert.ok(isStorageWriterQueueUnusableError(error), String(error));
	assert.deepEqual(
		[error.code, error.errno, error.adapter, error.location],
		["writer-queue-unusable", "EACCES", "node-sqlite", path],
	);
	assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
});

test("getWriterQueueStats on a queue it cannot read throws a typed writer-queue-unusable error instead of counting nobody (#4316)", async () => {
	const { database, path, writers } = await fixture();
	liveTicket(writers, 999_999_972);
	for (const fail of [() => failListing(writers, "EACCES"), () => failTicketStat(writers, "EACCES")]) {
		fail();
		const error = (() => {
			try {
				getWriterQueueStats(database);
			} catch (cause) {
				return cause;
			}
			return assert.fail("reported stats for a queue it cannot read");
		})();
		assert.ok(isStorageWriterQueueUnusableError(error), String(error));
		assert.deepEqual([error.code, error.errno, error.location], ["writer-queue-unusable", "EACCES", path]);
		assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
		readdirSync.mockImplementation(actual.readdirSync);
		statSync.mockImplementation(actual.statSync);
	}
	assert.equal(getWriterQueueStats(database).waiters, 1);
});

test("a queue directory or ticket that vanishes while it is read counts as absent, with no warning or failure (#4316)", async () => {
	const { database, warnings, writers } = await fixture();
	fs.mkdirSync(writers, { recursive: true });
	failListing(writers, "ENOENT");
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('directory gone')"));
	assert.equal(getWriterQueueStats(database).waiters, 0);
	readdirSync.mockImplementation(actual.readdirSync);
	const gone = liveTicket(writers, 999_999_973);
	liveTicket(writers, 999_999_974, 1);
	failTicketStat(writers, "ENOENT", [gone]);
	assert.equal(getWriterQueueStats(database).waiters, 1);
	await turn();
	assert.deepEqual(warnings, []);
});

test("on Windows a ticket deleted while another process holds it open (EPERM) counts as gone, elsewhere EPERM is a failure (#4316)", async () => {
	const { database, writers } = await fixture();
	const going = liveTicket(writers, 999_999_975);
	liveTicket(writers, 999_999_976, 1);
	failTicketStat(writers, "EPERM", [going]);
	platform.mockReturnValue("win32");
	assert.equal(getWriterQueueStats(database).waiters, 1);
	failTicketStat(writers, "EACCES", [going]);
	assert.throws(
		() => getWriterQueueStats(database),
		(error: Error) => (error.cause as NodeJS.ErrnoException).code === "EACCES",
		"only EPERM means a deleted ticket on Windows",
	);
	failTicketStat(writers, "EPERM", [going]);
	platform.mockReturnValue("linux");
	assert.throws(
		() => getWriterQueueStats(database),
		(error: Error) => isStorageWriterQueueUnusableError(error) && error.errno === "EPERM",
	);
	statSync.mockImplementation(actual.statSync);
	for (const name of fs.readdirSync(writers)) fs.unlinkSync(join(writers, name));
});

test("on Windows a release passes over a ticket deleted while another process holds it open (#4316)", async () => {
	const { database, warnings, writers } = await fixture();
	let going = "";
	let next = "";
	let mtimeMs = 0;
	utimesSync.mockImplementation(((path: fs.PathLike, atime: fs.TimeLike, mtime: fs.TimeLike) => {
		if (going !== "" && basename(String(path)) === going) throw failure("EPERM");
		actual.utimesSync(path, atime, mtime);
	}) as typeof fs.utimesSync);
	platform.mockReturnValue("win32");
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('handed past a deleted ticket')");
		going = liveTicket(writers, 999_999_977);
		next = liveTicket(writers, 999_999_978, 1);
		const old = new Date(databaseNow() - 1_000);
		actual.utimesSync(join(writers, next), old, old);
		mtimeMs = actual.statSync(join(writers, next)).mtimeMs;
	});
	assert.ok(noticeTouched(writers, next), "the notice after it was touched");
	assert.equal(actual.statSync(join(writers, next)).mtimeMs, mtimeMs, "its ticket kept its owner's liveness");
	await turn();
	assert.deepEqual(warnings, []);
});

test("a release wakes the oldest live ticket whatever order the directory lists them in (#4316)", async () => {
	const { database, writers } = await fixture();
	const listing = (path: fs.PathLike): string[] => {
		const names = actual.readdirSync(path);
		return String(path) === writers ? names.reverse() : names;
	};
	readdirSync.mockImplementation(listing as typeof fs.readdirSync);
	let oldest = "";
	let later = "";
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('listed backwards')");
		oldest = liveTicket(writers, 999_999_979);
		later = liveTicket(writers, 999_999_980, 1);
		utimesSync.mockClear();
	});
	assert.deepEqual(
		utimesSync.mock.calls.map(([path]) => String(path)),
		[join(wakes(writers), oldest)],
		"the release touched the oldest ticket's notice, and nothing else",
	);
	assert.deepEqual(
		[noticeTouched(writers, oldest), noticeTouched(writers, later)],
		[true, false],
		"the oldest was woken, not the one listed first",
	);
});

test("a writer that cannot watch its release notice leaves the degradation readable on the handle where warnings are suppressed (#4316)", async () => {
	const { database, holder, path, warnings } = await fixture();
	suppressWarnings();
	watch.mockImplementation(() => {
		throw failure("ENOSPC");
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	let recorded: StorageWriterQueueDegradedError | undefined;
	for (const value of ["first", "second"]) {
		holder.exec("BEGIN IMMEDIATE");
		const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value));
		await untilWaiting();
		holder.exec("COMMIT");
		await vi.advanceTimersByTimeAsync(20);
		await write;
		const [degraded, ...more] = getWriterQueueDegradation(database);
		assert.ok(degraded && isStorageWriterQueueDegradedError(degraded), "recorded on the handle");
		assert.deepEqual(more, []);
		recorded ??= degraded;
		assert.equal(degraded, recorded, "the first record is kept, not replaced");
	}
	assert.ok(recorded, "the fallback was recorded");
	assert.deepEqual(
		[recorded.code, recorded.reason, recorded.adapter, recorded.location, (recorded.cause as { code?: string }).code],
		["writer-queue-degraded", "watch-unavailable", "node-sqlite", path, "ENOSPC"],
	);
	await turn();
	assert.deepEqual(warnings, [], "no warning reached the process: the record does not depend on one");
	assert.deepEqual(
		(await database.all<{ value: string }>("SELECT value FROM items")).map((row) => row.value),
		["first", "second"],
	);
});

test("a release that cannot notify the next writer leaves the degradation readable on the handle where warnings are suppressed (#4316)", async () => {
	const { database, path, warnings, writers } = await fixture();
	suppressWarnings();
	for (const code of ["EMFILE", "EACCES"]) {
		await database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES (?)", code);
			fs.mkdirSync(writers, { recursive: true });
			failListing(writers, code);
		});
		readdirSync.mockImplementation(actual.readdirSync);
	}
	const [degraded, ...more] = getWriterQueueDegradation(database);
	assert.ok(degraded && isStorageWriterQueueDegradedError(degraded));
	assert.deepEqual(more, []);
	assert.deepEqual(
		[degraded.reason, degraded.adapter, degraded.location, (degraded.cause as { code?: string }).code],
		["wake-failed", "node-sqlite", path, "EMFILE"],
		"the second failure did not replace the first",
	);
	await turn();
	assert.deepEqual(warnings, []);
	assert.equal(
		((await database.all("SELECT value FROM items")) as unknown[]).length,
		2,
		"both transactions committed",
	);
});

test("an abandoned ticket that cannot be removed is recorded once and never fails a transaction (#4316)", async () => {
	const { database, path, warnings, writers } = await fixture();
	suppressWarnings();
	const abandoned = abandonedTicket(writers, 999_999_961);
	failUnlink(writers, "EACCES");
	for (const value of ["first", "second"])
		await database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value));
	assert.equal(getWriterQueueStats(database).waiters, 0, "the abandoned ticket is ignored");
	const [degraded, ...more] = getWriterQueueDegradation(database);
	assert.ok(degraded && isStorageWriterQueueDegradedError(degraded));
	assert.deepEqual(more, []);
	assert.deepEqual(
		[degraded.code, degraded.reason, degraded.adapter, degraded.location, (degraded.cause as { code?: string }).code],
		["writer-queue-degraded", "stale-ticket-kept", "node-sqlite", path, "EACCES"],
	);
	assert.match(degraded.hint, /remove abandoned entries by hand/);
	assert.ok(fs.existsSync(join(writers, abandoned)), "it stays where it is");
	await turn();
	assert.deepEqual(warnings, []);
});

test("an abandoned ticket that another writer removed first, or that is going, records nothing (#4316)", async () => {
	const { database, warnings, writers } = await fixture();
	const racing = abandonedTicket(writers, 999_999_962);
	failUnlink(writers, "ENOENT");
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('raced')"));
	assert.ok(fs.existsSync(join(writers, racing)), "the failed removal left it, as the race would have removed it");
	failUnlink(writers, "EPERM");
	platform.mockReturnValue("win32");
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('deleted while open')"));
	assert.deepEqual(getWriterQueueDegradation(database), []);
	platform.mockReturnValue("linux");
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('elsewhere')"));
	const [degraded] = getWriterQueueDegradation(database);
	assert.equal(degraded?.reason, "stale-ticket-kept", "EPERM is a failure to remove anywhere but Windows");
	await turn();
	assert.equal(warnings.length, 1);
});

test("each degradation is recorded once, in the order it first happened, and emitted once as a process warning (#4316)", async () => {
	const { database, warnings, writers } = await fixture();
	abandonedTicket(writers, 999_999_963);
	failUnlink(writers, "EACCES");
	for (let round = 0; round < 2; round++) getWriterQueueStats(database);
	for (let round = 0; round < 2; round++) {
		await database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES (?)", String(round));
			failListing(writers, "EACCES");
		});
		readdirSync.mockImplementation(actual.readdirSync);
	}
	assert.deepEqual(
		getWriterQueueDegradation(database).map((degraded) => degraded.reason),
		["stale-ticket-kept", "wake-failed"],
	);
	await turn();
	assert.deepEqual(
		warnings.map((degraded) => degraded.reason),
		["stale-ticket-kept", "wake-failed"],
		"one warning per reason",
	);
});

test("a healthy file handle, an in-memory one and a wrapped one have no degradation, and a foreign one is unsupported (#4316)", async () => {
	const { database, path } = await fixture();
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('healthy')"));
	assert.deepEqual(getWriterQueueDegradation(database), []);
	const memory = await openNodeSqliteDatabase(":memory:");
	const connection = new DatabaseSync(path);
	const wrapped = wrapNodeSqliteDatabase(connection);
	cleanups.push(async () => {
		await memory.close();
		await wrapped.close();
		connection.close();
	});
	assert.deepEqual(getWriterQueueDegradation(memory), []);
	assert.deepEqual(getWriterQueueDegradation(wrapped), []);
	const foreign = { ...database, descriptor: { adapter: "custom", location: "remote://db" } };
	const error = (() => {
		try {
			getWriterQueueDegradation(foreign as typeof database);
		} catch (cause) {
			return cause;
		}
		return assert.fail("returned a degradation for another adapter");
	})();
	assert.ok(isStorageUnsupportedOperationError(error), String(error));
	assert.deepEqual(
		[error.code, error.operation, error.adapter, error.location],
		["unsupported-operation", "getWriterQueueDegradation", "custom", "remote://db"],
	);
});

test("a release does not roll back the refresh a waiting writer made between the release's read of the queue and its notice (#4316)", async () => {
	const { database, warnings, writers } = await fixture();
	let waiter = "";
	let refreshedMs = 0;
	let refreshes = 0;
	utimesSync.mockImplementation(((path: fs.PathLike, atime: fs.TimeLike, mtime: fs.TimeLike) => {
		if (waiter !== "" && basename(String(path)) === waiter && refreshes === 0) {
			refreshes += 1;
			const now = new Date(databaseNow());
			actual.utimesSync(join(writers, waiter), now, now);
			refreshedMs = actual.statSync(join(writers, waiter)).mtimeMs;
		}
		actual.utimesSync(path, atime, mtime);
	}) as typeof fs.utimesSync);
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('released mid-refresh')");
		waiter = liveTicket(writers, 999_999_959);
		const earlier = new Date(databaseNow() - 1_500);
		actual.utimesSync(join(writers, waiter), earlier, earlier);
	});
	await turn();
	assert.equal(refreshes, 1, "the release reached the waiter");
	assert.equal(actual.statSync(join(writers, waiter)).mtimeMs, refreshedMs, "its refresh was not rolled back");
	assert.ok(databaseNow() - refreshedMs < 1_000);
	assert.ok(noticeTouched(writers, waiter), "and its notice was sent");
	assert.equal(getWriterQueueStats(database).waiters, 1, "other writers still see it as live");
	assert.deepEqual(warnings, []);
});

test("removing an abandoned ticket removes its release notice with it, so no sidecar outlives its ticket (#4316)", async () => {
	const { database, writers } = await fixture();
	const abandoned = abandonedTicket(writers, 999_999_958);
	assert.ok(fs.existsSync(join(wakes(writers), abandoned)));
	assert.equal(getWriterQueueStats(database).waiters, 0);
	assert.equal(fs.existsSync(join(writers, abandoned)), false, "the ticket is removed");
	assert.equal(fs.existsSync(join(wakes(writers), abandoned)), false, "and its notice");
	assert.deepEqual(getWriterQueueDegradation(database), []);
});

test("an abandoned ticket whose notice cannot be removed stays for the next scan, recorded once, and never fails a transaction (#4316)", async () => {
	const { database, writers } = await fixture();
	suppressWarnings();
	const abandoned = abandonedTicket(writers, 999_999_957);
	unlinkSync.mockImplementation(((path: fs.PathLike) => {
		if (dirname(String(path)) === wakes(writers)) throw failure("EACCES");
		actual.unlinkSync(path);
	}) as typeof fs.unlinkSync);
	for (const value of ["first", "second"])
		await database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value));
	const [degraded, ...more] = getWriterQueueDegradation(database);
	assert.ok(degraded && isStorageWriterQueueDegradedError(degraded));
	assert.deepEqual(more, []);
	assert.equal(degraded.reason, "stale-ticket-kept");
	assert.ok(fs.existsSync(join(writers, abandoned)), "the ticket stays, so the removal is retried");
	assert.ok(fs.existsSync(join(wakes(writers), abandoned)));
	unlinkSync.mockImplementation(actual.unlinkSync);
	assert.equal(getWriterQueueStats(database).waiters, 0);
	assert.deepEqual(
		[fs.existsSync(join(writers, abandoned)), fs.existsSync(join(wakes(writers), abandoned))],
		[false, false],
		"the retry removed both",
	);
});

test("a writer that cannot create its release notice fails as an unusable writers' queue and leaves no ticket behind (#4316)", async () => {
	const { database, holder, writers } = await fixture();
	let attempts = 0;
	writeFile.mockImplementation((async (path: fs.PathLike, data: string, options?: fs.WriteFileOptions) => {
		if (dirname(String(path)) !== wakes(writers)) return actualPromises.writeFile(path, data, options);
		attempts += 1;
		throw failure("EACCES");
	}) as typeof fsPromises.writeFile);
	holder.exec("BEGIN IMMEDIATE");
	const error = await database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('never')"))
		.then(
			() => assert.fail("wrote under a held lock"),
			(cause: unknown) => cause,
		);
	assert.ok(isStorageWriterQueueUnusableError(error), String(error));
	assert.equal(error.errno, "EACCES");
	assert.equal(attempts, 1, "a notice it may not write is not tried again");
	assert.equal(fs.existsSync(writers), false, "its ticket did not stay to block the writers behind it");
});

test("a release passes over a live ticket that has no release notice to the next one, and reports nothing (#4316)", async () => {
	const { database, warnings, writers } = await fixture();
	let bare = "";
	let next = "";
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('handed past a bare ticket')");
		bare = liveTicket(writers, 999_999_955);
		fs.unlinkSync(join(wakes(writers), bare));
		next = liveTicket(writers, 999_999_956, 1);
	});
	await turn();
	assert.ok(noticeTouched(writers, next), "the next notice was touched");
	assert.equal(fs.existsSync(join(wakes(writers), bare)), false, "no notice was made for the bare ticket");
	assert.deepEqual(warnings, []);
});

test("an uncontended transaction does not list a queue directory that does not exist (#4316)", async () => {
	const { database, writers } = await fixture();
	const listed: string[] = [];
	readdirSync.mockImplementation(((path: fs.PathLike, options?: Parameters<typeof actual.readdirSync>[1]) => {
		if (String(path) === writers) listed.push(String(path));
		return actual.readdirSync(path, options as never);
	}) as typeof fs.readdirSync);
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('alone')"));
	assert.equal(fs.existsSync(writers), false);
	assert.deepEqual(listed, [], "no listing, not even a failed one");
});

test("in debug mode each writers'-queue degradation reaches the debug log once, without its message (#4360)", async () => {
	await withDebugLog("ATOMIC_DEBUG", async (log) => {
		const { database, path, writers } = await fixture();
		suppressWarnings();
		for (const code of ["EMFILE", "EACCES"]) {
			await database.transaction(async (tx) => {
				await tx.run("INSERT INTO items VALUES (?)", code);
				fs.mkdirSync(writers, { recursive: true });
				failListing(writers, code);
			});
			readdirSync.mockImplementation(actual.readdirSync);
		}
		abandonedTicket(writers, 999_999_963);
		unlinkSync.mockImplementation(((target: fs.PathLike) => {
			if (dirname(String(target)) === writers)
				throw Object.assign(new Error("removal refused for a secret reason"), { code: 13 });
			actual.unlinkSync(target);
		}) as typeof fs.unlinkSync);
		await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('kept')"));
		await vi.waitFor(() => assert.equal(areaRecords(log, "storage").length, 2), { timeout: DEBUG_RECORD_WAIT_MS });
		assert.deepEqual(areaRecords(log, "storage"), [
			{
				event: "writer-queue-degraded",
				data: {
					code: "writer-queue-degraded",
					reason: "wake-failed",
					adapter: "node-sqlite",
					location: path,
					errno: "EMFILE",
				},
			},
			{
				event: "writer-queue-degraded",
				data: {
					code: "writer-queue-degraded",
					reason: "stale-ticket-kept",
					adapter: "node-sqlite",
					location: path,
				},
			},
		]);
		assert.equal(JSON.stringify(log.records()).includes("secret reason"), false, "the cause's message stays out");
	});
});

test("with debug mode off a writers'-queue degradation writes no debug log (#4360)", async () => {
	await withDebugLog("off", async (log) => {
		const { database, writers } = await fixture();
		suppressWarnings();
		await database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('off')");
			fs.mkdirSync(writers, { recursive: true });
			failListing(writers, "EMFILE");
		});
		assert.equal(getWriterQueueDegradation(database).length, 1);
		for (let index = 0; index < 10; index++) await turn();
		assert.equal(log.exists(), false);
	});
});

test("debug output that cannot load is reported as a process warning, and the degradation is still recorded (#4360)", async () => {
	vi.resetModules();
	vi.doMock("../../packages/coding-agent/src/core/debug.js", () => {
		throw new Error("debug output unavailable");
	});
	try {
		const isolated = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
		const directory = makeTempDirectory("atomic-writer-queue-debug-unavailable-");
		const path = join(directory, "queue.sqlite");
		const database = await isolated.openNodeSqliteDatabase(path);
		cleanups.push(async () => {
			await database.close();
			removeTempDirectory(directory);
		});
		const warnings: unknown[] = [];
		const spy = vi.spyOn(process, "emitWarning").mockImplementation((warning) => {
			warnings.push(warning);
		});
		cleanups.push(() => spy.mockRestore());
		await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
		await database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('unavailable')");
			fs.mkdirSync(`${path}-writers`, { recursive: true });
			failListing(`${path}-writers`, "EMFILE");
		});
		readdirSync.mockImplementation(actual.readdirSync);
		await vi.waitFor(() => assert.equal(warnings.length, 2), { timeout: DEBUG_RECORD_WAIT_MS });
		assert.ok(isStorageWriterQueueDegradedError(warnings[0]), "the degradation itself, as before");
		assert.ok(
			warnings[1] instanceof Error && !isStorageWriterQueueDegradedError(warnings[1]),
			"then the load failure",
		);
		assert.equal(isolated.getWriterQueueDegradation(database).length, 1);
	} finally {
		vi.doUnmock("../../packages/coding-agent/src/core/debug.js");
	}
});

/** Makes removing the files in `directory` with `fs/promises`, as a writer removes its own entry, fail with `code`. */
function failOwnUnlink(directory: string, code: string): void {
	unlink.mockImplementation((async (file: fs.PathLike) => {
		if (dirname(String(file)) === directory) throw failure(code);
		return actualPromises.unlink(file);
	}) as typeof fsPromises.unlink);
}

test("a writer whose ticket cannot be written fails as an unusable writers' queue, and records the notice it could not take back (#4387)", async () => {
	const { database, holder, path, writers } = await fixture();
	suppressWarnings();
	writeFile.mockImplementation((async (file: fs.PathLike, data: string, options?: fs.WriteFileOptions) => {
		if (dirname(String(file)) === writers) throw failure("EACCES");
		return actualPromises.writeFile(file, data, options);
	}) as typeof fsPromises.writeFile);
	failOwnUnlink(wakes(writers), "EACCES");
	holder.exec("BEGIN IMMEDIATE");
	const error = await database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('never')"))
		.then(
			() => assert.fail("wrote under a held lock"),
			(cause: unknown) => cause,
		);
	assert.ok(isStorageWriterQueueUnusableError(error), String(error));
	assert.equal(error.errno, "EACCES");
	const [kept, ...more] = getWriterQueueDegradation(database);
	assert.deepEqual(more, []);
	assert.deepEqual(
		[kept?.reason, kept?.location, (kept?.cause as { code?: string } | undefined)?.code],
		["stale-ticket-kept", path, "EACCES"],
	);
	assert.equal(fs.existsSync(writers), false, "no ticket was written");
	assert.equal(fs.readdirSync(wakes(writers)).length, 1, "the notice it could not remove stays");
});

test("a writer whose own entry cannot be removed when it leaves still commits, and records the entry it kept (#4387)", async () => {
	const { database, holder, path, writers } = await fixture();
	suppressWarnings();
	failOwnUnlink(wakes(writers), "EACCES");
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('kept its entry')"));
	await untilWaiting();
	const [name] = fs.readdirSync(writers);
	holder.exec("COMMIT");
	const time = new Date();
	actual.utimesSync(join(wakes(writers), name!), time, time);
	await write;
	const [kept, ...more] = getWriterQueueDegradation(database);
	assert.deepEqual(more, []);
	assert.deepEqual(
		[kept?.reason, kept?.location, (kept?.cause as { code?: string } | undefined)?.code],
		["stale-ticket-kept", path, "EACCES"],
	);
	assert.deepEqual(await database.all("SELECT value FROM items"), [{ value: "kept its entry" }]);
	assert.deepEqual(
		[fs.existsSync(join(writers, name!)), fs.existsSync(join(wakes(writers), name!))],
		[true, true],
		"removal stopped at the notice, so the ticket did not outlive it",
	);
});

/** Reads the synchronous file calls made from now on that list, create or open `directory` or a file in it. */
function syncCallsOn(directory: string): () => string[] {
	const marks = [mkdirSync, openSync, readdirSync].map((spy) => spy.mock.calls.length);
	return () =>
		[mkdirSync, openSync, readdirSync].flatMap((spy, index) =>
			spy.mock.calls
				.slice(marks[index])
				.map(([path]) => String(path))
				.filter((path) => path === directory || dirname(path) === directory),
		);
}

test("a connection creates its write-lock record off the event loop as it opens, so taking the lock only writes it in place (#4387)", async () => {
	const { path } = await fixture();
	const holders = `${path}-holders`;
	const calls = syncCallsOn(holders);
	const database = await openNodeSqliteDatabase(path);
	cleanups.push(() => database.close());
	const opened = actual.readdirSync(holders);
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('first')"));
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('second')"));
	assert.deepEqual(calls(), [], "no synchronous call made, listed or opened a record");
	assert.deepEqual(actual.readdirSync(holders), opened, "the record was there before the lock was taken");
	const records = opened.map((name) => actual.readFileSync(join(holders, name), "utf8").slice(0, 4));
	assert.deepEqual(records.sort(), ["", "free"], "the fixture's untouched record, and this one's");
});

test("a write-lock record that cannot be created is left out, and the transaction still commits (#4387)", async () => {
	const { path } = await fixture();
	const holders = `${path}-holders`;
	const earlier = actual.readdirSync(holders);
	mkdir.mockImplementation((async (directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
		if (String(directory) === holders) throw failure("EACCES");
		return actualPromises.mkdir(directory, options);
	}) as typeof fsPromises.mkdir);
	suppressWarnings();
	const calls = syncCallsOn(holders);
	const database = await openNodeSqliteDatabase(path);
	cleanups.push(() => database.close());
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('unrecorded')"));
	assert.deepEqual(await database.all("SELECT value FROM items"), [{ value: "unrecorded" }]);
	assert.deepEqual(actual.readdirSync(holders), earlier, "no record");
	assert.deepEqual(calls(), [], "and no synchronous attempt to create one under the lock");
	assertHolderRecordUnavailable(database, path, "EACCES");
});

/** The connection recorded one degradation: it could not keep its write-lock record, failing with `code`. */
function assertHolderRecordUnavailable(database: SqliteDatabase, path: string, code: string): void {
	const [degradation, ...more] = getWriterQueueDegradation(database);
	assert.deepEqual(more, []);
	assert.deepEqual(
		[degradation?.reason, degradation?.location, (degradation?.cause as { code?: string } | undefined)?.code],
		["holder-record-unavailable", path, code],
	);
}

test("a connection that cannot remove an exited process's write-lock record still creates its own, and records why (#4387)", async () => {
	const { path } = await fixture();
	suppressWarnings();
	const holders = `${path}-holders`;
	const exited = join(holders, "999999999-1");
	actual.writeFileSync(exited, "");
	unlink.mockImplementation((async (file: fs.PathLike) => {
		if (String(file) === exited) throw failure("EACCES");
		return actualPromises.unlink(file);
	}) as typeof fsPromises.unlink);
	const earlier = actual.readdirSync(holders);
	const database = await openNodeSqliteDatabase(path);
	cleanups.push(() => database.close());
	assert.equal(actual.readdirSync(holders).filter((name) => !earlier.includes(name)).length, 1, "its own record");
	assert.ok(actual.existsSync(exited), "the record it could not remove stays");
	assertHolderRecordUnavailable(database, path, "EACCES");
});

test("an exited process's write-lock record another connection removes first is not a failure (#4387)", async () => {
	const { path } = await fixture();
	const exited = join(`${path}-holders`, "999999999-1");
	actual.writeFileSync(exited, "");
	unlink.mockImplementation((async (file: fs.PathLike) => {
		if (String(file) !== exited) return actualPromises.unlink(file);
		await actualPromises.unlink(file);
		throw failure("ENOENT");
	}) as typeof fsPromises.unlink);
	const database = await openNodeSqliteDatabase(path);
	cleanups.push(() => database.close());
	assert.equal(actual.existsSync(exited), false);
	assert.deepEqual(getWriterQueueDegradation(database), []);
});

test("a write-lock record that cannot be written is removed and left out, and transactions still commit (#4387)", async () => {
	const { database, path } = await fixture();
	suppressWarnings();
	let attempts = 0;
	writeSync.mockImplementation(((descriptor: number, data: string, ...rest: never[]) => {
		if (typeof data !== "string" || !/^(held|free) /.test(data)) return actual.writeSync(descriptor, data, ...rest);
		attempts += 1;
		throw failure("EIO");
	}) as typeof fs.writeSync);
	for (const value of ["first", "second"])
		await database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value));
	assert.deepEqual(await database.all("SELECT value FROM items"), [{ value: "first" }, { value: "second" }]);
	assert.equal(attempts, 1, "a record it could not write is not written again");
	assert.deepEqual(actual.readdirSync(`${path}-holders`), [], "and does not stay to name a holder");
	assertHolderRecordUnavailable(database, path, "EIO");
});

/**
 * Makes the first write of a release notice find its directory missing although another writer makes it at that
 * moment, with `existing` written under the notice's name first when given.
 */
function raceNoticeDirectory(writers: string, existing?: string): void {
	let raced = false;
	writeFile.mockImplementation((async (file: fs.PathLike, data: string, options?: fs.WriteFileOptions) => {
		if (raced || dirname(String(file)) !== wakes(writers)) return actualPromises.writeFile(file, data, options);
		raced = true;
		actual.mkdirSync(wakes(writers), { recursive: true });
		if (existing !== undefined) actual.writeFileSync(String(file), existing);
		throw failure("ENOENT");
	}) as typeof fsPromises.writeFile);
}

test("a writer whose missing queue directory another writer makes as it joins still joins and commits (#4387)", async () => {
	const { database, holder, writers } = await fixture();
	raceNoticeDirectory(writers);
	holder.exec("BEGIN IMMEDIATE");
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('joined')"));
	while (!fs.existsSync(writers) || actual.readdirSync(writers).length === 0) await turn();
	holder.exec("COMMIT");
	await releaseWaiters(writers);
	await write;
	assert.deepEqual(await database.all("SELECT value FROM items"), [{ value: "joined" }]);
});

test("a writer that makes its missing queue directory still never writes over a file named like its entry (#4387)", async () => {
	const { database, holder, writers } = await fixture();
	raceNoticeDirectory(writers, "another writer's notice");
	holder.exec("BEGIN IMMEDIATE");
	const error = await database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('never')"))
		.then(
			() => assert.fail("wrote under a held lock"),
			(cause: unknown) => cause,
		);
	assert.ok(isStorageWriterQueueUnusableError(error), String(error));
	assert.equal(error.errno, "EEXIST");
	const [notice, ...more] = actual.readdirSync(wakes(writers));
	assert.deepEqual(more, []);
	assert.equal(actual.readFileSync(join(wakes(writers), notice!), "utf8"), "another writer's notice");
});

test("a writer waiting for the lock reads and refreshes the queue off the event loop, with no synchronous queue file call (#4387)", async () => {
	const { database, holder, path, writers } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('waited')"));
	await untilWaiting();
	const directories = [writers, wakes(writers), `${path}-holders`];
	const synchronous = [existsSync, readdirSync, statSync, utimesSync, unlinkSync, mkdirSync, openSync, writeSync];
	const marks = synchronous.map((spy) => spy.mock.calls.length);
	const [watches, listings, refreshes, removals, reads] = [watch, readdir, utimes, unlink, stat].map(
		(spy) => spy.mock.calls.length,
	);
	const [own] = actual.readdirSync(writers);
	for (let waited = 0; waited < 1_000; waited += 250) {
		await vi.advanceTimersByTimeAsync(250);
		await untilWaiting();
	}
	const calls = synchronous.flatMap((spy, index) =>
		spy.mock.calls
			.slice(marks[index])
			.map(([file]) => String(file))
			.filter((file) => directories.some((directory) => file === directory || dirname(file) === directory)),
	);
	assert.deepEqual(calls, [], "no synchronous call listed, read, refreshed, made or removed a queue file");
	assert.equal(watch.mock.calls.length, watches, "the watch it started stays");
	assert.equal(readdir.mock.calls.length - listings!, 4, "it read the queue at every recheck");
	assert.equal(utimes.mock.calls.length - refreshes!, 2, "and refreshed its ticket every 500 ms");
	assert.equal(unlink.mock.calls.length - removals!, 0, "nothing abandoned, so nothing removed");
	const ownReads = stat.mock.calls.slice(reads).filter(([file]) => String(file) === join(writers, own!));
	assert.deepEqual(ownReads, [], "and never read its own ticket's time to see who is ahead");
	holder.exec("COMMIT");
	await releaseWaiters(writers);
	await write;
});

/** Captures the listener the adapter gives each watch it starts, so a test can deliver a release notice itself. */
function captureNoticeListeners(): (() => void)[] {
	const listeners: (() => void)[] = [];
	watch.mockImplementation(((file: fs.PathLike, listener: () => void) => {
		listeners.push(listener);
		return actual.watch(file, listener);
	}) as typeof fs.watch);
	return listeners;
}

/** Holds the waiting writer's next read of `path`'s time until `answer` resolves, then answers with `answered`. */
function holdTicketRead(path: string, answered: fs.Stats, answer: Promise<void>): void {
	stat.mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
		if (String(file) !== path) return actualPromises.stat(file, options);
		await answer;
		return answered;
	}) as typeof fsPromises.stat);
}

test("a release notice that arrives while a waiting writer reads the queue ends its next wait at once (#4387)", async () => {
	const { database, holder, writers } = await fixture();
	const listeners = captureNoticeListeners();
	const ahead = liveTicket(writers, 999_999_961, -1);
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	let written = false;
	const write = database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('handed on')"))
		.then(() => {
			written = true;
		});
	await untilWaiting();
	assert.equal(listeners.length, 1);
	// Its next look at the ticket ahead is answered only after the release, and as it was before: still live.
	const aheadPath = join(writers, ahead);
	const answer = Promise.withResolvers<void>();
	holdTicketRead(aheadPath, await actualPromises.stat(aheadPath), answer.promise);
	await vi.advanceTimersByTimeAsync(250);
	while (!stat.mock.calls.some(([file]) => String(file) === aheadPath)) await turn();
	// The writer ahead took the lock in turn and left; its release reaches this writer while it reads.
	holder.exec("COMMIT");
	actual.unlinkSync(join(wakes(writers), ahead));
	actual.unlinkSync(aheadPath);
	listeners[0]!();
	answer.resolve();
	while (!written && vi.getTimerCount() === 0) await turn();
	assert.equal(written, true, "it took the lock instead of waiting out its recheck timer");
	await write;
	assert.deepEqual(await database.all("SELECT value FROM items"), [{ value: "handed on" }]);
});

test("a ticket that vanishes while a waiting writer reads the queue counts as gone (#4387)", async () => {
	const { database, holder, writers } = await fixture();
	const ahead = liveTicket(writers, 999_999_962, -1);
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('after a vanished ticket')"));
	await untilWaiting();
	holder.exec("COMMIT");
	const aheadPath = join(writers, ahead);
	stat.mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
		if (String(file) === aheadPath) throw failure("ENOENT");
		return actualPromises.stat(file, options);
	}) as typeof fsPromises.stat);
	await vi.advanceTimersByTimeAsync(250);
	await write;
	assert.deepEqual(await database.all("SELECT value FROM items"), [{ value: "after a vanished ticket" }]);
	assert.ok(actual.existsSync(aheadPath), "a ticket it only failed to find is left alone");
});

test("a waiting writer that cannot read a ticket's time fails as an unusable writers' queue, keeping the cause (#4387)", async () => {
	const { database, holder, path, writers } = await fixture();
	const ahead = liveTicket(writers, 999_999_963, -1);
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const failed = database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('never')"))
		.then(
			() => assert.fail("wrote under a held lock"),
			(error: unknown) => error,
		);
	await untilWaiting();
	stat.mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
		if (String(file) === join(writers, ahead)) throw failure("EACCES");
		return actualPromises.stat(file, options);
	}) as typeof fsPromises.stat);
	await vi.advanceTimersByTimeAsync(250);
	const error = await failed;
	assert.ok(isStorageWriterQueueUnusableError(error), String(error));
	assert.deepEqual([error.errno, error.location], ["EACCES", path]);
	assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
});
