import type { SqliteDatabase } from "@bastani/atomic/storage";

export interface LibsqlDatabaseOptions {
	url: string;
	authToken?: string;
}

export function openLibsqlDatabase(options: LibsqlDatabaseOptions): Promise<SqliteDatabase>;

declare const adapter: {
	atomicStorageAdapter: 1;
	openDatabase(options: Record<string, unknown>): Promise<SqliteDatabase>;
};
export default adapter;
