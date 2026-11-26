import assert from "node:assert/strict";
import { join } from "node:path";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { OutboxStore, RecipientPresenceSubject } from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import type { SessionInfo } from "../../packages/intercom/types.js";
import { useFixtureStorageAdapter } from "../helpers/fixture-storage-adapter.js";
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
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

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

const fixtureAdapter = useFixtureStorageAdapter();

const openNodeSqliteOutbox = sharedOutboxFixture("node-sqlite", "", (directory) =>
	openNodeSqliteDatabase(join(directory, "shared.sqlite")),
);

const openAdapterOutbox = sharedOutboxFixture("adapter", "team_", async (directory) => {
	const context = { agentDir: directory, domain: "sessions" } as const;
	const adapter = fixtureAdapter();
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

test("a message queued for an offline session is kept when the wake-up hint written with it fails (#5607)", async () => {
	const directory = makeTempDirectory("intercom-outbox-wake-");
	const database = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	try {
		const opened = await openIntercomBrokerState({ openDatabase: async () => database });
		const { state } = opened;
		await opened.bus.close();
		const target = JSON.stringify(["return", "recipient", "team"]);
		const from: SessionInfo = { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };
		const presence: RecipientPresenceSubject = {
			kind: "presence",
			targetIdentity: target,
			session: { ...from, id: "r" },
		};
		assert.equal((await state.leases.acquire(presence, "broker-b", 60_000)).status, "acquired");
		// The hint log cannot take the hint: only the hint's write fails, the message's own writes would succeed.
		await database.exec("DROP TABLE intercom_wakeups");
		const frame = (id: string) =>
			({ type: "message", from, message: { id, timestamp: 1, content: { text: id } } }) as const;
		const request = (id: string) =>
			({
				targetIdentity: target,
				originBrokerId: "broker-a",
				digest: id,
				frame: frame(id),
				wakeHostWithinMs: 60_000,
			}) as const;

		const reserved = await state.reserveAndEnqueue!(
			{ messageId: "m1", digest: "m1", targetIdentity: target },
			request("m1"),
		);
		const queued = await state.outbox.enqueue(request("m2"));

		assert.deepEqual([reserved.status, queued.status], ["inserted", "inserted"]);
		assert.deepEqual(
			[(await state.outbox.read("m1")).status, (await state.outbox.read("m2")).status],
			["found", "found"],
		);
		await state.close();
	} finally {
		await database.close().catch(() => {});
		removeTempDirectory(directory);
	}
});

test("claim skips opening a write transaction when the target has no undelivered outbox rows", async () => {
	const directory = makeTempDirectory("intercom-outbox-empty-claim-");
	const database = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	try {
		const outbox = await openSqlOutboxStore({ database, prefix: "" });
		const txSpy = vi.spyOn(database, "transaction");
		const empty = await outbox.claim({
			claimantId: "broker-a",
			targetIdentity: '["return","idle-session","default"]',
			staleAfterMs: 30_000,
		});
		assert.deepEqual(empty, { status: "claimed", rows: [] });
		assert.equal(txSpy.mock.calls.length, 0, "empty claim performs a read-only check without a write lock");

		const frame = {
			type: "message",
			from: { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
			message: { id: "m-new", timestamp: 1, content: { text: "wake" } },
		} as const;
		await outbox.enqueue({
			targetIdentity: '["return","idle-session","default"]',
			originBrokerId: "broker-b",
			digest: "d-new",
			frame,
		});
		txSpy.mockClear();
		const allSpy = vi.spyOn(database, "all");
		const claimed = await outbox.claim({
			claimantId: "broker-a",
			targetIdentity: '["return","idle-session","default"]',
			staleAfterMs: 30_000,
		});
		assert.equal(claimed.status, "claimed");
		if (claimed.status === "claimed") assert.equal(claimed.rows.length, 1);
		assert.equal(txSpy.mock.calls.length, 0, "non-empty claim needs no transaction");
		assert.deepEqual(
			allSpy.mock.calls.map(([sql]) => /^\s*UPDATE\b/.test(sql)),
			[true],
			"non-empty claim claims atomically in one statement (#6560)",
		);
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
});

test("on SQLite, a recipient's undelivered rows are read from the partial index, and settled rows are pruned from theirs", async () => {
	const directory = makeTempDirectory("intercom-outbox-sqlite-indexes-");
	const database = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	// A broker's open creates the indexes, once every store's tables are there.
	const opened = await openIntercomBrokerState({ openDatabase: async () => database });
	try {
		const { outbox } = opened.state;
		const target = '["return","busy-session","default"]';
		const from = { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };
		for (const id of ["m-1", "m-2"])
			await outbox.enqueue({
				targetIdentity: target,
				originBrokerId: "broker-b",
				digest: id,
				frame: { type: "message", from, message: { id, timestamp: 1, content: { text: id } } },
			});
		const indexes = await database.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'intercom_outbox' AND sql IS NOT NULL ORDER BY name",
		);
		assert.deepEqual(
			indexes.map((index) => index.name),
			["intercom_outbox_settled", "intercom_outbox_undelivered"],
		);
		const statements: { sql: string; params: unknown[] }[] = [];
		for (const method of ["all", "get", "run"] as const) {
			const original = database[method].bind(database) as (sql: string, ...params: unknown[]) => Promise<unknown>;
			vi.spyOn(database, method).mockImplementation(((sql: string, ...params: unknown[]) => {
				statements.push({ sql, params });
				return original(sql, ...params);
			}) as never);
		}
		const claimed = await outbox.claim({ claimantId: "broker-a", targetIdentity: target, staleAfterMs: 30_000 });
		assert.equal(claimed.status === "claimed" && claimed.rows.length, 2);
		assert.equal((await outbox.listUndelivered(target)).status, "listed");
		assert.equal((await outbox.undeliveredPosition(target, "m-2")).status, "positioned");
		await outbox.prune(60_000);
		vi.restoreAllMocks();
		const plans = await Promise.all(
			statements
				.filter(({ sql }) => /\bintercom_outbox\b/.test(sql))
				.map(async ({ sql, params }) => ({
					sql,
					plan: (await database.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(params as never[])))
						.map((row) => row.detail)
						.join("\n"),
				})),
		);
		for (const { sql, plan } of plans) {
			assert.doesNotMatch(plan, /SCAN intercom_outbox(?! USING)/, `a full scan of the outbox for:\n${sql}\n${plan}`);
			if (/target_identity = \? AND state IN \('queued', 'claimed'\)/.test(sql))
				assert.match(plan, /intercom_outbox_undelivered/, `not from the undelivered rows' index:\n${sql}\n${plan}`);
			if (/^\s*DELETE FROM intercom_outbox\b/.test(sql))
				assert.match(plan, /intercom_outbox_settled/, `not from the settled rows' index:\n${sql}\n${plan}`);
		}
		assert.ok(plans.some(({ sql }) => /^\s*DELETE FROM intercom_outbox\b/.test(sql)));
	} finally {
		await opened.bus.close();
		await opened.state.close();
		removeTempDirectory(directory);
	}
});
