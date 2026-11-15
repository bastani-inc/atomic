// @ts-check
import { connect as connectSocket } from "node:net";
import {
	createSqliteDatabase,
	postgresDialect,
	StorageAdapterLoadError,
	StorageConfigError,
	StorageError,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { createCloudPasswordProvider } from "./auth.js";

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
 * }} PostgresDatabaseOptions
 */

/** Connections one database keeps open at most, per process. */
export const DEFAULT_MAX_CONNECTIONS = 8;
/** How long one statement may run on the server before it is cancelled, in milliseconds. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
/** How long opening a connection, or waiting for a free one, may take. */
const CONNECT_TIMEOUT_MS = 10_000;
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
 * @param {string} field
 * @param {string} reason
 * @param {string} [hint]
 */
function configError(field, reason, hint) {
	return new StorageConfigError("sdk", field, reason, hint);
}

/** Whether `host` reaches this machine without a network: a socket directory, a loopback name or address. */
function isLocalHost(/** @type {string} */ host) {
	const name = host.replace(/^\[|\]$/g, "").toLowerCase();
	return (
		name === "" ||
		name.startsWith("/") ||
		name === "localhost" ||
		name === "::1" ||
		/^127(?:\.\d{1,3}){3}$/.test(name)
	);
}

/**
 * The URL pg connects with: a `postgres:` or `postgresql:` URL without a password, which gets `sslmode=verify-full`
 * when it names none and its host is not this machine.
 * @param {unknown} url
 * @returns {string}
 */
function connectionUrl(url) {
	/** @type {URL} */
	let parsed;
	try {
		parsed = new URL(/** @type {string} */ (url));
	} catch {
		throw configError("url", "unsupported-url", "Use a postgres:// or postgresql:// URL");
	}
	if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
		throw configError("url", "unsupported-url", "Use a postgres:// or postgresql:// URL");
	const names = [...parsed.searchParams.keys()].map((name) => name.toLowerCase());
	if (parsed.password !== "" || names.includes("password"))
		throw configError(
			"url",
			"credential-in-url",
			"Remove the password from the URL and pass it through the storage secrets instead",
		);
	if (names.includes("sslmode")) return /** @type {string} */ (url);
	const host = parsed.searchParams.get("host") ?? parsed.hostname;
	if (isLocalHost(host)) return /** @type {string} */ (url);
	parsed.searchParams.set("sslmode", "verify-full");
	return parsed.href;
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
]);

/**
 * The failure, as one that passes, read from the server's SQLSTATE when the server answered, else from whether a
 * connection could be had or broke during the call; never from a message.
 * @param {typeof import("pg").DatabaseError} DatabaseError
 * @returns {(failure: StorageFailureCause) => SqliteDriverTransientFailure | undefined}
 */
function transientFailureOf(DatabaseError) {
	return (failure) => {
		/** @type {PostgresConnectionFailure | undefined} */
		let connection;
		/** @type {unknown} */
		let current = failure;
		for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
			if (current instanceof DatabaseError) return TRANSIENT_SQLSTATES.get(current.code ?? "");
			if (current instanceof PostgresConnectionFailure) connection ??= current;
			else if (current instanceof StorageError) return undefined;
			current = /** @type {{ readonly cause?: unknown }} */ (current).cause;
		}
		if (connection === undefined) return undefined;
		return connection.phase === "connect"
			? { code: "connection-refused", outcome: "not-applied" }
			: { code: "connection-lost", outcome: "unknown" };
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
	const connection = parseUrl(connectionString);
	delete connection.password;

	/** Every password the pool was given, so the redactor can remove them from failures. */
	const passwords = new Set(typeof options.password === "string" ? [options.password] : []);
	const source =
		cloud === undefined
			? options.password
			: createCloudPasswordProvider({
					auth: cloud,
					host: connection.host ?? "",
					port: connection.port ?? 5432,
					user: connection.user ?? "",
				});
	/** @type {(() => Promise<string>) | undefined} */
	const password =
		source === undefined
			? undefined
			: async () => {
					const value = typeof source === "string" ? source : await source();
					if (typeof value !== "string" || value === "")
						throw configError("password", "empty-token", "The password source gave an empty password");
					passwords.add(value);
					return value;
				};

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

	/** @returns {Promise<PoolClient>} */
	const connect = async () => {
		try {
			return await pool.connect();
		} catch (cause) {
			throw new PostgresConnectionFailure("connect", /** @type {StorageFailureCause} */ (cause));
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
		const host = connection.host ?? "localhost";
		const port = connection.port ?? 5432;
		const socket = host.startsWith("/") ? connectSocket(`${host}/.s.PGSQL.${port}`) : connectSocket(port, host);
		socket.setTimeout(CLIENT_TIMEOUT_GRACE_MS, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		socket.end(request);
		return new Promise((resolve) => socket.once("close", () => resolve()));
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
	 * @returns {Promise<T>}
	 */
	const watched = async (client, query, timeoutMs) => {
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
		client.query({ text: numberPlaceholders(sql), values: [...params], rowMode: "array" });

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
	const execute = async (client, sql, params, timeoutMs) =>
		driverResult(await watched(client, () => statement(client, sql, params), timeoutMs));

	/**
	 * @param {PoolClient} client
	 * @param {string} sql
	 * @param {number} timeoutMs
	 */
	const executeMultiple = async (client, sql, timeoutMs) => {
		if (isPragma(sql)) return;
		await watched(client, () => client.query(sql), timeoutMs);
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
				const result = await watched(
					client,
					async () => {
						// Every answer is awaited, so none is left to fail unheard; the first failure is the call's.
						const answers = await Promise.allSettled([
							client.query(`BEGIN; ${setTimeoutSql}`),
							statement(client, sql, params),
							client.query("COMMIT"),
						]);
						for (const answer of answers) if (answer.status === "rejected") throw answer.reason;
						return /** @type {PromiseFulfilledResult<import("pg").QueryResult<SqliteValue[]>>} */ (answers[1]).value;
					},
					clientTimeoutMs,
				);
				return driverResult(result);
			},
			() => execute(client, sql, params, clientTimeoutMs),
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
			() => executeMultiple(client, `${setTimeoutSql}; ${sql}`, clientTimeoutMs),
			() => executeMultiple(client, sql, clientTimeoutMs),
		);
	};

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
			const lock =
				concurrency.kind !== "serial"
					? ""
					: concurrency.domain === undefined
						? `SELECT pg_advisory_xact_lock(${lockKey(DATABASE_LOCK_SCOPE)}); `
						: `SELECT pg_advisory_xact_lock_shared(${lockKey(DATABASE_LOCK_SCOPE)}), pg_advisory_xact_lock(${lockKey(concurrency.domain)}); `;
			const client = await connect();
			try {
				// One round trip, with nothing set outside the transaction, so a transaction-mode pooler can serve it.
				await watched(
					client,
					() =>
						client.query(
							`BEGIN; SET LOCAL lock_timeout = ${lockWaitMs}; ${lock}SET LOCAL statement_timeout = ${statementTimeoutMs}`,
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
		close: () => pool.end(),
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
		return database;
	} catch (error) {
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
		});
	},
};
export default adapter;
