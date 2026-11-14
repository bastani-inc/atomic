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
