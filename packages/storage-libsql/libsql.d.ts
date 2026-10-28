import type { AdapterOptions, SqliteDatabase } from "@bastani/atomic/storage";

export interface LibsqlDatabaseOptions {
	url: string;
	authToken?: string;
	/** A self-hosted sqld namespace, sent as `x-namespace`. Needs a `libsql:`, `https:` or `http:` URL. */
	namespace?: string;
	/** Extra request headers, redacted from diagnostics. Needs a `libsql:`, `https:` or `http:` URL. */
	headers?: Readonly<Record<string, string>>;
}

export function openLibsqlDatabase(options: LibsqlDatabaseOptions): Promise<SqliteDatabase>;

declare const adapter: {
	atomicStorageAdapter: 1;
	openDatabase(options: AdapterOptions): Promise<SqliteDatabase>;
};
export default adapter;
