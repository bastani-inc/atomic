import assert from "node:assert/strict";
import type { SqliteDatabase, SqliteExecutor } from "@bastani/atomic/storage";
import { describe, test } from "vitest";
import {
	openDatabaseWakeUpBus,
	type WakeUpPollScheduler,
} from "../../packages/intercom/broker/database-wake-up-bus.js";
import type { WakeUpBus, WakeUpEvent, WakeUpHint } from "../../packages/intercom/broker/wake-up-bus.js";
import { registerWakeUpBusConformance } from "../helpers/intercom-multinode-contract.js";
import { type PostgresScope, postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { countRoundTrips } from "../helpers/postgres-round-trips.js";

/** How long a hint may take to reach its broker through a notification, with the poll an hour away. */
const NOTIFIED_WAKE_BOUND_MS = 1_000;
/** A poll interval no test waits for when notifications work. */
const NEVER_POLL_MS = 60 * 60 * 1000;
/** The poll interval of the fallback cases, and how long a hint may take to arrive by that poll alone. */
const FALLBACK_POLL_MS = 300;
const FALLBACK_WAKE_BOUND_MS = FALLBACK_POLL_MS * 10;
/** How long the listening connection may take to connect and pass its probe. */
const LISTENING_BOUND_MS = 5_000;

const PREFIX = "w5103_";

function openBus(scope: PostgresScope, pollIntervalMs: number, listenUrl?: string): Promise<WakeUpBus> {
	return openDatabaseWakeUpBus({
		openDatabase: () => scope.open(listenUrl === undefined ? {} : { listenUrl }),
		prefix: PREFIX,
		pollIntervalMs,
	});
}

/** Subscribes `brokerId` and collects its hints with their arrival times. */
async function collect(bus: WakeUpBus, brokerId: string) {
	const hints: { readonly hint: WakeUpHint; readonly at: number }[] = [];
	const subscribed = await bus.subscribe(brokerId, (event: WakeUpEvent) => {
		if (event.kind === "hint") hints.push({ hint: event.hint, at: performance.now() });
	});
	assert.equal(subscribed.status, "subscribed");
	return {
		hints,
		async until(count: number, timeoutMs: number) {
			const deadline = performance.now() + timeoutMs;
			while (hints.length < count && performance.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 5));
			assert.ok(hints.length >= count, `${hints.length} of ${count} hints arrived within ${timeoutMs} ms`);
		},
	};
}

/** Waits until the bus's database reports its listening connection listening. */
async function listening(scope: PostgresScope): Promise<void> {
	const deadline = Date.now() + LISTENING_BOUND_MS;
	for (;;) {
		const row = await scope.admin.get<{ readonly listeners: number }>(
			"SELECT count(*)::int AS listeners FROM pg_stat_activity WHERE datname = ? AND application_name = 'atomic-listen' AND query LIKE 'LISTEN%intercom_wakeups%'",
			scope.name,
		);
		if ((row?.listeners ?? 0) > 0) return;
		assert.ok(Date.now() < deadline, "the bus never listened");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** `database`, recording each statement it runs outside a transaction that names the wake-up table. */
function recordingWakeUps<T extends SqliteExecutor>(database: T, statements: string[]): T {
	return new Proxy(database, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			if (key === "run" || key === "get" || key === "all")
				return (sql: string, ...params: unknown[]) => {
					if (sql.includes("intercom_wakeups")) statements.push(sql.trim().split(/\s+/)[0]!);
					return value.call(target, sql, ...params);
				};
			if (key === "autocommit")
				return (statement: { readonly sql: string }, ...rest: unknown[]) => {
					if (statement.sql.includes("intercom_wakeups")) statements.push(statement.sql.trim().split(/\s+/)[0]!);
					return value.call(target, statement, ...rest);
				};
			return value.bind(target);
		},
	});
}

describe.skipIf(postgresSkipReason !== undefined)("Intercom wake-ups on Postgres (#5103)", () => {
	registerWakeUpBusConformance(
		(name, body) => test(name, body),
		"database on Postgres with notifications (#5103)",
		async () => {
			let close!: () => void;
			const closed = new Promise<void>((resolve) => {
				close = resolve;
			});
			const opened = new Promise<{ readonly scope: PostgresScope; readonly buses: WakeUpBus[] }>((resolve) => {
				void withPostgresDatabase(async (scope) => {
					resolve({ scope, buses: [] });
					await closed;
				});
			});
			const { scope, buses } = await opened;
			const connections = new Map<WakeUpBus, SqliteDatabase[]>();
			return {
				async connect() {
					const opened: SqliteDatabase[] = [];
					const bus = await openDatabaseWakeUpBus({
						openDatabase: async () => {
							const database = await scope.open();
							opened.push(database);
							return database;
						},
						prefix: PREFIX,
						pollIntervalMs: FALLBACK_POLL_MS,
					});
					connections.set(bus, opened);
					buses.push(bus);
					return bus;
				},
				async interrupt(bus) {
					await connections.get(bus)?.at(-1)?.close();
				},
				async close() {
					await Promise.all(buses.map((bus) => bus.close()));
					close();
				},
			};
		},
	);

	test("a hint reaches its broker through a notification well before the poll would (#5103)", async () => {
		await withPostgresDatabase(async (scope) => {
			const publisher = await openBus(scope, NEVER_POLL_MS);
			const subscriber = await openBus(scope, NEVER_POLL_MS);
			try {
				const received = await collect(subscriber, "broker-b");
				await listening(scope);
				const sentAt = performance.now();
				assert.deepEqual(await publisher.publish({ brokerId: "broker-b", reason: "outbox", version: 7 }), {
					status: "published",
				});
				await received.until(1, NOTIFIED_WAKE_BOUND_MS);
				assert.deepEqual(received.hints[0]!.hint, { brokerId: "broker-b", reason: "outbox", version: 7 });
				assert.ok(received.hints[0]!.at - sentAt < NOTIFIED_WAKE_BOUND_MS);
			} finally {
				await publisher.close();
				await subscriber.close();
			}
		});
	});

	test("with notifications unavailable the poll still delivers every hint (#5103)", async () => {
		await withPostgresDatabase(async (scope) => {
			const unreachable = "postgres://atomic@127.0.0.1:1/atomic";
			const publisher = await openBus(scope, FALLBACK_POLL_MS, unreachable);
			const subscriber = await openBus(scope, FALLBACK_POLL_MS, unreachable);
			try {
				const received = await collect(subscriber, "broker-b");
				await publisher.publish({ brokerId: "broker-b", reason: "outcome", version: 0 });
				await received.until(1, FALLBACK_WAKE_BOUND_MS);
				assert.deepEqual(received.hints[0]!.hint, { brokerId: "broker-b", reason: "outcome", version: 0 });
			} finally {
				await publisher.close();
				await subscriber.close();
			}
		});
	});

	test("a hint published while the listening connection is down arrives by the poll (#5103)", async () => {
		await withPostgresDatabase(async (scope) => {
			const publisher = await openBus(scope, FALLBACK_POLL_MS);
			const subscriber = await openBus(scope, FALLBACK_POLL_MS);
			try {
				const received = await collect(subscriber, "broker-b");
				await listening(scope);
				await scope.admin.get(
					"SELECT count(pg_terminate_backend(pid)) AS killed FROM pg_stat_activity WHERE datname = ? AND application_name = 'atomic-listen'",
					scope.name,
				);
				await publisher.publish({ brokerId: "broker-b", reason: "outbox", version: 1 });
				await received.until(1, FALLBACK_WAKE_BOUND_MS);
			} finally {
				await publisher.close();
				await subscriber.close();
			}
		});
	});

	test("a hint the notification and the poll both find is delivered once (#5103)", async () => {
		await withPostgresDatabase(async (scope) => {
			// A poll interval so short that polls and notifications keep overlapping.
			const publisher = await openBus(scope, 5);
			const subscriber = await openBus(scope, 5);
			try {
				const received = await collect(subscriber, "broker-b");
				await listening(scope);
				const count = 40;
				await Promise.all(
					Array.from({ length: count }, (_, version) =>
						publisher.publish({ brokerId: "broker-b", reason: "outbox", version }),
					),
				);
				await received.until(count, FALLBACK_WAKE_BOUND_MS);
				await new Promise((resolve) => setTimeout(resolve, 200));
				const versions = received.hints.map(({ hint }) => hint.version).sort((a, b) => a - b);
				assert.deepEqual(
					versions,
					Array.from({ length: count }, (_, version) => version),
				);
			} finally {
				await publisher.close();
				await subscriber.close();
			}
		});
	});

	test("a poll takes and deletes its broker's hints in one statement, in the order they were published (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			const unreachable = "postgres://atomic@127.0.0.1:1/atomic";
			let poll: (() => void) | undefined;
			const schedule: WakeUpPollScheduler = (callback) => {
				poll = callback;
				return () => {
					if (poll === callback) poll = undefined;
				};
			};
			const statements: string[] = [];
			const read: string[] = [];
			const publisher = await openBus(scope, NEVER_POLL_MS, unreachable);
			// The reader is read-only, as a replica would be: the poll writes nothing through it.
			const reader = recordingWakeUps(await scope.open(), read);
			const subscriber = await openDatabaseWakeUpBus({
				openDatabase: async () => recordingWakeUps(await scope.open({ listenUrl: unreachable }), statements),
				prefix: PREFIX,
				schedule,
				reader,
			});
			const trips = countRoundTrips();
			try {
				const received = await collect(subscriber, "broker-b");
				for (const version of [1, 2, 3])
					await publisher.publish({ brokerId: "broker-b", reason: "outbox", version });
				await publisher.publish({ brokerId: "broker-c", reason: "outbox", version: 9 });
				const runPoll = async () => {
					statements.length = 0;
					const callback = poll;
					assert.ok(callback, "a poll is armed");
					poll = undefined;
					trips.take();
					callback();
					const deadline = performance.now() + FALLBACK_WAKE_BOUND_MS;
					while (poll === undefined && performance.now() < deadline)
						await new Promise((resolve) => setTimeout(resolve, 5));
					assert.equal(trips.take(), 1, "a poll is one round trip");
					return [...statements];
				};
				assert.deepEqual(await runPoll(), ["DELETE"], "one statement takes and deletes the hints");
				await received.until(3, FALLBACK_WAKE_BOUND_MS);
				assert.deepEqual(
					received.hints.map(({ hint }) => hint.version),
					[1, 2, 3],
				);
				assert.deepEqual(await runPoll(), ["DELETE"], "an empty poll is one statement too");
				assert.deepEqual(read, [], "nothing goes through the reader");
				assert.equal(received.hints.length, 3, "a hint is delivered once");
				assert.deepEqual(
					await (await scope.open()).all(`SELECT broker_id FROM ${PREFIX}intercom_wakeups`),
					[{ broker_id: "broker-c" }],
					"another broker's hint stays",
				);
			} finally {
				trips.restore();
				await publisher.close();
				await subscriber.close();
			}
		});
	});
});
