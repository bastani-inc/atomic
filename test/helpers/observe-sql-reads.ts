import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";

import { StoragePayloadTooLargeError } from "../../packages/coding-agent/src/core/storage/errors.js";
import type { StorageBackendScope } from "./storage-backends.js";

/** An adapter with an independent reader, including on engines where only the test introduces a response ceiling. */
export async function connectCatalogScope(scope: StorageBackendScope): Promise<SqliteDatabase> {
	const database = await scope.connect();
	database.openReader ??= scope.connect;
	return database;
}

/** A configurable response ceiling for exercising the same paging boundaries on all three engines. */
export function limitHeaderResponse(
	database: SqliteDatabase,
	fits: (rows: readonly SqliteRow[]) => boolean,
): () => void {
	return observeSqlReads(database, {
		after(rows) {
			if (rows.some((row) => typeof row.header_json === "string") && !fits(rows))
				throw new StoragePayloadTooLargeError(0, 0, { kind: "response" });
		},
	});
}

/** Observes public SQL reads whether a store uses a transaction or a standalone statement. */
export function observeSqlReads(
	database: SqliteDatabase,
	observer: {
		readonly before?: (sql: string, params: readonly SqliteValue[]) => void | Promise<void>;
		readonly after?: (rows: readonly SqliteRow[], sql: string, transaction: boolean) => void | Promise<void>;
	},
): () => void {
	const all = database.all.bind(database);
	const get = database.get.bind(database);
	const transaction = database.transaction.bind(database);
	const openReader = database.openReader;
	if (openReader) {
		database.openReader = async () => {
			const reader = await openReader.call(database);
			observeSqlReads(reader, observer);
			return reader;
		};
	}
	const executor = (source: SqliteExecutor, pinned: boolean): SqliteExecutor => ({
		exec: source.exec.bind(source),
		run: source.run.bind(source),
		all: async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			await observer.before?.(sql, params);
			const rows = await source.all<Row>(sql, ...params);
			await observer.after?.(rows, sql, pinned);
			return rows;
		},
		get: async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			await observer.before?.(sql, params);
			const row = await source.get<Row>(sql, ...params);
			await observer.after?.(row === undefined ? [] : [row], sql, pinned);
			return row;
		},
	});
	const direct = executor({ all, get, exec: database.exec.bind(database), run: database.run.bind(database) }, false);
	database.all = direct.all;
	database.get = direct.get;
	database.transaction = (body, options) => transaction((tx) => body(executor(tx, true)), options);
	return () => {
		database.all = all;
		database.get = get;
		database.transaction = transaction;
		if (openReader) database.openReader = openReader;
	};
}
