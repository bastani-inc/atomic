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

export interface SqliteDatabase extends SqliteExecutor {
	readonly descriptor: StorageDescriptor;
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}
