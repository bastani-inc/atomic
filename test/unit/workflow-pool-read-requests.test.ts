import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type SqliteDatabase,
	type SqliteRow,
	type SqliteValue,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
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
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const header = { runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" };
const running = poolWorkFixture("running");
const finished = poolWorkFixture("finished");
const LEASE_MS = 60_000;
const ROUNDS = 5;
const SQLITE_IOERR = 10;
const SQLITE_READONLY = 8;
const staleWork = { message: STALE_WORK_LEASE };

afterEach(() => {
	vi.restoreAllMocks();
});

interface PooledRoot {
	readonly path: string | undefined;
	readonly connection: DatabaseSync | undefined;
	readonly database: SqliteDatabase;
	readonly journal: SqlRunJournal;
	readonly lease: Lease;
	readonly pool: SqlPoolQueue;
	readonly ledger: SqlPoolUsage;
	readonly attempt: PoolWork;
	readonly completed: PoolWork;
	close(): Promise<void>;
}

type Storage = "file" | "memory" | "facade";

/** A database that runs every statement on `database` but names an adapter other than node:sqlite. */
function facadeOf(database: SqliteDatabase): SqliteDatabase {
	return {
		descriptor: { ...database.descriptor, adapter: "facade" },
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.get<T>(sql, ...params),
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.all<T>(sql, ...params),
		transaction: (callback, options) => database.transaction(callback, options),
		close: () => database.close(),
	};
}

/** A root whose pool holds one running attempt and one completed one. */
async function pooledRoot(storage: Storage = "file"): Promise<PooledRoot> {
	const directory = storage === "memory" ? undefined : makeTempDirectory("pool-read-requests-");
	const path = directory === undefined ? undefined : join(directory, "journal.sqlite");
	const connection = storage === "file" ? new DatabaseSync(path!) : undefined;
	const database =
		storage === "file"
			? wrapNodeSqliteDatabase(connection!)
			: storage === "facade"
				? facadeOf(await openNodeSqliteDatabase(path!))
				: await openNodeSqliteDatabase(":memory:");
	const journal = await SqlRunJournal.open(database);
	await journal.createRun(header);
	const acquired = await journal.acquire(header.runId, "coordinator");
	if (acquired.status !== "acquired") assert.fail("lease not acquired");
	const { lease } = acquired;
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(lease, LEASE_MS);
	await pool.enqueue(lease, running.work, running.boundary);
	await pool.enqueue(lease, finished.work, finished.boundary);
	const attempt = (await pool.claim(lease, "worker", [running.work], LEASE_MS))!;
	const completed = (await pool.claim(lease, "other-worker", [finished.work], LEASE_MS))!;
	await pool.complete(lease, completed, { runId: finished.work.childRunId, status: "completed" });
	const ledger = await openSqlPoolUsage(journal);
	return {
		path,
		connection,
		database,
		journal,
		lease,
		pool,
		ledger,
		attempt,
		completed,
		async close() {
			await journal.close();
			await database.close();
			connection?.close();
			if (directory !== undefined) removeTempDirectory(directory);
		},
	};
}

/** What the coordinator reads for each request it answers without changing the pool. */
function readOnlyRequests(f: PooledRoot) {
	return {
		control: () => f.pool.control(f.lease),
		budget: async () => {
			await f.pool.assertCurrent(f.lease, f.attempt);
			return f.pool.control(f.lease);
		},
		recovery: () => f.pool.inspect(header.runId),
		result: () => f.pool.result(header.runId, f.completed.id),
		usage: () => f.ledger.total(header.runId),
		rootLease: () => f.pool.rootLease(f.lease, LEASE_MS),
		initialized: () => f.pool.initialized(header.runId),
	};
}
const READS_PER_ROUND = 8;

function countExecutedStatements(primary: DatabaseSync | undefined) {
	const statements: { readonly connection: DatabaseSync; readonly sql: string }[] = [];
	const closed: DatabaseSync[] = [];
	const exec = DatabaseSync.prototype.exec;
	const close = DatabaseSync.prototype.close;
	vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
		statements.push({ connection: this, sql });
		return exec.call(this, sql);
	});
	vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
		closed.push(this);
		return close.call(this);
	});
	const count = (onPrimary: boolean, sql: string) =>
		statements.filter((statement) => (statement.connection === primary) === onPrimary && statement.sql === sql)
			.length;
	const readers = () =>
		new Set(statements.map((statement) => statement.connection).filter((connection) => connection !== primary));
	return { count, readers, closed };
}

test("read-only pool requests open no write transaction, one read transaction each (#4314)", async () => {
	const f = await pooledRoot();
	try {
		const requests = readOnlyRequests(f);
		await requests.usage();
		const transactions = vi.spyOn(f.database, "transaction");
		const { count, readers, closed } = countExecutedStatements(f.connection!);
		for (let round = 0; round < ROUNDS; round++) for (const request of Object.values(requests)) await request();
		assert.deepEqual(
			{
				writeTransactions: transactions.mock.calls.length,
				primaryBeginImmediate: count(true, "BEGIN IMMEDIATE"),
				primaryCommits: count(true, "COMMIT"),
				readerBeginImmediate: count(false, "BEGIN IMMEDIATE"),
			},
			{ writeTransactions: 0, primaryBeginImmediate: 0, primaryCommits: 0, readerBeginImmediate: 0 },
		);
		assert.deepEqual(
			{ readerBegins: count(false, "BEGIN"), readerCommits: count(false, "COMMIT") },
			{ readerBegins: ROUNDS * READS_PER_ROUND, readerCommits: ROUNDS * READS_PER_ROUND },
		);
		assert.equal(readers().size, 1, "every read runs on one reader connection");
		await f.journal.close();
		assert.deepEqual(
			closed.filter((connection) => connection !== f.connection),
			[...readers()],
			"closing the journal closes its reader",
		);
	} finally {
		await f.close();
	}
});

test("read-only pool requests are answered while another connection holds the write lock and a write waits for it (#4314)", async () => {
	const f = await pooledRoot();
	const holder = new DatabaseSync(f.path!);
	let holding = false;
	try {
		const requests = readOnlyRequests(f);
		await requests.usage();
		holder.exec("BEGIN IMMEDIATE");
		holding = true;
		let extended = false;
		const waiting = f.pool.extend(f.lease, f.attempt, 2 * LEASE_MS).then((work) => {
			extended = true;
			return work;
		});
		const answers = [];
		for (const request of Object.values(requests)) answers.push(await request());
		assert.deepEqual(answers.slice(0, 2), [
			{ state: "running", revision: 0 },
			{ state: "running", revision: 0 },
		]);
		assert.equal(extended, false, "the write waits for the lock the reads never took");
		holder.exec("COMMIT");
		holding = false;
		assert.ok((await waiting).expiresAt > f.attempt.expiresAt);
	} finally {
		if (holding) holder.exec("ROLLBACK");
		holder.close();
		await f.close();
	}
});

test.each(["file", "memory", "facade"] as const)(
	"a pool read refuses every fenced caller the write transaction refused (#4314, %s)",
	async (storage) => {
		const f = await pooledRoot(storage);
		try {
			await f.pool.assertCurrent(f.lease, f.attempt);
			await assert.rejects(f.pool.assertCurrent(f.lease, f.completed), staleWork);
			await assert.rejects(f.pool.assertCurrent(f.lease, { ...f.attempt, generation: 0 }), staleWork);
			await assert.rejects(f.pool.assertCurrent(f.lease, { ...f.attempt, worker: "other-worker" }), staleWork);

			await f.journal.createRun({ ...header, runId: "unpooled" });
			const unpooled = await f.journal.acquire("unpooled", "coordinator");
			if (unpooled.status !== "acquired") assert.fail("lease not acquired");
			await assert.rejects(f.pool.control(unpooled.lease), /Pool not initialized/);

			const storageOf = sqlPoolStorage(f.journal)!;
			const write = (sql: string) => storageOf.transaction((tx) => tx.run(sql));
			await write(`UPDATE wf_runs_work SET expires_at = 0 WHERE id = '${f.attempt.id}'`);
			await assert.rejects(f.pool.assertCurrent(f.lease, f.attempt), staleWork);
			assert.equal(await f.pool.expire(f.lease, f.attempt), true);
			const replacement = (await f.pool.claim(f.lease, "worker", [running.work], LEASE_MS))!;
			assert.equal(replacement.generation, f.attempt.generation + 1);
			await assert.rejects(f.pool.assertCurrent(f.lease, f.attempt), staleWork);
			await f.pool.assertCurrent(f.lease, replacement);

			await write("UPDATE wf_leases SET renewed_at = 0");
			await assert.rejects(f.pool.control(f.lease), StaleLeaseError);
			await assert.rejects(f.pool.assertCurrent(f.lease, replacement), StaleLeaseError);
			await f.journal.renew(f.lease);
			assert.deepEqual(await f.pool.control(f.lease), { state: "running", revision: 0 });

			await f.journal.release(f.lease);
			const reacquired = await f.journal.acquire(header.runId, f.lease.holderId);
			if (reacquired.status !== "acquired") assert.fail("lease not reacquired");
			assert.equal(reacquired.lease.epoch, f.lease.epoch + 1);
			await assert.rejects(f.pool.control(f.lease), StaleLeaseError);
			await assert.rejects(f.pool.assertCurrent(f.lease, replacement), StaleLeaseError);
			await assert.rejects(f.pool.assertCurrent(reacquired.lease, replacement), staleWork);
			const paused = await f.pool.setControl(reacquired.lease, "paused");
			assert.deepEqual(await f.pool.control(reacquired.lease), paused);
		} finally {
			await f.close();
		}
	},
);

test("a fence another connection commits refuses the next read, and one read sees one snapshot (#4314)", async () => {
	const f = await pooledRoot();
	const peerDatabase = await openNodeSqliteDatabase(f.path!);
	const peer = await SqlRunJournal.open(peerDatabase);
	const fencer = new DatabaseSync(f.path!);
	try {
		const peerPool = await openSqlPoolQueue(peer);
		const generation = `SELECT generation FROM wf_runs_work WHERE id = '${f.attempt.id}'`;
		const seen = await sqlPoolStorage(f.journal)!.read(async (executor) => {
			const before = await executor.get(generation);
			fencer.exec(`UPDATE wf_runs_work SET generation = generation + 1 WHERE id = '${f.attempt.id}'`);
			return [before, await executor.get(generation)];
		});
		assert.deepEqual(seen, [{ generation: f.attempt.generation }, { generation: f.attempt.generation }]);
		await assert.rejects(f.pool.assertCurrent(f.lease, f.attempt), staleWork);
		fencer.exec(`UPDATE wf_runs_work SET generation = generation - 1 WHERE id = '${f.attempt.id}'`);
		await f.pool.assertCurrent(f.lease, f.attempt);

		fencer.exec("UPDATE wf_leases SET renewed_at = 0");
		const takeover = await peer.takeoverExpired(header.runId, "resumed-coordinator", LEASE_MS);
		if (takeover.status !== "acquired") assert.fail("takeover failed");
		assert.equal(await peerPool.releasePreviousIncarnations(takeover.lease), 1);
		await assert.rejects(f.pool.control(f.lease), StaleLeaseError);
		await assert.rejects(f.pool.assertCurrent(f.lease, f.attempt), StaleLeaseError);
		await assert.rejects(f.pool.assertCurrent(takeover.lease, f.attempt), staleWork);
		assert.equal(
			(await f.pool.inspect(header.runId)).find((work) => work.id === f.attempt.id)?.state,
			"ready",
			"the read sees the other connection's release",
		);
	} finally {
		fencer.close();
		await peer.close();
		await peerDatabase.close();
		await f.close();
	}
});

test("the pool reader refuses writes (#4314)", async () => {
	const f = await pooledRoot();
	try {
		const refused = await sqlPoolStorage(f.journal)!
			.read((executor) => executor.run("UPDATE wf_runs_work SET state = 'ready'"))
			.then(
				() => assert.fail("a pool read wrote"),
				(error: unknown) => error,
			);
		assert.ok(refused instanceof StorageUnavailableError);
		assert.equal(refused.adapter, "node-sqlite");
		assert.equal((refused.cause as { readonly errcode?: number }).errcode, SQLITE_READONLY);
		assert.equal((await f.pool.inspect(header.runId)).find((work) => work.id === f.attempt.id)?.state, "leased");
		await f.pool.assertCurrent(f.lease, f.attempt);
	} finally {
		await f.close();
	}
});

function failReaderRollbacks(f: PooledRoot): void {
	const exec = DatabaseSync.prototype.exec;
	vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
		exec.call(this, sql);
		if (this !== f.connection && sql === "ROLLBACK")
			throw Object.assign(new Error("disk I/O error"), { errcode: SQLITE_IOERR });
	});
}

function assertReaderRollbackFailure(cleanupCause: unknown): void {
	assert.ok(cleanupCause instanceof StorageUnavailableError);
	assert.equal(cleanupCause.adapter, "node-sqlite");
	assert.equal((cleanupCause.cause as { readonly errcode?: number }).errcode, SQLITE_IOERR);
}

test("a failed read keeps its own error when its rollback fails too, with the rollback failure attached (#4314)", async () => {
	const f = await pooledRoot();
	try {
		await f.pool.assertCurrent(f.lease, f.attempt);
		failReaderRollbacks(f);
		const refused = await f.pool.assertCurrent(f.lease, { ...f.attempt, generation: 0 }).then(
			() => assert.fail("a stale attempt was authorized"),
			(error: unknown) => error,
		);
		assert.ok(refused instanceof Error);
		assert.equal(refused.message, STALE_WORK_LEASE);
		const attached = Object.getOwnPropertyDescriptor(refused, "cleanupCause");
		assertReaderRollbackFailure(attached?.value);
		assert.deepEqual(
			{ ...attached, value: undefined },
			{ value: undefined, writable: false, enumerable: false, configurable: true },
			"a later cleanup can still attach its own cause",
		);
		vi.restoreAllMocks();
		await f.pool.assertCurrent(f.lease, f.attempt);
	} finally {
		await f.close();
	}
});

test("a read that fails with something other than an Error, and whose rollback fails too, fails as storage unavailable (#4314)", async () => {
	const f = await pooledRoot();
	try {
		await f.pool.assertCurrent(f.lease, f.attempt);
		failReaderRollbacks(f);
		const thrown = { reason: "not an Error" };
		const refused = await sqlPoolStorage(f.journal)!
			.read(() => Promise.reject(thrown))
			.then(
				() => assert.fail("the read succeeded"),
				(error: unknown) => error,
			);
		assert.ok(refused instanceof StorageUnavailableError);
		assert.equal(refused.adapter, "node-sqlite");
		assert.equal(refused.cause, thrown);
		assertReaderRollbackFailure(
			(refused as StorageUnavailableError & { readonly cleanupCause?: unknown }).cleanupCause,
		);
	} finally {
		await f.close();
	}
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"a pool reader that cannot be opened fails the read, and the next read opens it (#4314)",
	async () => {
		const f = await pooledRoot();
		try {
			chmodSync(f.path!, 0o000);
			const refused = await f.pool.control(f.lease).then(
				() => assert.fail("the reader opened an unreadable file"),
				(error: unknown) => error,
			);
			chmodSync(f.path!, 0o600);
			assert.ok(refused instanceof StorageUnavailableError);
			assert.equal(refused.adapter, "node-sqlite");
			assert.deepEqual(await f.pool.control(f.lease), { state: "running", revision: 0 });
		} finally {
			chmodSync(f.path!, 0o600);
			await f.close();
		}
	},
);

test("a usage total takes a write transaction only to keep a missing total, then reads it (#4314)", async () => {
	const f = await pooledRoot();
	try {
		const transactions = vi.spyOn(f.database, "transaction");
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		assert.deepEqual(await f.ledger.total(header.runId), zero);
		assert.equal(transactions.mock.calls.length, 1);
		assert.deepEqual(await f.ledger.report(f.lease, f.attempt, [{ key: "stage", usage: { ...zero, input: 7 } }]), {
			...zero,
			input: 7,
		});
		const tenths = Array.from({ length: 10 }, (_, index) => ({
			key: `tenth-${index}`,
			usage: { ...zero, cost: 0.1 },
		}));
		assert.equal((await f.ledger.report(f.lease, f.attempt, tenths)).cost, 1);
		transactions.mockClear();
		for (let round = 0; round < ROUNDS; round++)
			assert.deepEqual(await f.ledger.total(header.runId), { ...zero, input: 7, cost: 1 });
		assert.equal(transactions.mock.calls.length, 0);
	} finally {
		await f.close();
	}
});

test("concurrent pool reads take turns on the reader, each in a read transaction of its own (#4314)", async () => {
	const f = await pooledRoot();
	try {
		const requests = readOnlyRequests(f);
		await requests.usage();
		const rounds = await Promise.all(
			Array.from({ length: ROUNDS }, () => Promise.all(Object.values(requests).map((request) => request()))),
		);
		for (const answers of rounds) assert.deepEqual(answers, rounds[0]);
	} finally {
		await f.close();
	}
});

test.each(["memory", "facade"] as const)(
	"a journal no other connection can open answers pool reads on its own connection, outside any transaction (#4314, %s)",
	async (storage) => {
		const f = await pooledRoot(storage);
		try {
			const requests = readOnlyRequests(f);
			await requests.usage();
			const transactions = vi.spyOn(f.database, "transaction");
			const { count } = countExecutedStatements(undefined);
			for (const request of Object.values(requests)) await request();
			assert.deepEqual(
				{
					writeTransactions: transactions.mock.calls.length,
					beginImmediate: count(false, "BEGIN IMMEDIATE"),
					readTransactions: count(false, "BEGIN"),
				},
				{ writeTransactions: 0, beginImmediate: 0, readTransactions: 0 },
			);
		} finally {
			await f.close();
		}
	},
);

test("a pool read on a closed journal fails as storage unavailable (#4314)", async () => {
	const f = await pooledRoot();
	try {
		await f.journal.close();
		const refused = await f.pool.control(f.lease).then(
			() => assert.fail("a closed journal answered"),
			(error: unknown) => error,
		);
		assert.ok(refused instanceof StorageUnavailableError);
		assert.equal(refused.adapter, "node-sqlite");
	} finally {
		await f.close();
	}
});
