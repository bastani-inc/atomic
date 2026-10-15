import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JournalError, StorageUnavailableError } from "./types.js";

export type SqliteValue = string | number | null;

export function storageBoundary<T>(path: string, operation: () => T): T {
	try {
		return operation();
	} catch (cause) {
		if (cause instanceof JournalError) throw cause;
		throw new StorageUnavailableError(path, cause instanceof Error ? cause : new Error(String(cause)));
	}
}

export class JournalDatabase {
	private readonly database: DatabaseSync;

	constructor(readonly path: string) {
		this.database = storageBoundary(path, () => {
			mkdirSync(dirname(path), { recursive: true });
			const database = new DatabaseSync(path);
			let initialized = false;
			try {
				database.exec(
					"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
				);
				initialized = true;
				return database;
			} finally {
				if (!initialized) database.close();
			}
		});
	}

	exec(sql: string): void {
		storageBoundary(this.path, () => this.database.exec(sql));
	}

	get<Row>(sql: string, ...values: SqliteValue[]): Row | undefined {
		return storageBoundary(this.path, () => this.database.prepare(sql).get(...values) as unknown as Row | undefined);
	}

	all<Row>(sql: string, ...values: SqliteValue[]): Row[] {
		return storageBoundary(this.path, () => this.database.prepare(sql).all(...values) as unknown as Row[]);
	}

	run(sql: string, ...values: SqliteValue[]): number {
		return storageBoundary(this.path, () => Number(this.database.prepare(sql).run(...values).changes));
	}

	transaction<T>(operation: () => T): T {
		return storageBoundary(this.path, () => {
			this.exec("BEGIN IMMEDIATE");
			try {
				const result = operation();
				this.exec("COMMIT");
				return result;
			} catch (error) {
				this.exec("ROLLBACK");
				throw error;
			}
		});
	}
	close(): void {
		storageBoundary(this.path, () => this.database.close());
	}
}
