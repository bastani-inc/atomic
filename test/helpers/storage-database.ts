import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { WithSqliteDatabaseSubject } from "../../packages/coding-agent/src/core/storage/testing.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

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
		removeTempDirectory(directory);
	}
};
