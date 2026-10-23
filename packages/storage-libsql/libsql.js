// @ts-check
import { createSqliteDatabase, redactSecrets, StorageAdapterLoadError } from "@bastani/atomic/storage";

/** @typedef {{ url: string, authToken?: string }} LibsqlDatabaseOptions */

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
			const result = await connection().execute({ sql, args: [...params] });
			return { columns: result.columns, rows: result.rows, changes: result.rowsAffected };
		},
		executeMultiple: (sql) => connection().executeMultiple(sql),
	};
}

/**
 * @param {LibsqlDatabaseOptions} options
 * @returns {Promise<import("@bastani/atomic/storage").SqliteDatabase>}
 */
export async function openLibsqlDatabase({ url, authToken }) {
	/** @type {typeof import("@libsql/client").createClient} */
	let createClient;
	try {
		({ createClient } = await import("@libsql/client"));
	} catch (cause) {
		throw new StorageAdapterLoadError("@libsql/client", /** @type {import("@bastani/atomic/storage").StorageFailureCause} */ (cause));
	}
	/** @type {import("@libsql/client").Client | undefined} */
	let client;
	// Create the client inside a driver call, so the facade redacts credentials from its failures.
	const connection = () => (client ??= createClient({ url, authToken, intMode: "bigint" }));
	const database = createSqliteDatabase({
		descriptor: { adapter: "libsql", location: url },
		redact: redactSecrets([authToken ?? "", ...urlCredentials(url)]),
		...statements(connection),
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
		return openLibsqlDatabase({
			url: options.url,
			authToken: typeof options.authToken === "string" ? options.authToken : undefined,
		});
	},
};
export default adapter;
