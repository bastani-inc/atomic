import { createRequire } from "node:module";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Client, Transaction } from "@libsql/client";
import {
	createSqliteDatabase,
	redactSecrets,
	type SqliteDatabase,
	type SqliteDriverExecutor,
	type StorageAdapterModule,
	StorageAdapterLoadError,
	type StorageFailureCause,
} from "../../packages/coding-agent/src/core/storage/index.js";

export interface LibsqlDatabaseOptions {
	url: string;
	authToken?: string;
}

/** Credentials a libSQL URL can carry: its userinfo and every `authToken` query value. */
function urlCredentials(url: string): string[] {
	const secrets: string[] = [];
	// Scan each key/value once, including malformed URLs, without retrying a growing suffix at every '?'.
	for (let index = 0; index < url.length; index++) {
		if (url[index] !== "?" && url[index] !== "&") continue;
		const start = ++index;
		while (index < url.length && !"?&=#".includes(url[index]!)) index++;
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

const closesOnce = Symbol.for("@bastani/atomic-storage-libsql.closesOnce");

interface LibsqlConnection {
	open: boolean;
	close(): void;
	prepare(sql: string): object;
}

interface LibsqlConnectionClass {
	prototype: LibsqlConnection & { [closesOnce]?: true };
}

const statementsHeldWhileClosing = new Set<object>();

function statementHoldingConnection(connection: LibsqlConnection): object | undefined {
	if (!connection.open) return undefined;
	try {
		return connection.prepare("SELECT 1");
	} catch {
		return undefined;
	}
}

function closeEachConnectionOnce(): void {
	const client = createRequire(import.meta.url).resolve("@libsql/client");
	const Connection = createRequire(client)("libsql") as LibsqlConnectionClass;
	if (Connection.prototype[closesOnce]) return;
	const close = Connection.prototype.close;
	Connection.prototype.close = function (this: LibsqlConnection) {
		const statement = statementHoldingConnection(this);
		if (statement) statementsHeldWhileClosing.add(statement);
		try {
			close.call(this);
		} finally {
			if (statement) statementsHeldWhileClosing.delete(statement);
		}
	};
	Connection.prototype[closesOnce] = true;
}

interface GarbageCollectingRuntime {
	gc?: () => void;
	Bun?: { gc(force: boolean): void };
}

function exposedGc(): () => void {
	setFlagsFromString("--expose-gc");
	try {
		return runInNewContext("gc") as () => void;
	} finally {
		setFlagsFromString("--no-expose-gc");
	}
}

function collectGarbage(): void {
	const runtime = globalThis as GarbageCollectingRuntime;
	if (runtime.gc) runtime.gc();
	else if (runtime.Bun) runtime.Bun.gc(true);
	else exposedGc()();
}

const COLLECTION_PASSES = 2;

async function releaseClosedConnections(): Promise<void> {
	for (let pass = 0; pass < COLLECTION_PASSES; pass++) {
		collectGarbage();
		await new Promise((resolve) => setImmediate(resolve));
	}
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
		closeEachConnectionOnce();
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
		async close() {
			client?.close();
			if (/^file:/i.test(url)) await releaseClosedConnections();
		},
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
	openDatabase: (options) =>
		openLibsqlDatabase({
			url: String(options.url),
			authToken: typeof options.authToken === "string" ? options.authToken : undefined,
		}),
} satisfies StorageAdapterModule;
