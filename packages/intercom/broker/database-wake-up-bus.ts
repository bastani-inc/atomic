import { createHash } from "node:crypto";
import * as storage from "@bastani/atomic/storage";
import {
	dialectOf,
	ensureStorageSchema,
	fencedPath,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteStatement,
	type StorageNotificationEvent,
	type StorageNotifications,
	type StorageNotificationSubscription,
	storageMigrationTable,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
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
import { addMissingColumns } from "./sql-add-column.js";
import { ensureBrokerSchema, openCatalogOf, RETRY_UNAPPLIED, withBrokerSchemaCatalog } from "./sql-schema.js";

/**
 * S4 wake-up bus (specs/2026-10-19-intercom-multi-node.md §5.6): a hint log in the shared storage database. Each
 * connection polls the rows addressed to its subscribed brokers, delivers them and deletes them. A failed query drops
 * the connection; the next poll or publish reopens it and every subscription gets a `reconnected` resync, because
 * hints written meanwhile may have been pruned or missed. While the database stays unavailable, reopening backs off
 * exponentially from the poll interval up to `WAKE_UP_RECONNECT_MAX_DELAY_MS`.
 *
 * On a database that delivers notifications (Postgres), a publish also notifies the hint's broker once the hint
 * commits, and a subscribed connection polls as soon as a notification for one of its brokers arrives (#5103). Each
 * broker has a channel of its own (`brokerWakeUpChannel`), so a notification reaches only the connection that hosts it;
 * brokers of earlier releases listen on the channel named like the table instead, which is notified too while the
 * broker's membership does not say it listens on its own (`wakeUpNotices`). A connection listens on both. The interval
 * poll stays: notifications are lost while the listening connection is down, and none arrive through a transaction
 * pooler. While the database reports its listening connection live, the poll only backs the notifications up and runs
 * at `WAKE_UP_LISTENING_POLL_INTERVAL_MS`; the listener's `listening` event, sent when it listens again after an
 * outage, polls at once (#6560).
 */

/** How often a connection with subscriptions reads its hints when no notification would announce them. */
export const WAKE_UP_POLL_INTERVAL_MS = 500;
/**
 * How often a connection with subscriptions reads its hints while its notifications are live: only a notification lost
 * in an outage the listener has not noticed yet waits for this poll.
 */
export const WAKE_UP_LISTENING_POLL_INTERVAL_MS = 5_000;
/** Hints nobody consumed (their broker exited) are deleted after this age; the backup poll has covered them. */
export const WAKE_UP_HINT_RETENTION_MS = OUTBOX_BACKUP_POLL_INTERVAL_MS;
/**
 * How often at most one connection deletes the hints past the retention, at a publish (#6560): a hint nobody consumed
 * then stays at most this much longer than the retention.
 */
export const WAKE_UP_PRUNE_INTERVAL_MS = 10_000;
/**
 * Hints read and deleted per statement; a poll repeats until a batch comes back short, so a backlog is taken in
 * statements of bounded size.
 */
export const WAKE_UP_POLL_BATCH_SIZE = 500;
/** Longest wait between attempts to reopen an unavailable database; the backup poll covers the gap. */
export const WAKE_UP_RECONNECT_MAX_DELAY_MS = OUTBOX_BACKUP_POLL_INTERVAL_MS;

/**
 * What a broker's membership subject holds, as the lease table stores it, when the broker listens on its own wake-up
 * channel (`BrokerMembershipSubject.ownWakeUpChannel`). A JSON string escapes its quotes, so only that field matches.
 */
export const OWN_WAKE_UP_CHANNEL_MARK = '"ownWakeUpChannel":true';

/**
 * The channel only `brokerId`'s connections listen on: the hint table's name and 64 bits of a hash of the broker id, so
 * it stays a short identifier whatever the id, as Que's `que_listener_<pid>`. A notification on it reaches that broker's
 * connection alone, where one on the table's channel reaches every broker's.
 */
export function brokerWakeUpChannel(table: string, brokerId: string): string {
	return `${table}_${createHash("sha256").update(brokerId).digest("hex").slice(0, 16)}`;
}

/**
 * The notifications that wake `brokerId` once the transaction that runs them commits: one on its own channel, and one on
 * the table's channel, where brokers of earlier releases listen, unless `brokerId`'s membership lease, in `leases`, says
 * it listens on its own. Both carry the broker id, which a listener checks.
 */
export function wakeUpNotices(
	notifications: StorageNotifications,
	table: string,
	leases: string,
	brokerId: string,
): SqliteStatement[] {
	return [
		notifications.notify(brokerWakeUpChannel(table, brokerId), brokerId),
		notifications.notify(table, brokerId, {
			sql: `SELECT 1 FROM ${leases} WHERE kind = 'broker' AND key = ? AND strpos(subject_json, ?) > 0`,
			params: [brokerId, OWN_WAKE_UP_CHANNEL_MARK],
		}),
	];
}

/** Runs `callback` once after `delayMs` and returns a function that cancels it. */
export type WakeUpPollScheduler = (callback: () => void, delayMs: number) => () => void;

export interface DatabaseWakeUpBusOptions {
	/** Opens a connection to the shared storage database; called again after every dropped connection. */
	readonly openDatabase: () => Promise<SqliteDatabase>;
	/** The validated storage prefix; the table is `<prefix>intercom_wakeups`. */
	readonly prefix?: string;
	readonly pollIntervalMs?: number;
	readonly listeningPollIntervalMs?: number;
	readonly schedule?: WakeUpPollScheduler;
	/**
	 * A separate handle on the same database that the poll reads its hints through, so a poll never queues behind the
	 * database's writes (#6560); the bus does not close it, and writes nothing through it. On PostgreSQL the poll reads
	 * nothing through it: it takes and deletes its hints in one statement (`DELETE … RETURNING`) on the database it
	 * opened. Absent: the poll runs on the database it opened.
	 */
	readonly reader?: SqliteExecutor;
}

interface HintRow extends SqliteRow {
	readonly id: number;
	readonly broker_id: string;
	readonly reason: string;
	readonly version: number;
	readonly target_identity: string | null;
}

/** The channels a connection listens on, each with its subscription, and the database it listens through. */
interface Listening {
	readonly database: SqliteDatabase;
	readonly channels: Map<string, StorageNotificationSubscription>;
	/** The database reported its listening connection live, as of the latest check. */
	live: boolean;
}

interface DatabaseSubscription {
	readonly brokerId: string;
	readonly listener: WakeUpListener;
	open: boolean;
}

const scheduleTimeout: WakeUpPollScheduler = (callback, delayMs) => {
	const timer = setTimeout(callback, delayMs);
	timer.unref?.();
	return () => clearTimeout(timer);
};

/**
 * `storageSchemaCurrent` of the storage API, which an Atomic installation older than #6560 lacks: a named import would
 * fail to link there, so it is taken from the module namespace, and without it the hint log's persistence is read from
 * the catalog at every open.
 */
const schemaApi: Partial<Pick<typeof storage, "storageSchemaCurrent">> = storage;

/** The ledger step, `schema:intercom-wakeups-unlogged`, that makes a hint log created as a logged table unlogged. */
const UNLOGGED_HINTS_DOMAIN = "intercom-wakeups-unlogged";

async function createSchema(database: SqliteDatabase, table: string, prefix: string | undefined): Promise<void> {
	const { types, name } = dialectOf(database);
	// On PostgreSQL the hint log is unlogged: its rows skip the write-ahead log, so a hint costs no log write and its
	// commit no flush to disk. A crash of the server empties it, which loses only hints, and the backup poll finds
	// every message they announced. In a serial transaction, so brokers opening a new bus at once take turns creating
	// it (#5054).
	const schema = `CREATE ${name === "postgres" ? "UNLOGGED " : ""}TABLE IF NOT EXISTS ${table} (
			id ${types.serialKey},
			broker_id TEXT NOT NULL,
			reason TEXT NOT NULL CHECK (reason IN ('outbox', 'outcome')),
			version ${types.int} NOT NULL,
			created_at ${types.int} NOT NULL,
			target_identity TEXT
		);
		CREATE INDEX IF NOT EXISTS ${table}_broker ON ${table} (broker_id, id);
		CREATE INDEX IF NOT EXISTS ${table}_created ON ${table} (created_at);`;
	// `target_identity`, the recipient a hint is about (`WakeUpHint.targetIdentity`), came later: a table an earlier
	// release created gets it here, and an earlier broker's hints leave it null. A table this open creates has it, so a
	// new database's first open spends nothing on it.
	const catalog = await openCatalogOf(database);
	const existed = catalog === undefined || catalog.hasTable(table);
	await ensureBrokerSchema(database, prefix, "wakeups", (tx) => tx.exec(schema));
	if (existed) await addMissingColumns(database, table, { target_identity: "TEXT" });
	await ensureUnloggedHints(database, table, prefix);
}

/**
 * Makes a hint log that an earlier Atomic created as a logged table unlogged on PostgreSQL, once per database, recorded
 * in the ledger as `schema:intercom-wakeups-unlogged`. `ALTER TABLE … SET UNLOGGED` needs the table's owner, so a
 * runtime role without DDL leaves it logged, as before, until `atomic storage migrate` runs as the owner. Earlier
 * Atomic releases use the unlogged table unchanged. The rewrite locks the table, which holds only hints younger than
 * the retention: when another broker holds it longer than the schema lock wait, the next open tries again.
 */
async function ensureUnloggedHints(database: SqliteDatabase, table: string, prefix: string | undefined): Promise<void> {
	const dialect = dialectOf(database);
	if (dialect.name !== "postgres" || database.readOnly === true) return;
	const schema = { ledger: storageMigrationTable(prefix), domain: UNLOGGED_HINTS_DOMAIN, revision: 1 };
	if (await schemaApi.storageSchemaCurrent?.(database, schema)) return;
	const found = await database.get<SqliteRow & { owned: boolean | number; unlogged: boolean | number }>(
		`SELECT pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS owned, c.relpersistence = 'u' AS unlogged
		FROM pg_catalog.pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ?`,
		dialect.identifier(table),
	);
	const yes = (value: boolean | number | undefined) => value === true || Number(value) === 1;
	// An unlogged table only needs the step recorded, which any role that writes the ledger may do.
	if (found === undefined || (!yes(found.unlogged) && !yes(found.owned))) return;
	try {
		await database.transaction(
			(tx) =>
				ensureStorageSchema(tx, dialect, schema, async () => {
					if (!yes(found.unlogged)) await tx.exec(`ALTER TABLE ${table} SET UNLOGGED`);
				}),
			{ concurrency: { kind: "serial", domain: schema.ledger } },
		);
	} catch {
		// The table stays as it was: hints work the same in a logged table.
	}
}

/**
 * Opens a connection to the bus's database and sets up its table, checked against one read of the schema catalog, so a
 * current table costs no transaction or lock (#6560). With `schemaSetUp`, this bus set the table up already, on an
 * earlier connection: a schema only moves forward, so the connection runs no schema statement at all.
 */
async function openSchemaConnection(
	options: DatabaseWakeUpBusOptions,
	table: string,
	schemaSetUp = false,
): Promise<SqliteDatabase> {
	const database = await options.openDatabase();
	try {
		// Refused before anything is created when the prefix is too long for this backend's identifiers (#5067).
		validateStoragePrefix(options.prefix, dialectOf(database).name);
		if (!schemaSetUp)
			await withBrokerSchemaCatalog(database, options.prefix, () => createSchema(database, table, options.prefix));
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
	/** The lease table, whose membership leases say which brokers listen on their own channels. */
	private readonly leases: string;
	private readonly pollIntervalMs: number;
	private readonly listeningPollIntervalMs: number;
	private readonly schedule: WakeUpPollScheduler;
	private database: SqliteDatabase | undefined;
	private opening: Promise<SqliteDatabase | undefined> | undefined;
	private cancelPoll: (() => void) | undefined;
	private polling: Promise<void> | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;
	/** Consecutive failed attempts to reopen the database; each doubles the wait before the next. */
	private reconnectFailures = 0;
	private reconnectNotBefore = 0;
	/**
	 * The notification channels this connection listens on, each with its subscription: the table's and each subscribed
	 * broker's own (`brokerWakeUpChannel`). And the database it listens through.
	 */
	private listening: Listening | undefined;
	/** A notification arrived during a poll: the next poll runs as soon as that one ends. */
	private pollAgain = false;
	/** When a publish last deleted the hints past the retention, by this process's clock. */
	private prunedAt: number | undefined;

	constructor(options: DatabaseWakeUpBusOptions, table: string, database: SqliteDatabase) {
		this.options = options;
		this.table = table;
		this.leases = `${validateStoragePrefix(options.prefix)}intercom_leases`;
		this.database = database;
		this.pollIntervalMs = options.pollIntervalMs ?? WAKE_UP_POLL_INTERVAL_MS;
		this.listeningPollIntervalMs = options.listeningPollIntervalMs ?? WAKE_UP_LISTENING_POLL_INTERVAL_MS;
		this.schedule = options.schedule ?? scheduleTimeout;
	}

	async publish(hint: WakeUpHint): Promise<WakeUpPublishResult> {
		if (hint.brokerId.length === 0) return { status: "invalid", reason: "empty-broker-id" };
		const database = await this.connection(false);
		if (database === undefined) return { status: "unavailable" };
		const { nowMs } = dialectOf(database);
		const insert: SqliteStatement = {
			sql: `INSERT INTO ${this.table} (broker_id, reason, version, created_at, target_identity) VALUES (?, ?, ?, ${nowMs}, ?)`,
			params: [hint.brokerId, hint.reason, hint.version, hint.targetIdentity ?? null],
		};
		const notifications = database.notifications;
		try {
			if (notifications === undefined) await database.run(insert.sql, ...insert.params);
			else {
				// The notifications go out once the hint commits, so the poll they start finds the hint: on Postgres right
				// behind its commit, in the same round trip, and the insert goes with the transaction's start (#6560). A hint
				// is a new row that no write checks first, so its writers take no lock domain: see
				// `fencedPath("intercom-wakeup-hint")`.
				const notices = wakeUpNotices(notifications, this.table, this.leases, hint.brokerId);
				await database.transaction(
					async (tx) => {
						await Promise.all([insert, ...notices].map(({ sql, params }) => tx.run(sql, ...params)));
					},
					{
						...RETRY_UNAPPLIED,
						concurrency: { kind: "fenced", audit: fencedPath("intercom-wakeup-hint") },
						leading: [insert],
					},
				);
			}
			// #6560: at most once per interval, not at every publish: each prune is a write every broker would send.
			if (this.prunedAt === undefined || Date.now() - this.prunedAt >= WAKE_UP_PRUNE_INTERVAL_MS) {
				this.prunedAt = Date.now();
				// The clock is read once, in a subquery: PostgreSQL's is volatile, and a volatile bound uses no index.
				await database.run(
					`DELETE FROM ${this.table} WHERE created_at < (SELECT ${nowMs}) - ?`,
					WAKE_UP_HINT_RETENTION_MS,
				);
			}
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
		this.listen();
		this.armPoll();
		const handle: WakeUpSubscription = {
			brokerId,
			close: async () => {
				subscription.open = false;
				this.subscriptions.delete(subscription);
				this.listen();
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
		this.stopListening();
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

	/**
	 * Listens for notifications through the current database, when it delivers them: on each subscribed broker's own
	 * channel, and on the table's, where brokers of earlier releases send them. A channel no subscription needs any more
	 * is left.
	 */
	private listen(): void {
		const database = this.database;
		if (this.closed || database === undefined) return;
		if (this.listening !== undefined && this.listening.database !== database) this.stopListening();
		const notifications = database.notifications;
		if (notifications === undefined) return;
		const fresh = this.listening === undefined;
		const listening = (this.listening ??= { database, channels: new Map(), live: false });
		const wanted = new Set([
			this.table,
			...[...this.subscriptions].map((subscription) => brokerWakeUpChannel(this.table, subscription.brokerId)),
		]);
		for (const [channel, subscription] of listening.channels) {
			if (wanted.has(channel)) continue;
			subscription.close();
			listening.channels.delete(channel);
		}
		for (const channel of wanted) {
			if (!listening.channels.has(channel))
				listening.channels.set(channel, notifications.listen(channel, (event) => this.notified(listening, event)));
		}
		if (fresh) void this.checkListening();
	}

	private notified(listening: Listening, event: StorageNotificationEvent): void {
		if (event.kind === "listening") {
			if (this.listening === listening) listening.live = true;
			this.pollNow();
		} else if ([...this.subscriptions].some((open) => open.brokerId === event.payload)) this.pollNow();
	}

	private stopListening(): void {
		for (const subscription of this.listening?.channels.values() ?? []) subscription.close();
		this.listening = undefined;
	}

	/** Asks the database whether its listening connection is live, for the interval of the next poll. */
	private async checkListening(): Promise<void> {
		const listening = this.listening;
		const notifications = listening?.database.notifications;
		if (listening === undefined || notifications === undefined) return;
		const live = await notifications.state().then(
			(state) => state.status === "listening",
			() => false,
		);
		if (this.listening === listening) listening.live = live;
	}

	/** Polls at once, or as soon as the poll in progress ends, instead of at the next interval. */
	private pollNow(): void {
		if (this.closed) return;
		if (this.polling !== undefined) {
			this.pollAgain = true;
			return;
		}
		this.cancelPoll?.();
		this.cancelPoll = undefined;
		this.armPoll(0);
	}

	private armPoll(delayMs = this.nextPollDelayMs()): void {
		if (this.closed || this.cancelPoll !== undefined || this.polling !== undefined) return;
		if (this.subscriptions.size === 0) return;
		this.cancelPoll = this.schedule(() => {
			this.cancelPoll = undefined;
			this.pollAgain = false;
			this.polling = this.poll()
				.then(() => this.checkListening())
				.finally(() => {
				this.polling = undefined;
				this.armPoll(this.pollAgain ? 0 : this.nextPollDelayMs());
			});
		}, delayMs);
	}

	private nextPollDelayMs(): number {
		if (this.database !== undefined && this.listening?.database === this.database && this.listening.live)
			return this.listeningPollIntervalMs;
		if (this.database !== undefined || this.reconnectFailures === 0) return this.pollIntervalMs;
		return Math.min(this.pollIntervalMs * 2 ** this.reconnectFailures, WAKE_UP_RECONNECT_MAX_DELAY_MS);
	}

	private async poll(): Promise<void> {
		const database = await this.connection(true);
		const brokerIds = [...new Set([...this.subscriptions].map((subscription) => subscription.brokerId))];
		if (database === undefined || brokerIds.length === 0) return;
		const dialect = dialectOf(database);
		// One statement text whatever the number of brokers, so the server plans it once: their ids go as one JSON array.
		const batch = `FROM ${this.table} WHERE broker_id IN (SELECT value FROM ${dialect.jsonValues("?")}) ORDER BY id LIMIT ${WAKE_UP_POLL_BATCH_SIZE}`;
		const ids = JSON.stringify(brokerIds);
		const reader = this.options.reader ?? database;
		for (;;) {
			let rows: HintRow[];
			try {
				if (dialect.name === "postgres") {
					// #6560: one statement takes the batch and deletes it. It is a write, so it goes through the database,
					// never the reader, as a statement of its own in the wake-up table's domain: one round trip, queued
					// behind neither other domains' writes nor read-only transactions. It returns the hints in no
					// particular order.
					const take = {
						sql: `DELETE FROM ${this.table} WHERE id IN (SELECT id ${batch}) RETURNING id, broker_id, reason, version, target_identity`,
						params: [ids],
					};
					rows = (
						database.autocommit === undefined
							? await database.all(take.sql, ...take.params)
							: await database.autocommit(take, { kind: "serial", domain: this.table })
					) as HintRow[];
					rows.sort((left, right) => Number(left.id) - Number(right.id));
				} else {
					rows = await reader.all<HintRow>(
						`SELECT id, broker_id, reason, version, target_identity ${batch}`,
						ids,
					);
					if (rows.length > 0) {
						await database.run(
							`DELETE FROM ${this.table} WHERE id IN (SELECT value FROM ${dialect.jsonValues("?")})`,
							JSON.stringify(rows.map((row) => Number(row.id))),
						);
					}
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
					...(row.target_identity === null ? {} : { targetIdentity: row.target_identity }),
				};
				for (const subscription of this.subscriptions) {
					if (subscription.brokerId === hint.brokerId) this.deliver(subscription, { kind: "hint", hint });
				}
			}
			if (rows.length < WAKE_UP_POLL_BATCH_SIZE || this.closed) return;
		}
	}

	/** `force` (the poll) reopens even while backing off; a publish waits for the backoff to pass. */
	private connection(force: boolean): Promise<SqliteDatabase | undefined> {
		if (this.closed) return Promise.resolve(undefined);
		if (this.database !== undefined) return Promise.resolve(this.database);
		if (!force && this.opening === undefined && Date.now() < this.reconnectNotBefore) return Promise.resolve(undefined);
		this.opening ??= this.reconnect().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	private async reconnect(): Promise<SqliteDatabase | undefined> {
		let database: SqliteDatabase;
		try {
			// The bus set its table up when it opened: replacing a dropped connection runs no schema statement, so it never
			// takes the database's write lock, however many brokers lose their connections at once (#6560).
			database = await openSchemaConnection(this.options, this.table, true);
		} catch {
			this.reconnectFailures++;
			this.reconnectNotBefore = Date.now() + this.nextPollDelayMs();
			return undefined;
		}
		this.reconnectFailures = 0;
		if (this.closed) {
			await database.close().catch(() => {});
			return undefined;
		}
		this.database = database;
		this.listen();
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
