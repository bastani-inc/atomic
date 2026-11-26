import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	adapterOpenContext,
	defaultSharedStoragePath,
	dialectOf,
	loadStorageAdapter,
	openNodeSqliteDatabase,
	resolveAdapterOptions,
	type SqliteDatabase,
	type StorageOpenContext,
	type StorageSettingsSelection,
	StorageUnavailableError,
	selectStorage,
	storagePathBaseDir,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
import { type DatabaseWakeUpBusOptions, openDatabaseWakeUpBus } from "./database-wake-up-bus.js";
import type { IntercomBrokerStateStore } from "./multinode-state-store.js";
import { ensureEndedChildQueueSchema, openSqlEndedChildQueueStore } from "./sql-ended-child-queue-store.js";
import { openSqlHeldSendStore } from "./sql-held-send-store.js";
import { openSqlKnownSessionStore } from "./sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "./sql-lease-store.js";
import { openSqlOutboxStore, recipientTransaction, runLast, withoutFailedWake } from "./sql-outbox-store.js";
import { openSqlPendingAskStore } from "./sql-pending-ask-store.js";
import { openSqlReleasedAskStore } from "./sql-released-ask-store.js";
import { openSqlRestoringReservationStore } from "./sql-restoring-reservation-store.js";
import { withBrokerSchemaCatalog } from "./sql-schema.js";
import { openSqlSentMessageAuthority } from "./sql-sent-message-authority.js";
import type { WakeUpBus } from "./wake-up-bus.js";

/**
 * S5 (specs/2026-10-19-intercom-multi-node.md §4, §14): opens the shared Intercom broker state on the top-level
 * `storage` selection of the agent directory's settings. The broker loads this module lazily, only when that
 * selection is set, so single-node brokers never load the host storage layer.
 */

/** Where the shared Intercom state lives: a database opener and the selection's table prefix. */
export interface SharedDatabaseSource {
	/** Opens the connection the stores and the wake-up bus share. */
	readonly openDatabase: () => Promise<SqliteDatabase>;
	readonly prefix?: string;
}

export interface OpenedBrokerState {
	readonly state: IntercomBrokerStateStore;
	readonly bus: WakeUpBus;
}

/** Why multi-node routing is off: there is no `SqliteDatabase` to share, so Intercom behaves exactly as today. */
export type BrokerStateOffReason = "no-storage" | "memory" | "domain-only-adapter";

export type BrokerStateSource =
	| { readonly status: "off"; readonly reason: BrokerStateOffReason }
	| { readonly status: "shared"; readonly source: SharedDatabaseSource };

function resolveSettingsPath(
	path: string,
	agentDir: string,
	storage: StorageSettingsSelection | undefined,
): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
		return join(homedir(), path.slice(2));
	}
	return isAbsolute(path) ? path : resolve(storagePathBaseDir(path, agentDir, { storage }), path);
}

/**
 * Decide from a top-level `storage` value where the shared state lives. Invalid configuration throws the storage
 * layer's own `StorageConfigError` or `StorageAdapterLoadError`; it never selects another store.
 */
export async function resolveBrokerStateSource(
	value: StorageSettingsSelection | undefined,
	agentDir: string,
): Promise<BrokerStateSource> {
	if (value === undefined) return { status: "off", reason: "no-storage" };
	const selection = selectStorage(value, "settings", "storage", () =>
		defaultSharedStoragePath(agentDir, { storage: value }),
	);
	if (selection.kind === "memory") return { status: "off", reason: "memory" };
	if (selection.kind === "sqlite") {
		if (selection.path === "" || selection.path === ":memory:") return { status: "off", reason: "memory" };
		const path = resolveSettingsPath(selection.path, agentDir, value);
		validateStoragePrefix(selection.prefix);
		return {
			status: "shared",
			source: { openDatabase: () => openNodeSqliteDatabase(path), prefix: selection.prefix },
		};
	}
	if (selection.kind !== "adapter") return { status: "off", reason: "no-storage" };
	validateStoragePrefix(selection.prefix);
	const context: StorageOpenContext = adapterOpenContext(selection, { agentDir, domain: "intercom" });
	// Destructured: the broker's runtime-graph walker reads a bare `module` identifier as the CJS module object.
	const { module: adapterModule } = selection;
	const adapter = await loadStorageAdapter(adapterModule, context);
	const hook = adapter.openDatabase?.bind(adapter);
	if (hook === undefined) return { status: "off", reason: "domain-only-adapter" };
	const options = await resolveAdapterOptions(selection, context, adapter.liveSecrets);
	const location = { adapter: adapterModule, location: adapterModule };
	return {
		status: "shared",
		source: {
			prefix: selection.prefix,
			async openDatabase() {
				try {
					return await hook(options, context);
				} catch (cause) {
					if (cause instanceof StorageUnavailableError) throw cause;
					throw new StorageUnavailableError(location, cause as Error);
				}
			},
		},
	};
}

/**
 * A view of `database` whose `close` leaves it open. The wake-up bus borrows the stores' connection: a SQLite driver
 * that waits for a lock synchronously (node:sqlite) would otherwise block this process on a second connection's
 * write while one of the stores' transactions is suspended between statements. Every other field, such as the
 * dialect and the batch method, is the database's own, so the bus speaks Postgres on Postgres (#5054).
 */
export function borrowedDatabase(database: SqliteDatabase): SqliteDatabase {
	const close = async () => {};
	return new Proxy(database, { get: (target, key) => (key === "close" ? close : Reflect.get(target, key)) });
}

/**
 * Creates the tables a broker creates only on first use, today the ended-child queue's, for `atomic storage migrate`:
 * with `openIntercomBrokerState`, every table a broker needs, so a runtime role that may not create tables finds them
 * (#6560).
 */
export async function ensureLazyIntercomSchemas(source: SharedDatabaseSource): Promise<void> {
	const database = await source.openDatabase();
	try {
		await ensureEndedChildQueueSchema({ database, prefix: source.prefix ?? "" });
	} finally {
		await database.close();
	}
}

/** Compose S1–S4 and the S5 known-session store, and the wake-up bus, on one connection. */
export async function openIntercomBrokerState(
	source: SharedDatabaseSource,
	busOptions: Pick<DatabaseWakeUpBusOptions, "pollIntervalMs" | "listeningPollIntervalMs" | "schedule"> = {},
): Promise<OpenedBrokerState> {
	const database = await source.openDatabase();
	let reader: SqliteDatabase | undefined;
	try {
		// The backend is known once the database is open: refuse a prefix too long for it before creating anything (#5067).
		validateStoragePrefix(source.prefix, dialectOf(database).name);
		// Reads that answer within a bound go through a handle of their own, never queued behind the writes (#6560).
		reader = await database.openReader?.();
		const options = { database, prefix: source.prefix ?? "", ...(reader === undefined ? {} : { reader }) };
		const borrowed = borrowedDatabase(database);
		const openStores = async () => {
			const leases = await openSqlBrokerLeaseStore(options);
			const outbox = await openSqlOutboxStore(options);
			const heldSends = await openSqlHeldSendStore(options);
			const reservations = await openSqlRestoringReservationStore(options);
			const pendingAsks = await openSqlPendingAskStore(options);
			const releasedAsks = await openSqlReleasedAskStore(options);
			const sentMessages = await openSqlSentMessageAuthority(options);
			const knownSessions = await openSqlKnownSessionStore(options);
			const bus = await openDatabaseWakeUpBus({
				openDatabase: async () => borrowed,
				prefix: source.prefix,
				...busOptions,
				...(reader === undefined ? {} : { reader }),
			});
			return { leases, outbox, heldSends, reservations, pendingAsks, releasedAsks, sentMessages, knownSessions, bus };
		};
		// One read of the schema for every store: a broker whose stores are current opens without a schema transaction,
		// so brokers starting together neither take nor wait for the database's write lock (#6560).
		const { leases, outbox, heldSends, reservations, pendingAsks, releasedAsks, sentMessages, knownSessions, bus } =
			await withBrokerSchemaCatalog(database, options.prefix, openStores, [borrowed]);
		let closing: Promise<void> | undefined;
		const state: IntercomBrokerStateStore = {
			leases,
			outbox,
			heldSends,
			reservations,
			pendingAsks,
			releasedAsks,
			sentMessages,
			knownSessions,
			reserveAndEnqueue(reservation, request) {
				// The recipient's domain: sends to it run one at a time, and sends to others beside them (#6560).
				const send = recipientTransaction(database, source.prefix, request.targetIdentity);
				// The reservation's read and the enqueue's go out with the transaction's start, the reservation's write
				// and the row's insert together, then the commit, on a pipelined connection: three round trips (#6560).
				const leading = (attempt: typeof request) => [
					sentMessages.lookupStatement(reservation.messageId),
					...outbox.enqueueLeading(attempt),
				];
				// #5607: written again, without it, when only an offline recipient's wake-up hint failed.
				return withoutFailedWake(request, (attempt) =>
					database.transaction(async (tx) => {
						const key = { messageId: reservation.messageId, digest: reservation.digest };
						const earlier = await sentMessages.lookupIn(tx, key);
						if (earlier.status === "conflict")
							return { status: "conflict", messageId: reservation.messageId } as const;
						// The reservation is written first and the row inserted only under it: a reservation of the message
						// with another digest, on another connection and in no domain of this recipient, either commits first
						// and the row is refused, or waits for this send and is refused itself (#6560).
						const reserve = sentMessages.reserveStatement(reservation);
						const enqueued = await outbox.enqueueIn(
							tx,
							attempt,
							reserve === undefined
								? undefined
								: { first: reserve, condition: sentMessages.reservedCondition(key) },
						);
						if (enqueued.status === "full") {
							// Refused before anything was written, so the transaction has no commit to sync.
							if (earlier.status === "match") await sentMessages.forgetIn(tx, key);
							return enqueued;
						}
						// Another send's row of the message, with another digest: the reservation this send wrote goes too.
						if (enqueued.status === "conflict" && earlier.status === "miss") await sentMessages.forgetIn(tx, key);
						// A duplicate the leading read found wrote nothing: its reservation is recorded again, as before.
						else if (enqueued.status === "duplicate" && reserve !== undefined) await runLast(tx, reserve);
						return enqueued;
					}, { ...send, leading: leading(attempt) }),
				);
			},
			openEndedChildQueue(owner) {
				return openSqlEndedChildQueueStore(options, owner);
			},
			close() {
				closing ??= Promise.all([reader?.close(), database.close()]).then(() => {});
				return closing;
			},
		};
		return { state, bus };
	} catch (cause) {
		await reader?.close().catch(() => {});
		await database.close().catch(() => {});
		throw cause;
	}
}
