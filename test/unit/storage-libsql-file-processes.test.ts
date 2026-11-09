import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { openLibsqlDatabase as openAdapterDatabase } from "../../packages/storage-libsql/libsql.js";
import { openLibsqlDatabase } from "../fixtures/storage-libsql-wrapper.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { decodeStream, readStreamText, sleep, spawnProcess } from "../helpers/runtime.js";
import { holdSqliteWriteLock } from "../helpers/sqlite-lock-holder.js";

const writer = fileURLToPath(new URL("../fixtures/storage-libsql-file-writer.mjs", import.meta.url));
const committer = fileURLToPath(new URL("../fixtures/storage-sqlite-busy-committer.mjs", import.meta.url));
const WRITERS = 4;
const ROUNDS = 100;
/** The adapter's busy timeout for a local file (`FILE_BUSY_TIMEOUT_MS`): one wait of SQLite's busy handler. */
const ADAPTER_BUSY_TIMEOUT_MS = 5_000;
/**
 * How long the other process keeps the lock for each of its commits: far longer than the moment between its commit
 * and its next `BEGIN IMMEDIATE`, so SQLite's busy handler, which polls for the lock, finds it free almost never.
 */
const COMMIT_HOLD_MS = 100;
/** How long the other process keeps committing: past two busy timeouts, each of which sees it commit. */
const COMMITTING_MS = ADAPTER_BUSY_TIMEOUT_MS * 2.5;

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

test(
	"a write waits for another process that keeps committing past the busy timeout instead of failing with SQLITE_BUSY",
	async () => {
		const directory = makeLibsqlDirectory();
		try {
			const path = join(directory, "shared.sqlite");
			const database = await openAdapterDatabase({ url: pathToFileURL(path).href });
			try {
				await database.exec("CREATE TABLE writes(n INTEGER NOT NULL)");
				const other = spawnProcess(
					[process.execPath, committer, path, String(COMMIT_HOLD_MS), String(COMMITTING_MS)],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const stderr = readStreamText(other.stderr);
				const stdout = decodeStream(other.stdout!).getReader();
				let output = "";
				const readUntil = async (text: string) => {
					while (!output.includes(text)) {
						const { done, value } = await stdout.read();
						if (done)
							assert.fail(
								`the committing process exited before it printed ${JSON.stringify(text)}: ${await stderr}`,
							);
						output += value;
					}
				};
				await readUntil("committing\n");
				// The lock changes hands every COMMIT_HOLD_MS: the write is behind a process that is making progress.
				await database.run("INSERT INTO writes VALUES (1)");
				await readUntil("committed ");
				assert.equal(await other.exited, 0, await stderr);
				assert.equal(Number((await database.get("SELECT COUNT(*) AS count FROM writes"))?.count), 1);
			} finally {
				await database.close();
			}
		} finally {
			await removeLibsqlDirectory(directory);
		}
	},
	ADAPTER_BUSY_TIMEOUT_MS * 12,
);

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

test("a write that gave up on another process's lock leaves the file usable: later writes and transactions commit", async () => {
	const directory = makeLibsqlDirectory();
	try {
		const path = join(directory, "shared.sqlite");
		const database = await openAdapterDatabase({ url: pathToFileURL(path).href });
		try {
			await database.exec("CREATE TABLE writes(n INTEGER NOT NULL)");
			// The first wait gives up at once; the write runs again on a new connection, which waits one busy timeout in
			// which the holder commits nothing, and then fails the same way.
			await database.exec("PRAGMA busy_timeout = 0");
			const holder = await holdSqliteWriteLock(path);
			try {
				await assert.rejects(database.run("INSERT INTO writes VALUES (1)"), (error: Error) => {
					assert.match(String((error.cause as Error | undefined)?.message), /SQLITE_BUSY: database is locked/);
					return true;
				});
			} finally {
				await holder.release();
			}

			await database.transaction(async (transaction) => {
				await transaction.run("INSERT INTO writes VALUES (2)");
			});
			await database.run("INSERT INTO writes VALUES (3)");
		} finally {
			await database.close();
		}
		// Read from another connection: a write the failed statement's connection kept uncommitted is not saved.
		const reader = await openLibsqlDatabase({ url: pathToFileURL(path).href });
		try {
			assert.deepEqual(
				(await reader.all<{ n: number }>("SELECT n FROM writes ORDER BY n")).map((row) => Number(row.n)),
				[2, 3],
			);
		} finally {
			await reader.close();
		}
	} finally {
		await removeLibsqlDirectory(directory);
	}
});
