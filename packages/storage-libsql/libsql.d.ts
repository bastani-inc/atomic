import type { AdapterOptions, SqliteDatabase } from "@bastani/atomic/storage";

export interface LibsqlDatabaseOptions {
	url: string;
	authToken?: string;
	/** A self-hosted sqld namespace, sent as `x-namespace`. Needs a `libsql:`, `https:` or `http:` URL. */
	namespace?: string;
	/** Extra request headers, redacted from diagnostics. Needs a `libsql:`, `https:` or `http:` URL. */
	headers?: Readonly<Record<string, string>>;
	/**
	 * How long an idle connection to a libSQL server stays open for the next request, in milliseconds. Unset keeps the
	 * runtime's own timeout on Node.js (about 4 seconds), and 4 seconds on Bun 1.4.3 or later. Applies to `libsql:`,
	 * `https:` and `http:` URLs; ignored for WebSocket and `file:` URLs and on older Bun. Keep it below the server's own
	 * idle timeout: Turso closes idle connections after 5 seconds, so leave it unset for Turso.
	 */
	keepAliveMs?: number;
	/**
	 * On a libSQL server, how many reads one connection runs at once: read-only transactions and single `SELECT`s
	 * outside a transaction. A positive integer, default 20. Writes still run one at a time. No effect on `file:` URLs.
	 */
	concurrency?: number;
}

/** How many reads one connection to a libSQL server runs at once by default. */
export const DEFAULT_CONCURRENCY: 20;

export function openLibsqlDatabase(options: LibsqlDatabaseOptions): Promise<SqliteDatabase>;

declare const adapter: {
	atomicStorageAdapter: 1;
	openDatabase(options: AdapterOptions): Promise<SqliteDatabase>;
};
export default adapter;
