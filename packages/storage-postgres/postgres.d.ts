import type { AdapterOptions, SqliteDatabase, StorageOpenContext } from "@bastani/atomic/storage";
import type { PostgresSocketFactory } from "./proxy.js";

export type { PostgresSocketFactory, ProxyTarget } from "./proxy.js";

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
	/**
	 * Connections kept open at most, in this process. Default 8. Every database this process opens with the same URL,
	 * role, password, schema and pool options shares one pool, one readers' pool of up to `readerMaxConnections` connections, and one
	 * listening connection, which the last of them to close closes (#6560).
	 */
	maxConnections?: number;
	/** How long one statement may run before the server cancels it, in milliseconds. Default 30000. */
	statementTimeoutMs?: number;
	/**
	 * How long a pool's last connection may stay idle before it is closed, in milliseconds: the time since the pool's
	 * last call. Default 300000. The pool's other connections close after `SURGE_IDLE_TIMEOUT_MS` idle, or after
	 * `idleTimeoutMs` when it is shorter (#6560).
	 */
	idleTimeoutMs?: number;
	/**
	 * Connections each reader handle's pool keeps open at most. Default 2, never more than
	 * `maxConnections`. 0 opens no separate pool, so reads share the main pool.
	 */
	readerMaxConnections?: number;
	/** How long opening a connection, or waiting for a free pooled one, may take, in milliseconds. Default 10000. */
	connectTimeoutMs?: number;
	/** How long a pooled connection stays idle before TCP keepalive probes start, in milliseconds. Default 60000. */
	keepAliveIdleMs?: number;
	/**
	 * Statements each pooled connection keeps prepared at most, so the server parses and plans each once per connection.
	 * `0` sends every statement unnamed, for a transaction-mode pooler without prepared-statement support. Default 256,
	 * or `0` behind a transaction pooler (`listenUrl` set, port 6432 or 6543, or a pooler the first connection finds)
	 * unless the first connection finds PgBouncer 1.21 or later with `max_prepared_statements` above 0.
	 */
	maxPreparedStatements?: number;
	/**
	 * A direct (session) endpoint for the connection that listens for wake-ups, when `url` goes through a transaction
	 * pooler. Default `url`. Without notifications, Intercom brokers find work by polling alone.
	 */
	listenUrl?: string;
	/**
	 * The schema Atomic's tables live in (#5218). Default `atomic`, created by the first store that sets up its tables
	 * when the role may; a database whose `public` schema holds an earlier release's tables, and has no `atomic` schema,
	 * keeps using `public` until `atomic storage migrate` moves them.
	 */
	schema?: string;
	/**
	 * npm prefixes to find a cloud `auth`'s SDK in when it is not found beside the adapter. The adapter's
	 * `openDatabase` passes `<agentDir>/npm`, where `atomic install npm:<package>` installs user packages.
	 */
	sdkSearchPaths?: readonly string[];
	/**
	 * The HTTP proxy connections tunnel through with `CONNECT` (#5473): an `http://` or `https://` URL, with credentials
	 * sent as `Proxy-Authorization` when it has them, or `"none"` for direct connections. It overrides the environment
	 * and applies to this machine too: without it, a connection to a host other than this machine tunnels through
	 * `HTTPS_PROXY` (or `ALL_PROXY`, then `HTTP_PROXY`) unless `NO_PROXY` exempts the host. A socket directory is always
	 * reached directly. TLS still runs end to end with the server. A proxy can read the traffic with `sslmode` `prefer`,
	 * `allow` or `disable`, and with `verify-ca` when it holds a certificate from the CA the connection trusts, for any
	 * host: `verify-full` (the default) checks the certificate's host name.
	 */
	proxy?: string;
	/**
	 * Opens each connection to the server for a custom transport, in place of a socket or a proxy tunnel; passing it
	 * with `proxy` is refused (`conflicting-transport`). A socket directory is always reached directly.
	 */
	socket?: PostgresSocketFactory;
}

export const DEFAULT_MAX_CONNECTIONS: 8;
export const DEFAULT_STATEMENT_TIMEOUT_MS: 30000;
export const DEFAULT_IDLE_TIMEOUT_MS: 300000;
export const DEFAULT_READER_MAX_CONNECTIONS: 2;
export const DEFAULT_CONNECT_TIMEOUT_MS: 10000;
export const DEFAULT_KEEPALIVE_IDLE_MS: 60000;
export const DEFAULT_MAX_PREPARED_STATEMENTS: 256;
export const SURGE_IDLE_TIMEOUT_MS: 10000;
export const DEFAULT_SCHEMA: "atomic";

/** `sql` with each positional `?` parameter outside literals, quoted identifiers and comments numbered `$1`, `$2`, .... */
export function numberPlaceholders(sql: string): string;
/** `sql` with every unquoted identifier longer than 63 bytes replaced by `postgresDialect.identifier` of it. */
export function physicalIdentifiers(sql: string): string;

export function openPostgresDatabase(options: PostgresDatabaseOptions): Promise<SqliteDatabase>;

declare const adapter: {
	atomicStorageAdapter: 1;
	liveSecrets: readonly string[];
	openDatabase(options: AdapterOptions, context: StorageOpenContext): Promise<SqliteDatabase>;
};
export default adapter;
