import assert from "node:assert/strict";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	applyStorageMigrations,
	createSqliteDatabase,
	openNodeSqliteDatabase,
	type SqliteDatabase,
	type SqliteDriver,
	type SqliteDriverExecutor,
	type SqliteDriverTransactionOptions,
	type SqliteRow,
	StorageConfigError,
	type StorageDialect,
	type StorageMigrationStep,
	StorageSchemaVersionError,
	sqliteDialect,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import {
	SESSION_PRESENCE_DOMAIN,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const { DatabaseSync: Database } = await import("node:sqlite");

/** SQLite with a migration ledger: the versioned path Postgres takes, run on a real engine. */
const ledgerDialect: StorageDialect = { ...sqliteDialect, versionedMigrations: true };

/** A node:sqlite driver that speaks `dialect` and records how each transaction was begun. */
function recordingDriver(path: string, dialect: StorageDialect, begun: SqliteDriverTransactionOptions[]): SqliteDriver {
	const connection: DatabaseSync = new Database(path);
	const executor: SqliteDriverExecutor = {
		execute(sql, params) {
			const statement = connection.prepare(sql);
			const columns = statement.columns().map((column) => column.name);
			if (columns.length === 0) return { columns, rows: [], changes: Number(statement.run(...params).changes) };
			return { columns, rows: statement.all(...params).map((row) => columns.map((name) => row[name]!)), changes: 0 };
		},
		executeMultiple: (sql) => connection.exec(sql),
	};
	return {
		...executor,
		dialect,
		descriptor: { adapter: "migration-test", location: path },
		beginTransaction(options) {
			if (options) begun.push(options);
			connection.exec("BEGIN IMMEDIATE");
			return { ...executor, commit: () => connection.exec("COMMIT"), rollback: () => connection.exec("ROLLBACK") };
		},
		close: () => connection.close(),
	};
}

/** A database from `openNodeSqliteDatabase` (one connection, cross-connection lock waits) speaking `dialect`. */
function withDialect(database: SqliteDatabase, dialect: StorageDialect): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		dialect,
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: (sql, ...params) => database.get(sql, ...params),
		all: (sql, ...params) => database.all(sql, ...params),
		transaction: (callback, options) => database.transaction(callback, options),
		close: () => database.close(),
	};
}

const tableStep = (version: number, table: string): StorageMigrationStep => ({
	version,
	up: async (transaction, dialect) => {
		await transaction.exec(`CREATE TABLE ${table} (id ${dialect.types.int} PRIMARY KEY)${dialect.tableOptions}`);
	},
});

let directory: string;
let path: string;
beforeEach(() => {
	directory = makeTempDirectory("storage-migrations-");
	path = join(directory, "store.sqlite");
});
afterEach(() => removeTempDirectory(directory));

async function tables(database: SqliteDatabase): Promise<string[]> {
	const rows = await database.all<SqliteRow & { name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
	);
	return rows.map((row) => row.name);
}

test("a domain that accepts newer versions runs nothing on a newer recorded version and reports it (#5065)", async () => {
	const database = createSqliteDatabase(recordingDriver(path, ledgerDialect, []));
	try {
		await applyStorageMigrations(database, "presence", [tableStep(1, "one"), tableStep(2, "two")]);
		assert.deepEqual(
			await applyStorageMigrations(database, "presence", [tableStep(1, "one")], { acceptNewer: true }),
			{ applied: [], version: 2 },
		);
		const versions = await database.all("SELECT version FROM atomic_migrations ORDER BY version");
		assert.deepEqual(versions, [{ version: 1 }, { version: 2 }]);
	} finally {
		await database.close();
	}
});

test("a versioned store applies only missing steps, once each, and records them (#4793)", async () => {
	const begun: SqliteDriverTransactionOptions[] = [];
	const database = createSqliteDatabase(recordingDriver(path, ledgerDialect, begun));
	try {
		const steps = [tableStep(1, "one"), tableStep(2, "two")];
		assert.deepEqual(await applyStorageMigrations(database, "sessions", steps, { table: "team_migrations" }), {
			applied: [1, 2],
			version: 2,
		});
		assert.deepEqual(await applyStorageMigrations(database, "sessions", steps, { table: "team_migrations" }), {
			applied: [],
			version: 2,
		});
		assert.deepEqual(
			await applyStorageMigrations(database, "sessions", [...steps, tableStep(3, "three")], {
				table: "team_migrations",
			}),
			{ applied: [3], version: 3 },
		);
		assert.deepEqual(
			await applyStorageMigrations(database, "journal", [tableStep(1, "j")], { table: "team_migrations" }),
			{
				applied: [1],
				version: 1,
			},
		);
		const ledger = await database.all<SqliteRow & { applied_at: number }>(
			"SELECT domain, version, applied_at FROM team_migrations ORDER BY domain, version",
		);
		assert.deepEqual(
			ledger.map(({ domain, version }) => [domain, version]),
			[
				["journal", 1],
				["sessions", 1],
				["sessions", 2],
				["sessions", 3],
			],
		);
		assert.ok(ledger.every((row) => Number.isInteger(row.applied_at) && row.applied_at > 1_600_000_000_000));
		assert.deepEqual(await tables(database), ["j", "one", "team_migrations", "three", "two"]);
		assert.deepEqual(begun.at(-1), { concurrency: { kind: "serial", domain: "team_migrations" } });
	} finally {
		await database.close();
	}
});

test("a versioned store with no steps records nothing and reports version 0 (#4793)", async () => {
	const database = createSqliteDatabase(recordingDriver(path, ledgerDialect, []));
	try {
		assert.deepEqual(await applyStorageMigrations(database, "sessions", []), { applied: [], version: 0 });
		assert.deepEqual(await database.all("SELECT * FROM atomic_migrations"), []);
	} finally {
		await database.close();
	}
});

test("a migration runs again after a transient failure that applied nothing (#4793)", async () => {
	const begun: SqliteDriverTransactionOptions[] = [];
	const driver = recordingDriver(path, ledgerDialect, begun);
	const begin = driver.beginTransaction.bind(driver);
	const lost = Object.assign(new Error("connection refused"), { lost: true });
	let failures = 1;
	const database = createSqliteDatabase({
		...driver,
		beginTransaction(options) {
			if (failures-- > 0) throw lost;
			return begin(options);
		},
		transientFailure: (failure) =>
			failure === lost ? { code: "connection-refused", outcome: "not-applied" } : undefined,
	});
	const warned = new Promise((resolve) => process.once("warning", resolve));
	try {
		assert.deepEqual(await applyStorageMigrations(database, "sessions", [tableStep(1, "one")]), {
			applied: [1],
			version: 1,
		});
		await warned;
		assert.equal(begun.length, 1);
	} finally {
		await database.close();
	}
});

test("a versioned store refuses a newer recorded version and changes nothing (#4793)", async () => {
	const database = createSqliteDatabase(recordingDriver(path, ledgerDialect, []));
	try {
		await applyStorageMigrations(database, "sessions", [tableStep(1, "one"), tableStep(2, "two")]);
		await assert.rejects(
			applyStorageMigrations(database, "sessions", [tableStep(1, "one")]),
			(error: StorageSchemaVersionError) =>
				error instanceof StorageSchemaVersionError &&
				error.domain === "sessions" &&
				error.found === 2 &&
				error.supported === 1,
		);
		const versions = await database.all("SELECT version FROM atomic_migrations ORDER BY version");
		assert.deepEqual(versions, [{ version: 1 }, { version: 2 }]);
	} finally {
		await database.close();
	}
});

test("a failed step rolls back the whole migration, ledger included (#4793)", async () => {
	const database = createSqliteDatabase(recordingDriver(path, ledgerDialect, []));
	try {
		const failure = new Error("step failed");
		const failing: StorageMigrationStep = {
			version: 2,
			up: async (transaction) => {
				await transaction.exec("CREATE TABLE half (id INTEGER)");
				throw failure;
			},
		};
		await assert.rejects(applyStorageMigrations(database, "sessions", [tableStep(1, "one"), failing]), failure);
		assert.deepEqual(await tables(database), []);
		assert.deepEqual(await applyStorageMigrations(database, "sessions", [tableStep(1, "one")]), {
			applied: [1],
			version: 1,
		});
	} finally {
		await database.close();
	}
});

test("SQLite runs every idempotent step and adds no table of its own (#4793)", async () => {
	const begun: SqliteDriverTransactionOptions[] = [];
	const database = createSqliteDatabase(recordingDriver(path, sqliteDialect, begun));
	const runs: number[] = [];
	const steps: StorageMigrationStep[] = [1, 2].map((version) => ({
		version,
		up: async (transaction, dialect) => {
			assert.equal(dialect, sqliteDialect);
			runs.push(version);
			await transaction.exec(`CREATE TABLE IF NOT EXISTS t${version} (id INTEGER)${dialect.tableOptions}`);
		},
	}));
	try {
		assert.deepEqual(await applyStorageMigrations(database, "sessions", steps), { applied: [1, 2], version: 2 });
		assert.deepEqual(await applyStorageMigrations(database, "sessions", steps), { applied: [1, 2], version: 2 });
		assert.deepEqual(runs, [1, 2, 1, 2]);
		assert.deepEqual(await tables(database), ["t1", "t2"]);
		assert.deepEqual(begun, [
			{ concurrency: { kind: "serial", domain: "atomic_migrations" } },
			{ concurrency: { kind: "serial", domain: "atomic_migrations" } },
		]);
		assert.deepEqual(await applyStorageMigrations(database, "sessions", []), { applied: [], version: 0 });
	} finally {
		await database.close();
	}
});

test("migration steps must be numbered in increasing order (#4793)", async () => {
	const database = createSqliteDatabase(recordingDriver(path, ledgerDialect, []));
	try {
		for (const versions of [[0], [1, 1], [2, 1], [1.5], [-1], [Number.NaN]]) {
			await assert.rejects(
				applyStorageMigrations(
					database,
					"sessions",
					versions.map((version) => tableStep(version, "never")),
				),
				(error: StorageConfigError) =>
					error instanceof StorageConfigError &&
					error.source === "sdk" &&
					error.field === "steps" &&
					error.reason === "versions-increasing" &&
					error.hint === "Number migration steps 1, 2, 3, … in increasing order",
			);
		}
		assert.deepEqual(await tables(database), []);
	} finally {
		await database.close();
	}
});

test("concurrent migrators on separate connections apply each versioned step once (#4793)", async () => {
	const migrators = 8;
	const applied: number[] = [];
	const steps: StorageMigrationStep[] = [1, 2].map((version) => ({
		version,
		up: async (transaction) => {
			applied.push(version);
			// Not idempotent: a second run of the step fails, so only the ledger keeps it from running twice.
			await transaction.exec(`CREATE TABLE t${version} (id INTEGER)`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		},
	}));
	const databases = await Promise.all(
		Array.from({ length: migrators }, async () => withDialect(await openNodeSqliteDatabase(path), ledgerDialect)),
	);
	try {
		const results = await Promise.all(databases.map((database) => applyStorageMigrations(database, "d", steps)));
		assert.deepEqual(applied, [1, 2]);
		assert.deepEqual(
			results.map((result) => result.version),
			Array(migrators).fill(2),
		);
		assert.deepEqual(
			results.flatMap((result) => result.applied),
			[1, 2],
		);
	} finally {
		await Promise.all(databases.map((database) => database.close()));
	}
});

test("concurrent SQLite migrators all finish with the schema made once (#4793)", async () => {
	const migrators = 8;
	const step: StorageMigrationStep = {
		version: 1,
		up: async (transaction) => {
			await transaction.exec("CREATE TABLE IF NOT EXISTS meta (schema_version INTEGER NOT NULL) STRICT");
			await transaction.run("INSERT INTO meta SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM meta)");
		},
	};
	const databases = await Promise.all(Array.from({ length: migrators }, () => openNodeSqliteDatabase(path)));
	try {
		const results = await Promise.all(databases.map((database) => applyStorageMigrations(database, "d", [step])));
		assert.ok(results.every((result) => result.version === 1));
		assert.deepEqual(await databases[0]!.all("SELECT schema_version FROM meta"), [{ schema_version: 1 }]);
		assert.deepEqual(await tables(databases[0]!), ["meta"]);
	} finally {
		await Promise.all(databases.map((database) => database.close()));
	}
});

test("a newer build's session-presence version does not lock this build out of the sessions (#5065)", async () => {
	const database = createSqliteDatabase(recordingDriver(path, ledgerDialect, []));
	try {
		await (await SqlSessionStore.open(database)).close();
		// A newer build added a presence step this build does not know; presence is not needed to read or write sessions.
		await database.run("INSERT INTO atomic_migrations VALUES (?, 4, 0)", SESSION_PRESENCE_DOMAIN);
		const store = await SqlSessionStore.open(database);
		await store.create({ id: "s", version: 4, createdAt: "2026-01-01T00:00:00.000Z", cwd: "/w" }, []);
		assert.equal((await store.load("s")).lastSeq, 0);
		await store.close();
	} finally {
		await database.close();
	}
});
