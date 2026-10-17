import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import { migrateStageSessionCheckpoint } from "../../packages/workflows/src/durable/backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { type JournalEntry, RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

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

async function readAll(iterable: AsyncIterable<JournalEntry>): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const entry of iterable) entries.push(entry);
	return entries;
}

test("copies runs from the unprefixed journal tables so older runs stay resumable", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);

	const journal = await openSqlRunJournal(path);
	try {
		const runs = await journal.listRuns({ cwd: legacyRun.cwd });
		assert.deepEqual(
			runs.map((run) => run.runId),
			[legacyRun.runId],
		);
		const entries = await readAll(journal.read(legacyRun.runId));
		assert.deepEqual(
			entries.map((entry) => [entry.seq, entry.epoch, entry.event.type]),
			[[1, 3, RUN_EVENT_TYPES.runStarted]],
		);
		const outcome = await journal.acquire(legacyRun.runId, "resuming-session");
		assert.equal(outcome.status, "acquired");
		assert.ok(outcome.status === "acquired" && outcome.lease.epoch > 3);
	} finally {
		await journal.close();
	}

	const original = new DatabaseSync(path);
	try {
		assert.equal(original.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count, 1);
		assert.equal(original.prepare("SELECT holder_id FROM leases").get()?.holder_id, "old-process");
	} finally {
		original.close();
	}
});

test("does not bring back a run deleted after the journal migration", async () => {
	const path = join(tempDirectory(), "journal.sqlite");
	writeLegacyJournal(path);

	const first = await openSqlRunJournal(path);
	await first.deleteRun(legacyRun.runId);
	await first.close();

	const second = await openSqlRunJournal(path);
	try {
		assert.equal(await second.getRun(legacyRun.runId), undefined);
	} finally {
		await second.close();
	}
});

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

test("resolves a path-only stage checkpoint to its transcript header ID, not its file name", () => {
	const directory = tempDirectory();
	const sessionFile = join(directory, "2026-10-13T17-06-16-398Z_01a1363a-a8ce-7ee4-8cea-1c498f2a706d.jsonl");
	writeTextSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "01a1363a-b000-7000-8000-000000000001", timestamp: "2026-10-13T17:06:16.398Z", cwd: "/projects/legacy" })}\n`,
	);

	const migrated = migrateStageSessionCheckpoint(stageCheckpoint({ sessionFile }));

	assert.equal(migrated.sessionId, "01a1363a-b000-7000-8000-000000000001");
	assert.equal(migrated.sessionFile, sessionFile);
});

test("keeps stage checkpoints that already carry a session ID or whose transcript is gone", () => {
	const withId = stageCheckpoint({ sessionId: "current-id", sessionFile: "/missing/session.jsonl" });
	assert.equal(migrateStageSessionCheckpoint(withId), withId);

	const missing = stageCheckpoint({ sessionFile: join(tempDirectory(), "missing.jsonl") });
	assert.equal(migrateStageSessionCheckpoint(missing).sessionId, undefined);
});
