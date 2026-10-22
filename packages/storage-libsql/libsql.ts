import type { Client, Transaction } from "@libsql/client";
import {
	createSqliteDatabase,
	redactSecrets,
	type SqliteDatabase,
	type SqliteDriverExecutor,
	type StorageAdapterModule,
	StorageAdapterLoadError,
	type StorageFailureCause,
} from "@bastani/atomic/storage";

export interface LibsqlDatabaseOptions {
	url: string;
	authToken?: string;
}

/** Credentials a libSQL URL can carry: its userinfo and every `authToken` query value. */
function urlCredentials(url: string): string[] {
	const secrets: string[] = [];
	for (const match of url.matchAll(/[?&]([^=&#]*)=([^&#]*)/g)) {
		const token = new URLSearchParams(match[0].slice(1)).get("authToken");
		if (token !== null) secrets.push(match[2] ?? "", token);
	}
	const userinfo = url.match(/\/\/([^/?#]*)@/)?.[1];
	if (userinfo !== undefined) secrets.push(...userinfo.split(":"));
	return secrets;
}

function statements(connection: () => Client | Transaction): SqliteDriverExecutor {
	return {
		async execute(sql, params) {
			const result = await connection().execute({ sql, args: [...params] });
			return { columns: result.columns, rows: result.rows, changes: result.rowsAffected };
		},
		executeMultiple: (sql) => connection().executeMultiple(sql),
	};
}

export async function openLibsqlDatabase({ url, authToken }: LibsqlDatabaseOptions): Promise<SqliteDatabase> {
	let createClient: typeof import("@libsql/client").createClient;
	try {
		({ createClient } = await import("@libsql/client"));
	} catch (cause) {
		throw new StorageAdapterLoadError("@libsql/client", cause as StorageFailureCause);
	}
	let client: Client | undefined;
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

export default {
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
} satisfies StorageAdapterModule;
