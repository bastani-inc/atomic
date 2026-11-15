import assert from "node:assert/strict";
import { join } from "node:path";
import { type SqliteDatabase, StoragePrefixError, StorageProvider } from "@bastani/atomic/storage";
import { describe, test } from "vitest";
import {
	POSTGRES_MAX_STORAGE_PREFIX_LENGTH,
	POSTGRES_STORAGE_IDENTIFIER_SUFFIXES,
} from "../../packages/coding-agent/src/core/storage/prefix.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openDatabaseWakeUpBus } from "../../packages/intercom/broker/database-wake-up-bus.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { openSqlHeldSendStore } from "../../packages/intercom/broker/sql-held-send-store.js";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import { openSqlPendingAskStore } from "../../packages/intercom/broker/sql-pending-ask-store.js";
import { openSqlReleasedAskStore } from "../../packages/intercom/broker/sql-released-ask-store.js";
import { openSqlRestoringReservationStore } from "../../packages/intercom/broker/sql-restoring-reservation-store.js";
import { openSqlSentMessageAuthority } from "../../packages/intercom/broker/sql-sent-message-authority.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { type PostgresScope, postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { moduleDir } from "../helpers/runtime.js";

type OpenReservationStore = typeof openSqlRestoringReservationStore;
/** The reservation store as it was before #5067, loaded by path so it is not type-checked against this version. */
const earlierStore = join(
	moduleDir(import.meta.url),
	"../fixtures/intercom-0.9.88-pre-5067/broker/sql-restoring-reservation-store.ts",
);
const openEarlierReservationStore = async (...args: Parameters<OpenReservationStore>) =>
	(
		(await import(earlierStore)) as { openSqlRestoringReservationStore: OpenReservationStore }
	).openSqlRestoringReservationStore(...args);

/** Postgres's identifier limit in bytes; longer names are truncated. */
const POSTGRES_IDENTIFIER_BYTES = 63;

const prefixOfLength = (length: number) => `${"p".repeat(length - 1)}_`;

/** Opens every store Atomic keeps on a PostgreSQL database: sessions, the run journal and the Intercom broker state. */
async function openEveryStore(scope: PostgresScope, prefix: string): Promise<void> {
	const database = await scope.open();
	await (await SqlSessionStore.open(database, { prefix })).close();
	await (await SqlRunJournal.open(database, { prefix })).close();
	for (const open of [
		openSqlBrokerLeaseStore,
		openSqlOutboxStore,
		openSqlHeldSendStore,
		openSqlRestoringReservationStore,
		openSqlPendingAskStore,
		openSqlReleasedAskStore,
		openSqlSentMessageAuthority,
		openSqlKnownSessionStore,
	])
		await open({ database, prefix });
	await (await openDatabaseWakeUpBus({ openDatabase: () => scope.open(), prefix })).close();
}

/**
 * Every identifier Atomic named in the database: tables, indexes, triggers and trigger functions. Constraint names,
 * the indexes behind them and identity sequences are left out: Postgres chooses those itself and keeps them unique.
 */
async function createdIdentifiers(database: SqliteDatabase): Promise<string[]> {
	const rows = await database.all(`
		SELECT relname AS name FROM pg_class c WHERE relnamespace = 'public'::regnamespace AND (relkind = 'r'
			OR relkind = 'i' AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = c.oid))
		UNION SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
		UNION SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
		ORDER BY 1`);
	return rows.map((row) => String(row.name));
}

const tooLong = (prefix: string) => (error: Error) => {
	assert.ok(error instanceof StoragePrefixError, String(error));
	assert.equal(error.reason, "too-long");
	assert.equal(error.prefix, prefix);
	return true;
};

describe.skipIf(postgresSkipReason !== undefined)("Postgres storage prefix length (#5067)", () => {
	for (const length of [25, 33])
		test(`a ${length}-character prefix is refused before anything is created (#5067)`, async () => {
			await withPostgresDatabase(async (scope) => {
				const database = await scope.open();
				const prefix = prefixOfLength(length);
				const provider = new StorageProvider({
					memory: () => assert.fail("a database selection opens no memory journal"),
					sql: (database, options) => SqlRunJournal.open(database, options),
				});
				const context = { agentDir: "/unused", domain: "sessions" } as const;
				await assert.rejects(
					provider.openSessionStore({ kind: "database", database, prefix }, context),
					tooLong(prefix),
				);
				await assert.rejects(
					provider.openRunJournal({ kind: "database", database, prefix }, { ...context, domain: "journal" }),
					tooLong(prefix),
				);
				await assert.rejects(SqlSessionStore.open(database, { prefix }), tooLong(prefix));
				await assert.rejects(SqlRunJournal.open(database, { prefix }), tooLong(prefix));
				await assert.rejects(
					openIntercomBrokerState({ prefix, openDatabase: () => scope.open() }),
					tooLong(prefix),
				);
				assert.deepEqual(await createdIdentifiers(database), []);
			});
		});

	for (const length of [18, 24])
		test(`a store created before #5067 with a ${length}-character prefix opens, migrates and works (#5067)`, async () => {
			await withPostgresDatabase(async (scope) => {
				const database = await scope.open();
				const prefix = prefixOfLength(length);
				const table = `${prefix}intercom_restoring_reservations`;
				const earlierIndex = `${table}_wake_requested`.slice(0, POSTGRES_IDENTIFIER_BYTES);
				const earlier = await openEarlierReservationStore({ database, prefix });
				const reserved = await earlier.reserve({
					reservationKey: "reservation",
					ownerSessionId: "owner",
					ownerBrokerId: "broker",
					childName: "child",
					childTarget: "child",
					aliases: [],
					group: "group",
					dormant: false,
					wake: true,
				});
				assert.equal(reserved.status, "reserved");
				assert.ok((await createdIdentifiers(database)).includes(earlierIndex));
				const indexOid = async (name: string) =>
					(await database.get("SELECT to_regclass(?)::oid AS oid", name))?.oid;
				const earlierOid = await indexOid(earlierIndex);

				await openEveryStore(scope, prefix);
				// Renamed in place, not rebuilt.
				assert.equal(await indexOid(`${table}_wake`), earlierOid);
				const suffixes = async () =>
					(await createdIdentifiers(database)).map((name) => name.slice(prefix.length)).sort();
				assert.deepEqual(await suffixes(), [...POSTGRES_STORAGE_IDENTIFIER_SUFFIXES].sort());

				// A broker of the earlier version recreates its index beside the renamed one; the next open drops it.
				await openEarlierReservationStore({ database, prefix });
				assert.ok((await createdIdentifiers(database)).includes(earlierIndex));
				const store = await openSqlRestoringReservationStore({ database, prefix });
				assert.deepEqual(await suffixes(), [...POSTGRES_STORAGE_IDENTIFIER_SUFFIXES].sort());

				assert.deepEqual(await store.requestWake("reservation"), { status: "requested" });
				assert.deepEqual(await store.takeWakeRequests("broker"), {
					status: "taken",
					requests: [{ reservationKey: "reservation", ownerSessionId: "owner", childName: "child" }],
				});
			});
		});

	test("the longest prefix allowed opens every store, and every identifier created is listed (#5067)", async () => {
		await withPostgresDatabase(async (scope) => {
			const prefix = prefixOfLength(POSTGRES_MAX_STORAGE_PREFIX_LENGTH);
			await openEveryStore(scope, prefix);
			const created = await createdIdentifiers(await scope.open());
			for (const name of created) {
				assert.ok(Buffer.byteLength(name) <= POSTGRES_IDENTIFIER_BYTES, name);
				assert.ok(name.startsWith(prefix), name);
			}
			assert.deepEqual(
				created.map((name) => name.slice(prefix.length)).sort(),
				[...POSTGRES_STORAGE_IDENTIFIER_SUFFIXES].sort(),
			);
		});
	});
});
