import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.ts";

/** One statement a database ran, and how many rows it returned to JavaScript. */
export interface CountedStatement {
	readonly sql: string;
	readonly params: readonly SqliteValue[];
	readonly rows: number;
}

/** A database that records every statement it runs, inside transactions too, and how many transactions it opened. */
export function countingDatabase(database: SqliteDatabase) {
	const statements: CountedStatement[] = [];
	const counts = { transactions: 0 };
	const record = <T>(sql: string, params: readonly SqliteValue[], result: T): T => {
		statements.push({ sql, params, rows: Array.isArray(result) ? result.length : result === undefined ? 0 : 1 });
		return result;
	};
	const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: async (sql) => record(sql, [], await executor.exec(sql)),
		run: async (sql: string, ...params: readonly SqliteValue[]) => {
			const result = await executor.run(sql, ...params);
			statements.push({ sql, params, rows: 0 });
			return result;
		},
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			record(sql, params, await executor.get<T>(sql, ...params)),
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			record(sql, params, await executor.all<T>(sql, ...params)),
	});
	const wrapped: SqliteDatabase = {
		...wrap(database),
		descriptor: database.descriptor,
		transaction: (callback, options) => {
			counts.transactions++;
			return database.transaction((transaction) => callback(wrap(transaction)), options);
		},
		close: () => database.close(),
	};
	return { wrapped, statements, counts };
}
