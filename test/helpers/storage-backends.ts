import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient, type Transaction } from "@libsql/client";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { WithSqliteDatabaseSubject } from "../../packages/coding-agent/src/core/storage/testing.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

/**
 * The storage backends every store's conformance suite runs on (#4793): a local SQLite file, a libSQL server (sqld)
 * over HTTP through the shipped adapter, and Postgres. A server backend runs when its URL is set:
 *   ATOMIC_TEST_LIBSQL_URL=http://127.0.0.1:8080          docker run -d -p 127.0.0.1:8080:8080 -e SQLD_CHECKPOINT_INTERVAL_S=60 ghcr.io/tursodatabase/libsql-server:v0.24.33
 *   ATOMIC_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:5432/postgres, ATOMIC_TEST_POSTGRES_PASSWORD=pw
 *                                                         docker run -d -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=pw postgres:16
 * Locally a missing URL skips that backend's rows. `ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED=1`, which CI's storage
 * conformance job sets, makes a missing URL fail instead, so a broken service never passes as skipped rows.
 */

/** One isolated place to keep state in: every suite registered against a backend runs in a scope of its own. */
export interface StorageBackendScope {
	/** The table prefix every store opened in this scope uses, so scopes on one shared server never collide. */
	readonly prefix: string;
	/** Another connection to this scope's database, as a second host would open; closed with the scope. */
	connect(): Promise<SqliteDatabase>;
	/** Closes every connection and removes everything the scope wrote. */
	close(): Promise<void>;
}

export interface StorageBackend {
	readonly name: string;
	/** Why this backend's rows do not run here, or undefined when they do. */
	readonly skipReason: string | undefined;
	openScope(): Promise<StorageBackendScope>;
	/** Runs `operation` while every rollback this backend's driver sends fails with `cause`. */
	withRollbackFailure(cause: Error, operation: () => Promise<void>): Promise<void>;
}

const required = process.env.ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED === "1";

/** The server URL in `variable`, or why the backend is skipped; with backends required, a missing URL throws. */
function serverUrl(variable: string): { readonly url: string } | { readonly skipReason: string } {
	const url = process.env[variable];
	if (url !== undefined && url !== "") return { url };
	if (required) throw new Error(`ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED=1 but ${variable} is not set`);
	return { skipReason: `${variable} is not set` };
}

function scopePrefix(): string {
	return `c${randomBytes(6).toString("hex")}_`;
}

/** Opens connections through `open` and closes every one of them, whatever the suite left open. */
function connections(open: () => Promise<SqliteDatabase>) {
	const opened: SqliteDatabase[] = [];
	return {
		async connect() {
			const database = await open();
			opened.push(database);
			return database;
		},
		async closeAll() {
			await Promise.all(opened.splice(0).map((database) => database.close()));
		},
	};
}

export const sqliteFileBackend: StorageBackend = {
	name: "SQLite file",
	skipReason: undefined,
	async openScope() {
		const directory = makeTempDirectory("atomic-storage-matrix-");
		const path = join(directory, "database.sqlite");
		const pool = connections(() => openNodeSqliteDatabase(path));
		return {
			prefix: scopePrefix(),
			connect: pool.connect,
			async close() {
				try {
					await pool.closeAll();
				} finally {
					removeTempDirectory(directory);
				}
			},
		};
	},
	async withRollbackFailure(cause, operation) {
		const exec = DatabaseSync.prototype.exec;
		DatabaseSync.prototype.exec = function (sql) {
			if (sql === "ROLLBACK") throw cause;
			return exec.call(this, sql);
		};
		try {
			await operation();
		} finally {
			DatabaseSync.prototype.exec = exec;
		}
	},
};

/**
 * Tables the facade suite (`registerSqliteDatabaseConformance`) creates under fixed names. A scope on the shared server
 * drops them too, so its runs start from nothing; no other suite on the server uses them.
 */
const FACADE_SUITE_TABLES = ["children", "parents", "items", "concurrent_items"];

/** Drops the scope's tables on a shared libSQL server; a table another still references is retried after it. */
async function dropLibsqlScope(database: SqliteDatabase, prefix: string): Promise<void> {
	const rows = await database.all(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND (substr(name, 1, length(?)) = ? OR name IN (?, ?, ?, ?))",
		prefix,
		prefix,
		...FACADE_SUITE_TABLES,
	);
	let pending = rows.map((row) => String(row.name));
	while (pending.length > 0) {
		const failed: string[] = [];
		let cause: unknown;
		for (const name of pending) {
			await database.exec(`DROP TABLE IF EXISTS "${name}"`).catch((error: unknown) => {
				failed.push(name);
				cause = error;
			});
		}
		if (failed.length === pending.length)
			throw new Error(`could not drop ${failed.join(", ")} on the libSQL server`, { cause });
		pending = failed;
	}
}

function libsqlServerBackend(): StorageBackend {
	const server = serverUrl("ATOMIC_TEST_LIBSQL_URL");
	return {
		name: "libSQL server (sqld)",
		skipReason: "skipReason" in server ? server.skipReason : undefined,
		async openScope() {
			if (!("url" in server)) throw new Error("the libSQL server backend is skipped here");
			const { url } = server;
			const prefix = scopePrefix();
			const cleanup = async () => {
				const database = await openLibsqlDatabase({ url });
				try {
					await dropLibsqlScope(database, prefix);
				} finally {
					await database.close();
				}
			};
			await cleanup();
			const pool = connections(() => openLibsqlDatabase({ url }));
			return {
				prefix,
				connect: pool.connect,
				async close() {
					try {
						await pool.closeAll();
					} finally {
						await cleanup();
					}
				},
			};
		},
		async withRollbackFailure(cause, operation) {
			if (!("url" in server)) throw new Error("the libSQL server backend is skipped here");
			// The adapter and this probe share one @libsql/client, so patching the HTTP transaction's prototype reaches
			// the adapter's transactions too.
			const client = createClient({ url: server.url });
			try {
				const probe = await client.transaction("write");
				const prototype = Object.getPrototypeOf(probe) as Pick<Transaction, "rollback">;
				try {
					await probe.rollback();
				} finally {
					probe.close();
				}
				const rollback = prototype.rollback;
				prototype.rollback = async () => {
					throw cause;
				};
				try {
					await operation();
				} finally {
					prototype.rollback = rollback;
				}
			} finally {
				client.close();
			}
		},
	};
}

function postgresBackend(): StorageBackend {
	serverUrl("ATOMIC_TEST_POSTGRES_URL");
	const skipReason = "the Postgres storage adapter lands in P2 of #4793; until then its rows are todo";
	const skipped = () => Promise.reject(new Error(skipReason));
	return { name: "Postgres", skipReason, openScope: skipped, withRollbackFailure: skipped };
}

export const storageBackends: readonly StorageBackend[] = [sqliteFileBackend, libsqlServerBackend(), postgresBackend()];

/** The facade suite's subject on `backend`: one connection, reopened as a fresh one on the same scope. */
export function databaseSubject(backend: StorageBackend): WithSqliteDatabaseSubject {
	return async (body) => {
		const scope = await backend.openScope();
		try {
			let database = await scope.connect();
			await body({
				get database() {
					return database;
				},
				async reopen() {
					await database.close();
					database = await scope.connect();
					return database;
				},
				withRollbackFailure: (cause, operation) => backend.withRollbackFailure(cause, operation),
			});
		} finally {
			await scope.close();
		}
	};
}
