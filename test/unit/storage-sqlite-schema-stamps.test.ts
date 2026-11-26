import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import type { SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ConnectionRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import type { RestoringReservationReserveResult } from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

/**
 * SQLite and libSQL stamp each store's schema setup with the database's schema version, so an open whose schema is
 * current takes no write lock; a stamp is believed only while no change to the schema came after it (#6560).
 */

/** The Intercom broker state as main shipped it before #5218, vendored: a build that records no stamps. */
const earlierBroker = resolve(moduleDir(import.meta.url), "../fixtures/intercom-pre-5218/broker/open-broker-state.ts");

interface BrokerState {
	readonly state: {
		readonly reservations: { reserve(request: object): Promise<RestoringReservationReserveResult> };
		close(): Promise<void>;
	};
	readonly bus: { close(): Promise<void> };
}
type OpenBroker = (source: { openDatabase: () => ReturnType<typeof openNodeSqliteDatabase> }) => Promise<BrokerState>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function databasePath(): string {
	const directory = makeTempDirectory("atomic-schema-stamps-");
	cleanups.push(() => removeTempDirectory(directory));
	return join(directory, "broker.sqlite");
}

/** Counts the write transactions every connection begins until `take`. */
function countBegins() {
	let begins = 0;
	const interception = interceptConnectionRequests((request: ConnectionRequest, send) => {
		if (request.kind === "begin") begins += 1;
		return send(request);
	});
	cleanups.push(() => interception.restore());
	return {
		take() {
			const taken = begins;
			begins = 0;
			return taken;
		},
	};
}

/** Opens the broker state `open` builds on `path`, runs `use`, and closes it. */
async function withBroker<T>(
	open: OpenBroker,
	path: string,
	use: (state: BrokerState["state"]) => Promise<T> = async () => undefined as T,
): Promise<T> {
	const { state, bus } = await open({ openDatabase: () => openNodeSqliteDatabase(path) });
	try {
		return await use(state);
	} finally {
		await bus.close();
		await state.close();
	}
}

const current: OpenBroker = (source) => openIntercomBrokerState(source) as unknown as Promise<BrokerState>;

async function reserve(state: BrokerState["state"], key: string): Promise<number> {
	const reserved = await state.reservations.reserve({
		reservationKey: key,
		ownerSessionId: `owner-${key}`,
		ownerBrokerId: "broker",
		childName: key,
		childTarget: key,
		aliases: [],
		group: "crew",
		dormant: false,
		wake: false,
	});
	assert.equal(reserved.status, "reserved");
	return (reserved as Extract<RestoringReservationReserveResult, { status: "reserved" }>).lease.fencingToken;
}

async function onFile<T>(
	path: string,
	use: (database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>) => Promise<T>,
) {
	const database = await openNodeSqliteDatabase(path);
	try {
		return await use(database);
	} finally {
		await database.close();
	}
}

test("a broker store whose table was dropped after it was stamped is set up again, not believed current (#6560)", async () => {
	const path = databasePath();
	await withBroker(current, path, (state) => reserve(state, "first"));
	// Dropped behind Atomic's back: the stamp still names the store's revision, and the schema version moved on.
	await onFile(path, (database) => database.exec("DROP TABLE intercom_restoring_reservation_counters"));
	const begins = countBegins();
	// Believed, the stamp would skip the setup, and the reservation would find no counters to take its token from.
	assert.equal(await withBroker(current, path, (state) => reserve(state, "second")), 1);
	assert.ok(begins.take() >= 1, "the setup ran under the write lock");
	await withBroker(current, path);
	assert.equal(begins.take(), 0, "stamped again, the next open takes no write lock");
});

test("a build that records no stamps opens a stamped store, and the next open checks what it changed (#6560)", async () => {
	const path = databasePath();
	const earlier = (await import(earlierBroker)).openIntercomBrokerState as OpenBroker;
	await withBroker(current, path, (state) => reserve(state, "first"));
	const begins = countBegins();
	await withBroker(current, path);
	assert.equal(begins.take(), 0, "a current schema is believed");
	// The earlier build sets up the counters table it finds missing, seeds it and takes a token from it, and stamps
	// nothing: the stamps it leaves are those of the schema before its change.
	await onFile(path, (database) => database.exec("DROP TABLE intercom_restoring_reservation_counters"));
	assert.equal(await withBroker(earlier, path, (state) => reserve(state, "earlier")), 1);
	const stamps = await onFile(path, async (database) => ({
		stamped: await database.all<SqliteRow & { version: number }>(
			"SELECT DISTINCT schema_version AS version FROM atomic_schema_stamps",
		),
		now: await database.get<SqliteRow & { schema_version: number }>("PRAGMA schema_version"),
	}));
	assert.ok(
		stamps.stamped.every(({ version }) => version < stamps.now!.schema_version),
		"every stamp is behind the schema the earlier build left",
	);
	begins.take();
	assert.equal(await withBroker(current, path, (state) => reserve(state, "later")), 2);
	assert.ok(begins.take() >= 1, "the stores were checked again under the write lock");
	await withBroker(current, path);
	assert.equal(begins.take(), 0);
	// And the earlier build still opens the store this build stamped again, and reads and writes it.
	assert.equal(await withBroker(earlier, path, (state) => reserve(state, "earlier again")), 3);
});

/** The stamps of the broker's stores, and how many of them a schema change since left behind. */
function stampsOf(path: string) {
	return onFile(path, async (database) => {
		const rows = await database.all<SqliteRow & { domain: string; behind: number }>(
			`SELECT domain, schema_version <> (SELECT schema_version FROM pragma_schema_version) AS behind
			FROM atomic_schema_stamps ORDER BY domain`,
		);
		return { domains: rows.map((row) => row.domain), behind: rows.filter((row) => row.behind === 1).length };
	});
}

test("a broker store whose dropped column an open adds again is stamped again in that open (#6560)", async () => {
	const path = databasePath();
	await withBroker(current, path);
	const stamped = await stampsOf(path);
	assert.equal(stamped.behind, 0);
	await onFile(path, (database) => database.exec("ALTER TABLE intercom_known_sessions DROP COLUMN lost_at"));
	assert.equal((await stampsOf(path)).behind, stamped.domains.length, "the drop left every stamp behind");
	await withBroker(current, path);
	const columns = await onFile(path, (database) =>
		database.all<SqliteRow & { name: string }>("SELECT name FROM pragma_table_info('intercom_known_sessions')"),
	);
	assert.ok(
		columns.some((column) => column.name === "lost_at"),
		"the column is added again",
	);
	// Every store, those whose setups it ran and those the catalog found, is stamped with the schema it left.
	assert.deepEqual(await stampsOf(path), stamped);
	const begins = countBegins();
	await withBroker(current, path);
	assert.equal(begins.take(), 0);
});

test("a store an earlier build set up, which has no stamps, is stamped at this build's first open (#6560)", async () => {
	const path = databasePath();
	const earlier = (await import(earlierBroker)).openIntercomBrokerState as OpenBroker;
	await withBroker(earlier, path, (state) => reserve(state, "earlier"));
	await withBroker(current, path);
	const begins = countBegins();
	assert.equal(await withBroker(current, path, (state) => reserve(state, "current")), 2);
	assert.equal(begins.take(), 1, "the reservation's own transaction only");
});
