import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** How long each write to a file descriptor takes here: a disk slower than the transaction around it. */
const SLOW_WRITE_MS = 20;
/** Bound, in real milliseconds, on the wait for a held record to land on that disk. */
const RECORD_WRITE_WAIT_MS = 2_000;
/** When the other connection writes: while the transaction would wait for its record on that slow disk. */
const OTHER_WRITER_DELAY_MS = 5;
/** The other connection's busy wait, which holds this thread until the lock is free or it gives up. */
const OTHER_WRITER_BUSY_TIMEOUT_MS = 1_000;

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		write(...args: unknown[]) {
			setTimeout(() => (actual.write as (...writeArgs: unknown[]) => void)(...args), SLOW_WRITE_MS);
		},
	};
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("a connection's write-lock record says held while its transaction runs and free as soon as it settled, however slow the disk (#4316)", async () => {
	const directory = makeTempDirectory("atomic-holder-record-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "records.sqlite");
	// The test setup loads the adapter before this file's slow disk applies; load it again on that disk.
	vi.resetModules();
	const { openNodeSqliteDatabase } = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
	const database = await openNodeSqliteDatabase(path);
	cleanups.push(() => database.close());
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const holders = `${path}-holders`;
	const record = () => {
		const [name] = readdirSync(holders).filter((entry) => entry.startsWith(`${process.pid}-`));
		return readFileSync(join(holders, name!), "utf8").slice(0, 4);
	};

	let during = "";
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('recorded')");
		// Taking the lock never waits for the disk; the record says held soon after.
		for (let turn = 0; turn < RECORD_WRITE_WAIT_MS && record() !== "held"; turn++) await realSleep(1);
		during = record();
	});

	assert.equal(during, "held");
	assert.equal(record(), "free", "a settled transaction's record says free at once");
});

test("another connection in this process writes while a transaction's lock record is still being written (#4245)", async () => {
	const directory = makeTempDirectory("atomic-holder-record-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "records.sqlite");
	vi.resetModules();
	const { openNodeSqliteDatabase } = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
	const first = await openNodeSqliteDatabase(path);
	cleanups.push(() => first.close());
	await first.exec("CREATE TABLE items (value TEXT NOT NULL)");
	// A statement outside a transaction waits for the lock in SQLite's busy handler, which blocks this thread.
	const second = await openNodeSqliteDatabase(path, { busyTimeoutMs: OTHER_WRITER_BUSY_TIMEOUT_MS });
	cleanups.push(() => second.close());

	const transaction = first.transaction((tx) => tx.run("INSERT INTO items VALUES ('first')"));
	const statement = new Promise((resolve, reject) => {
		setTimeout(() => second.run("INSERT INTO items VALUES ('second')").then(resolve, reject), OTHER_WRITER_DELAY_MS);
	});

	await Promise.all([transaction, statement]);
	assert.deepEqual(
		(await first.all<{ value: string }>("SELECT value FROM items ORDER BY value")).map((row) => row.value),
		["first", "second"],
	);
});
