import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openSqlRestoringReservationStore } from "../../packages/intercom/broker/sql-restoring-reservation-store.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

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

const indexes = async (database: SqliteDatabase) =>
	(
		await database.all(
			"SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'p_intercom_restoring_reservations_wake%' ORDER BY name",
		)
	).map((row) => row.name);

test("a SQLite reservation store from before #5067 converges on the shorter wake index and keeps working (#5067)", async () => {
	const directory = makeTempDirectory("intercom-wake-index-");
	const database = await openNodeSqliteDatabase(join(directory, "state.sqlite"));
	try {
		const prefix = "p_";
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
		assert.deepEqual(await indexes(database), ["p_intercom_restoring_reservations_wake_requested"]);

		await openSqlRestoringReservationStore({ database, prefix });
		assert.deepEqual(await indexes(database), ["p_intercom_restoring_reservations_wake"]);
		// A broker of the earlier version recreates its index; the next open drops it again.
		await openEarlierReservationStore({ database, prefix });
		const store = await openSqlRestoringReservationStore({ database, prefix });
		assert.deepEqual(await indexes(database), ["p_intercom_restoring_reservations_wake"]);

		assert.deepEqual(await store.requestWake("reservation"), { status: "requested" });
		assert.deepEqual(await store.takeWakeRequests("broker"), {
			status: "taken",
			requests: [{ reservationKey: "reservation", ownerSessionId: "owner", childName: "child" }],
		});
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
});
