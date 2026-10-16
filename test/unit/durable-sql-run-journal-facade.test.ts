import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { StoragePrefixError, StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { registerRunJournalConformance } from "../../packages/workflows/src/durable/journal/conformance.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	JournalCasConflictError,
	JournalInvalidTextError,
	StaleLeaseError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { assertLeaseStateUnchanged } from "../helpers/journal-lease-state.js";
import { observeJournalRead } from "../helpers/journal-read-observation.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const close of cleanup.splice(0)) await close();
});

function executor(source: SqliteExecutor): SqliteExecutor {
	return {
		exec: (sql) => source.exec(sql),
		run: (sql, ...params) => source.run(sql, ...params),
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			const row = await source.get<T>(sql, ...params);
			if (row !== undefined) Object.freeze(row);
			return row;
		},
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			const rows = await source.all<T>(sql, ...params);
			for (const row of rows) Object.freeze(row);
			return rows;
		},
	};
}

async function database(): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("sql-journal-facade-");
	const db = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	cleanup.push(async () => {
		await db.close();
		removeTempDirectory(directory);
	});
	return db;
}

registerRunJournalConformance(
	test,
	"user-supplied minimal facade",
	async () => {
		const source = await database();
		const facade: SqliteDatabase = {
			...executor(source),
			descriptor: { adapter: "test-sqlite", location: "test database" },
			transaction: (callback) => source.transaction((tx) => callback(executor(tx))),
			close: () => source.close(),
		};
		return SqlRunJournal.open(facade);
	},
	observeJournalRead,
);

const header = { runId: "same-id", name: "workflow", cwd: "/raw/../cwd", createdAt: 0, status: "running" };

async function acquire(journal: SqlRunJournal) {
	await journal.createRun(header);
	const acquired = await journal.acquire(header.runId, "first");
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") assert.fail("lease not acquired");
	return acquired.lease;
}

test("session and journal stores isolate records in one caller-owned database across reopen and close", async () => {
	const db = await database();
	const session = await SqlSessionStore.open(db);
	const journal = await SqlRunJournal.open(db);
	const sessionHeader = { id: "same-id", version: 4 as const, createdAt: "2026-01-01T00:00:00.000Z", cwd: header.cwd };
	await session.create(sessionHeader, []);
	const held = await acquire(journal);
	const event = await journal.append(held, { type: "RunStarted", payload: { values: [2, 1, 2] } }, { key: "" });
	assert.deepEqual(await session.load("same-id"), { header: sessionHeader, entries: [], lastSeq: 0 });
	assert.deepEqual(await journal.listRuns(), [header]);
	await journal.close();
	await session.close();
	const reopenedJournal = await SqlRunJournal.open(db);
	const reopenedSession = await SqlSessionStore.open(db);
	assert.deepEqual(await reopenedJournal.readKey(header.runId, ""), event.entry);
	await reopenedJournal.deleteOwnedRun(held);
	assert.deepEqual(await reopenedSession.readHeader("same-id"), sessionHeader);
	await reopenedSession.delete("same-id");
	assert.deepEqual(await reopenedJournal.listRuns(), []);
	assert.equal((await db.get("SELECT COUNT(*) AS count FROM wf_events"))?.count, 0);
	assert.deepEqual(
		(await db.all("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")).map((row) => row.name),
		[
			"session_entries",
			"session_meta",
			"session_search_texts",
			"session_sessions",
			"wf_events",
			"wf_leases",
			"wf_meta",
			"wf_runs",
		],
	);
	await reopenedJournal.close();
	await reopenedSession.close();
	assert.equal((await db.get("SELECT 1 AS alive"))?.alive, 1);
});

test("journal prefixes isolate schema, events, leases and tombstones without reading bare tables", async () => {
	const db = await database();
	await db.exec("CREATE TABLE runs(run_id TEXT); INSERT INTO runs VALUES ('old')");
	const left = await SqlRunJournal.open(db, { prefix: "left_" });
	const right = await SqlRunJournal.open(db, { prefix: "right_" });
	const first = await acquire(left);
	assert.equal(await right.getRun(header.runId), undefined);
	const second = await acquire(right);
	await left.append(first, { type: "RunStarted", payload: "left" }, { key: "same" });
	await right.append(second, { type: "RunStarted", payload: "right" }, { key: "same" });
	await left.deleteOwnedRun(first);
	assert.equal((await right.readKey(header.runId, "same"))?.event.payload, "right");
	const recreated = await acquire(left);
	assert.equal(recreated.epoch, first.epoch + 1);
	await assert.rejects(left.append(first, { type: "RunFinished", payload: null }), StaleLeaseError);
	assert.equal((await db.get("SELECT COUNT(*) AS count FROM runs"))?.count, 1);
	await left.close();
	await right.close();
});

test("journal deletion explicitly removes events when foreign keys are disabled", async () => {
	const db = await database();
	await db.exec("PRAGMA foreign_keys=OFF");
	const journal = await SqlRunJournal.open(db);
	const lease = await acquire(journal);
	await journal.append(lease, { type: "RunStarted", payload: null });
	await journal.deleteRun(header.runId);
	assert.equal((await db.get("SELECT COUNT(*) AS count FROM wf_events"))?.count, 0);
	assert.equal((await db.get("SELECT epoch FROM wf_leases"))?.epoch, lease.epoch);
	await journal.close();
});

test("event and lease timestamps and expiry use the database clock rather than the writer clock", async () => {
	const db = await database();
	const journal = await SqlRunJournal.open(db);
	vi.spyOn(Date, "now").mockReturnValue(-100_000);
	const lease = await acquire(journal);
	const time = Number((await db.get("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now"))?.now);
	const state = await journal.leaseState(header.runId);
	assert.ok(state!.renewedAt >= time - 1000);
	const appended = await journal.append(lease, { type: "RunStarted", payload: null });
	assert.ok(appended.entry.at >= time);
	vi.mocked(Date.now).mockReturnValue(time + 1_000_000);
	assert.equal((await journal.takeoverExpired(header.runId, "next", 60_000)).status, "held");
	await db.run("UPDATE wf_leases SET renewed_at = ?", time - 60_001);
	assert.equal((await journal.takeoverExpired(header.runId, "next", 60_000)).status, "acquired");
	await journal.close();
});

test("a failed final status write rolls back the event and retains the original typed error", async () => {
	const db = await database();
	const journal = await SqlRunJournal.open(db);
	const lease = await acquire(journal);
	await db.exec("CREATE TRIGGER reject_status BEFORE UPDATE ON wf_runs BEGIN SELECT RAISE(ABORT, 'blocked'); END");
	await assert.rejects(
		journal.append(lease, { type: "StatusChanged", payload: { status: "paused" } }),
		StorageUnavailableError,
	);
	assert.equal(await journal.readKey(header.runId, "missing"), undefined);
	assert.equal((await db.get("SELECT COUNT(*) AS count FROM wf_events"))?.count, 0);
	assert.deepEqual(await journal.getRun(header.runId), header);
	await db.exec("DROP TRIGGER reject_status");
	assert.equal((await journal.append(lease, { type: "RunFinished", payload: null })).entry.seq, 1);
	await journal.close();
});

test.each(["administrative", "owned"] as const)(
	"%s deletion rolls back events and the lease when the final delete fails",
	async (mode) => {
		const db = await database();
		const journal = await SqlRunJournal.open(db);
		const lease = await acquire(journal);
		const appended = await journal.append(lease, { type: "RunStarted", payload: [2, 1, 2] }, { key: "retained" });
		const beforeLease = await journal.leaseState(header.runId);
		await db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON wf_runs BEGIN SELECT RAISE(ABORT, 'blocked'); END");
		await assert.rejects(
			mode === "owned" ? journal.deleteOwnedRun(lease, 1) : journal.deleteRun(header.runId),
			StorageUnavailableError,
		);
		assert.deepEqual(await journal.getRun(header.runId), header);
		assert.deepEqual(await journal.readKey(header.runId, "retained"), appended.entry);
		assertLeaseStateUnchanged(await journal.leaseState(header.runId), beforeLease);
		await db.exec("DROP TRIGGER reject_delete");
		await journal.deleteOwnedRun(lease, 1);
		await journal.close();
	},
);

test("close drains an accepted append before settling and leaves the facade open", async () => {
	const source = await database();
	const prepared = Promise.withResolvers<void>();
	const commit = Promise.withResolvers<void>();
	let delayed = false;
	const facade: SqliteDatabase = {
		...executor(source),
		descriptor: source.descriptor,
		transaction: (callback) =>
			source.transaction(async (tx) => {
				const result = await callback(executor(tx));
				if (delayed) {
					prepared.resolve();
					await commit.promise;
				}
				return result;
			}),
		close: () => source.close(),
	};
	const journal = await SqlRunJournal.open(facade);
	const lease = await acquire(journal);
	delayed = true;
	const append = journal.append(lease, { type: "RunStarted", payload: "committed" }, { key: "pending" });
	await prepared.promise;
	let closed = false;
	const close = journal.close().then(() => {
		closed = true;
	});
	try {
		await Promise.resolve();
		assert.equal(closed, false);
		await assert.rejects(journal.createRun({ ...header, runId: "late" }), StorageUnavailableError);
	} finally {
		commit.resolve();
		await append;
		await close;
	}
	const reopened = await SqlRunJournal.open(source);
	assert.equal((await reopened.readKey(header.runId, "pending"))?.event.payload, "committed");
	await reopened.close();
	assert.equal((await source.get("SELECT 1 AS alive"))?.alive, 1);
});

test("invalid prefixes reject before the node factory creates its file", async () => {
	const directory = makeTempDirectory("sql-journal-prefix-");
	try {
		for (const prefix of ["not-valid", "sqlite_reserved", "SQLITE_reserved"]) {
			const path = join(directory, "new", "journal.sqlite");
			await assert.rejects(openSqlRunJournal(path, { prefix }), (error: Error) => {
				assert.ok(error instanceof StoragePrefixError);
				assert.equal(error.prefix, prefix);
				return true;
			});
			assert.equal(await fileExists(path), false);
		}
	} finally {
		removeTempDirectory(directory);
	}
});

test.each(["header", "append"] as const)(
	"%s serialization failures are typed and leave journal state unchanged",
	async (kind) => {
		const db = await database();
		const journal = await SqlRunJournal.open(db);
		const lease = await acquire(journal);
		const first = await journal.append(lease, { type: "RunStarted", payload: "original" }, { key: "first" });
		const state = await journal.leaseState(header.runId);
		const cause = new Error("serializer failed");
		const inputs = { values: [2, 1, 2] };
		Object.defineProperty(inputs, "toJSON", {
			value: () => {
				throw cause;
			},
		});
		const event = { type: "StatusChanged", payload: { status: "failed", inputs } } as const;
		if (kind === "append") {
			await assert.rejects(journal.append({ ...lease, epoch: lease.epoch + 1 }, event), StaleLeaseError);
			assert.deepEqual(await journal.append(lease, event, { key: "first", expectSeq: 0 }), {
				status: "exists",
				entry: first.entry,
			});
			await assert.rejects(journal.append(lease, event, { expectSeq: 0 }), JournalCasConflictError);
			await assert.rejects(
				journal.append(lease, { type: "StatusChanged", payload: { status: "bad\u0000status", inputs } }),
				(error: Error) => {
					assert.ok(error instanceof StorageUnavailableError);
					assert.equal(error.adapter, db.descriptor.adapter);
					assert.equal(error.location, db.descriptor.location);
					assert.equal(error.cause, cause);
					return true;
				},
			);
			await assert.rejects(
				journal.append(lease, { type: "StatusChanged", payload: { status: "bad\u0000status" } }),
				(error: Error) => {
					assert.ok(error instanceof JournalInvalidTextError);
					assert.equal(error.field, "status");
					return true;
				},
			);
		}
		const rejected =
			kind === "header"
				? journal.createRun({ ...header, runId: "rejected", inputs })
				: journal.append(lease, event, { key: "rejected", expectSeq: 1 });
		assert.ok(rejected instanceof Promise);
		await assert.rejects(rejected, (error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error.adapter, db.descriptor.adapter);
			assert.equal(error.location, db.descriptor.location);
			assert.equal(error.cause, cause);
			return true;
		});
		assert.deepEqual(await journal.listRuns(), [header]);
		assert.equal(await journal.getRun("rejected"), undefined);
		assert.equal(await journal.readKey(header.runId, "rejected"), undefined);
		assert.deepEqual(await journal.readKey(header.runId, "first"), first.entry);
		const entries = [];
		for await (const entry of journal.read(header.runId)) entries.push(entry);
		assert.deepEqual(entries, [first.entry]);
		assertLeaseStateUnchanged(await journal.leaseState(header.runId), state);
		assert.equal(
			(await journal.append(lease, { type: "RunFinished", payload: null }, { expectSeq: 1 })).entry.seq,
			2,
		);
		await journal.close();
	},
);

test("independent journals acquire and append concurrently without stalling timers (#3682)", async () => {
	const directory = makeTempDirectory("journal-concurrent-");
	const path = join(directory, "runs.sqlite");
	const first = await openSqlRunJournal(path);
	const second = await openSqlRunJournal(path);
	try {
		await first.createRun({ ...header, runId: "first" });
		await second.createRun({ ...header, runId: "second" });
		const started = performance.now();
		const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 10));
		const acquisitions = await Promise.allSettled([first.acquire("first", "one"), second.acquire("second", "two")]);
		const EVENT_LOOP_STALL_BOUND_MS = 2000;
		assert.ok((await timer) < EVENT_LOOP_STALL_BOUND_MS, "concurrent acquisitions blocked the event loop");
		const leases = acquisitions.map((outcome) => {
			assert.equal(outcome.status, "fulfilled");
			assert.equal(outcome.value.status, "acquired");
			return outcome.value.lease;
		});
		const appended = await Promise.all([
			first.append(leases[0]!, { type: "RunStarted", payload: "first" }),
			second.append(leases[1]!, { type: "RunStarted", payload: "second" }),
		]);
		assert.deepEqual(
			appended.map((result) => result.entry.seq),
			[1, 1],
		);
		assert.equal((await first.getRun("first"))?.runId, "first");
		assert.equal((await second.getRun("second"))?.runId, "second");
	} finally {
		await first.close();
		await second.close();
		removeTempDirectory(directory);
	}
});

test("session and journal write concurrently through separate connections to one file (#3682)", async () => {
	const directory = makeTempDirectory("session-journal-concurrent-");
	const path = join(directory, "shared.sqlite");
	const db = await openNodeSqliteDatabase(path);
	const session = await SqlSessionStore.open(db);
	const journal = await openSqlRunJournal(path);
	try {
		const lease = await acquire(journal);
		const sessionHeader = { id: "session", version: 4 as const, createdAt: "2026-01-01T00:00:00.000Z", cwd: "/" };
		await Promise.all([
			session.create(sessionHeader, []),
			journal.append(lease, { type: "RunStarted", payload: "saved" }, { key: "saved" }),
		]);
		assert.deepEqual(await session.readHeader("session"), sessionHeader);
		assert.equal((await journal.readKey(header.runId, "saved"))?.event.payload, "saved");
	} finally {
		await session.close();
		await journal.close();
		await db.close();
		removeTempDirectory(directory);
	}
});
