import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function databasePath(): string {
	const directory = makeTempDirectory("atomic-database-open-");
	cleanups.push(() => removeTempDirectory(directory));
	return join(directory, "store.sqlite");
}

test("opening a database waits for its connection's thread twice: the open, then its settings in one request", async () => {
	const path = databasePath();
	let inFlight = 0;
	let waits = 0;
	const interception = interceptConnectionRequests((request, send) => {
		if (inFlight === 0) waits += 1;
		inFlight += 1;
		return send(request).finally(() => {
			inFlight -= 1;
		});
	});
	cleanups.push(() => interception.restore());
	for (const existing of [false, true]) {
		waits = 0;
		const database = await openNodeSqliteDatabase(path);
		assert.equal(waits, 2, existing ? "an existing file" : "a new file");
		const settings = await Promise.all(
			["busy_timeout", "journal_mode", "synchronous", "foreign_keys"].map((name) => database.get(`PRAGMA ${name}`)),
		);
		assert.deepEqual(
			settings.map((row) => Object.values(row ?? {})[0]),
			[5000, "wal", 2, 1],
		);
		const records = readdirSync(`${path}-holders`).filter((name) => name.startsWith(`${process.pid}-`));
		assert.equal(records.length, 1, "its write-lock record is there once the open resolved");
		await database.close();
	}
});

test("an open whose settings fail closes what it opened: no write-lock record is left, and the file opens again", async () => {
	const path = databasePath();
	const failing = interceptConnectionRequests((request, send) =>
		request.kind === "exec" && request.sql.includes("PRAGMA journal_mode")
			? Promise.reject(Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 }))
			: send(request),
	);
	cleanups.push(() => failing.restore());
	await assert.rejects(openNodeSqliteDatabase(path), StorageUnavailableError);
	failing.restore();
	const holders = `${path}-holders`;
	const records = existsSync(holders) ? readdirSync(holders).filter((name) => name.startsWith(`${process.pid}-`)) : [];
	assert.deepEqual(records, [], "no write-lock record of this process is left");
	const database = await openNodeSqliteDatabase(path);
	await database.exec("CREATE TABLE items (value TEXT)");
	await database.close();
});
