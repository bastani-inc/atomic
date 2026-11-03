import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { openLibsqlDatabase as openAdapterDatabase } from "../../packages/storage-libsql/libsql.js";
import { openLibsqlDatabase } from "../fixtures/storage-libsql-wrapper.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { readStreamText, sleep, spawnProcess } from "../helpers/runtime.js";
import { holdSqliteWriteLock } from "../helpers/sqlite-lock-holder.js";

const writer = fileURLToPath(new URL("../fixtures/storage-libsql-file-writer.mjs", import.meta.url));
const WRITERS = 4;
const ROUNDS = 100;

test("several processes write one libSQL file at once without a failed statement", async () => {
	const directory = makeLibsqlDirectory();
	try {
		const url = pathToFileURL(join(directory, "shared.sqlite")).href;
		// The file exists, as a database does before several processes open it.
		await (await openLibsqlDatabase({ url })).close();
		const processes = Array.from({ length: WRITERS }, (_, index) =>
			spawnProcess([process.execPath, writer, url, String(index), String(ROUNDS)], {
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const reports = await Promise.all(
			processes.map(async (child) => {
				const [stdout, stderr, code] = await Promise.all([
					readStreamText(child.stdout),
					readStreamText(child.stderr),
					child.exited,
				]);
				assert.equal(code, 0, stderr);
				return JSON.parse(stdout) as { writer: number; written: number; failures: string[]; failed: number };
			}),
		);
		for (const report of reports)
			assert.deepEqual([report.failed, report.failures], [0, []], `writer ${report.writer}`);
		const database = await openLibsqlDatabase({ url });
		try {
			assert.equal(
				Number((await database.get("SELECT COUNT(*) AS count FROM writes"))?.count),
				WRITERS * ROUNDS * 3,
			);
			// Several processes share the file through the write-ahead log, as Atomic's own SQLite stores do.
			assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
		} finally {
			await database.close();
		}
	} finally {
		await removeLibsqlDirectory(directory);
	}
}, 120_000);

test("opening a libSQL file another process is writing waits for its lock to switch the file to the write-ahead log (#4270)", async () => {
	const directory = makeLibsqlDirectory();
	try {
		const path = join(directory, "shared.sqlite");
		// The file is still in the rollback journal, as a new file or one from before the adapter used WAL is.
		const holder = await holdSqliteWriteLock(path);
		const opening = openAdapterDatabase({ url: pathToFileURL(path).href });
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
	} finally {
		await removeLibsqlDirectory(directory);
	}
});
