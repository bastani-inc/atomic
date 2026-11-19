import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { STORED_JSON_CHUNK_BYTES } from "../../packages/coding-agent/src/core/storage/run-journal.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import {
	ageBlobs,
	fullScanRetainedHashes,
	startRun,
	statusEvent,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";
import { storageBackends } from "../helpers/storage-backends.js";

/**
 * Workflow journal events, pool inputs and pool results larger than a libSQL server takes in one value (#4965): sqld
 * 0.24.33 refuses a value or row over 5,000,000 bytes. Every backend of test/helpers/storage-backends.ts runs these: a
 * SQLite file always, sqld and Postgres when their URLs are set. On every backend no stored row may hold more than one
 * chunk of such a value, so that what works on SQLite works on sqld.
 */

/** Writing and reading back 20 MB values over HTTP, several times, is the server's cost, not a slow test. */
const LARGE_VALUE_TIMEOUT_MS = 300_000;
const MB = 1_000_000;

/** A string of `bytes` bytes of UTF-8 whose characters take one to four bytes, so chunks split characters. */
function largeText(bytes: number, seed = "a"): string {
	const unit = `${seed}αβγ-😀-`;
	return unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit)));
}

/** The longest text one row of `column` in `table` holds, in characters. */
async function longest(database: SqliteDatabase, table: string, column: string): Promise<number> {
	const row = await database.get<{ longest: number | null }>(`SELECT max(length(${column})) AS longest FROM ${table}`);
	return Number(row?.longest ?? 0);
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	// A timed-out hook can keep running: it must never close resources the next test registers (#5521).
	for (const close of closers.splice(0).reverse()) await close();
});

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`large workflow journal events on ${name} (#4965)`, () => {
		test(
			"a 20 MB step result is stored in chunks, reads back whole and resumes on another connection (#4965)",
			async () => {
				const scope = await backend.openScope();
				closers.push(() => scope.close());
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				const writer = await JournalDurableBackend.open(journal);
				closers.push(() => writer.close());
				const workflowId = "large-step";
				await writer.commitWorkflowRegistration({
					workflowId,
					name: "large",
					inputs: {},
					createdAt: 1,
					status: "running",
				});
				const output = largeText(20 * MB);
				const checkpoint: DurableToolCheckpoint = {
					kind: "tool",
					workflowId,
					checkpointId: "step-1",
					name: "step",
					argsHash: "args-1",
					output,
					completedAt: 42,
				};
				await writer.commitCheckpoint(checkpoint);
				await writer.releaseWorkflow(workflowId);

				const t = runJournalTables(scope.prefix);
				assert.ok(
					(await longest(database, t.events, "payload")) <= STORED_JSON_CHUNK_BYTES,
					"no events row holds more than one chunk",
				);

				const elsewhere = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
				closers.push(() => elsewhere.close());
				const read: RunEvent[] = [];
				for await (const entry of elsewhere.read(workflowId)) read.push(entry.event);
				const recorded = read.find((event) => event.type === RUN_EVENT_TYPES.checkpointRecorded);
				assert.equal((recorded?.payload as { output?: unknown } | undefined)?.output, output);
				let keyed = 0;
				for await (const entry of SqlRunJournal.readKeyRange(elsewhere, workflowId, "", "\uffff")) {
					if (entry.event.type === RUN_EVENT_TYPES.checkpointRecorded) {
						keyed++;
						assert.equal((entry.event.payload as { output?: unknown }).output, output);
						const byKey = await elsewhere.readKey(workflowId, entry.key!);
						assert.equal((byKey?.event.payload as { output?: unknown } | undefined)?.output, output);
					}
				}
				assert.equal(keyed, 1);
				// The snapshot tail reads the checkpoint's `completedAt` from the stored row, in SQL.
				const tail = await elsewhere.snapshotTail(workflowId);
				assert.equal(tail?.laterCheckpoints, 1);
				assert.equal(tail?.lastCheckpointAt, 42);

				const resumed = await JournalDurableBackend.open(elsewhere, { ownsJournal: false });
				closers.push(() => resumed.close());
				await resumed.hydrateWorkflow(workflowId);
				assert.equal(resumed.getToolOutput(workflowId, "args-1"), output);
				const checkpoints = await resumed.readCheckpoints(workflowId);
				assert.deepEqual(checkpoints, [checkpoint]);
			},
			LARGE_VALUE_TIMEOUT_MS,
		);

		test(
			"the SQL that reads payload JSON gives the same results for a payload stored in chunks (#4965)",
			async () => {
				const scope = await backend.openScope();
				closers.push(() => scope.close());
				const database = await scope.connect();
				const sessions = await SqlSessionStore.open(database, { prefix: scope.prefix });
				closers.push(() => sessions.close());
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				closers.push(() => journal.close());
				const lease = await startRun(journal, "parity");
				const kept = textBlob("kept patch");
				const orphan = textBlob("orphan patch");
				const snapshot = syntheticSnapshot("snapshot", [kept.hash]);
				// A snapshot is recorded only once its blobs are stored (#5077).
				await journal.snapshotBlobs.putBlobs([kept, orphan]);
				await journal.append(lease, statusEvent("parity", { status: "running" }, "RunStarted"));
				// A status event stored in chunks keeps the fields the run state reads: the run stays resumable.
				const failed = statusEvent("parity", { status: "failed" });
				await journal.append(lease, {
					type: failed.type,
					payload: { ...(failed.payload as Record<string, unknown>), error: largeText(3 * MB) },
				} as RunEvent);
				await journal.append(
					lease,
					{
						type: RUN_EVENT_TYPES.checkpointRecorded,
						payload: {
							kind: "tool",
							checkpointId: "large",
							completedAt: 7,
							output: largeText(6 * MB),
							worktreeSnapshots: [snapshot],
						},
					} as unknown as RunEvent,
					{ key: "large" },
				);
				const t = runJournalTables(scope.prefix);
				assert.ok((await longest(database, t.events, "payload")) <= STORED_JSON_CHUNK_BYTES);
				assert.equal((await journal.getRun("parity"))?.status, "failed");

				const tail = await journal.snapshotTail("parity");
				assert.equal(tail?.laterCheckpoints, 1);
				assert.equal(tail?.lastCheckpointAt, 7);
				assert.equal((tail?.snapshot.event.payload as { error?: string } | undefined)?.error, largeText(3 * MB));

				const expected = await fullScanRetainedHashes(journal, sessions);
				assert.deepEqual([...expected], [kept.hash]);
				await ageBlobs(database, journal.snapshotBlobs.table, 10_000);
				const { deleted } = await collectSnapshotGarbage(journal.snapshotBlobs);
				assert.deepEqual([...deleted], [orphan.hash]);
				assert.deepEqual([...(await journal.snapshotBlobs.listBlobHashes())], [kept.hash]);
			},
			LARGE_VALUE_TIMEOUT_MS,
		);

		test(
			"a journal written before chunks is upgraded, its single-row events stay readable, and it refuses older builds (#4965)",
			async () => {
				const scope = await backend.openScope();
				closers.push(() => scope.close());
				const database = await scope.connect();
				const dialect = dialectOf(database);
				const { int } = dialect.types;
				const t = runJournalTables(scope.prefix);
				// The tables as a build of journal schema version 1 created them: no chunks column, no chunk table.
				// Each schema change can safely run again after SQLITE_SCHEMA; several in one exec cannot (#5521).
				for (const sql of [
					`CREATE TABLE ${t.meta}(schema_version ${int} NOT NULL)`,
					`CREATE TABLE ${t.runs}(
						run_id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL,
						created_at ${int} NOT NULL, status TEXT NOT NULL, header_json TEXT NOT NULL${dialect.rowOrderColumn}
					)`,
					`CREATE TABLE ${t.events}(
						run_id TEXT NOT NULL,
						seq ${int} NOT NULL, epoch ${int} NOT NULL, key TEXT${dialect.byteOrderCollation},
						type TEXT NOT NULL, payload TEXT NOT NULL, at ${int} NOT NULL${dialect.rowOrderColumn},
						PRIMARY KEY(run_id, seq), UNIQUE(run_id, key)
					)`,
					`CREATE TABLE ${t.leases}(
						run_id TEXT PRIMARY KEY, holder_id TEXT, epoch ${int} NOT NULL, renewed_at ${int} NOT NULL
					)`,
				])
					await database.exec(sql);
				await database.run(`INSERT INTO ${t.meta} VALUES (1)`);
				const header = { runId: "old", name: "old", cwd: "/repo", createdAt: 1, status: "running" };
				await database.run(
					`INSERT INTO ${t.runs}(run_id, name, cwd, created_at, status, header_json) VALUES (?, ?, ?, ?, ?, ?)`,
					"old",
					"old",
					"/repo",
					1,
					"running",
					JSON.stringify(header),
				);
				// Over one chunk but under sqld's row limit: a build before chunks stored it in its row.
				const old = { kind: "tool", checkpointId: "old", output: largeText(2 * MB, "o") };
				await database.run(
					`INSERT INTO ${t.events}(run_id, seq, epoch, key, type, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					"old",
					1,
					0,
					"old-key",
					RUN_EVENT_TYPES.checkpointRecorded,
					JSON.stringify(old),
					5,
				);

				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				closers.push(() => journal.close());
				const meta = await database.get<{ schema_version: number }>(`SELECT schema_version FROM ${t.meta}`);
				assert.equal(Number(meta?.schema_version), 2, "upgraded to the version older builds refuse");
				assert.deepEqual((await journal.readKey("old", "old-key"))?.event.payload, old);

				const acquired = await journal.acquire("old", "holder");
				assert.equal(acquired.status, "acquired");
				if (acquired.status !== "acquired") return;
				const large = { kind: "tool", checkpointId: "new", output: largeText(8 * MB, "n") };
				await journal.append(acquired.lease, {
					type: RUN_EVENT_TYPES.checkpointRecorded,
					payload: large,
				} as unknown as RunEvent);
				const payloads: unknown[] = [];
				for await (const entry of journal.read("old")) payloads.push(entry.event.payload);
				assert.deepEqual(payloads, [old, large]);

				// Reopening an upgraded journal changes nothing and reads the same.
				const again = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
				closers.push(() => again.close());
				const reread: unknown[] = [];
				for await (const entry of again.read("old")) reread.push(entry.event.payload);
				assert.deepEqual(reread, [old, large]);
				await journal.deleteRun("old");
				const chunks = await database.get<{ count: number }>(`SELECT count(*) AS count FROM ${t.eventChunks}`);
				assert.equal(Number(chunks?.count), 0, "deleting a run deletes its chunks");
			},
			LARGE_VALUE_TIMEOUT_MS,
		);

		// Worker pools run on SQLite and libSQL only (docs/storage.md, "What works on PostgreSQL").
		test.skipIf(backend.name === "Postgres")(
			"a 20 MB pooled child's inputs, step result and result round-trip and resume on another connection (#4965)",
			async () => {
				const scope = await backend.openScope();
				closers.push(() => scope.close());
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				closers.push(() => journal.close());
				const root = await JournalDurableBackend.open(journal, { ownsJournal: false });
				closers.push(() => root.close());
				await root.commitWorkflowRegistration({
					workflowId: "root",
					name: "root",
					inputs: {},
					createdAt: 0,
					status: "running",
				});
				const acquired = await journal.acquire("root", root.holderId);
				assert.equal(acquired.status, "acquired");
				if (acquired.status !== "acquired") return;
				const lease = acquired.lease;
				const { work: fixture, boundary } = poolWorkFixture();
				const inputs = { text: largeText(20 * MB, "i") };
				const work = { ...fixture, inputs };
				const pool = await openSqlPoolQueue(journal);
				await pool.initialize(lease, 60_000);
				await pool.enqueue(lease, work, boundary);
				const attempt = await pool.claim(lease, "worker", [work], 60_000);
				assert.ok(attempt);
				assert.deepEqual(attempt.inputs, inputs, "the claimed work carries its whole inputs");

				const output = largeText(20 * MB, "s");
				const run = { ...boundary.topology!.boundary!.child };
				const step: DurableToolCheckpoint = {
					kind: "tool",
					workflowId: "root",
					checkpointId: `${work.scope}:tool:1`,
					name: "tool",
					argsHash: `${work.scope}:args`,
					output,
					completedAt: 1,
					topology: { version: 1, nodeId: "tool", parentIds: [], ordinal: 0, order: 0, run },
				};
				const receipt = await pool.commit(lease, attempt, "step", { kind: "checkpoint", checkpoint: step });
				assert.deepEqual(
					await pool.commit(lease, attempt, "step", { kind: "checkpoint", checkpoint: step }),
					receipt,
				);
				const result = { runId: work.childRunId, result: largeText(20 * MB, "r") };
				await pool.complete(lease, attempt, result);
				// Completing again with the same result is the same completion.
				await pool.complete(lease, attempt, result);

				const t = runJournalTables(scope.prefix);
				for (const [table, column] of [
					[t.events, "payload"],
					[`${t.runs}_work`, "descriptor"],
					[`${t.runs}_work_results`, "result"],
				] as const)
					assert.ok(
						(await longest(database, table, column)) <= STORED_JSON_CHUNK_BYTES,
						`no ${table} row holds more than one chunk`,
					);

				const elsewhere = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
				closers.push(() => elsewhere.close());
				const otherPool = await openSqlPoolQueue(elsewhere);
				assert.deepEqual(await otherPool.result("root", attempt.id), result);
				const resumed = await JournalDurableBackend.open(elsewhere, { ownsJournal: false });
				closers.push(() => resumed.close());
				await resumed.hydrateWorkflow("root");
				const checkpoints = await resumed.readCheckpoints("root");
				assert.ok(
					checkpoints.some((checkpoint) => (checkpoint as { output?: unknown }).output === output),
					"the child's step result resumes whole",
				);
			},
			LARGE_VALUE_TIMEOUT_MS,
		);
	});
}
