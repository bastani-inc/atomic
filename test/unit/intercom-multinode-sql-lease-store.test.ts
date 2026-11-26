import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase, type StorageOpenContext } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import type { BrokerLeaseStore } from "../../packages/intercom/broker/multinode-state-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import { useFixtureStorageAdapter } from "../helpers/fixture-storage-adapter.js";
import {
	registerBrokerLeaseStoreConformance,
	type SharedStoreFixture,
} from "../helpers/intercom-multinode-contract.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

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

const fixtureAdapter = useFixtureStorageAdapter();

registerBrokerLeaseStoreConformance(test, "node sqlite file shared by two connections", () =>
	sharedDatabaseFixture("intercom-sql-leases-", "", (directory) =>
		openNodeSqliteDatabase(join(directory, "shared.sqlite")),
	),
);

registerBrokerLeaseStoreConformance(test, "module-selected SQLite adapter", () =>
	sharedDatabaseFixture("intercom-adapter-leases-", "team_", async (directory) => {
		const context: StorageOpenContext = { agentDir: directory, domain: "sessions" };
		const adapter = fixtureAdapter();
		assert.ok(adapter.openDatabase);
		return adapter.openDatabase({ path: join(directory, "shared.sqlite") }, context);
	}),
);

test("renewMany renews membership and multiple presence leases in a single SQLite transaction while reporting per-lease status", async () => {
	const directory = makeTempDirectory("intercom-sql-leases-batch-");
	const database = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	try {
		const store = await openSqlBrokerLeaseStore({ database, prefix: "" });
		assert.equal(typeof store.renewMany, "function", "SQL lease store exposes single-transaction renewMany");
		const memberSubject = { kind: "broker", brokerId: "broker-a", nodeId: "host-a", startedAt: 1 } as const;
		const member = await store.acquire(memberSubject, "broker-a", 30_000);
		assert.equal(member.status, "acquired");
		const presences = [];
		for (let i = 0; i < 5; i++) {
			const subject = {
				kind: "presence" as const,
				targetIdentity: `["return","s-${i}","default"]`,
				session: { id: `id-${i}`, name: `s-${i}`, cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
			};
			const acquired = await store.acquire(subject, "broker-a", 30_000);
			assert.equal(acquired.status, "acquired");
			presences.push({ lease: acquired.lease, subject });
		}
		// Release the 3rd presence lease so its renewal reports stale alongside live renewals.
		const released = await store.release(presences[2]!.lease);
		assert.equal(released.status, "released");

		const txSpy = vi.spyOn(database, "transaction");
		const results = await store.renewMany!([
			{ lease: member.lease },
			...presences.map(({ lease, subject }) => ({ lease, subject })),
			{ lease: member.lease, subject: presences[0]!.subject },
		]);

		assert.equal(txSpy.mock.calls.length, 1, "all 6 valid renewals execute inside one transaction");
		assert.deepEqual(
			results.map((r) => r.status),
			["renewed", "renewed", "renewed", "stale", "renewed", "renewed", "invalid"],
		);
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
});

test("only renewals commit without waiting for the disk: acquisitions and releases stay durable (#6560)", async () => {
	const directory = makeTempDirectory("intercom-sql-leases-durability-");
	const database = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	try {
		const store = await openSqlBrokerLeaseStore({ database, prefix: "" });
		const txSpy = vi.spyOn(database, "transaction");
		const relaxed = () => txSpy.mock.calls.map(([, options]) => options?.relaxedDurability === true);
		const subject = { kind: "broker", brokerId: "broker-a", nodeId: "host-a", startedAt: 1 } as const;
		const acquired = await store.acquire(subject, "broker-a", 30_000);
		assert.equal(acquired.status, "acquired");
		assert.ok(relaxed().length > 0 && relaxed().every((flag) => !flag), "an acquisition is durable");
		txSpy.mockClear();
		assert.equal((await store.renew(acquired.lease)).status, "renewed");
		assert.equal((await store.renew(acquired.lease, subject)).status, "renewed");
		assert.deepEqual(
			(await store.renewMany!([{ lease: acquired.lease }])).map((result) => result.status),
			["renewed"],
		);
		assert.deepEqual(relaxed(), [true, true, true]);
		txSpy.mockClear();
		assert.equal((await store.release(acquired.lease)).status, "released");
		assert.deepEqual(relaxed(), [false]);
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
});
