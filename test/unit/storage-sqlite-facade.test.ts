import assert from "node:assert/strict";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import {
	createSqliteDatabase,
	redactSecrets,
	type SqliteDriver,
	type SqliteDriverExecutor,
	type SqliteDriverResult,
	type SqliteDriverTransaction,
	type SqliteStatement,
	StorageError,
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageUnavailableError,
	StoreClosedError,
} from "@bastani/atomic/storage";
import { describe, it, test } from "vitest";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const { DatabaseSync: Database } = await import("node:sqlite");

/** A minimal synchronous node:sqlite driver; every SQLite rule the conformance suite checks comes from the facade. */
function nodeSqliteDriver(path: string, faults: { rollback?: Error } = {}): SqliteDriver {
	const connection: DatabaseSync = new Database(path);
	const executor: SqliteDriverExecutor = {
		execute(sql, params) {
			const statement = connection.prepare(sql);
			statement.setReadBigInts(true);
			const columns = statement.columns().map((column) => column.name);
			if (columns.length === 0) return { columns, rows: [], changes: Number(statement.run(...params).changes) };
			return { columns, rows: statement.all(...params).map((row) => columns.map((name) => row[name]!)), changes: 0 };
		},
		executeMultiple: (sql) => connection.exec(sql),
	};
	return {
		...executor,
		descriptor: { adapter: "facade-node-sqlite", location: path },
		beginTransaction() {
			connection.exec("BEGIN IMMEDIATE");
			return {
				...executor,
				commit: () => connection.exec("COMMIT"),
				rollback() {
					connection.exec("ROLLBACK");
					if (faults.rollback) throw faults.rollback;
				},
			};
		},
		close: () => connection.close(),
	};
}

registerSqliteDatabaseConformance({ describe, it }, "createSqliteDatabase over node:sqlite (#3856)", async (body) => {
	const directory = makeTempDirectory("storage-sqlite-facade-");
	const path = join(directory, "database.sqlite");
	const faults: { rollback?: Error } = {};
	let database = createSqliteDatabase(nodeSqliteDriver(path, faults));
	try {
		await body({
			get database() {
				return database;
			},
			async reopen() {
				await database.close();
				database = createSqliteDatabase(nodeSqliteDriver(path, faults));
				return database;
			},
			async withRollbackFailure(cause, operation) {
				faults.rollback = cause;
				try {
					await operation();
				} finally {
					faults.rollback = undefined;
				}
			},
		});
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
});

/** A scripted driver for behaviours a local database cannot produce on demand. */
function scriptedDriver(
	overrides: Partial<SqliteDriver> & Pick<SqliteDriver, "execute">,
	calls: string[] = [],
): SqliteDriver {
	return {
		descriptor: { adapter: "scripted", location: "scripted://database" },
		executeMultiple: (sql) => void calls.push(`script ${sql}`),
		beginTransaction: () => ({
			execute: (sql, params) => {
				calls.push(`tx ${sql}`);
				return overrides.execute(sql, params);
			},
			executeMultiple: (sql) => void calls.push(`tx script ${sql}`),
			commit: () => void calls.push("commit"),
			rollback: () => void calls.push("rollback"),
			close: () => void calls.push("tx close"),
		}),
		close: () => void calls.push("close"),
		...overrides,
	};
}

test("createSqliteDatabase normalizes driver integers and blobs (#3856)", async () => {
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const database = createSqliteDatabase(
		scriptedDriver({
			execute: () => ({
				columns: ["safe", "large", "buffer", "view", "float", "text", "missing"],
				rows: [[42n, 2n ** 60n, bytes.buffer.slice(1, 3), new DataView(bytes.buffer, 2, 2), 1.5, "x"]],
				changes: 0,
			}),
		}),
	);
	const row = await database.get("SELECT");
	assert.deepEqual(row, {
		safe: 42,
		large: 2n ** 60n,
		buffer: new Uint8Array([2, 3]),
		view: new Uint8Array([3, 4]),
		float: 1.5,
		text: "x",
		missing: null,
	});
	bytes.fill(0);
	assert.deepEqual(row?.view, new Uint8Array([3, 4]));
	await database.close();
});

test("createSqliteDatabase rejects NUL text before the driver runs and keeps call order (#3856)", async () => {
	const calls: string[] = [];
	const database = createSqliteDatabase(
		scriptedDriver(
			{
				execute: (sql, params) => {
					calls.push(`${sql} ${params.join(",")}`);
					return { columns: [], rows: [], changes: 1 };
				},
			},
			calls,
		),
	);
	const outcomes = await Promise.allSettled([
		database.run("first", 1),
		database.run("nul", "ok", "A\0B"),
		database.transaction(async (tx) => {
			await tx.run("inside", 2);
		}),
		database.exec("last"),
	]);
	assert.equal(outcomes[1]?.status, "rejected");
	assert.ok(outcomes[1]?.status === "rejected" && outcomes[1].reason instanceof StorageInvalidTextError);
	assert.equal(outcomes[1].reason.parameterIndex, 1);
	assert.deepEqual(calls, ["first 1", "tx inside", "inside 2", "commit", "tx close", "script last"]);
	await database.close();
});

test("createSqliteDatabase expires transaction handles and drains accepted handle work before commit (#3856)", async () => {
	const calls: string[] = [];
	const release = Promise.withResolvers<void>();
	const database = createSqliteDatabase(
		scriptedDriver(
			{
				execute: async (sql) => {
					if (sql === "slow") await release.promise;
					calls.push(`done ${sql}`);
					return { columns: [], rows: [], changes: 0 };
				},
			},
			calls,
		),
	);
	let handle: Parameters<Parameters<typeof database.transaction>[0]>[0] | undefined;
	let pending: Promise<{ changes: number }> | undefined;
	const transaction = database.transaction(async (tx) => {
		handle = tx;
		pending = tx.run("slow");
	});
	await Promise.resolve();
	setTimeout(() => release.resolve(), 10);
	await transaction;
	assert.deepEqual(await pending, { changes: 0 });
	assert.deepEqual(calls, ["tx slow", "done slow", "commit", "tx close"]);
	await assert.rejects(handle!.run("late"), StorageTransactionClosedError);
	await database.close();
});

test("createSqliteDatabase maps driver failures and redacts credentials from diagnostics (#3856)", async () => {
	const secret = "fixture/secret token";
	const nested = new StorageError(`denied ${encodeURIComponent(secret)}`);
	const failure = new Error(`request to https://u:${secret}@db.example failed`, { cause: nested });
	const plain = new Error("no credentials here");
	const rollbackFailure = new Error(`rollback ${secret}`);
	let fail: Error = failure;
	const database = createSqliteDatabase(
		scriptedDriver({
			descriptor: { adapter: "scripted", location: `https://u:${secret}@db.example` },
			redact: redactSecrets([secret]),
			execute: () => {
				throw fail;
			},
			beginTransaction: () => ({
				execute: () => ({ columns: [], rows: [], changes: 0 }),
				executeMultiple: () => {},
				commit: () => {},
				rollback: () => {
					throw rollbackFailure;
				},
			}),
		}),
	);
	assert.equal(database.descriptor.location, "https://u:[redacted]@db.example");
	await assert.rejects(database.get("SELECT ?", 1), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.adapter, "scripted");
		assert.equal(error.location, "https://u:[redacted]@db.example");
		assert.ok(error.cause instanceof StorageError);
		assert.notEqual(error.cause, failure);
		const rendered = inspect(error, { depth: null });
		assert.equal(rendered.includes(secret), false);
		assert.equal(rendered.includes(encodeURIComponent(secret)), false);
		return true;
	});
	fail = plain;
	await assert.rejects(database.all("SELECT"), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.cause, plain);
		return true;
	});
	const callbackFailure = new Error("callback failed");
	await assert.rejects(
		database.transaction(async () => {
			throw callbackFailure;
		}),
		(error: Error) => {
			assert.ok(error instanceof StorageRollbackError);
			assert.equal(error.cause, callbackFailure);
			assert.ok(error.rollbackCause instanceof StorageUnavailableError);
			assert.equal(inspect(error, { depth: null }).includes(secret), false);
			return true;
		},
	);
	await database.close();
	await assert.rejects(database.exec("SELECT 1"), StoreClosedError);
});

test("transaction close failure preserves callback and rollback failures (#3856)", async () => {
	for (const rollbackFails of [false, true]) {
		const callbackFailure = new Error("callback failed");
		const closeFailure = new Error("close failed");
		const database = createSqliteDatabase(
			scriptedDriver({
				execute: () => ({ columns: [], rows: [], changes: 0 }),
				beginTransaction: () => ({
					execute: () => ({ columns: [], rows: [], changes: 0 }),
					executeMultiple: () => {},
					commit: () => {},
					rollback: () => {
						if (rollbackFails) throw new Error("rollback failed");
					},
					close: async () => {
						throw closeFailure;
					},
				}),
			}),
		);
		try {
			await assert.rejects(
				database.transaction(async () => {
					throw callbackFailure;
				}),
				(error: Error) => {
					if (rollbackFails) {
						assert.ok(error instanceof StorageRollbackError);
						assert.equal(error.cause, callbackFailure);
					} else assert.equal(error, callbackFailure);
					return true;
				},
			);
		} finally {
			await database.close();
		}
	}
});

test("redactSecrets removes encoded forms and longer secrets first (#3856)", () => {
	const redact = redactSecrets(["user", "user-password", "a b/c", "", "\ud800"]);
	assert.equal(redact("user-password user a b/c a%20b%2Fc"), "[redacted] [redacted] [redacted] [redacted]");
	assert.equal(redact("nothing secret"), "nothing secret");
});

/** The node:sqlite driver with a `batch` that runs every statement in one immediate transaction. */
function batchingDriver(path: string): SqliteDriver & { batches: number } {
	const driver = nodeSqliteDriver(path);
	const batching = {
		...driver,
		batches: 0,
		batch(statements: readonly SqliteStatement[]): SqliteDriverResult[] {
			batching.batches++;
			const transaction = driver.beginTransaction() as SqliteDriverTransaction;
			try {
				const results = statements.map(({ sql, params }) => transaction.execute(sql, params) as SqliteDriverResult);
				transaction.commit();
				return results;
			} catch (error) {
				transaction.rollback();
				throw error;
			}
		},
	};
	return batching;
}

test("createSqliteDatabase offers batch only for a driver that sends one (#4083)", async () => {
	const directory = makeTempDirectory("storage-sqlite-facade-batch-");
	try {
		const plain = createSqliteDatabase(nodeSqliteDriver(join(directory, "plain.sqlite")));
		assert.equal(plain.batch, undefined);
		await plain.close();
		const driver = batchingDriver(join(directory, "batch.sqlite"));
		const database = createSqliteDatabase(driver);
		await database.exec("CREATE TABLE t(value)");
		const rows = await database.batch!([
			{ sql: "INSERT INTO t VALUES (?)", params: [1] },
			{ sql: "SELECT changes() AS inserted", params: [] },
			{ sql: "SELECT value FROM t", params: [] },
		]);
		assert.equal(driver.batches, 1);
		assert.deepEqual(rows, [[], [{ inserted: 1 }], [{ value: 1 }]]);
		await assert.rejects(
			database.batch!([
				{ sql: "INSERT INTO t VALUES (?)", params: [2] },
				{ sql: "INSERT INTO t VALUES (?)", params: ["bad\0text"] },
			]),
			StorageInvalidTextError,
		);
		assert.equal(driver.batches, 1, "a batch with NUL text never reaches the driver");
		await assert.rejects(
			database.batch!([{ sql: "INSERT INTO missing VALUES (1)", params: [] }]),
			StorageUnavailableError,
		);
		assert.deepEqual(await database.all("SELECT value FROM t"), [{ value: 1 }]);
		await database.close();
		await assert.rejects(database.batch!([{ sql: "SELECT 1", params: [] }]), StoreClosedError);
	} finally {
		removeTempDirectory(directory);
	}
});
