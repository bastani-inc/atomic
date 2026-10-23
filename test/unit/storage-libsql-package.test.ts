import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
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
import { makeTempDirectory, moduleDir, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

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

afterAll(async () => removeTempDirectory(await agentDirectory));
