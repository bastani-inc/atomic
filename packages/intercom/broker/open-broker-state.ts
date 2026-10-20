import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	loadStorageAdapter,
	openNodeSqliteDatabase,
	resolveAdapterOptions,
	type SqliteDatabase,
	type StorageOpenContext,
	type StorageSettingsSelection,
	StorageUnavailableError,
	selectStorage,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
import { type DatabaseWakeUpBusOptions, openDatabaseWakeUpBus } from "./database-wake-up-bus.js";
import type { IntercomBrokerStateStore } from "./multinode-state-store.js";
import { openSqlHeldSendStore } from "./sql-held-send-store.js";
import { openSqlKnownSessionStore } from "./sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "./sql-lease-store.js";
import { openSqlOutboxStore } from "./sql-outbox-store.js";
import { openSqlPendingAskStore } from "./sql-pending-ask-store.js";
import { openSqlRestoringReservationStore } from "./sql-restoring-reservation-store.js";
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

function resolveSettingsPath(path: string, agentDir: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
		return join(homedir(), path.slice(2));
	}
	return isAbsolute(path) ? path : resolve(dirname(agentDir), path);
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
	const selection = selectStorage(value, "settings", "storage", join(dirname(agentDir), "storage.sqlite"));
	if (selection.kind === "memory") return { status: "off", reason: "memory" };
	if (selection.kind === "sqlite") {
		if (selection.path === "" || selection.path === ":memory:") return { status: "off", reason: "memory" };
		const path = resolveSettingsPath(selection.path, agentDir);
		validateStoragePrefix(selection.prefix);
		return {
			status: "shared",
			source: { openDatabase: () => openNodeSqliteDatabase(path), prefix: selection.prefix },
		};
	}
	if (selection.kind !== "adapter") return { status: "off", reason: "no-storage" };
	validateStoragePrefix(selection.prefix);
	const context: StorageOpenContext = { agentDir, domain: "intercom" };
	// Destructured: the broker's runtime-graph walker reads a bare `module` identifier as the CJS module object.
	const { module: adapterModule } = selection;
	const adapter = await loadStorageAdapter(adapterModule, context);
	const hook = adapter.openDatabase?.bind(adapter);
	if (hook === undefined) return { status: "off", reason: "domain-only-adapter" };
	const options = await resolveAdapterOptions(selection, context);
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
 * write while one of the stores' transactions is suspended between statements.
 */
export function borrowedDatabase(database: SqliteDatabase): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: (sql, ...params) => database.get(sql, ...params),
		all: (sql, ...params) => database.all(sql, ...params),
		transaction: (callback) => database.transaction(callback),
		close: async () => {},
	};
}

/** Compose S1–S4 and the S5 known-session store, and the wake-up bus, on one connection. */
export async function openIntercomBrokerState(
	source: SharedDatabaseSource,
	busOptions: Pick<DatabaseWakeUpBusOptions, "pollIntervalMs" | "schedule"> = {},
): Promise<OpenedBrokerState> {
	const database = await source.openDatabase();
	try {
		const options = { database, prefix: source.prefix ?? "" };
		const leases = await openSqlBrokerLeaseStore(options);
		const outbox = await openSqlOutboxStore(options);
		const heldSends = await openSqlHeldSendStore(options);
		const reservations = await openSqlRestoringReservationStore(options);
		const pendingAsks = await openSqlPendingAskStore(options);
		const sentMessages = await openSqlSentMessageAuthority(options);
		const knownSessions = await openSqlKnownSessionStore(options);
		const bus = await openDatabaseWakeUpBus({
			openDatabase: async () => borrowedDatabase(database),
			prefix: source.prefix,
			...busOptions,
		});
		let closing: Promise<void> | undefined;
		const state: IntercomBrokerStateStore = {
			leases,
			outbox,
			heldSends,
			reservations,
			pendingAsks,
			sentMessages,
			knownSessions,
			close() {
				closing ??= database.close();
				return closing;
			},
		};
		return { state, bus };
	} catch (cause) {
		await database.close().catch(() => {});
		throw cause;
	}
}
