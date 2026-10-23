import type { AdapterOptions, SqliteDatabase } from "@bastani/atomic/storage";

export interface LibsqlDatabaseOptions {
	url: string;
	authToken?: string;
}

export function openLibsqlDatabase(options: LibsqlDatabaseOptions): Promise<SqliteDatabase>;

declare const adapter: {
	atomicStorageAdapter: 1;
	openDatabase(options: AdapterOptions): Promise<SqliteDatabase>;
};
export default adapter;
