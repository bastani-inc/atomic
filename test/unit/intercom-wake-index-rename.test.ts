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

const indexes = async (database: SqliteDatabase, prefix: string) =>
	(
		await database.all(
			"SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE ? ORDER BY name",
			`${prefix}intercom_restoring_reservations_wake%`,
		)
	).map((row) => row.name);

for (const prefix of ["p_", `${"p".repeat(23)}_`])
	test(`a SQLite reservation store from before #5067 with a ${prefix.length}-character prefix converges on the shorter wake index and keeps working (#5067)`, async () => {
		const directory = makeTempDirectory("intercom-wake-index-");
		const database = await openNodeSqliteDatabase(join(directory, "state.sqlite"));
		try {
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
			assert.deepEqual(await indexes(database, prefix), [`${prefix}intercom_restoring_reservations_wake_requested`]);

			await openSqlRestoringReservationStore({ database, prefix });
			assert.deepEqual(await indexes(database, prefix), [`${prefix}intercom_restoring_reservations_wake`]);
			// A broker of the earlier version recreates its index; the next open drops it again.
			await openEarlierReservationStore({ database, prefix });
			const store = await openSqlRestoringReservationStore({ database, prefix });
			assert.deepEqual(await indexes(database, prefix), [`${prefix}intercom_restoring_reservations_wake`]);

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
