import { randomBytes } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { WithSqliteDatabaseSubject } from "../../packages/coding-agent/src/core/storage/testing.js";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";
import { interceptConnectionRequests, isExec } from "./sqlite-connection-requests.js";

/**
 * The storage backends every store's conformance suite runs on (#4793): a local SQLite file and Postgres. The Postgres
 * backend runs when its URL is set:
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
	/**
	 * `facadeTables`: the scope also starts and ends without the tables the facade suite creates under fixed names. Only
	 * that suite asks for it, so a scope another file opens on a shared server never drops a table the facade suite,
	 * running beside it, is using.
	 */
	openScope(options?: { readonly facadeTables?: boolean }): Promise<StorageBackendScope>;
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

/** Ten characters: the longest prefix PostgreSQL names every identifier of, worker pools included, under. */
function scopePrefix(): string {
	return `c${randomBytes(4).toString("hex")}_`;
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
		const failing = interceptConnectionRequests((request, send) =>
			isExec(request, "ROLLBACK") ? Promise.reject(cause) : send(request),
		);
		try {
			await operation();
		} finally {
			failing.restore();
		}
	},
};

function postgresBackend(): StorageBackend {
	const server = serverUrl("ATOMIC_TEST_POSTGRES_URL");
	const password = process.env.ATOMIC_TEST_POSTGRES_PASSWORD;
	const open = (url: string) => openPostgresDatabase({ url, ...(password === undefined ? {} : { password }) });
	return {
		name: "Postgres",
		skipReason: "skipReason" in server ? server.skipReason : undefined,
		async openScope() {
			if (!("url" in server)) throw new Error("the Postgres backend is skipped here");
			// A database of its own per scope, so the facade suite's fixed table names never collide.
			const admin = await open(server.url);
			const name = `atomic_matrix_${randomBytes(8).toString("hex")}`;
			try {
				await admin.exec(`CREATE DATABASE ${name}`);
			} catch (error) {
				await admin.close();
				throw error;
			}
			const url = new URL(server.url);
			url.pathname = `/${name}`;
			const pool = connections(() => open(url.href));
			return {
				prefix: scopePrefix(),
				connect: pool.connect,
				async close() {
					try {
						await pool.closeAll();
					} finally {
						try {
							await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
						} finally {
							await admin.close();
						}
					}
				},
			};
		},
		async withRollbackFailure(cause, operation) {
			// The adapter's pg is this one, so patching the client prototype reaches the adapter's connections.
			const query = pg.Client.prototype.query;
			const patched = function (this: pg.Client, ...args: Parameters<pg.Client["query"]>) {
				if (args[0] === "ROLLBACK") return Promise.reject(cause);
				return Reflect.apply(query, this, args);
			};
			pg.Client.prototype.query = patched as pg.Client["query"];
			try {
				await operation();
			} finally {
				pg.Client.prototype.query = query;
			}
		},
	};
}

export const storageBackends: readonly StorageBackend[] = [sqliteFileBackend, postgresBackend()];

/** The facade suite's subject on `backend`: one connection, reopened as a fresh one on the same scope. */
export function databaseSubject(backend: StorageBackend): WithSqliteDatabaseSubject {
	return async (body) => {
		const scope = await backend.openScope({ facadeTables: true });
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
