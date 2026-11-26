import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SqliteDatabase, SqliteExecutor } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openDatabaseWakeUpBus } from "../../packages/intercom/broker/database-wake-up-bus.js";
import { LOCAL_RETRY_LOOKUP_BOUND_MS } from "../../packages/intercom/broker/multinode-router.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	type IntercomBrokerStateOptions,
	KNOWN_SESSION_RETENTION_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { borrowedDatabase, openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { openSqlHeldSendStore } from "../../packages/intercom/broker/sql-held-send-store.js";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import { openSqlPendingAskStore } from "../../packages/intercom/broker/sql-pending-ask-store.js";
import { openSqlReleasedAskStore } from "../../packages/intercom/broker/sql-released-ask-store.js";
import { openSqlRestoringReservationStore } from "../../packages/intercom/broker/sql-restoring-reservation-store.js";
import { openSqlSentMessageAuthority } from "../../packages/intercom/broker/sql-sent-message-authority.js";
import {
	type OpenSharedStoreFixture,
	registerBrokerLeaseStoreConformance,
	registerCrossNodeHeldRoundTripConformance,
	registerCrossNodeRoundTripConformance,
	registerHeldSendStoreConformance,
	registerIdOwnerConformance,
	registerKnownSessionStoreConformance,
	registerOutboxStoreConformance,
	registerPendingAskStoreConformance,
	registerReleasedAskStoreConformance,
	registerRestoringReservationStoreConformance,
	registerReturningSessionConformance,
	registerSentMessageAuthorityConformance,
} from "../helpers/intercom-multinode-contract.js";
import { openMemoryOutboxFixture, openMemoryWakeUpBusFixture } from "../helpers/intercom-multinode-memory-reference.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { type StorageBackend, storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	framesOf,
	message,
	messageFrames,
	Node,
	outcomeOf,
	reasonOf,
	sendAndSettle,
	waitFor,
	waitOffline,
} from "../unit/intercom-multinode-broker-routing-helpers.js";
import { backendLabel } from "./storage-conformance-matrix-helpers.js";

/**
 * Intercom multi-node routing state behavioural contract on every storage backend (#4793): a SQLite file, a libSQL
 * server and Postgres.
 */

useTemporaryAgentDir();

/** How long a read that must not wait behind the broker's writes may take; `REMOTE_SESSIONS_BOUND_MS` is 2 s. */
const UNQUEUED_READ_MS = 2_000;

/** A backup poll so slow that a hint arriving before it was notified. */
const UNNOTIFIED_POLL_MS = 60_000;
/** How long a notified hint may take to arrive. */
const NOTIFIED_HINT_MS = 5_000;

/** How long a send may take while an unrelated write holds its transaction open. */
const UNBLOCKED_SEND_MS = 5_000;

const sender = { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

/** A send of `messageId` with `digest` to `target`: its sent-message reservation and its outbox row. */
function send(messageId: string, digest: string, target = "target-a") {
	return [
		{ messageId, digest, targetIdentity: target },
		{
			targetIdentity: target,
			originBrokerId: "broker-a",
			digest,
			frame: { type: "message", from: sender, message: { id: messageId, timestamp: 1, content: { text: digest } } },
		},
	] as const;
}

/** A shared-state fixture whose every connection is another database connection to one backend scope. */
function scopeFixture<Store>(
	backend: StorageBackend,
	openStore: (options: IntercomBrokerStateOptions) => Promise<Store>,
): OpenSharedStoreFixture<Store> {
	return async () => {
		const scope = await backend.openScope();
		return {
			connect: async () => openStore({ database: await scope.connect(), prefix: scope.prefix }),
			close: () => scope.close(),
		};
	};
}

for (const backend of storageBackends) {
	const name = backendLabel(backend);
	const run = backend.skipReason === undefined ? test : test.skip;
	const intercom = `Intercom routing on ${name}`;
	registerBrokerLeaseStoreConformance(run, intercom, scopeFixture(backend, openSqlBrokerLeaseStore));
	registerKnownSessionStoreConformance(run, intercom, scopeFixture(backend, openSqlKnownSessionStore));
	// The lease store's table is there first, as in a broker: an unanswered claim's `reclaim` reads it.
	registerIdOwnerConformance(
		run,
		intercom,
		scopeFixture(backend, async (options) => {
			await openSqlBrokerLeaseStore(options);
			return openSqlKnownSessionStore(options);
		}),
	);
	registerOutboxStoreConformance(run, intercom, scopeFixture(backend, openSqlOutboxStore));
	registerPendingAskStoreConformance(run, intercom, scopeFixture(backend, openSqlPendingAskStore));
	registerReleasedAskStoreConformance(run, intercom, scopeFixture(backend, openSqlReleasedAskStore));
	registerSentMessageAuthorityConformance(run, intercom, scopeFixture(backend, openSqlSentMessageAuthority));
	registerHeldSendStoreConformance(run, intercom, scopeFixture(backend, openSqlHeldSendStore));
	registerRestoringReservationStoreConformance(run, intercom, scopeFixture(backend, openSqlRestoringReservationStore));
	// The stores in the order a broker opens them, then its wake-up bus on the same connection (#5607).
	registerReturningSessionConformance(
		run,
		intercom,
		scopeFixture(backend, async (options) => ({
			leases: await openSqlBrokerLeaseStore(options),
			knownSessions: await openSqlKnownSessionStore(options),
			outbox: await openSqlOutboxStore(options),
			bus: await openDatabaseWakeUpBus({
				openDatabase: async () => borrowedDatabase(options.database),
				prefix: options.prefix,
			}),
		})),
	);
	registerCrossNodeRoundTripConformance(run, intercom, {
		openOutbox: scopeFixture(backend, openSqlOutboxStore),
		openPendingAsks: scopeFixture(backend, openSqlPendingAskStore),
		openBus: openMemoryWakeUpBusFixture,
	});
	run(
		`${intercom}: live leases and known sessions answer while a write holds the broker's database (#6560)`,
		async () => {
			const scope = await backend.openScope();
			try {
				let database!: SqliteDatabase;
				const { state, bus } = await openIntercomBrokerState({
					prefix: scope.prefix,
					async openDatabase() {
						database = await scope.connect();
						// A database that offers a reader, as the adapters do.
						database.openReader ??= () => scope.connect();
						return database;
					},
				});
				try {
					const member = { kind: "broker", brokerId: "broker-a", nodeId: "host-a", startedAt: 1 } as const;
					await state.leases.acquire(member, "broker-a", BROKER_LEASE_STALE_AFTER_MS);
					await state.knownSessions.record({
						targetIdentity: "target-a",
						intercomSessionId: "session-a",
						group: "team",
						groups: ["team"],
					});
					// A write that stalls with the broker's database held, as one waiting for a lock does.
					let finish!: () => void;
					const held = new Promise<void>((resolve) => {
						finish = resolve;
					});
					let entered!: () => void;
					const holding = new Promise<void>((resolve) => {
						entered = resolve;
					});
					const write = database.transaction(async (tx) => {
						await tx.get("SELECT 1 AS one");
						entered();
						await held;
					});
					await holding;
					try {
						const within = <T>(read: Promise<T>) =>
							Promise.race([
								read,
								sleep(UNQUEUED_READ_MS).then(() => {
									throw new Error(`the read waited behind the write for ${UNQUEUED_READ_MS} ms`);
								}),
							]);
						const live = await within(state.leases.listLive("broker", BROKER_LEASE_STALE_AFTER_MS));
						assert.deepEqual(
							live.map((lease) => lease.holderId),
							["broker-a"],
						);
						const known = await within(state.knownSessions.lookup("session-a", KNOWN_SESSION_RETENTION_MS));
						assert.equal(known.status === "found" ? known.sessions.length : 0, 1);
					} finally {
						finish();
						await write;
					}
				} finally {
					await bus.close();
					await state.close();
				}
			} finally {
				await scope.close();
			}
		},
	);
	run(
		`${intercom}: a read through the reader sees the broker's writes it started before it, awaited or not`,
		async () => {
			const scope = await backend.openScope();
			try {
				const { state, bus } = await openIntercomBrokerState({
					prefix: scope.prefix,
					async openDatabase() {
						const database = await scope.connect();
						// A database that offers a reader, as the adapters do.
						database.openReader ??= () => scope.connect();
						return database;
					},
				});
				try {
					for (let round = 0; round < 4; round++) {
						const targetIdentity = `target-${round}`;
						const sessionId = `session-${round}`;
						const recorded = state.knownSessions.record({
							targetIdentity,
							intercomSessionId: sessionId,
							group: "team",
							groups: ["team"],
						});
						const known = await state.knownSessions.lookup(sessionId, KNOWN_SESSION_RETENTION_MS);
						assert.equal(known.status === "found" ? known.sessions.length : 0, 1, `lookup after record ${round}`);
						await recorded;
						const bound = state.knownSessions.bind(
							`bound-${round}`,
							`address-${round}`,
							KNOWN_SESSION_RETENTION_MS,
						);
						assert.deepEqual(
							await state.knownSessions.binding(`bound-${round}`, KNOWN_SESSION_RETENTION_MS),
							{ status: "bound", returnAddress: `address-${round}` },
							`binding after bind ${round}`,
						);
						await bound;
						const presence = {
							kind: "presence",
							targetIdentity,
							session: { ...sender, id: sessionId, name: sessionId },
						} as const;
						const acquired = state.leases.acquire(presence, "broker-a", BROKER_LEASE_STALE_AFTER_MS);
						const [read, live] = await Promise.all([
							state.leases.read({ kind: "presence", targetIdentity }),
							state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS),
						]);
						assert.equal(read.status, "found", `read after acquire ${round}`);
						assert.ok(
							live.some((lease) => lease.holderId === "broker-a" && lease.key.kind === "presence"),
							`live leases after acquire ${round}`,
						);
						const taken = await acquired;
						assert.equal(taken.status, "acquired");
						if (taken.status !== "acquired") return;
						const released = state.leases.release(taken.lease);
						assert.deepEqual(
							await state.leases.read({ kind: "presence", targetIdentity }),
							{ status: "missing" },
							`read after release ${round}`,
						);
						await released;
					}
				} finally {
					await bus.close();
					await state.close();
				}
			} finally {
				await scope.close();
			}
		},
	);
	run(
		`${intercom}: a send queues its message only under its own reservation, while another connection reserves it (#6560)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const brokers = await Promise.all(
					[0, 1, 2].map(() =>
						openIntercomBrokerState({ prefix: scope.prefix, openDatabase: () => scope.connect() }),
					),
				);
				try {
					const [first, second, third] = brokers.map(({ state }) => state);
					const ids = Array.from({ length: 12 }, (_, index) => `m-${index}`);
					// Per message, from three connections at once: two sends of one digest and a reservation of another.
					const outcomes = await Promise.all(
						ids.map(async (id) => {
							const [sent, again, rival] = await Promise.all([
								first!.reserveAndEnqueue!(...send(id, `${id}-a`)),
								second!.reserveAndEnqueue!(...send(id, `${id}-a`)),
								third!.sentMessages.reserve(send(id, `${id}-b`)[0]),
							]);
							return { id, statuses: [sent.status, again.status], rival: rival.status };
						}),
					);
					for (const { id, statuses, rival } of outcomes) {
						const row = await first!.outbox.read(id);
						const reservation = await first!.sentMessages.lookup({ messageId: id, digest: `${id}-a` });
						if (row.status === "found") {
							// Queued once, by one send; the rival reservation of another digest lost to it.
							assert.equal(row.row.digest, `${id}-a`, id);
							assert.deepEqual([...statuses].sort(), ["duplicate", "inserted"], id);
							assert.equal(rival, "conflict", id);
							assert.notEqual(reservation.status, "conflict", id);
						} else {
							// The rival reserved first: both sends were refused, and nothing was queued.
							assert.deepEqual(statuses, ["conflict", "conflict"], id);
							assert.equal(rival, "reserved", id);
							assert.equal(reservation.status, "conflict", id);
						}
					}
				} finally {
					for (const { state, bus } of brokers) {
						await bus.close();
						await state.close();
					}
				}
			} finally {
				await scope.close();
			}
		},
	);
	run(
		`${intercom}: concurrent sends to one recipient keep each sender's order and queue a resent message once (#6560)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const brokers = await Promise.all(
					[0, 1, 2].map(() =>
						openIntercomBrokerState({ prefix: scope.prefix, openDatabase: () => scope.connect() }),
					),
				);
				try {
					const states = brokers.map(({ state }) => state);
					const perSender = 6;
					// Each broker sends its own messages in turn, and every message is also sent again by the next broker,
					// at the same time, so sends of one message and of one sender race on three connections.
					const outcomes = await Promise.all(
						states.map(async (state, sender) => {
							const statuses: string[] = [];
							for (let index = 0; index < perSender; index++) {
								const id = `m-${sender}-${index}`;
								const resender = states[(sender + 1) % states.length]!;
								const [sent, again] = await Promise.all([
									state.reserveAndEnqueue!(...send(id, `${id}-d`)),
									resender.reserveAndEnqueue!(...send(id, `${id}-d`)),
								]);
								statuses.push([sent.status, again.status].sort().join("+"));
							}
							return statuses;
						}),
					);
					for (const statuses of outcomes)
						assert.deepEqual(statuses, Array<string>(perSender).fill("duplicate+inserted"));
					const claimed = await states[0]!.outbox.claim({
						claimantId: "broker-r",
						targetIdentity: "target-a",
						staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
					});
					assert.equal(claimed.status, "claimed");
					if (claimed.status !== "claimed") return;
					const ids = claimed.rows.map(({ row }) => row.messageId);
					const sequences = claimed.rows.map(({ row }) => row.sequence);
					// Every message once, in sequence order, and each sender's messages in the order it sent them.
					assert.equal(new Set(ids).size, ids.length);
					assert.equal(ids.length, states.length * perSender);
					assert.deepEqual(
						sequences,
						[...sequences].sort((a, b) => a - b),
					);
					for (const sender of [0, 1, 2])
						assert.deepEqual(
							ids.filter((id) => id.startsWith(`m-${sender}-`)),
							Array.from({ length: perSender }, (_, index) => `m-${sender}-${index}`),
						);
					for (const id of ids)
						assert.equal(
							(await states[1]!.sentMessages.lookup({ messageId: id, digest: `${id}-d` })).status,
							"match",
						);
				} finally {
					for (const { state, bus } of brokers) {
						await bus.close();
						await state.close();
					}
				}
			} finally {
				await scope.close();
			}
		},
	);
	if (backend.name === "Postgres")
		run(
			`${intercom}: sends, and another recipient's claim and delivery, do not wait while one recipient's claim holds its rows (#6560)`,
			async () => {
				const scope = await backend.openScope();
				try {
					const { state, bus } = await openIntercomBrokerState({
						prefix: scope.prefix,
						openDatabase: () => scope.connect(),
					});
					try {
						for (const [id, target] of [
							["m-a", "target-a"],
							["m-b", "target-b"],
						] as const)
							assert.equal((await state.reserveAndEnqueue!(...send(id, id, target))).status, "inserted");
						// A claim of target-a whose transaction read and locked its rows and stalls before its commit.
						let entered!: () => void;
						const holding = new Promise<void>((resolve) => {
							entered = resolve;
						});
						let commit!: () => void;
						const committing = new Promise<void>((resolve) => {
							commit = resolve;
						});
						let stall = false;
						const claiming = await scope.connect();
						const stalling = new Proxy(claiming, {
							get(target, key) {
								if (key !== "transaction") return Reflect.get(target, key, target);
								return (callback: (tx: SqliteExecutor) => Promise<unknown>, transactionOptions?: object) =>
									target.transaction(async (tx) => {
										const result = await callback(tx);
										if (stall) {
											entered();
											await committing;
										}
										return result;
									}, transactionOptions);
							},
						}) as SqliteDatabase;
						const stalledOutbox = await openSqlOutboxStore({ database: stalling, prefix: scope.prefix });
						stall = true;
						const stalledClaim = stalledOutbox.claim({
							claimantId: "broker-a",
							targetIdentity: "target-a",
							staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
						});
						await holding;
						try {
							const unblocked = <T>(write: Promise<T>, what: string) =>
								Promise.race([
									write,
									sleep(UNBLOCKED_SEND_MS).then(() => {
										throw new Error(`${what} waited behind the claim for ${UNBLOCKED_SEND_MS} ms`);
									}),
								]);
							const sends = await unblocked(
								Promise.all([
									state.reserveAndEnqueue!(...send("m-b2", "m-b2", "target-b")),
									state.reserveAndEnqueue!(...send("m-c", "m-c", "target-c")),
									state.reserveAndEnqueue!(...send("m-a2", "m-a2", "target-a")),
								]),
								"a send",
							);
							assert.deepEqual(
								sends.map((sent) => sent.status),
								["inserted", "inserted", "inserted"],
							);
							const other = await unblocked(
								state.outbox.claim({
									claimantId: "broker-b",
									targetIdentity: "target-b",
									staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
								}),
								"another recipient's claim",
							);
							assert.deepEqual(
								other.status === "claimed" ? other.rows.map(({ row }) => row.messageId) : other.status,
								["m-b", "m-b2"],
							);
							if (other.status !== "claimed") return;
							const delivered = await unblocked(
								state.outbox.markDelivered(other.rows[0]!.claim),
								"another recipient's delivery",
							);
							assert.equal(delivered.status, "delivered");
						} finally {
							commit();
						}
						const claimed = await stalledClaim;
						// The stalled claim took the row it locked; the one queued meanwhile waits for the next claim.
						assert.deepEqual(
							claimed.status === "claimed" ? claimed.rows.map(({ row }) => row.messageId) : claimed.status,
							["m-a"],
						);
						const position = await state.outbox.undeliveredPosition("target-a", "m-a2");
						assert.deepEqual(position, { status: "positioned", position: 2 });
					} finally {
						await bus.close();
						await state.close();
					}
				} finally {
					await scope.close();
				}
			},
		);
	if (backend.name === "Postgres")
		run(
			`${intercom}: a send does not wait for another connection's write of an unrelated domain (#6560)`,
			async () => {
				const scope = await backend.openScope();
				try {
					const { state, bus } = await openIntercomBrokerState({
						prefix: scope.prefix,
						openDatabase: () => scope.connect(),
					});
					try {
						const holder = await scope.connect();
						let release!: () => void;
						let holding!: () => void;
						const held = new Promise<void>((resolve) => {
							holding = resolve;
						});
						// A session's write, stalled with its transaction open, as one waiting on a far-away server is.
						const stalled = holder.transaction(
							async (tx) => {
								await tx.get("SELECT 1 AS one");
								holding();
								await new Promise<void>((resolve) => {
									release = resolve;
								});
							},
							{ concurrency: { kind: "serial", domain: `${scope.prefix}sessions:unrelated` } },
						);
						await held;
						try {
							const sent = await Promise.race([
								state.reserveAndEnqueue!(...send("m-free", "d-free")),
								sleep(UNBLOCKED_SEND_MS).then(() => {
									throw new Error(`the send waited behind the unrelated write for ${UNBLOCKED_SEND_MS} ms`);
								}),
							]);
							assert.equal(sent.status, "inserted");
						} finally {
							release();
							await stalled;
						}
					} finally {
						await bus.close();
						await state.close();
					}
				} finally {
					await scope.close();
				}
			},
		);
	run(
		`${intercom}: a lease table holding half a surrogate pair from an earlier broker gets its address columns and lists the row (#6560)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const table = `${scope.prefix}intercom_leases`;
				const database = await scope.connect();
				await openSqlBrokerLeaseStore({ database, prefix: scope.prefix });
				// The table as a broker before the address columns left it.
				const columns = ["presence_id", "presence_id_head", "presence_name", "presence_host", "presence_alias"];
				for (const column of columns) await database.exec(`DROP INDEX IF EXISTS ${table}_${column}`);
				for (const column of columns) await database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
				if (backend.name === "Postgres")
					await database.run(
						`DELETE FROM ${scope.prefix}atomic_migrations WHERE domain = ?`,
						"schema:intercom-lease-addresses",
					);
				// An earlier broker wrote its subject as `JSON.stringify` does: the cut emoji as a lone `\ud83d` escape.
				const half = "Fix the build \u{1F600}".slice(0, 15);
				const targetIdentity = JSON.stringify(["return", half, "team"]);
				const subject = {
					kind: "presence",
					targetIdentity,
					session: { ...sender, id: "half-id", name: half, status: half },
				};
				await database.run(
					`INSERT INTO ${table}(kind, key, holder_id, fencing_token, last_token, subject_json, renewed_at,
						first_acquired_order) VALUES ('presence', ?, 'broker-old', 1, 1, ?, ?, 1)`,
					targetIdentity,
					JSON.stringify(subject),
					Date.now(),
				);
				const leases = await openSqlBrokerLeaseStore({ database: await scope.connect(), prefix: scope.prefix });
				assert.ok(leases.listLiveFor, "the address columns were added");
				for (const target of [half, half.toWellFormed(), "half-id"]) {
					const [found] = await leases.listLiveFor(target, BROKER_LEASE_STALE_AFTER_MS);
					assert.equal(found?.key.kind === "presence" && found.key.targetIdentity, targetIdentity);
					assert.equal(found?.subject.kind === "presence" && found.subject.session.name, half.toWellFormed());
				}
			} finally {
				await scope.close();
			}
		},
	);
	run(
		`${intercom}: a send reaches a session on another broker whose name ends in half a surrogate pair (#6560)`,
		async () => {
			const scope = await backend.openScope();
			const directory = makeTempDirectory("intercom-matrix-surrogates-");
			const nodes: Node[] = [];
			try {
				const shared = await scope.connect();
				for (const name of ["node-0", "node-1"])
					nodes.push(await Node.start(name, directory, shared, undefined, scope.prefix));
				const [a, b] = nodes as [Node, Node];
				// An emoji cut in half, as a UTF-16 slice of a longer name leaves it.
				const half = "Fix the build \u{1F600}".slice(0, 15);
				const sender = await a.connect("sender");
				const recipient = await b.connect(half);
				const sent = message();
				a.send(sender, half, sent);
				const frame = await waitFor(
					() => messageFrames(recipient, sent.id)[0] ?? reasonOf(outcomeOf(sender, sent.id)),
				);
				assert.deepEqual(frame, { type: "message", from: sender.info, message: sent });
				b.router.received(recipient, sent.id);
				assert.equal((await waitFor(() => outcomeOf(sender, sent.id))).type, "delivered");
			} finally {
				for (const node of nodes) await node.close();
				await scope.close();
				removeTempDirectory(directory);
			}
		},
	);
	run(
		`${intercom}: keys first acquired at once from several connections each get their own order (#6560)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const stores = await Promise.all(
					[0, 1, 2].map(async () =>
						openSqlBrokerLeaseStore({ database: await scope.connect(), prefix: scope.prefix }),
					),
				);
				const targets = Array.from({ length: 24 }, (_, index) => `target-${index}`);
				const acquired = await Promise.all(
					targets.map((targetIdentity, index) =>
						stores[index % stores.length]!.acquire(
							{ kind: "presence", targetIdentity, session: { ...sender, id: targetIdentity } },
							`broker-${index % stores.length}`,
							BROKER_LEASE_STALE_AFTER_MS,
						),
					),
				);
				assert.deepEqual(new Set(acquired.map((result) => result.status)), new Set(["acquired"]));
				const reader = await scope.connect();
				const orders = await reader.all<{ first_acquired_order: number | bigint }>(
					`SELECT first_acquired_order FROM ${scope.prefix}intercom_leases WHERE kind = 'presence'`,
				);
				assert.equal(orders.length, targets.length);
				assert.equal(new Set(orders.map((row) => Number(row.first_acquired_order))).size, targets.length);
				const live = await stores[0]!.listLive("presence", BROKER_LEASE_STALE_AFTER_MS);
				assert.deepEqual(
					new Set(live.map((lease) => (lease.key.kind === "presence" ? lease.key.targetIdentity : ""))),
					new Set(targets),
				);
			} finally {
				await scope.close();
			}
		},
	);
	if (backend.name === "Postgres")
		run(
			`${intercom}: fifty first acquisitions do not wait for one another, nor for one that has not committed (#6560)`,
			async () => {
				const scope = await backend.openScope();
				try {
					// One acquisition whose transaction stalls before its commit, as one waiting on a far-away server does.
					let stall = false;
					let entered!: () => void;
					const stalled = new Promise<void>((resolve) => {
						entered = resolve;
					});
					let commit!: () => void;
					const committing = new Promise<void>((resolve) => {
						commit = resolve;
					});
					const slow = await scope.connect();
					const stalling = new Proxy(slow, {
						get(target, key) {
							if (key !== "transaction") return Reflect.get(target, key, target);
							return (callback: (tx: SqliteExecutor) => Promise<unknown>, transactionOptions?: object) =>
								target.transaction(async (tx) => {
									const result = await callback(tx);
									if (stall) {
										stall = false;
										entered();
										await committing;
									}
									return result;
								}, transactionOptions);
						},
					}) as SqliteDatabase;
					const first = await openSqlBrokerLeaseStore({ database: stalling, prefix: scope.prefix });
					const stores = await Promise.all(
						[0, 1, 2, 3, 4].map(async () =>
							openSqlBrokerLeaseStore({ database: await scope.connect(), prefix: scope.prefix }),
						),
					);
					const presence = (targetIdentity: string) =>
						({ kind: "presence", targetIdentity, session: { ...sender, id: targetIdentity } }) as const;
					stall = true;
					const held = first.acquire(presence("target-held"), "broker-held", BROKER_LEASE_STALE_AFTER_MS);
					held.catch(() => {});
					await stalled;
					const targets = Array.from({ length: 50 }, (_, index) => `target-${index}`);
					try {
						const acquired = await Promise.race([
							Promise.all(
								targets.map((target, index) =>
									stores[index % stores.length]!.acquire(
										presence(target),
										`broker-${index % stores.length}`,
										BROKER_LEASE_STALE_AFTER_MS,
									),
								),
							),
							sleep(UNBLOCKED_SEND_MS).then(() => {
								throw new Error(
									`the acquisitions waited behind the uncommitted one for ${UNBLOCKED_SEND_MS} ms`,
								);
							}),
						]);
						assert.deepEqual(new Set(acquired.map((result) => result.status)), new Set(["acquired"]));
					} finally {
						commit();
					}
					assert.equal((await held).status, "acquired");
					const orders = await (await scope.connect()).all<{ first_acquired_order: number | bigint }>(
						`SELECT first_acquired_order FROM ${scope.prefix}intercom_leases WHERE kind = 'presence'`,
					);
					assert.equal(orders.length, targets.length + 1);
					assert.equal(new Set(orders.map((row) => Number(row.first_acquired_order))).size, targets.length + 1);
				} finally {
					await scope.close();
				}
			},
		);
	if (backend.name === "Postgres")
		for (const before of ["absent", "released", "stale"] as const)
			run(
				`${intercom}: a registration over a ${before} presence finds a send to it that read no live presence (#5607, #6560)`,
				async () => {
					const scope = await backend.openScope();
					try {
						const options = async () => ({ database: await scope.connect(), prefix: scope.prefix });
						const leases = await openSqlBrokerLeaseStore(await options());
						const claimer = await openSqlOutboxStore(await options());
						const target = "target-r";
						const presence = {
							kind: "presence",
							targetIdentity: target,
							session: { ...sender, id: "r" },
						} as const;
						if (before !== "absent") {
							const earlier = await leases.acquire(presence, "broker-old", BROKER_LEASE_STALE_AFTER_MS);
							assert.equal(earlier.status, "acquired");
							if (earlier.status !== "acquired") return;
							if (before === "released") assert.equal((await leases.release(earlier.lease)).status, "released");
							else
								await (await scope.connect()).run(
									`UPDATE ${scope.prefix}intercom_leases SET renewed_at = renewed_at - ? WHERE kind = 'presence'`,
									10 * BROKER_LEASE_STALE_AFTER_MS,
								);
						}
						// A send whose transaction read the presence and stalls before its commit.
						let entered!: () => void;
						const reading = new Promise<void>((resolve) => {
							entered = resolve;
						});
						let commit!: () => void;
						const committing = new Promise<void>((resolve) => {
							commit = resolve;
						});
						let stall = false;
						const sending = await scope.connect();
						const stalling = new Proxy(sending, {
							get(target, key) {
								if (key !== "transaction") return Reflect.get(target, key, target);
								return (callback: (tx: SqliteExecutor) => Promise<unknown>, transactionOptions?: object) =>
									target.transaction(async (tx) => {
										const result = await callback(tx);
										if (stall) {
											entered();
											await committing;
										}
										return result;
									}, transactionOptions);
							},
						}) as SqliteDatabase;
						const outbox = await openSqlOutboxStore({ database: stalling, prefix: scope.prefix });
						const [, request] = send("m-raced", "d-raced", target);
						stall = true;
						const sent = outbox.enqueue({ ...request, wakeHostWithinMs: BROKER_LEASE_STALE_AFTER_MS });
						await reading;
						// The registration: its presence lease, then its first scan of the outbox.
						const registration = (async () => {
							const acquired = await leases.acquire(presence, "broker-r", BROKER_LEASE_STALE_AFTER_MS);
							const claimed = await claimer.claim({
								claimantId: "broker-r",
								targetIdentity: target,
								staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
							});
							return { acquired, claimed };
						})();
						await Promise.race([registration, sleep(500)]);
						commit();
						assert.equal((await sent).status, "inserted");
						const { acquired, claimed } = await registration;
						assert.equal(acquired.status, "acquired");
						assert.deepEqual(
							claimed.status === "claimed" ? claimed.rows.map(({ row }) => row.messageId) : claimed.status,
							["m-raced"],
						);
					} finally {
						await scope.close();
					}
				},
			);
	if (backend.name === "Postgres")
		run(
			`${intercom}: a send's wake-up hint for an offline recipient's host is notified, not left to the backup poll (#5607, #6560)`,
			async () => {
				const scope = await backend.openScope();
				try {
					const host = await openIntercomBrokerState(
						{ prefix: scope.prefix, openDatabase: () => scope.connect() },
						{ pollIntervalMs: UNNOTIFIED_POLL_MS },
					);
					const sending = await openIntercomBrokerState({
						prefix: scope.prefix,
						openDatabase: () => scope.connect(),
					});
					try {
						const hints: number[] = [];
						let resynced!: () => void;
						const subscribed = new Promise<void>((resolve) => {
							resynced = resolve;
						});
						await host.bus.subscribe("broker-host", (event) => {
							if (event.kind === "hint") hints.push(event.hint.version);
							else resynced();
						});
						await subscribed;
						// Its first poll has run: from here only a notification brings a hint before the next one.
						await sleep(1_000);
						const presence = {
							kind: "presence",
							targetIdentity: "target-a",
							session: { ...sender, id: "r" },
						} as const;
						assert.equal(
							(await host.state.leases.acquire(presence, "broker-host", BROKER_LEASE_STALE_AFTER_MS)).status,
							"acquired",
						);
						const [, request] = send("m-woken", "d-woken");
						const sent = await sending.state.outbox.enqueue({
							...request,
							wakeHostWithinMs: BROKER_LEASE_STALE_AFTER_MS,
						});
						assert.equal(sent.status === "inserted" ? sent.woke : sent.status, "broker-host");
						const deadline = performance.now() + NOTIFIED_HINT_MS;
						while (hints.length === 0 && performance.now() < deadline) await sleep(20);
						assert.equal(hints.length, 1, `no hint within ${NOTIFIED_HINT_MS} ms`);
					} finally {
						for (const { state, bus } of [host, sending]) {
							await bus.close();
							await state.close();
						}
					}
				} finally {
					await scope.close();
				}
			},
			UNNOTIFIED_POLL_MS,
		);
	if (backend.name === "Postgres")
		run(
			`${intercom}: a presence renewal does not wait for another connection's write of an unrelated domain (#6560)`,
			async () => {
				const scope = await backend.openScope();
				try {
					const leases = await openSqlBrokerLeaseStore({ database: await scope.connect(), prefix: scope.prefix });
					const presence = {
						kind: "presence",
						targetIdentity: "target-a",
						session: { ...sender, id: "r" },
					} as const;
					const acquired = await leases.acquire(presence, "broker-a", BROKER_LEASE_STALE_AFTER_MS);
					assert.equal(acquired.status, "acquired");
					if (acquired.status !== "acquired") return;
					const holder = await scope.connect();
					let release!: () => void;
					let holding!: () => void;
					const held = new Promise<void>((resolve) => {
						holding = resolve;
					});
					const stalled = holder.transaction(
						async (tx) => {
							await tx.get("SELECT 1 AS one");
							holding();
							await new Promise<void>((resolve) => {
								release = resolve;
							});
						},
						{ concurrency: { kind: "serial", domain: `${scope.prefix}sessions:unrelated` } },
					);
					await held;
					try {
						const renewed = await Promise.race([
							leases.renew(acquired.lease, presence),
							sleep(UNBLOCKED_SEND_MS).then(() => {
								throw new Error(`the renewal waited behind the unrelated write for ${UNBLOCKED_SEND_MS} ms`);
							}),
						]);
						assert.equal(renewed.status, "renewed");
					} finally {
						release();
						await stalled;
					}
				} finally {
					await scope.close();
				}
			},
		);
	run(
		`${intercom}: messages queued for an offline session reach it, once it registers on its sender's broker, before the sender's later sends, however slow the broker's first claim of them is (#6637)`,
		async () => {
			const scope = await backend.openScope();
			const directory = makeTempDirectory("intercom-matrix-handoff-");
			const nodes: Node[] = [];
			let unstall = () => {};
			try {
				const shared = await scope.connect();
				for (const name of ["node-0", "node-1"])
					nodes.push(await Node.start(name, directory, shared, undefined, scope.prefix));
				const [a, b] = nodes as [Node, Node];
				const sender = await a.connect("sender");
				const returnAddress = randomUUID();
				const away = await b.connect("mover", { returnAddress });
				b.leave(away);
				await waitOffline(a, away);
				const queued = [0, 1, 2, 3].map((index) => message({ content: { text: `queued-${index}` } }));
				for (const sent of queued)
					assert.equal((await sendAndSettle(a, sender, away.info.id, sent)).type, "queued", sent.content.text);
				// The sender's broker claims the queued messages slower than a local send's lookups are bounded, as a claim
				// that follows the registration's writes to a far-away database does.
				const outbox = a.opened.state.outbox;
				const claim = outbox.claim.bind(outbox);
				const stalled = new Promise<void>((resolve) => {
					unstall = resolve;
				});
				Object.assign(outbox, {
					claim: async (request: Parameters<typeof claim>[0]) => {
						await stalled;
						return claim(request);
					},
				});
				// The session registers on its sender's broker, and the sender sends again at once.
				const moved = await a.connect("mover", { returnAddress, id: away.info.id });
				const later = [0, 1, 2, 3].map((index) => message({ content: { text: `later-${index}` } }));
				for (const sent of later) a.send(sender, away.info.id, sent);
				const texts = () =>
					framesOf(moved).flatMap((frame) => (frame.type === "message" ? [frame.message.content.text] : []));
				await sleep(3 * LOCAL_RETRY_LOOKUP_BOUND_MS);
				assert.deepEqual(texts(), [], "nothing overtook the queued messages");
				unstall();
				await waitFor(() => (texts().length >= 8 ? true : undefined));
				assert.deepEqual(
					texts(),
					[...queued, ...later].map((sent) => sent.content.text),
				);
			} finally {
				unstall();
				for (const node of nodes) await node.close();
				await scope.close();
				removeTempDirectory(directory);
			}
		},
	);
	registerCrossNodeHeldRoundTripConformance(run, intercom, {
		openReservations: scopeFixture(backend, openSqlRestoringReservationStore),
		openHeldSends: scopeFixture(backend, openSqlHeldSendStore),
		openOutbox: openMemoryOutboxFixture,
		openBus: openMemoryWakeUpBusFixture,
	});
}
