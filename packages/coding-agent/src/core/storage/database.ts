export type SqliteValue = null | number | bigint | string | Uint8Array;
export type SqliteRow = Readonly<Record<string, SqliteValue>>;

export interface SqliteRunResult {
	readonly changes: number;
}

export interface SqliteExecutor {
	exec(sql: string): Promise<void>;
	run(sql: string, ...params: readonly SqliteValue[]): Promise<SqliteRunResult>;
	get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined>;
	all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]>;
}

export interface StorageDescriptor {
	readonly adapter: string;
	readonly location: string;
}

/** One statement of a batch: SQL with positional `?` parameters. */
export interface SqliteStatement {
	readonly sql: string;
	readonly params: readonly SqliteValue[];
}

export interface SqliteDatabase extends SqliteExecutor {
	readonly descriptor: StorageDescriptor;
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
	/**
	 * Runs the statements in order, in one write transaction, as one call to the database: all of them commit or none
	 * do. Resolves with each statement's rows. Present only when the driver can send a batch in one request, which
	 * saves a round trip per statement against a remote database.
	 */
	batch?(statements: readonly SqliteStatement[]): Promise<SqliteRow[][]>;
	close(): Promise<void>;
}
