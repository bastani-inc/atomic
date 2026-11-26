import assert from "node:assert/strict";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import pg from "pg";
import { afterEach, describe, test } from "vitest";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
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
import { type PostgresScope, postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { sleep } from "../helpers/runtime.js";

/** Long enough for a local server to answer a read-only transaction's commit, which an open does not wait for. */
const COMMIT_SETTLE_MS = 200;

/**
 * Records what every connection sends, and counts the round trips: queries a connection sent while none of its own
 * were unanswered. The adapter's pg is this one, so patching the client prototype reaches its connections.
 */
function recordQueries() {
	const query = pg.Client.prototype.query;
	const unanswered = new WeakMap<pg.Client, number>();
	let trips = 0;
	let texts: string[] = [];
	const recording = function (this: pg.Client, ...args: Parameters<pg.Client["query"]>) {
		const pending = unanswered.get(this) ?? 0;
		if (pending === 0) trips += 1;
		unanswered.set(this, pending + 1);
		const first = args[0] as unknown;
		texts.push(typeof first === "string" ? first : String((first as { text?: unknown } | undefined)?.text ?? ""));
		const answered = () => unanswered.set(this, (unanswered.get(this) ?? 1) - 1);
		const result = Reflect.apply(query, this, args) as unknown as Promise<unknown>;
		void result.then(answered, answered);
		return result;
	};
	pg.Client.prototype.query = recording as pg.Client["query"];
	restores.push(() => {
		pg.Client.prototype.query = query;
	});
	return {
		take() {
			const taken = { trips, texts };
			trips = 0;
			texts = [];
			return taken;
		},
	};
}

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

/** Opens a session store and an Intercom broker's state on handles of their own, as an agent process does. */
async function openProcess({ open }: PostgresScope) {
	const store = await SqlSessionStore.open(await open());
	const broker = await openIntercomBrokerState({ prefix: "", openDatabase: () => open() }, { pollIntervalMs: 60_000 });
	return {
		async close() {
			await broker.bus.close();
			await broker.state.close();
			await store.close();
		},
	};
}

/**
 * A statement that takes the whole database's write lock (a default transaction's) or the schema setup lock under it:
 * `SELECT pg_advisory_xact_lock(` first, where a domain's transaction takes the database's lock shared.
 */
const WHOLE_OR_SCHEMA_LOCK = /SELECT pg_advisory_xact_lock\(/;
const DDL = /\b(CREATE|ALTER|DROP)\b/;

function assertNoLockOrDdl(texts: readonly string[], what: string): void {
	for (const text of texts) {
		assert.doesNotMatch(text, WHOLE_OR_SCHEMA_LOCK, `${what} took the database's write lock: ${text}`);
		assert.doesNotMatch(text, DDL, `${what} ran DDL: ${text}`);
	}
}

/** A broker that started on the database before, with the queue of messages for ended subagents of its home. */
async function startEarlierBroker(scope: PostgresScope): Promise<void> {
	const broker = await openIntercomBrokerState(
		{ prefix: "", openDatabase: () => scope.open() },
		{ pollIntervalMs: 60_000 },
	);
	const queue = await broker.state.openEndedChildQueue?.({ home: "earlier-home", holder: "earlier-broker" });
	await queue?.close();
	await broker.bus.close();
	await broker.state.close();
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL warm open (#6560)", () => {
	test("an open whose schema is current reads the catalog once and takes no lock: a few round trips, not about 150 (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			await (await openProcess(scope)).close();
			const recorded = recordQueries();
			const store = await SqlSessionStore.open(await scope.open());
			const session = recorded.take();
			const broker = await openIntercomBrokerState(
				{ prefix: "", openDatabase: () => scope.open() },
				{ pollIntervalMs: 60_000 },
			);
			const intercom = recorded.take();
			try {
				assert.ok(session.trips <= 5, `the session store open took ${session.trips} round trips`);
				assert.ok(intercom.trips <= 3, `the broker state open took ${intercom.trips} round trips`);
				for (const text of [...session.texts, ...intercom.texts]) {
					assert.doesNotMatch(text, /pg_advisory_xact_lock/, "a warm open took a lock");
					assert.doesNotMatch(text, /\b(CREATE|ALTER|DROP)\b/, "a warm open ran DDL");
				}
			} finally {
				await broker.bus.close();
				await broker.state.close();
				await store.close();
			}
		});
	});

	test("a warm open reads the schema with the server's version, in the open's own round trip (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			await (await openProcess(scope)).close();
			// Each read-only transaction's commit is answered after the open returned: the opens are counted apart, once the
			// commits before them were answered.
			await sleep(COMMIT_SETTLE_MS);
			const recorded = recordQueries();
			const store = await SqlSessionStore.open(await scope.open());
			await sleep(COMMIT_SETTLE_MS);
			const session = recorded.take();
			const broker = await openIntercomBrokerState(
				{ prefix: "", openDatabase: () => scope.open() },
				{ pollIntervalMs: 60_000 },
			);
			await sleep(COMMIT_SETTLE_MS);
			const intercom = recorded.take();
			try {
				// The session store: the version check with the catalog and the ledger's versions, then its commit, sent with
				// the start of the snapshot index's reads, then their commit, which the open does not wait for. Five before: the
				// version check, the ledger's versions, the catalog and the snapshot index's two reads each took one.
				assert.equal(session.trips, 3);
				// The broker: the version check with the catalog and the versions, then its commit. Three before.
				assert.equal(intercom.trips, 2);
				assert.equal(session.texts.filter((text) => text.includes("information_schema.columns")).length, 1);
				assert.equal(intercom.texts.filter((text) => text.includes("information_schema.columns")).length, 1);
			} finally {
				await broker.bus.close();
				await broker.state.close();
				await store.close();
			}
		});
	});

	test("the first open of a new database installs the snapshot index of the tables it creates after reading the catalog (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			const store = await SqlSessionStore.open(database);
			try {
				// The catalog the open read had no entries table: the open created it, so its triggers are read, not taken
				// from the catalog, and installed.
				const triggers = await database.all<{ name: string }>(
					"SELECT tgname AS name FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'session_entries' AND NOT t.tgisinternal AND t.tgname LIKE 'session_entries_snapshot%'",
				);
				assert.ok(triggers.length > 0, "the entries table has no snapshot index triggers");
			} finally {
				await store.close();
			}
		});
	});

	test("a broker's start on a current schema, the ended-child queue of its new home included, takes no lock and runs no DDL (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			await startEarlierBroker(scope);
			const recorded = recordQueries();
			const broker = await openIntercomBrokerState(
				{ prefix: "", openDatabase: () => scope.open() },
				{ pollIntervalMs: 60_000 },
			);
			// What the broker opens once multi-node routing is on: the queue of a home this database has not served yet.
			const queue = await broker.state.openEndedChildQueue?.({ home: "new-home", holder: "new-broker" });
			const started = recorded.take();
			try {
				assert.ok(queue !== undefined);
				assertNoLockOrDdl(started.texts, "a warm broker start");
				// Counted per connection: the state's three, the queue's identity, the catalog's two reads sent together, and
				// the new home's record, in a transaction of its own.
				assert.ok(started.trips <= 10, `the broker's start took ${started.trips} round trips`);
			} finally {
				await queue?.close();
				await broker.bus.close();
				await broker.state.close();
			}
		});
	});

	test("each broker store opened on its own on a current schema reads the catalog once and takes no lock (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			await startEarlierBroker(scope);
			const database = await scope.open();
			const options = { database, prefix: "" };
			const opens: Record<string, () => Promise<unknown>> = {
				leases: () => openSqlBrokerLeaseStore(options),
				outbox: () => openSqlOutboxStore(options),
				heldSends: () => openSqlHeldSendStore(options),
				reservations: () => openSqlRestoringReservationStore(options),
				pendingAsks: () => openSqlPendingAskStore(options),
				releasedAsks: () => openSqlReleasedAskStore(options),
				sentMessages: () => openSqlSentMessageAuthority(options),
				knownSessions: () => openSqlKnownSessionStore(options),
				wakeUpBus: async () => {
					const bus = await openDatabaseWakeUpBus({ openDatabase: () => scope.open(), prefix: "" });
					await bus.close();
				},
			};
			const recorded = recordQueries();
			for (const [name, open] of Object.entries(opens)) {
				await open();
				const opened = recorded.take();
				assertNoLockOrDdl(opened.texts, `the ${name} store's open`);
				// The catalog's two reads, sent together on connections of their own; the bus's own connection also reads the
				// server's version and the schema's location.
				assert.ok(
					opened.trips <= (name === "wakeUpBus" ? 3 : 2),
					`the ${name} store's open took ${opened.trips} round trips`,
				);
			}
		});
	});

	test("a wake-up bus that reconnects on a current schema takes no lock and runs no DDL (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			await startEarlierBroker(scope);
			let failing: SqliteDatabase | undefined;
			const bus = await openDatabaseWakeUpBus({
				// The first connection fails its next write, as one the server dropped does; later ones work.
				openDatabase: async () => {
					const database = await scope.open();
					if (failing !== undefined) return database;
					failing = new Proxy(database, {
						get: (target, key) =>
							key === "transaction" || key === "run"
								? async () => {
										throw new Error("connection terminated");
									}
								: Reflect.get(target, key),
					});
					return failing;
				},
				prefix: "",
				pollIntervalMs: 60_000,
			});
			try {
				const hint = { brokerId: "broker", reason: "outbox", version: 1 } as const;
				assert.equal((await bus.publish(hint)).status, "unavailable");
				const recorded = recordQueries();
				assert.equal((await bus.publish(hint)).status, "published");
				const reconnected = recorded.take().texts;
				assertNoLockOrDdl(reconnected, "the bus's reconnect");
				// The bus set its table up when it opened: a new connection does not even check it again. Only the database's
				// open reads the ledger, with the catalog, for a store open that may follow.
				for (const text of reconnected) assert.doesNotMatch(text, /atomic_migrations WHERE/);
			} finally {
				await bus.close();
			}
		});
	});

	test("a process's first chat record on a current schema checks its table without a lock (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			const earlier = await SqlSessionStore.open(await scope.open());
			await earlier.prepareChatRecords();
			await earlier.close();
			const store = await SqlSessionStore.open(await scope.open());
			try {
				const recorded = recordQueries();
				await store.prepareChatRecords();
				assertNoLockOrDdl(recorded.take().texts, "the chat records' check");
			} finally {
				await store.close();
			}
		});
	});

	test("twenty processes open together while a writer holds the database's write lock, none waiting for it (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			await (await openProcess(scope)).close();
			const writer = await scope.open();
			const holdMs = 6_000;
			let held!: () => void;
			const holding = new Promise<void>((resolve) => {
				held = resolve;
			});
			// A default transaction takes the whole database's write lock, which every earlier open's schema check waited for.
			const writing = writer.transaction(async (tx) => {
				held();
				await tx.get(`SELECT pg_sleep(${holdMs / 1000})`);
			});
			await holding;
			const started = performance.now();
			const processes = await Promise.all(Array.from({ length: 20 }, () => openProcess(scope)));
			const elapsed = performance.now() - started;
			try {
				assert.ok(elapsed < holdMs / 2, `the opens took ${Math.round(elapsed)} ms beside a ${holdMs} ms writer`);
			} finally {
				await Promise.all(processes.map((process) => process.close()));
				await writing;
			}
		});
	}, 60_000);

	test("an open after a newer build recorded a later schema still refuses it (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			await (await openProcess(scope)).close();
			const database = await scope.open();
			await database.run("INSERT INTO atomic_migrations (domain, version, applied_at) VALUES ('sessions', 99, 0)");
			const refused = await SqlSessionStore.open(await scope.open()).then(
				async (store) => {
					await store.close();
					return undefined;
				},
				(error: Error) => error,
			);
			assert.ok(refused !== undefined, "the newer schema was opened");
			assert.match(refused.message, /99/);
		});
	});
});
