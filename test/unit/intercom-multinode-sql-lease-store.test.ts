import assert from "node:assert/strict";
import { join } from "node:path";
import {
	loadStorageAdapter,
	openNodeSqliteDatabase,
	type SqliteDatabase,
	type StorageOpenContext,
} from "@bastani/atomic/storage";
import { test } from "vitest";
import type { BrokerLeaseStore } from "../../packages/intercom/broker/multinode-state-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import {
	registerBrokerLeaseStoreConformance,
	type SharedStoreFixture,
} from "../helpers/intercom-multinode-contract.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

async function sharedDatabaseFixture(
	directoryPrefix: string,
	prefix: string,
	openDatabase: (directory: string) => Promise<SqliteDatabase>,
): Promise<SharedStoreFixture<BrokerLeaseStore>> {
	const directory = makeTempDirectory(directoryPrefix);
	const databases: SqliteDatabase[] = [];
	return {
		async connect() {
			const database = await openDatabase(directory);
			databases.push(database);
			return openSqlBrokerLeaseStore({ database, prefix });
		},
		async close() {
			try {
				for (const database of databases.splice(0)) await database.close();
			} finally {
				removeTempDirectory(directory);
			}
		},
	};
}

registerBrokerLeaseStoreConformance(test, "node sqlite file shared by two connections", () =>
	sharedDatabaseFixture("intercom-sql-leases-", "", (directory) =>
		openNodeSqliteDatabase(join(directory, "shared.sqlite")),
	),
);

registerBrokerLeaseStoreConformance(test, "module-selected SQLite adapter", () =>
	sharedDatabaseFixture("intercom-adapter-leases-", "team_", async (directory) => {
		const context: StorageOpenContext = { agentDir: directory, domain: "sessions" };
		const adapter = await loadStorageAdapter(
			join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
			context,
		);
		assert.ok(adapter.openDatabase);
		return adapter.openDatabase({ path: join(directory, "shared.sqlite") }, context);
	}),
);
