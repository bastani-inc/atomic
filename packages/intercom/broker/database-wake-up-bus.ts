import { type SqliteDatabase, type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
import { OUTBOX_BACKUP_POLL_INTERVAL_MS } from "./multinode-state-store.js";
import type {
	WakeUpBus,
	WakeUpEvent,
	WakeUpHint,
	WakeUpListener,
	WakeUpPublishResult,
	WakeUpSubscribeResult,
	WakeUpSubscription,
} from "./wake-up-bus.js";

/**
 * S4 wake-up bus (specs/2026-10-19-intercom-multi-node.md §5.6): a hint log in the shared storage database. Each
 * connection polls the rows addressed to its subscribed brokers, delivers them and deletes them. A failed query drops
 * the connection; the next poll or publish reopens it and every subscription gets a `reconnected` resync, because
 * hints written meanwhile may have been pruned or missed.
 */

/** How often a connection with subscriptions reads its hints. */
export const WAKE_UP_POLL_INTERVAL_MS = 500;
/** Hints nobody consumed (their broker exited) are deleted after this age; the backup poll has covered them. */
export const WAKE_UP_HINT_RETENTION_MS = OUTBOX_BACKUP_POLL_INTERVAL_MS;
/**
 * Hints read and deleted per statement; a poll repeats until a batch comes back short. Each batch's delete binds one
 * parameter per hint, so a backlog never exceeds SQLite's bound-parameter limit (999 on old builds).
 */
export const WAKE_UP_POLL_BATCH_SIZE = 500;

/** Runs `callback` once after `delayMs` and returns a function that cancels it. */
export type WakeUpPollScheduler = (callback: () => void, delayMs: number) => () => void;

export interface DatabaseWakeUpBusOptions {
	/** Opens a connection to the shared storage database; called again after every dropped connection. */
	readonly openDatabase: () => Promise<SqliteDatabase>;
	/** The validated storage prefix; the table is `<prefix>intercom_wakeups`. */
	readonly prefix?: string;
	readonly pollIntervalMs?: number;
	readonly schedule?: WakeUpPollScheduler;
}

interface HintRow extends SqliteRow {
	readonly id: number;
	readonly broker_id: string;
	readonly reason: string;
	readonly version: number;
}

interface DatabaseSubscription {
	readonly brokerId: string;
	readonly listener: WakeUpListener;
	open: boolean;
}

const DATABASE_NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const scheduleTimeout: WakeUpPollScheduler = (callback, delayMs) => {
	const timer = setTimeout(callback, delayMs);
	timer.unref?.();
	return () => clearTimeout(timer);
};

async function createSchema(database: SqliteDatabase, table: string): Promise<void> {
	await database.exec(
		`CREATE TABLE IF NOT EXISTS ${table} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			broker_id TEXT NOT NULL,
			reason TEXT NOT NULL CHECK (reason IN ('outbox', 'outcome')),
			version INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS ${table}_broker ON ${table} (broker_id, id);
		CREATE INDEX IF NOT EXISTS ${table}_created ON ${table} (created_at);`,
	);
}

async function openSchemaConnection(options: DatabaseWakeUpBusOptions, table: string): Promise<SqliteDatabase> {
	const database = await options.openDatabase();
	try {
		await createSchema(database, table);
	} catch (cause) {
		await database.close().catch(() => {});
		throw cause;
	}
	return database;
}

class DatabaseWakeUpBus implements WakeUpBus {
	private readonly subscriptions = new Set<DatabaseSubscription>();
	private readonly options: DatabaseWakeUpBusOptions;
	private readonly table: string;
	private readonly pollIntervalMs: number;
	private readonly schedule: WakeUpPollScheduler;
	private database: SqliteDatabase | undefined;
	private opening: Promise<SqliteDatabase | undefined> | undefined;
	private cancelPoll: (() => void) | undefined;
	private polling: Promise<void> | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;

	constructor(options: DatabaseWakeUpBusOptions, table: string, database: SqliteDatabase) {
		this.options = options;
		this.table = table;
		this.database = database;
		this.pollIntervalMs = options.pollIntervalMs ?? WAKE_UP_POLL_INTERVAL_MS;
		this.schedule = options.schedule ?? scheduleTimeout;
	}

	async publish(hint: WakeUpHint): Promise<WakeUpPublishResult> {
		if (hint.brokerId.length === 0) return { status: "invalid", reason: "empty-broker-id" };
		const database = await this.connection();
		if (database === undefined) return { status: "unavailable" };
		try {
			await database.run(
				`INSERT INTO ${this.table} (broker_id, reason, version, created_at) VALUES (?, ?, ?, ${DATABASE_NOW_MS})`,
				hint.brokerId,
				hint.reason,
				hint.version,
			);
			await database.run(
				`DELETE FROM ${this.table} WHERE created_at < ${DATABASE_NOW_MS} - ?`,
				WAKE_UP_HINT_RETENTION_MS,
			);
		} catch {
			this.drop(database);
			return { status: "unavailable" };
		}
		return { status: "published" };
	}

	async subscribe(brokerId: string, listener: WakeUpListener): Promise<WakeUpSubscribeResult> {
		if (brokerId.length === 0) return { status: "invalid", reason: "empty-broker-id" };
		if (this.closed) return { status: "unavailable" };
		const subscription: DatabaseSubscription = { brokerId, listener, open: true };
		this.subscriptions.add(subscription);
		this.deliver(subscription, { kind: "resync", cause: "subscribed" });
		this.armPoll();
		const handle: WakeUpSubscription = {
			brokerId,
			close: async () => {
				subscription.open = false;
				this.subscriptions.delete(subscription);
			},
		};
		return { status: "subscribed", subscription: handle };
	}

	close(): Promise<void> {
		this.closing ??= this.shutdown();
		return this.closing;
	}

	private async shutdown(): Promise<void> {
		this.closed = true;
		this.cancelPoll?.();
		this.cancelPoll = undefined;
		for (const subscription of this.subscriptions) subscription.open = false;
		this.subscriptions.clear();
		await this.polling;
		await this.opening;
		const database = this.database;
		this.database = undefined;
		await database?.close().catch(() => {});
	}

	private deliver(subscription: DatabaseSubscription, event: WakeUpEvent): void {
		queueMicrotask(() => {
			if (subscription.open) subscription.listener(event);
		});
	}

	private armPoll(): void {
		if (this.closed || this.cancelPoll !== undefined || this.polling !== undefined) return;
		if (this.subscriptions.size === 0) return;
		this.cancelPoll = this.schedule(() => {
			this.cancelPoll = undefined;
			this.polling = this.poll().finally(() => {
				this.polling = undefined;
				this.armPoll();
			});
		}, this.pollIntervalMs);
	}

	private async poll(): Promise<void> {
		const database = await this.connection();
		const brokerIds = [...new Set([...this.subscriptions].map((subscription) => subscription.brokerId))];
		if (database === undefined || brokerIds.length === 0) return;
		const placeholders = brokerIds.map(() => "?").join(", ");
		for (;;) {
			let rows: HintRow[];
			try {
				rows = await database.all<HintRow>(
					`SELECT id, broker_id, reason, version FROM ${this.table} WHERE broker_id IN (${placeholders}) ORDER BY id LIMIT ${WAKE_UP_POLL_BATCH_SIZE}`,
					...brokerIds,
				);
				if (rows.length > 0) {
					await database.run(
						`DELETE FROM ${this.table} WHERE id IN (${rows.map(() => "?").join(", ")})`,
						...rows.map((row) => row.id),
					);
				}
			} catch {
				this.drop(database);
				return;
			}
			for (const row of rows) {
				const hint: WakeUpHint = {
					brokerId: row.broker_id,
					reason: row.reason === "outcome" ? "outcome" : "outbox",
					version: row.version,
				};
				for (const subscription of this.subscriptions) {
					if (subscription.brokerId === hint.brokerId) this.deliver(subscription, { kind: "hint", hint });
				}
			}
			if (rows.length < WAKE_UP_POLL_BATCH_SIZE || this.closed) return;
		}
	}

	private connection(): Promise<SqliteDatabase | undefined> {
		if (this.closed) return Promise.resolve(undefined);
		if (this.database !== undefined) return Promise.resolve(this.database);
		this.opening ??= this.reconnect().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	private async reconnect(): Promise<SqliteDatabase | undefined> {
		let database: SqliteDatabase;
		try {
			database = await openSchemaConnection(this.options, this.table);
		} catch {
			return undefined;
		}
		if (this.closed) {
			await database.close().catch(() => {});
			return undefined;
		}
		this.database = database;
		for (const subscription of this.subscriptions) {
			this.deliver(subscription, { kind: "resync", cause: "reconnected" });
		}
		return database;
	}

	private drop(database: SqliteDatabase): void {
		if (this.database !== database) return;
		this.database = undefined;
		void database.close().catch(() => {});
	}
}

/** Opens one broker's connection to the database wake-up bus; a failure to open the database is thrown. */
export async function openDatabaseWakeUpBus(options: DatabaseWakeUpBusOptions): Promise<WakeUpBus> {
	const table = `${validateStoragePrefix(options.prefix)}intercom_wakeups`;
	return new DatabaseWakeUpBus(options, table, await openSchemaConnection(options, table));
}
