import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	switchToWriteAheadLog,
	switchToWriteAheadLogSync,
} from "../../packages/coding-agent/src/core/storage/write-ahead-log.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { holdSqliteWriteLock } from "../helpers/sqlite-lock-holder.js";

const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

/** A path for a new database file; another process creates it in the rollback journal and holds its write lock. */
function databasePath(): string {
	const directory = makeTempDirectory("atomic-wal-switch-");
	directories.push(directory);
	return join(directory, "store.sqlite");
}

test("opening a store another process is writing waits for its lock to switch the file to the write-ahead log (#4270)", async () => {
	const path = databasePath();
	const holder = await holdSqliteWriteLock(path);
	const opening = openNodeSqliteDatabase(path);
	let early: unknown;
	try {
		early = await Promise.race([
			opening.then(
				() => "opened",
				(error: unknown) => error,
			),
			sleep(500).then(() => "waiting"),
		]);
	} finally {
		await holder.release();
	}
	// The open must still be waiting for the other process's lock, not have failed with SQLITE_BUSY.
	assert.equal(early, "waiting");
	const database = await opening;
	try {
		assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
		// It switched the file after the other process committed, not instead of it.
		assert.equal(Number((await database.get("SELECT COUNT(*) AS count FROM held"))?.count), 1);
	} finally {
		await database.close();
	}
});

test("an open refused for longer than its busy timeout fails with SQLITE_BUSY once the timeout has passed (#4270)", async () => {
	const path = databasePath();
	const holder = await holdSqliteWriteLock(path);
	try {
		const started = Date.now();
		await assert.rejects(openNodeSqliteDatabase(path, { busyTimeoutMs: 300 }), (error: unknown) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal((error.cause as { errcode?: unknown }).errcode, 5);
			return true;
		});
		const waited = Date.now() - started;
		assert.ok(waited >= 300, `the open gave up after ${waited} ms, before its 300 ms busy timeout`);
	} finally {
		await holder.release();
	}
});

test("wrapping a connection to a file another process is writing waits for its lock to switch the file to the write-ahead log (#4270)", async () => {
	const path = databasePath();
	// The holder commits on its own: wrapping is synchronous and waits on this thread, as node:sqlite's busy timeout does.
	const holder = await holdSqliteWriteLock(path, 750);
	const connection = new DatabaseSync(path);
	try {
		const database = wrapNodeSqliteDatabase(connection);
		try {
			assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
			// It switched the file after the other process committed, not instead of it.
			assert.equal(Number((await database.get("SELECT COUNT(*) AS count FROM held"))?.count), 1);
		} finally {
			await database.close();
		}
	} finally {
		connection.close();
		await holder.release();
	}
});

const SQLITE_IOERR = 10;
const SQLITE_IOERR_TRUNCATE = 1546;
const SQLITE_BUSY = 5;
const TRUNCATE_CAP_MS = 5_000;

function sqliteFailure(fields: Record<string, unknown>): Error {
	return Object.assign(new Error("disk I/O error"), fields);
}

function failWalSwitches(failures: number, errcode = SQLITE_IOERR_TRUNCATE): () => number {
	let attempts = 0;
	const exec = DatabaseSync.prototype.exec;
	vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
		if (sql.startsWith("PRAGMA journal_mode")) {
			attempts += 1;
			if (attempts <= failures) throw sqliteFailure({ code: "ERR_SQLITE_ERROR", errcode, errstr: "disk I/O error" });
		}
		return exec.call(this, sql);
	});
	return () => attempts;
}

interface GaveUp {
	readonly attempts: number;
	readonly elapsedMs: number;
	readonly error: unknown;
}

async function giveUp(failure: unknown, busyTimeoutMs: number): Promise<GaveUp> {
	vi.useFakeTimers();
	const started = Date.now();
	let attempts = 0;
	let outcome: { readonly error: unknown } | undefined;
	void switchToWriteAheadLog(() => {
		attempts += 1;
		throw failure;
	}, busyTimeoutMs).then(
		() => assert.fail("the switch cannot succeed"),
		(error: unknown) => {
			outcome = { error };
		},
	);
	for (let turn = 0; outcome === undefined && turn < 2_000; turn++) await vi.runOnlyPendingTimersAsync();
	assert.ok(outcome !== undefined, "the switch gave up");
	const result = { attempts, elapsedMs: Date.now() - started, error: outcome.error };
	vi.useRealTimers();
	return result;
}

function giveUpSync(failure: unknown, busyTimeoutMs: number): GaveUp {
	vi.useFakeTimers();
	vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
		vi.setSystemTime(Date.now() + Number(timeout));
		return "timed-out";
	});
	const started = Date.now();
	let attempts = 0;
	try {
		switchToWriteAheadLogSync(() => {
			attempts += 1;
			throw failure;
		}, busyTimeoutMs);
	} catch (error) {
		const result = { attempts, elapsedMs: Date.now() - started, error };
		vi.useRealTimers();
		return result;
	}
	return assert.fail("the switch cannot succeed");
}

const GIVE_UP = [
	giveUp,
	async (failure: unknown, busyTimeoutMs: number) => giveUpSync(failure, busyTimeoutMs),
] as const;

test("opening a store whose wal-index a killed process still maps waits out the release (#4610)", async () => {
	const path = databasePath();
	const attempts = failWalSwitches(3);
	const database = await openNodeSqliteDatabase(path);
	try {
		assert.equal(attempts(), 4);
		assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
	} finally {
		await database.close();
	}
});

test("wrapping a connection whose wal-index a killed process still maps waits out the release (#4610)", async () => {
	const path = databasePath();
	const attempts = failWalSwitches(3);
	const connection = new DatabaseSync(path);
	try {
		const database = wrapNodeSqliteDatabase(connection);
		try {
			assert.equal(attempts(), 4);
			assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
		} finally {
			await database.close();
		}
	} finally {
		connection.close();
	}
});

test("an open with no busy timeout fails at once with its SQLITE_IOERR_TRUNCATE cause (#4610)", async () => {
	const path = databasePath();
	const attempts = failWalSwitches(Number.POSITIVE_INFINITY);
	await assert.rejects(openNodeSqliteDatabase(path, { busyTimeoutMs: 0 }), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal((error.cause as { errcode?: unknown }).errcode, SQLITE_IOERR_TRUNCATE);
		return true;
	});
	assert.equal(attempts(), 1);
});

test("any other I/O failure while switching to the write-ahead log fails at once (#4610)", async () => {
	const path = databasePath();
	const attempts = failWalSwitches(Number.POSITIVE_INFINITY, SQLITE_IOERR);
	await assert.rejects(openNodeSqliteDatabase(path), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal((error.cause as { errcode?: unknown }).errcode, SQLITE_IOERR);
		return true;
	});
	assert.equal(attempts(), 1);
});

for (const [name, run] of [
	["switchToWriteAheadLog", GIVE_UP[0]],
	["switchToWriteAheadLogSync", GIVE_UP[1]],
] as const) {
	test.each([
		[300, 300],
		[TRUNCATE_CAP_MS, TRUNCATE_CAP_MS],
		[10_000, TRUNCATE_CAP_MS],
		[600_000, TRUNCATE_CAP_MS],
	])(
		`${name} retries a refused truncation under a busy timeout of %d ms for %d ms (#4610)`,
		async (busyTimeoutMs, expectedMs) => {
			const failure = sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE });
			const gaveUp = await run(failure, busyTimeoutMs);
			assert.equal(gaveUp.elapsedMs, expectedMs);
			assert.ok(gaveUp.attempts > 2, `${gaveUp.attempts} attempts`);
			assert.equal(gaveUp.error, failure);
		},
	);

	test.each([[300], [TRUNCATE_CAP_MS], [10_000]])(
		`${name} retries SQLITE_BUSY for the whole busy timeout of %d ms, past the truncation cap (#4610)`,
		async (busyTimeoutMs) => {
			const failure = sqliteFailure({ errcode: SQLITE_BUSY });
			const gaveUp = await run(failure, busyTimeoutMs);
			assert.equal(gaveUp.elapsedMs, busyTimeoutMs);
			assert.ok(gaveUp.attempts > 2, `${gaveUp.attempts} attempts`);
			assert.equal(gaveUp.error, failure);
		},
	);

	test.each([
		["no code", () => new Error("boom")],
		["SQLITE_IOERR", () => sqliteFailure({ errcode: SQLITE_IOERR })],
		["SQLITE_IOERR in rawCode", () => sqliteFailure({ rawCode: SQLITE_IOERR })],
		["SQLITE_ERROR", () => sqliteFailure({ errcode: 1 })],
		["SQLITE_IOERR_SHMSIZE", () => sqliteFailure({ errcode: 4874 })],
		["a non-numeric code", () => sqliteFailure({ errcode: String(SQLITE_IOERR_TRUNCATE) })],
		["a thrown string", () => "disk I/O error"],
		["a thrown null", () => null],
		[
			"a numeric code that is not first",
			() => sqliteFailure({ errcode: SQLITE_IOERR, cause: sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE }) }),
		],
		["errcode before rawCode", () => sqliteFailure({ errcode: SQLITE_IOERR, rawCode: SQLITE_IOERR_TRUNCATE })],
	])(`${name} throws %s at once, whatever the busy timeout (#4610)`, async (_label, make) => {
		for (const busyTimeoutMs of [0, 300, 600_000]) {
			const failure = make();
			const gaveUp = await run(failure, busyTimeoutMs);
			assert.equal(gaveUp.attempts, 1, `busy timeout ${busyTimeoutMs}`);
			assert.equal(gaveUp.elapsedMs, 0);
			assert.equal(gaveUp.error, failure);
		}
	});

	test.each([
		["SQLITE_BUSY", SQLITE_BUSY],
		["SQLITE_IOERR_TRUNCATE", SQLITE_IOERR_TRUNCATE],
	])(`${name} throws %s at once under a busy timeout of 0 (#4610)`, async (_label, errcode) => {
		const failure = sqliteFailure({ errcode });
		const gaveUp = await run(failure, 0);
		assert.equal(gaveUp.attempts, 1);
		assert.equal(gaveUp.elapsedMs, 0);
		assert.equal(gaveUp.error, failure);
	});

	test.each([
		["errcode", () => sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE })],
		["libSQL's rawCode", () => sqliteFailure({ rawCode: SQLITE_IOERR_TRUNCATE })],
		["errcode over rawCode", () => sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE, rawCode: SQLITE_IOERR })],
		[
			"a non-numeric code in front of its cause",
			() => sqliteFailure({ errcode: "ERR", cause: sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE }) }),
		],
		[
			"the cause of a wrapper",
			() =>
				new StorageUnavailableError(
					{ adapter: "node-sqlite", location: "x" },
					sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE }),
				),
		],
		[
			"a cause three levels down",
			() =>
				new Error("a", {
					cause: new Error("b", {
						cause: new Error("c", { cause: sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE }) }),
					}),
				}),
		],
	])(`${name} recognizes SQLITE_IOERR_TRUNCATE as %s (#4610)`, async (_label, make) => {
		const gaveUp = await run(make(), 600_000);
		assert.equal(gaveUp.elapsedMs, TRUNCATE_CAP_MS);
	});

	test(`${name} stops at once on a chain of causes that leads back to itself without a code (#4610)`, async () => {
		const first = new Error("first");
		const second = new Error("second", { cause: first });
		first.cause = second;
		const alone = new Error("alone");
		alone.cause = alone;
		for (const failure of [first, alone]) {
			const gaveUp = await run(failure, 600_000);
			assert.equal(gaveUp.attempts, 1);
			assert.equal(gaveUp.elapsedMs, 0);
		}
	});

	test(`${name} finds SQLITE_IOERR_TRUNCATE in a chain of causes that leads back to itself (#4610)`, async () => {
		const first = new Error("first");
		const second = sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE, cause: first });
		first.cause = second;
		const gaveUp = await run(first, 600_000);
		assert.equal(gaveUp.elapsedMs, TRUNCATE_CAP_MS);
	});
}
