import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.ts";

/** What a server of the libSQL family refuses, as sqld does by default: its row size and response size limits. */
export interface ServerLimits {
	/** The most bytes one bound value, or one value of a returned row, may hold. sqld: 5 MB (`SQLD_MAX_ROW_SIZE`). */
	readonly maxValueBytes: number;
	/** The most bytes one statement may return. sqld: 10 MB (`max_response_size`). */
	readonly maxResponseBytes: number;
}

export const SQLD_DEFAULT_LIMITS: ServerLimits = { maxValueBytes: 5_000_000, maxResponseBytes: 10_000_000 };

/** A statement the server turned down for its size, as its driver reports it. */
export class ServerLimitError extends Error {
	override readonly name = "ServerLimitError";
}

function valueBytes(value: SqliteValue | undefined): number {
	if (value instanceof Uint8Array) return value.byteLength;
	return typeof value === "string" ? Buffer.byteLength(value) : 0;
}

/**
 * A database that refuses what a libSQL server refuses for size: a bound value over `maxValueBytes`, and a statement
 * whose rows hold more than `maxResponseBytes`. Statements that pass run on `database` unchanged, inside transactions
 * too, so a test sees the failure a remote server would give without running one.
 */
export function rowLimitedDatabase(database: SqliteDatabase, limits: ServerLimits = SQLD_DEFAULT_LIMITS) {
	const refused: string[] = [];
	const check = (sql: string, params: readonly SqliteValue[]): void => {
		const largest = Math.max(0, ...params.map(valueBytes));
		if (largest <= limits.maxValueBytes) return;
		refused.push(sql);
		throw new ServerLimitError(
			`a bound value of ${largest} bytes is over the ${limits.maxValueBytes} byte row limit`,
		);
	};
	const checkResponse = <T extends SqliteRow | SqliteRow[] | undefined>(sql: string, rows: T): T => {
		const list: SqliteRow[] = Array.isArray(rows) ? rows : rows === undefined ? [] : [rows];
		let bytes = 0;
		for (const row of list) for (const value of Object.values(row)) bytes += valueBytes(value);
		if (bytes <= limits.maxResponseBytes) return rows;
		refused.push(sql);
		throw new ServerLimitError(`a response of ${bytes} bytes is over the ${limits.maxResponseBytes} byte limit`);
	};
	const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql) => executor.exec(sql),
		run: async (sql: string, ...params: readonly SqliteValue[]) => {
			check(sql, params);
			return executor.run(sql, ...params);
		},
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			check(sql, params);
			return checkResponse(sql, await executor.get<T>(sql, ...params));
		},
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			check(sql, params);
			return checkResponse(sql, await executor.all<T>(sql, ...params));
		},
	});
	const wrapped: SqliteDatabase = {
		...wrap(database),
		descriptor: database.descriptor,
		transaction: (callback, options) => database.transaction((transaction) => callback(wrap(transaction)), options),
		close: () => database.close(),
	};
	return { wrapped, refused };
}
