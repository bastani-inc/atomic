import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	openDatabaseWakeUpBus,
	WAKE_UP_POLL_INTERVAL_MS,
	WAKE_UP_RECONNECT_MAX_DELAY_MS,
	type WakeUpPollScheduler,
} from "../../packages/intercom/broker/database-wake-up-bus.js";
import type { WakeUpBus, WakeUpEvent } from "../../packages/intercom/broker/wake-up-bus.js";
import { registerWakeUpBusConformance, type WakeUpBusFixture } from "../helpers/intercom-multinode-contract.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Short enough to keep the conformance cases quick, far below the suite's 5 s delivery bound. */
const CONFORMANCE_POLL_INTERVAL_MS = 20;

interface SqliteFile {
	readonly path: string;
	/** Every connection opened on the file, in order, per bus. */
	readonly opened: Map<WakeUpBus, SqliteDatabase[]>;
	connect(options?: { prefix?: string; schedule?: WakeUpPollScheduler }): Promise<WakeUpBus>;
	close(): Promise<void>;
}

function openSqliteFile(): SqliteFile {
	const directory = makeTempDirectory("atomic-intercom-wakeups-");
	const path = join(directory, "storage.sqlite");
	const opened = new Map<WakeUpBus, SqliteDatabase[]>();
	return {
		path,
		opened,
		async connect(options = {}) {
			const connections: SqliteDatabase[] = [];
			const bus = await openDatabaseWakeUpBus({
				openDatabase: async () => {
					const database = await openNodeSqliteDatabase(path);
					connections.push(database);
					return database;
				},
				prefix: options.prefix,
				pollIntervalMs: options.schedule === undefined ? CONFORMANCE_POLL_INTERVAL_MS : undefined,
				schedule: options.schedule,
			});
			opened.set(bus, connections);
			return bus;
		},
		async close() {
			for (const bus of opened.keys()) await bus.close();
			for (const connections of opened.values()) for (const database of connections) await database.close();
			removeTempDirectory(directory);
		},
	};
}

async function openSqliteWakeUpBusFixture(): Promise<WakeUpBusFixture> {
	const file = openSqliteFile();
	return {
		connect: () => file.connect(),
		async interrupt(bus) {
			await file.opened.get(bus)?.at(-1)?.close();
		},
		close: () => file.close(),
	};
}

registerWakeUpBusConformance(test, "database (two connections, one SQLite file)", openSqliteWakeUpBusFixture);

/** Captures the bus's poll timer so a test fires each poll itself and waits until the next one is armed. */
function manualScheduler() {
	const delays: number[] = [];
	let pending: (() => void) | undefined;
	let armed: (() => void) | undefined;
	const schedule: WakeUpPollScheduler = (callback, delayMs) => {
		delays.push(delayMs);
		pending = callback;
		armed?.();
		armed = undefined;
		return () => {
			if (pending === callback) pending = undefined;
		};
	};
	return {
		schedule,
		delays,
		isArmed: () => pending !== undefined,
		/** Run one poll and resolve once it has finished and armed the next. */
		async poll(): Promise<void> {
			const callback = pending;
			assert.ok(callback, "a poll is armed");
			pending = undefined;
			const rearmed = new Promise<void>((resolve) => {
				armed = resolve;
			});
			callback();
			await rearmed;
			await Promise.resolve();
		},
	};
}

function recorder() {
	const events: WakeUpEvent[] = [];
	return { events, listener: (event: WakeUpEvent) => events.push(event) };
}

test("database wake-up bus polls every 500 ms by default and prunes each hint once delivered", async () => {
	const file = openSqliteFile();
	try {
		const scheduler = manualScheduler();
		const subscriber = await file.connect({ prefix: "team_", schedule: scheduler.schedule });
		const publisher = await file.connect({ prefix: "team_" });
		const observer = await openNodeSqliteDatabase(file.path);
		try {
			const pendingHints = async () =>
				(await observer.get<{ count: number }>("SELECT COUNT(*) AS count FROM team_intercom_wakeups"))?.count;
			const received = recorder();
			assert.equal((await subscriber.subscribe("broker-b", received.listener)).status, "subscribed");
			assert.deepEqual(scheduler.delays, [WAKE_UP_POLL_INTERVAL_MS]);
			assert.equal(WAKE_UP_POLL_INTERVAL_MS, 500);

			const hint = { brokerId: "broker-b", reason: "outbox", version: 7 } as const;
			assert.deepEqual(await publisher.publish(hint), { status: "published" });
			assert.equal(await pendingHints(), 1);
			await scheduler.poll();
			assert.deepEqual(received.events, [
				{ kind: "resync", cause: "subscribed" },
				{ kind: "hint", hint },
			]);
			assert.equal(await pendingHints(), 0);

			await scheduler.poll();
			assert.equal(received.events.length, 2, "a pruned hint is not delivered twice");
			await subscriber.close();
			assert.equal(scheduler.isArmed(), false, "close cancels the poll timer");
		} finally {
			await observer.close();
		}
	} finally {
		await file.close();
	}
});

test("database wake-up bus deletes hints nobody consumed once they are older than the retention", async () => {
	const file = openSqliteFile();
	try {
		const publisher = await file.connect();
		const observer = await openNodeSqliteDatabase(file.path);
		try {
			await observer.run(
				"INSERT INTO intercom_wakeups (broker_id, reason, version, created_at) VALUES ('exited-broker', 'outbox', 1, 0)",
			);
			await publisher.publish({ brokerId: "broker-without-subscriber", reason: "outcome", version: 2 });
			assert.deepEqual(await observer.all("SELECT broker_id FROM intercom_wakeups"), [
				{ broker_id: "broker-without-subscriber" },
			]);
		} finally {
			await observer.close();
		}
	} finally {
		await file.close();
	}
});

test("database wake-up bus interrupt closes the poller's connection and the next poll reopens it with a resync", async () => {
	const file = openSqliteFile();
	try {
		const scheduler = manualScheduler();
		const bus = await file.connect({ schedule: scheduler.schedule });
		const received = recorder();
		await bus.subscribe("broker-b", received.listener);
		const [first] = file.opened.get(bus) ?? [];
		assert.ok(first);

		await first.close();
		await assert.rejects(first.get("SELECT 1"));
		await scheduler.poll();
		await scheduler.poll();

		const connections = file.opened.get(bus) ?? [];
		assert.equal(connections.length, 2, "the bus opened a fresh connection");
		assert.deepEqual(await connections[1]?.get("SELECT 1 AS ok"), { ok: 1 });
		assert.deepEqual(received.events, [
			{ kind: "resync", cause: "subscribed" },
			{ kind: "resync", cause: "reconnected" },
		]);
	} finally {
		await file.close();
	}
});

/** More waiting hints than SQLite's default limit of 32,766 bound parameters in one statement. */
const HINT_BACKLOG = 33_000;

test("database wake-up bus drains a hint backlog larger than SQLite's parameter limit in bounded batches", async () => {
	const file = openSqliteFile();
	try {
		const scheduler = manualScheduler();
		const subscriber = await file.connect({ schedule: scheduler.schedule });
		const observer = await openNodeSqliteDatabase(file.path);
		try {
			await observer.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${HINT_BACKLOG})
				INSERT INTO intercom_wakeups (broker_id, reason, version, created_at)
				SELECT 'broker-b', 'outbox', i, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM n`,
			);
			const received = recorder();
			assert.equal((await subscriber.subscribe("broker-b", received.listener)).status, "subscribed");
			await scheduler.poll();
			await new Promise<void>((resolve) => setImmediate(resolve));
			const hints = received.events.filter((event) => event.kind === "hint");
			assert.equal(hints.length, HINT_BACKLOG);
			assert.deepEqual(hints.at(-1), {
				kind: "hint",
				hint: { brokerId: "broker-b", reason: "outbox", version: HINT_BACKLOG },
			});
			assert.equal(
				received.events.some((event) => event.kind === "resync" && event.cause === "reconnected"),
				false,
				"the connection is never dropped",
			);
			assert.deepEqual(await observer.get("SELECT COUNT(*) AS count FROM intercom_wakeups"), { count: 0 });
		} finally {
			await observer.close();
		}
	} finally {
		await file.close();
	}
});

test("database wake-up bus backs off exponentially while the database stays unavailable, then resyncs", async () => {
	const directory = makeTempDirectory("atomic-intercom-wakeups-backoff-");
	const connections: SqliteDatabase[] = [];
	let unavailable = false;
	let openAttempts = 0;
	try {
		const scheduler = manualScheduler();
		const bus = await openDatabaseWakeUpBus({
			openDatabase: async () => {
				openAttempts++;
				if (unavailable) throw new Error("database unavailable");
				const database = await openNodeSqliteDatabase(join(directory, "storage.sqlite"));
				connections.push(database);
				return database;
			},
			schedule: scheduler.schedule,
		});
		const received = recorder();
		await bus.subscribe("broker-b", received.listener);
		unavailable = true;
		await connections[0]?.close();
		const failedPolls = 8;
		for (let poll = 0; poll <= failedPolls; poll++) await scheduler.poll();
		// The poll that finds the connection gone re-arms at the normal interval; each failed reopen doubles the wait.
		const backoff = [2, 4, 8, 16, 32, 64, 128, 256].map((factor) =>
			Math.min(WAKE_UP_POLL_INTERVAL_MS * factor, WAKE_UP_RECONNECT_MAX_DELAY_MS),
		);
		assert.deepEqual(scheduler.delays, [WAKE_UP_POLL_INTERVAL_MS, WAKE_UP_POLL_INTERVAL_MS, ...backoff]);
		assert.equal(scheduler.delays.at(-1), WAKE_UP_RECONNECT_MAX_DELAY_MS);

		const attemptsBeforePublish = openAttempts;
		assert.deepEqual(await bus.publish({ brokerId: "broker-b", reason: "outbox", version: 1 }), {
			status: "unavailable",
		});
		assert.equal(openAttempts, attemptsBeforePublish, "a publish during the backoff does not reopen the database");

		unavailable = false;
		await scheduler.poll();
		assert.equal(scheduler.delays.at(-1), WAKE_UP_POLL_INTERVAL_MS, "a successful reopen resets the backoff");
		assert.deepEqual(received.events, [
			{ kind: "resync", cause: "subscribed" },
			{ kind: "resync", cause: "reconnected" },
		]);
		await bus.close();
	} finally {
		for (const database of connections) await database.close().catch(() => {});
		removeTempDirectory(directory);
	}
});
