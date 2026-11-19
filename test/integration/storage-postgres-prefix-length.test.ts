import assert from "node:assert/strict";
import { join } from "node:path";
import { type SqliteDatabase, StoragePrefixError, StorageProvider } from "@bastani/atomic/storage";
import { describe, test } from "vitest";
import { postgresDialect } from "../../packages/coding-agent/src/core/storage/dialect.js";
import {
	POSTGRES_HASHED_STORAGE_IDENTIFIER_SUFFIXES,
	POSTGRES_MAX_STORAGE_PREFIX_LENGTH,
	POSTGRES_STORAGE_IDENTIFIER_SUFFIXES,
} from "../../packages/coding-agent/src/core/storage/prefix.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SqlSnapshotBlobStore } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
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
import { seedLegacyWorkflowTables } from "../helpers/legacy-store-0990.js";

import { type PostgresScope, postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { moduleDir } from "../helpers/runtime.js";

type OpenReservationStore = typeof openSqlRestoringReservationStore;
/** The reservation store as it was before #5067, loaded by path so it is not type-checked against this version. */
const earlierStore = join(
	moduleDir(import.meta.url),
	"../fixtures/intercom-0.9.88-pre-5067/broker/sql-restoring-reservation-store.ts",
);
/**
 * Opens the reservation store as it was before #5067, and leaves its wake index under the name an earlier build's
 * driver gave it: Postgres's truncation of the whole name. This build's driver sends a name that long as the dialect's
 * hashed form instead (#4793), so the index is renamed to what the earlier build left.
 */
const openEarlierReservationStore = async (...args: Parameters<OpenReservationStore>) => {
	const store = await (
		(await import(earlierStore)) as { openSqlRestoringReservationStore: OpenReservationStore }
	).openSqlRestoringReservationStore(...args);
	const [{ database, prefix = "" }] = args;
	const index = `${prefix}intercom_restoring_reservations_wake_requested`;
	if (index.length > POSTGRES_IDENTIFIER_BYTES)
		await database.exec(
			`DO $$ BEGIN IF to_regclass('${postgresDialect.identifier(index)}') IS NOT NULL THEN ALTER INDEX ${postgresDialect.identifier(index)} RENAME TO ${index.slice(0, POSTGRES_IDENTIFIER_BYTES)}; END IF; END $$`,
		);
	return store;
};

/** Postgres's identifier limit in bytes; longer names are truncated. */
const POSTGRES_IDENTIFIER_BYTES = 63;

const prefixOfLength = (length: number) => `${"p".repeat(length - 1)}_`;

/** The name builds before #5219 gave a name too long to keep whole: its first 54 characters and FNV-1a folded to 32 bits. */
function legacyIdentifier(name: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const character of name)
		hash = ((hash ^ BigInt(character.charCodeAt(0))) * 0x100000001b3n) & ((1n << 64n) - 1n);
	return `${name.slice(0, 54)}_${((hash ^ (hash >> 32n)) & 0xffffffffn).toString(16).padStart(8, "0")}`;
}

/**
 * What follows `prefix` in every identifier the stores create under it: each listed name whole, and each name too long
 * to stay whole as Postgres knows it, its head and a hash of the whole name (#4793).
 */
const expectedSuffixes = (prefix: string) =>
	[...POSTGRES_STORAGE_IDENTIFIER_SUFFIXES, ...POSTGRES_HASHED_STORAGE_IDENTIFIER_SUFFIXES]
		.map((suffix) => postgresDialect.identifier(`${prefix}${suffix}`).slice(prefix.length))
		.sort();

/** Every Intercom store's open function, each of which a caller may use on its own. */
const INTERCOM_STORES = [
	openSqlBrokerLeaseStore,
	openSqlOutboxStore,
	openSqlHeldSendStore,
	openSqlRestoringReservationStore,
	openSqlPendingAskStore,
	openSqlReleasedAskStore,
	openSqlSentMessageAuthority,
	openSqlKnownSessionStore,
] as const;

/** Opens every store Atomic keeps on a PostgreSQL database: sessions, the run journal, the worker pool and the Intercom broker state, as a broker does. */
async function openEveryStore(scope: PostgresScope, prefix: string): Promise<void> {
	const database = await scope.open();
	// Exercise current identifiers alongside a real pre-0.10 schema, including the snapshot trigger upgrade.
	await seedLegacyWorkflowTables(database, { prefix });
	await (await SqlSessionStore.open(database, { prefix })).close();
	const intercom = await openIntercomBrokerState({ prefix, openDatabase: () => scope.open() });
	await intercom.bus.close();
	await intercom.state.close();
}

/**
 * Every identifier Atomic named in the database: tables, indexes, triggers and trigger functions. Constraint names,
 * the indexes behind them and identity sequences are left out: Postgres chooses those itself and keeps them unique.
 */
async function createdIdentifiers(database: SqliteDatabase): Promise<string[]> {
	const rows = await database.all(`
		SELECT relname AS name FROM pg_class c WHERE relnamespace = current_schema()::regnamespace AND (relkind = 'r'
			OR relkind = 'i' AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = c.oid))
		UNION SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
		UNION SELECT proname FROM pg_proc p WHERE pronamespace = current_schema()::regnamespace
			AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
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
				const provider = new StorageProvider();
				const context = { agentDir: "/unused", domain: "sessions" } as const;
				await assert.rejects(
					provider.openSessionStore({ kind: "database", database, prefix }, context),
					tooLong(prefix),
				);
				await assert.rejects(SqlSessionStore.open(database, { prefix }), tooLong(prefix));

				await assert.rejects(
					openIntercomBrokerState({ prefix, openDatabase: () => scope.open() }),
					tooLong(prefix),
				);
				// Opened directly, each Intercom store and the wake-up bus refuse it too.
				for (const open of INTERCOM_STORES) await assert.rejects(open({ database, prefix }), tooLong(prefix));
				await assert.rejects(openDatabaseWakeUpBus({ openDatabase: () => scope.open(), prefix }), tooLong(prefix));
				assert.deepEqual(await createdIdentifiers(database), []);
			});
		});

	test("a prefix with uppercase letters is refused before anything is created, so it never shares its lowercase form's tables (#5218)", async () => {
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			const prefix = "Team_";
			const uppercase = (error: Error) => {
				assert.ok(error instanceof StoragePrefixError, String(error));
				assert.equal(error.reason, "uppercase");
				assert.match(error.message, /team_/);
				return true;
			};
			await assert.rejects(SqlSessionStore.open(database, { prefix }), uppercase);

			await assert.rejects(openIntercomBrokerState({ prefix, openDatabase: () => scope.open() }), uppercase);
			for (const open of INTERCOM_STORES) await assert.rejects(open({ database, prefix }), uppercase);
			assert.deepEqual(await createdIdentifiers(database), []);
			// The lowercase form works.
			await (await SqlSessionStore.open(database, { prefix: "team_" })).close();
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
				assert.deepEqual(await suffixes(), expectedSuffixes(prefix));

				// A broker of the earlier version recreates its index beside the renamed one; the next open drops it.
				await openEarlierReservationStore({ database, prefix });
				assert.ok((await createdIdentifiers(database)).includes(earlierIndex));
				const store = await openSqlRestoringReservationStore({ database, prefix });
				assert.deepEqual(await suffixes(), expectedSuffixes(prefix));

				assert.deepEqual(await store.requestWake("reservation"), { status: "requested" });
				assert.deepEqual(await store.takeWakeRequests("broker"), {
					status: "taken",
					requests: [{ reservationKey: "reservation", ownerSessionId: "owner", childName: "child" }],
				});
			});
		});

	test("under a prefix whose long names once shared a shortened name, each trigger is its own and indexes what it should (#5219)", async () => {
		await withPostgresDatabase(async (scope) => {
			// A valid prefix under which the root snapshot's insert and delete triggers once got one name.
			const prefix = "atomic_team_bmuhhgaaaaaa";
			await openEveryStore(scope, prefix);
			const database = await scope.open();
			const rootSnapshots = `${prefix}wf_runs_pool_root_snapshot`;
			const triggers = await database.all(
				"SELECT tgname FROM pg_trigger WHERE tgrelid = to_regclass(?) AND NOT tgisinternal",
				rootSnapshots,
			);
			assert.equal(triggers.length, 3, "the root snapshot's insert, update and delete triggers");
			const created = await createdIdentifiers(database);
			assert.deepEqual(created.map((name) => name.slice(prefix.length)).sort(), expectedSuffixes(prefix));

			// The insert trigger records the blob a root's snapshot carries, and the delete trigger lets go of it.
			await database.run(
				`INSERT INTO ${prefix}wf_runs(run_id, name, cwd, created_at, status, header_json) VALUES ('root', 'root', '/', 0, 'running', '{}')`,
			);
			await database.run(
				`INSERT INTO ${rootSnapshots}(root, epoch, snapshot) VALUES ('root', 1, ?)`,
				JSON.stringify({ bundle: { blob: "carried-hash" } }),
			);
			const carried = () => database.all(`SELECT owner, hash FROM ${prefix}snapshot_carried_refs`);
			assert.deepEqual(await carried(), [{ owner: "root:root", hash: "carried-hash" }]);
			await database.run(`DELETE FROM ${rootSnapshots} WHERE root = 'root'`);
			assert.deepEqual(await carried(), []);
		});
	});

	test("a database an earlier build left with one of two colliding triggers gets all three, and indexes what it missed (#5219)", async () => {
		await withPostgresDatabase(async (scope) => {
			const prefix = "atomic_team_bmuhhgaaaaaa";
			await openEveryStore(scope, prefix);
			const database = await scope.open();
			const rootSnapshots = `${prefix}wf_runs_pool_root_snapshot`;
			const trigger = (event: string) => `${rootSnapshots}_snapshot_carried_${event}`;
			// What an earlier build left: its insert trigger replaced by its delete trigger of the same name, and the names
			// it gave the others and their functions.
			const insert = trigger("insert");
			assert.equal(legacyIdentifier(insert), legacyIdentifier(trigger("delete")));
			await database.exec(`DROP TRIGGER ${postgresDialect.identifier(insert)} ON ${rootSnapshots}`);
			for (const event of ["update", "delete"])
				await database.exec(
					`ALTER TRIGGER ${postgresDialect.identifier(trigger(event))} ON ${rootSnapshots} RENAME TO ${legacyIdentifier(trigger(event))}`,
				);
			for (const event of ["insert", "update", "delete"])
				await database.exec(
					`ALTER FUNCTION ${postgresDialect.identifier(`${trigger(event)}_fn`)}() RENAME TO ${legacyIdentifier(`${trigger(event)}_fn`)}`,
				);
			await database.run(
				`INSERT INTO ${prefix}wf_runs(run_id, name, cwd, created_at, status, header_json) VALUES ('root', 'root', '/', 0, 'running', '{}')`,
			);
			await database.run(
				`INSERT INTO ${rootSnapshots}(root, epoch, snapshot) VALUES ('root', 1, ?)`,
				JSON.stringify({ bundle: { blob: "missed-hash" } }),
			);
			const carried = () => database.all(`SELECT owner, hash FROM ${prefix}snapshot_carried_refs ORDER BY hash`);
			assert.deepEqual(await carried(), [], "the earlier build's missing insert trigger indexed nothing");

			await openEveryStore(scope, prefix);
			const triggers = await database.all<{ tgname: string }>(
				"SELECT tgname FROM pg_trigger WHERE tgrelid = to_regclass(?) AND NOT tgisinternal ORDER BY 1",
				rootSnapshots,
			);
			assert.deepEqual(
				triggers.map((row) => row.tgname),
				["insert", "update", "delete"].map((event) => postgresDialect.identifier(trigger(event))).sort(),
				"the three triggers under this build's names, none of the earlier build's beside them",
			);
			assert.deepEqual(
				(await createdIdentifiers(database)).map((name) => name.slice(prefix.length)).sort(),
				expectedSuffixes(prefix),
				"no function of the earlier build's is left",
			);
			await (await SqlSnapshotBlobStore.open(database, prefix)).completeIndex();
			assert.deepEqual(
				await carried(),
				[{ owner: "root:root", hash: "missed-hash" }],
				"collection's backfill indexes the row the earlier build missed",
			);
			await database.run(
				`UPDATE ${rootSnapshots} SET snapshot = ? WHERE root = 'root'`,
				JSON.stringify({ bundle: { blob: "new-hash" } }),
			);
			assert.deepEqual(await carried(), [{ owner: "root:root", hash: "new-hash" }]);
			await database.run(`DELETE FROM ${rootSnapshots}`);
			await database.run(
				`INSERT INTO ${rootSnapshots}(root, epoch, snapshot) VALUES ('root', 2, ?)`,
				JSON.stringify({ bundle: { blob: "inserted-hash" } }),
			);
			assert.deepEqual(await carried(), [{ owner: "root:root", hash: "inserted-hash" }]);
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
			assert.deepEqual(created.map((name) => name.slice(prefix.length)).sort(), expectedSuffixes(prefix));
			assert.ok(
				POSTGRES_HASHED_STORAGE_IDENTIFIER_SUFFIXES.every(
					(suffix) => `${prefix}${suffix}`.length > POSTGRES_IDENTIFIER_BYTES,
				),
				"every hashed name is one that does not fit whole under the longest prefix",
			);
		});
	});
});
