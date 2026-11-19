import assert from "node:assert/strict";
import {
	createSqliteDatabase,
	type SqliteDriverResult,
	type SqliteStatement,
	STORAGE_PRIORITY_CALL_MAX_WAIT_MS,
	STORAGE_QUEUED_CALL_MAX_WAIT_MS,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { test, vi } from "vitest";

const EMPTY: SqliteDriverResult = { columns: [], rows: [], changes: 0 };

test("a priority batch runs before calls queued ahead of it, one call at a time, and the rest keep their order (#4768)", async () => {
	const ran: string[] = [];
	let running = 0;
	let release!: () => void;
	const first = new Promise<void>((resolve) => {
		release = resolve;
	});
	const database = createSqliteDatabase({
		descriptor: { adapter: "ordered", location: "memory" },
		async execute(sql) {
			running++;
			assert.equal(running, 1, "one call at a time");
			if (sql === "first") await first;
			ran.push(sql);
			running--;
			return EMPTY;
		},
		executeMultiple() {},
		beginTransaction: () => assert.fail("no transaction"),
		async batch(statements: readonly SqliteStatement[]) {
			running++;
			assert.equal(running, 1, "one call at a time");
			ran.push(statements.map((statement) => statement.sql).join("+"));
			running--;
			return statements.map(() => EMPTY);
		},
		close() {},
	});
	const calls = [
		database.run("first"),
		database.run("second"),
		database.batch!([{ sql: "third", params: [] }]),
		database.batch!([{ sql: "renewal", params: [] }], { priority: true }),
		database.run("fourth"),
	];
	await new Promise((resolve) => setImmediate(resolve));
	release();
	await Promise.all(calls);
	assert.deepEqual(ran, ["first", "renewal", "second", "third", "fourth"]);
	await database.close();
});

test("a batch that finds the write lock busy waits for its next send outside the call queue, so a renewal goes through meanwhile (#4768)", async () => {
	const ran: string[] = [];
	let busyLeft = 3;
	const database = createSqliteDatabase({
		descriptor: { adapter: "busy", location: "memory" },
		execute: () => EMPTY,
		executeMultiple() {},
		beginTransaction: () => assert.fail("no transaction"),
		async batch(statements: readonly SqliteStatement[]) {
			const name = statements.map((statement) => statement.sql).join("+");
			if (name === "write" && busyLeft-- > 0)
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			ran.push(name);
			return statements.map(() => EMPTY);
		},
		lockBusy: (failure) => (failure as { cause?: { code?: string } }).cause?.code === "SQLITE_BUSY",
		close() {},
	});
	const write = database.batch!([{ sql: "write", params: [] }], { lockWaitMs: 60_000 });
	// Queued after the write's first send failed, and before its next send.
	await new Promise((resolve) => setImmediate(resolve));
	await database.batch!([{ sql: "renewal", params: [] }], { priority: true });
	await write;
	assert.deepEqual(ran, ["renewal", "write"]);
	await database.close();
});

test("a busy batch fails once its lockWaitMs has passed, and at once without one (#4768)", async () => {
	let sends = 0;
	const database = createSqliteDatabase({
		descriptor: { adapter: "busy", location: "memory" },
		execute: () => EMPTY,
		executeMultiple() {},
		beginTransaction: () => assert.fail("no transaction"),
		batch() {
			sends++;
			throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		},
		lockBusy: (failure) => (failure as { cause?: { code?: string } }).cause?.code === "SQLITE_BUSY",
		close() {},
	});
	await assert.rejects(database.batch!([{ sql: "write", params: [] }]));
	assert.equal(sends, 1);
	sends = 0;
	await assert.rejects(database.batch!([{ sql: "write", params: [] }], { lockWaitMs: 200 }));
	assert.ok(sends > 1, `sent ${sends} times`);
	await database.close();
});

/** A driver whose batches find the lock busy every time, counting its sends. */
function alwaysBusy() {
	const sent = { count: 0 };
	const database = createSqliteDatabase({
		descriptor: { adapter: "busy", location: "memory" },
		execute: () => EMPTY,
		executeMultiple() {},
		beginTransaction: () => assert.fail("no transaction"),
		batch() {
			sent.count++;
			throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		},
		lockBusy: (failure) => (failure as { cause?: { code?: string } }).cause?.code === "SQLITE_BUSY",
		close() {},
	});
	return { database, sent };
}

test("a busy batch with a lockWaitMs of 0 is sent once, and one waiting out a busy lock stops when the database closes (#4768)", async () => {
	const { database, sent } = alwaysBusy();
	await assert.rejects(database.batch!([{ sql: "write", params: [] }], { lockWaitMs: 0 }));
	assert.equal(sent.count, 1);
	const waiting = database.batch!([{ sql: "write", params: [] }], { lockWaitMs: 60_000 });
	await new Promise((resolve) => setTimeout(resolve, 50));
	await database.close();
	await assert.rejects(waiting, (error: Error) => error.name === "StoreClosedError");
});

test("closing waits for the call that is running before it closes the driver (#4768)", async () => {
	const order: string[] = [];
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const database = createSqliteDatabase({
		descriptor: { adapter: "slow", location: "memory" },
		async execute(sql) {
			await held;
			order.push(sql);
			return EMPTY;
		},
		executeMultiple() {},
		beginTransaction: () => assert.fail("no transaction"),
		batch: (statements: readonly SqliteStatement[]) => statements.map(() => EMPTY),
		close() {
			order.push("close");
		},
	});
	const running = database.run("slow");
	await new Promise((resolve) => setImmediate(resolve));
	const closing = database.close();
	await new Promise((resolve) => setTimeout(resolve, 20));
	release();
	await Promise.all([running, closing]);
	assert.deepEqual(order, ["slow", "close"]);
});

/** A driver whose `execute` of "stuck" never settles until `settle()`, and whose other calls take `runMs` each. */
function stuckDriver(runMs = 0) {
	const ran: string[] = [];
	let settle!: () => void;
	const database = createSqliteDatabase({
		descriptor: { adapter: "stuck", location: "memory" },
		async execute(sql) {
			if (sql === "stuck")
				await new Promise<void>((resolve) => {
					settle = resolve;
				});
			else await new Promise((resolve) => setTimeout(resolve, runMs));
			ran.push(sql);
			return EMPTY;
		},
		executeMultiple() {},
		beginTransaction: () => assert.fail("no transaction"),
		async batch(statements: readonly SqliteStatement[]) {
			ran.push(statements.map((statement) => statement.sql).join("+"));
			return statements.map(() => EMPTY);
		},
		close() {},
	});
	return { database, ran, settle: () => settle() };
}

function failure(call: Promise<unknown>): Promise<unknown> {
	return call.then(
		() => assert.fail("ran behind a stuck call"),
		(error: unknown) => error,
	);
}

test("behind a call that never settles, a priority call fails without running once that call has run STORAGE_PRIORITY_CALL_MAX_WAIT_MS, other calls once it has run STORAGE_QUEUED_CALL_MAX_WAIT_MS, and the queue serves calls again once it settles (#5114)", async () => {
	vi.useFakeTimers();
	try {
		const { database, ran, settle } = stuckDriver();
		const stuck = database.run("stuck");
		const failed = new Map<string, unknown>();
		void failure(database.batch!([{ sql: "renewal", params: [] }], { priority: true })).then((error) =>
			failed.set("renewal", error),
		);
		void failure(database.run("write")).then((error) => failed.set("write", error));
		await vi.advanceTimersByTimeAsync(STORAGE_PRIORITY_CALL_MAX_WAIT_MS - 1);
		assert.equal(failed.size, 0, "the call ahead may still settle");
		await vi.advanceTimersByTimeAsync(1);
		const renewal = failed.get("renewal");
		assert.ok(renewal instanceof StorageUnavailableError, String(renewal));
		assert.match(renewal.message, /ran 10 seconds without settling, and did not run/);
		assert.equal(failed.has("write"), false, "an ordinary call waits the longer bound");
		await vi.advanceTimersByTimeAsync(STORAGE_QUEUED_CALL_MAX_WAIT_MS - STORAGE_PRIORITY_CALL_MAX_WAIT_MS - 1);
		assert.equal(failed.has("write"), false);
		await vi.advanceTimersByTimeAsync(1);
		const write = failed.get("write");
		assert.ok(write instanceof StorageUnavailableError, String(write));
		assert.match(write.message, /ran 60 seconds without settling/);
		settle();
		await stuck;
		await database.batch!([{ sql: "next", params: [] }], { priority: true });
		assert.deepEqual(ran, ["stuck", "next"]);
		await database.close();
	} finally {
		vi.useRealTimers();
	}
});

test("a heartbeat behind a call that never settles fails in time to be tried again, and goes through on the next attempt (#5114)", async () => {
	vi.useFakeTimers();
	try {
		const { database, ran, settle } = stuckDriver();
		const stuck = database.run("stuck");
		const tries: number[] = [];
		const start = Date.now();
		/** How long a host waits before it tries a failed heartbeat again: its first retry wait, at most. */
		const RETRY_MS = 1_000;
		// A heartbeat as a worker host sends it: on the priority lane, tried again shortly after it fails.
		const heartbeat = (async () => {
			for (;;) {
				tries.push(Date.now() - start);
				try {
					return await database.batch!([{ sql: "heartbeat", params: [] }], { priority: true });
				} catch (error) {
					assert.ok(error instanceof StorageUnavailableError);
				}
				await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
			}
		})();
		await vi.advanceTimersByTimeAsync(STORAGE_PRIORITY_CALL_MAX_WAIT_MS + RETRY_MS);
		// The first try failed once the call ahead had run the priority bound; the second, behind a call that has already
		// run it, fails at once.
		assert.deepEqual(tries, [0, STORAGE_PRIORITY_CALL_MAX_WAIT_MS + RETRY_MS]);
		settle();
		await stuck;
		await vi.advanceTimersByTimeAsync(RETRY_MS);
		await heartbeat;
		assert.ok(Date.now() - start < 3 * STORAGE_PRIORITY_CALL_MAX_WAIT_MS);
		assert.deepEqual(ran, ["stuck", "heartbeat"]);
		await database.close();
	} finally {
		vi.useRealTimers();
	}
});

test("calls queued behind healthy work never fail, however long the queue: each call ahead gets the bounds from its own start (#5114)", async () => {
	vi.useFakeTimers();
	try {
		/** Each call runs most of the priority bound, so the queue as a whole runs far longer than either bound. */
		const RUN_MS = STORAGE_PRIORITY_CALL_MAX_WAIT_MS - 1_000;
		const { database, ran } = stuckDriver(RUN_MS);
		const calls = [
			...Array.from({ length: 8 }, (_, index) => database.run(`write-${index}`)),
			database.batch!([{ sql: "renewal", params: [] }], { priority: true }),
		];
		await vi.advanceTimersByTimeAsync(8 * RUN_MS);
		await Promise.all(calls);
		assert.deepEqual(ran, ["write-0", "renewal", ...Array.from({ length: 7 }, (_, index) => `write-${index + 1}`)]);
		await database.close();
	} finally {
		vi.useRealTimers();
	}
});

test("a call queued after the running call has run a while fails once that call has run its bound since it started, and at once when it already has (#5114)", async () => {
	vi.useFakeTimers();
	try {
		const { database, settle } = stuckDriver();
		const stuck = database.run("stuck");
		await vi.advanceTimersByTimeAsync(STORAGE_QUEUED_CALL_MAX_WAIT_MS - 10_000);
		const failed = new Map<string, unknown>();
		const write = failure(database.run("write")).then((error) => failed.set("write", error));
		await vi.advanceTimersByTimeAsync(10_000 - 1);
		assert.equal(failed.has("write"), false, "the call ahead has not yet run the whole bound");
		await vi.advanceTimersByTimeAsync(1);
		await write;
		assert.ok(failed.get("write") instanceof StorageUnavailableError);
		const late = failure(database.run("late"));
		const renewal = failure(database.batch!([{ sql: "renewal", params: [] }], { priority: true }));
		await vi.advanceTimersByTimeAsync(0);
		assert.ok((await late) instanceof StorageUnavailableError);
		assert.ok((await renewal) instanceof StorageUnavailableError);
		settle();
		await stuck;
		await database.close();
	} finally {
		vi.useRealTimers();
	}
});

test("a priority call queued behind ordinary calls that wait on a call that never settles still fails at STORAGE_PRIORITY_CALL_MAX_WAIT_MS (#5114)", async () => {
	vi.useFakeTimers();
	try {
		const { database, settle } = stuckDriver();
		const stuck = database.run("stuck");
		const failed = new Map<string, unknown>();
		void failure(database.run("write")).then((error) => failed.set("write", error));
		await vi.advanceTimersByTimeAsync(1_000);
		void failure(database.batch!([{ sql: "renewal", params: [] }], { priority: true })).then((error) =>
			failed.set("renewal", error),
		);
		await vi.advanceTimersByTimeAsync(STORAGE_PRIORITY_CALL_MAX_WAIT_MS - 1_000);
		assert.ok(failed.get("renewal") instanceof StorageUnavailableError, "the renewal failed while its lease holds");
		assert.equal(failed.has("write"), false, "the ordinary call still waits");
		await vi.advanceTimersByTimeAsync(STORAGE_QUEUED_CALL_MAX_WAIT_MS - STORAGE_PRIORITY_CALL_MAX_WAIT_MS);
		assert.ok(failed.get("write") instanceof StorageUnavailableError);
		settle();
		await stuck;
		await database.close();
	} finally {
		vi.useRealTimers();
	}
});
