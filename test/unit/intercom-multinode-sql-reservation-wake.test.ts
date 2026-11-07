import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase, type SqliteRow } from "@bastani/atomic/storage";
import { afterEach, describe, test } from "vitest";
import {
	type RestoringReservationStore,
	reservationKeyFor,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { borrowedDatabase } from "../../packages/intercom/broker/open-broker-state.js";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import { openSqlRestoringReservationStore } from "../../packages/intercom/broker/sql-restoring-reservation-store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const TABLE = "intercom_restoring_reservations";

type ColumnInfo = SqliteRow & {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
};

type IndexInfo = SqliteRow & {
	name: string;
	sql: string;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openDatabase(): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("intercom-sql-reservation-wake-");
	const database = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	cleanups.push(async () => {
		await database.close();
		removeTempDirectory(directory);
	});
	return database;
}

const columnsOf = (database: SqliteDatabase, table = TABLE) => database.all<ColumnInfo>(`PRAGMA table_info(${table})`);

const indexesOf = (database: SqliteDatabase, table = TABLE) =>
	database.all<IndexInfo>(
		"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
		table,
	);

const OLD_SCHEMA = `
	CREATE TABLE ${TABLE}(
		reservation_key TEXT PRIMARY KEY,
		"order" INTEGER NOT NULL,
		owner_session_id TEXT NOT NULL,
		owner_broker_id TEXT NOT NULL,
		child_name TEXT NOT NULL,
		child_target TEXT NOT NULL,
		targets_json TEXT NOT NULL,
		"group" TEXT NOT NULL,
		dormant INTEGER NOT NULL,
		fencing_token INTEGER NOT NULL,
		gone TEXT,
		renewed_at INTEGER NOT NULL,
		end_json TEXT,
		ended_at INTEGER
	);
	CREATE INDEX ${TABLE}_active ON ${TABLE}(end_json, "order");
	CREATE TABLE intercom_restoring_reservation_counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
	INSERT INTO intercom_restoring_reservation_counters(name, value) VALUES ('order', 1), ('token', 1);
	INSERT INTO ${TABLE}(reservation_key, "order", owner_session_id, owner_broker_id, child_name, child_target,
		targets_json, "group", dormant, fencing_token, gone, renewed_at, end_json, ended_at)
	VALUES ('legacy', 1, 'owner', 'broker', '"legacy-child"', 'legacy-child', '["legacy-child"]', 'crew', 0, 1, NULL,
		CAST(unixepoch('subsec') * 1000 AS INTEGER), NULL, NULL);
`;

function failingAlter(
	database: SqliteDatabase,
	failure: () => unknown,
	staleColumns = false,
): { readonly database: SqliteDatabase; readonly alters: string[] } {
	const borrowed = borrowedDatabase(database);
	const alters: string[] = [];
	return {
		alters,
		database: {
			...borrowed,
			all: (async (sql: string, ...params: never[]) =>
				staleColumns && sql.startsWith("PRAGMA table_info")
					? []
					: borrowed.all(sql, ...params)) as SqliteDatabase["all"],
			exec: async (sql) => {
				if (sql.startsWith("ALTER TABLE")) {
					alters.push(sql);
					throw failure();
				}
				return borrowed.exec(sql);
			},
		},
	};
}

describe("SQL reservation store wake schema (#4326)", () => {
	test("a new table has the wake columns and both partial indexes (#4326)", async () => {
		const database = await openDatabase();
		await openSqlRestoringReservationStore({ database, prefix: "" });
		const columns = await columnsOf(database);
		for (const name of ["wake", "wake_requested", "wake_generation"]) {
			const column = columns.find((existing) => existing.name === name);
			assert.deepEqual(column && { type: column.type, notnull: column.notnull, dflt: column.dflt_value }, {
				type: "INTEGER",
				notnull: 1,
				dflt: "0",
			});
		}
		const indexes = await indexesOf(database);
		const child = indexes.find((index) => index.name === `${TABLE}_child`);
		const wakeRequested = indexes.find((index) => index.name === `${TABLE}_wake_requested`);
		assert.match(child?.sql ?? "", /\(child_target\) WHERE end_json IS NULL$/);
		assert.match(wakeRequested?.sql ?? "", /\(owner_broker_id\) WHERE wake_requested = 1$/);
	});

	test("a table from an older broker gets the wake columns and keeps its rows readable as not wakeable (#4326)", async () => {
		const database = await openDatabase();
		await database.exec(OLD_SCHEMA);
		assert.deepEqual(
			(await columnsOf(database)).map((column) => column.name).filter((name) => name.startsWith("wake")),
			[],
		);
		const store = await openSqlRestoringReservationStore({ database, prefix: "" });
		assert.deepEqual(
			(await columnsOf(database)).map((column) => column.name).filter((name) => name.startsWith("wake")),
			["wake", "wake_requested", "wake_generation"],
		);
		assert.deepEqual(
			await database.get(`SELECT wake, wake_requested FROM ${TABLE} WHERE reservation_key = 'legacy'`),
			{
				wake: 0,
				wake_requested: 0,
			},
		);
		const read = await store.read("legacy");
		assert.equal(read.status === "active" && read.reservation.wake, false);
		assert.deepEqual(await store.requestWake("legacy"), { status: "not-wakeable" });
		assert.deepEqual(
			(await indexesOf(database)).map((index) => index.name).filter((name) => name.endsWith("_wake_requested")),
			[`${TABLE}_wake_requested`],
		);
	});

	test("opening a current table again adds no column (#4326)", async () => {
		const database = await openDatabase();
		await openSqlRestoringReservationStore({ database, prefix: "" });
		const wrapped = failingAlter(database, () => new Error("must not be reached"));
		await openSqlRestoringReservationStore({ database: wrapped.database, prefix: "" });
		assert.deepEqual(wrapped.alters, []);
	});

	test("opening an old table adds each wake column once (#4326)", async () => {
		const database = await openDatabase();
		await database.exec(OLD_SCHEMA);
		const borrowed = borrowedDatabase(database);
		const alters: string[] = [];
		await openSqlRestoringReservationStore({
			database: {
				...borrowed,
				exec: async (sql) => {
					if (sql.startsWith("ALTER TABLE")) alters.push(sql);
					return borrowed.exec(sql);
				},
			},
			prefix: "",
		});
		assert.deepEqual(alters, [
			`ALTER TABLE ${TABLE} ADD COLUMN wake INTEGER NOT NULL DEFAULT 0`,
			`ALTER TABLE ${TABLE} ADD COLUMN wake_requested INTEGER NOT NULL DEFAULT 0`,
			`ALTER TABLE ${TABLE} ADD COLUMN wake_generation INTEGER NOT NULL DEFAULT 0`,
		]);
	});

	test("a column another broker added meanwhile is not an error, however the driver words it (#4326)", async () => {
		const wordings: Array<() => unknown> = [
			() => new Error("SQLITE_ERROR: duplicate column name: wake"),
			() => new Error("statement failed", { cause: "duplicate column name: wake" }),
			() => new Error("statement failed", { cause: new Error("Duplicate Column Name: wake") }),
		];
		for (const wording of wordings) {
			const database = await openDatabase();
			await openSqlRestoringReservationStore({ database, prefix: "" });
			const wrapped = failingAlter(database, wording, true);
			await openSqlRestoringReservationStore({ database: wrapped.database, prefix: "" });
			assert.equal(wrapped.alters.length, 3);
		}
	});

	test("any other failure while adding a column is raised (#4326)", async () => {
		const failures: Array<() => unknown> = [
			() => new Error("database is locked"),
			() => new Error("statement failed", { cause: "disk I/O error" }),
			() => "duplicate column name: wake",
		];
		for (const failure of failures) {
			const database = await openDatabase();
			await database.exec(OLD_SCHEMA);
			const wrapped = failingAlter(database, failure);
			await assert.rejects(openSqlRestoringReservationStore({ database: wrapped.database, prefix: "" }));
			assert.equal(wrapped.alters.length, 1);
		}
	});
});

describe("SQL reservation store wake rows (#4326)", () => {
	async function open(): Promise<{ readonly store: RestoringReservationStore; readonly database: SqliteDatabase }> {
		const database = await openDatabase();
		return { store: await openSqlRestoringReservationStore({ database, prefix: "" }), database };
	}

	const base = {
		ownerSessionId: "owner",
		ownerBrokerId: "broker-a",
		childName: "child",
		childTarget: "child",
		aliases: [] as string[],
		group: "crew",
		dormant: false,
	};

	test("a wake claim survives taking its notice, while later sends and new wake epochs remain wakeable (#4488)", async () => {
		const { store, database } = await open();
		const location = await database.get<SqliteRow & { file: string }>("PRAGMA database_list");
		assert.ok(location);
		const peerDatabase = await openNodeSqliteDatabase(location.file);
		cleanups.push(() => peerDatabase.close());
		const peer = await openSqlRestoringReservationStore({ database: peerDatabase, prefix: "" });
		const request = { ...base, reservationKey: "released:child", wake: true };
		await store.reserve(request);
		const read = await store.read(request.reservationKey);
		assert.equal(read.status, "active");
		if (read.status !== "active") return;
		const claim = {
			fencingToken: read.reservation.fencingToken,
			wakeGeneration: read.reservation.wakeGeneration,
			messageId: "send-1",
		};
		const claims = await Promise.all([
			store.requestWake(request.reservationKey, claim),
			peer.requestWake(request.reservationKey, claim),
		]);
		assert.equal(claims.filter((result) => result.status === "requested").length, 1);
		const first = await store.takeWakeRequests(base.ownerBrokerId);
		assert.equal(first.status === "taken" && first.requests.length, 1);
		assert.deepEqual(await peer.requestWake(request.reservationKey, claim), { status: "not-wakeable" });
		assert.deepEqual(await store.takeWakeRequests(base.ownerBrokerId), { status: "taken", requests: [] });
		assert.deepEqual(await peer.requestWake(request.reservationKey, { ...claim, messageId: "send-2" }), {
			status: "requested",
		});
		await store.takeWakeRequests(base.ownerBrokerId);

		await store.reserve({ ...request, wake: false });
		await store.reserve(request);
		assert.deepEqual(
			await peer.requestWake(request.reservationKey, claim),
			{ status: "not-wakeable" },
			"a delayed sender cannot claim a later release",
		);
		const later = await store.read(request.reservationKey);
		assert.equal(later.status, "active");
		if (later.status !== "active") return;
		assert.ok(later.reservation.wakeGeneration > claim.wakeGeneration);
		const nextClaim = { ...claim, wakeGeneration: later.reservation.wakeGeneration };
		assert.deepEqual(
			await store.requestWake(request.reservationKey, nextClaim),
			{ status: "requested" },
			"the same still-waiting send can wake a new epoch",
		);
		await store.takeWakeRequests(base.ownerBrokerId);
		await store.reserve({ ...request, ownerBrokerId: "replacement-broker" });
		const moved = await store.read(request.reservationKey);
		assert.equal(moved.status, "active");
		if (moved.status !== "active") return;
		assert.deepEqual(
			await peer.requestWake(request.reservationKey, { ...claim, wakeGeneration: moved.reservation.wakeGeneration }),
			{ status: "requested" },
			"a replacement broker replays a lost wake",
		);
	});

	test("the wake flag round-trips through insert and update and stays out of unrelated rows (#4326)", async () => {
		const { store, database } = await open();
		await store.reserve({ ...base, reservationKey: "a", wake: true });
		await store.reserve({ ...base, reservationKey: "b", childName: "other", childTarget: "other", wake: false });
		assert.deepEqual(
			await database.all(`SELECT reservation_key, wake, wake_requested FROM ${TABLE} ORDER BY reservation_key`),
			[
				{ reservation_key: "a", wake: 1, wake_requested: 0 },
				{ reservation_key: "b", wake: 0, wake_requested: 0 },
			],
		);
		await store.reserve({ ...base, reservationKey: "a", wake: false });
		const read = await store.read("a");
		assert.equal(read.status === "active" && read.reservation.wake, false);
		await store.reserve({ ...base, reservationKey: "a", wake: true });
		const again = await store.read("a");
		assert.equal(again.status === "active" && again.reservation.wake, true);
	});

	test("a wake request is taken once by the owning broker and only for live wake reservations (#4326)", async () => {
		const { store, database } = await open();
		await store.reserve({ ...base, reservationKey: "first", wake: true });
		await store.reserve({ ...base, reservationKey: "second", childName: "two", childTarget: "two", wake: true });
		await store.reserve({
			...base,
			reservationKey: "foreign",
			ownerBrokerId: "broker-b",
			childName: "three",
			childTarget: "three",
			wake: true,
		});
		await store.reserve({ ...base, reservationKey: "plain", childName: "four", childTarget: "four", wake: false });
		assert.deepEqual(await store.requestWake("plain"), { status: "not-wakeable" });
		assert.deepEqual(await store.requestWake("missing"), { status: "not-wakeable" });
		for (const key of ["second", "first", "foreign"])
			assert.deepEqual(await store.requestWake(key), { status: "requested" });
		assert.deepEqual(await store.takeWakeRequests("broker-a"), {
			status: "taken",
			requests: [
				{ reservationKey: "first", ownerSessionId: "owner", childName: "child" },
				{ reservationKey: "second", ownerSessionId: "owner", childName: "two" },
			],
		});
		assert.deepEqual(await store.takeWakeRequests("broker-a"), { status: "taken", requests: [] });
		assert.deepEqual(await database.all(`SELECT reservation_key FROM ${TABLE} WHERE wake_requested = 1`), [
			{ reservation_key: "foreign" },
		]);
		assert.deepEqual(await store.takeWakeRequests("broker-b"), {
			status: "taken",
			requests: [{ reservationKey: "foreign", ownerSessionId: "owner", childName: "three" }],
		});
	});
});

describe("SQL reservation consumption of released and dormant rows (#4326)", () => {
	const crew = ["crew"];
	const reserveRow = async (
		store: RestoringReservationStore,
		reservationKey: string,
		ownerSessionId: string,
		dormant: boolean,
	) => {
		const reserved = await store.reserve({
			reservationKey,
			ownerSessionId,
			ownerBrokerId: "broker-a",
			childName: "child",
			childTarget: "child",
			aliases: [],
			group: "crew",
			dormant,
			wake: false,
		});
		assert.equal(reserved.status, "reserved");
	};

	async function seeded() {
		const database = await openDatabase();
		const store = await openSqlRestoringReservationStore({ database, prefix: "" });
		const releasedKey = releasedReservationKey("child");
		await reserveRow(store, "live", "owner-live", false);
		await reserveRow(store, releasedKey, "owner-released", false);
		await reserveRow(store, "dormant", "owner-dormant", true);
		return { store, releasedKey };
	}

	test("a registration by name consumes the released row of its owner's child and the dormant row, never a live one (#4326)", async () => {
		const { store, releasedKey } = await seeded();
		const consumed = await store.consume("unrelated", {
			childTarget: "child",
			groups: crew,
			authorizedBy: "owner-released",
		});
		assert.deepEqual(consumed, { status: "consumed", reservationKeys: [releasedKey, "dormant"] });
		const live = await store.read("live");
		assert.equal(live.status, "active");
	});

	test("a registration that has no capability consumes no released row (#4326)", async () => {
		const { store, releasedKey } = await seeded();
		const consumed = await store.consume("unrelated", { childTarget: "child", groups: crew, releasedOnly: true });
		assert.deepEqual(consumed, { status: "consumed", reservationKeys: [] });
		assert.equal((await store.read(releasedKey)).status, "active");
		assert.equal((await store.read("dormant")).status, "active");
		assert.equal((await store.read("live")).status, "active");
	});

	test("a registration whose capability another session issued leaves the released row of the child it names (#4326)", async () => {
		const { store, releasedKey } = await seeded();
		const consumed = await store.consume("unrelated", {
			childTarget: "child",
			groups: crew,
			authorizedBy: "owner-impostor",
		});
		assert.deepEqual(consumed, { status: "consumed", reservationKeys: ["dormant"] });
		assert.equal((await store.read(releasedKey)).status, "active");
	});

	test("a registration outside the groups of a released row leaves it (#4326)", async () => {
		const { store } = await seeded();
		const consumed = await store.consume("unrelated", { childTarget: "child", groups: ["elsewhere"] });
		assert.deepEqual(consumed, { status: "consumed", reservationKeys: [] });
	});

	test("a registration ends by name only the rows inserted up to the mark it read as it began (#4488)", async () => {
		const database = await openDatabase();
		const store = await openSqlRestoringReservationStore({ database, prefix: "" });
		const releasedKey = releasedReservationKey("child");
		const before = await store.insertionMark();
		// The child is released after its registration began: its owner's reservation is inserted after the mark.
		await reserveRow(store, releasedKey, "owner-released", true);
		const after = await store.insertionMark();
		assert.equal(after, before + 1);
		const registered = { childTarget: "child", groups: crew, authorizedBy: "owner-released" };
		assert.deepEqual(
			await store.consume("unrelated", { ...registered, insertedBy: before }),
			{ status: "consumed", reservationKeys: [] },
			"a reservation inserted after the registration began stays",
		);
		assert.equal((await store.read(releasedKey)).status, "active");
		// An update keeps the reservation's insertion: the mark moves only with inserts.
		await reserveRow(store, releasedKey, "owner-released", false);
		assert.equal(await store.insertionMark(), after);
		assert.deepEqual(await store.consume("unrelated", { ...registered, insertedBy: after }), {
			status: "consumed",
			reservationKeys: [releasedKey],
		});
	});
});

describe("reservation keys (#4326)", () => {
	test("a released child's key is kept as it is and a capability's key is its SHA-256 (#4326)", () => {
		assert.equal(reservationKeyFor("released:child"), "released:child");
		assert.equal(
			reservationKeyFor("abc.capability"),
			createHash("sha256").update("abc.capability", "utf8").digest("hex"),
		);
	});
});
