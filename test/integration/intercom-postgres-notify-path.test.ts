import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterEach, describe, test } from "vitest";
import {
	brokerWakeUpChannel,
	type DatabaseWakeUpBusOptions,
	openDatabaseWakeUpBus,
} from "../../packages/intercom/broker/database-wake-up-bus.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	type BrokerMembershipSubject,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import type { WakeUpBus, WakeUpEvent, WakeUpHint } from "../../packages/intercom/broker/wake-up-bus.js";
import { NOTIFY_COALESCE_MS } from "../../packages/storage-postgres/listen.js";
import {
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { countRoundTrips } from "../helpers/postgres-round-trips.js";

/**
 * The PostgreSQL wake-up path: a hint's notifications go out after its commit, in a transaction of their own, at no
 * extra round trip; each broker listens on a channel of its own as well as the shared one brokers of earlier releases
 * use; the same notification from many commits at once goes out once after them; and a lost notification only delays
 * the hint until the poll.
 */

const PREFIX = "np_";
const TABLE = `${PREFIX}intercom_wakeups`;
/** The schema the test databases keep Atomic's tables in, which names their channels. */
const SCHEMA = "atomic";
/** A poll interval no test waits for: a hint that arrives came by a notification. */
const NEVER_POLL_MS = 60 * 60 * 1000;
/** How long a hint may take to arrive through a notification. */
const NOTIFIED_BOUND_MS = 2_000;
/** How long the listening connections may take to listen. */
const LISTENING_BOUND_MS = 5_000;

const repoRoot = resolve(import.meta.dirname, "../..");
/** The 0.10.11-alpha.2 bus: it listens on the shared channel alone, and its hints name no recipient. */
const previousBus = (await import(
	join(repoRoot, "test/fixtures/intercom-wake-up-bus-0.10.11-alpha.2/broker/database-wake-up-bus.ts")
)) as { openDatabaseWakeUpBus(options: DatabaseWakeUpBusOptions): Promise<WakeUpBus> };

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

/** The name a channel is sent and listened to as in the test databases. */
const physical = (channel: string) => `${SCHEMA}_${channel}`;

/** Opens a bus whose database has a pool and a listening connection of its own, as another process's would. */
let pools = 0;
function openBus(
	scope: PostgresScope,
	open: (options: DatabaseWakeUpBusOptions) => Promise<WakeUpBus> = openDatabaseWakeUpBus,
	options: Partial<DatabaseWakeUpBusOptions> = {},
): Promise<WakeUpBus> {
	const idleTimeoutMs = 300_000 + ++pools;
	return open({
		openDatabase: () => scope.open({ idleTimeoutMs }),
		prefix: PREFIX,
		pollIntervalMs: NEVER_POLL_MS,
		listeningPollIntervalMs: NEVER_POLL_MS,
		...options,
	});
}

/** Subscribes `brokerId` and collects its hints. */
async function collect(bus: WakeUpBus, brokerId: string) {
	const hints: WakeUpHint[] = [];
	const subscribed = await bus.subscribe(brokerId, (event: WakeUpEvent) => {
		if (event.kind === "hint") hints.push(event.hint);
	});
	assert.equal(subscribed.status, "subscribed");
	return {
		hints,
		async until(count: number, timeoutMs = NOTIFIED_BOUND_MS) {
			const deadline = performance.now() + timeoutMs;
			while (hints.length < count && performance.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 5));
			assert.ok(hints.length >= count, `${hints.length} of ${count} hints arrived within ${timeoutMs} ms`);
		},
	};
}

/** A session of its own listening on `channels`, which records every notification it receives. */
async function rawListener(scope: PostgresScope, channels: readonly string[]) {
	const url = new URL(scope.url);
	if (postgresTestPassword !== undefined) url.password = postgresTestPassword;
	const client = new pg.Client({ connectionString: url.href });
	await client.connect();
	const received: { channel: string; payload: string }[] = [];
	client.on("notification", (message) => received.push({ channel: message.channel, payload: message.payload ?? "" }));
	for (const channel of channels) await client.query(`LISTEN "${physical(channel)}"`);
	return { received, close: () => client.end() };
}

/** Waits until `count` listening connections of the scope have listened on their channels. */
async function listening(scope: PostgresScope, count: number): Promise<void> {
	const deadline = Date.now() + LISTENING_BOUND_MS;
	for (;;) {
		const row = await scope.admin.get<{ readonly listeners: number }>(
			"SELECT count(*)::int AS listeners FROM pg_stat_activity WHERE datname = ? AND application_name = 'atomic-listen' AND query LIKE 'LISTEN%intercom_wakeups%'",
			scope.name,
		);
		if ((row?.listeners ?? 0) >= count) break;
		assert.ok(Date.now() < deadline, "the buses never listened");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	// The LISTEN of a broker's own channel follows the shared channel's on the same connection.
	await new Promise((resolve) => setTimeout(resolve, 200));
}

/** Writes the membership leases of `brokers`, each as this release writes it, or as an earlier release did. */
async function members(scope: PostgresScope, brokers: Readonly<Record<string, "current" | "earlier">>) {
	const leases = await openSqlBrokerLeaseStore({ database: await scope.open(), prefix: PREFIX });
	for (const [brokerId, release] of Object.entries(brokers)) {
		const subject: BrokerMembershipSubject = {
			kind: "broker",
			brokerId,
			nodeId: "node",
			startedAt: 1,
			...(release === "current" ? { ownWakeUpChannel: true as const } : {}),
		};
		assert.equal((await leases.acquire(subject, brokerId, BROKER_LEASE_STALE_AFTER_MS)).status, "acquired");
	}
}

/** Records the text of every statement this process's connections send, in order. */
function recordStatements(): string[] {
	const query = pg.Client.prototype.query;
	const texts: string[] = [];
	pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<pg.Client["query"]>) {
		const [first] = args as unknown[];
		texts.push(typeof first === "string" ? first : String((first as { text?: string }).text));
		return Reflect.apply(query, this, args);
	} as pg.Client["query"];
	restores.push(() => {
		pg.Client.prototype.query = query;
	});
	return texts;
}

describe.skipIf(postgresSkipReason !== undefined)("Intercom wake-ups on PostgreSQL: the notify path", () => {
	test("a publish notifies after its commit, in a transaction that waits for no flush, in two round trips", async () => {
		await withPostgresDatabase(async (scope) => {
			const publisher = await openBus(scope);
			try {
				// The pool's connection is open and the hint table's prune ran before counting starts.
				await publisher.publish({ brokerId: "broker-b", reason: "outbox", version: 0 });
				const trips = countRoundTrips();
				restores.push(trips.restore);
				const texts = recordStatements();
				// Another broker than the first publish's, whose notification would otherwise be held back if sent within 5 ms.
				await publisher.publish({ brokerId: "broker-c", reason: "outbox", version: 1, targetIdentity: "alice" });
				assert.equal(trips.take(), 2, "the hint with the transaction's start; the notifications with its commit");
				const commit = texts.indexOf("COMMIT");
				const insert = texts.findIndex((text) => text.includes(`INSERT INTO ${TABLE}`));
				const notify = texts.findIndex((text) => text.includes("pg_notify"));
				assert.ok(insert >= 0 && insert < commit, "the hint is written in the transaction");
				assert.ok(notify > commit, `the notification goes out after the commit: ${JSON.stringify(texts)}`);
				assert.ok(
					texts.slice(commit + 1, notify).some((text) => text.includes("SET LOCAL synchronous_commit TO off")),
					"in a transaction of its own that does not wait for its flush",
				);
			} finally {
				await publisher.close();
			}
		});
	});

	test("an offline recipient's send writes its hint and notifies after its commit, at no extra round trip", async () => {
		await withPostgresDatabase(async (scope) => {
			const { state, bus } = await openIntercomBrokerState(
				{ openDatabase: () => scope.open() },
				{
					pollIntervalMs: NEVER_POLL_MS,
				},
			);
			const presence = {
				kind: "presence",
				targetIdentity: "alice",
				session: { id: "alice", name: "alice", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
			} as const;
			try {
				assert.equal(
					(await state.leases.acquire(presence, "broker-b", BROKER_LEASE_STALE_AFTER_MS)).status,
					"acquired",
				);
				const send = (id: string, wakeHostWithinMs?: number) =>
					state.outbox.enqueue({
						targetIdentity: "alice",
						originBrokerId: "broker-a",
						digest: id,
						frame: {
							type: "message",
							from: presence.session,
							message: { id, timestamp: 1, content: { text: id } },
						},
						...(wakeHostWithinMs === undefined ? {} : { wakeHostWithinMs }),
					});
				assert.equal((await send("m-warm", BROKER_LEASE_STALE_AFTER_MS)).status, "inserted");
				const trips = countRoundTrips();
				restores.push(trips.restore);
				assert.equal((await send("m-plain")).status, "inserted");
				const plainTrips = trips.take();
				const texts = recordStatements();
				// Past the window in which the warm-up's notification to the same broker would hold this one back.
				await new Promise((resolve) => setTimeout(resolve, NOTIFY_COALESCE_MS * 2));
				const woken = await send("m-woken", BROKER_LEASE_STALE_AFTER_MS);
				const wokenTrips = trips.take();
				assert.equal(woken.status === "inserted" && woken.woke, "broker-b");
				assert.equal(wokenTrips, plainTrips + 1, "the hint and its notifications together, in one round trip");
				const commit = texts.indexOf("COMMIT");
				assert.ok(texts.findIndex((text) => text.includes("pg_notify")) > commit);
				const hint = await (await scope.open()).get<{ target_identity: string }>(
					"SELECT target_identity FROM intercom_wakeups ORDER BY id DESC LIMIT 1",
				);
				assert.equal(hint?.target_identity, "alice", "the hint names its recipient");
			} finally {
				await bus.close();
				await state.close();
			}
		});
	});

	test("a broker of this release and one of 0.10.11-alpha.2, which created the hint table, each wake the other's brokers, and only an earlier broker's wake-ups go to every listener", async () => {
		await withPostgresDatabase(async (scope) => {
			// The earlier release creates the hint table, without its recipient column, as on a database it set up.
			const earlier = await openBus(scope, previousBus.openDatabaseWakeUpBus);
			const current = await openBus(scope);
			const toCurrent = await collect(current, "broker-new");
			const toEarlier = await collect(earlier, "broker-old");
			await members(scope, { "broker-new": "current", "broker-old": "earlier" });
			await listening(scope, 2);
			const shared = await rawListener(scope, [TABLE]);
			const own = await rawListener(scope, [brokerWakeUpChannel(TABLE, "broker-new")]);
			try {
				await current.publish({ brokerId: "broker-old", reason: "outbox", version: 1, targetIdentity: "bob" });
				await toEarlier.until(1);
				await current.publish({ brokerId: "broker-new", reason: "outbox", version: 2, targetIdentity: "alice" });
				await toCurrent.until(1);
				assert.deepEqual(toCurrent.hints[0], {
					brokerId: "broker-new",
					reason: "outbox",
					version: 2,
					targetIdentity: "alice",
				});
				await earlier.publish({ brokerId: "broker-new", reason: "outbox", version: 3 });
				await toCurrent.until(2);
				assert.deepEqual(
					toCurrent.hints[1],
					{ brokerId: "broker-new", reason: "outbox", version: 3 },
					"no recipient",
				);
				await earlier.publish({ brokerId: "broker-old", reason: "outcome", version: 0 });
				await toEarlier.until(2);
				await new Promise((resolve) => setTimeout(resolve, 200));
				assert.deepEqual(
					shared.received.map(({ payload }) => payload),
					["broker-old", "broker-new", "broker-old"],
					"this release notifies the shared channel only for a broker that does not listen on its own",
				);
				assert.deepEqual(
					own.received.map(({ payload }) => payload),
					["broker-new"],
					"a broker's own channel carries only its wake-ups",
				);
			} finally {
				await shared.close();
				await own.close();
				await current.close();
				await earlier.close();
			}
		});
	});

	test("a broker no lease names yet is notified on the shared channel too", async () => {
		await withPostgresDatabase(async (scope) => {
			const publisher = await openBus(scope);
			await members(scope, {});
			const shared = await rawListener(scope, [TABLE]);
			try {
				await publisher.publish({ brokerId: "broker-unknown", reason: "outbox", version: 1 });
				const deadline = performance.now() + NOTIFIED_BOUND_MS;
				while (shared.received.length === 0 && performance.now() < deadline)
					await new Promise((resolve) => setTimeout(resolve, 5));
				assert.deepEqual(shared.received, [{ channel: physical(TABLE), payload: "broker-unknown" }]);
			} finally {
				await shared.close();
				await publisher.close();
			}
		});
	});

	test("a notification sent outside a transaction goes out too, after the writes it announces", async () => {
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			const notifications = database.notifications;
			assert.ok(notifications !== undefined);
			const listener = await rawListener(scope, ["outside"]);
			try {
				const notice = notifications.notify("outside", "payload");
				assert.equal((await database.run(notice.sql, ...notice.params)).changes, 0);
				const deadline = performance.now() + NOTIFIED_BOUND_MS;
				while (listener.received.length === 0 && performance.now() < deadline)
					await new Promise((resolve) => setTimeout(resolve, 5));
				assert.deepEqual(listener.received, [{ channel: physical("outside"), payload: "payload" }]);
			} finally {
				await listener.close();
			}
		});
	});

	test("many commits waking one broker at once share notifications, and every hint still arrives by one", async () => {
		await withPostgresDatabase(async (scope) => {
			const publisher = await openBus(scope);
			const subscriber = await openBus(scope);
			const received = await collect(subscriber, "broker-b");
			await members(scope, { "broker-b": "current" });
			await listening(scope, 1);
			const own = await rawListener(scope, [brokerWakeUpChannel(TABLE, "broker-b")]);
			try {
				const count = 40;
				await Promise.all(
					Array.from({ length: count }, (_, version) =>
						publisher.publish({ brokerId: "broker-b", reason: "outbox", version }),
					),
				);
				await received.until(count);
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.ok(own.received.length >= 1, "at least one notification");
				// How many commits share one depends on how close together they commit; the coalescer's own test pins that.
				assert.ok(own.received.length <= count, `${own.received.length} notifications for ${count} commits`);
				assert.deepEqual(
					received.hints.map(({ version }) => version).sort((a, b) => a - b),
					Array.from({ length: count }, (_, version) => version),
				);
			} finally {
				await own.close();
				await publisher.close();
				await subscriber.close();
			}
		});
	});

	test("a notification that is lost after its hint committed only delays the hint until the poll", async () => {
		await withPostgresDatabase(async (scope) => {
			const pollMs = 300;
			const publisher = await openBus(scope);
			const subscriber = await openBus(scope, openDatabaseWakeUpBus, {
				pollIntervalMs: pollMs,
				listeningPollIntervalMs: pollMs,
			});
			const received = await collect(subscriber, "broker-b");
			await members(scope, { "broker-b": "current" });
			await listening(scope, 1);
			const own = await rawListener(scope, [brokerWakeUpChannel(TABLE, "broker-b"), TABLE]);
			// The notifications' transaction is lost, as when the connection breaks right after the hint's commit.
			const query = pg.Client.prototype.query;
			pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<pg.Client["query"]>) {
				const [first] = args as unknown[];
				if (
					typeof first === "object" &&
					first !== null &&
					String((first as { text?: string }).text).includes("pg_notify")
				)
					return Reflect.apply(query, this, [{ text: "SELECT 1", rowMode: "array" }]);
				return Reflect.apply(query, this, args);
			} as pg.Client["query"];
			restores.push(() => {
				pg.Client.prototype.query = query;
			});
			try {
				await publisher.publish({ brokerId: "broker-b", reason: "outbox", version: 7 });
				await received.until(1, pollMs * 10);
				assert.equal(received.hints[0]?.version, 7);
				assert.deepEqual(own.received, [], "no notification went out");
			} finally {
				await own.close();
				await publisher.close();
				await subscriber.close();
			}
		});
	});
});
