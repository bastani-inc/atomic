import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const EXPECTED_WAL_AUTO_CHECKPOINT = 10_000;
const EXPECTED_JOURNAL_SIZE_LIMIT = 4 * 1024 * 1024;
/** One commit of a 3 KiB row writes a few 4 KiB WAL pages, so peak WAL stays tightly bounded above the 4 MiB limit. */
const SUSTAINED_WAL_PEAK_CAP_BYTES = EXPECTED_JOURNAL_SIZE_LIMIT + 512 * 1024;
/**
 * Upper bound on a passive checkpoint running while another connection holds BEGIN IMMEDIATE: PASSIVE never invokes
 * the 5000 ms busy handler, whereas RESTART or TRUNCATE would wait the full busy timeout.
 */
const PASSIVE_UNDER_WRITE_LOCK_BUDGET_MS = 2_500;
const ROW_PAYLOAD = "x".repeat(3000);

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function databasePath(): string {
	const directory = makeTempDirectory("atomic-wal-checkpoint-");
	cleanups.push(() => removeTempDirectory(directory));
	return join(directory, "store.sqlite");
}

async function open(path: string, readOnly = false): Promise<SqliteDatabase> {
	const database = await openNodeSqliteDatabase(path, { readOnly });
	cleanups.push(() => database.close());
	return database;
}

async function pragmaNumber(database: SqliteDatabase, name: string): Promise<number> {
	const row = await database.get<SqliteRow>(`PRAGMA ${name}`);
	assert.ok(row !== undefined, `PRAGMA ${name} returned a row`);
	return Number(Object.values(row)[0]);
}

function walBytes(path: string): number {
	return statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0;
}

test("writable file connections raise wal_autocheckpoint and cap journal_size_limit while read-only connections leave them alone (#6707)", async () => {
	const path = databasePath();
	const writer = await open(path);
	assert.equal(await pragmaNumber(writer, "wal_autocheckpoint"), EXPECTED_WAL_AUTO_CHECKPOINT);
	assert.equal(await pragmaNumber(writer, "journal_size_limit"), EXPECTED_JOURNAL_SIZE_LIMIT);

	const reader = await open(path, true);
	assert.equal(await pragmaNumber(reader, "wal_autocheckpoint"), 1000);
	assert.equal(await pragmaNumber(reader, "journal_size_limit"), -1);
});

test("the write-ahead log stays bounded near 4 MiB under sustained appends without hitting the safety-net threshold (#6707)", async () => {
	const path = databasePath();
	const writer = await open(path);
	await writer.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");

	// ~900 commits of 3 KiB rows produce ~11 MiB of WAL frames, well past 4 MiB and well below the 10000-page safety net.
	const commits = 900;
	let peakBytes = 0;
	for (let index = 0; index < commits; index++) {
		await writer.transaction((tx) => tx.run("INSERT INTO items (body) VALUES (?)", ROW_PAYLOAD));
		const size = walBytes(path);
		if (size > peakBytes) peakBytes = size;
	}
	assert.ok(
		peakBytes <= SUSTAINED_WAL_PEAK_CAP_BYTES,
		`peak WAL grew to ${peakBytes} bytes (cap ${SUSTAINED_WAL_PEAK_CAP_BYTES})`,
	);
	assert.equal(
		Number((await writer.get<SqliteRow & { count: number }>("SELECT count(*) AS count FROM items"))?.count),
		commits,
	);
});

test("after a long reader holding a snapshot ends, subsequent commits fold and shrink the WAL back under the 4 MiB limit (#6707)", async () => {
	const path = databasePath();
	const writer = await open(path);
	await writer.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
	await writer.run("INSERT INTO items (body) VALUES (?)", "seed");

	// Hold an open read snapshot while sustained commits push the WAL well past 4 MiB.
	const reader = await open(path, true);
	let releaseReader!: () => void;
	const readerHolding = new Promise<void>((resolve) => {
		void reader
			.transaction(
				async (tx) => {
					await tx.get("SELECT count(*) AS count FROM items");
					resolve();
					await new Promise<void>((done) => {
						releaseReader = done;
					});
				},
				{ readOnly: true },
			)
			.catch(() => {});
	});
	await readerHolding;

	const commitsDuringReader = 600;
	for (let index = 0; index < commitsDuringReader; index++) {
		await writer.transaction((tx) => tx.run("INSERT INTO items (body) VALUES (?)", ROW_PAYLOAD));
	}
	const peakWithReader = walBytes(path);
	assert.ok(
		peakWithReader > EXPECTED_JOURNAL_SIZE_LIMIT + 2 * 1024 * 1024,
		`expected WAL to grow past 6 MiB while reader held snapshot, got ${peakWithReader}`,
	);

	// Reads while the WAL is unchanged must succeed without altering the held WAL.
	assert.equal(
		Number((await writer.get<SqliteRow & { count: number }>("SELECT count(*) AS count FROM items"))?.count),
		commitsDuringReader + 1,
	);

	releaseReader();
	await reader.close();

	// While the WAL file is unchanged after the reader closes, plain reads must not trigger redundant checkpoints.
	const dbBytesBeforeCommit = statSync(path).size;
	assert.ok(
		dbBytesBeforeCommit < 1024 * 1024,
		`expected main database file to remain small while reader blocked checkpoints, got ${dbBytesBeforeCommit}`,
	);
	assert.equal(
		Number((await writer.get<SqliteRow & { count: number }>("SELECT count(*) AS count FROM items"))?.count),
		commitsDuringReader + 1,
	);
	assert.deepEqual(await writer.get("SELECT 1 AS ok"), { ok: 1 });
	assert.equal(
		statSync(path).size,
		dbBytesBeforeCommit,
		"unchanged WAL must not trigger a redundant checkpoint on reads",
	);

	// First commit after the reader ends advances the WAL and triggers post-response PASSIVE checkpointing of all
	// frames into the main database file.
	await writer.transaction((tx) => tx.run("INSERT INTO items (body) VALUES (?)", ROW_PAYLOAD));
	assert.deepEqual(await writer.get("SELECT 1 AS ok"), { ok: 1 });
	assert.ok(
		statSync(path).size > 2 * 1024 * 1024,
		`expected post-response PASSIVE to fold backlog into main database file, got ${statSync(path).size} bytes`,
	);

	// One more commit runs after that PASSIVE completed, resets the WAL to frame 1, and truncates it to 4 MiB.
	await writer.transaction((tx) => tx.run("INSERT INTO items (body) VALUES (?)", ROW_PAYLOAD));

	const shrunkBytes = walBytes(path);
	assert.ok(
		shrunkBytes <= EXPECTED_JOURNAL_SIZE_LIMIT,
		`expected WAL to shrink to <= ${EXPECTED_JOURNAL_SIZE_LIMIT} bytes after reader ended, got ${shrunkBytes}`,
	);
	assert.equal(
		Number((await writer.get<SqliteRow & { count: number }>("SELECT count(*) AS count FROM items"))?.count),
		commitsDuringReader + 3,
	);
});

test("no checkpoint runs inside an open transaction even when uncommitted writes push the WAL past 4 MiB (#6707)", async () => {
	const path = databasePath();
	const writer = await open(path);
	const reader = await open(path, true);
	await writer.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");

	// Write >5 MiB across multiple statements inside one transaction, then roll back.
	const largeChunk = "y".repeat(64 * 1024);
	await assert.rejects(
		writer.transaction(async (tx) => {
			for (let index = 0; index < 90; index++) {
				await tx.run("INSERT INTO items (body) VALUES (?)", largeChunk);
			}
			// Uncommitted pages have already spilled past 4 MiB into the WAL while the transaction is still open.
			assert.ok(
				walBytes(path) > EXPECTED_JOURNAL_SIZE_LIMIT,
				`expected WAL > 4 MiB mid-transaction, got ${walBytes(path)}`,
			);
			assert.equal(
				Number((await reader.get<SqliteRow & { count: number }>("SELECT count(*) AS count FROM items"))?.count),
				0,
			);
			throw new Error("abort transaction");
		}),
		/abort transaction/,
	);
	assert.equal(
		Number((await writer.get<SqliteRow & { count: number }>("SELECT count(*) AS count FROM items"))?.count),
		0,
	);

	// Now commit a >5 MiB transaction cleanly, then one more small commit brings the WAL back to <= 4 MiB.
	await writer.transaction(async (tx) => {
		for (let index = 0; index < 90; index++) {
			await tx.run("INSERT INTO items (body) VALUES (?)", largeChunk);
		}
	});
	await writer.transaction((tx) => tx.run("INSERT INTO items (body) VALUES (?)", "after"));
	assert.ok(
		walBytes(path) <= EXPECTED_JOURNAL_SIZE_LIMIT,
		`expected WAL <= 4 MiB after follow-up commit, got ${walBytes(path)}`,
	);
	assert.equal(
		Number((await writer.get<SqliteRow & { count: number }>("SELECT count(*) AS count FROM items"))?.count),
		91,
	);
});

test("post-response passive checkpoint does not block on or conflict with another writer holding BEGIN IMMEDIATE (#6707)", async () => {
	const path = databasePath();
	const writer = await open(path);
	await writer.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");

	// External connection pushes the WAL past 4 MiB and immediately holds BEGIN IMMEDIATE (WAL write lock).
	const other = new DatabaseSync(path);
	cleanups.push(() => other.close());
	other.exec("PRAGMA busy_timeout = 5000");
	const insert = other.prepare("INSERT INTO items (body) VALUES (?)");
	other.exec("BEGIN IMMEDIATE");
	for (let index = 0; index < 1_800; index++) insert.run(ROW_PAYLOAD);
	other.exec("COMMIT");
	assert.ok(
		walBytes(path) > EXPECTED_JOURNAL_SIZE_LIMIT,
		`expected external writes to push WAL past 4 MiB, got ${walBytes(path)}`,
	);

	other.exec("BEGIN IMMEDIATE");
	try {
		// This read sees the over-limit changed WAL and triggers post-response PASSIVE while `other` holds BEGIN IMMEDIATE.
		const started = performance.now();
		assert.equal(
			Number((await writer.get<SqliteRow & { count: number }>("SELECT count(*) AS count FROM items"))?.count),
			1_800,
		);
		// A second request on the same worker thread runs right after `maybeCheckpoint` finishes.
		assert.deepEqual(await writer.get("SELECT 1 AS ok"), { ok: 1 });
		const elapsedMs = performance.now() - started;
		assert.ok(
			elapsedMs < PASSIVE_UNDER_WRITE_LOCK_BUDGET_MS,
			`post-response checkpoint stalled for ${Math.round(elapsedMs)} ms under an external BEGIN IMMEDIATE`,
		);

		// External writer commits cleanly with zero lock conflict.
		insert.run("from-other");
		other.exec("COMMIT");
	} catch (error) {
		try {
			other.exec("ROLLBACK");
		} catch {}
		throw error;
	}

	assert.equal(
		Number((await writer.get<SqliteRow & { count: number }>("SELECT count(*) AS count FROM items"))?.count),
		1_801,
	);
});

test("concurrent writers sharing the writer queue stay conflict-free and keep the WAL bounded across checkpoints (#6707)", async () => {
	const path = databasePath();
	const writerA = await open(path);
	const writerB = await open(path);
	await writerA.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL)");

	const perWriter = 300;
	await Promise.all([
		(async () => {
			for (let index = 0; index < perWriter; index++) {
				await writerA.transaction((tx) =>
					tx.run("INSERT INTO items (owner, body) VALUES (?, ?)", "A", ROW_PAYLOAD),
				);
			}
		})(),
		(async () => {
			for (let index = 0; index < perWriter; index++) {
				await writerB.transaction((tx) =>
					tx.run("INSERT INTO items (owner, body) VALUES (?, ?)", "B", ROW_PAYLOAD),
				);
			}
		})(),
	]);

	// Drain any post-response passive checkpoints on both worker threads, then run two quiet commits so that even if
	// the last concurrent PASSIVE hit SQLITE_BUSY from the other worker's checkpoint, the first quiet commit folds
	// any remaining frames and the second restarts and truncates the WAL back to 4 MiB.
	await Promise.all([writerA.get("SELECT 1"), writerB.get("SELECT 1")]);
	await writerA.transaction((tx) => tx.run("INSERT INTO items (owner, body) VALUES (?, ?)", "A", "tail-1"));
	await writerA.transaction((tx) => tx.run("INSERT INTO items (owner, body) VALUES (?, ?)", "A", "tail-2"));
	assert.ok(
		walBytes(path) <= EXPECTED_JOURNAL_SIZE_LIMIT,
		`expected final WAL <= 4 MiB after concurrent writers, got ${walBytes(path)}`,
	);
	assert.equal(
		Number((await writerA.get<SqliteRow & { count: number }>("SELECT count(*) AS count FROM items"))?.count),
		perWriter * 2 + 2,
	);
});
