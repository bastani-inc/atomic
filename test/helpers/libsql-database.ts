import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Transaction } from "@libsql/client";
import type { WithSqliteDatabaseSubject } from "../../packages/coding-agent/src/core/storage/testing.js";
import { openLibsqlDatabase } from "../fixtures/storage-libsql-wrapper.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

export const withLibsqlDatabase: WithSqliteDatabaseSubject = async (body) => {
	const directory = makeTempDirectory("atomic-libsql-");
	const url = pathToFileURL(join(directory, "database.sqlite")).href;
	let database = await openLibsqlDatabase({ url });
	try {
		await body({
			get database() {
				return database;
			},
			async reopen() {
				await database.close();
				database = await openLibsqlDatabase({ url });
				return database;
			},
			async withRollbackFailure(cause, operation) {
				const client = createClient({ url });
				const probe = await client.transaction("write");
				const prototype = Object.getPrototypeOf(probe) as Pick<Transaction, "rollback">;
				await probe.rollback();
				const rollback = prototype.rollback;
				prototype.rollback = async () => {
					throw cause;
				};
				try {
					await operation();
				} finally {
					prototype.rollback = rollback;
					client.close();
				}
			},
		});
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
};
