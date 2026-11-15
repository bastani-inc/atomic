import type { AdapterOptions, SqliteDatabase, StorageOpenContext } from "@bastani/atomic/storage";

export interface PostgresDatabaseOptions {
	/** A `postgres://` or `postgresql://` URL without a password. */
	url: string;
	/** The password, or a function that returns it, called for each new connection the server asks one of. */
	password?: string | (() => Promise<string>);
	/**
	 * How the password is obtained. Default `"password"`. `"azure-entra"`, `"aws-iam"` and `"gcp-iam"` take a token from
	 * the platform's own credentials for each new connection, and refuse a `password` beside them.
	 */
	auth?: "password" | "azure-entra" | "aws-iam" | "gcp-iam";
	/** Connections kept open at most, in this process. Default 8. */
	maxConnections?: number;
	/** How long one statement may run before the server cancels it, in milliseconds. Default 30000. */
	statementTimeoutMs?: number;
	/**
	 * A direct (session) endpoint for the connection that listens for wake-ups, when `url` goes through a transaction
	 * pooler. Default `url`. Without notifications, worker hosts and Intercom brokers find work by polling alone.
	 */
	listenUrl?: string;
}

export const DEFAULT_MAX_CONNECTIONS: 8;
export const DEFAULT_STATEMENT_TIMEOUT_MS: 30000;

/** `sql` with each positional `?` parameter outside literals, quoted identifiers and comments numbered `$1`, `$2`, .... */
export function numberPlaceholders(sql: string): string;

export function openPostgresDatabase(options: PostgresDatabaseOptions): Promise<SqliteDatabase>;

declare const adapter: {
	atomicStorageAdapter: 1;
	liveSecrets: readonly string[];
	openDatabase(options: AdapterOptions, context: StorageOpenContext): Promise<SqliteDatabase>;
};
export default adapter;
