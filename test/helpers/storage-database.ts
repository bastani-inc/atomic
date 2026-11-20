import { join } from "node:path";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
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
