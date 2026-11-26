// @ts-check
import { createHash, randomBytes } from "node:crypto";
import { connect as connectSocket, isIP } from "node:net";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import {
	createSqliteDatabase,
	postgresDialect,
	StorageAdapterLoadError,
	StorageConfigError,
	StorageError,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { createCloudPasswordProvider } from "./auth.js";
import { createPostgresListener } from "./listen.js";
import {
	isLocalTarget,
	isRefusedCertificate,
	OpenedSocket,
	ProxySettingError,
	ProxyTunnelError,
	postgresTransport,
	socketOpener,
} from "./proxy.js";

/**
 * @typedef {import("@bastani/atomic/storage").SqliteDriverResult} SqliteDriverResult
 * @typedef {import("@bastani/atomic/storage").SqliteDriverTransientFailure} SqliteDriverTransientFailure
 * @typedef {import("@bastani/atomic/storage").StorageFailureCause} StorageFailureCause
 * @typedef {import("@bastani/atomic/storage").SqliteValue} SqliteValue
 * @typedef {import("pg").PoolClient} PoolClient
 * @typedef {"password" | "azure-entra" | "aws-iam" | "gcp-iam"} PostgresAuth
 * @typedef {{
 *   url: string,
 *   password?: string | (() => Promise<string>),
 *   auth?: PostgresAuth,
 *   maxConnections?: number,
 *   statementTimeoutMs?: number,
 *   idleTimeoutMs?: number,
 *   readerMaxConnections?: number,
 *   connectTimeoutMs?: number,
 *   keepAliveIdleMs?: number,
 *   maxPreparedStatements?: number,
 *   listenUrl?: string,
 *   schema?: string,
 *   sdkSearchPaths?: readonly string[],
 *   proxy?: string,
 *   socket?: import("./proxy.js").PostgresSocketFactory,
 * }} PostgresDatabaseOptions
 */

/** Connections one database keeps open at most, per process. */
export const DEFAULT_MAX_CONNECTIONS = 8;
/** How long one statement may run on the server before it is cancelled, in milliseconds. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
/** How long opening a connection, or waiting for a free one, may take, in milliseconds. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** How long the listening connection stays idle before TCP keepalive probes start. */
const LISTEN_KEEPALIVE_IDLE_MS = 10_000;
/**
 * How long a pool's first connection may stay idle before it is closed, in milliseconds: the time the whole pool was
 * idle. The others close after `SURGE_IDLE_TIMEOUT_MS` (#6560).
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/**
 * How long a connection beyond a pool's first may stay idle before it is closed, in milliseconds, and the idle timeout of
 * every connection when `idleTimeoutMs` is shorter: node-postgres's own default. A burst's extra connections are given
 * back within seconds, as HikariCP retires idle connections above its minimum, so a process holds one connection while
 * it works one call at a time (#6560).
 */
export const SURGE_IDLE_TIMEOUT_MS = 10_000;
/** How long a pooled connection stays idle before TCP keepalive probes start, in milliseconds. */
export const DEFAULT_KEEPALIVE_IDLE_MS = 60_000;
/** Statements one connection keeps prepared at most; past it, further statements go unnamed. */
export const DEFAULT_MAX_PREPARED_STATEMENTS = 256;
/** A statement gets a name once a process has sent it this many times, so one-off statements are never prepared. */
const PREPARE_AFTER_USES = 2;
/** Statements whose uses or names a database remembers at most. */
const STATEMENTS_TRACKED = 4096;
/** Data statements, the only ones worth preparing: no setup, schema change or transaction control. */
const PREPARABLE = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;
/** The ports transaction poolers listen on by convention: PgBouncer's and Supavisor's. */
const POOLER_PORTS = new Set([6432, 6543]);
/** The first PgBouncer release that keeps each client's prepared statements across its server connections. */
const PGBOUNCER_PREPARED_VERSION = [1, 21];
/**
 * Whether the server that runs this statement holds it under a name PgBouncer gave it: PgBouncer 1.21 and later,
 * with `max_prepared_statements` above 0, prepare a client's named statement on each server connection as
 * `PGBOUNCER_<n>`. The server holds it under the client's own name when nothing renames it: a direct connection, or
 * a pooler that passes statements on as they are. With the server process that runs it, which a pooler that hands
 * out cancel keys of its own does not name in the connection's key.
 */
const PGBOUNCER_PROBE_SQL =
	"SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_prepared_statements WHERE statement = current_query() AND name LIKE 'PGBOUNCER\\_%') AS kept, pg_backend_pid() AS pid";

/**
 * What the `pgbouncer.*` parameters a server reports at login say of prepared statements: PgBouncer 1.26 and later
 * report its version and `max_prepared_statements` there. True for PgBouncer 1.21 or later with
 * `max_prepared_statements` above 0, false for another PgBouncer, undefined when the parameters name none.
 * @param {ReadonlyMap<string, string>} parameters
 * @returns {boolean | undefined}
 */
function pgbouncerKeepsPrepared(parameters) {
	const version = parameters.get("pgbouncer.version");
	if (version === undefined) return undefined;
	const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
	const [needMajor, needMinor] = PGBOUNCER_PREPARED_VERSION;
	const recent = major > needMajor || (major === needMajor && minor >= needMinor);
	return recent && Number(parameters.get("pgbouncer.max_prepared_statements")) > 0;
}
/** Connections the pool for reads keeps open at most, per process; never more than `maxConnections`. */
export const DEFAULT_READER_MAX_CONNECTIONS = 2;
/**
 * How much longer than the statement timeout a statement may take before the client gives up on its connection and
 * asks the server to cancel it: the server cancels a statement itself at the statement timeout, so this bounds only a
 * server or a network that stopped answering, and a statement that cannot run in a transaction block.
 */
const CLIENT_TIMEOUT_GRACE_MS = 5_000;
/** The length and code of a protocol cancel request, which is sent on a connection of its own, without a startup. */
const CANCEL_REQUEST_LENGTH = 16;
const CANCEL_REQUEST_CODE = 80877102;
/** The advisory lock a serial transaction takes when it names no domain: the whole database's. */
const DATABASE_LOCK_SCOPE = "atomic";
/** The oldest server major version the adapter supports. */
const MINIMUM_SERVER_VERSION = 140000;

/**
 * A rejection of the password source that carries a refused certificate's code, made for that one rejection, with the
 * source's error as its cause and its message: the source's own request, to a secret store say, was refused a
 * certificate, which says nothing about the server's, so the connection fails as for any other failure of the source.
 */
class PasswordSourceError extends Error {
	/** @param {unknown} cause */
	constructor(cause) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
	}
}

/**
 * The link of `cause`'s chain that is a certificate TLS verification refused: its code is one of the certificate codes,
 * or `UNSPECIFIED` with a certificate reason. Undefined when there is none, and for an https proxy's own certificate
 * and a password source's failure, which are not the server's (#6112).
 * @param {unknown} cause
 * @returns {{ code: string, message: string } | undefined}
 */
function refusedCertificate(cause) {
	/** @type {unknown} */
	let current = cause;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (current instanceof ProxyTunnelError || current instanceof PasswordSourceError) return undefined;
		const { code, message } = /** @type {{ code?: unknown, message?: unknown }} */ (current);
		if (typeof code === "string" && isRefusedCertificate(code, typeof message === "string" ? message.trim() : ""))
			return { code, message: /** @type {Error} */ (current).message };
		current = /** @type {{ cause?: unknown }} */ (current).cause;
	}
	return undefined;
}

/**
 * The permanent failure a connection refused by TLS verification is (#5218), with the reason and the fix: a host name
 * the certificate names, or the CA in `sslrootcert`. Undefined for any other failure, and for an https proxy's own
 * certificate, which its tunnel failure names with the proxy's fix, or a password source's (#6112).
 * @param {unknown} cause
 * @returns {StorageError | undefined}
 */
function tlsVerificationFailure(cause) {
	const refused = refusedCertificate(cause);
	if (refused === undefined) return undefined;
	const { code, message } = refused;
	const fix =
		code === "ERR_TLS_CERT_ALTNAME_INVALID" || code === "HOSTNAME_MISMATCH"
			? "Connect by a host name the certificate names, or, for an address it does not name such as a private IP address, add sslmode=verify-ca with sslrootcert=<CA file> to the URL"
			: "Add sslrootcert=<CA file> with the server's CA to the URL; see TLS in docs/storage.md";
	return new StorageError(
		`The server's TLS certificate was not accepted (${code}: ${message}). ${fix}. It is not retried`,
		{ cause: /** @type {Error} */ (cause) },
	);
}

/**
 * What a connection attempt that failed with `cause` throws, wherever the adapter opens one (the pool, the reconnect
 * after a refused token, the schema's own connection): a certificate TLS verification refused, or a tunnel a proxy
 * refused, fails at once; anything else is a connection that could not be made for now (#6112).
 * @param {unknown} cause
 * @returns {Error}
 */
function connectFailure(cause) {
	const tls = tlsVerificationFailure(cause);
	if (tls !== undefined) return tls;
	// A proxy that refused the tunnel refuses it again: permanent, never retried as unreachable (#5473).
	const tunnel = proxyTunnelFailure(cause);
	if (tunnel?.permanent === true) return new StorageError(tunnel.message, { cause: /** @type {Error} */ (cause) });
	return new PostgresConnectionFailure("connect", /** @type {StorageFailureCause} */ (cause));
}

/**
 * The tunnel a proxy did not open along `cause`'s chain (#5473), or undefined when the failure is not a proxy's.
 * @param {unknown} cause
 * @returns {ProxyTunnelError | undefined}
 */
function proxyTunnelFailure(cause) {
	/** @type {unknown} */
	let current = cause;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (current instanceof ProxyTunnelError) return current;
		current = /** @type {{ cause?: unknown }} */ (current).cause;
	}
	return undefined;
}

/** The SQLSTATEs of a refused password or token: `28P01`, and `28000`, which Azure sends for a malformed token. */
const REFUSED_TOKEN_SQLSTATES = new Set(["28P01", "28000"]);
/** The schema Atomic's tables, indexes, triggers and functions live in when the options name none (#5218). */
export const DEFAULT_SCHEMA = "atomic";
/**
 * Where releases before #5218 created everything: the first schema of the default `search_path`. A database whose
 * `public` holds Atomic's tables and that has no `atomic` schema yet keeps using it until `atomic storage migrate` moves
 * them.
 */
const LEGACY_SCHEMA = "public";
/** A table every release that used a database created in it: the migration ledger, the run journal, sessions, Intercom. */
const LEGACY_MARKERS = "(atomic_migrations|wf_runs|session_sessions|intercom_leases)$";
/**
 * What the comment of each table `atomic storage migrate` leaves in `public` after moving the tables starts with (the
 * coding agent's `postgres-schema.ts`): such a table fences an earlier release and holds nothing, so it never makes
 * `public` the schema to use, as after the `atomic` schema was dropped to start over (#5218).
 */
const MOVED_FENCE_COMMENT = "atomic-moved-fence:";
/** The ledger a store opened without a prefix records its schema versions in, whose versions the open reads. */
const OPENED_LEDGER = "atomic_migrations";
/**
 * Every relation, trigger, column and function of the schema the statement runs in, as the coding agent's
 * `readStorageSchemaCatalog` reads them: the open reads them with its own query, and the first store open takes them
 * instead of reading them again (#6560).
 */
const OPENED_CATALOG_SQL = `SELECT 'relation' AS kind, c.relname::text AS name, c.relkind::text AS detail
	FROM pg_catalog.pg_class c WHERE c.relnamespace = current_schema()::regnamespace
UNION ALL SELECT 'trigger', t.tgname::text, NULL
	FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
	WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal
UNION ALL SELECT 'column', table_name::text, column_name::text
	FROM information_schema.columns WHERE table_schema = current_schema()
UNION ALL SELECT 'function', p.proname::text, CASE WHEN has_function_privilege(p.oid, 'EXECUTE') THEN 'executable' END
	FROM pg_catalog.pg_proc p WHERE p.pronamespace = current_schema()::regnamespace`;
/** The highest version the ledger records for each domain. */
const OPENED_VERSIONS_SQL = `SELECT domain, MAX(version) AS version FROM ${OPENED_LEDGER} GROUP BY domain`;
/** The kinds of relation the catalog counts as tables: plain, partitioned and foreign tables, and views of each kind. */
const TABLE_KINDS = new Set(["r", "p", "v", "m", "f"]);
/** A schema name the adapter accepts: a lowercase identifier that needs no quotes. */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * @param {string} field
 * @param {string} reason
 * @param {string} [hint]
 */
function configError(field, reason, hint) {
	return new StorageConfigError("sdk", field, reason, hint);
}

/**
 * The failure of a statement the server refused for a missing privilege (SQLSTATE `42501`), as a configuration error
 * that names the privilege and the fix (#5218): never retried, and never the server's bare message.
 * @param {{ message: string }} cause
 * @param {string} role
 * @param {string} schema
 * @param {string} database
 * @param {string} [sql] The statement refused, when known.
 */
function missingPrivilege(cause, role, schema, database, sql = "") {
	const who = role === "" ? "This role" : `Role "${role}"`;
	const denied = cause.message;
	/** @type {string} */
	let fix;
	if (/must be owner of/.test(denied))
		fix = `Changing Atomic's tables needs their owner: the schema is behind this version of Atomic. Run \`atomic storage migrate\` as the owner role (the role that owns schema ${schema}), then start again.`;
	else if (/permission denied for database/.test(denied))
		fix = `Creating schema ${schema} needs CREATE on the database: run \`atomic storage migrate\` as the owner role, or GRANT CREATE ON DATABASE ${database} TO <owner role>.`;
	else if (/no schema has been selected/.test(denied))
		fix = `The role cannot use schema ${schema}: grant it as the schema's owner, GRANT USAGE ON SCHEMA ${schema} TO "${role}"; with the table grants of a runtime role.`;
	else if (/permission denied for schema/.test(denied) && /^\s*(CREATE|ALTER|DROP|COMMENT)\b/i.test(sql))
		fix = `Creating or changing Atomic's tables in schema ${schema} needs the owner role: the schema is behind this version of Atomic. Run \`atomic storage migrate\` as the owner role, then start again.`;
	else if (/permission denied for schema/.test(denied))
		fix = `The role needs USAGE on schema ${schema}: GRANT USAGE ON SCHEMA ${schema} TO "${role}";`;
	else if (/permission denied for (table|relation|sequence)/.test(denied))
		fix = `A runtime role needs SELECT, INSERT, UPDATE and DELETE on every table in schema ${schema}: GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO "${role}"; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO "${role}"; and ALTER DEFAULT PRIVILEGES as the owner for tables created later.`;
	else if (/permission denied for function/.test(denied))
		fix = `A runtime role needs EXECUTE on Atomic's trigger functions in schema ${schema}: GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO "${role}";`;
	else fix = `Grant the role the privilege, or run \`atomic storage migrate\` as the owner role.`;
	return configError(
		"privileges",
		"missing-privilege",
		`${who} lacks a privilege PostgreSQL requires: ${denied} (SQLSTATE ${/** @type {{ code?: string }} */ (cause).code ?? "42501"}). ${fix} See "Set up the database" in docs/storage.md`,
	);
}

/**
 * The `sslmode` values libpq knows.
 * @type {ReadonlySet<string>}
 */
const SSL_MODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);

/** Whether `name`, in lowercase, is a parameter that chooses or configures TLS. */
function isTlsParameter(/** @type {string} */ name) {
	return name.startsWith("ssl") || name === "uselibpqcompat";
}

/**
 * The URL pg connects with: a `postgres:` or `postgresql:` URL without a password, which gets `sslmode=verify-full`
 * when it names none and its host, or `PGHOST` for a URL that names no host, is not this machine. A TLS parameter whose name is not lowercase, or an `sslmode`
 * libpq does not know, is refused.
 * @param {unknown} url
 * @param {"url" | "listenUrl"} [field] The option that holds the URL, which a refusal names.
 * @returns {string}
 */
function connectionUrl(url, field = "url") {
	/** @type {URL} */
	let parsed;
	try {
		parsed = new URL(/** @type {string} */ (url));
	} catch {
		throw configError(field, "unsupported-url", "Use a postgres:// or postgresql:// URL");
	}
	if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
		throw configError(field, "unsupported-url", "Use a postgres:// or postgresql:// URL");
	const names = [...parsed.searchParams.keys()].map((name) => name.toLowerCase());
	if (parsed.password !== "" || names.includes("password"))
		throw configError(
			field,
			"credential-in-url",
			"Remove the password from the URL and pass it through the storage secrets instead",
		);
	// pg reads parameter names exactly as written, as libpq does: `SSLMODE=verify-full` would be ignored, and the
	// connection made without TLS.
	for (const name of parsed.searchParams.keys())
		if (name !== name.toLowerCase() && isTlsParameter(name.toLowerCase()))
			throw configError("url", "tls-parameter-case", `Write the parameter ${name} in lowercase`);
	const mode = parsed.searchParams.get("sslmode");
	if (mode !== null && !SSL_MODES.has(mode))
		throw configError("url", "unsupported-sslmode", `Use an sslmode of ${[...SSL_MODES].join(", ")}`);
	if (mode !== null) return /** @type {string} */ (url);
	// The host pg connects to: a URL that names none falls back to PGHOST, as pg does. This machine is told by the rule
	// that keeps it out of a proxy, so every spelling of it is treated alike (#5473).
	const host = parsed.searchParams.get("host") ?? (parsed.hostname || process.env.PGHOST || "");
	if (isLocalTarget(host)) return /** @type {string} */ (url);
	parsed.searchParams.set("sslmode", "verify-full");
	return parsed.href;
}

/**
 * The `sslmode` values whose TLS options the adapter sets itself, as libpq reads them, rather than as pg does, which
 * checks the host name for each of them: `verify-ca`, and `require` with an `sslrootcert`, check the certificate's CA
 * but not its host name, and `prefer` and `allow` encrypt without checking the certificate (pg cannot fall back to an
 * unencrypted connection, so neither does). `require` without an `sslrootcert` checks the certificate and its host
 * name, as `verify-full` does: stricter than libpq, which checks neither.
 * @type {ReadonlySet<string>}
 */
const LIBPQ_SSL_MODES = new Set(["allow", "prefer", "require", "verify-ca"]);

/**
 * The client configuration of `url`, with the TLS options its `sslmode` asks for. A URL with `uselibpqcompat` is left
 * to pg, which reads `sslmode` as libpq does then.
 * @param {typeof import("pg-connection-string").parseIntoClientConfig} parseUrl
 * @param {string} url
 */
function clientConfig(parseUrl, url) {
	const parsed = new URL(url);
	const mode = parsed.searchParams.get("sslmode");
	if (mode === null || !LIBPQ_SSL_MODES.has(mode) || parsed.searchParams.has("uselibpqcompat")) return parseUrl(url);
	// Parsed as verify-full, the TLS options pg builds for every mode here, without pg's warning that it checks them all.
	parsed.searchParams.set("sslmode", "verify-full");
	const connection = parseUrl(parsed.href);
	const ssl = /** @type {import("node:tls").ConnectionOptions} */ (connection.ssl);
	if (mode === "verify-ca" || (mode === "require" && parsed.searchParams.has("sslrootcert")))
		ssl.checkServerIdentity = () => undefined;
	else if (mode !== "require") ssl.rejectUnauthorized = false;
	return connection;
}

/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInteger(field, value, fallback) {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
		throw configError(field, "positive-integer-required");
	return value;
}

/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} fallback
 */
function nonNegativeInteger(field, value, fallback) {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw configError(field, "non-negative-integer-required");
	return value;
}

/**
 * Whether `character` can continue an identifier, so a `$` or `'` after it does not start a literal. Like Postgres's
 * lexer, any non-ASCII character counts; each UTF-16 code unit of one is at least U+0080.
 */
function isWordCharacter(/** @type {string | undefined} */ character) {
	return character !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(character);
}

/**
 * `sql` with each positional `?` parameter replaced by `$1`, `$2`, ... in order. A `?` inside a string literal, a quoted
 * identifier, a dollar-quoted string or a comment is text, not a parameter.
 * @param {string} sql
 */
export function numberPlaceholders(sql) {
	if (!sql.includes("?")) return sql;
	let numbered = "";
	let copied = 0;
	let count = 0;
	let index = 0;
	while (index < sql.length) {
		const character = sql[index];
		if (character === "?") {
			// After an identifier character `$1` would continue the identifier, so a space keeps the parameter apart.
			const separator = isWordCharacter(sql[index - 1]) ? " " : "";
			numbered += `${sql.slice(copied, index)}${separator}$${++count}`;
			copied = ++index;
		} else if (character === "'") {
			const escapes = /[eE]/.test(sql[index - 1] ?? "") && !isWordCharacter(sql[index - 2]);
			index++;
			// A doubled quote is a quote inside the same string, which keeps its backslash escapes.
			while (index < sql.length) {
				if (escapes && sql[index] === "\\") index += 2;
				else if (sql[index] !== "'") index++;
				else if (sql[index + 1] === "'") index += 2;
				else break;
			}
			index++;
		} else if (character === '"') {
			index = sql.indexOf('"', index + 1);
			index = index === -1 ? sql.length : index + 1;
		} else if (character === "-" && sql[index + 1] === "-") {
			index = sql.indexOf("\n", index);
			if (index === -1) index = sql.length;
		} else if (character === "/" && sql[index + 1] === "*") {
			let depth = 1;
			index += 2;
			while (index < sql.length && depth > 0) {
				if (sql.startsWith("/*", index)) {
					depth++;
					index += 2;
				} else if (sql.startsWith("*/", index)) {
					depth--;
					index += 2;
				} else index++;
			}
		} else if (character === "$" && !isWordCharacter(sql[index - 1])) {
			// A tag starts with an ASCII letter, `_` or any non-ASCII character, and may continue with digits too.
			const tag = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(sql.slice(index))?.[0];
			if (tag === undefined) index++;
			else {
				const end = sql.indexOf(tag, index + tag.length);
				index = end === -1 ? sql.length : end + tag.length;
			}
		} else index++;
	}
	return numbered + sql.slice(copied);
}

/**
 * @typedef {{
 *   references: number,
 *   pool: import("pg").Pool,
 *   reader: { pool: import("pg").Pool, references: number } | undefined,
 *   openReaderPool: () => import("pg").Pool,
 *   listener: (import("@bastani/atomic/storage").StorageNotifications & { close(): Promise<void> }) | undefined,
 *   lost: WeakSet<object>,
 *   tokenProviders: Set<{ invalidate(): void }>,
 *   passwords: Set<string>,
 *   password: (() => Promise<string>) | undefined,
 *   listenPassword: (() => Promise<string>) | undefined,
 *   pooler?: { decided: Promise<boolean | undefined>, decide(client: object): void },
 * }} SharedConnections The connections the databases a process opens with one identity share (#6560): the pool, the
 *   readers' pool, opened by the first reader and closed by the last, and the listening connection, with what their
 *   connections are opened and checked with. The last database to close closes them.
 * @typedef {{
 *   byDriver: WeakMap<object, Map<string, SharedConnections>>,
 *   socketFactories: WeakMap<object, number>,
 *   nextSocketFactory: number,
 * }} SharedRegistry
 */

/**
 * Where every load of this adapter in a process finds the connections it shares (#6560). The host evaluates the adapter
 * afresh for each load, the session store's and the Intercom broker's, so a map of the module's own would hold one
 * load's connections only. The key names the shape of the entries, so a load that keeps another shape never shares them.
 */
const SHARED_CONNECTIONS = Symbol.for("@bastani/atomic-storage-postgres/shared-connections@1");

function sharedRegistry() {
	const holder = /** @type {{ [SHARED_CONNECTIONS]?: SharedRegistry }} */ (globalThis);
	holder[SHARED_CONNECTIONS] ??= { byDriver: new WeakMap(), socketFactories: new WeakMap(), nextSocketFactory: 0 };
	return holder[SHARED_CONNECTIONS];
}

/**
 * The shared connections of the databases opened with `pg`, by identity: only databases on the same `pg` share them, so
 * a failure on a shared connection is always an error class of the `pg` that reads it.
 * @param {object} pg
 */
function sharedConnectionsOf(pg) {
	const { byDriver } = sharedRegistry();
	let byIdentity = byDriver.get(pg);
	if (byIdentity === undefined) {
		byIdentity = new Map();
		byDriver.set(pg, byIdentity);
	}
	return byIdentity;
}

/**
 * A number for `factory` in a pool's identity: the same function is the same transport.
 * @param {object} factory
 */
function socketFactoryId(factory) {
	const registry = sharedRegistry();
	let id = registry.socketFactories.get(factory);
	if (id === undefined) {
		id = ++registry.nextSocketFactory;
		registry.socketFactories.set(factory, id);
	}
	return id;
}

/** Where every load of this adapter in a process finds the number it gave each password (#6560). */
const CREDENTIAL_IDS = Symbol.for("@bastani/atomic-storage-postgres/credential-ids@1");

/**
 * A number for `password` in a pool's identity, the same for the same password in every load of this adapter in the
 * process. The password stays in memory, as the pool's own configuration already holds it; it is never hashed, stored
 * or sent anywhere.
 * @param {string} password
 */
function credentialId(password) {
	const holder = /** @type {{ [CREDENTIAL_IDS]?: { ids: Map<string, number>, next: number } }} */ (globalThis);
	const registry = (holder[CREDENTIAL_IDS] ??= { ids: new Map(), next: 0 });
	let id = registry.ids.get(password);
	if (id === undefined) {
		id = ++registry.next;
		registry.ids.set(password, id);
	}
	return id;
}

/**
 * What tells one password from another in a pool's identity: a number for the password `source` gives now, never the
 * password itself, with the password, which the redactor removes from failures. Undefined when the source fails or
 * gives no password: such a database shares nothing, and its connections fail as they would alone (#6560).
 * @param {string | (() => Promise<string>) | undefined} source
 * @returns {Promise<{ key: string, value?: string } | undefined>}
 */
async function credentialOf(source) {
	if (source === undefined) return { key: "none" };
	/** @type {unknown} */
	let value;
	try {
		value = typeof source === "string" ? source : await source();
	} catch {
		return undefined;
	}
	if (typeof value !== "string" || value === "") return undefined;
	return { key: `password:${credentialId(value)}`, value };
}

/**
 * Closes the connections `pool` keeps without an idle timeout of their own (its `min`) once the whole pool was idle for
 * `idleMs` since a call last returned a connection (#6560). Each is taken from the idle ones, so none is opened here.
 * @param {import("pg").Pool} pool
 * @param {number} idleMs
 */
function closeWhenIdle(pool, idleMs) {
	/** @type {NodeJS.Timeout | undefined} */
	let timer;
	let closing = false;
	const close = async () => {
		timer = undefined;
		closing = true;
		try {
			while (!pool.ending && pool.waitingCount === 0 && pool.idleCount > 0 && pool.idleCount === pool.totalCount)
				(await pool.connect()).release(true);
		} catch {
			// The pool ended meanwhile.
		} finally {
			closing = false;
		}
	};
	pool.on("release", () => {
		if (closing) return;
		clearTimeout(timer);
		timer = setTimeout(close, idleMs);
		timer.unref();
	});
}

/** The longest identifier Postgres keeps whole; it truncates a longer one. */
const IDENTIFIER_BYTES = 63;

/**
 * `sql` with every unquoted identifier longer than Postgres keeps whole replaced by the name the storage dialect gives
 * it (`postgresDialect.identifier`: its head and a hash of the whole name), in every statement, DDL and DML alike, and
 * in the bodies of functions and `DO` blocks. Created objects, the statements that use them, and the dialect's catalog
 * probes then always name one object by one identifier, whatever prefix a store was given, rather than Postgres
 * truncating each occurrence on its own. Values are never changed: string literals, every other dollar-quoted string,
 * quoted identifiers and comments (nested as Postgres nests them) are left as written.
 * @param {string} sql
 */
export function physicalIdentifiers(sql) {
	if (!/[A-Za-z0-9_$]{64}/.test(sql)) return sql;
	let mapped = "";
	let copied = 0;
	let index = 0;
	// Where the current statement starts, after the last `;` outside quotes and comments.
	let statement = 0;
	while (index < sql.length) {
		const character = /** @type {string} */ (sql[index]);
		if (/[A-Za-z_]/.test(character) && !isWordCharacter(sql[index - 1])) {
			let end = index + 1;
			while (end < sql.length && isWordCharacter(sql[end])) end++;
			const word = sql.slice(index, end);
			if (word.length > IDENTIFIER_BYTES && /^[A-Za-z0-9_]+$/.test(word)) {
				mapped += `${sql.slice(copied, index)}${postgresDialect.identifier(word)}`;
				copied = end;
			}
			index = end;
		} else if (character === "'") {
			const escapes = /[eE]/.test(sql[index - 1] ?? "") && !isWordCharacter(sql[index - 2]);
			index++;
			while (index < sql.length) {
				if (escapes && sql[index] === "\\") index += 2;
				else if (sql[index] !== "'") index++;
				else if (sql[index + 1] === "'") index += 2;
				else break;
			}
			index++;
		} else if (character === '"') {
			index = sql.indexOf('"', index + 1);
			index = index === -1 ? sql.length : index + 1;
		} else if (character === "-" && sql[index + 1] === "-") {
			index = sql.indexOf("\n", index);
			if (index === -1) index = sql.length;
		} else if (character === "/" && sql[index + 1] === "*") {
			index = blockCommentEnd(sql, index);
		} else if (character === "$" && !isWordCharacter(sql[index - 1])) {
			const tag = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(sql.slice(index))?.[0];
			if (tag === undefined) index++;
			else {
				const start = index + tag.length;
				const close = sql.indexOf(tag, start);
				const end = close === -1 ? sql.length : close;
				// A function's or `DO` block's body is SQL: its identifiers are mapped, its literals kept. Any other
				// dollar-quoted string is a value, kept as written.
				if (isRoutineBody(sql.slice(statement, index))) {
					mapped += `${sql.slice(copied, start)}${physicalIdentifiers(sql.slice(start, end))}`;
					copied = end;
				}
				index = close === -1 ? sql.length : close + tag.length;
			}
		} else {
			if (character === ";") statement = index + 1;
			index++;
		}
	}
	return mapped + sql.slice(copied);
}

/** The index after the block comment that opens at `index`, which nests as Postgres nests comments. */
function blockCommentEnd(/** @type {string} */ sql, /** @type {number} */ index) {
	let depth = 1;
	let at = index + 2;
	while (at < sql.length && depth > 0) {
		if (sql.startsWith("/*", at)) {
			depth++;
			at += 2;
		} else if (sql.startsWith("*/", at)) {
			depth--;
			at += 2;
		} else at++;
	}
	return at;
}

/**
 * Whether a dollar-quoted string after `before`, the text of its statement up to it, is the body of a routine: the
 * string after `AS` in `CREATE [OR REPLACE] FUNCTION|PROCEDURE`, or after `DO [LANGUAGE …]`.
 * @param {string} before
 */
function isRoutineBody(before) {
	let text = "";
	for (let at = 0; at < before.length; ) {
		if (before.startsWith("/*", at)) {
			at = blockCommentEnd(before, at);
			text += " ";
		} else if (before.startsWith("--", at)) {
			const end = before.indexOf("\n", at);
			at = end === -1 ? before.length : end;
			text += " ";
		} else text += before[at++];
	}
	if (/^\s*DO(?:\s+LANGUAGE\s+\w+)?\s*$/i.test(text)) return true;
	return /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b[\s\S]*\bAS\s*$/i.test(text);
}

/** Whether `sql` is a single SQLite `PRAGMA` statement, which Postgres has no use for. */
function isPragma(/** @type {string} */ sql) {
	return /^PRAGMA\b[^;]*;?$/i.test(sql.trim());
}

const INT8 = 20;
const INT2 = 21;
const INT4 = 23;
const OID = 26;
const FLOAT4 = 700;
const FLOAT8 = 701;
const NUMERIC = 1700;
const BOOL = 16;
const BYTEA = 17;

/**
 * Turns each column's text into a SQLite value: integers as numbers or `bigint`s (the facade turns safe ones into
 * numbers), a whole `NUMERIC` (such as a `SUM` of `BIGINT`s, or `2.00`) as an integer, booleans as 1 or 0, `BYTEA` as bytes,
 * and everything else, JSON and timestamps included, as its text.
 * @param {typeof import("pg").types} pgTypes
 */
function sqliteTypes(pgTypes) {
	const bytea = pgTypes.getTypeParser(BYTEA, "text");
	/** @type {(text: string) => string} */
	const asText = (text) => text;
	return {
		/** @param {number} oid */
		getTypeParser(oid) {
			switch (oid) {
				case INT8:
					return (/** @type {string} */ text) => BigInt(text);
				case INT2:
				case INT4:
				case OID:
				case FLOAT4:
				case FLOAT8:
					return Number;
				case NUMERIC:
					return (/** @type {string} */ text) => {
						const whole = /^(-?\d+)(?:\.0*)?$/.exec(text);
						return whole === null ? Number(text) : BigInt(/** @type {string} */ (whole[1]));
					};
				case BOOL:
					return (/** @type {string} */ text) => (text === "t" ? 1 : 0);
				case BYTEA:
					return bytea;
				default:
					return asText;
			}
		},
	};
}

/**
 * Why a driver call failed before or while it talked to the server, when the server did not say: `"connect"`, no
 * connection could be had, so nothing was sent; `"lost"`, the connection broke or stopped answering during the call.
 */
class PostgresConnectionFailure extends StorageError {
	/**
	 * @param {"connect" | "lost"} phase
	 * @param {StorageFailureCause} cause
	 */
	constructor(phase, cause) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.phase = phase;
	}
}

/** How far `transientFailure` follows `cause`. */
const MAX_CAUSE_DEPTH = 8;

/**
 * SQLSTATEs of a failure that passes, with what it says of the request.
 * @type {ReadonlyMap<string, SqliteDriverTransientFailure>}
 */
const TRANSIENT_SQLSTATES = new Map([
	// serialization_failure, deadlock_detected, lock_not_available: the server rolled the statement back.
	["40001", { code: "lock-conflict", outcome: "not-applied" }],
	["40P01", { code: "lock-conflict", outcome: "not-applied" }],
	["55P03", { code: "lock-conflict", outcome: "not-applied" }],
	// query_canceled (statement_timeout) and idle_in_transaction_session_timeout: rolled back.
	["57014", { code: "transaction-timeout", outcome: "not-applied" }],
	["25P03", { code: "transaction-timeout", outcome: "not-applied" }],
	// too_many_connections, cannot_connect_now (starting up or in recovery): no connection, nothing sent.
	["53300", { code: "connection-refused", outcome: "not-applied" }],
	["57P03", { code: "connection-refused", outcome: "not-applied" }],
	["08001", { code: "connection-refused", outcome: "not-applied" }],
	["08004", { code: "connection-refused", outcome: "not-applied" }],
	// admin_shutdown, crash_shutdown, connection_exception, connection_does_not_exist, connection_failure: the
	// connection ended while a request may have been applied.
	["57P01", { code: "connection-lost", outcome: "unknown" }],
	["57P02", { code: "connection-lost", outcome: "unknown" }],
	["08000", { code: "connection-lost", outcome: "unknown" }],
	["08003", { code: "connection-lost", outcome: "unknown" }],
	["08006", { code: "connection-lost", outcome: "unknown" }],
	// read_only_sql_transaction: a write refused, nothing applied. A read replica refuses it every time; a primary does
	// for a while during a failover, or when the service makes it read-only because its storage is nearly full.
	["25006", { code: "read-only-server", outcome: "not-applied" }],
	// invalid_sql_statement_name, duplicate_prepared_statement: a named statement the connection's server no longer
	// has, or already has, as behind a pooler that moves connections; nothing ran, and the call goes again unnamed.
	["26000", { code: "connection-lost", outcome: "not-applied" }],
	["42P05", { code: "connection-lost", outcome: "not-applied" }],
]);

/** A prepared statement whose plan a schema change invalidated: refused before it ran, and run again on a new connection. */
const STALE_PLAN = /** @type {const} */ ({ code: "connection-lost", outcome: "not-applied" });

/**
 * Whether the server refused a prepared statement because a schema change altered its result columns ("cached plan
 * must not change result type"): `feature_not_supported`, raised where the server checks a cached plan.
 * @param {{ code?: string, routine?: string }} failure
 */
function isStalePlan(failure) {
	return failure.code === "0A000" && failure.routine === "RevalidateCachedQuery";
}

/**
 * The failure, as one that passes, read from the server's SQLSTATE when the server answered, else from whether a
 * connection could be had or broke during the call; never from a message. A connection a proxy did not open names the
 * proxy as the hop that failed (#5473).
 * @param {typeof import("pg").DatabaseError} DatabaseError
 * @returns {(failure: StorageFailureCause) => SqliteDriverTransientFailure | undefined}
 */
function transientFailureOf(DatabaseError) {
	return (failure) => {
		/** @type {PostgresConnectionFailure | undefined} */
		let connection;
		/** @type {ProxyTunnelError | undefined} */
		let tunnel;
		/** @type {unknown} */
		let current = failure;
		for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
			if (current instanceof DatabaseError)
				return isStalePlan(current) ? STALE_PLAN : TRANSIENT_SQLSTATES.get(current.code ?? "");
			if (current instanceof PostgresConnectionFailure) connection ??= current;
			else if (current instanceof ProxyTunnelError) tunnel ??= current;
			else if (current instanceof StorageError) return undefined;
			current = /** @type {{ readonly cause?: unknown }} */ (current).cause;
		}
		if (connection === undefined) return undefined;
		if (connection.phase === "lost") return { code: "connection-lost", outcome: "unknown" };
		return tunnel === undefined
			? { code: "connection-refused", outcome: "not-applied" }
			: {
					code: "connection-refused",
					outcome: "not-applied",
					hop: { name: `the proxy ${tunnel.proxy}`, failure: tunnel.message },
				};
	};
}

/**
 * Whether two statements' parameters are the same values.
 * @param {readonly SqliteValue[]} first
 * @param {readonly SqliteValue[]} second
 */
function sameParams(first, second) {
	if (first.length !== second.length) return false;
	return first.every((value, index) => {
		const other = second[index];
		if (value instanceof Uint8Array && other instanceof Uint8Array)
			return value.length === other.length && value.every((byte, at) => byte === other[at]);
		return value === other;
	});
}

/**
 * The advisory lock key of `scope`, as SQL.
 * @param {string} scope
 */
function lockKey(scope) {
	return `hashtextextended(${literal(scope)}, 0)`;
}

/**
 * The endpoint pg connects to for `config`, resolved as pg resolves it: the URL's host and port, else `PGHOST` and
 * `PGPORT`, else `localhost` and 5432.
 * @param {{ host?: string | null, port?: string | number | null }} config
 * @returns {{ host: string, port: number }}
 */
function endpointOf(config) {
	return {
		host: config.host || process.env.PGHOST || "localhost",
		port: Number.parseInt(String(config.port || process.env.PGPORT || 5432), 10),
	};
}

/** The protocol's SSLRequest code, sent before a TLS handshake on a new connection. */
const SSL_REQUEST_CODE = 80877103;

/**
 * `raw`, a new connection to the server, with TLS negotiated on it as pg negotiates it for a session: an SSLRequest,
 * then a handshake with `ssl`'s options that checks the certificate against `host`. A server that declines TLS gets
 * nothing more, so a cancel key meant for an encrypted connection is never sent in clear (#5473).
 * @param {import("node:stream").Duplex} raw
 * @param {string} host
 * @param {boolean | import("node:tls").ConnectionOptions} ssl
 * @returns {Promise<import("node:stream").Duplex>}
 */
function secureCancelStream(raw, host, ssl) {
	return new Promise((resolve, reject) => {
		const request = Buffer.alloc(8);
		request.writeInt32BE(8, 0);
		request.writeInt32BE(SSL_REQUEST_CODE, 4);
		raw.once("error", reject);
		raw.once("data", (/** @type {Buffer} */ answer) => {
			raw.pause();
			if (answer.toString("latin1") !== "S") {
				raw.destroy();
				reject(new Error("The server declined TLS for the cancel request"));
				return;
			}
			const secure = connectTls({
				socket: /** @type {import("node:net").Socket} */ (raw),
				host,
				...(ssl === true ? {} : ssl),
				...(isIP(host) === 0 ? { servername: host } : {}),
			});
			secure.once("error", reject);
			secure.once("secureConnect", () => {
				secure.off("error", reject);
				resolve(secure);
			});
		});
		// A tunnel is handed over paused, and a `data` listener alone does not resume a paused stream.
		raw.resume();
		raw.write(request);
	});
}

/**
 * Quotes `text` as a SQL string literal.
 * @param {string} text
 */
function literal(text) {
	return `'${text.replaceAll("'", "''")}'`;
}

/**
 * @param {PostgresDatabaseOptions} options
 * @returns {Promise<import("@bastani/atomic/storage").SqliteDatabase>}
 */
export async function openPostgresDatabase(options) {
	const connectionString = connectionUrl(options.url);
	const auth = options.auth ?? "password";
	const cloud = auth === "azure-entra" || auth === "aws-iam" || auth === "gcp-iam" ? auth : undefined;
	if (cloud === undefined && auth !== "password")
		throw configError("auth", "unsupported-auth", 'Use "password", "azure-entra", "aws-iam" or "gcp-iam"');
	if (cloud !== undefined && options.password !== undefined)
		throw configError("auth", "conflicting-token", `Use either a password or ${cloud} auth, not both`);
	const maxConnections = positiveInteger("maxConnections", options.maxConnections, DEFAULT_MAX_CONNECTIONS);
	const statementTimeoutMs = positiveInteger(
		"statementTimeoutMs",
		options.statementTimeoutMs,
		DEFAULT_STATEMENT_TIMEOUT_MS,
	);
	const idleTimeoutMs = positiveInteger("idleTimeoutMs", options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
	const readerMaxConnections = Math.min(
		nonNegativeInteger("readerMaxConnections", options.readerMaxConnections, DEFAULT_READER_MAX_CONNECTIONS),
		maxConnections,
	);
	const connectTimeoutMs = positiveInteger("connectTimeoutMs", options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
	const keepAliveIdleMs = positiveInteger("keepAliveIdleMs", options.keepAliveIdleMs, DEFAULT_KEEPALIVE_IDLE_MS);
	const configuredPrepared =
		options.maxPreparedStatements === undefined
			? undefined
			: nonNegativeInteger("maxPreparedStatements", options.maxPreparedStatements, 0);
	if (options.schema !== undefined && (typeof options.schema !== "string" || !SCHEMA_NAME.test(options.schema)))
		throw configError("schema", "invalid-schema", "Use a lowercase identifier of letters, digits and _, such as atomic");
	if (options.proxy !== undefined && typeof options.proxy !== "string")
		throw configError("proxy", "unsupported-proxy", 'Use an http:// or https:// proxy URL, or "none"');
	if (options.socket !== undefined && typeof options.socket !== "function")
		throw configError("socket", "invalid-socket-factory", "Pass a function that opens a connection to { host, port }");
	if (options.proxy !== undefined && options.socket !== undefined)
		throw configError("proxy", "conflicting-transport", "Pass either a proxy or a socket factory, not both");
	/**
	 * The schema every statement runs in, set with `SET LOCAL search_path` in each transaction so a transaction-mode
	 * pooler can serve it: the configured one, else `atomic`, or `public` for a database an earlier release set up there.
	 * Resolved when the database opens.
	 */
	let schema = options.schema ?? DEFAULT_SCHEMA;
	/** Whether `schema` exists; until it does, the first statement that creates something creates it first. */
	let schemaReady = true;
	/** Whether `schema` is `public` because an earlier release's tables were there when the database opened. */
	let legacy = false;
	/** @type {Promise<void> | undefined} */
	let creatingSchema;
	/**
	 * The schema's catalog and ledger versions the open read, until the first store open takes them (#6560).
	 * @type {import("@bastani/atomic/storage").StorageOpenedCatalog | undefined}
	 */
	let openedCatalog;
	const searchPathSql = () => `SET LOCAL search_path TO "${schema}"`;
	/** A lock or channel name of this schema's own: unchanged for `public`, so earlier releases there share them. */
	const inSchema = (/** @type {string} */ name) => (schema === LEGACY_SCHEMA ? name : `${schema}:${name}`);

	/** @type {Pick<typeof import("pg"), "Pool" | "Client" | "DatabaseError" | "types">} */
	let pg;
	/** @type {typeof import("pg-connection-string").parseIntoClientConfig} */
	let parseUrl;
	try {
		pg = (await import("pg")).default;
		({ parseIntoClientConfig: parseUrl } = await import("pg-connection-string"));
	} catch (cause) {
		throw new StorageAdapterLoadError("pg", /** @type {StorageFailureCause} */ (cause));
	}

	// The URL is parsed here rather than passed as `connectionString`, whose empty password would replace `password`.
	/** @param {string} url */
	const parseConnection = (url) => {
		const parsed = clientConfig(parseUrl, url);
		delete parsed.password;
		return parsed;
	};
	const connection = parseConnection(connectionString);
	// Notifications reach only a session of their own: through a transaction pooler `listenUrl` names a direct endpoint.
	const listenConnection =
		options.listenUrl === undefined ? connection : parseConnection(connectionUrl(options.listenUrl, "listenUrl"));
	// Behind a transaction pooler, a connection's prepared statements can land on another server connection, which
	// only some poolers handle (PgBouncer 1.21 and later with `max_prepared_statements` set, not Supavisor's shared
	// pooler), so unless configured they start off there: where `listenUrl` names a direct endpoint, or on the ports
	// PgBouncer (6432) and Supavisor (6543) listen on. The first connection then tells whether the endpoint is such a
	// PgBouncer, which turns them on, or another pooler, which turns them off on any port (`keepsPrepared`).
	const behindPooler = options.listenUrl !== undefined || POOLER_PORTS.has(endpointOf(connection).port);
	let maxPreparedStatements = configuredPrepared ?? (behindPooler ? 0 : DEFAULT_MAX_PREPARED_STATEMENTS);

	/**
	 * How connections to `target` are opened (#5473): through the caller's socket factory, the `proxy` option, or the
	 * environment's HTTP proxy, as `postgresTransport` decides; undefined for a direct connection, which pg opens itself.
	 * A socket directory is always reached directly. The decision is made for the endpoint pg connects to, which falls
	 * back to `PGHOST` and `PGPORT` when the URL names no host or port.
	 * @param {typeof connection} target
	 * @returns {import("./proxy.js").PostgresSocketFactory | undefined}
	 */
	const openerFor = (target) => {
		const { host, port } = endpointOf(target);
		if (host.startsWith("/")) return undefined;
		if (options.socket !== undefined) return options.socket;
		try {
			return socketOpener(postgresTransport({ host, port }, process.env, options.proxy));
		} catch (error) {
			if (error instanceof ProxySettingError)
				throw configError(
					"proxy",
					"unsupported-proxy",
					`${error.message}. Use an http:// or https:// proxy URL, set NO_PROXY for the database host, or pass proxy "none"`,
				);
			throw error;
		}
	};
	const opener = openerFor(connection);
	const listenOpener = listenConnection === connection ? opener : openerFor(listenConnection);
	/**
	 * pg's `stream` option for connections opened by `open`: a fresh stream for each connection.
	 * @param {import("./proxy.js").PostgresSocketFactory | undefined} open
	 */
	const streamOption = (open) => (open === undefined ? {} : { stream: () => new OpenedSocket(open) });

	// What decides whether two databases of this process share their connections (#6560): the same server, database,
	// role and credential, schema and pool options. A database whose password source failed has no identity, and gets
	// connections of its own that fail as they did before.
	const credential = cloud === undefined ? await credentialOf(options.password) : { key: `auth:${cloud}` };
	const identity =
		credential === undefined
			? undefined
			: JSON.stringify([
					connectionString,
					options.listenUrl === undefined ? null : connectionUrl(options.listenUrl, "listenUrl"),
					auth,
					credential.key,
					options.schema ?? DEFAULT_SCHEMA,
					options.proxy ?? null,
					options.socket === undefined ? null : socketFactoryId(options.socket),
					maxConnections,
					idleTimeoutMs,
					readerMaxConnections,
					connectTimeoutMs,
					keepAliveIdleMs,
					options.sdkSearchPaths ?? null,
				]);
	const sharing = sharedConnectionsOf(pg);
	/** The connections an open database of this process with the same identity holds, which this one shares. */
	const found = identity === undefined ? undefined : sharing.get(identity);

	/** The cloud token providers of the pool's and the listening connection's hosts. */
	/** @type {Set<{ invalidate(): void }>} */
	const tokenProviders = found?.tokenProviders ?? new Set();
	/** Every password the pool was given, so the redactor can remove them from failures. */
	const passwords = found?.passwords ?? new Set(typeof options.password === "string" ? [options.password] : []);
	if (credential?.value !== undefined) passwords.add(credential.value);
	/**
	 * The password function for connections to `target`: cloud IAM tokens are issued per host.
	 * @param {typeof connection} target
	 * @returns {(() => Promise<string>) | undefined}
	 */
	const passwordFor = (target) => {
		const provider =
			cloud === undefined
				? undefined
				: createCloudPasswordProvider({
						auth: cloud,
						host: target.host ?? "",
						port: target.port ?? 5432,
						user: target.user ?? "",
						...(options.sdkSearchPaths === undefined ? {} : { searchPaths: options.sdkSearchPaths }),
					});
		if (provider !== undefined) tokenProviders.add(provider);
		const source = provider ?? options.password;
		return source === undefined
			? undefined
			: async () => {
					/** @type {unknown} */
					let value;
					try {
						value = typeof source === "string" ? source : await source();
					} catch (error) {
						// The source's own request refused a certificate is not the server's (#6112): such a rejection is
						// wrapped, for itself alone, so the connection fails as for any failure of the source; any other
						// rejection is passed on as it is.
						throw refusedCertificate(error) === undefined ? error : new PasswordSourceError(error);
					}
					if (typeof value !== "string" || value === "")
						throw configError("password", "empty-token", "The password source gave an empty password");
					passwords.add(value);
					return value;
				};
	};
	const password = found === undefined ? passwordFor(connection) : found.password;

	// pg leaves the socket of a connection that failed to start open, for instance when the password source failed while
	// the server waited for the password; the server keeps that half-started backend until its authentication timeout,
	// and meanwhile it holds up statements that wait for every backend, such as `DROP DATABASE`.
	class ClosingClient extends pg.Client {
		/** The `pgbouncer.*` parameters the server reported at login, which PgBouncer 1.26 and later report. */
		poolerParameters = new Map();
		/** @param {(error: Error | undefined) => void} callback */
		// @ts-expect-error pg-pool always passes a callback, so the promise form is left out.
		connect(callback) {
			this.connection.on(
				"parameterStatus",
				(/** @type {{ parameterName: string, parameterValue: string }} */ { parameterName, parameterValue }) => {
					if (parameterName.startsWith("pgbouncer.")) this.poolerParameters.set(parameterName, parameterValue);
				},
			);
			super.connect((/** @type {Error | undefined} */ error) => {
				if (error) this.connection.stream.destroy();
				callback(error);
			});
		}
	}
	/** Connections that broke: they are closed, never returned to the pool. */
	const lost = found?.lost ?? new WeakSet();
	/**
	 * Whether the endpoint keeps a connection's prepared statements across the server connections it hands it, as a
	 * direct connection does: true for PgBouncer 1.21 or later with `max_prepared_statements` above 0, false for any
	 * other pooler found, undefined when it cannot tell. Decided from `client`, the first connection the shared pools
	 * opened, at no cost of its own: PgBouncer 1.26 and later name themselves in the parameters they report at login.
	 * Otherwise `client` prepares a probe statement in a transaction sent ahead of the call that opened it, in the same
	 * round trip, and drops it again. A server that holds it under a PgBouncer name keeps statements. A server process
	 * other than the one the connection's cancel key names sits behind a pooler that hands out keys of its own (as every
	 * PgBouncer does), which keeps them off. A failed probe says nothing.
	 * @param {ClosingClient} client
	 * @returns {Promise<boolean | undefined>}
	 */
	const keepsPrepared = async (client) => {
		const reported = pgbouncerKeepsPrepared(client.poolerParameters);
		if (reported !== undefined) return reported;
		const name = `atomic_probe_${randomBytes(8).toString("hex")}`;
		// Every answer is awaited, so none is left to fail unheard. The probe runs in a transaction, so the statement it
		// leaves on a server connection that a pooler passes it to is dropped on that same connection.
		const [, probe] = await Promise.allSettled([
			client.query("BEGIN"),
			client.query({ name, text: PGBOUNCER_PROBE_SQL, rowMode: "array" }),
			client.query(
				`DO $probe$BEGIN EXECUTE 'DEALLOCATE ${name}'; EXCEPTION WHEN invalid_sql_statement_name THEN NULL; END$probe$`,
			),
			client.query("COMMIT"),
		]);
		if (probe.status !== "fulfilled") return undefined;
		const [kept, pid] = probe.value.rows[0] ?? [];
		// The pool reads booleans as SQLite does, 1 for true.
		if (kept === 1) return true;
		const { processID } = /** @type {ClosingClient & { processID: number }} */ (client);
		return Number(pid) === processID ? undefined : false;
	};
	/**
	 * What the shared pools' first connection tells of prepared statements (`keepsPrepared`), decided once.
	 * @returns {NonNullable<SharedConnections["pooler"]>}
	 */
	const poolerDecision = () => {
		/** @type {(kept: Promise<boolean | undefined>) => void} */
		let settle = () => {};
		const decided = new Promise((resolve) => {
			settle = resolve;
		});
		let pending = true;
		return {
			decided: /** @type {Promise<boolean | undefined>} */ (decided),
			decide(client) {
				if (!pending) return;
				pending = false;
				settle(keepsPrepared(/** @type {ClosingClient} */ (client)).catch(() => undefined));
			},
		};
	};
	/**
	 * Whether the pool keeps its first connection longer than the others: with an idle timeout above
	 * `SURGE_IDLE_TIMEOUT_MS`, a connection beyond the first closes after that much idle time, and the first one only
	 * once the whole pool was idle for the idle timeout (#6560).
	 */
	const tiered = idleTimeoutMs > SURGE_IDLE_TIMEOUT_MS;
	/**
	 * A pool of up to `max` connections to the database, opened as calls need them. An idle connection stays open a
	 * while, so the next call does not wait for a new connection's handshakes, and it does not keep the process from
	 * exiting.
	 * @param {number} max
	 * @param {string} applicationName
	 */
	const openPool = (max, applicationName) => {
		const opened = new pg.Pool({
			Client: /** @type {typeof pg.Client} */ (/** @type {unknown} */ (ClosingClient)),
			...connection,
			...streamOption(opener),
			...(password === undefined ? {} : { password }),
			max,
			connectionTimeoutMillis: connectTimeoutMs,
			min: tiered ? 1 : 0,
			idleTimeoutMillis: tiered ? SURGE_IDLE_TIMEOUT_MS : idleTimeoutMs,
			allowExitOnIdle: true,
			keepAlive: true,
			keepAliveInitialDelayMillis: keepAliveIdleMs,
			// Queries are written without waiting for the answer to the one before, so a statement outside a transaction
			// sends its `BEGIN` and `COMMIT` in the same round trip; each query still ends with its own sync.
			pipeline: true,
			application_name: applicationName,
			types: sqliteTypes(pg.types),
		});
		// An idle connection that breaks emits `error` on the pool, which would end the process unheard.
		opened.on("error", (_error, client) => lost.add(client));
		opened.on("connect", (client) => {
			client.on("error", () => lost.add(client));
			shared.pooler?.decide(client);
		});
		if (tiered) closeWhenIdle(opened, idleTimeoutMs);
		return opened;
	};
	/** @type {SharedConnections} */
	const shared = found ?? {
		references: 0,
		pool: openPool(maxConnections, "atomic"),
		reader: undefined,
		openReaderPool: () => openPool(readerMaxConnections, "atomic-reader"),
		listener: undefined,
		lost,
		tokenProviders,
		passwords,
		password,
		listenPassword: passwordFor(listenConnection),
		pooler: poolerDecision(),
	};
	if (found === undefined && identity !== undefined) sharing.set(identity, shared);
	shared.references++;
	const { pool } = shared;

	/**
	 * The proxy's refusal or failure the latest attempt to connect ended in, kept here because the facade passes on a
	 * redacted copy of a failure, which is no longer a `ProxyTunnelError` (#5473). Cleared by a connection that opens.
	 * @type {ProxyTunnelError | undefined}
	 */
	let tunnelFailure;
	/**
	 * A connection of `from`.
	 * @param {import("pg").Pool} from
	 * @returns {Promise<PoolClient>}
	 */
	const connect = async (from) => {
		try {
			const client = await from.connect();
			tunnelFailure = undefined;
			return client;
		} catch (cause) {
			tunnelFailure = proxyTunnelFailure(cause);
			// A cloud token the server refused (28P01, or Azure's 28000 for a malformed one) is dropped, and a fresh one
			// tried once: a clock that runs behind can reuse a cached token past its expiry (#5218).
			if (tokenProviders.size > 0 && cause instanceof pg.DatabaseError && REFUSED_TOKEN_SQLSTATES.has(cause.code ?? "")) {
				for (const provider of tokenProviders) provider.invalidate();
				try {
					return await from.connect();
				} catch (retried) {
					throw connectFailure(retried);
				}
			}
			throw connectFailure(cause);
		}
	};

	/**
	 * Asks the server, on a connection of its own, to cancel the statement `client` runs, so a statement the client gave
	 * up on stops rather than runs on. Resolves once the server, or a pooler that passes the request on, closed that
	 * connection, or after `CLIENT_TIMEOUT_GRACE_MS` when it does not.
	 * @param {PoolClient} client
	 * @returns {Promise<void>}
	 */
	const cancel = (client) => {
		const { processID, secretKey } = /** @type {PoolClient & { processID: number, secretKey: number }} */ (client);
		const request = Buffer.alloc(CANCEL_REQUEST_LENGTH);
		request.writeInt32BE(CANCEL_REQUEST_LENGTH, 0);
		request.writeInt32BE(CANCEL_REQUEST_CODE, 4);
		request.writeInt32BE(processID, 8);
		request.writeInt32BE(secretKey, 12);
		const { host, port } = endpointOf(connection);
		return new Promise((resolve) => {
			/** @type {import("node:stream").Duplex | undefined} */
			let socket;
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				socket?.destroy();
				resolve(undefined);
			};
			// The whole request, a proxy tunnel and its TLS included, is bounded.
			const timer = setTimeout(finish, CLIENT_TIMEOUT_GRACE_MS);
			/** @type {Promise<import("node:stream").Duplex>} */
			const opened =
				opener === undefined
					? Promise.resolve(
							host.startsWith("/") ? connectSocket(`${host}/.s.PGSQL.${port}`) : connectSocket(port, host),
						)
					: // Through a tunnel the request is sent over TLS when the connection is, so the proxy never sees the
						// connection's cancel key (#5473).
						Promise.resolve()
							.then(() => opener({ host, port }))
							.then((raw) => {
								// Kept at once, so the bound closes the tunnel whatever stage the request reached: a hung
								// server may never answer the SSLRequest or finish the handshake.
								socket = raw;
								if (done) {
									raw.destroy();
									return raw;
								}
								return connection.ssl ? secureCancelStream(raw, host, connection.ssl) : raw;
							});
			opened.then(
				(opening) => {
					socket = opening;
					if (done) return void opening.destroy();
					opening.on("error", finish);
					opening.once("close", finish);
					opening.end(request);
					opening.resume();
				},
				finish,
			);
		});
	};

	/**
	 * Runs `query` on `client`. When it has not finished after `timeoutMs`, the server is asked to cancel it, and the
	 * connection is closed, after the request because a pooler forgets the connection's cancel key once it closes; the
	 * call then fails as a lost connection, whatever the server answers late. A failure that was not the server's
	 * answer, once the connection broke, is reported as a lost connection too.
	 * @template T
	 * @param {PoolClient} client
	 * @param {() => Promise<T>} query
	 * @param {number} timeoutMs
	 * @param {string} [sql] The statement, which a missing privilege's message reads to name the fix.
	 * @returns {Promise<T>}
	 */
	const watched = async (client, query, timeoutMs, sql = "") => {
		let expired = false;
		const timer = setTimeout(() => {
			expired = true;
			lost.add(client);
			void cancel(client).then(() => client.connection.stream.destroy());
		}, timeoutMs);
		try {
			return await query();
		} catch (cause) {
			if (expired)
				throw new PostgresConnectionFailure("lost", new Error(`The server did not answer within ${timeoutMs} ms`));
			// The server ends the connection after a FATAL error, and pg reports the end only later.
			if (cause instanceof pg.DatabaseError && (cause.severity === "FATAL" || cause.severity === "PANIC"))
				lost.add(client);
			if (!(cause instanceof pg.DatabaseError) && lost.has(client))
				throw new PostgresConnectionFailure("lost", /** @type {StorageFailureCause} */ (cause));
			if (cause instanceof pg.DatabaseError && (cause.code === "42501" || cause.code === "3F000"))
				throw Object.defineProperty(
					missingPrivilege(cause, connection.user ?? "", schema, connection.database ?? "", sql),
					"cause",
					{ value: cause, configurable: true },
				);
			throw cause;
		} finally {
			clearTimeout(timer);
		}
	};

	/**
	 * @param {PoolClient} client
	 * @param {string} sql
	 * @param {readonly SqliteValue[]} params
	 */
	const statement = (client, sql, params) => {
		const text = numberPlaceholders(physicalIdentifiers(sql));
		const name = preparedName(client, text);
		const query = { text, values: [...params], rowMode: /** @type {const} */ ("array") };
		if (name === undefined) return client.query(query);
		// Whether this connection's server had already confirmed the statement, read before the answer can change it.
		const confirmed = parsedOn(client, name);
		return client.query({ ...query, name }).catch((/** @type {unknown} */ cause) => {
			forgetPrepared(client, cause, confirmed);
			throw cause;
		});
	};

	/** Whether this database still gives statements names: until a server or pooler loses or confuses them. */
	let preparing = maxPreparedStatements > 0;
	/** How often each statement not yet named was sent. */
	const uses = new Map();
	/** The name of each statement that has one: from its text alone, so it means the same statement in every process. */
	const names = new Map();
	/** @type {WeakMap<PoolClient, Set<string>>} The names each connection was asked to prepare. */
	const preparedOn = new WeakMap();
	/** Whether a server or pooler lost or confused a named statement, which keeps every statement unnamed from then on. */
	let refused = false;
	// Unless configured, prepared statements follow what the endpoint turns out to be once the first connection tells:
	// on behind a PgBouncer that keeps them, off behind one that does not. Pools an earlier release's adapter opened
	// tell nothing, and leave the default.
	if (configuredPrepared === undefined)
		void shared.pooler?.decided.then((kept) => {
			if (kept === undefined) return;
			maxPreparedStatements = kept ? DEFAULT_MAX_PREPARED_STATEMENTS : 0;
			preparing = kept && !refused;
		});

	/**
	 * The name `text` is sent under on `client`, or undefined to send it unnamed. A named statement is parsed and planned
	 * once per connection: pg sends its Parse with the first execution on that connection, in the same round trip, and
	 * only Bind and Execute after. A statement is named from its second use in this process, and a connection prepares at
	 * most `maxPreparedStatements`, so one-off statements never fill it.
	 * @param {PoolClient} client
	 * @param {string} text
	 */
	const preparedName = (client, text) => {
		if (!preparing || !PREPARABLE.test(text)) return undefined;
		let name = names.get(text);
		if (name === undefined) {
			const used = (uses.get(text) ?? 0) + 1;
			if (used < PREPARE_AFTER_USES || names.size >= STATEMENTS_TRACKED) {
				if (uses.size >= STATEMENTS_TRACKED) uses.clear();
				uses.set(text, used);
				return undefined;
			}
			uses.delete(text);
			name = `atomic_${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
			names.set(text, name);
		}
		let prepared = preparedOn.get(client);
		if (prepared === undefined) preparedOn.set(client, (prepared = new Set()));
		if (!prepared.has(name)) {
			if (prepared.size >= maxPreparedStatements) return undefined;
			prepared.add(name);
		}
		return name;
	};

	/**
	 * Whether the server answered `client`'s Parse of `name`, as pg records it.
	 * @param {PoolClient} client
	 * @param {string} name
	 */
	const parsedOn = (client, name) =>
		/** @type {{ connection: { parsedStatements: Record<string, string> } }} */ (
			/** @type {unknown} */ (client)
		).connection.parsedStatements[name] !== undefined;

	/**
	 * After a named statement failed because the server no longer has it, already has it, or planned it for tables a
	 * migration has since changed, closes `client`, which drops every statement it prepared. A statement the server had
	 * confirmed and then no longer has, or a name it has without being asked, means a pooler hands this connection's
	 * statements to other server connections (PgBouncer before 1.21, or with `max_prepared_statements` 0), so this
	 * database sends every statement unnamed from then on. A missing name the server never confirmed is only a sibling
	 * of a Parse that failed in the same pipeline. The failed call applied nothing and may run again.
	 * @param {PoolClient} client
	 * @param {unknown} cause
	 * @param {boolean} confirmed Whether the server had answered this connection's Parse of the statement.
	 */
	const forgetPrepared = (client, cause, confirmed) => {
		if (!(cause instanceof pg.DatabaseError)) return;
		if ((cause.code === "26000" && confirmed) || cause.code === "42P05") {
			preparing = false;
			refused = true;
		}
		else if (cause.code !== "26000" && !isStalePlan(cause)) return;
		lost.add(client);
	};

	/**
	 * Creates `schema` when it does not exist yet and `sql` creates something, before `sql` runs: on a connection of its
	 * own, which commits at once, so the transaction `sql` runs in finds it. Opening a database, `atomic storage status`
	 * and `atomic storage join` create nothing; the first store that sets up its tables creates the schema too, under an
	 * advisory lock, so hosts that start together on a new database create it once.
	 * A database resolved to `public` because an earlier release's tables were there is checked again before each
	 * statement that creates something: once `atomic storage migrate` has moved them, this process must not create
	 * Atomic's tables in `public` again, apart from the moved ones (#5218).
	 * @param {PoolClient} client
	 * @param {string} sql
	 */
	const schemaFor = (client, sql) => {
		if ((schemaReady && !legacy) || !/(?:^|;)\s*CREATE\s/i.test(sql)) return undefined;
		// A statement that names `public` itself, as `atomic storage migrate` does for the fences it leaves there, or
		// that creates a schema, is meant for where it says.
		const checkMove = legacy && !/\bpublic\./i.test(sql) && !/^\s*CREATE\s+SCHEMA\b/i.test(sql);
		return checkMove || !schemaReady ? prepareSchema(client, checkMove) : undefined;
	};

	/**
	 * @param {PoolClient} client
	 * @param {boolean} checkMove
	 */
	const prepareSchema = async (client, checkMove) => {
		if (checkMove) {
			const moved = await watched(
				client,
				() =>
					client.query(
						"SELECT count(*)::int AS ledgers FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname ~ 'atomic_migrations$'",
						[DEFAULT_SCHEMA],
					),
				clientTimeoutMs,
			);
			if (Number(moved.rows[0]?.ledgers) > 0)
				throw new StorageError(
					`This database was upgraded since this process started: \`atomic storage migrate\` moved Atomic's tables from schema public to schema ${DEFAULT_SCHEMA}. Restart this process (#5218)`,
				);
		}
		if (schemaReady) return;
		creatingSchema ??= (async () => {
			const client = new ClosingClient({
				...connection,
				...streamOption(opener),
				...(password === undefined ? {} : { password }),
				connectionTimeoutMillis: connectTimeoutMs,
				application_name: "atomic",
			});
			client.on("error", () => {});
			try {
				await new Promise((resolve, reject) =>
					client.connect((/** @type {Error | undefined} */ error) => (error ? reject(error) : resolve(undefined))),
				);
			} catch (cause) {
				throw connectFailure(cause);
			}
			try {
				await watched(
					/** @type {PoolClient} */ (/** @type {unknown} */ (client)),
					() =>
						client.query(
							`BEGIN; ${setTimeoutSql}; SELECT pg_advisory_xact_lock(${lockKey(`schema:${schema}`)}); CREATE SCHEMA IF NOT EXISTS "${schema}"; COMMIT`,
						),
					clientTimeoutMs,
				);
				schemaReady = true;
			} finally {
				await client.end().catch(() => {});
			}
		})().finally(() => {
			creatingSchema = undefined;
		});
		await creatingSchema;
	};

	/**
	 * @param {import("pg").QueryResult<SqliteValue[]>} result
	 * @returns {SqliteDriverResult}
	 */
	const driverResult = (result) => ({
		columns: result.fields.map((field) => field.name),
		rows: result.rows,
		changes: result.rowCount ?? 0,
	});

	/**
	 * @param {PoolClient} client
	 * @param {string} sql
	 * @param {readonly SqliteValue[]} params
	 * @param {number} timeoutMs
	 * @returns {Promise<SqliteDriverResult>}
	 */
	const sendStatement = async (client, sql, params, timeoutMs) => {
		return driverResult(await watched(client, () => statement(client, sql, params), timeoutMs, sql));
	};

	/**
	 * @param {PoolClient} client
	 * @param {string} sql
	 * @param {number} timeoutMs
	 */
	const sendScript = async (client, sql, timeoutMs) => {
		if (isPragma(sql)) return;
		await watched(client, () => client.query(physicalIdentifiers(sql)), timeoutMs, sql);
	};

	/**
	 * Runs `body` on a connection of `from` outside a transaction, and returns the connection, or closes it when it broke.
	 * @template T
	 * @param {import("pg").Pool} from
	 * @param {(client: PoolClient) => Promise<T>} body
	 */
	const autocommit = async (from, body) => {
		const client = await connect(from);
		try {
			return await body(client);
		} finally {
			client.release(lost.has(client));
		}
	};
	const clientTimeoutMs = statementTimeoutMs + CLIENT_TIMEOUT_GRACE_MS;
	const setTimeoutSql = `SET LOCAL statement_timeout = ${statementTimeoutMs}`;

	/**
	 * Runs `bounded`, which runs a statement in a transaction with the statement timeout, or, when the statement cannot
	 * run in a transaction block, `unbounded`, which runs it alone: the failed attempt rolled back without applying it.
	 * The timeout is set in a transaction rather than on the connection, so a transaction-mode pooler can serve it.
	 * @template T
	 * @param {() => Promise<T>} bounded
	 * @param {() => Promise<T>} unbounded
	 */
	const withTimeout = async (bounded, unbounded) => {
		try {
			return await bounded();
		} catch (error) {
			// SQLSTATE active_sql_transaction: the statement, such as `VACUUM`, cannot run inside a transaction block.
			if (!(error instanceof pg.DatabaseError) || error.code !== "25001") throw error;
			return unbounded();
		}
	};

	/**
	 * Runs `body`, a statement that cannot run in a transaction block, in the schema: the connection's `search_path` is
	 * set for it, and reset after.
	 * @template T
	 * @param {PoolClient} client
	 * @param {() => Promise<T>} body
	 */
	const inSearchPath = async (client, body) => {
		await watched(client, () => client.query(`SET search_path TO "${schema}"`), clientTimeoutMs);
		try {
			return await body();
		} finally {
			await watched(client, () => client.query("RESET search_path"), clientTimeoutMs).catch(() => lost.add(client));
		}
	};

	/**
	 * Runs one statement on `client` in a transaction of its own, which the server cancels at the statement timeout. The
	 * pipelined connection writes the `BEGIN`, the statement and the `COMMIT` together, so this costs one round trip like
	 * the statement alone. A statement that fails aborts the transaction, which the `COMMIT` then rolls back.
	 * @param {PoolClient} client
	 * @param {string} sql
	 * @param {readonly SqliteValue[]} params
	 */
	const executeAutocommit = (client, sql, params) =>
		withTimeout(
			async () => {
				await schemaFor(client, sql);
				const result = await watched(
					client,
					async () => {
						// Every answer is awaited, so none is left to fail unheard; the first failure is the call's.
						const answers = await Promise.allSettled([
							client.query(`BEGIN; ${setTimeoutSql}; ${searchPathSql()}`),
							statement(client, sql, params),
							client.query("COMMIT"),
						]);
						for (const answer of answers) if (answer.status === "rejected") throw answer.reason;
						return /** @type {PromiseFulfilledResult<import("pg").QueryResult<SqliteValue[]>>} */ (answers[1]).value;
					},
					clientTimeoutMs,
					sql,
				);
				return driverResult(result);
			},
			() => inSearchPath(client, async () => {
				await schemaFor(client, sql);
				return sendStatement(client, sql, params, clientTimeoutMs);
			}),
		);

	/**
	 * Runs the statements of `sql` on `client`. Postgres runs several statements sent together in one transaction, which
	 * the timeout set first joins; the server cancels each statement at the statement timeout.
	 * @param {PoolClient} client
	 * @param {string} sql
	 */
	const executeMultipleAutocommit = async (client, sql) => {
		if (isPragma(sql)) return;
		const executeScript = async (/** @type {string} */ text) => {
			await schemaFor(client, text);
			await sendScript(client, text, clientTimeoutMs);
		};
		await withTimeout(
			() => executeScript(`${setTimeoutSql}; ${searchPathSql()}; ${sql}`),
			() => inSearchPath(client, () => executeScript(sql)),
		);
	};

	const { listenPassword } = shared;
	// One listening connection for every database that shares the pool: each names its channels itself.
	const listener = (shared.listener ??= createPostgresListener({
		async connect() {
			const client = new ClosingClient({
				...listenConnection,
				...streamOption(listenOpener),
				...(listenPassword === undefined ? {} : { password: listenPassword }),
				connectionTimeoutMillis: connectTimeoutMs,
				// A short keepalive notices a peer that vanished without a reset sooner than the system's two hours; the
				// listener's own health probe catches the rest.
				keepAlive: true,
				keepAliveInitialDelayMillis: LISTEN_KEEPALIVE_IDLE_MS,
				application_name: "atomic-listen",
			});
			// An error before the listener attaches its own handler must not end the process unheard.
			client.on("error", () => {});
			await new Promise((resolve, reject) =>
				client.connect((/** @type {Error | undefined} */ error) => (error ? reject(error) : resolve(undefined))),
			);
			return client;
		},
		send: async (channel, payload) => {
			await autocommit(pool, (client) => client.query("SELECT pg_notify($1, $2)", [channel, payload]));
		},
		channelName: (channel) => channel,
	}));
	/** This database's subscriptions, closed when it closes: the listening connection may outlive it. */
	/** @type {Set<{ close(): void }>} */
	const subscriptions = new Set();
	/**
	 * Each schema's wake-ups are its own; `public` keeps the channels earlier releases listen on.
	 * @param {string} channel
	 */
	const channelName = (channel) =>
		postgresDialect.identifier(schema === LEGACY_SCHEMA ? channel : `${schema}_${channel}`);
	/** @type {import("@bastani/atomic/storage").StorageNotifications} */
	const notifications = {
		notify: (channel, payload) => listener.notify(channelName(channel), payload),
		listen(channel, onEvent) {
			const subscription = listener.listen(channelName(channel), onEvent);
			const tracked = {
				close() {
					subscriptions.delete(tracked);
					subscription.close();
				},
			};
			subscriptions.add(tracked);
			return tracked;
		},
		state: () => listener.state(),
	};
	/**
	 * Gives up this database's share of the connections: the last database to close closes the listening connection,
	 * then the pools.
	 */
	const release = async () => {
		for (const subscription of [...subscriptions]) subscription.close();
		if (--shared.references > 0) return;
		if (identity !== undefined && sharing.get(identity) === shared) sharing.delete(identity);
		await listener.close();
		const reader = shared.reader;
		shared.reader = undefined;
		await Promise.all([pool.end(), reader?.pool.end()]);
	};

	/**
	 * Which database and schema this one reaches (#6560): the server, the database, the role, the schema its statements
	 * run in, and how connections reach the server. Every handle that answers the same reads and writes the same tables.
	 */
	const databaseIdentity = () => {
		const { host, port } = endpointOf(connection);
		return JSON.stringify([
			"postgres",
			host,
			port,
			connection.database ?? process.env.PGDATABASE ?? null,
			connection.user ?? process.env.PGUSER ?? null,
			schema,
			options.proxy ?? null,
			options.socket === undefined ? null : socketFactoryId(options.socket),
		]);
	};

	/**
	 * The driver of the calls that run on connections of `from`.
	 * @param {import("pg").Pool} from
	 * @returns {Omit<import("@bastani/atomic/storage").SqliteDriver, "close">}
	 */
	const driverOn = (from) => ({
		descriptor: { adapter: "postgres", location: connectionString },
		databaseIdentity,
		redact: (text) => {
			let redacted = text;
			for (const secret of [...passwords].sort((first, second) => second.length - first.length))
				if (secret !== "") redacted = redacted.replaceAll(secret, "[redacted]");
			return redacted;
		},
		transientFailure: transientFailureOf(pg.DatabaseError),
		// Postgres's largest field is 1 GB less one byte (#4954).
		payloadLimits: { value: 1_073_741_823 },
		execute: (sql, params) => autocommit(from, (client) => executeAutocommit(client, sql, params)),
		executeMultiple: (sql) => autocommit(from, (client) => executeMultipleAutocommit(client, sql)),
		concurrentTransactions: true,
		// The connection is pipelined: a transaction's statements go out without waiting for the answers before them.
		pipelinedTransactions: true,
		dialect: postgresDialect,
		// The facade always says how the transaction excludes other writers.
		async beginTransaction(/** @type {import("@bastani/atomic/storage").SqliteDriverTransactionOptions} */ begin) {
			const { concurrency } = begin;
			const lockWaitMs = positiveInteger("lockWaitMs", begin.lockWaitMs, statementTimeoutMs);
			// A serial transaction takes its domain's advisory lock, which makes it the only writer of that domain as
			// `BEGIN IMMEDIATE` makes a SQLite transaction the only writer of its file; a fenced one locks its rows itself.
			// The locks nest: one without a domain holds the whole database's lock, and one with a domain holds that lock
			// shared, so it waits for and excludes whole-database transactions, but not those of other domains. The locks,
			// and every row lock after them, wait at most `lockWaitMs`; the statement timeout starts after them.
			// With `lockIfLeadingFinds`, a domain's transaction takes the same locks in its first leading statement instead, and
			// only for the row that read returns, so one whose read finds nothing takes no lock (#6560).
			const lockedDomain =
				begin.lockIfLeadingFinds === true &&
				begin.readOnly !== true &&
				concurrency.kind === "serial" &&
				(begin.leading?.length ?? 0) > 0
					? concurrency.domain
					: undefined;
			const lock = begin.readOnly === true || lockedDomain !== undefined ? "" :
				concurrency.kind !== "serial"
					? concurrency.excludesSerial === true
						? `SELECT pg_advisory_xact_lock_shared(${lockKey(inSchema(DATABASE_LOCK_SCOPE))}); `
						: ""
					: concurrency.domain === undefined
						? `SELECT pg_advisory_xact_lock(${lockKey(inSchema(DATABASE_LOCK_SCOPE))}); `
						: `SELECT pg_advisory_xact_lock_shared(${lockKey(inSchema(DATABASE_LOCK_SCOPE))}), pg_advisory_xact_lock(${lockKey(inSchema(concurrency.domain))}); `;
			const client = await connect(from);
			/** @type {Promise<void> | undefined} */
			let pendingSubmission;
			/**
			 * @template T
			 * @param {string} sql
			 * @param {() => Promise<T>} send
			 * @returns {Promise<T>}
			 */
			const submit = (sql, send) => {
				const checked =
					pendingSubmission === undefined
						? schemaFor(client, sql)
						: pendingSubmission.then(() => schemaFor(client, sql));
				if (checked === undefined) return send();
				const sent = checked.then(() => ({ answer: send() }));
				const submitted = sent.then(() => {
					if (pendingSubmission === submitted) pendingSubmission = undefined;
				});
				submitted.catch(() => {});
				pendingSubmission = submitted;
				return sent.then(({ answer }) => answer);
			};
			/**
			 * Sends `sql`, a read, so that each row it returns takes the database's lock shared and `domain`'s lock, as a
			 * domain's transaction takes them with its start; a read that returns no row takes neither. The lock keys go as
			 * parameters, so the text is the same for every domain. The answer is the read's own columns.
			 * @param {string} sql
			 * @param {readonly SqliteValue[]} params
			 * @param {string} domain
			 * @returns {Promise<SqliteDriverResult>}
			 */
			const sendLocking = (sql, params, domain) => {
				const locking = `SELECT found.*, pg_advisory_xact_lock_shared(hashtextextended(?, 0)) AS atomic_database_lock,
					pg_advisory_xact_lock(hashtextextended(?, 0)) AS atomic_domain_lock FROM (${sql}) AS found`;
				const values = [inSchema(DATABASE_LOCK_SCOPE), inSchema(domain), ...params];
				return submit(locking, () => sendStatement(client, locking, values, lockWaitMs + clientTimeoutMs)).then(
					(result) => ({
						...result,
						columns: result.columns.slice(0, -2),
						rows: result.rows.map((row) => Array.prototype.slice.call(row, 0, -2)),
					}),
				);
			};
			/** @type {{ sql: string, params: readonly SqliteValue[], result: Promise<SqliteDriverResult>, failure?: unknown }[]} */
			const lead = [];
			/** Whether the connection went back to the pool, which a read-only transaction's commit does as it is sent. */
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				client.release(lost.has(client));
			};
			/**
			 * Sends the `COMMIT`. A read-only transaction's connection goes back to the pool once its `COMMIT` is written, not
			 * once it is answered: the connection is pipelined, so the next transaction's `BEGIN` goes out behind the `COMMIT`
			 * and the server runs it after. A read that follows at once then reuses this connection instead of opening another,
			 * whose handshakes cost several round trips (#6560). A commit that fails ended nothing this transaction wrote.
			 * @param {number} timeoutMs
			 */
			const sendCommit = (timeoutMs) =>
				submit("", () => {
					const answer = watched(client, () => client.query("COMMIT"), timeoutMs);
					if (begin.readOnly === true) release();
					return answer;
				});
			/**
			 * With `leadingOnly`, the `COMMIT`, sent right behind the leading statements: the transaction is one round trip.
			 * Its timer starts with them, so it waits as long as they may wait for their locks.
			 * @type {Promise<import("pg").QueryResult> | undefined}
			 */
			let committed;
			try {
				// One round trip, with nothing set outside the transaction, so a transaction-mode pooler can serve it. The
				// transaction's leading reads go out behind it on the pipelined connection, so the server runs them once the
				// locks are held, and the callback starts once all are answered: the reads cost no round trip of their own.
				const opened = watched(
					client,
					() =>
						client.query(
							`${begin.readOnly === true ? "BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ" : "BEGIN"}; SET LOCAL lock_timeout = ${lockWaitMs}; ${lock}SET LOCAL statement_timeout = ${statementTimeoutMs}; ${searchPathSql()}`,
						),
					lockWaitMs + clientTimeoutMs,
				);
				for (const { sql, params } of begin.leading ?? []) {
					const result =
						lockedDomain !== undefined && lead.length === 0
							? sendLocking(sql, params, lockedDomain)
							: submit(sql, () => sendStatement(client, sql, params, lockWaitMs + clientTimeoutMs));
					result.catch(() => {});
					lead.push({ sql, params, result });
				}
				if (begin.leadingOnly === true && lead.length > 0) {
					committed = sendCommit(lockWaitMs + clientTimeoutMs);
					committed.catch(() => {});
				}
				await opened;
				const outcomes = await Promise.allSettled(lead.map(({ result }) => result));
				outcomes.forEach((outcome, index) => {
					if (outcome.status === "rejected") lead[index].failure = outcome.reason ?? new Error("leading read failed");
				});
			} catch (error) {
				// The transaction may be open, so the connection is closed rather than reused.
				client.release(true);
				throw error;
			}
			/**
			 * Ends the lead, and says why the call that ended it fails without being sent: a leading read the callback did
			 * not make failed, which aborted the transaction. Calls go out in the order they are made, so this decides at once.
			 */
			const endLead = () => lead.splice(0).find((read) => "failure" in read)?.failure;
			/** A call made after the `COMMIT` went out with the leading statements: it would run outside the transaction. */
			const afterCommit = () =>
				Promise.reject(new StorageError("The transaction committed with its leading statements; it takes no more calls"));
			return {
				execute: (sql, params) => {
					const next = lead[0];
					if (next !== undefined && next.sql === sql && sameParams(next.params, params)) {
						lead.shift();
						return next.result;
					}
					const failure = endLead();
					if (committed !== undefined) return afterCommit();
					return failure === undefined
						? submit(sql, () => sendStatement(client, sql, params, clientTimeoutMs))
						: Promise.reject(failure);
				},
				executeMultiple: (sql) => {
					const failure = endLead();
					if (committed !== undefined) return afterCommit();
					return failure === undefined
						? submit(sql, () => sendScript(client, sql, clientTimeoutMs))
						: Promise.reject(failure);
				},
				async commit() {
					// A leading read the callback never made failed and aborted the transaction: nothing is sent, and its own
					// failure, not a bare rollback, says whether the transaction may run again. With `leadingOnly` the `COMMIT`
					// went out already and ends it.
					const failure = endLead();
					if (failure !== undefined) throw failure;
					const result = await (committed ?? sendCommit(clientTimeoutMs));
					// A transaction a failed statement aborted ends in a rollback when committed, without an error.
					if (result.command === "ROLLBACK")
						throw new StorageError("The transaction was rolled back because a statement in it failed");
				},
				async rollback() {
					// The server rolled back the transaction of a connection that broke. One that went back to the pool is another
					// call's now, and its `COMMIT`, answered or not, ended the read-only transaction. A `COMMIT` sent with the
					// leading statements ended it too, as a rollback when one of them failed; one still unanswered is waited for.
					if (committed !== undefined) {
						await committed.catch(() => {});
						return;
					}
					if (released || lost.has(client)) return;
					try {
						await watched(client, () => client.query("ROLLBACK"), clientTimeoutMs);
					} catch (error) {
						// The transaction may still be open, so the connection is closed rather than reused.
						lost.add(client);
						throw error;
					}
				},
				// The facade closes a transaction once, after its commit or rollback.
				close: release,
			};
		},
	});

	const database = createSqliteDatabase({
		...driverOn(pool),
		// Readers have a pool of their own, so their calls never wait for connections the writers' transactions hold. Every
		// reader of the databases that share the pool shares it, and the last reader to close closes it (#6560). With
		// `readerMaxConnections: 0` there is none, and reads share the main pool.
		...(readerMaxConnections === 0
			? {}
			: {
					openReader: () => {
						shared.reader ??= { pool: shared.openReaderPool(), references: 0 };
						const reader = shared.reader;
						reader.references++;
						let closed = false;
						return {
							...driverOn(reader.pool),
							close: async () => {
								if (closed) return;
								closed = true;
								// The readers' pool ended already when the last database closed before its readers.
								if (--reader.references > 0 || reader.pool.ending) return;
								if (shared.reader === reader) shared.reader = undefined;
								await reader.pool.end();
							},
						};
					},
				}),
		notifications,
		takeOpenedCatalog: () => {
			const catalog = openedCatalog;
			openedCatalog = undefined;
			return catalog;
		},
		close: release,
	});
	try {
		// The server's version, and which schema holds Atomic's tables, read in one round trip without creating anything
		// (#5218, #6560). The query runs on any server version, so an older server is refused by its answer.
		const probe = {
			sql: `SELECT current_setting('server_version_num') AS version,
				(SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname = ?) AS present,
				(SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname = ?) AS preferred,
				(SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
					WHERE n.nspname = ? AND c.relkind = 'r' AND c.relname ~ ?
					AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT LIKE ?) AS legacy`,
			params: [schema, DEFAULT_SCHEMA, LEGACY_SCHEMA, LEGACY_MARKERS, `${MOVED_FENCE_COMMENT}%`],
		};
		/** @type {import("@bastani/atomic/storage").SqliteRow | undefined} */
		let found;
		// The schema's catalog and the ledger's versions go out with it, read as the schema checks of the first store open
		// read them, which then reads nothing (`takeOpenedCatalog`): an open costs one round trip less (#6560). They are
		// read in the schema the open expects, and kept only when it is the one the answer chose.
		await database.transaction(
			async (transaction) => {
				openedCatalog = undefined;
				found = await transaction.get(probe.sql, ...probe.params);
				if (options.schema === undefined && Number(found?.preferred) === 0 && Number(found?.legacy) > 0) return;
				try {
					const rows = await transaction.all(OPENED_CATALOG_SQL);
					const ledger = rows.some(
						(row) => row.kind === "relation" && row.name === OPENED_LEDGER && TABLE_KINDS.has(String(row.detail)),
					);
					// Taken even where the ledger does not exist and the read failed, so the transaction ends with its commit,
					// sent at once, rather than with a rollback after it.
					const versions = await transaction.all(OPENED_VERSIONS_SQL).catch((error) => {
						if (ledger) throw error;
						return undefined;
					});
					openedCatalog = { ledger: OPENED_LEDGER, rows, versions };
				} catch {
					// The first store open reads them itself, as it would without them.
				}
			},
			{
				readOnly: true,
				retryTransientFailures: true,
				leading: [probe, { sql: OPENED_CATALOG_SQL, params: [] }, { sql: OPENED_VERSIONS_SQL, params: [] }],
			},
		);
		const version = Number(found?.version);
		if (!(version >= MINIMUM_SERVER_VERSION))
			throw new StorageUnavailableError(
				database.descriptor,
				new StorageError(`PostgreSQL server version ${version} is older than 14`),
				"PostgreSQL 14 or newer is required",
			);
		if (options.schema === undefined && Number(found?.preferred) === 0 && Number(found?.legacy) > 0)
		{
			schema = LEGACY_SCHEMA;
			legacy = true;
		}
		else schemaReady = Number(found?.present) > 0;
		return database;
	} catch (caught) {
		// A proxy that did not open the tunnel is named, with the server it was asked for, in the failure itself (#5473):
		// a worker that relays only the message keeps the reason. The message names the proxy without its credentials.
		const error =
			tunnelFailure === undefined
				? caught
				: new StorageUnavailableError(database.descriptor, /** @type {Error} */ (caught), tunnelFailure.message);
		await database
			.close()
			.catch((cleanupCause) =>
				Object.defineProperty(/** @type {Error} */ (error), "cleanupCause", { value: cleanupCause, configurable: true }),
			);
		throw error;
	}
}

/** @satisfies {import("@bastani/atomic/storage").StorageAdapterModule} */
const adapter = {
	atomicStorageAdapter: 1,
	liveSecrets: /** @type {readonly string[]} */ (["password"]),
	/**
	 * @param {import("@bastani/atomic/storage").AdapterOptions} options
	 * @param {import("@bastani/atomic/storage").StorageOpenContext} context
	 */
	openDatabase(options, context) {
		if (typeof options.url !== "string" || options.url === "")
			return Promise.reject(configError("url", "unsupported-url", "Use a postgres:// or postgresql:// URL"));
		const { secret } = context;
		// Cloud IAM auth issues its own password; a selection carries no password secret for it.
		const cloud = typeof options.auth === "string" && options.auth !== "password";
		return openPostgresDatabase({
			url: options.url,
			...(cloud
				? {}
				: secret !== undefined
					? { password: () => secret("password") }
					: typeof options.password === "string"
						? { password: options.password }
						: {}),
			...(typeof options.auth === "string" ? { auth: /** @type {PostgresAuth} */ (options.auth) } : {}),
			...(typeof options.maxConnections === "number" ? { maxConnections: options.maxConnections } : {}),
			...(typeof options.statementTimeoutMs === "number" ? { statementTimeoutMs: options.statementTimeoutMs } : {}),
			...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: /** @type {number} */ (options.idleTimeoutMs) }),
			...(options.readerMaxConnections === undefined
				? {}
				: { readerMaxConnections: /** @type {number} */ (options.readerMaxConnections) }),
			...(options.connectTimeoutMs === undefined
				? {}
				: { connectTimeoutMs: /** @type {number} */ (options.connectTimeoutMs) }),
			...(options.keepAliveIdleMs === undefined
				? {}
				: { keepAliveIdleMs: /** @type {number} */ (options.keepAliveIdleMs) }),
			...(options.maxPreparedStatements === undefined
				? {}
				: { maxPreparedStatements: /** @type {number} */ (options.maxPreparedStatements) }),
			...(typeof options.listenUrl === "string" ? { listenUrl: options.listenUrl } : {}),
			...(options.schema === undefined ? {} : { schema: /** @type {string} */ (options.schema) }),
			// A value that is not a string reaches the option's check, which names it.
			...(options.proxy === undefined ? {} : { proxy: /** @type {string} */ (options.proxy) }),
			// A cloud SDK `atomic install` put in the user packages, for an adapter installed from a local path (#5218).
			...(cloud ? { sdkSearchPaths: [join(context.agentDir, "npm")] } : {}),
		});
	},
};
export default adapter;
