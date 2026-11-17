import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { WithSqliteDatabaseSubject } from "../../packages/coding-agent/src/core/storage/testing.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";
import { interceptConnectionRequests, isExec } from "./sqlite-connection-requests.js";

export const withNodeSqliteDatabase: WithSqliteDatabaseSubject = async (body) => {
	const directory = makeTempDirectory("atomic-storage-");
	const path = join(directory, "nested", "database.sqlite");
	let database = await openNodeSqliteDatabase(path);
	try {
		await body({
			get database() {
				return database;
			},
			async reopen() {
				await database.close();
				database = await openNodeSqliteDatabase(path);
				return database;
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
		});
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
};

/**
 * `withNodeSqliteDatabase` over a connection this thread owns and wraps, so a test can change what SQLite itself does
 * through `DatabaseSync.prototype`: register functions that an older SQLite lacks or measures differently, or count
 * statements as SQLite prepares them. A connection `openNodeSqliteDatabase` opens runs on a thread of its own, out of
 * their reach.
 */
export const withCallerThreadSqliteDatabase: WithSqliteDatabaseSubject = async (body) => {
	const directory = makeTempDirectory("atomic-storage-");
	const path = join(directory, "database.sqlite");
	let connection = new DatabaseSync(path);
	let database = wrapNodeSqliteDatabase(connection);
	try {
		await body({
			get database() {
				return database;
			},
			async reopen() {
				await database.close();
				connection.close();
				connection = new DatabaseSync(path);
				database = wrapNodeSqliteDatabase(connection);
				return database;
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
		});
	} finally {
		await database.close();
		connection.close();
		removeTempDirectory(directory);
	}
};
