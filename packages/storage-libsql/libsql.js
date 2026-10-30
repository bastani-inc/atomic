// @ts-check
import { createSqliteDatabase, redactSecrets, StorageAdapterLoadError } from "@bastani/atomic/storage";

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
 * `fetch` that adds `headers` to every request the libSQL HTTP client sends.
 * @param {[string, string][]} headers
 * @returns {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>}
 */
function fetchWith(headers) {
	return (input, init) => {
		const request = new Request(input, init);
		for (const [name, value] of headers) request.headers.set(name, value);
		return fetch(request);
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
 * @param {() => import("@libsql/client").Client | import("@libsql/client").Transaction} connection
 * @returns {import("@bastani/atomic/storage").SqliteDriverExecutor}
 */
function statements(connection) {
	return {
		async execute(sql, params) {
			return driverResult(await connection().execute({ sql, args: [...params] }));
		},
		executeMultiple: (sql) => connection().executeMultiple(sql),
	};
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
	const connection = () =>
		(client ??= createClient({
			url,
			authToken,
			intMode: "bigint",
			...(local ? { timeout: FILE_BUSY_TIMEOUT_MS } : {}),
			...(added.length > 0 ? { fetch: fetchWith(added) } : {}),
		}));
	const database = createSqliteDatabase({
		descriptor: { adapter: "libsql", location: url },
		redact: redactSecrets([authToken ?? "", ...urlCredentials(url), ...Object.values(headers ?? {})]),
		...statements(connection),
		// One request for the whole batch, in a write transaction: the journal sends a batch of appends this way.
		async batch(batched) {
			const results = await connection().batch(
				batched.map(({ sql, params }) => ({ sql, args: [...params] })),
				"write",
			);
			return results.map(driverResult);
		},
		async beginTransaction() {
			const transaction = await connection().transaction("write");
			return {
				...statements(() => transaction),
				commit: () => transaction.commit(),
				rollback: () => transaction.rollback(),
				close: () => transaction.close(),
			};
		},
		close: () => client?.close(),
	});
	try {
		await database.exec("PRAGMA foreign_keys = ON");
		// Readers and the one writer of a file share it through the write-ahead log, as in Atomic's own SQLite stores;
		// in the default rollback journal a read refuses a writer's commit and the other way round. The mode is stored
		// in the file, so this changes it once and costs nothing afterwards.
		if (local) await database.exec("PRAGMA journal_mode = WAL");
		return database;
	} catch (error) {
		await database.close().catch(() => {});
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
