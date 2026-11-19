import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteTransactionOptions, SqliteValue } from "../database.js";
import { dialectOf } from "../dialect.js";
import { assertStoredSchemaVersion } from "../schema.js";

/** A handle stays open while another client can upgrade its store. Every session reader, including the search and
 * snapshot stores it exposes, must stop before publishing data in a format it cannot read. */
export function guardSessionDatabase(
	database: SqliteDatabase,
	meta: string,
	oldest: number,
	newest: number,
): SqliteDatabase {
	const dialect = dialectOf(database);
	const check = (executor: SqliteExecutor, lock = "") =>
		assertStoredSchemaVersion(
			executor,
			{ sql: `SELECT schema_version FROM ${meta}${lock}` },
			"sessions",
			newest,
			"schema_version",
			oldest,
		);
	const transaction = <T>(body: (tx: SqliteExecutor) => Promise<T>, options?: SqliteTransactionOptions) =>
		database.transaction(async (tx) => {
			await check(tx, dialect.lockClause("share"));
			return body(tx);
		}, options);
	// Reads outside a transaction don't take the SQLite write lock. A bump between the first check and the query
	// either changes its answer or makes the statement invalid; don't return that answer or misreport that error.
	const read = async <T>(query: () => Promise<T>): Promise<T> => {
		await check(database);
		let result: T;
		try {
			result = await query();
		} catch (error) {
			await check(database);
			throw error;
		}
		await check(database);
		return result;
	};
	const batch = database.batch?.bind(database);
	return {
		descriptor: database.descriptor,
		dialect,
		readOnly: database.readOnly,
		notifications: database.notifications,
		transaction,
		get: <T extends SqliteRow>(sql: string, ...params: SqliteValue[]) => read(() => database.get<T>(sql, ...params)),
		all: <T extends SqliteRow>(sql: string, ...params: SqliteValue[]) => read(() => database.all<T>(sql, ...params)),
		exec: (sql) => transaction((tx) => tx.exec(sql)),
		run: (sql, ...params) => transaction((tx) => tx.run(sql, ...params)),
		...(batch && {
			batch: async (statements, options) => {
				// The NOT NULL constraint aborts the whole batch on an unsupported version. Compatible batches insert
				// nothing. Keep this check in the batch itself, not in an earlier round trip.
				const fence = {
					sql: `INSERT INTO ${meta} (schema_version) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM ${meta} WHERE schema_version BETWEEN ? AND ?${dialect.lockClause("share")})`,
					params: [oldest, newest],
				};
				try {
					return (await batch([fence, ...statements], options)).slice(1);
				} catch (error) {
					await check(database);
					throw error;
				}
			},
		}),
		close: () => database.close(),
	};
}
