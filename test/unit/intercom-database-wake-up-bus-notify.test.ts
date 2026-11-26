import assert from "node:assert/strict";
import { join } from "node:path";
import type {
	SqliteDatabase,
	SqliteTransactionOptions,
	StorageListenerState,
	StorageNotificationEvent,
	StorageNotifications,
} from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	brokerWakeUpChannel,
	openDatabaseWakeUpBus,
	WAKE_UP_LISTENING_POLL_INTERVAL_MS,
	WAKE_UP_POLL_INTERVAL_MS,
	type WakeUpPollScheduler,
} from "../../packages/intercom/broker/database-wake-up-bus.js";
import type { WakeUpBus, WakeUpEvent } from "../../packages/intercom/broker/wake-up-bus.js";
import { removeFixtureTree } from "../helpers/fixture-removal.js";
import { makeTempDirectory } from "../helpers/runtime.js";

/**
 * The database wake-up bus on a database that delivers notifications (#5103), as Postgres does, here a SQLite file
 * given notifications that record each notice in a table and hand the test each listener.
 */

const TABLE = "team_intercom_wakeups";

interface Listening {
	readonly channel: string;
	readonly listener: (event: StorageNotificationEvent) => void;
	open: boolean;
}

/** A SQLite file whose connections deliver notifications through the test, and record each transaction's options. */
async function notifyingFile() {
	const directory = makeTempDirectory("intercom-wakeups-notify-");
	const path = join(directory, "storage.sqlite");
	const setup = await openNodeSqliteDatabase(path);
	await setup.exec("CREATE TABLE notices(id INTEGER PRIMARY KEY, channel TEXT NOT NULL, payload TEXT NOT NULL)");
	await setup.close();
	const listening: Listening[] = [];
	const transactions: (SqliteTransactionOptions | undefined)[] = [];
	const opened: SqliteDatabase[] = [];
	const buses: WakeUpBus[] = [];
	/** What the database reports of its listening connection; set it to `listening` to report notifications live. */
	const listener: { state: StorageListenerState } = { state: { status: "connecting" } };
	const notifications: StorageNotifications = {
		notify: (channel, payload) => ({
			sql: "INSERT INTO notices(channel, payload) VALUES (?, ?)",
			params: [channel, payload],
		}),
		listen(channel, listener) {
			const entry: Listening = { channel, listener, open: true };
			listening.push(entry);
			return {
				close() {
					entry.open = false;
				},
			};
		},
		state: async () => listener.state,
	};
	/** While set, every read of the bus waits for it. */
	let gate: Promise<void> | undefined;
	const open = async (): Promise<SqliteDatabase> => {
		const database = await openNodeSqliteDatabase(path);
		opened.push(database);
		return new Proxy(database, {
			get(target, key) {
				if (key === "notifications") return notifications;
				if (key === "transaction")
					return (body: Parameters<SqliteDatabase["transaction"]>[0], options?: SqliteTransactionOptions) => {
						transactions.push(options);
						return target.transaction(body, options);
					};
				if (key === "all")
					return async (...args: Parameters<SqliteDatabase["all"]>) => {
						await gate;
						return target.all(...args);
					};
				return Reflect.get(target, key);
			},
		});
	};
	return {
		path,
		listener,
		listening,
		transactions,
		opened,
		open,
		hold(): () => void {
			let release!: () => void;
			gate = new Promise((resolve) => {
				release = resolve;
			});
			return () => {
				gate = undefined;
				release();
			};
		},
		/** Opens a bus on the file, closed with it: a bus's close waits for a connection it is still opening. */
		async openBus(schedule?: WakeUpPollScheduler): Promise<WakeUpBus> {
			const bus = await openDatabaseWakeUpBus({ openDatabase: open, prefix: "team_", schedule });
			buses.push(bus);
			return bus;
		},
		async close() {
			const busCloses = await Promise.allSettled(buses.map((bus) => bus.close()));
			const databaseCloses = await Promise.allSettled(opened.map((database) => database.close()));
			const closes = [...busCloses, ...databaseCloses];
			removeFixtureTree(directory);
			for (const close of closes) if (close.status === "rejected") throw close.reason;
		},
	};
}

/** How long a poll, including reopening the database, may take to end on a loaded machine. */
const POLL_END_LIMIT_MS = 20_000;

/** Records the bus's poll timers; `fire` runs the armed poll. */
function scheduler() {
	const delays: number[] = [];
	let pending: (() => void) | undefined;
	const schedule: WakeUpPollScheduler = (callback, delayMs) => {
		delays.push(delayMs);
		pending = callback;
		return () => {
			if (pending === callback) pending = undefined;
		};
	};
	return {
		schedule,
		delays,
		armed: () => pending !== undefined,
		/** Resolves once the poll in progress has ended and armed the next one, however long a loaded machine takes. */
		async settled(): Promise<void> {
			const deadline = Date.now() + POLL_END_LIMIT_MS;
			while (pending === undefined) {
				assert.ok(Date.now() < deadline, `the poll ends and arms the next within ${POLL_END_LIMIT_MS} ms`);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		},
		fire() {
			const callback = pending;
			assert.ok(callback, "a poll is armed");
			pending = undefined;
			callback();
		},
	};
}

function recorder() {
	const events: WakeUpEvent[] = [];
	return { events, listener: (event: WakeUpEvent) => events.push(event) };
}

test("a publish writes its hint, with its recipient, and notifies its broker's own channel and the shared one, in one transaction on the fenced hint path (#5103, #6560)", async () => {
	const file = await notifyingFile();
	try {
		const bus = await file.openBus();
		file.transactions.length = 0;
		assert.deepEqual(
			await bus.publish({ brokerId: "broker-b", reason: "outbox", version: 3, targetIdentity: "session:alice" }),
			{ status: "published" },
		);
		assert.equal(file.transactions.length, 1);
		assert.deepEqual(file.transactions[0]?.concurrency, { kind: "fenced", audit: "intercom-wakeup-hint" });
		assert.equal(file.transactions[0]?.retryTransientFailures, true);
		assert.equal(file.transactions[0]?.leading?.length, 1, "the hint goes with the transaction's start");
		assert.deepEqual(await bus.publish({ brokerId: "broker-c", reason: "outcome", version: 0 }), {
			status: "published",
		});
		const observer = await openNodeSqliteDatabase(file.path);
		try {
			assert.deepEqual(await observer.all("SELECT channel, payload FROM notices ORDER BY id"), [
				{ channel: brokerWakeUpChannel(TABLE, "broker-b"), payload: "broker-b" },
				{ channel: TABLE, payload: "broker-b" },
				{ channel: brokerWakeUpChannel(TABLE, "broker-c"), payload: "broker-c" },
				{ channel: TABLE, payload: "broker-c" },
			]);
			assert.deepEqual(
				await observer.all(`SELECT broker_id, reason, version, target_identity FROM ${TABLE} ORDER BY id`),
				[
					{ broker_id: "broker-b", reason: "outbox", version: 3, target_identity: "session:alice" },
					{ broker_id: "broker-c", reason: "outcome", version: 0, target_identity: null },
				],
			);
		} finally {
			await observer.close();
		}
		await bus.close();
	} finally {
		await file.close();
	}
});

test("a notification for a subscribed broker, or a resumed listener, polls at once; another broker's waits for the poll (#5103)", async () => {
	const file = await notifyingFile();
	try {
		const timers = scheduler();
		const bus = await file.openBus(timers.schedule);
		await bus.subscribe("broker-b", recorder().listener);
		const brokerC = await bus.subscribe("broker-c", recorder().listener);
		assert.deepEqual(
			file.listening.map((entry) => entry.channel),
			[TABLE, brokerWakeUpChannel(TABLE, "broker-b"), brokerWakeUpChannel(TABLE, "broker-c")],
			"the shared channel, which earlier releases notify, and each subscribed broker's own",
		);
		const [listening, ownB, ownC] = file.listening;
		assert.deepEqual(timers.delays, [WAKE_UP_POLL_INTERVAL_MS]);
		listening!.listener({ kind: "notification", payload: "broker-a" });
		assert.deepEqual(timers.delays, [WAKE_UP_POLL_INTERVAL_MS]);
		listening!.listener({ kind: "notification", payload: "broker-c" });
		assert.deepEqual(timers.delays, [WAKE_UP_POLL_INTERVAL_MS, 0]);
		timers.fire();
		await timers.settled();
		assert.deepEqual(timers.delays, [WAKE_UP_POLL_INTERVAL_MS, 0, WAKE_UP_POLL_INTERVAL_MS]);
		listening!.listener({ kind: "listening" });
		assert.deepEqual(timers.delays.at(-1), 0);
		timers.fire();
		await timers.settled();
		ownB!.listener({ kind: "notification", payload: "broker-b" });
		assert.equal(timers.delays.at(-1), 0, "a notification on a broker's own channel polls at once");
		timers.fire();
		await timers.settled();
		if (brokerC.status === "subscribed") await brokerC.subscription.close();
		assert.equal(ownC!.open, false, "a broker no subscription needs any more is no longer listened for");
		assert.equal(ownB!.open, true);
		await bus.close();
		assert.equal(listening!.open, false, "close stops listening");
		assert.equal(ownB!.open, false);
		const armed = timers.delays.length;
		listening!.listener({ kind: "notification", payload: "broker-b" });
		assert.equal(timers.delays.length, armed, "a closed bus polls no more");
	} finally {
		await file.close();
	}
});

test("a notification during a poll runs the next poll as soon as that one ends (#5103)", async () => {
	const file = await notifyingFile();
	try {
		const timers = scheduler();
		const bus = await file.openBus(timers.schedule);
		await bus.subscribe("broker-b", recorder().listener);
		const [listening] = file.listening;
		let release = file.hold();
		timers.fire();
		listening!.listener({ kind: "notification", payload: "broker-b" });
		assert.equal(timers.armed(), false, "no second poll starts beside the one in progress");
		release();
		await timers.settled();
		assert.deepEqual(timers.delays, [WAKE_UP_POLL_INTERVAL_MS, 0]);
		release = file.hold();
		timers.fire();
		release();
		await timers.settled();
		assert.deepEqual(
			timers.delays,
			[WAKE_UP_POLL_INTERVAL_MS, 0, WAKE_UP_POLL_INTERVAL_MS],
			"without one, the interval",
		);
		await bus.close();
	} finally {
		await file.close();
	}
});

test("a bus listens again through the database it reopens, and a subscription made while it has none listens nowhere (#5103)", async () => {
	const file = await notifyingFile();
	try {
		const timers = scheduler();
		const bus = await file.openBus(timers.schedule);
		const received = recorder();
		await bus.subscribe("broker-b", received.listener);
		await file.opened.at(-1)!.close();
		timers.fire();
		await timers.settled();
		// The failed poll dropped the connection; the bus has none until its next poll reopens it.
		await bus.subscribe("broker-c", recorder().listener);
		assert.equal(file.listening.length, 2, "the shared channel and broker-b's");
		timers.fire();
		await timers.settled();
		assert.deepEqual(
			file.listening.map((entry) => [entry.channel, entry.open]),
			[
				[TABLE, false],
				[brokerWakeUpChannel(TABLE, "broker-b"), false],
				[TABLE, true],
				[brokerWakeUpChannel(TABLE, "broker-b"), true],
				[brokerWakeUpChannel(TABLE, "broker-c"), true],
			],
		);
		assert.ok(received.events.some((event) => event.kind === "resync" && event.cause === "reconnected"));
		await bus.close();
	} finally {
		await file.close();
	}
});

test("while the database reports its notifications live, the poll only backs them up at the slower interval (#6560)", async () => {
	const file = await notifyingFile();
	try {
		const timers = scheduler();
		file.listener.state = { status: "listening" };
		const bus = await file.openBus(timers.schedule);
		await bus.subscribe("broker-b", recorder().listener);
		const [listening] = file.listening;
		timers.fire();
		await timers.settled();
		assert.equal(timers.delays.at(-1), WAKE_UP_LISTENING_POLL_INTERVAL_MS, "notifications live: the backup interval");
		listening!.listener({ kind: "notification", payload: "broker-b" });
		assert.equal(timers.delays.at(-1), 0, "a notification still polls at once");
		timers.fire();
		await timers.settled();
		assert.equal(timers.delays.at(-1), WAKE_UP_LISTENING_POLL_INTERVAL_MS);
		file.listener.state = { status: "unavailable", reason: "connection-failed" };
		timers.fire();
		await timers.settled();
		assert.equal(timers.delays.at(-1), WAKE_UP_POLL_INTERVAL_MS, "listening connection down: the fast interval");
		file.listener.state = { status: "listening" };
		listening!.listener({ kind: "listening" });
		assert.equal(timers.delays.at(-1), 0, "listening again polls at once for the notifications lost meanwhile");
		timers.fire();
		await timers.settled();
		assert.equal(timers.delays.at(-1), WAKE_UP_LISTENING_POLL_INTERVAL_MS);
		await bus.close();
	} finally {
		await file.close();
	}
});

test("through a transaction pooler, where no notification arrives, the poll keeps the fast interval (#6560)", async () => {
	const file = await notifyingFile();
	try {
		const timers = scheduler();
		file.listener.state = { status: "unavailable", reason: "pooler" };
		const bus = await file.openBus(timers.schedule);
		await bus.subscribe("broker-b", recorder().listener);
		for (let poll = 0; poll < 2; poll++) {
			timers.fire();
			await timers.settled();
			assert.equal(timers.delays.at(-1), WAKE_UP_POLL_INTERVAL_MS);
		}
		await bus.close();
	} finally {
		await file.close();
	}
});

test("a hint table an earlier release created gets the recipient column when this release opens it", async () => {
	const file = await notifyingFile();
	try {
		const earlier = await openNodeSqliteDatabase(file.path);
		await earlier.exec(`CREATE TABLE ${TABLE} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			broker_id TEXT NOT NULL,
			reason TEXT NOT NULL CHECK (reason IN ('outbox', 'outcome')),
			version INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		)`);
		await earlier.run(
			`INSERT INTO ${TABLE} (broker_id, reason, version, created_at) VALUES ('broker-b', 'outbox', 1, ?)`,
			Date.now(),
		);
		await earlier.close();
		const bus = await file.openBus();
		assert.deepEqual(
			await bus.publish({ brokerId: "broker-b", reason: "outbox", version: 2, targetIdentity: "session:alice" }),
			{ status: "published" },
		);
		const received = recorder();
		await bus.subscribe("broker-b", received.listener);
		await vi.waitFor(() => assert.equal(received.events.filter((event) => event.kind === "hint").length, 2), {
			timeout: POLL_END_LIMIT_MS,
		});
		assert.deepEqual(
			received.events.flatMap((event) => (event.kind === "hint" ? [event.hint] : [])),
			[
				{ brokerId: "broker-b", reason: "outbox", version: 1 },
				{ brokerId: "broker-b", reason: "outbox", version: 2, targetIdentity: "session:alice" },
			],
			"the earlier release's hint names no recipient",
		);
		await bus.close();
	} finally {
		await file.close();
	}
});
