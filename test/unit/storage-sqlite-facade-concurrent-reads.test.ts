import assert from "node:assert/strict";
import {
	createSqliteDatabase,
	type FencedPathId,
	type SqliteDatabase,
	type SqliteDriver,
	type SqliteDriverResult,
	type SqliteTransactionOptions,
	STORAGE_QUEUED_CALL_MAX_WAIT_MS,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";

const EMPTY: SqliteDriverResult = { columns: [], rows: [], changes: 0 };

/** Each driver's way to answer every hold, now and after, so a failed test still closes its database. */
const openings = new Set<() => void>();

/**
 * A driver that runs reads beside each other, as a libSQL server's does, up to `concurrentReads` at once. A statement
 * `hold <name>` or `SELECT hold <name>`, in a transaction or alone, stays unanswered until `release(name)`.
 */
function readingDriver(overrides: Partial<SqliteDriver> = {}) {
	const gates = new Map<string, () => void>();
	let opened = false;
	openings.add(() => {
		opened = true;
		for (const gate of gates.values()) gate();
	});
	const hold = async (sql: string) => {
		const name = /^(?:SELECT )?hold (.+)$/.exec(sql)?.[1];
		if (name === undefined || opened) return EMPTY;
		await new Promise<void>((resolve) => gates.set(name, resolve));
		gates.delete(name);
		return EMPTY;
	};
	const driver: SqliteDriver = {
		descriptor: { adapter: "reading", location: "reading://database" },
		concurrentReads: 2,
		readsOnly: (sql) => sql.startsWith("SELECT "),
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

const READ: SqliteTransactionOptions = { readOnly: true };
/** Stands in for `fencedPath(name)`. */
const AUDITED = "test-path" as FencedPathId;
const domain = (name: string): SqliteTransactionOptions => ({ concurrency: { kind: "serial", domain: name } });

test("read-only transactions run beside each other, up to the driver's limit, in call order (#6565)", async () => {
	const reading = readingDriver();
	const database = open(reading.driver);
	const reads = ["r1", "r2", "r3"].map((name) => database.transaction((tx) => tx.all(`hold ${name}`), READ));
	await settle();
	assert.deepEqual(reading.running(), ["r1", "r2"]);
	reading.release("r2");
	await settle();
	assert.deepEqual(reading.running(), ["r1", "r3"]);
	reading.release("r1");
	reading.release("r3");
	await Promise.all(reads);
});

test("a lone statement the driver says only reads runs beside other reads; any other runs alone (#6565)", async () => {
	const reading = readingDriver();
	const database = open(reading.driver);
	const read = database.transaction((tx) => tx.all("hold load"), READ);
	const select = database.all("SELECT hold lookup");
	const write = database.run("hold insert");
	await settle();
	assert.deepEqual(reading.running(), ["load", "lookup"]);
	reading.release("load");
	reading.release("lookup");
	await settle();
	assert.deepEqual(reading.running(), ["insert"]);
	reading.release("insert");
	await Promise.all([read, select, write]);
});

test("writes keep their turn: a domain transaction runs alone on a driver that runs only reads concurrently (#6565)", async () => {
	const reading = readingDriver();
	const database = open(reading.driver);
	const first = database.transaction((tx) => tx.run("hold a"), domain("a"));
	const other = database.transaction((tx) => tx.run("hold b"), domain("b"));
	const fenced = database.transaction((tx) => tx.run("hold fenced"), {
		concurrency: { kind: "fenced", audit: AUDITED },
	});
	await settle();
	assert.deepEqual(reading.running(), ["a"]);
	reading.release("a");
	await settle();
	assert.deepEqual(reading.running(), ["b"]);
	reading.release("b");
	await settle();
	assert.deepEqual(reading.running(), ["fenced"]);
	reading.release("fenced");
	await Promise.all([first, other, fenced]);
});

test("a read waits for the write before it, and a write waits for the reads before it (#6565)", async () => {
	const reading = readingDriver();
	const database = open(reading.driver);
	const write = database.transaction((tx) => tx.run("hold append"));
	const read = database.transaction((tx) => tx.all("hold load"), READ);
	const lookup = database.get("SELECT hold lookup");
	const laterWrite = database.transaction((tx) => tx.run("hold later"));
	await settle();
	assert.deepEqual(reading.running(), ["append"]);
	reading.release("append");
	await settle();
	assert.deepEqual(reading.running(), ["load", "lookup"]);
	reading.release("load");
	await settle();
	assert.deepEqual(reading.running(), ["lookup"]);
	reading.release("lookup");
	await settle();
	assert.deepEqual(reading.running(), ["later"]);
	reading.release("later");
	await Promise.all([write, read, lookup, laterWrite]);
});

test("a driver without concurrentReads runs every call in turn (#6565)", async () => {
	const reading = readingDriver({ concurrentReads: undefined });
	const database = open(reading.driver);
	const reads = ["r1", "r2"].map((name) => database.transaction((tx) => tx.all(`hold ${name}`), READ));
	const select = database.all("SELECT hold lookup");
	await settle();
	assert.deepEqual(reading.running(), ["r1"]);
	reading.release("r1");
	await settle();
	assert.deepEqual(reading.running(), ["r2"]);
	reading.release("r2");
	await settle();
	assert.deepEqual(reading.running(), ["lookup"]);
	reading.release("lookup");
	await Promise.all([...reads, select]);
});

test("a read waiting for a free place fails at the queued-call bound when the running reads never settle (#6565)", async () => {
	vi.useFakeTimers();
	const reading = readingDriver({ concurrentReads: 1 });
	const database = open(reading.driver);
	const stuck = database.transaction((tx) => tx.all("hold stuck"), READ);
	const waiting = database.transaction((tx) => tx.all("waiting"), READ);
	const outcome = waiting.then(
		() => "ran",
		(error) => (error instanceof StorageUnavailableError ? "stalled" : String(error)),
	);
	await vi.advanceTimersByTimeAsync(STORAGE_QUEUED_CALL_MAX_WAIT_MS - 1);
	assert.deepEqual(reading.running(), ["stuck"]);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(await outcome, "stalled");
	reading.release("stuck");
	await stuck;
});

test("closing waits for the reads under way, then closes the driver once (#6565)", async () => {
	const events: string[] = [];
	const reading = readingDriver({ close: () => void events.push("driver closed") });
	const database = createSqliteDatabase(reading.driver);
	const reads = ["r1", "r2"].map((name) =>
		database.transaction((tx) => tx.all(`hold ${name}`), READ).then(() => void events.push(name)),
	);
	await settle();
	const closed = database.close();
	await settle();
	assert.deepEqual(events, []);
	reading.release("r2");
	reading.release("r1");
	await closed;
	await Promise.all(reads);
	assert.deepEqual(events, ["r2", "r1", "driver closed"]);
});
