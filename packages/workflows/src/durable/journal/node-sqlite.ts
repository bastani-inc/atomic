import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JOURNAL_COLUMNS as c, JournalCounterRangeError, JournalError, StorageUnavailableError } from "./types.js";

export type SqliteValue = string | number | null;
export type SqliteStoredValue = string | number | bigint | Uint8Array | null;

export function journalCounter(
	runId: string,
	field: "seq" | "epoch",
	value: number | bigint,
	reason: "overflow" | "unsafe-integer" = "unsafe-integer",
): number {
	const counter = Number(value);
	if (counter < 0) throw new JournalCounterRangeError(runId, field, counter, "negative");
	if (!Number.isSafeInteger(counter)) throw new JournalCounterRangeError(runId, field, counter, reason);
	return counter;
}

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
	private readonly ownsDatabase: boolean;
	readonly path: string;

	constructor(source: string | DatabaseSync) {
		this.ownsDatabase = typeof source === "string";
		this.path =
			typeof source === "string" ? source : storageBoundary(":memory:", () => source.location() || ":memory:");
		this.database = storageBoundary(this.path, () => {
			if (typeof source === "string") mkdirSync(dirname(source), { recursive: true });
			const database = typeof source === "string" ? new DatabaseSync(source) : source;
			let initialized = false;
			try {
				database.exec(
					"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
				);
				initialized = true;
				return database;
			} finally {
				if (!initialized && this.ownsDatabase) database.close();
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

	getWide<Row>(sql: string, ...values: SqliteValue[]): Row | undefined {
		return storageBoundary(this.path, () => {
			const statement = this.database.prepare(sql);
			statement.setReadBigInts(true);
			return statement.get(...values) as unknown as Row | undefined;
		});
	}

	getCounters<Row>(runId: string, sql: string, ...values: SqliteValue[]): Row | undefined {
		return this.allCounters<Row>(runId, sql, ...values)[0];
	}

	allCounters<Row>(runId: string, sql: string, ...values: SqliteValue[]): Row[] {
		return storageBoundary(this.path, () => {
			const statement = this.database.prepare(sql);
			statement.setReadBigInts(true);
			const rows = statement.all(...values) as unknown as Record<string, string | number | bigint | null>[];
			return rows.map((row) =>
				Object.fromEntries(
					Object.entries(row).map(([field, value]) => [
						field,
						field === c.seq || field === c.epoch
							? journalCounter(runId, field, value as number | bigint)
							: typeof value === "bigint"
								? Number(value)
								: value,
					]),
				),
			) as unknown as Row[];
		});
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
		if (!this.ownsDatabase) return;
		storageBoundary(this.path, () => {
			this.database.close();
			// Bun retains the closed file until unreachable prepared statements are collected.
			(globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
		});
	}
}
