import { DatabaseSync } from "node:sqlite";
import type { SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";

/** Raw connection for schema, corruption and transaction assertions only. */
export class JournalTestDatabase {
	private readonly connection: DatabaseSync;
	constructor(path: string) {
		this.connection = new DatabaseSync(path);
		this.connection.exec(
			"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
		);
	}
	exec(sql: string): void {
		this.connection.exec(sql);
	}
	run(sql: string, ...params: SqliteValue[]): void {
		this.connection.prepare(sql).run(...params);
	}
	get<Row extends SqliteRow>(sql: string, ...params: SqliteValue[]): Row | undefined {
		return this.connection.prepare(sql).get(...params) as Row | undefined;
	}
	all<Row extends SqliteRow>(sql: string, ...params: SqliteValue[]): Row[] {
		return this.connection.prepare(sql).all(...params) as Row[];
	}
	close(): void {
		this.connection.close();
		(globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
	}
}
