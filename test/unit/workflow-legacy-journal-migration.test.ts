import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import {
	StoragePayloadTooLargeError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { inspectJournalFile } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { migrateStageSessionCheckpoint } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	JOURNAL_SCHEMA_VERSION,
	type JournalEntry,
	JournalSchemaVersionError,
	RUN_EVENT_TYPES,
} from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { stripWorkflowOnlyOptions } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import { limitHeaderResponse, observeSqlReads } from "../helpers/observe-sql-reads.js";
import { makeTempDirectory, readText, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

function tempDirectory(): string {
	const directory = makeTempDirectory("legacy-journal-");
	directories.push(directory);
	return directory;
}

const legacyRun = {
	runId: "legacy-run",
	name: "goal",
	cwd: "/projects/legacy",
	createdAt: 1_790_000_000_000,
	status: "paused",
};

function writeLegacyJournal(path: string): void {
	const database = new DatabaseSync(path);
	try {
		database.exec(`
			CREATE TABLE meta(schema_version INTEGER NOT NULL);
			INSERT INTO meta VALUES (1);
			CREATE TABLE runs(
				run_id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL,
				created_at INTEGER NOT NULL, status TEXT NOT NULL, header_json TEXT NOT NULL
			);
			CREATE TABLE events(
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				seq INTEGER NOT NULL, epoch INTEGER NOT NULL, key TEXT,
				type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL,
				PRIMARY KEY(run_id, seq), UNIQUE(run_id, key)
			);
			CREATE TABLE leases(
				run_id TEXT PRIMARY KEY, holder_id TEXT, epoch INTEGER NOT NULL, renewed_at INTEGER NOT NULL
			);
		`);
		database
			.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)")
			.run(
				legacyRun.runId,
				legacyRun.name,
				legacyRun.cwd,
				legacyRun.createdAt,
				legacyRun.status,
				JSON.stringify(legacyRun),
			);
		database
			.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(
				legacyRun.runId,
				1,
				3,
				null,
				RUN_EVENT_TYPES.runStarted,
				JSON.stringify({ inputs: {} }),
				legacyRun.createdAt,
			);
		database
			.prepare("INSERT INTO leases VALUES (?, ?, ?, ?)")
			.run(legacyRun.runId, "old-process", 3, legacyRun.createdAt);
	} finally {
		database.close();
	}
}

for (const method of ["listRuns", "getRun"] as const)
	test(`${method} checks a current-table miss before returning a legacy header (#5537)`, async () => {
		const path = join(tempDirectory(), "schema.sqlite");
		writeLegacyJournal(path);
		const db = await openNodeSqliteDatabase(path),
			peer = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(db);
		let upgraded = false;
		const restore = observeSqlReads(db, {
			after: async (_rows, sql) => {
				if (!upgraded && sql.includes("wf_runs")) {
					upgraded = true;
					await peer.run("UPDATE wf_meta SET schema_version=?", JOURNAL_SCHEMA_VERSION + 1);
				}
			},
		});
		try {
			await assert.rejects(
				method === "getRun" ? journal.getRun(legacyRun.runId) : journal.listRuns({ cwd: legacyRun.cwd }),
				JournalSchemaVersionError,
			);
			assert.equal(upgraded, true);
		} finally {
			restore();
			await journal.close();
			await peer.close();
			await db.close();
		}
	});

test("near-limit legacy headers and events keep their original response columns (#5537)", async () => {
	const path = join(tempDirectory(), "legacy-wire.sqlite");
	writeLegacyJournal(path);
	const db = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(db);
	try {
		const header = {
			runId: "a",
			name: "r",
			cwd: "/p",
			createdAt: 1,
			status: "paused",
			inputs: { s: "x".repeat(149720) },
		};
		const payload = { inputs: { s: "x".repeat(149536) } };
		await db.run(
			"INSERT INTO runs VALUES (?,?,?,?,?,?)",
			header.runId,
			header.name,
			header.cwd,
			header.createdAt,
			header.status,
			JSON.stringify(header),
		);
		await db.run("UPDATE events SET payload=?,epoch=1,at=1 WHERE run_id=?", JSON.stringify(payload), legacyRun.runId);
		const restore = observeSqlReads(db, {
			after(rows) {
				for (const row of rows) {
					if (typeof row.header_json === "string" && row.header_json.length > 149000)
						assert.deepEqual(Object.keys(row).sort(), ["header_json", "run_id", "status"]);
					if (typeof row.payload === "string" && row.payload.length > 149000)
						assert.deepEqual(Object.keys(row).sort(), ["at", "epoch", "key", "payload", "run_id", "seq", "type"]);
				}
			},
		});
		try {
			assert.deepEqual(await journal.getRun("a"), header);
			assert.deepEqual(await journal.listRuns({ cwd: "/p" }), [header]);
			assert.deepEqual((await Array.fromAsync(journal.read(legacyRun.runId)))[0]!.event.payload, payload);
		} finally {
			restore();
		}
	} finally {
		await journal.close();
		await db.close();
	}
});

test("legacy event reads honor the same size budget as current event reads (#5537)", async () => {
	const path = join(tempDirectory(), "large-legacy-events.sqlite");
	writeLegacyJournal(path);
	const payload = JSON.stringify({ inputs: { text: '"'.repeat(1_000_000) } });
	const raw = new DatabaseSync(path);
	try {
		const insert = raw.prepare(
			"INSERT INTO events(run_id, seq, epoch, key, type, payload, at) VALUES (?, ?, 3, NULL, ?, ?, ?)",
		);
		for (let seq = 2; seq <= 7; seq++)
			insert.run(legacyRun.runId, seq, RUN_EVENT_TYPES.runStarted, payload, legacyRun.createdAt + seq);
	} finally {
		raw.close();
	}
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const release = observeSqlReads(database, {
		after(rows) {
			const bytes = rows.reduce(
				(total, row) => total + (typeof row.payload === "string" ? Buffer.byteLength(row.payload) : 0),
				0,
			);
			if (bytes > 4 * 1024 * 1024 + Buffer.byteLength(payload))
				throw new StoragePayloadTooLargeError(bytes, 0, { kind: "response" });
		},
	});
	try {
		const seqs: number[] = [];
		for await (const entry of journal.read(legacyRun.runId)) seqs.push(entry.seq);
		assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7]);
	} finally {
		release();
		await journal.close();
		await database.close();
	}
});

test("inspection lists a 150,000-run legacy catalog without overflowing the call stack (#5537)", async () => {
	const path = join(tempDirectory(), "large-legacy.sqlite");
	writeLegacyJournal(path);
	const database = new DatabaseSync(path);
	try {
		database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150000)
			INSERT INTO runs(run_id, name, cwd, created_at, status, header_json)
			SELECT 'run-' || i, 'run', '/project', 1, 'running',
			'{"runId":"run-' || i || '","name":"run","cwd":"/project","createdAt":1,"status":"running"}' FROM n`);
	} finally {
		database.close();
	}
	const inspection = await inspectJournalFile(path);
	assert.equal(inspection.runs.length, 150_001);
	assert.equal(new Set(inspection.runs.map((run) => run.runId)).size, 150_001);
});

test("legacy catalog listings check cancellation between size-bounded pages (#5537)", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);
	const database = new DatabaseSync(path);
	try {
		database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 128)
			INSERT INTO runs(run_id, name, cwd, created_at, status, header_json)
			SELECT 'run-' || i, 'run', '/project', 1, 'running',
			'{"runId":"run-' || i || '","name":"run","cwd":"/project","createdAt":1,"status":"running"}' FROM n`);
	} finally {
		database.close();
	}
	const db = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(db);
	const release = limitHeaderResponse(db, (rows) => rows.length <= 64);
	try {
		const controller = new AbortController();
		const reason = new Error("legacy catalog cancelled");
		const timer = setImmediate(() => controller.abort(reason));
		try {
			await assert.rejects(journal.listRuns(undefined, { signal: controller.signal }), (error) => error === reason);
		} finally {
			clearImmediate(timer);
		}
	} finally {
		release();
		await journal.close();
		await db.close();
	}
});

async function readAll(iterable: AsyncIterable<JournalEntry>): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const entry of iterable) entries.push(entry);
	return entries;
}

function convertedRunIds(path: string): string[] {
	const database = new DatabaseSync(path);
	try {
		return database
			.prepare("SELECT run_id FROM wf_runs ORDER BY run_id")
			.all()
			.map((row) => String(row.run_id));
	} finally {
		database.close();
	}
}

test("a storage failure while reading the legacy tables fails the open instead of hiding their runs (#5065)", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);
	await (await openSqlRunJournal(path)).close();
	const database = await openNodeSqliteDatabase(path);
	const failure = new StorageUnavailableError(database.descriptor, new Error("the database server call failed"));
	// The journal's tables exist, so its next transaction is the one that reads the legacy tables.
	const failing = new Proxy(database, {
		get(target, property, receiver) {
			if (property === "transaction") return () => Promise.reject(failure);
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as SqliteDatabase;
	try {
		await assert.rejects(SqlRunJournal.open(failing), (error) => error === failure);
	} finally {
		await database.close();
	}
});

test("a database with a migration ledger, as Postgres keeps, is never read for pre-0.9.38 runs (#5065)", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);
	const database = await openNodeSqliteDatabase(path);
	const ledgered = new Proxy(database, {
		get(target, property, receiver) {
			if (property === "dialect") return { ...dialectOf(target), versionedMigrations: true };
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as SqliteDatabase;
	try {
		const journal = await SqlRunJournal.open(ledgered);
		assert.deepEqual(await journal.listRuns({ cwd: legacyRun.cwd }), []);
		await journal.close();
	} finally {
		await database.close();
	}
});

test("lists legacy runs from the unprefixed tables without converting them", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);

	const journal = await openSqlRunJournal(path);
	try {
		assert.deepEqual(
			(await journal.listRuns({ cwd: legacyRun.cwd })).map((run) => [run.runId, run.status]),
			[[legacyRun.runId, legacyRun.status]],
		);
		assert.equal((await journal.getRun(legacyRun.runId))?.name, legacyRun.name);
	} finally {
		await journal.close();
	}

	assert.deepEqual(convertedRunIds(path), []);
});

test("converts a legacy run when it is resumed, leaving the legacy tables unchanged", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);

	const journal = await openSqlRunJournal(path);
	try {
		const outcome = await journal.acquire(legacyRun.runId, "resuming-session");
		assert.equal(outcome.status, "acquired");
		assert.ok(outcome.status === "acquired" && outcome.lease.epoch > 3);
		const entries = await readAll(journal.read(legacyRun.runId));
		assert.deepEqual(
			entries.map((entry) => [entry.seq, entry.epoch, entry.event.type]),
			[[1, 3, RUN_EVENT_TYPES.runStarted]],
		);
		assert.deepEqual(
			(await journal.listRuns()).map((run) => run.runId),
			[legacyRun.runId],
		);
	} finally {
		await journal.close();
	}

	assert.deepEqual(convertedRunIds(path), [legacyRun.runId]);
	const original = new DatabaseSync(path);
	try {
		assert.equal(original.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count, 1);
		assert.equal(original.prepare("SELECT holder_id FROM leases").get()?.holder_id, "old-process");
	} finally {
		original.close();
	}
});

test("reads a legacy run's events in place without converting it", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);

	const journal = await openSqlRunJournal(path);
	try {
		assert.deepEqual(
			(await readAll(journal.read(legacyRun.runId))).map((entry) => [entry.seq, entry.event.type]),
			[[1, RUN_EVENT_TYPES.runStarted]],
		);
		assert.equal(await journal.readKey(legacyRun.runId, "missing"), undefined);
		assert.equal(await journal.leaseState(legacyRun.runId), undefined);
	} finally {
		await journal.close();
	}

	assert.deepEqual(convertedRunIds(path), []);
});

test("opening the durable backend lists legacy runs without converting any of them", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);

	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	await backend.close();

	assert.deepEqual(convertedRunIds(path), []);
});

test("does not create a new run over an unconverted legacy run with the same ID", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);

	const journal = await openSqlRunJournal(path);
	try {
		assert.equal(await journal.createRun({ ...legacyRun, name: "replacement", status: "running" }), "exists");
		assert.equal(
			await journal.createRunWithEvents({ ...legacyRun, name: "replacement", status: "running" }, [
				{ event: { type: RUN_EVENT_TYPES.runFinished, payload: null } },
			]),
			"exists",
		);
		assert.equal((await journal.getRun(legacyRun.runId))?.name, legacyRun.name);
		assert.equal((await readAll(journal.read(legacyRun.runId))).length, 1);
	} finally {
		await journal.close();
	}
});

test("keeps legacy reads off after the earlier version copied every run, so its deletions stay deleted", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);
	const database = new DatabaseSync(path);
	try {
		database.exec(`
			CREATE TABLE wf_migrations(name TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
			INSERT INTO wf_migrations VALUES ('unprefixed-journal-tables', 0);
		`);
	} finally {
		database.close();
	}

	const journal = await openSqlRunJournal(path);
	try {
		assert.deepEqual(await journal.listRuns(), []);
		assert.equal(await journal.getRun(legacyRun.runId), undefined);
		assert.deepEqual(await readAll(journal.read(legacyRun.runId)), []);
	} finally {
		await journal.close();
	}
});

for (const converted of [false, true]) {
	test(`does not list a ${converted ? "converted" : "legacy-only"} run again after it is deleted`, async () => {
		const path = join(tempDirectory(), "journal.sqlite");
		writeLegacyJournal(path);

		const first = await openSqlRunJournal(path);
		if (converted) await first.acquire(legacyRun.runId, "resuming-session");
		await first.deleteRun(legacyRun.runId);
		await first.close();

		const second = await openSqlRunJournal(path);
		try {
			assert.equal(await second.getRun(legacyRun.runId), undefined);
			assert.deepEqual(await second.listRuns(), []);
			assert.deepEqual(await readAll(second.read(legacyRun.runId)), []);
		} finally {
			await second.close();
		}
	});
}

test("leaves legacy tables alone for a prefixed journal", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);

	const journal = await openSqlRunJournal(path, { prefix: "team_" });
	try {
		assert.equal(await journal.getRun(legacyRun.runId), undefined);
	} finally {
		await journal.close();
	}
});

test("ignores an unrelated runs table and still opens the journal", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	const database = new DatabaseSync(path);
	database.exec(`
		CREATE TABLE meta(schema_version INTEGER NOT NULL);
		CREATE TABLE runs(id INTEGER PRIMARY KEY, label TEXT);
		CREATE TABLE events(id INTEGER PRIMARY KEY);
		INSERT INTO runs(label) VALUES ('not a workflow run');
	`);
	database.close();

	const journal = await openSqlRunJournal(path);
	try {
		assert.deepEqual(await journal.listRuns(), []);
	} finally {
		await journal.close();
	}
});

function stageCheckpoint(overrides: Partial<DurableStageCheckpoint>): DurableStageCheckpoint {
	return {
		kind: "stage",
		workflowId: "legacy-run",
		checkpointId: "stage-session:orchestrator-1",
		name: "orchestrator-1",
		replayKey: "stage:task:orchestrator-1:1",
		completedAt: legacyRun.createdAt,
		...overrides,
	} as DurableStageCheckpoint;
}

test("resolves a path-only stage checkpoint to its transcript header ID, not its file name", async () => {
	const directory = tempDirectory();
	const sessionFile = join(directory, "2026-10-13T17-06-16-398Z_01a1363a-a8ce-7ee4-8cea-1c498f2a706d.jsonl");
	writeTextSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "01a1363a-b000-7000-8000-000000000001", timestamp: "2026-10-13T17:06:16.398Z", cwd: "/projects/legacy" })}\n`,
	);

	const migrated = await migrateStageSessionCheckpoint(stageCheckpoint({ sessionFile }));

	assert.equal(migrated.sessionId, "01a1363a-b000-7000-8000-000000000001");
	assert.equal(migrated.sessionFile, sessionFile);
});

test("keeps stage checkpoints that already carry a session ID or whose transcript is gone", async () => {
	const withId = stageCheckpoint({ sessionId: "current-id", sessionFile: "/missing/session.jsonl" });
	assert.equal(await migrateStageSessionCheckpoint(withId), withId);

	const missing = stageCheckpoint({ sessionFile: join(tempDirectory(), "missing.jsonl") });
	assert.equal((await migrateStageSessionCheckpoint(missing)).sessionId, undefined);
});

test("resumes a pre-#3700 stage from its transcript when the selected store has never seen it", async () => {
	const directory = tempDirectory();
	const sessionId = "01a1363a-b000-7000-8000-000000000002";
	const createdAt = "2026-10-13T17:06:16.398Z";
	const sessionFile = join(directory, "2026-10-13T17-06-16-398Z_01a1363a-a8ce-7ee4-8cea-1c498f2a706d.jsonl");
	const transcript = `${[
		{ type: "session", version: 3, id: sessionId, timestamp: createdAt, cwd: directory, internal: true },
		{
			type: "message",
			id: "e0000001",
			parentId: null,
			timestamp: createdAt,
			message: { role: "user", content: "Finish the review", timestamp: Date.parse(createdAt) },
		},
	]
		.map((line) => JSON.stringify(line))
		.join("\n")}\n`;
	writeTextSync(sessionFile, transcript);
	const store = new MemorySessionStore();

	const resumed = await stripWorkflowOnlyOptions(
		{ sessionStore: store, resumeFromSessionId: sessionId, resumeFromLegacySessionFile: sessionFile, cwd: directory },
		undefined,
		{ runId: "legacy-run", stageId: "stage", stageName: "review" },
	);

	assert.equal(resumed.sessionManager?.getSessionId(), sessionId);
	const message = resumed.sessionManager?.buildSessionContext().messages[0];
	assert.ok(message?.role === "user");
	assert.equal(message.content, "Finish the review");
	assert.equal((await store.load(sessionId)).header.internal, true);
	assert.equal(await readText(sessionFile), transcript);
});
