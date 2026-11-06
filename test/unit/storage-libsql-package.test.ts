import assert from "node:assert/strict";
import { readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { constants, PerformanceObserver } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	loadStorageAdapter,
	type SqliteDatabase,
	type StorageAdapterModule,
	type StorageOpenContext,
	StorageProvider,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { afterAll, describe, it, test } from "vitest";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import { registerRunJournalConformance } from "../../packages/workflows/src/durable/journal/conformance.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { registerBrokerLeaseStoreConformance } from "../helpers/intercom-multinode-contract.js";
import { observeJournalRead } from "../helpers/journal-read-observation.js";
import {
	collectReleasedLibsqlStatements,
	makeLibsqlDirectory,
	removeLibsqlDirectory,
} from "../helpers/libsql-cleanup.js";
import { libsqlDatabaseSubject } from "../helpers/libsql-database.js";
import {
	makeTempDirectory,
	moduleDir,
	readDirectorySync,
	removePathSync,
	removeTempDirectory,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const PACKAGE_NAME = "@bastani/atomic-storage-libsql";
const packageRoot = resolve(moduleDir(import.meta.url), "../../packages/storage-libsql");

/** A user agent directory whose settings list the package by local path, as `atomic install <path>` records it. */
async function installedAgentDirectory(): Promise<string> {
	const agentDir = makeTempDirectory("storage-libsql-agent-");
	await writeFileEnsuringDir(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
	return agentDir;
}

const agentDirectory = installedAgentDirectory();
const adapters = new Map<StorageOpenContext["domain"], Promise<StorageAdapterModule>>();

/** The adapter exactly as a user's settings select it: by package name, from the installed package. */
function packageAdapter(domain: StorageOpenContext["domain"]): Promise<StorageAdapterModule> {
	let adapter = adapters.get(domain);
	if (adapter === undefined) {
		adapter = agentDirectory.then((agentDir) => loadStorageAdapter(PACKAGE_NAME, { agentDir, domain }));
		adapters.set(domain, adapter);
	}
	return adapter;
}

async function openPackageDatabase(url: string, domain: StorageOpenContext["domain"]): Promise<SqliteDatabase> {
	const adapter = await packageAdapter(domain);
	assert.ok(adapter.openDatabase);
	return adapter.openDatabase({ url }, { agentDir: await agentDirectory, domain });
}

const withPackageDatabase = libsqlDatabaseSubject((url) => openPackageDatabase(url, "sessions"));

registerSqliteDatabaseConformance(
	{ describe, it },
	"package-selected libSQL adapter on a file URL",
	withPackageDatabase,
);

registerSessionStoreConformance(
	{ describe, it },
	"SqlSessionStore on the package-selected libSQL adapter (#3857)",
	async (body) => {
		await withPackageDatabase(async (subject) => {
			let store = await SqlSessionStore.open(subject.database);
			await body({
				store,
				async reopen() {
					store = await SqlSessionStore.open(await subject.reopen());
					return store;
				},
			});
		});
	},
);

registerRunJournalConformance(
	test,
	"package-selected libSQL adapter journal (#3857)",
	async () => {
		const directory = makeLibsqlDirectory();
		const database = await openPackageDatabase(pathToFileURL(join(directory, "journal.sqlite")).href, "journal");
		const journal = await SqlRunJournal.open(database);
		const close = journal.close.bind(journal);
		journal.close = async () => {
			await close();
			await database.close();
			await removeLibsqlDirectory(directory);
		};
		return journal;
	},
	observeJournalRead,
);

// A `file:` libSQL connection has no busy timeout, so two local connections would fail with SQLITE_BUSY under the
// contract's concurrent acquires. Both "brokers" share one connection; remote databases serialize writers themselves.
registerBrokerLeaseStoreConformance(test, "package-selected libSQL adapter intercom domain (#3857)", async () => {
	const directory = makeLibsqlDirectory();
	const database = await openPackageDatabase(pathToFileURL(join(directory, "intercom.sqlite")).href, "intercom");
	return {
		async connect() {
			return openSqlBrokerLeaseStore({ database, prefix: "team_" });
		},
		async close() {
			await database.close();
			await removeLibsqlDirectory(directory);
		},
	};
});

test("the package's first listed adapter is the one selected by package name (#3857)", async () => {
	const manifest = (await import("../../packages/storage-libsql/package.json", { with: { type: "json" } })).default;
	assert.deepEqual(manifest.atomic.storageAdapters, ["./libsql.js"]);
	assert.deepEqual(manifest.pi.storageAdapters, manifest.atomic.storageAdapters);
	const byName = await loadStorageAdapter(`${PACKAGE_NAME}/libsql`, {
		agentDir: await agentDirectory,
		domain: "sessions",
	});
	assert.equal(typeof byName.openDatabase, "function");
});

test("the package opens sessions through the storage provider with a file-based token (#3857)", async () => {
	const agentDir = await agentDirectory;
	const directory = makeLibsqlDirectory();
	await writeFileEnsuringDir(join(directory, "token"), "fixture-token-value\n");
	const selection = {
		kind: "adapter" as const,
		module: PACKAGE_NAME,
		options: { url: pathToFileURL(join(directory, "sessions.sqlite")).href },
		secrets: { authToken: { file: join(directory, "token") } },
		prefix: "p_",
	};
	try {
		const provider = new StorageProvider();
		const store = await provider.openSessionStore(selection, { agentDir, domain: "sessions" });
		await store.close();
	} finally {
		await collectReleasedLibsqlStatements();
		await removeLibsqlDirectory(directory);
	}
});

test("the package redacts the auth token from an unusable database failure (#3857)", async () => {
	const agentDir = await agentDirectory;
	const directory = makeLibsqlDirectory();
	const token = "fixture-secret-token-3857";
	await writeFileEnsuringDir(join(directory, "token"), `${token}\n`);
	try {
		const provider = new StorageProvider();
		await assert.rejects(
			provider.openSessionStore(
				{
					kind: "adapter",
					module: PACKAGE_NAME,
					options: { url: "libsql://example.invalid/database?unsupported=1" },
					secrets: { authToken: { file: join(directory, "token") } },
				},
				{ agentDir, domain: "sessions" },
			),
			(error: Error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.adapter, "libsql");
				assert.equal(inspect(error, { depth: null }).includes(token), false);
				return true;
			},
		);
	} finally {
		await removeLibsqlDirectory(directory);
	}
});

test("the package requires a url option (#3857)", async () => {
	const adapter = await packageAdapter("sessions");
	assert.throws(() => adapter.openDatabase?.({}, { agentDir: packageRoot, domain: "sessions" }), /"url" option/);
});

/** The files under `directory` this process holds open, as Linux lists its descriptors. */
function heldFiles(directory: string): string[] {
	return readDirectorySync("/proc/self/fd").flatMap((descriptor) => {
		try {
			const target = readlinkSync(join("/proc/self/fd", descriptor));
			return target.startsWith(directory) ? [target] : [];
		} catch (error) {
			// The descriptor that listed the directory is closed by the time it is read.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	});
}

/** Asserts nothing holds the files under `directory`: Windows refuses to delete a file a handle holds open. */
function assertReleased(directory: string): void {
	if (process.platform === "linux") assert.deepEqual(heldFiles(directory), []);
	removePathSync(directory, { recursive: true });
}

/** Observes the full collections the runtime reports as forced, until `count` is awaited. */
function observeForcedFullCollections(): { count(): Promise<number> } {
	const entries: object[] = [];
	const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
	observer.observe({ entryTypes: ["gc"] });
	return {
		async count() {
			// The runtime reports a collection on a later turn of the event loop.
			await new Promise((resolve) => setImmediate(resolve));
			entries.push(...observer.takeRecords());
			observer.disconnect();
			return entries.filter((entry) => {
				const { kind, flags } = (entry as { detail: { kind: number; flags: number } }).detail;
				return (
					kind === constants.NODE_PERFORMANCE_GC_MAJOR &&
					(flags & constants.NODE_PERFORMANCE_GC_FLAGS_FORCED) !== 0
				);
			}).length;
		},
	};
}

test("closing a file database releases its files before close resolves (#4433)", async () => {
	const directory = makeTempDirectory("storage-libsql-release-");
	try {
		const database = await openPackageDatabase(pathToFileURL(join(directory, "journal.sqlite")).href, "journal");
		await database.exec("CREATE TABLE entries(value INTEGER NOT NULL)");
		await database.transaction(async (transaction) => {
			await transaction.run("INSERT INTO entries VALUES (?)", 1);
		});
		const rejected = new Error("roll back");
		await assert.rejects(
			database.transaction(async (transaction) => {
				await transaction.run("INSERT INTO entries VALUES (?)", 2);
				throw rejected;
			}),
			(error) => error === rejected,
		);
		assert.ok(database.batch);
		await database.batch([{ sql: "INSERT INTO entries VALUES (?)", params: [3] }]);
		await assert.rejects(database.run("INSERT INTO entries VALUES (NULL)"), StorageUnavailableError);
		assert.deepEqual(await database.all("SELECT value FROM entries ORDER BY value"), [{ value: 1 }, { value: 3 }]);
		const collections = observeForcedFullCollections();
		await database.close();
		assertReleased(directory);
		// The close forced a full collection, with V8's gc taken without leaving it exposed to code that runs later.
		assert.ok((await collections.count()) > 0);
		assert.equal(runInNewContext("typeof gc"), "undefined");
	} finally {
		removeTempDirectory(directory);
	}
});

/** V8's full collection, as `node --expose-gc` exposes it. */
function v8Collection(): () => void {
	setFlagsFromString("--expose-gc");
	try {
		return runInNewContext("gc") as () => void;
	} finally {
		setFlagsFromString("--no-expose-gc");
	}
}

test("a file database closed on a Bun host collects with Bun.gc(true) (#4433)", async () => {
	const host = globalThis as { Bun?: unknown };
	assert.equal(host.Bun, undefined);
	const directory = makeTempDirectory("storage-libsql-release-");
	try {
		const database = await openPackageDatabase(pathToFileURL(join(directory, "journal.sqlite")).href, "journal");
		await database.get("SELECT 1");
		const collect = v8Collection();
		const forced: unknown[] = [];
		host.Bun = {
			gc(force: unknown) {
				forced.push(force);
				collect();
			},
		};
		try {
			await database.close();
		} finally {
			delete host.Bun;
		}
		assert.deepEqual(forced, [true]);
		assertReleased(directory);
	} finally {
		removeTempDirectory(directory);
	}
});

interface Collections {
	count: number;
	/** Runs at the start of the next collection, before it collects; a throw fails that collection. */
	beforeNext?: () => void;
}

/** Runs `body` with `globalThis.gc` counting the full collections the package runs, as `node --expose-gc` exposes it. */
async function withCountedCollections(body: (collections: Collections) => Promise<void>): Promise<void> {
	const collect = v8Collection();
	const collections: Collections = { count: 0 };
	const exposed = globalThis.gc;
	globalThis.gc = (() => {
		collections.count++;
		const beforeNext = collections.beforeNext;
		collections.beforeNext = undefined;
		beforeNext?.();
		collect();
	}) as NodeJS.GCFunction;
	try {
		await body(collections);
	} finally {
		globalThis.gc = exposed;
	}
}

/** File databases opened through the package, each with a statement run, and their directories removed afterwards. */
async function withOpenedFileDatabases(
	count: number,
	body: (opened: { directory: string; database: SqliteDatabase }[]) => Promise<void>,
): Promise<void> {
	const directories = Array.from({ length: count }, () => makeTempDirectory("storage-libsql-release-"));
	try {
		const opened = [];
		for (const directory of directories) {
			const database = await openPackageDatabase(pathToFileURL(join(directory, "journal.sqlite")).href, "journal");
			await database.get("SELECT 1");
			opened.push({ directory, database });
		}
		await body(opened);
	} finally {
		for (const directory of directories) removeTempDirectory(directory);
	}
}

test("file databases closed together share one collection (#4433)", async () => {
	await withCountedCollections(async (collections) => {
		await withOpenedFileDatabases(3, async (opened) => {
			await Promise.all(opened.map(({ database }) => database.close()));
			assert.equal(collections.count, 1);
			for (const { directory } of opened) assertReleased(directory);
		});
	});
});

test("a file database closed while a collection runs waits for the next collection (#4433)", async () => {
	await withCountedCollections(async (collections) => {
		await withOpenedFileDatabases(2, async ([first, second]) => {
			let closingSecond: Promise<void> | undefined;
			// The second database runs a statement after the first collection has started, then closes.
			collections.beforeNext = () => {
				closingSecond = second!.database.get("SELECT 2").then(() => second!.database.close());
			};
			await first!.database.close();
			await closingSecond;
			assert.equal(collections.count, 2);
			assertReleased(first!.directory);
			assertReleased(second!.directory);
		});
	});
});

test("a failed collection fails only the close that waited for it (#4433)", async () => {
	await withCountedCollections(async (collections) => {
		await withOpenedFileDatabases(2, async ([first, second]) => {
			const failure = new Error("fixture collection failure");
			collections.beforeNext = () => {
				throw failure;
			};
			await assert.rejects(first!.database.close(), (error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.cause, failure);
				return true;
			});
			await second!.database.close();
			assert.equal(collections.count, 2);
			assertReleased(first!.directory);
			assertReleased(second!.directory);
		});
	});
});

test("a failed open keeps its error and attaches a failure to close it (#4433)", async () => {
	const directory = makeTempDirectory("storage-libsql-release-");
	try {
		const path = join(directory, "journal.sqlite");
		writeFileSync(path, "not a SQLite database\n".repeat(64));
		const open = () => openPackageDatabase(pathToFileURL(path).href, "journal");
		await withCountedCollections(async (collections) => {
			// The client never opens: a file URL with a host names another machine.
			await assert.rejects(openPackageDatabase("file://example.invalid/journal.sqlite", "journal"), (error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.cleanupCause, undefined);
				return true;
			});
			await assert.rejects(open(), (error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.cleanupCause, undefined);
				return true;
			});
			assert.equal(collections.count, 2);
			const failure = new Error("fixture collection failure");
			collections.beforeNext = () => {
				throw failure;
			};
			await assert.rejects(open(), (error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.ok(error.cleanupCause instanceof StorageUnavailableError);
				assert.equal(error.cleanupCause.cause, failure);
				// Attached as storage attaches every cleanup cause, so an outer cleanup can still attach its own.
				assert.equal(Object.getOwnPropertyDescriptor(error, "cleanupCause")?.configurable, true);
				return true;
			});
			assert.equal(collections.count, 3);
		});
	} finally {
		// The failed collection left the last open's driver for a later collection to release.
		await removeLibsqlDirectory(directory);
	}
});

test("closing a remote database runs no collection (#4433)", async () => {
	const server = await recordingServer();
	try {
		await withCountedCollections(async (collections) => {
			await assert.rejects(
				openPackageDatabase(server.url, "journal"),
				(error) => error instanceof StorageUnavailableError && error.cleanupCause === undefined,
			);
			assert.ok(server.seen.length > 0);
			assert.equal(collections.count, 0);
		});
	} finally {
		await server.close();
	}
});

afterAll(async () => removeTempDirectory(await agentDirectory));

/** An HTTP server that records each request's headers and refuses it, standing in for a remote sqld. */
async function recordingServer() {
	const { createServer } = await import("node:http");
	const seen: Record<string, string | string[] | undefined>[] = [];
	const server = createServer((request, response) => {
		seen.push(request.headers);
		response.writeHead(500).end("refused");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		url: `http://127.0.0.1:${address.port}`,
		seen,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

test("the namespace option reaches a namespaced sqld as x-namespace (#4083)", async () => {
	const server = await recordingServer();
	try {
		const adapter = await packageAdapter("journal");
		await assert.rejects(
			adapter.openDatabase!(
				{ url: server.url, namespace: "team-a" },
				{ agentDir: await agentDirectory, domain: "journal" },
			),
			StorageUnavailableError,
		);
		assert.ok(server.seen.length > 0);
		assert.ok(server.seen.every((headers) => headers["x-namespace"] === "team-a"));
	} finally {
		await server.close();
	}
});

test("extra headers are sent and redacted from failures (#4083)", async () => {
	const { openLibsqlDatabase } = await import("../../packages/storage-libsql/libsql.js");
	const server = await recordingServer();
	const secret = "fixture-header-secret-4083";
	try {
		await assert.rejects(
			openLibsqlDatabase({ url: server.url, headers: { "x-proxy-key": secret } }),
			(error: Error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(inspect(error, { depth: null }).includes(secret), false);
				return true;
			},
		);
		assert.ok(server.seen.every((headers) => headers["x-proxy-key"] === secret));
	} finally {
		await server.close();
	}
});

test("namespace and headers are refused where libSQL sends no HTTP request (#4083)", async () => {
	const { openLibsqlDatabase } = await import("../../packages/storage-libsql/libsql.js");
	for (const url of ["file:/tmp/never-opened.sqlite", "wss://example.invalid", "ws://example.invalid"])
		await assert.rejects(openLibsqlDatabase({ url, namespace: "team-a" }), /only over HTTP/);
	await assert.rejects(openLibsqlDatabase({ url: "libsql://example.invalid", namespace: "" }), /non-empty string/);
	await assert.rejects(
		openLibsqlDatabase({ url: "libsql://example.invalid", headers: { "bad name": "x" } }),
		/header name/,
	);
	await assert.rejects(
		openLibsqlDatabase({ url: "libsql://example.invalid", headers: { "x-key": "a\r\nb" } }),
		/value of header/,
	);
	const adapter = await packageAdapter("sessions");
	assert.throws(
		() =>
			adapter.openDatabase?.(
				{ url: "libsql://example.invalid", namespace: 1 },
				{ agentDir: packageRoot, domain: "sessions" },
			),
		/non-empty string/,
	);
});
