import assert from "node:assert/strict";
import { join } from "node:path";
import { loadStorageAdapter, type SqliteDatabase } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { OutboxStore } from "../../packages/intercom/broker/multinode-state-store.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import {
	type OpenSharedStoreFixture,
	registerCrossNodeRoundTripConformance,
	registerOutboxStoreConformance,
	type SharedStoreFixture,
} from "../helpers/intercom-multinode-contract.js";
import {
	openMemoryPendingAskFixture,
	openMemoryWakeUpBusFixture,
} from "../helpers/intercom-multinode-memory-reference.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

function sharedOutboxFixture(
	label: string,
	prefix: string,
	openDatabase: (directory: string) => Promise<SqliteDatabase>,
): OpenSharedStoreFixture<OutboxStore> {
	return async (): Promise<SharedStoreFixture<OutboxStore>> => {
		const directory = makeTempDirectory(`intercom-outbox-${label}-`);
		const databases: SqliteDatabase[] = [];
		return {
			async connect() {
				const database = await openDatabase(directory);
				databases.push(database);
				return openSqlOutboxStore({ database, prefix });
			},
			async close() {
				await Promise.all(databases.map((database) => database.close()));
				removeTempDirectory(directory);
			},
		};
	};
}

const openNodeSqliteOutbox = sharedOutboxFixture("node-sqlite", "", (directory) =>
	openNodeSqliteDatabase(join(directory, "shared.sqlite")),
);

const openAdapterOutbox = sharedOutboxFixture("adapter", "team_", async (directory) => {
	const context = { agentDir: directory, domain: "sessions" } as const;
	const adapter = await loadStorageAdapter(
		join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
		context,
	);
	assert.ok(adapter.openDatabase);
	return adapter.openDatabase({ path: join(directory, "shared.sqlite") }, context);
});

registerOutboxStoreConformance(test, "SQL on two node:sqlite connections", openNodeSqliteOutbox);
registerOutboxStoreConformance(test, "SQL on the module-selected adapter", openAdapterOutbox);
registerCrossNodeRoundTripConformance(test, "SQL outbox", {
	openOutbox: openNodeSqliteOutbox,
	openPendingAsks: openMemoryPendingAskFixture,
	openBus: openMemoryWakeUpBusFixture,
});

test("keeps each table prefix's outbox in its own <prefix>intercom_outbox table", async () => {
	const directory = makeTempDirectory("intercom-outbox-prefix-");
	const database = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	try {
		const team = await openSqlOutboxStore({ database, prefix: "team_" });
		const plain = await openSqlOutboxStore({ database, prefix: "" });
		const frame = {
			type: "message",
			from: { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
			message: { id: "m1", timestamp: 1, content: { text: "hi" } },
		} as const;
		await team.enqueue({ targetIdentity: "r", originBrokerId: "a", digest: "d", frame });
		assert.equal((await team.read("m1")).status, "found");
		assert.deepEqual(await plain.read("m1"), { status: "missing" });
		const tables = await database.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%intercom_outbox' ORDER BY name",
		);
		assert.deepEqual(
			tables.map((table) => table.name),
			["intercom_outbox", "team_intercom_outbox"],
		);
		await assert.rejects(openSqlOutboxStore({ database, prefix: "bad prefix" }));
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
});
