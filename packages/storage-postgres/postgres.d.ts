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
	/** Connections kept open at most, in this process. Default 8. */
	maxConnections?: number;
	/** How long one statement may run before the server cancels it, in milliseconds. Default 30000. */
	statementTimeoutMs?: number;
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
