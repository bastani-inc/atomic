import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";

/** Observes public SQL reads whether a store uses a transaction or a standalone statement. */
export function observeSqlReads(
	database: SqliteDatabase,
	observer: {
		readonly before?: () => void;
		readonly after?: (rows: readonly SqliteRow[]) => void | Promise<void>;
	},
): () => void {
	const all = database.all.bind(database);
	const get = database.get.bind(database);
	const transaction = database.transaction.bind(database);
	const executor = (source: SqliteExecutor): SqliteExecutor => ({
		exec: source.exec.bind(source),
		run: source.run.bind(source),
		all: async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			observer.before?.();
			const rows = await source.all<Row>(sql, ...params);
			await observer.after?.(rows);
			return rows;
		},
		get: async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			observer.before?.();
			const row = await source.get<Row>(sql, ...params);
			await observer.after?.(row === undefined ? [] : [row]);
			return row;
		},
	});
	const direct = executor({ all, get, exec: database.exec.bind(database), run: database.run.bind(database) });
	database.all = direct.all;
	database.get = direct.get;
	database.transaction = (body, options) => transaction((tx) => body(executor(tx)), options);
	return () => {
		database.all = all;
		database.get = get;
		database.transaction = transaction;
	};
}
