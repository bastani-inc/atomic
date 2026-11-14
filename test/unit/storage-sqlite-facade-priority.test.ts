import assert from "node:assert/strict";
import { createSqliteDatabase, type SqliteDriverResult, type SqliteStatement } from "@bastani/atomic/storage";
import { test } from "vitest";

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
