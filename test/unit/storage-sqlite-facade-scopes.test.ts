import assert from "node:assert/strict";
import {
	createSqliteDatabase,
	type SqliteDatabase,
	type SqliteDriver,
	type SqliteDriverResult,
	type SqliteStatement,
	type SqliteTransactionOptions,
	STORAGE_PRIORITY_CALL_MAX_WAIT_MS,
	STORAGE_QUEUED_CALL_MAX_WAIT_MS,
	StorageUnavailableError,
	StoreClosedError,
} from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";

const EMPTY: SqliteDriverResult = { columns: [], rows: [], changes: 0 };

/**
 * A driver that runs transactions concurrently, as PostgreSQL's does. A statement `hold <name>`, in a transaction or
 * alone, stays unanswered until `release(name)`; `running()` lists the holds that started and are not released.
 */
/** Each driver's way to answer every hold, now and after, so a failed test still closes its database. */
const openings = new Set<() => void>();

function heldDriver(overrides: Partial<SqliteDriver> = {}) {
	const gates = new Map<string, () => void>();
	let opened = false;
	openings.add(() => {
		opened = true;
		for (const gate of gates.values()) gate();
	});
	const started: string[] = [];
	const hold = async (sql: string) => {
		const name = /^hold (.+)$/.exec(sql)?.[1];
		if (name === undefined || opened) return EMPTY;
		started.push(name);
		await new Promise<void>((resolve) => gates.set(name, resolve));
		gates.delete(name);
		return EMPTY;
	};
	const driver: SqliteDriver = {
		descriptor: { adapter: "held", location: "held://database" },
		concurrentTransactions: true,
		execute: (sql) => hold(sql),
		executeMultiple: () => {},
		beginTransaction: () => ({
			execute: (sql) => hold(sql),
			executeMultiple: () => {},
			commit: () => {},
			rollback: () => {},
		}),
		close: () => {},
		...overrides,
	};
	return {
		driver,
		started,
		running: () => [...gates.keys()].sort(),
		release: (name: string) => {
			const gate = gates.get(name);
			assert.ok(gate, `${name} is running`);
			gate();
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const databases: SqliteDatabase[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const open of openings) open();
	openings.clear();
	await Promise.all(databases.splice(0).map((database) => database.close()));
});

function open(driver: SqliteDriver): SqliteDatabase {
	const database = createSqliteDatabase(driver);
	databases.push(database);
	return database;
}

const domain = (name: string): SqliteTransactionOptions => ({ concurrency: { kind: "serial", domain: name } });
const READ: SqliteTransactionOptions = { readOnly: true };

test("transactions of different domains run at once, and one domain's keep their order (#6560)", async () => {
	const held = heldDriver();
	const database = open(held.driver);
	const calls = [
		database.transaction((tx) => tx.run("hold a1"), domain("a")),
		database.transaction((tx) => tx.run("hold b1"), domain("b")),
		database.transaction((tx) => tx.run("hold a2"), domain("a")),
	];
	await settle();
	assert.deepEqual(held.running(), ["a1", "b1"]);
	held.release("a1");
	await settle();
	assert.deepEqual(held.running(), ["a2", "b1"]);
	held.release("a2");
	held.release("b1");
	await Promise.all(calls);
});

/** A call of each scope, holding until released under `name`. */
const calls: Record<string, (database: SqliteDatabase, name: string) => Promise<unknown>> = {
	whole: (database, name) => database.transaction((tx) => tx.run(`hold ${name}`)),
	plain: (database, name) => database.run(`hold ${name}`),
	read: (database, name) => database.transaction((tx) => tx.all(`hold ${name}`), READ),
	"domain a": (database, name) => database.transaction((tx) => tx.run(`hold ${name}`), domain("a")),
	"domain b": (database, name) => database.transaction((tx) => tx.run(`hold ${name}`), domain("b")),
};

test("a call waits for an earlier unfinished call exactly when their scopes conflict (#6560)", async () => {
	// Whether a call of the column's scope, made while one of the row's runs, waits for it.
	const waits: Record<string, Record<string, boolean>> = {
		whole: { whole: true, plain: true, read: true, "domain a": true, "domain b": true },
		plain: { whole: true, plain: true, read: true, "domain a": true, "domain b": true },
		read: { whole: true, plain: true, read: false, "domain a": false, "domain b": false },
		"domain a": { whole: true, plain: true, read: true, "domain a": true, "domain b": false },
		"domain b": { whole: true, plain: true, read: true, "domain a": false, "domain b": true },
	};
	const observed: Record<string, Record<string, boolean>> = {};
	for (const earlier of Object.keys(waits)) {
		observed[earlier] = {};
		for (const later of Object.keys(waits)) {
			const held = heldDriver();
			const database = open(held.driver);
			const first = calls[earlier]!(database, "first");
			const second = calls[later]!(database, "second");
			await settle();
			observed[earlier]![later] = !held.running().includes("second");
			held.release("first");
			if (observed[earlier]![later]) await settle();
			held.release("second");
			await Promise.all([first, second]);
		}
	}
	assert.deepEqual(observed, waits);
});

test("a read-only transaction waits for the write queued before it, while the writes queued after it run (#6560)", async () => {
	const held = heldDriver();
	const database = open(held.driver);
	const write = database.transaction((tx) => tx.run("hold append"), domain("a"));
	const read = database.transaction((tx) => tx.all("hold load"), READ);
	const otherRead = database.transaction((tx) => tx.all("hold other load"), READ);
	const laterWrite = database.transaction((tx) => tx.run("hold later append"), domain("b"));
	await settle();
	assert.deepEqual(held.running(), ["append", "later append"]);
	held.release("append");
	await settle();
	// Both reads start together once the write before them settled.
	assert.deepEqual(held.running(), ["later append", "load", "other load"]);
	for (const name of held.running()) held.release(name);
	await Promise.all([write, read, otherRead, laterWrite]);
});

test("a whole-database transaction waits for every call before it, and every call after it waits for it (#6560)", async () => {
	const held = heldDriver();
	const database = open(held.driver);
	const before = [
		database.transaction((tx) => tx.all("hold read"), READ),
		database.transaction((tx) => tx.run("hold a"), domain("a")),
	];
	const whole = database.transaction((tx) => tx.run("hold whole"));
	const after = database.transaction((tx) => tx.run("hold b"), domain("b"));
	await settle();
	assert.deepEqual(held.running(), ["a", "read"]);
	held.release("a");
	held.release("read");
	await settle();
	assert.deepEqual(held.running(), ["whole"]);
	held.release("whole");
	await settle();
	assert.deepEqual(held.running(), ["b"]);
	held.release("b");
	await Promise.all([...before, whole, after]);
});

test("a priority batch goes ahead of the waiting calls, not of those running (#6560)", async () => {
	const ran: string[] = [];
	const held = heldDriver({
		batch: (statements: readonly SqliteStatement[]) => {
			ran.push(statements.map((statement) => statement.sql).join("+"));
			return statements.map(() => EMPTY);
		},
	});
	const database = open(held.driver);
	const running = database.transaction((tx) => tx.run("hold a"), domain("a"));
	const waiting = database.run("second").then(() => void ran.push("second"));
	const renewal = database.batch!([{ sql: "renewal", params: [] }], { priority: true });
	await settle();
	assert.deepEqual(ran, []);
	held.release("a");
	await Promise.all([running, waiting, renewal]);
	assert.deepEqual(ran, ["renewal", "second"]);
});

test("calls waiting behind a call that does not settle fail at their bound, and calls beside it run (#6560)", async () => {
	vi.useFakeTimers();
	const held = heldDriver({ batch: (statements) => statements.map(() => EMPTY) });
	const database = open(held.driver);
	const stuck = database.transaction((tx) => tx.run("hold stuck"), domain("a"));
	const outcomes: string[] = [];
	const note = (name: string, call: Promise<unknown>) =>
		call.then(
			() => void outcomes.push(`${name} ran`),
			(error) => void outcomes.push(`${name} ${error instanceof StorageUnavailableError ? "stalled" : error}`),
		);
	const calls = [
		note(
			"beside",
			database.transaction((tx) => tx.run("beside"), domain("b")),
		),
		note(
			"same domain",
			database.transaction((tx) => tx.run("same"), domain("a")),
		),
		note(
			"whole",
			database.transaction((tx) => tx.run("whole")),
		),
		// Waits only for the whole-database transaction, which waits for the stuck one.
		note(
			"behind whole",
			database.transaction((tx) => tx.run("behind"), domain("b")),
		),
		note("renewal", database.batch!([{ sql: "renewal", params: [] }], { priority: true })),
		note(
			"read",
			database.transaction((tx) => tx.all("read"), READ),
		),
	];
	await vi.advanceTimersByTimeAsync(STORAGE_PRIORITY_CALL_MAX_WAIT_MS - 1);
	assert.deepEqual(outcomes, ["beside ran"]);
	await vi.advanceTimersByTimeAsync(1);
	assert.deepEqual(outcomes, ["beside ran", "renewal stalled"]);
	await vi.advanceTimersByTimeAsync(STORAGE_QUEUED_CALL_MAX_WAIT_MS - STORAGE_PRIORITY_CALL_MAX_WAIT_MS - 1);
	assert.equal(outcomes.length, 2);
	await vi.advanceTimersByTimeAsync(1);
	assert.deepEqual(outcomes.slice(2).sort(), [
		"behind whole stalled",
		"read stalled",
		"same domain stalled",
		"whole stalled",
	]);
	held.release("stuck");
	await Promise.all([stuck, ...calls]);
});

test("closing waits for the running and the waiting calls, then closes the driver once (#6560)", async () => {
	const events: string[] = [];
	const held = heldDriver({ close: () => void events.push("driver closed") });
	const database = createSqliteDatabase(held.driver);
	const calls = [
		database.transaction((tx) => tx.run("hold a"), domain("a")).then(() => void events.push("a")),
		database.transaction((tx) => tx.run("hold b"), domain("b")).then(() => void events.push("b")),
		database.transaction((tx) => tx.run("after a"), domain("a")).then(() => void events.push("after a")),
	];
	const closed = database.close();
	await assert.rejects(
		database.transaction(async () => {}, domain("c")),
		StoreClosedError,
	);
	await settle();
	assert.deepEqual(events, []);
	held.release("b");
	held.release("a");
	await closed;
	await Promise.all(calls);
	assert.deepEqual(events, ["b", "a", "after a", "driver closed"]);
});

test("a reader runs its calls on its own driver beside the main handle's, and closes with it (#6560)", async () => {
	const events: string[] = [];
	const reader = heldDriver({ close: () => void events.push("reader closed") });
	const main = heldDriver({
		openReader: () => reader.driver,
		close: () => void events.push("main closed"),
	});
	const database = createSqliteDatabase(main.driver);
	const write = database.transaction((tx) => tx.run("hold write"));
	const handle = await database.openReader!();
	assert.notEqual(handle, database);
	const read = handle.transaction((tx) => tx.all("hold read"), READ);
	const plain = handle.get("hold plain read");
	await settle();
	assert.deepEqual([main.running(), reader.running()], [["write"], ["read"]]);
	reader.release("read");
	await settle();
	assert.deepEqual(reader.running(), ["plain read"]);
	reader.release("plain read");
	await Promise.all([read, plain]);
	const closed = database.close();
	await assert.rejects(database.openReader!(), StoreClosedError);
	await assert.rejects(handle.get("after"), StoreClosedError);
	main.release("write");
	await Promise.all([write, closed]);
	assert.deepEqual(events, ["reader closed", "main closed"]);
});

test("a database whose driver opens no reader offers none (#6560)", async () => {
	const database = open(heldDriver().driver);
	assert.equal(database.openReader, undefined);
});
