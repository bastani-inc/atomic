import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";

/**
 * A database over the SQLite file at `path` that runs every call on a connection of its own, as a libSQL server runs
 * each HTTP request on a new stream (#4805, #4814): a per-connection pragma read through it never sees a write move.
 */
export function connectionPerCallDatabase(path: string): SqliteDatabase {
	const onConnection = async <T>(body: (connection: DatabaseSync) => T): Promise<T> => {
		const connection = new DatabaseSync(path);
		try {
			connection.exec("PRAGMA busy_timeout = 5000");
			return body(connection);
		} finally {
			connection.close();
		}
	};
	const executor = (connection: DatabaseSync) => ({
		exec: async (sql: string) => connection.exec(sql),
		run: async (sql: string, ...params: readonly SqliteValue[]) => ({
			changes: Number(connection.prepare(sql).run(...params).changes),
		}),
		get: async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			connection.prepare(sql).get(...params) as Row | undefined,
		all: async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			connection.prepare(sql).all(...params) as Row[],
	});
	return {
		descriptor: { adapter: "connection-per-call", location: path },
		exec: (sql) => onConnection((connection) => connection.exec(sql)),
		run: (sql, ...params) =>
			onConnection((connection) => ({ changes: Number(connection.prepare(sql).run(...params).changes) })),
		get: <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			onConnection((connection) => connection.prepare(sql).get(...params) as Row | undefined),
		all: <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			onConnection((connection) => connection.prepare(sql).all(...params) as Row[]),
		transaction: async (body) => {
			const connection = new DatabaseSync(path);
			try {
				connection.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
				try {
					const result = await body(executor(connection));
					connection.exec("COMMIT");
					return result;
				} catch (error) {
					connection.exec("ROLLBACK");
					throw error;
				}
			} finally {
				connection.close();
			}
		},
		close: async () => {},
	};
}
