import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase, SqliteRow } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { type SqlPoolStorage, sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import {
	openSqlPoolQueue,
	type PoolWork,
	type SqlPoolQueue,
	STALE_WORK_LEASE,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage, type SqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { type Lease, StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import {
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const CHAOS_WRITER = fileURLToPath(new URL("../fixtures/sqlite-pool-chaos-writer.mjs", import.meta.url));
/** Each test drives real writer processes against one journal file. */
const CHAOS_TEST_TIMEOUT_MS = 120_000;
const ROOT = "root";
const POOL_TIMEOUT_MS = 10 * 60_000;
const running = poolWorkFixture("running");
const finished = poolWorkFixture("finished");
const staleWork = { message: STALE_WORK_LEASE };
const CONCURRENT_WRITERS = 8;
/** Fences the writers commit while the pool keeps reading, before they are stopped. */
const FENCES_UNDER_READS = 200;
/** Rounds of reads the pool makes while the writers commit, however fast they commit. */
const READ_ROUNDS_UNDER_WRITERS = 200;
const FILL_BYTES = 16 * 1024 * 1024;
const FILL_HEADROOM_BYTES = 256 * 1024;

afterEach(() => {
	vi.restoreAllMocks();
});

interface ChaosRoot {
	readonly directory: string;
	readonly path: string;
	readonly database: SqliteDatabase;
	readonly journal: SqlRunJournal;
	readonly storage: SqlPoolStorage;
	readonly lease: Lease;
	readonly pool: SqlPoolQueue;
	readonly ledger: SqlPoolUsage;
	readonly attempt: PoolWork;
	readonly completed: PoolWork;
	close(): Promise<void>;
}

async function chaosRoot(): Promise<ChaosRoot> {
	const directory = makeTempDirectory("pool-read-chaos-");
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	await journal.createRun({ runId: ROOT, name: ROOT, cwd: "", createdAt: 0, status: "running" });
	const acquired = await journal.acquire(ROOT, "coordinator");
	if (acquired.status !== "acquired") assert.fail("lease not acquired");
	const { lease } = acquired;
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(lease, POOL_TIMEOUT_MS);
	await pool.enqueue(lease, running.work, running.boundary);
	await pool.enqueue(lease, finished.work, finished.boundary);
	const attempt = (await pool.claim(lease, "worker", [running.work], POOL_TIMEOUT_MS))!;
	const completed = (await pool.claim(lease, "other-worker", [finished.work], POOL_TIMEOUT_MS))!;
	await pool.complete(lease, completed, { runId: finished.work.childRunId, status: "completed" });
	await pool.setControl(lease, "running");
	const ledger = await openSqlPoolUsage(journal);
	await ledger.total(ROOT);
	return {
		directory,
		path,
		database,
		journal,
		storage: sqlPoolStorage(journal)!,
		lease,
		pool,
		ledger,
		attempt,
		completed,
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

/** Every request the coordinator answers with a read, as it sends them. */
async function readOnlyRequests(f: ChaosRoot): Promise<void> {
	await f.pool.control(f.lease);
	await f.pool.assertCurrent(f.lease, f.attempt);
	await f.pool.inspect(ROOT);
	await f.pool.result(ROOT, f.completed.id);
	await f.ledger.total(ROOT);
	assert.equal(await f.pool.rootLease(f.lease, POOL_TIMEOUT_MS), "current");
	assert.equal(await f.pool.initialized(ROOT), true);
}

function chaosWriter(args: readonly string[], command: readonly string[] = [process.execPath, CHAOS_WRITER]) {
	return spawnProcess([...command, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

async function readLine(child: SpawnedProcess): Promise<string> {
	assert.ok(child.stdout);
	const reader = child.stdout.getReader();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const next = await reader.read();
			if (next.done) assert.fail(`writer exited early: ${await readStreamText(child.stderr)}`);
			text += new TextDecoder().decode(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return text.trim();
}

function fenceSql(attempt: PoolWork): string {
	return `UPDATE wf_runs_work SET generation = generation + 1 WHERE id = '${attempt.id}'`;
}

/** The attempt's generation and the pool's control revision, read in one snapshot. */
function progress(f: ChaosRoot): Promise<{ readonly generation: number; readonly revision: number }> {
	return f.storage.read(async (executor) => {
		const work = await executor.get<SqliteRow & { generation: number }>(
			"SELECT generation FROM wf_runs_work WHERE id = ?",
			f.attempt.id,
		);
		const control = await executor.get<SqliteRow & { revision: number }>(
			"SELECT revision FROM wf_runs_pool_control WHERE root = ?",
			ROOT,
		);
		return { generation: work!.generation, revision: control!.revision };
	});
}

async function generation(f: ChaosRoot): Promise<number> {
	return (await progress(f)).generation;
}

function refusal<T>(action: Promise<T>): Promise<string> {
	return action.then(
		() => "authorized",
		(error: Error) => (error instanceof StaleLeaseError ? "StaleLeaseError" : error.message),
	);
}

test.skipIf(process.platform === "win32")(
	"a writer stopped mid-transaction holding the write lock blocks no pool read, and its fence binds reads and writes once it commits (#4314)",
	async () => {
		const f = await chaosRoot();
		const holder = chaosWriter(["hold", f.path, fenceSql(f.attempt)]);
		try {
			assert.equal(await readLine(holder), "locked");
			holder.kill("SIGSTOP");
			let extendSettled = false;
			const extended = refusal(f.pool.extend(f.lease, f.attempt, POOL_TIMEOUT_MS)).then((outcome) => {
				extendSettled = true;
				return outcome;
			});
			await readOnlyRequests(f);
			assert.equal(extendSettled, false, "the coordinator's write waits for the stopped writer's lock");
			holder.kill("SIGCONT");
			holder.stdin!.end("commit\n");
			assert.equal(await readLine(holder), "committed");
			assert.equal(await holder.exited, 0, await readStreamText(holder.stderr));
			assert.equal(await extended, STALE_WORK_LEASE);
			await assert.rejects(f.pool.assertCurrent(f.lease, f.attempt), staleWork);
			await f.pool.assertCurrent(f.lease, { ...f.attempt, generation: f.attempt.generation + 1 });
		} finally {
			holder.kill("SIGKILL");
			await holder.exited;
			await f.close();
		}
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a writer killed mid-transaction never publishes its fence, and pool reads and writes go on (#4314)",
	async () => {
		const f = await chaosRoot();
		const holder = chaosWriter(["hold", f.path, fenceSql(f.attempt)]);
		try {
			assert.equal(await readLine(holder), "locked");
			await readOnlyRequests(f);
			holder.kill("SIGKILL");
			await holder.exited;
			assert.equal(holder.signalCode, "SIGKILL");
			await readOnlyRequests(f);
			assert.equal(await generation(f), f.attempt.generation);
			assert.deepEqual(await f.storage.read((executor) => executor.get("PRAGMA quick_check")), {
				quick_check: "ok",
			});
			const extended = await f.pool.extend(f.lease, f.attempt, POOL_TIMEOUT_MS);
			assert.equal(extended.generation, f.attempt.generation);
			await f.pool.assertCurrent(f.lease, extended);
		} finally {
			holder.kill("SIGKILL");
			await holder.exited;
			await f.close();
		}
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test(
	"under many concurrent writers each pool read sees one commit whole, never authorizes a fenced attempt, and takes no write lock (#4314)",
	async () => {
		const f = await chaosRoot();
		const stopPath = join(f.directory, "stop");
		const writers: SpawnedProcess[] = [];
		try {
			const start = await progress(f);
			for (let index = 0; index < CONCURRENT_WRITERS; index++)
				writers.push(chaosWriter(["fence", f.path, f.attempt.id, stopPath]));
			for (const writer of writers) assert.equal(await readLine(writer), "ready");
			const exec = DatabaseSync.prototype.exec;
			let writeLocksTaken = 0;
			vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
				if (sql === "BEGIN IMMEDIATE") writeLocksTaken += 1;
				return exec.call(this, sql);
			});
			const refusedGenerations = new Set<number>();
			let lastRevision = start.revision;
			let observed = start.generation;
			for (
				let round = 0;
				round < READ_ROUNDS_UNDER_WRITERS || observed < start.generation + FENCES_UNDER_READS;
				round++
			) {
				const snapshot = await progress(f);
				assert.equal(
					snapshot.revision - start.revision,
					snapshot.generation - start.generation,
					"a read saw one writer's transaction in part",
				);
				assert.ok(snapshot.generation >= observed, "a later read saw an earlier commit");
				observed = snapshot.generation;
				if (observed > start.generation)
					await assert.rejects(
						f.pool.assertCurrent(f.lease, { ...f.attempt, generation: observed - 1 }),
						staleWork,
						"a read authorized an attempt fenced before an earlier read",
					);
				const outcome = await refusal(f.pool.assertCurrent(f.lease, { ...f.attempt, generation: observed }));
				if (outcome === "authorized")
					assert.ok(!refusedGenerations.has(observed), "a read authorized an attempt it had refused");
				else {
					assert.equal(outcome, STALE_WORK_LEASE);
					refusedGenerations.add(observed);
				}
				const control = await f.pool.control(f.lease);
				assert.ok(control.revision >= snapshot.revision, "control read an earlier commit than the read before it");
				assert.ok(control.revision >= lastRevision);
				lastRevision = control.revision;
			}
			assert.equal(writeLocksTaken, 0, "pool reads took the write lock");
			await writeFileEnsuringDir(stopPath, "");
			let commits = 0;
			for (const writer of writers) {
				commits += Number(await readLine(writer));
				assert.equal(await writer.exited, 0, await readStreamText(writer.stderr));
			}
			assert.equal(await generation(f), start.generation + commits, "a fence was lost");
		} finally {
			await writeFileEnsuringDir(stopPath, "");
			for (const writer of writers) {
				writer.kill("SIGKILL");
				await writer.exited;
			}
			await f.close();
		}
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform !== "linux")(
	"a writer whose file writes fail, as on a full disk, leaves no fence for pool reads to see, and the journal stays usable (#4314)",
	async () => {
		const f = await chaosRoot();
		try {
			const largest = Math.max(statSync(f.path).size, statSync(`${f.path}-wal`).size);
			const blocks = Math.ceil((largest + FILL_HEADROOM_BYTES) / 1024);
			const writer = chaosWriter(
				["fill", f.path, f.attempt.id, String(FILL_BYTES)],
				["/bin/sh", "-c", `ulimit -f ${blocks} && exec "$0" "$@"`, process.execPath, CHAOS_WRITER],
			);
			const outcome = JSON.parse(await readLine(writer)) as { committed: boolean; errcode?: number };
			assert.equal(await writer.exited, 0, await readStreamText(writer.stderr));
			assert.equal(outcome.committed, false, "the writer was not limited");
			await readOnlyRequests(f);
			assert.equal(await generation(f), f.attempt.generation);
			assert.deepEqual(
				await f.storage.read((executor) =>
					executor.get("SELECT count(*) AS tables FROM sqlite_master WHERE name = 'chaos_fill'"),
				),
				{ tables: 0 },
			);
			assert.deepEqual(await f.storage.read((executor) => executor.get("PRAGMA quick_check")), {
				quick_check: "ok",
			});
			await f.pool.extend(f.lease, f.attempt, POOL_TIMEOUT_MS);
			await f.pool.assertCurrent(f.lease, f.attempt);
		} finally {
			await f.close();
		}
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test(
	"pool reads refuse exactly what pool writes refuse for renewals stamped by a skewed clock (#4314)",
	async () => {
		const f = await chaosRoot();
		const write = (sql: string) => f.storage.transaction((tx) => tx.run(sql));
		const storeNow = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
		try {
			for (const [skewMs, expected] of [
				[-(POOL_TIMEOUT_MS + 60_000), "StaleLeaseError"],
				[-(POOL_TIMEOUT_MS - 60_000), "authorized"],
				[0, "authorized"],
				[60_000, "authorized"],
				[10 * POOL_TIMEOUT_MS, "authorized"],
			] as const) {
				await write(`UPDATE wf_leases SET renewed_at = ${storeNow} + (${skewMs}) WHERE run_id = '${ROOT}'`);
				const read = await refusal(f.pool.control(f.lease));
				const budget = await refusal(f.pool.assertCurrent(f.lease, f.attempt));
				const written = await refusal(f.pool.setControl(f.lease, "running"));
				assert.deepEqual(
					{ skewMs, read, budget, written },
					{ skewMs, read: expected, budget: expected, written: expected },
				);
			}
			await write(`UPDATE wf_leases SET renewed_at = ${storeNow} WHERE run_id = '${ROOT}'`);
			for (const [skewMs, expected] of [
				[-60_000, STALE_WORK_LEASE],
				[60_000, "authorized"],
			] as const) {
				await write(`UPDATE wf_runs_work SET expires_at = ${storeNow} + (${skewMs}) WHERE id = '${f.attempt.id}'`);
				const read = await refusal(f.pool.assertCurrent(f.lease, f.attempt));
				const written = await refusal(f.pool.renew(f.lease, f.attempt, POOL_TIMEOUT_MS));
				assert.deepEqual({ skewMs, read, written }, { skewMs, read: expected, written: expected });
			}
		} finally {
			await f.close();
		}
	},
	CHAOS_TEST_TIMEOUT_MS,
);
