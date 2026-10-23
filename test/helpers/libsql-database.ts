import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Transaction } from "@libsql/client";
import { type InArgs, type InStatement, Sqlite3Transaction } from "@libsql/client/sqlite3";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/index.js";
import type { WithSqliteDatabaseSubject } from "../../packages/coding-agent/src/core/storage/testing.js";
import { openLibsqlDatabase } from "../fixtures/storage-libsql-wrapper.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "./libsql-cleanup.js";

/** Conformance subject over a temp-dir `file:` libSQL database opened by `open`. */
export const libsqlDatabaseSubject =
	(open: (url: string) => Promise<SqliteDatabase>): WithSqliteDatabaseSubject =>
	async (body) => {
		const directory = makeLibsqlDirectory();
		const url = pathToFileURL(join(directory, "database.sqlite")).href;
		let database = await open(url);
		// Exercise asynchronous driver binding, rather than relying on the local driver's synchronous fast path.
		const execute = Sqlite3Transaction.prototype.execute;
		Sqlite3Transaction.prototype.execute = async function (statement: InStatement | string, args?: InArgs) {
			await Promise.resolve();
			return execute.call(
				this,
				typeof statement === "string" ? statement : statement.sql,
				typeof statement === "string" ? args : statement.args,
			);
		};
		try {
			await body({
				get database() {
					return database;
				},
				async reopen() {
					await database.close();
					database = await open(url);
					return database;
				},
				async withRollbackFailure(cause, operation) {
					const client = createClient({ url });
					try {
						const probe = await client.transaction("write");
						const prototype = Object.getPrototypeOf(probe) as Pick<Transaction, "rollback">;
						try {
							await probe.rollback();
						} finally {
							await probe.close();
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
						await client.close();
					}
				},
			});
		} finally {
			Sqlite3Transaction.prototype.execute = execute;
			await database.close();
			await removeLibsqlDirectory(directory);
		}
	};

export const withLibsqlDatabase = libsqlDatabaseSubject((url) => openLibsqlDatabase({ url }));
