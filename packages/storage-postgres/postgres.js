// @ts-check
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
/** How long opening a connection, or waiting for a free one, may take. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long the listening connection stays idle before TCP keepalive probes start. */
const LISTEN_KEEPALIVE_IDLE_MS = 10_000;
/** An idle connection is closed after this long. */
const IDLE_TIMEOUT_MS = 10_000;
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
 * The permanent failure a connection refused by TLS verification is (#5218), with the reason and the fix: a host name
 * the certificate names, or the CA in `sslrootcert`. Undefined for any other failure, and for an https proxy's own
 * certificate, which its tunnel failure names with the proxy's fix (#6112).
 * @param {unknown} cause
 * @returns {StorageError | undefined}
 */
function tlsVerificationFailure(cause) {
	/** @type {unknown} */
	let current = cause;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (current instanceof ProxyTunnelError) return undefined;
		const { code, message } = /** @type {{ code?: unknown, message?: unknown }} */ (current);
		if (typeof code === "string" && isRefusedCertificate(code, typeof message === "string" ? message.trim() : "")) {
			const fix =
				code === "ERR_TLS_CERT_ALTNAME_INVALID" || code === "HOSTNAME_MISMATCH"
					? "Connect by a host name the certificate names, or, for an address it does not name such as a private IP address, add sslmode=verify-ca with sslrootcert=<CA file> to the URL"
					: "Add sslrootcert=<CA file> with the server's CA to the URL; see TLS in docs/storage.md";
			return new StorageError(
				`The server's TLS certificate was not accepted (${code}: ${/** @type {Error} */ (current).message}). ${fix}. It is not retried`,
				{ cause: /** @type {Error} */ (cause) },
			);
		}
		current = /** @type {{ cause?: unknown }} */ (current).cause;
	}
	return undefined;
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
	return /^\s*PRAGMA\b[^;]*;?\s*$/i.test(sql);
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
]);

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
			if (current instanceof DatabaseError) return TRANSIENT_SQLSTATES.get(current.code ?? "");
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

	/** The cloud token providers of the pool's and the listening connection's hosts. */
	/** @type {Set<{ invalidate(): void }>} */
	const tokenProviders = new Set();
	/** Every password the pool was given, so the redactor can remove them from failures. */
	const passwords = new Set(typeof options.password === "string" ? [options.password] : []);
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
					const value = typeof source === "string" ? source : await source();
					if (typeof value !== "string" || value === "")
						throw configError("password", "empty-token", "The password source gave an empty password");
					passwords.add(value);
					return value;
				};
	};
	const password = passwordFor(connection);

	// pg leaves the socket of a connection that failed to start open, for instance when the password source failed while
	// the server waited for the password; the server keeps that half-started backend until its authentication timeout,
	// and meanwhile it holds up statements that wait for every backend, such as `DROP DATABASE`.
	class ClosingClient extends pg.Client {
		/** @param {(error: Error | undefined) => void} callback */
		// @ts-expect-error pg-pool always passes a callback, so the promise form is left out.
		connect(callback) {
			super.connect((/** @type {Error | undefined} */ error) => {
				if (error) this.connection.stream.destroy();
				callback(error);
			});
		}
	}
	const pool = new pg.Pool({
		Client: /** @type {typeof pg.Client} */ (/** @type {unknown} */ (ClosingClient)),
		...connection,
		...streamOption(opener),
		...(password === undefined ? {} : { password }),
		max: maxConnections,
		connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
		idleTimeoutMillis: IDLE_TIMEOUT_MS,
		keepAlive: true,
		// Queries are written without waiting for the answer to the one before, so a statement outside a transaction
		// sends its `BEGIN` and `COMMIT` in the same round trip; each query still ends with its own sync.
		pipeline: true,
		application_name: "atomic",
		types: sqliteTypes(pg.types),
	});
	/** Connections that broke: they are closed, never returned to the pool. */
	const lost = new WeakSet();
	// An idle connection that breaks emits `error` on the pool, which would end the process unheard.
	pool.on("error", (_error, client) => lost.add(client));
	pool.on("connect", (client) => client.on("error", () => lost.add(client)));

	/**
	 * The proxy's refusal or failure the latest attempt to connect ended in, kept here because the facade passes on a
	 * redacted copy of a failure, which is no longer a `ProxyTunnelError` (#5473). Cleared by a connection that opens.
	 * @type {ProxyTunnelError | undefined}
	 */
	let tunnelFailure;
	/** @returns {Promise<PoolClient>} */
	const connect = async () => {
		try {
			const client = await pool.connect();
			tunnelFailure = undefined;
			return client;
		} catch (cause) {
			tunnelFailure = proxyTunnelFailure(cause);
			// A cloud token the server refused (28P01, or Azure's 28000 for a malformed one) is dropped, and a fresh one
			// tried once: a clock that runs behind can reuse a cached token past its expiry (#5218).
			if (tokenProviders.size > 0 && cause instanceof pg.DatabaseError && REFUSED_TOKEN_SQLSTATES.has(cause.code ?? "")) {
				for (const provider of tokenProviders) provider.invalidate();
				try {
					return await pool.connect();
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
	const statement = (client, sql, params) =>
		client.query({ text: numberPlaceholders(physicalIdentifiers(sql)), values: [...params], rowMode: "array" });

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
	const schemaFor = async (client, sql) => {
		if (!/(?:^|;)\s*CREATE\s/i.test(sql)) return;
		// A statement that names `public` itself, as `atomic storage migrate` does for the fences it leaves there, or
		// that creates a schema, is meant for where it says.
		if (legacy && !/\bpublic\./i.test(sql) && !/^\s*CREATE\s+SCHEMA\b/i.test(sql)) {
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
				connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
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
	const execute = async (client, sql, params, timeoutMs) => {
		await schemaFor(client, sql);
		return driverResult(await watched(client, () => statement(client, sql, params), timeoutMs, sql));
	};

	/**
	 * @param {PoolClient} client
	 * @param {string} sql
	 * @param {number} timeoutMs
	 */
	const executeMultiple = async (client, sql, timeoutMs) => {
		if (isPragma(sql)) return;
		await schemaFor(client, sql);
		await watched(client, () => client.query(physicalIdentifiers(sql)), timeoutMs, sql);
	};

	/**
	 * Runs `body` on a pooled connection outside a transaction, and returns the connection, or closes it when it broke.
	 * @template T
	 * @param {(client: PoolClient) => Promise<T>} body
	 */
	const autocommit = async (body) => {
		const client = await connect();
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
			() => inSearchPath(client, () => execute(client, sql, params, clientTimeoutMs)),
		);

	/**
	 * Runs the statements of `sql` on `client`. Postgres runs several statements sent together in one transaction, which
	 * the timeout set first joins; the server cancels each statement at the statement timeout.
	 * @param {PoolClient} client
	 * @param {string} sql
	 */
	const executeMultipleAutocommit = async (client, sql) => {
		if (isPragma(sql)) return;
		await withTimeout(
			() => executeMultiple(client, `${setTimeoutSql}; ${searchPathSql()}; ${sql}`, clientTimeoutMs),
			() => inSearchPath(client, () => executeMultiple(client, sql, clientTimeoutMs)),
		);
	};

	const listenPassword = passwordFor(listenConnection);
	const listener = createPostgresListener({
		async connect() {
			const client = new ClosingClient({
				...listenConnection,
				...streamOption(listenOpener),
				...(listenPassword === undefined ? {} : { password: listenPassword }),
				connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
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
			await autocommit((client) => client.query("SELECT pg_notify($1, $2)", [channel, payload]));
		},
		// Each schema's wake-ups are its own; `public` keeps the channels earlier releases listen on.
		channelName: (channel) =>
			postgresDialect.identifier(schema === LEGACY_SCHEMA ? channel : `${schema}_${channel}`),
	});

	const database = createSqliteDatabase({
		descriptor: { adapter: "postgres", location: connectionString },
		redact: (text) => {
			let redacted = text;
			for (const secret of [...passwords].sort((first, second) => second.length - first.length))
				if (secret !== "") redacted = redacted.replaceAll(secret, "[redacted]");
			return redacted;
		},
		transientFailure: transientFailureOf(pg.DatabaseError),
		// Postgres's largest field is 1 GB less one byte (#4954).
		payloadLimits: { value: 1_073_741_823 },
		execute: (sql, params) => autocommit((client) => executeAutocommit(client, sql, params)),
		executeMultiple: (sql) => autocommit((client) => executeMultipleAutocommit(client, sql)),
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
			const lock = begin.readOnly === true ? "" :
				concurrency.kind !== "serial"
					? concurrency.excludesSerial === true
						? `SELECT pg_advisory_xact_lock_shared(${lockKey(inSchema(DATABASE_LOCK_SCOPE))}); `
						: ""
					: concurrency.domain === undefined
						? `SELECT pg_advisory_xact_lock(${lockKey(inSchema(DATABASE_LOCK_SCOPE))}); `
						: `SELECT pg_advisory_xact_lock_shared(${lockKey(inSchema(DATABASE_LOCK_SCOPE))}), pg_advisory_xact_lock(${lockKey(inSchema(concurrency.domain))}); `;
			const client = await connect();
			try {
				// One round trip, with nothing set outside the transaction, so a transaction-mode pooler can serve it.
				await watched(
					client,
					() =>
						client.query(
							`${begin.readOnly === true ? "BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ" : "BEGIN"}; SET LOCAL lock_timeout = ${lockWaitMs}; ${lock}SET LOCAL statement_timeout = ${statementTimeoutMs}; ${searchPathSql()}`,
						),
					lockWaitMs + clientTimeoutMs,
				);
			} catch (error) {
				// The transaction may be open, so the connection is closed rather than reused.
				client.release(true);
				throw error;
			}
			return {
				execute: (sql, params) => execute(client, sql, params, clientTimeoutMs),
				executeMultiple: (sql) => executeMultiple(client, sql, clientTimeoutMs),
				async commit() {
					const result = await watched(client, () => client.query("COMMIT"), clientTimeoutMs);
					// A transaction a failed statement aborted ends in a rollback when committed, without an error.
					if (result.command === "ROLLBACK")
						throw new StorageError("The transaction was rolled back because a statement in it failed");
				},
				async rollback() {
					// The server rolled back the transaction of a connection that broke.
					if (lost.has(client)) return;
					try {
						await watched(client, () => client.query("ROLLBACK"), clientTimeoutMs);
					} catch (error) {
						// The transaction may still be open, so the connection is closed rather than reused.
						lost.add(client);
						throw error;
					}
				},
				// The facade closes a transaction once, after its commit or rollback.
				close: () => client.release(lost.has(client)),
			};
		},
		notifications: listener,
		close: async () => {
			await listener.close();
			await pool.end();
		},
	});
	try {
		const row = await database.get("SELECT current_setting('server_version_num') AS version");
		const version = Number(row?.version);
		if (!(version >= MINIMUM_SERVER_VERSION))
			throw new StorageUnavailableError(
				database.descriptor,
				new StorageError(`PostgreSQL server version ${version} is older than 14`),
				"PostgreSQL 14 or newer is required",
			);
		// Which schema holds Atomic's tables, read without creating anything (#5218).
		const found = await database.get(
			`SELECT (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname = ?) AS present,
				(SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname = ?) AS preferred,
				(SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
					WHERE n.nspname = ? AND c.relkind = 'r' AND c.relname ~ ?
					AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT LIKE ?) AS legacy`,
			schema,
			DEFAULT_SCHEMA,
			LEGACY_SCHEMA,
			LEGACY_MARKERS,
			`${MOVED_FENCE_COMMENT}%`,
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
