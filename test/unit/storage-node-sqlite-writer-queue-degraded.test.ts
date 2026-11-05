import assert from "node:assert/strict";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import {
	isStorageUnsupportedOperationError,
	isStorageWriterQueueDegradedError,
	isStorageWriterQueueUnusableError,
	type StorageWriterQueueDegradedError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		watch: vi.fn(actual.watch),
		utimesSync: vi.fn(actual.utimesSync),
		readdirSync: vi.fn(actual.readdirSync),
		statSync: vi.fn(actual.statSync),
		unlinkSync: vi.fn(actual.unlinkSync),
	};
});

// The setup files already loaded the adapter with the real node:fs; load a copy that imports the mocked one.
vi.resetModules();
const { getWriterQueueDegradation, getWriterQueueStats, openNodeSqliteDatabase, wrapNodeSqliteDatabase } = await import(
	"../../packages/coding-agent/src/core/storage/node-sqlite.js"
);
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const watch = vi.mocked(fs.watch);
const utimesSync = vi.mocked(fs.utimesSync);
const readdirSync = vi.mocked(fs.readdirSync);
const statSync = vi.mocked(fs.statSync);
const unlinkSync = vi.mocked(fs.unlinkSync);

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	vi.useRealTimers();
	watch.mockImplementation(actual.watch);
	utimesSync.mockImplementation(actual.utimesSync);
	readdirSync.mockImplementation(actual.readdirSync);
	statSync.mockImplementation(actual.statSync);
	unlinkSync.mockImplementation(actual.unlinkSync);
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
	const old = new Date(Date.now() - 30_000);
	actual.utimesSync(join(writers, name), old, old);
	return name;
}

/** What Atomic's own entry points do before anything else loads: process warnings go nowhere. */
function suppressWarnings(): void {
	const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	cleanups.push(() => spy.mockRestore());
}

function liveTicket(writers: string, pid: number, offsetMs = 0): string {
	fs.mkdirSync(writers, { recursive: true });
	const name = `${String(Date.now() + offsetMs).padStart(15, "0")}-${pid}-1`;
	fs.writeFileSync(join(writers, name), "");
	return name;
}

/** Runs the test body as if on Windows, where a deleted file still held open reads as EPERM. */
async function onWindows(body: () => Promise<void>): Promise<void> {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	try {
		await body();
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
}

async function fixture() {
	const directory = makeTempDirectory("atomic-writer-queue-degraded-");
	const path = join(directory, "queue.sqlite");
	const database = await openNodeSqliteDatabase(path);
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const holder = new DatabaseSync(path);
	const warnings: Error[] = [];
	const onWarning = (warning: Error) => warnings.push(warning);
	process.on("warning", onWarning);
	cleanups.push(async () => {
		process.off("warning", onWarning);
		if (holder.isTransaction) holder.exec("ROLLBACK");
		holder.close();
		await database.close();
		removeTempDirectory(directory);
	});
	return { path, database, holder, warnings, writers: `${path}-writers` };
}

async function turn(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

async function untilWaiting(): Promise<void> {
	while (vi.getTimerCount() === 0) await turn();
}

function degradations(warnings: readonly Error[]): StorageWriterQueueDegradedError[] {
	return warnings.filter((warning) => isStorageWriterQueueDegradedError(warning));
}

test("a writer that cannot watch its ticket polls for the lock and reports the fallback once", async () => {
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
	const [degraded, ...more] = degradations(warnings);
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

test("a watch that fails while the writer waits leaves it polling instead", async () => {
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
	while (degradations(warnings).length === 0) await turn();
	// The wait in progress still ends at its 250 ms recheck; from then on the writer retries every 20 ms.
	await vi.advanceTimersByTimeAsync(250);
	holder.exec("COMMIT");
	await vi.advanceTimersByTimeAsync(20);
	await write;
	assert.equal(degradations(warnings)[0]!.reason, "watch-unavailable");
});

test("a writer keeps one watch on its ticket for its whole wait and closes it once it holds the lock", async () => {
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
	actual.utimesSync(join(writers, name!), time, time);
	await write;
	assert.deepEqual([watches, closes], [1, 1]);
});

test("connections without a writers' queue report no fallback when they let go of the lock", async () => {
	const { warnings } = await fixture();
	const memory = await openNodeSqliteDatabase(":memory:");
	await memory.transaction((tx) => tx.exec("CREATE TABLE items (value TEXT)"));
	await memory.close();
	await turn();
	assert.deepEqual(degradations(warnings), []);
});

test("a writer that cannot hand the turn on still commits, and reports the fallback once", async () => {
	const { database, warnings, writers } = await fixture();
	let ticket = "";
	utimesSync.mockImplementation(((path: fs.PathLike, atime: fs.TimeLike, mtime: fs.TimeLike) => {
		if (String(path).endsWith(ticket)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		actual.utimesSync(path, atime, mtime);
	}) as typeof fs.utimesSync);
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('committed')");
		fs.mkdirSync(writers, { recursive: true });
		ticket = `${String(Date.now()).padStart(15, "0")}-999999984-1`;
		fs.writeFileSync(join(writers, ticket), "");
	});
	await turn();
	const [degraded, ...more] = degradations(warnings);
	assert.ok(degraded, "the fallback was reported");
	assert.equal(degraded.reason, "wake-failed");
	assert.equal((degraded.cause as NodeJS.ErrnoException).code, "EACCES");
	assert.deepEqual(more, []);
	assert.deepEqual(await database.all("SELECT value FROM items"), [{ value: "committed" }]);
});

test("a releasing writer whose oldest waiter left as it looked hands the turn to the next one, and reports nothing", async () => {
	const { database, warnings, writers } = await fixture();
	let gone = "";
	let next = "";
	let mtimeMs = 0;
	utimesSync.mockImplementation(((path: fs.PathLike, atime: fs.TimeLike, mtime: fs.TimeLike) => {
		if (gone !== "" && String(path).endsWith(gone))
			throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
		actual.utimesSync(path, atime, mtime);
	}) as typeof fs.utimesSync);
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('handed on')");
		fs.mkdirSync(writers, { recursive: true });
		const now = Date.now();
		gone = `${String(now).padStart(15, "0")}-999999985-1`;
		next = `${String(now + 1).padStart(15, "0")}-999999986-1`;
		for (const name of [gone, next]) {
			fs.writeFileSync(join(writers, name), "");
			const old = new Date(now - 1_000);
			actual.utimesSync(join(writers, name), old, old);
		}
		mtimeMs = actual.statSync(join(writers, next)).mtimeMs;
	});
	await turn();
	const touched = actual.statSync(join(writers, next));
	assert.ok(Date.now() - touched.atimeMs < 500, "the next ticket was touched");
	assert.equal(touched.mtimeMs, mtimeMs, "and left with the liveness its owner gave it");
	assert.deepEqual(degradations(warnings), []);
});

test("a waiting writer that cannot refresh its own ticket fails the transaction as an unusable writers' queue", async () => {
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
	utimesSync.mockImplementation(((path: fs.PathLike) => {
		if (String(path).startsWith(writers))
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
	}) as typeof fs.utimesSync);
	await vi.advanceTimersByTimeAsync(500);
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
	const [degraded, ...more] = degradations(warnings);
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
	const [degraded] = degradations(warnings);
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
	failListing(writers, "EACCES");
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
	assert.deepEqual(degradations(warnings), []);
});

test("on Windows a ticket deleted while another process holds it open (EPERM) counts as gone, elsewhere EPERM is a failure (#4316)", async () => {
	const { database, writers } = await fixture();
	const going = liveTicket(writers, 999_999_975);
	liveTicket(writers, 999_999_976, 1);
	failTicketStat(writers, "EPERM", [going]);
	await onWindows(async () => {
		assert.equal(getWriterQueueStats(database).waiters, 1);
		failTicketStat(writers, "EACCES", [going]);
		assert.throws(
			() => getWriterQueueStats(database),
			(error: Error) => (error.cause as NodeJS.ErrnoException).code === "EACCES",
			"only EPERM means a deleted ticket on Windows",
		);
		failTicketStat(writers, "EPERM", [going]);
	});
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
	await onWindows(async () => {
		await database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('handed past a deleted ticket')");
			going = liveTicket(writers, 999_999_977);
			next = liveTicket(writers, 999_999_978, 1);
			const old = new Date(Date.now() - 1_000);
			actual.utimesSync(join(writers, next), old, old);
			mtimeMs = actual.statSync(join(writers, next)).mtimeMs;
		});
	});
	const touched = actual.statSync(join(writers, next));
	assert.ok(Date.now() - touched.atimeMs < 500, "the ticket after it was touched");
	assert.equal(touched.mtimeMs, mtimeMs);
	await turn();
	assert.deepEqual(degradations(warnings), []);
});

test("a release wakes the oldest live ticket whatever order the directory lists them in (#4316)", async () => {
	const { database, writers } = await fixture();
	const listing = (path: fs.PathLike): string[] => {
		const names = actual.readdirSync(path);
		return String(path) === writers ? names.reverse() : names;
	};
	readdirSync.mockImplementation(listing as typeof fs.readdirSync);
	const events = new Map<string, number>();
	const watchers: fs.FSWatcher[] = [];
	let oldest = "";
	let later = "";
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('listed backwards')");
		oldest = liveTicket(writers, 999_999_979);
		later = liveTicket(writers, 999_999_980, 1);
		for (const name of [oldest, later]) {
			events.set(name, 0);
			watchers.push(actual.watch(join(writers, name), () => events.set(name, events.get(name)! + 1)));
		}
	});
	cleanups.push(() => {
		for (const watcher of watchers) watcher.close();
	});
	while (events.get(oldest) === 0 && events.get(later) === 0) await turn();
	for (let index = 0; index < 20; index++) await turn();
	assert.deepEqual(
		[events.get(oldest)! > 0, events.get(later)],
		[true, 0],
		"the oldest was woken, not the one listed first",
	);
});

test("a writer that cannot watch its ticket leaves the degradation readable on the handle where warnings are suppressed (#4316)", async () => {
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
	assert.match(degraded.hint, /remove them by hand/);
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
	await onWindows(async () => {
		await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('deleted while open')"));
	});
	assert.deepEqual(getWriterQueueDegradation(database), []);
	await onWindows(async () => {});
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('elsewhere')"));
	const [degraded] = getWriterQueueDegradation(database);
	assert.equal(degraded?.reason, "stale-ticket-kept", "EPERM is a failure to remove anywhere but Windows");
	await turn();
	assert.equal(degradations(warnings).length, 1);
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
		degradations(warnings).map((degraded) => degraded.reason),
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
