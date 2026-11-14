// @ts-check
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createSqliteDatabase, redactSecrets, StorageAdapterLoadError, switchToWriteAheadLog } from "@bastani/atomic/storage";

/**
 * @typedef {{ url: string, authToken?: string, namespace?: string, headers?: Readonly<Record<string, string>> }} LibsqlDatabaseOptions
 */

/** Header names an HTTP request can carry: RFC 9110 tokens. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The request headers `namespace` and `headers` add, checked. A self-hosted sqld started with `--enable-namespaces`
 * picks the database by `x-namespace`.
 * @param {string} url
 * @param {string | undefined} namespace
 * @param {Readonly<Record<string, string>> | undefined} headers
 * @returns {[string, string][]}
 */
function requestHeaders(url, namespace, headers) {
	/** @type {[string, string][]} */
	const added = Object.entries(headers ?? {});
	if (namespace !== undefined) {
		if (typeof namespace !== "string" || namespace === "")
			throw new TypeError('The libSQL storage adapter\'s "namespace" option must be a non-empty string');
		added.push(["x-namespace", namespace]);
	}
	for (const [name, value] of added) {
		if (!HEADER_NAME.test(name)) throw new TypeError(`The libSQL storage adapter can't send the header name ${JSON.stringify(name)}`);
		if (typeof value !== "string" || /[\r\n\0]/.test(value))
			throw new TypeError(`The libSQL storage adapter can't send the value of header ${JSON.stringify(name)}`);
	}
	if (added.length > 0 && !/^(libsql|https?):/i.test(url))
		throw new TypeError(
			'The libSQL storage adapter sends "namespace" and "headers" only over HTTP: use a libsql:, https: or http: URL',
		);
	return added;
}

/**
 * How long one request to a database server may go unanswered before it is abandoned. A server answers a request that
 * waits for its write lock within its own lock wait (sqld's is 5 seconds), so a request still unanswered long after
 * that is stuck in the server: abandoning it lets the caller plan its write again instead of waiting without end.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * `fetch` that adds `headers` to every request the libSQL HTTP client sends, and abandons a request after
 * `REQUEST_TIMEOUT_MS`.
 * @param {[string, string][]} headers
 * @returns {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>}
 */
function fetchWith(headers) {
	return (input, init) => {
		const request = new Request(input, init);
		for (const [name, value] of headers) request.headers.set(name, value);
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		return fetch(request, { signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

/**
 * Credentials a libSQL URL can carry: its userinfo and every `authToken` query value.
 * @param {string} url
 * @returns {string[]}
 */
function urlCredentials(url) {
	const secrets = [];
	// Scan each key/value once, including malformed URLs, without retrying a growing suffix at every '?'.
	for (let index = 0; index < url.length; index++) {
		if (url[index] !== "?" && url[index] !== "&") continue;
		const start = ++index;
		while (index < url.length && !"?&=#".includes(url[index])) index++;
		if (url[index] === "=") {
			const valueStart = ++index;
			while (index < url.length && url[index] !== "&" && url[index] !== "#") index++;
			const token = new URLSearchParams(url.slice(start, index)).get("authToken");
			if (token !== null) secrets.push(url.slice(valueStart, index), token);
		}
		index--;
	}
	const userinfo = url.match(/\/\/([^/?#]*)@/)?.[1];
	if (userinfo !== undefined) secrets.push(...userinfo.split(":"));
	return secrets;
}

/**
 * @param {() => Promise<import("@libsql/client").Client | import("@libsql/client").Transaction>} connection
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} watch
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} [single] runs one statement, which a failure may run again
 * @returns {import("@bastani/atomic/storage").SqliteDriverExecutor}
 */
function statements(connection, watch, single = watch) {
	return {
		execute: (sql, params) =>
			single(async () => driverResult(await (await connection()).execute({ sql, args: [...params] }))),
		// An `exec` of one statement wrote nothing when it fails, as one `execute` did; one of several statements may
		// fail after the statements before it committed.
		executeMultiple: (sql) =>
			(isOneStatement(sql) ? single : watch)(async () => (await connection()).executeMultiple(sql)),
	};
}

/**
 * Whether `sql` is one statement: it has no `;` but at its end. A `;` in a literal or a comment also counts, so
 * several statements are never taken for one.
 * @param {string} sql
 */
function isOneStatement(sql) {
	const first = sql.indexOf(";");
	return first === -1 || /^[\s;]*$/.test(sql.slice(first));
}

/**
 * @param {import("@libsql/client").ResultSet} result
 * @returns {import("@bastani/atomic/storage").SqliteDriverResult}
 */
function driverResult(result) {
	return { columns: result.columns, rows: result.rows, changes: result.rowsAffected };
}

/**
 * How long a connection to a local `file:` database waits for a lock another connection holds before failing with
 * `SQLITE_BUSY`, as Atomic's own SQLite stores wait. Without it the driver fails at once, so two processes writing
 * one file, such as a workflow root, its coordinator and its workers, lose statements to each other.
 */
const FILE_BUSY_TIMEOUT_MS = 5000;

/**
 * Whether a driver call failed because another connection held a lock past the busy timeout.
 * @param {unknown} error
 */
function isBusy(error) {
	return /** @type {{ readonly code?: unknown } | undefined} */ (error)?.code === "SQLITE_BUSY";
}

/** V8's `gc`, taken from a context created while `--expose-gc` is set; the flag is off again for code that runs later. */
function exposeGc() {
	setFlagsFromString("--expose-gc");
	try {
		return /** @type {() => void} */ (runInNewContext("gc"));
	} finally {
		setFlagsFromString("--no-expose-gc");
	}
}

function collectGarbage() {
	if (globalThis.gc) globalThis.gc();
	else if (typeof Bun !== "undefined") Bun.gc(true);
	else exposeGc()();
}

/**
 * Consecutive full collections one close runs. One forced collection occasionally leaves a statement uncollected, about
 * once in several thousand closes in a loop that opens, uses and closes a file database, and a further event-loop turn
 * does not collect it; a second collection does.
 */
const COLLECTION_PASSES = 2;

/** @type {Promise<void>} */
let collection = Promise.resolve();
/** @type {Promise<void> | undefined} */
let pendingCollection;

/**
 * libsql 0.5 finalizes a statement only when the statement is garbage-collected, and a connection stays open until
 * its last statement is finalized, so the client's `close()` leaves a `file:` database's files open and Windows
 * refuses to delete them. This resolves after `COLLECTION_PASSES` full collections that started after the call, each
 * followed by the event-loop turn in which the runtime runs the native finalizers it queued. Calls made before those
 * collections start share them.
 * @returns {Promise<void>}
 */
function releaseClosedConnections() {
	if (!pendingCollection) {
		pendingCollection = collection.then(collectAndFinalize, collectAndFinalize);
		collection = pendingCollection;
	}
	return pendingCollection;
}

async function collectAndFinalize() {
	pendingCollection = undefined;
	for (let pass = 0; pass < COLLECTION_PASSES; pass++) {
		collectGarbage();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/**
 * Write requests one process sends to a database server at once, over every database it opened: the server takes its
 * write lock one writer at a time, so more requests in flight only lengthen the queue for it, and a process with many
 * workers would fill it. Batches that set `priority` do not count, so a lease renewal never waits behind them.
 */
const MAX_IN_FLIGHT_WRITES = 4;

/** Write batches in a row a server left unanswered, after which its writes count as stalled. */
const STALLED_WRITES_WARNING_AFTER = 3;
/**
 * Each server's unanswered write batches in a row, and whether its stall was reported, by its location: one stalled
 * server is told apart from another that answers.
 * @type {Map<string, { unanswered: number; reported: boolean }>}
 */
const writeHealth = new Map();

/**
 * Counts a write batch's outcome toward the process's warning that a server stopped taking writes, once per stall: the
 * first write answered after it warns that writes go through again. sqld 0.24.33 and earlier can stop granting its
 * write lock to anyone (tursodatabase/libsql#2286): the stall warning names the fix.
 * @param {unknown} error undefined for a batch the server answered
 * @param {string} location
 */
function noteWriteOutcome(error, location) {
	const health = writeHealth.get(location) ?? { unanswered: 0, reported: false };
	if (!isTimeout(error)) {
		// A write answered after a reported stall: the server takes writes again, and a later stall warns again.
		if (health.reported)
			reportWriteHealth(
				false,
				`The libSQL server at ${location} is taking writes again after ${health.unanswered} unanswered write requests.`,
				"ATOMIC_LIBSQL_WRITES_RECOVERED",
			);
		writeHealth.delete(location);
		return;
	}
	health.unanswered++;
	writeHealth.set(location, health);
	if (health.unanswered < STALLED_WRITES_WARNING_AFTER || health.reported) return;
	health.reported = true;
	reportWriteHealth(
		true,
		`The libSQL server at ${location} left ${health.unanswered} write requests in a row unanswered for ${REQUEST_TIMEOUT_MS / 1000} seconds each. sqld 0.24.33 and earlier can stop taking writes from every client until it restarts (https://github.com/tursodatabase/libsql/issues/2286); start sqld with --checkpoint-interval-s 60 (SQLD_CHECKPOINT_INTERVAL_S=60) to avoid it, and restart it now if writes stay stuck. Atomic keeps retrying its writes meanwhile.`,
		"ATOMIC_LIBSQL_WRITES_STALLED",
	);
}

/**
 * Reports a server's write health as a process warning, and as the process event `atomic-libsql-write-health`, which a
 * process that silences warnings (as Atomic's CLI does) still hears: `{ stalled, message }`.
 * @param {boolean} stalled
 * @param {string} message
 * @param {string} code
 */
function reportWriteHealth(stalled, message, code) {
	process.emitWarning(message, { code });
	/** @type {(event: string, payload: { stalled: boolean; message: string }) => boolean} */ (process.emit)(
		"atomic-libsql-write-health",
		{ stalled, message },
	);
}

/**
 * Whether a request was abandoned after `REQUEST_TIMEOUT_MS`, read along the cause chain.
 * @param {unknown} error
 */
function isTimeout(error) {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		const { name, cause } = /** @type {{ readonly name?: unknown, readonly cause?: unknown }} */ (current);
		if (name === "TimeoutError") return true;
		current = cause;
	}
	return false;
}

let writesInFlight = 0;
/** @type {(() => void)[]} */
const waitingWrites = [];

/**
 * Runs `operation` once fewer than `MAX_IN_FLIGHT_WRITES` other writes of this process are in flight.
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function limitedWrite(operation) {
	if (writesInFlight >= MAX_IN_FLIGHT_WRITES) await new Promise((resolve) => waitingWrites.push(() => resolve(undefined)));
	else writesInFlight++;
	try {
		return await operation();
	} finally {
		const next = waitingWrites.shift();
		// The slot passes straight to the next waiter, so a write arriving meanwhile cannot take it first.
		if (next) next();
		else writesInFlight--;
	}
}

/**
 * Codes a server answers a batch with when it could not take the write lock in time: the batch wrote nothing.
 * @type {ReadonlySet<unknown>}
 */
const LOCK_BUSY = new Set(["SQLITE_BUSY", "TRANSACTION_TIMEOUT"]);

/**
 * Whether a failed request found the write lock busy, read from each error's `code` along the cause chain.
 * @param {unknown} error
 */
function isLockBusy(error) {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		const { code, cause } = /** @type {{ readonly code?: unknown, readonly cause?: unknown }} */ (current);
		if (LOCK_BUSY.has(code)) return true;
		current = cause;
	}
	return false;
}

/** How far `transientFailure` follows `cause`: a driver error wraps the network error that fetch wraps. */
const MAX_CAUSE_DEPTH = 8;
/**
 * Codes sqld answers for a stream or transaction it ended and rolled back: nothing of it was written.
 * @type {ReadonlyMap<unknown, import("@bastani/atomic/storage").StorageTransientErrorCode>}
 */
const ENDED_BY_SERVER = new Map([
	["STREAM_EXPIRED", "stream-expired"],
	["TRANSACTION_TIMEOUT", "transaction-timeout"],
]);
/**
 * Network codes of a request that never reached the server, from Node's fetch and from Bun's.
 * @type {ReadonlySet<unknown>}
 */
const NOT_SENT = new Set(["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
/**
 * Network codes of a connection that broke after a request may have reached the server.
 * @type {ReadonlySet<unknown>}
 */
const CONNECTION_LOST = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"]);

/**
 * The failure, as one that passes, when the server ended the stream or transaction of a process that stalled, or the
 * connection to the server could not be made or broke; read from each error's `code` along the cause chain, never
 * from its message.
 * @param {import("@bastani/atomic/storage").StorageFailureCause} failure
 * @returns {import("@bastani/atomic/storage").SqliteDriverTransientFailure | undefined}
 */
function transientFailure(failure) {
	/** @type {unknown} */
	let current = failure;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		const { code, cause, name } = /** @type {{ readonly code?: unknown, readonly cause?: unknown, readonly name?: unknown }} */ (
			current
		);
		// A request abandoned after `REQUEST_TIMEOUT_MS`: the server may have applied it.
		if (name === "TimeoutError") return { code: "connection-lost", outcome: "unknown" };
		const ended = ENDED_BY_SERVER.get(code);
		if (ended !== undefined) return { code: ended, outcome: "not-applied" };
		if (NOT_SENT.has(code)) return { code: "connection-refused", outcome: "not-applied" };
		if (CONNECTION_LOST.has(code)) return { code: "connection-lost", outcome: "unknown" };
		current = cause;
	}
	return undefined;
}

/**
 * @param {LibsqlDatabaseOptions} options
 * @returns {Promise<import("@bastani/atomic/storage").SqliteDatabase>}
 */
export async function openLibsqlDatabase({ url, authToken, namespace, headers }) {
	const added = requestHeaders(url, namespace, headers);
	/** @type {typeof import("@libsql/client").createClient} */
	let createClient;
	try {
		({ createClient } = await import("@libsql/client"));
	} catch (cause) {
		throw new StorageAdapterLoadError("@libsql/client", /** @type {import("@bastani/atomic/storage").StorageFailureCause} */ (cause));
	}
	const local = /^file:/i.test(url);
	/** @type {import("@libsql/client").Client | undefined} */
	let client;
	// Create the client inside a driver call, so the facade redacts credentials from its failures. The busy timeout is a
	// client option, not a PRAGMA, because the client opens more connections than the one that ran the PRAGMA, and
	// each needs it; a connection waits for a lock on the calling thread.
	const create = () =>
		createClient({
			url,
			authToken,
			intMode: "bigint",
			...(local ? { timeout: FILE_BUSY_TIMEOUT_MS } : {}),
			...(local ? {} : { fetch: fetchWith(added) }),
		});
	// A local statement that fails part way, as a write does when another process holds the lock past the busy timeout,
	// stays active on its connection: the driver resets and finalizes a statement only when it is garbage collected.
	// Until then that connection commits nothing ("cannot commit transaction - SQL statements in progress"), and a
	// write outside a transaction reports success but is never committed. So after a local failure the next call gets
	// new connections. The facade runs one call at a time, so no call is still using the old ones.
	let replace = false;
	/** @type {<T>(operation: () => Promise<T>) => Promise<T>} */
	const watch = async (operation) => {
		try {
			return await operation();
		} catch (error) {
			if (local) replace = true;
			throw error;
		}
	};
	// SQLite's busy handler polls for a lock with growing sleeps, so a writer behind others that take the lock in turn
	// can miss every poll and fail after the busy timeout although the lock changed hands many times meanwhile. So a
	// call that the busy timeout ended before it wrote anything runs again, on new connections, as long as another
	// connection committed while it waited: it fails only after a whole busy timeout in which nobody committed, as
	// Atomic's own SQLite stores fail only after their lock wait passes without a commit. `PRAGMA data_version`, read
	// on a connection of its own, changes when another connection commits.
	/** @type {import("@libsql/client").Client | undefined} */
	let probe;
	const dataVersion = async () => {
		probe ??= create();
		const version = (await probe.execute("PRAGMA data_version")).rows[0]?.data_version;
		return typeof version === "bigint" || typeof version === "number" ? version : undefined;
	};
	/** @type {<T>(operation: () => Promise<T>) => Promise<T>} */
	const waitForLock = async (operation) => {
		/** @type {bigint | number | undefined} */
		let version;
		for (;;) {
			try {
				return await watch(operation);
			} catch (error) {
				if (!local || !isBusy(error)) throw error;
				// The first wait's progress is unknown, so it runs again once whatever the version says.
				const current = await dataVersion().catch(() => version);
				if (current === undefined || current === version) throw error;
				version = current;
			}
		}
	};
	const connection = async () => {
		if (replace) {
			replace = false;
			client?.close();
			const fresh = create();
			client = fresh;
			// A new connection does not have the PRAGMA the open ran on the one it replaces.
			await watch(() => fresh.execute("PRAGMA foreign_keys = ON"));
		}
		return (client ??= create());
	};
	const redact = redactSecrets([authToken ?? "", ...urlCredentials(url), ...Object.values(headers ?? {})]);
	/** The server's location as diagnostics show it, without credentials. */
	const redacted = redact(url);
	const database = createSqliteDatabase({
		descriptor: { adapter: "libsql", location: url },
		redact,
		transientFailure,
		// A server's batch the busy lock ended: the facade sends it again within the caller's `lockWaitMs`.
		lockBusy: (failure) => !local && isLockBusy(failure),
		// One statement outside a transaction, run alone or as an `exec` of one statement, that waited out the busy
		// timeout wrote nothing and runs again. Several statements in one `exec` do not: the ones before the failed
		// statement were committed.
		...statements(connection, watch, waitForLock),
		// One request for the whole batch, in a write transaction: the journal sends a batch of appends this way. Only
		// its `BEGIN IMMEDIATE` waits for the write lock, so a batch the busy timeout ended wrote nothing (`lockBusy`). A
		// server's batch counts against this process's writes in flight, unless it has priority.
		batch: (batched, options) => {
			const send = async () => {
				const results = await (await connection()).batch(
					batched.map(({ sql, params }) => ({ sql, args: [...params] })),
					"write",
				);
				return results.map(driverResult);
			};
			if (local) return waitForLock(send);
			const sent = () =>
				watch(() =>
					send().then(
						(results) => {
							noteWriteOutcome(undefined, redacted);
							return results;
						},
						(error) => {
							noteWriteOutcome(error, redacted);
							throw error;
						},
					),
				);
			return options?.priority === true ? sent() : limitedWrite(sent);
		},
		async beginTransaction() {
			const transaction = await waitForLock(async () => (await connection()).transaction("write"));
			return {
				...statements(async () => transaction, watch),
				commit: () => watch(() => transaction.commit()),
				rollback: () => watch(() => transaction.rollback()),
				close: () => transaction.close(),
			};
		},
		async close() {
			client?.close();
			probe?.close();
			if (local) await releaseClosedConnections();
		},
	});
	try {
		await database.exec("PRAGMA foreign_keys = ON");
		// Readers and the one writer of a file share it through the write-ahead log, as in Atomic's own SQLite stores;
		// in the default rollback journal a read refuses a writer's commit and the other way round. The mode is stored
		// in the file, so this changes it once and costs nothing afterwards. SQLite does not wait for another
		// connection's lock while it changes the mode, so the switch waits out the busy timeout itself: several
		// processes opening one new file at once, or one writing it, would otherwise fail the open with SQLITE_BUSY.
		if (local) await switchToWriteAheadLog((sql) => database.exec(sql), FILE_BUSY_TIMEOUT_MS);
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
	openDatabase(options) {
		if (typeof options.url !== "string" || options.url === "") {
			throw new TypeError('The libSQL storage adapter requires a non-empty string "url" option');
		}
		if (options.namespace !== undefined && typeof options.namespace !== "string") {
			throw new TypeError('The libSQL storage adapter\'s "namespace" option must be a non-empty string');
		}
		return openLibsqlDatabase({
			url: options.url,
			authToken: typeof options.authToken === "string" ? options.authToken : undefined,
			...(options.namespace === undefined ? {} : { namespace: options.namespace }),
		});
	},
};
export default adapter;
