import { type SqliteDatabase, StorageAdapterLoadError } from "../../packages/coding-agent/src/core/storage/index.js";
import { type LibsqlDatabaseOptions, openLibsqlDatabase } from "./storage-libsql-wrapper.js";

export async function useLibsql(options: LibsqlDatabaseOptions): Promise<SqliteDatabase> {
	try {
		const database = await openLibsqlDatabase(options);
		await database.transaction(async (transaction) => {
			await transaction.run("SELECT ?", 9007199254740992n);
		});
		return database;
	} catch (error) {
		if (error instanceof StorageAdapterLoadError) console.error(error.module);
		throw error;
	}
}
