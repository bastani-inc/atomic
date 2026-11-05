import assert from "node:assert/strict";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import {
	findStorageWriteLockTimeoutError,
	isRetryableStorageError,
	isStorageConfigError,
	isStorageUnsupportedOperationError,
	isStorageWriteLockTimeoutError,
	isStorageWriterQueueUnusableError,
	StorageConfigError,
	StorageRollbackError,
	StorageUnavailableError,
	StorageUnsupportedOperationError,
	StorageWriteLockTimeoutError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	DEFAULT_GROUP_COMMIT_HOLD_MS,
	getWriterQueueStats,
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { isSqliteBusy } from "../../packages/coding-agent/src/core/storage/write-ahead-log.js";
import { databaseNow, freezeDatabaseClock } from "../helpers/database-clock.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** The adapter's recheck period for a writer that watches its release notice; a release nobody announces waits for it. */
const WATCHED_RECHECK_MS = 250;
/** The adapter's retry period for a writer without a watched release notice, within the connection's lock wait. */
const UNWATCHED_RETRY_MS = 20;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Counts {
	/** `BEGIN IMMEDIATE` attempts by the adapter's connection, successful or refused, with the time of each. */
	attempts: number[];
	begins: number;
	commits: number;
}

/**
 * A file database opened by the adapter, a raw connection to the same file that can hold the write lock the way
 * another process would, and counts of what the adapter's connection begins and commits.
 */
async function fixture(options?: Parameters<typeof openNodeSqliteDatabase>[1]) {
	const directory = makeTempDirectory("atomic-writer-queue-");
	const path = join(directory, "queue.sqlite");
	const database = await openNodeSqliteDatabase(path, options);
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const holder = new DatabaseSync(path);
	const counts: Counts = { attempts: [], begins: 0, commits: 0 };
	const exec = DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void {
		const ours = this !== holder;
		if (ours && sql === "BEGIN IMMEDIATE") counts.attempts.push(performance.now());
		exec.call(this, sql);
		if (ours && sql === "BEGIN IMMEDIATE") counts.begins += 1;
		if (ours && sql === "COMMIT") counts.commits += 1;
	};
	cleanups.push(async () => {
		DatabaseSync.prototype.exec = exec;
		if (holder.isTransaction) holder.exec("ROLLBACK");
		holder.close();
		await releaseWaiters(`${path}-writers`);
		await database.close();
		removeTempDirectory(directory);
	});
	return { directory, path, database, holder, counts, writers: `${path}-writers` };
}

async function turn(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Tells every writer still queued that the lock is free, as a releasing writer would. A raw holder's rollback
 * announces nothing, so a writer left waiting by a failed assertion, its fake timers already gone, would otherwise
 * keep the database from closing.
 */
async function releaseWaiters(writers: string): Promise<void> {
	const notices = wakes(writers);
	for (let attempt = 0; attempt < 100 && existsSync(notices) && readdirSync(notices).length > 0; attempt++) {
		for (const name of readdirSync(notices)) {
			try {
				touch(join(notices, name));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		await turn();
	}
}

/** The writers' tickets once there are at least `count`, oldest first. */
async function untilTickets(writers: string, count: number): Promise<string[]> {
	for (;;) {
		const names = existsSync(writers) ? readdirSync(writers).sort() : [];
		if (names.length >= count) return names;
		await turn();
	}
}

/** Waits until the adapter's waiting writer has scheduled its next recheck under fake timers. */
async function untilWaiting(): Promise<void> {
	while (vi.getTimerCount() === 0) await turn();
}

/** Freezes the database clock every connection reads at `nowMs` until the test ends; see `freezeDatabaseClock`. */
function setDatabaseClock(nowMs: number): (nowMs: number) => void {
	const clock = freezeDatabaseClock(nowMs);
	cleanups.push(() => clock.restore());
	return (next) => clock.set(next);
}

/** Stamps `path` `offsetMs` from now on the database clock, as a ticket's owner refreshes it. */
function touch(path: string, offsetMs = 0): void {
	const time = new Date(databaseNow() + offsetMs);
	utimesSync(path, time, time);
}

function wakes(writers: string): string {
	return writers.replace(/-writers$/, "-wakes");
}

function ticket(writers: string, timeMs: number, pid: number, mtimeOffsetMs = 0): string {
	mkdirSync(writers, { recursive: true });
	mkdirSync(wakes(writers), { recursive: true });
	const name = `${String(timeMs).padStart(15, "0")}-${pid}-1`;
	writeFileSync(join(writers, name), "");
	writeFileSync(join(wakes(writers), name), "");
	touch(join(wakes(writers), name), -3_600_000);
	touch(join(writers, name), mtimeOffsetMs);
	return name;
}

async function values(database: SqliteDatabase): Promise<string[]> {
	return (await database.all<{ value: string }>("SELECT value FROM items ORDER BY rowid")).map((row) => row.value);
}

function settledFlag(promise: Promise<unknown>): { readonly settled: boolean } {
	const flag = { settled: false };
	void promise.then(
		() => {
			flag.settled = true;
		},
		() => {
			flag.settled = true;
		},
	);
	return flag;
}

test("a queued writer takes the lock as soon as the writer releasing it touches its release notice, with its recheck timer frozen (#4316)", async () => {
	const { database, holder, writers } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('queued')"));
	const [name] = await untilTickets(writers, 1);
	await untilWaiting();
	holder.exec("COMMIT");
	touch(join(wakes(writers), name!));
	await write;
	assert.equal(vi.getTimerCount(), 0, "the recheck timer was cleared, not fired");
	assert.deepEqual(await values(database), ["queued"]);
	assert.deepEqual(readdirSync(writers), [], "the writer left the queue once it held the lock");
	assert.deepEqual(readdirSync(wakes(writers)), [], "and took its release notice with it");
});

test("a release nobody announces is noticed when the recheck timer fires (#4316)", async () => {
	const { database, holder } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('raw release')"));
	const write$ = settledFlag(write);
	await untilWaiting();
	holder.exec("COMMIT");
	await vi.advanceTimersByTimeAsync(WATCHED_RECHECK_MS - 1);
	for (let index = 0; index < 50; index++) await turn();
	assert.equal(write$.settled, false, "nothing told the writer before its recheck");
	await vi.advanceTimersByTimeAsync(1);
	await write;
	assert.deepEqual(await values(database), ["raw release"]);
});

/** A wrapped connection, which has no writers' queue, and the times of its `BEGIN IMMEDIATE` attempts. */
async function wrappedFixture() {
	const directory = makeTempDirectory("atomic-writer-queue-wrapped-");
	const path = join(directory, "wrapped.sqlite");
	const connection = new DatabaseSync(path);
	const database = wrapNodeSqliteDatabase(connection);
	const holder = new DatabaseSync(path);
	const attempts: number[] = [];
	const exec = DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void {
		if (this === connection && sql === "BEGIN IMMEDIATE") attempts.push(performance.now());
		exec.call(this, sql);
	};
	cleanups.push(async () => {
		DatabaseSync.prototype.exec = exec;
		holder.close();
		await database.close();
		connection.close();
		removeTempDirectory(directory);
	});
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	return { path, database, holder, attempts };
}

test("a writer without a queue retries within its lock wait, and a timed-out writer reports a typed, retryable timeout (#4316)", async () => {
	const { path, database, holder, attempts } = await wrappedFixture();
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const failure = database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('never')"), { lockWaitMs: 100 })
		.then(
			() => assert.fail("wrote under a held lock"),
			(error: unknown) => error,
		);
	await untilWaiting();
	await vi.advanceTimersByTimeAsync(100);
	const error = await failure;
	assert.ok(error instanceof StorageWriteLockTimeoutError, String(error));
	assert.ok(error instanceof StorageUnavailableError);
	assert.ok(isStorageWriteLockTimeoutError(error));
	assert.ok(isRetryableStorageError(error));
	assert.equal(error.code, "write-lock-timeout");
	assert.equal(error.retryable, true);
	assert.equal(error.timeoutMs, 100);
	assert.equal(error.elapsedMs, 100);
	assert.equal(error.phase, "acquiring");
	assert.equal(error.adapter, "node-sqlite");
	assert.equal(error.location, path);
	assert.equal(error.holderPid, undefined);
	assert.ok(isSqliteBusy(error.cause));
	const start = attempts[0]!;
	assert.deepEqual(
		attempts.map((time) => time - start),
		[0, 20, 40, 60, 80, 100],
		"retried every 20 ms until the lock wait ran out",
	);
});

test("a writer without a queue retries less often once past the connection's lock wait (#4316)", async () => {
	const { database, holder, attempts } = await wrappedFixture();
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const failure = database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('patient')"), { lockWaitMs: 30_600 })
		.then(
			() => assert.fail("wrote under a held lock"),
			(error: unknown) => error,
		);
	await untilWaiting();
	await vi.advanceTimersByTimeAsync(30_600);
	assert.ok(isStorageWriteLockTimeoutError(await failure));
	const start = attempts[0]!;
	const offsets = attempts.map((time) => time - start);
	assert.equal(offsets.filter((offset) => offset < 30_000).length, 30_000 / UNWATCHED_RETRY_MS);
	assert.deepEqual(
		offsets.filter((offset) => offset >= 30_000),
		[30_000, 30_000 + WATCHED_RECHECK_MS, 30_000 + 2 * WATCHED_RECHECK_MS, 30_600],
	);
});

test("a writer that watches its release notice rechecks every recheck period, up to its own lock wait (#4316)", async () => {
	const { database, holder, counts } = await fixture({ lockWaitMs: 100 });
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('patient')"), { lockWaitMs: 700 });
	const failure = write.then(
		() => assert.fail("wrote under a held lock"),
		(error: unknown) => error,
	);
	await untilWaiting();
	await vi.advanceTimersByTimeAsync(700);
	const error = await failure;
	assert.ok(isStorageWriteLockTimeoutError(error));
	assert.equal(error.timeoutMs, 700);
	const start = counts.attempts[0]!;
	// A watched writer rechecks every 250 ms once past the connection's 100 ms lock wait, up to its own 700 ms.
	assert.deepEqual([...new Set(counts.attempts.map((time) => time - start))], [0, 250, 500, 700]);
});

test("transactions requested while a batch waits for the lock share its acquisition and commit, in order (#4316)", async () => {
	const { database, holder, counts, writers } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	const first = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('1')"));
	const [name] = await untilTickets(writers, 1);
	const later = ["2", "3", "4", "5"].map((value) =>
		database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value)),
	);
	holder.exec("COMMIT");
	touch(join(wakes(writers), name!));
	await Promise.all([first, ...later]);
	assert.deepEqual(await values(database), ["1", "2", "3", "4", "5"]);
	assert.equal(counts.begins, 1, "one acquisition served the waiting batch and the transactions behind it");
	assert.equal(counts.commits, 1);
});

test("a statement requested between waiting transactions keeps them in separate acquisitions, in order (#4316)", async () => {
	const { database, holder, counts, writers } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	const first = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('first')"));
	const [name] = await untilTickets(writers, 1);
	const statement = database.run("INSERT INTO items VALUES ('statement')");
	const second = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('second')"));
	holder.exec("COMMIT");
	touch(join(wakes(writers), name!));
	await Promise.all([first, statement, second]);
	assert.deepEqual(await values(database), ["first", "statement", "second"]);
	assert.equal(counts.begins, 2);
});

test("a waiting batch takes in at most the batch size limit, and the rest joins the next acquisition (#4316)", async () => {
	const { database, holder, counts, writers } = await fixture({ groupCommitHoldMs: 60_000 });
	holder.exec("BEGIN IMMEDIATE");
	const first = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('0')"));
	const [name] = await untilTickets(writers, 1);
	const expected = Array.from({ length: 201 }, (_, index) => String(index));
	const later = expected
		.slice(1)
		.map((value) => database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value)));
	holder.exec("COMMIT");
	touch(join(wakes(writers), name!));
	await Promise.all([first, ...later]);
	assert.deepEqual(await values(database), expected);
	// 128 in the first acquisition; the one left of the second batch then takes in all 72 of the third.
	assert.equal(counts.begins, 2);
	assert.equal(counts.commits, 2);
});

test("groupCommitHoldMs bounds how long one acquisition runs queued transactions (#4316)", async () => {
	// With the clock frozen no member takes any time: a budget of 0 is still used up, any larger one never is.
	vi.useFakeTimers({ toFake: ["performance"] });
	for (const [groupCommitHoldMs, commits] of [
		[0, 5],
		[DEFAULT_GROUP_COMMIT_HOLD_MS, 1],
	] as const) {
		const { database, holder, counts, writers } = await fixture({ groupCommitHoldMs });
		holder.exec("BEGIN IMMEDIATE");
		const first = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('a')"));
		const [name] = await untilTickets(writers, 1);
		const later = ["b", "c", "d", "e"].map((value) =>
			database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value)),
		);
		holder.exec("COMMIT");
		touch(join(wakes(writers), name!));
		await Promise.all([first, ...later]);
		assert.deepEqual(await values(database), ["a", "b", "c", "d", "e"]);
		assert.equal(counts.commits, commits, `groupCommitHoldMs ${groupCommitHoldMs}`);
	}
});

test("an invalid groupCommitHoldMs is rejected as a typed configuration error before anything is created (#4316)", async () => {
	const directory = makeTempDirectory("atomic-writer-queue-config-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "not-created", "queue.sqlite");
	for (const groupCommitHoldMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, "100" as unknown as number]) {
		const error = await openNodeSqliteDatabase(path, { groupCommitHoldMs }).then(
			() => assert.fail(`accepted ${String(groupCommitHoldMs)}`),
			(cause: unknown) => cause,
		);
		assert.ok(error instanceof StorageConfigError, String(error));
		assert.ok(isStorageConfigError(error));
		assert.equal(error.name, "StorageConfigError");
		assert.equal(error.code, "invalid-config");
		assert.equal(error.source, "sdk");
		assert.equal(error.field, "groupCommitHoldMs");
		assert.equal(error.reason, "non-negative-finite-number-required");
		assert.equal(
			error.hint,
			`Pass a finite number of milliseconds, 0 or more, or omit it for the default of ${DEFAULT_GROUP_COMMIT_HOLD_MS} ms`,
		);
	}
	assert.equal(existsSync(join(directory, "not-created")), false);
	for (const groupCommitHoldMs of [0, 2.5]) {
		const database = await openNodeSqliteDatabase(join(directory, `valid-${groupCommitHoldMs}.sqlite`), {
			groupCommitHoldMs,
		});
		await database.close();
	}
});

test("an invalid groupCommitHoldMs renders one message with the remedy (#4316)", async () => {
	const error = await openNodeSqliteDatabase(":memory:", { groupCommitHoldMs: -5 }).then(
		() => assert.fail("accepted -5"),
		(cause: unknown) => cause as Error,
	);
	assert.equal(
		error.message,
		"Invalid storage configuration: groupCommitHoldMs (non-negative-finite-number-required). Pass a finite number of milliseconds, 0 or more, or omit it for the default of 100 ms",
	);
});

test("getWriterQueueStats reports held share, commit rate, and waits over the window (#4316)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const { database, holder } = await fixture();
	vi.advanceTimersByTime(1_000);
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('held')");
		vi.advanceTimersByTime(250);
		const during = getWriterQueueStats(database);
		assert.equal(during.lockHeldRatio, 250 / 1_250, "a hold still open counts");
	});
	vi.advanceTimersByTime(750);
	assert.deepEqual(getWriterQueueStats(database), {
		lockHeldRatio: 250 / 2_000,
		waiters: 0,
		p50WaitMs: 0,
		p95WaitMs: 0,
		commitsPerSecond: 1 / 2,
	});

	holder.exec("BEGIN IMMEDIATE");
	const waited = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('waited')"));
	await untilWaiting();
	assert.equal(getWriterQueueStats(database).waiters, 1, "this writer's own ticket is a waiter");
	holder.exec("COMMIT");
	await vi.advanceTimersByTimeAsync(WATCHED_RECHECK_MS);
	await waited;
	const stats = getWriterQueueStats(database);
	assert.equal(stats.p50WaitMs, 0);
	assert.equal(stats.p95WaitMs, WATCHED_RECHECK_MS);
	assert.equal(stats.commitsPerSecond, 2 / 2.25);
	assert.equal(stats.waiters, 0);

	vi.advanceTimersByTime(10_001);
	assert.deepEqual(getWriterQueueStats(database), {
		lockHeldRatio: 0,
		waiters: 0,
		p50WaitMs: 0,
		p95WaitMs: 0,
		commitsPerSecond: 0,
	});
});

test("getWriterQueueStats counts only the part of a hold inside the window (#4316)", async () => {
	vi.useFakeTimers({ toFake: ["performance"] });
	const { database } = await fixture();
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('long')");
		vi.advanceTimersByTime(3_000);
	});
	vi.advanceTimersByTime(8_000);
	const stats = getWriterQueueStats(database);
	assert.equal(stats.lockHeldRatio, 2_000 / 10_000);
	assert.equal(stats.commitsPerSecond, 1 / 10);
	assert.equal(getWriterQueueStats(await openNodeSqliteDatabase(":memory:")).lockHeldRatio, 0);
});

test("getWriterQueueStats counts live tickets of any process as waiters, not stale or future-dated ones (#4316)", async () => {
	const { database, writers } = await fixture();
	ticket(writers, Date.now(), 999_999_991);
	ticket(writers, Date.now(), 999_999_992);
	ticket(writers, Date.now(), 999_999_993, -5_000);
	ticket(writers, Date.now(), 999_999_994, 5_000);
	assert.equal(getWriterQueueStats(database).waiters, 2);
	const memory = await openNodeSqliteDatabase(":memory:");
	cleanups.push(() => memory.close());
	assert.equal(getWriterQueueStats(memory).waiters, 0);
});

test("getWriterQueueStats rejects a database from another adapter with a typed error (#4316)", () => {
	const custom: SqliteDatabase = {
		descriptor: { adapter: "custom", location: "remote://db" },
		exec: async () => {},
		run: async () => ({ changes: 0 }),
		get: async () => undefined,
		all: async () => [],
		transaction: (callback) => callback(custom),
		close: async () => {},
	};
	const error = (() => {
		try {
			getWriterQueueStats(custom);
		} catch (cause) {
			return cause;
		}
		return assert.fail("returned stats for another adapter");
	})();
	assert.ok(error instanceof StorageUnsupportedOperationError);
	assert.ok(isStorageUnsupportedOperationError(error));
	assert.equal(error.code, "unsupported-operation");
	assert.equal(error.operation, "getWriterQueueStats");
	assert.equal(error.adapter, "custom");
	assert.equal(error.location, "remote://db");
	assert.equal(
		error.message,
		"Unsupported storage operation: getWriterQueueStats on custom at remote://db (unsupported-operation). Call getWriterQueueStats with a database from openNodeSqliteDatabase or wrapNodeSqliteDatabase",
	);
});

test("a writer queues behind a live ticket dated ahead of its own clock instead of overtaking it (#4316)", async () => {
	const { database, writers } = await fixture();
	const ahead = ticket(writers, Date.now() + 3_600_000, 999_999_995);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('behind')"));
	const write$ = settledFlag(write);
	const names = await untilTickets(writers, 2);
	await untilWaiting();
	assert.equal(names[0], ahead, "the new ticket sorts after the live one");
	touch(join(wakes(writers), names[1]!));
	for (let index = 0; index < 50; index++) await turn();
	assert.equal(write$.settled, false, "a notice does not let it overtake a live ticket ahead");
	writeFileSync(join(writers, ahead), "");
	touch(join(writers, ahead), -60_000);
	touch(join(wakes(writers), names[1]!));
	await write;
	assert.deepEqual(await values(database), ["behind"]);
});

test("tickets dated far from now are not live, and long-abandoned ones are removed in either direction (#4316)", async () => {
	const { database, writers } = await fixture();
	const future = ticket(writers, Date.now(), 999_999_996, 3_600_000);
	const past = ticket(writers, Date.now(), 999_999_997, -3_600_000);
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('uncontended')"));
	assert.deepEqual(await values(database), ["uncontended"]);
	assert.equal(existsSync(join(writers, future)), false);
	assert.equal(existsSync(join(writers, past)), false);
});

/** Counts the change events on each ticket's release notice, as its waiting writer's watch would see them. */
function watchNotices(writers: string, names: readonly string[]) {
	const events = new Map(names.map((name) => [name, 0]));
	const watchers = names.map((name) =>
		fs.watch(join(wakes(writers), name), () => events.set(name, (events.get(name) ?? 0) + 1)),
	);
	return {
		events,
		woken: () => [...events.values()].some((count) => count > 0),
		close: () => {
			for (const watcher of watchers) watcher.close();
		},
	};
}

test("a writer that lets go of the lock wakes the oldest live ticket through its release notice, after a commit and after a rollback (#4316)", async () => {
	const { database, writers } = await fixture();
	for (const outcome of ["commit", "rollback"] as const) {
		const mtimes = new Map<string, number>();
		let stale = "";
		let oldest = "";
		let next = "";
		let last = "";
		let watched: ReturnType<typeof watchNotices> | undefined;
		const transaction = database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES (?)", outcome);
			const now = Date.now();
			// The oldest is created neither first nor last, so a listing in creation order or its reverse would miss it.
			next = ticket(writers, now + 10, 999_999_983, -1_000);
			oldest = ticket(writers, now, 999_999_982, -1_000);
			last = ticket(writers, now + 20, 999_999_984, -1_000);
			stale = ticket(writers, now - 10, 999_999_981, -5_000);
			for (const name of [stale, oldest, next, last]) mtimes.set(name, statSync(join(writers, name)).mtimeMs);
			watched = watchNotices(writers, [stale, oldest, next, last]);
			if (outcome === "rollback") throw new Error("rolled back");
		});
		await transaction.catch((error: Error) => assert.equal(error.message, "rolled back"));
		while (!watched!.woken()) await turn();
		for (let index = 0; index < 20; index++) await turn();
		watched!.close();
		assert.deepEqual(
			[stale, oldest, next, last].map((name) => watched!.events.get(name)! > 0),
			[false, true, false, false],
			`${outcome}: only the oldest live ticket was woken`,
		);
		assert.ok(
			Date.now() - statSync(join(wakes(writers), oldest)).mtimeMs < 500,
			`${outcome}: its notice was touched`,
		);
		for (const name of [stale, oldest, next, last])
			assert.equal(
				statSync(join(writers, name)).mtimeMs,
				mtimes.get(name),
				`${outcome}: only an owner moves a ticket's liveness`,
			);
		for (const name of [stale, oldest, next, last]) touch(join(writers, name), -60_000);
	}
	assert.deepEqual(await values(database), ["commit"]);
});

test("a release does not keep a dead waiter's ticket alive: it goes stale 2 s after its owner last refreshed it (#4316)", async () => {
	const { database, writers } = await fixture();
	const now = Math.floor(databaseNow() / 1000) * 1000 + 1000;
	const setClock = setDatabaseClock(now);
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('released past a dead waiter')");
		// The ticket of a waiter that died 1.5 s ago, first in line.
		ticket(writers, now - 1_600, 999_999_988, -1_500);
	});
	assert.equal(getWriterQueueStats(database).waiters, 1);
	setClock(now + 600);
	assert.equal(
		getWriterQueueStats(database).waiters,
		0,
		"stale 2 s after its owner's last refresh, whatever the release did",
	);
});

test("a waiting writer's watch fires when another writer's release wakes it, without moving its ticket's liveness (#4316)", async () => {
	const { database, writers } = await fixture();
	let head = "";
	let watcher: fs.FSWatcher | undefined;
	let events = 0;
	let mtimeMs = 0;
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('woke a watcher')");
		head = ticket(writers, Date.now(), 999_999_989, -1_000);
		mtimeMs = statSync(join(writers, head)).mtimeMs;
		watcher = fs.watch(join(wakes(writers), head), () => {
			events += 1;
		});
	});
	cleanups.push(() => watcher?.close());
	while (events === 0) await turn();
	assert.equal(statSync(join(writers, head)).mtimeMs, mtimeMs);
});

test("a writer behind a live ticket that never moves gives up as queued and names the holder from its record (#4316)", async () => {
	const { database, writers, path } = await fixture({ lockWaitMs: 300 });
	const ahead = ticket(writers, Date.now() - 1, 999_999_998);
	mkdirSync(`${path}-holders`, { recursive: true });
	const tookAt = Date.now() - 1_000;
	writeFileSync(join(`${path}-holders`, `${process.pid}-999999`), `held ${String(tookAt).padStart(15, "0")}\n`);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const failure = database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('never')"))
		.then(
			() => assert.fail("overtook a live ticket"),
			(error: unknown) => error,
		);
	await untilWaiting();
	await vi.advanceTimersByTimeAsync(300);
	const error = await failure;
	assert.ok(isStorageWriteLockTimeoutError(error), String(error));
	assert.equal(error.phase, "queued");
	assert.equal(error.timeoutMs, 300);
	assert.equal(error.holderPid, process.pid);
	assert.ok((error.holderHeldMs ?? -1) >= 1_000);
	assert.equal(error.cause, undefined, "it never attempted the lock");
	const wrapped = new Error("journal append failed", { cause: error });
	assert.equal(findStorageWriteLockTimeoutError(wrapped), error);
	assert.ok(isRetryableStorageError(wrapped));
	assert.ok(existsSync(join(writers, ahead)));
});

test("a waiting writer refreshes its ticket every 500 ms, recreates it if it was removed, and still hears the release (#4316)", async () => {
	const { database, holder, writers } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.advanceTimersByTime(60_000);
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('kept live')"));
	const [name] = await untilTickets(writers, 1);
	const path = join(writers, name!);
	await untilWaiting();
	const age = () => databaseNow() - statSync(path).mtimeMs;
	touch(path, -1_500);
	await vi.advanceTimersByTimeAsync(WATCHED_RECHECK_MS);
	assert.ok(age() >= 1_400, "not refreshed before 500 ms");
	await vi.advanceTimersByTimeAsync(WATCHED_RECHECK_MS);
	assert.ok(age() < 1_000, "refreshed at 500 ms");
	const notice = join(wakes(writers), name!);
	fs.unlinkSync(path);
	fs.unlinkSync(notice);
	await vi.advanceTimersByTimeAsync(2 * WATCHED_RECHECK_MS);
	assert.ok(existsSync(path), "recreated under its old name, keeping its place");
	assert.ok(existsSync(notice), "with its release notice");
	holder.exec("COMMIT");
	touch(notice);
	await write;
	assert.deepEqual(await values(database), ["kept live"]);
});

test("a writer never takes over a file already named like its ticket, and fails as an unusable writers' queue (#4316)", async () => {
	const { database, holder, writers } = await fixture({ lockWaitMs: 300 });
	const now = Math.floor(Date.now() / 1000) * 1000 + 1000;
	vi.useFakeTimers({ toFake: ["Date"], now });
	holder.exec("BEGIN IMMEDIATE");
	const first = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('first')"));
	const [earlier] = await untilTickets(writers, 1);
	holder.exec("COMMIT");
	touch(join(wakes(writers), earlier!));
	await first;
	const [time, pid, sequence] = earlier!.split("-");
	const taken = `${time}-${pid}-${Number(sequence) + 1}`;
	writeFileSync(join(writers, taken), "another writer's");
	touch(join(writers, taken), -5_000);
	holder.exec("BEGIN IMMEDIATE");
	const error = await database
		.transaction((tx) => tx.run("INSERT INTO items VALUES ('second')"))
		.then(
			() => assert.fail("took the lock past a ticket it did not create"),
			(cause: unknown) => cause,
		);
	assert.ok(isStorageWriterQueueUnusableError(error), String(error));
	assert.equal(error.errno, "EEXIST");
	assert.equal(fs.readFileSync(join(writers, taken), "utf8"), "another writer's", "the file was left as it was");
});

test("commits by other connections keep a waiting writer from giving up, however long the lock stays busy (#4316)", async () => {
	const { database, holder } = await fixture({ lockWaitMs: 300 });
	holder.exec("CREATE TABLE other (n INTEGER)");
	holder.exec("BEGIN IMMEDIATE; INSERT INTO other VALUES (0)");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('patient through progress')"));
	const write$ = settledFlag(write);
	await untilWaiting();
	for (let round = 1; round <= 6; round++) {
		await vi.advanceTimersByTimeAsync(200);
		holder.exec(`COMMIT; BEGIN IMMEDIATE; INSERT INTO other VALUES (${round})`);
	}
	await vi.advanceTimersByTimeAsync(200);
	assert.equal(write$.settled, false, "still waiting after 1400 ms of a busy lock with a 300 ms lock wait");
	holder.exec("COMMIT");
	await vi.advanceTimersByTimeAsync(WATCHED_RECHECK_MS);
	await write;
	assert.deepEqual(await values(database), ["patient through progress"]);
});

test("the connection's holder record says held while it holds the lock and free once it lets go (#4316)", async () => {
	const { database, path } = await fixture();
	const record = () => {
		const [name] = readdirSync(`${path}-holders`).filter((entry) => entry.startsWith(`${process.pid}-`));
		return fs.readFileSync(join(`${path}-holders`, name!), "utf8").slice(0, 4);
	};
	let during = "";
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('recorded')");
		during = record();
	});
	assert.equal(during, "held");
	assert.equal(record(), "free");
	await database
		.transaction(async () => {
			throw new Error("rolled back");
		})
		.catch((error: Error) => assert.equal(error.message, "rolled back"));
	assert.equal(record(), "free", "freed after a rollback too");
});

test("a rolled-back transaction counts toward lock-held time but not toward commits (#4316)", async () => {
	vi.useFakeTimers({ toFake: ["performance"] });
	const { database } = await fixture();
	await database
		.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('undone')");
			vi.advanceTimersByTime(400);
			throw new Error("undo");
		})
		.catch((error: Error) => assert.equal(error.message, "undo"));
	vi.advanceTimersByTime(600);
	const stats = getWriterQueueStats(database);
	assert.equal(stats.lockHeldRatio, 400 / 1_000);
	assert.equal(stats.commitsPerSecond, 0);
	assert.deepEqual(await values(database), []);
});

test("a writer names its ticket <15-digit time>-<pid>-<sequence> and ignores files in the queue that are not tickets (#4316)", async () => {
	const { database, holder, writers } = await fixture();
	fs.mkdirSync(writers, { recursive: true });
	const stray = `stray-${String(Date.now() + 3_600_000).padStart(15, "0")}-x`;
	fs.writeFileSync(join(writers, stray), "");
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('beside a stray file')"));
	const names = await untilTickets(writers, 2);
	const own = names.find((name) => name !== stray)!;
	assert.match(own, new RegExp(`^\\d{15}-${process.pid}-\\d+$`));
	assert.ok(Number(own.slice(0, 15)) < Date.now() + 60_000, "named from the clock, not from the stray file");
	assert.equal(fs.readFileSync(join(writers, own), "utf8"), "", "a ticket carries nothing but its name and times");
	assert.equal(fs.readFileSync(join(wakes(writers), own), "utf8"), "", "and so does its release notice");
	await untilWaiting();
	holder.exec("COMMIT");
	touch(join(wakes(writers), own));
	await write;
});

test("a ticket is live strictly within 2 s of now and removed strictly beyond 20 s, in either direction (#4316)", async () => {
	const { database, writers } = await fixture();
	const now = Math.floor(databaseNow() / 1000) * 1000 + 1000;
	setDatabaseClock(now);
	let pid = 999_999_900;
	const at = (offsetMs: number) => {
		pid += 1;
		const name = ticket(writers, now, pid);
		const time = new Date(now + offsetMs);
		utimesSync(join(writers, name), time, time);
		return name;
	};
	const liveFuture = at(1_999);
	const liveFutureAge = statSync(join(writers, liveFuture)).mtimeMs - now;
	assert.equal(liveFutureAge, 1_999);
	at(-1_999);
	at(2_000);
	at(-2_000);
	const keptPast = at(-20_000);
	const removedPast = at(-20_001);
	assert.equal(getWriterQueueStats(database).waiters, 2, "only the two within 2 s are live");
	assert.ok(existsSync(join(writers, keptPast)), "20 s old is not yet removed");
	assert.equal(existsSync(join(writers, removedPast)), false, "older than 20 s is removed");
});

/** How far a running process's own clock can sit from the system clock: on Windows, until V8 renews its reading. */
const PROCESS_CLOCK_OFFSETS_MS = [-30_000, 30_000];

test("a writer whose own clock is off the system clock by seconds still finds the live tickets, and removes none of them (#4387)", async () => {
	const { database, writers } = await fixture();
	const live = ticket(writers, Date.now(), 999_999_870);
	const stale = ticket(writers, Date.now(), 999_999_871, -5_000);
	for (const offsetMs of PROCESS_CLOCK_OFFSETS_MS) {
		vi.useFakeTimers({ toFake: ["Date"], now: databaseNow() + offsetMs });
		assert.equal(getWriterQueueStats(database).waiters, 1, `with its clock ${offsetMs} ms off`);
		vi.useRealTimers();
	}
	assert.deepEqual(readdirSync(writers).sort(), [live, stale].sort(), "neither ticket was taken for abandoned");
});

test("a waiting writer whose own clock is off the system clock refreshes its ticket on the database clock, so other writers keep it live (#4387)", async () => {
	const { database, holder, writers } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	for (const offsetMs of PROCESS_CLOCK_OFFSETS_MS) {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "performance", "Date"],
			now: databaseNow() + offsetMs,
		});
		const write = database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", String(offsetMs)));
		const [name] = await untilTickets(writers, 1);
		await untilWaiting();
		await vi.advanceTimersByTimeAsync(2 * WATCHED_RECHECK_MS);
		const ageMs = databaseNow() - statSync(join(writers, name!)).mtimeMs;
		assert.ok(Math.abs(ageMs) < 1_000, `with its clock ${offsetMs} ms off, refreshed ${ageMs} ms from now`);
		holder.exec("COMMIT");
		touch(join(wakes(writers), name!));
		await write;
		holder.exec("BEGIN IMMEDIATE");
		vi.useRealTimers();
	}
	holder.exec("ROLLBACK");
	assert.deepEqual(await values(database), PROCESS_CLOCK_OFFSETS_MS.map(String));
});

/** Counts the database clock reads of every connection until the test ends. */
function countDatabaseClockReads(): { readonly reads: number } {
	const counted = { reads: 0 };
	const prepare = DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
		if (sql.includes("unixepoch(")) counted.reads += 1;
		return prepare.call(this, sql);
	} as typeof prepare;
	cleanups.push(() => {
		DatabaseSync.prototype.prepare = prepare;
	});
	return counted;
}

test("the database clock is read once per look at a queue with tickets, and never for an absent or empty queue (#4387)", async () => {
	const { database, writers } = await fixture();
	const clock = countDatabaseClockReads();
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('alone')"));
	assert.equal(getWriterQueueStats(database).waiters, 0);
	mkdirSync(writers, { recursive: true });
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('after contention')"));
	assert.equal(getWriterQueueStats(database).waiters, 0);
	assert.equal(clock.reads, 0, "no tickets, no clock");
	ticket(writers, Date.now(), 999_999_872);
	ticket(writers, Date.now(), 999_999_873);
	const before = clock.reads;
	assert.equal(getWriterQueueStats(database).waiters, 2);
	assert.equal(clock.reads - before, 1, "one read for both tickets");
});

test("getWriterQueueStats still counts the writers waiting in the queue after the handle is closed (#4387)", async () => {
	const { database, writers } = await fixture();
	ticket(writers, Date.now(), 999_999_874);
	await database.close();
	assert.equal(getWriterQueueStats(database).waiters, 1);
});

test("an uncontended transaction neither creates a writers' queue nor takes a ticket (#4316)", async () => {
	const { database, writers } = await fixture();
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('alone')"));
	assert.equal(existsSync(writers), false);
});

test("getWriterQueueStats drops samples that leave the window, and keeps one exactly at its start (#4316)", async () => {
	vi.useFakeTimers({ toFake: ["performance"] });
	vi.advanceTimersByTime(1_000);
	const { database } = await fixture();
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('at the start')"));
	vi.advanceTimersByTime(2_000);
	assert.equal(getWriterQueueStats(database).commitsPerSecond, 1 / 2, "measured since the handle opened");
	vi.advanceTimersByTime(8_000);
	assert.equal(
		getWriterQueueStats(database).commitsPerSecond,
		1 / 10,
		"a commit exactly at the window's start counts",
	);
	vi.advanceTimersByTime(1);
	for (const value of ["later 1", "later 2"])
		await database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value));
	assert.equal(getWriterQueueStats(database).commitsPerSecond, 2 / 10);
});

test("getWriterQueueStats percentiles sort the waits, whatever order they happened in (#4316)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const { database, holder } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	const waited = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('waited')"));
	await untilWaiting();
	holder.exec("COMMIT");
	await vi.advanceTimersByTimeAsync(WATCHED_RECHECK_MS);
	await waited;
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('at once')"));
	const stats = getWriterQueueStats(database);
	assert.equal(stats.p50WaitMs, 0);
	assert.equal(stats.p95WaitMs, WATCHED_RECHECK_MS);
});

test("failed rollbacks and abandoned group commits release the lock without counting a commit (#4316)", async () => {
	vi.useFakeTimers({ toFake: ["performance"] });
	const { database, counts } = await fixture();
	await database.exec("CREATE UNIQUE INDEX items_value ON items(value)");
	await database.run("INSERT INTO items VALUES ('taken')");
	const alone = await database
		.transaction(async (tx) => {
			await tx.exec("ROLLBACK");
			throw new Error("ended its own transaction");
		})
		.then(
			() => assert.fail("committed"),
			(error: unknown) => error,
		);
	assert.ok(alone instanceof StorageRollbackError, String(alone));
	const grouped = await Promise.allSettled([
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('first')")),
		database.transaction((tx) => tx.run("INSERT OR ROLLBACK INTO items VALUES ('taken')")),
	]);
	assert.deepEqual(
		grouped.map((outcome) => outcome.status),
		["rejected", "rejected"],
	);
	assert.equal(counts.begins, 2, "nothing was left to commit after the abandoned group");
	assert.equal(counts.commits, 0);
	vi.advanceTimersByTime(1_000);
	assert.equal(getWriterQueueStats(database).commitsPerSecond, 0);
	assert.deepEqual(await values(database), ["taken"]);
});

test("a group commit frees the holder record, counts one commit, and hands the turn on (#4316)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const { database, holder, path, writers, counts } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	const first = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('a')"));
	const [name] = await untilTickets(writers, 1);
	await untilWaiting();
	let waiting = "";
	const rest = ["b", "c"].map((value) =>
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES (?)", value);
			if (value === "c") waiting = ticket(writers, Date.now() + 5_000, 999_999_987, -1_000);
		}),
	);
	holder.exec("COMMIT");
	touch(join(wakes(writers), name!));
	await Promise.all([first, ...rest]);
	assert.equal(counts.commits, 1);
	vi.advanceTimersByTime(1_000);
	assert.equal(getWriterQueueStats(database).commitsPerSecond, 1);
	const [record] = readdirSync(`${path}-holders`).filter((entry) => entry.startsWith(`${process.pid}-`));
	assert.equal(fs.readFileSync(join(`${path}-holders`, record!), "utf8").slice(0, 4), "free");
	assert.ok(
		Date.now() - statSync(join(wakes(writers), waiting)).mtimeMs < 500,
		"the next writer's notice was touched",
	);
});

test("transactions requested together join one batch up to the batch size limit (#4316)", async () => {
	const { database, counts } = await fixture();
	const expected = Array.from({ length: 129 }, (_, index) => String(index));
	await Promise.all(
		expected.map((value) => database.transaction((tx) => tx.run("INSERT INTO items VALUES (?)", value))),
	);
	assert.deepEqual(await values(database), expected);
	assert.equal(counts.commits, 2, "128 in the first commit, the 129th in the next");
});

test("a batch waits for the lock as long as the most patient of the transactions requested with it (#4316)", async () => {
	const { database, holder } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const impatient = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('impatient')"), {
		lockWaitMs: 100,
	});
	const patient = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('patient')"), { lockWaitMs: 1_000 });
	const impatient$ = settledFlag(impatient);
	await untilWaiting();
	await vi.advanceTimersByTimeAsync(2 * WATCHED_RECHECK_MS);
	assert.equal(impatient$.settled, false, "still waiting with its patient batch mate past its own 100 ms");
	holder.exec("COMMIT");
	await vi.advanceTimersByTimeAsync(WATCHED_RECHECK_MS);
	await Promise.all([impatient, patient]);
	assert.deepEqual(await values(database), ["impatient", "patient"]);
});

test("a transaction requested while an absorbing batch commits still runs, in its own commit (#4316)", async () => {
	const { database, holder, counts, writers } = await fixture();
	holder.exec("BEGIN IMMEDIATE");
	const first = database.transaction((tx) => tx.run("INSERT INTO items VALUES ('first')"));
	const [name] = await untilTickets(writers, 1);
	let late: Promise<unknown> | undefined;
	const second = database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('second')");
		late = database.transaction((inner) => inner.run("INSERT INTO items VALUES ('late')"));
	});
	holder.exec("COMMIT");
	touch(join(wakes(writers), name!));
	await Promise.all([first, second]);
	await late;
	assert.deepEqual(await values(database), ["first", "second", "late"]);
	assert.equal(counts.commits, 2);
});

test("members left after the hold budget take the lock again without new transactions, so another handle to the file waits for at most one batch (#4316)", async () => {
	const { database: first, path, holder, writers } = await fixture({ groupCommitHoldMs: 0 });
	const second = await openNodeSqliteDatabase(path, { groupCommitHoldMs: 0 });
	cleanups.push(() => second.close());
	const pumped = 40;
	const requested: Promise<unknown>[] = [];
	const request = (): void => {
		const value = `a${requested.length}`;
		requested.push(
			first.transaction(async (tx) => {
				await turn();
				await tx.run("INSERT INTO items VALUES (?)", value);
				if (requested.length < pumped) request();
			}),
		);
	};
	holder.exec("BEGIN IMMEDIATE");
	request();
	const [name] = await untilTickets(writers, 1);
	for (let index = 0; index < 3; index++) request();
	const other = second.transaction((tx) => tx.run("INSERT INTO items VALUES ('b')"));
	holder.exec("COMMIT");
	touch(join(wakes(writers), name!));
	await other;
	for (let settled = 0; settled < requested.length; ) {
		settled = requested.length;
		await Promise.all(requested);
	}
	const order = await values(first);
	assert.deepEqual(
		order.filter((value) => value !== "b"),
		Array.from({ length: pumped }, (_, index) => `a${index}`),
	);
	assert.equal(order.indexOf("b"), 4, "the other handle committed right after the first batch's four commits");
});

test("closing a database the adapter opened closes its connection, which removes the write-ahead log (#4316)", async () => {
	const directory = makeTempDirectory("atomic-writer-queue-close-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "closed.sqlite");
	const database = await openNodeSqliteDatabase(path);
	await database.transaction((tx) => tx.exec("CREATE TABLE items (value TEXT)"));
	assert.ok(existsSync(`${path}-wal`));
	await database.close();
	assert.equal(existsSync(`${path}-wal`), false);
});
