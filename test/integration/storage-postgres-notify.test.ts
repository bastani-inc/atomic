import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SqliteDatabase, StorageNotificationEvent, StorageNotifications } from "@bastani/atomic/storage";
import { afterAll, beforeAll, describe, test } from "vitest";
import { LISTEN_PROBE_TIMEOUT_MS } from "../../packages/storage-postgres/listen.js";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import {
	openPostgresAdmin,
	postgresSkipReason,
	postgresTestPassword,
	postgresUrlFor,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";

/** How long a committed notification may take to reach a listener on the same server. */
const NOTIFY_WAKE_BOUND_MS = 1_000;
/** How long the listening connection may take to connect and pass its probe. */
const LISTENING_BOUND_MS = 5_000;
/**
 * The test of a listening endpoint notifications never reach (#5218): it opens the database and its listening
 * connection and waits out the adapter's whole probe (`LISTEN_PROBE_TIMEOUT_MS`, 2 s) before the state reads
 * unavailable; its database is created and dropped in hooks, outside this bound. About 2.4 s on an idle machine, database
 * included; the full suite's load stretched it past 10 s, so this leaves room for each connection to take several times
 * `LISTENING_BOUND_MS`.
 */
const UNREACHED_LISTENER_TEST_MS = LISTEN_PROBE_TIMEOUT_MS + 6 * LISTENING_BOUND_MS;
/** The listener's first retry waits a second; a reconnect after a killed connection fits well inside this. */
const RECONNECT_BOUND_MS = 10_000;

function notificationsOf(database: SqliteDatabase): StorageNotifications {
	assert.ok(database.notifications, "a Postgres database delivers notifications");
	return database.notifications;
}

/** Resolves with the first event on `channel` that `accept` takes, or rejects after `timeoutMs`. */
function nextEvent(
	notifications: StorageNotifications,
	channel: string,
	accept: (event: StorageNotificationEvent) => boolean,
	timeoutMs: number,
): Promise<StorageNotificationEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			subscription.close();
			reject(new Error(`no event on ${channel} within ${timeoutMs} ms`));
		}, timeoutMs);
		const subscription = notifications.listen(channel, (event) => {
			if (!accept(event)) return;
			clearTimeout(timer);
			subscription.close();
			resolve(event);
		});
	});
}

async function notifyInTransaction(database: SqliteDatabase, channel: string, payload: string, commit: boolean) {
	const statement = notificationsOf(database).notify(channel, payload);
	await database
		.transaction(async (tx) => {
			await tx.run(statement.sql, ...statement.params);
			if (!commit) throw new Error("rolled back");
		})
		.catch((error: Error) => {
			if (commit || error.message !== "rolled back") throw error;
		});
}

describe.skipIf(postgresSkipReason !== undefined)("Postgres LISTEN/NOTIFY wake-ups (#5103)", () => {
	test("a notification sent in a committed transaction reaches another connection's listener promptly, a rolled-back one never (#5103)", async () => {
		await withPostgresDatabase(async (scope) => {
			const listening = await scope.open();
			const sending = await scope.open();
			const notifications = notificationsOf(listening);
			assert.deepEqual(await notifications.state(), { status: "listening" });
			const payloads: string[] = [];
			const arrivals: number[] = [];
			const subscription = notifications.listen("p_pool_ready", (event) => {
				if (event.kind === "notification") {
					payloads.push(event.payload);
					arrivals.push(performance.now());
				}
			});
			try {
				// The channel is listened to on the open connection before the first send.
				await new Promise((resolve) => setTimeout(resolve, 100));
				await notifyInTransaction(sending, "p_pool_ready", "rolled-back", false);
				const sentAt = performance.now();
				await notifyInTransaction(sending, "p_pool_ready", "root-1", true);
				const deadline = Date.now() + NOTIFY_WAKE_BOUND_MS;
				while (payloads.length === 0 && Date.now() < deadline)
					await new Promise((resolve) => setTimeout(resolve, 5));
				assert.deepEqual(payloads, ["root-1"]);
				assert.ok(arrivals[0]! - sentAt < NOTIFY_WAKE_BOUND_MS);
			} finally {
				subscription.close();
			}
		});
	});

	test("a channel name longer than an identifier is shortened alike for notify and listen (#5103)", async () => {
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			const notifications = notificationsOf(database);
			const channel = `${"p".repeat(60)}_pool_ready`;
			assert.deepEqual(await notifications.state(), { status: "listening" });
			const event = nextEvent(
				notifications,
				channel,
				(event) => event.kind === "notification",
				NOTIFY_WAKE_BOUND_MS * 5,
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			await notifyInTransaction(database, channel, "root", true);
			assert.deepEqual(await event, { kind: "notification", payload: "root" });
		});
	});

	test(
		"a listening connection the server killed reconnects and announces that notifications may have been missed (#5103)",
		async () => {
			await withPostgresDatabase(async (scope) => {
				const database = await scope.open();
				const notifications = notificationsOf(database);
				assert.deepEqual(await notifications.state(), { status: "listening" });
				// Both listeners are added before the kill, so the channel keeps a listener throughout: the reconnect
				// listens to it before it announces "listening", and the notification sent after that announcement
				// cannot race a fresh LISTEN.
				const relistened = nextEvent(
					notifications,
					"p_intercom_wakeups",
					(event) => event.kind === "listening",
					RECONNECT_BOUND_MS,
				);
				const delivered = nextEvent(
					notifications,
					"p_intercom_wakeups",
					(event) => event.kind === "notification",
					RECONNECT_BOUND_MS + NOTIFY_WAKE_BOUND_MS * 5,
				);
				await scope.admin.get(
					"SELECT count(pg_terminate_backend(pid)) AS killed FROM pg_stat_activity WHERE datname = ? AND application_name = 'atomic-listen'",
					scope.name,
				);
				await relistened;
				await notifyInTransaction(database, "p_intercom_wakeups", "broker", true);
				assert.deepEqual(await delivered, { kind: "notification", payload: "broker" });
			});
		},
		RECONNECT_BOUND_MS * 2,
	);

	describe("a database of its own, created and dropped outside the timed test", () => {
		let scope: { readonly name: string; readonly url: string; close(): Promise<void> } | undefined;
		beforeAll(async () => {
			const admin = await openPostgresAdmin();
			const name = `atomic_p2_${randomUUID().replaceAll("-", "")}`;
			await admin.exec(`CREATE DATABASE ${name}`);
			scope = {
				name,
				url: postgresUrlFor(name),
				async close() {
					await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
					await admin.close();
				},
			};
		});
		afterAll(async () => {
			await scope?.close();
		});

		test(
			"a listening endpoint the notifications never reach, as through a transaction pooler, is reported and not used (#5103)",
			async () => {
				// Notifications stay inside one database, so a listener on another never sees the probe the pool sends.
				const database = await openPostgresDatabase({
					url: scope!.url,
					...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
					listenUrl: new URL(scope!.url.replace(`/${scope!.name}`, "/postgres")).href,
				});
				try {
					assert.deepEqual(await notificationsOf(database).state(), { status: "unavailable", reason: "pooler" });
				} finally {
					await database.close();
				}
			},
			UNREACHED_LISTENER_TEST_MS,
		);
	});

	test("an unreachable listening endpoint leaves the database working without notifications (#5103)", async () => {
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open({ listenUrl: "postgres://atomic@127.0.0.1:1/atomic" });
			assert.deepEqual(await notificationsOf(database).state(), {
				status: "unavailable",
				reason: "connection-failed",
			});
			assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
		});
	});
});
