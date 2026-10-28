import { AsyncLocalStorage } from "node:async_hooks";
import {
	assertStorageSchemaVersion,
	renderStorageIdentifiers,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteStatement,
	type StorageDescriptor,
	type StorageFailureCause,
	StorageSchemaVersionError,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import {
	JOURNAL_READ_PAGE_SIZE,
	type JournalAppendGuard,
	type JournalBatchAppend,
	NON_SNAPSHOT_EVENT_TYPES,
	type RunSnapshotTail,
	type RunVersion,
	registerSqlPoolStorage,
} from "./internal.js";
import { isWorkflowLeaseExpired } from "./lease-expiry.js";
import { LegacyJournalRuns, latestEventColumns, type RunVersionRow } from "./legacy-journal-tables.js";
import {
	type AppendOutcome,
	JOURNAL_COLUMNS as c,
	JOURNAL_LEASE,
	JOURNAL_SCHEMA_VERSION,
	JOURNAL_TABLES,
	JournalCasConflictError,
	JournalClosedError,
	type JournalEntry,
	type JournalEventRow,
	type JournalLeaseRow,
	JournalMetaCorruptError,
	JournalSchemaVersionError,
	type Lease,
	type LeaseOutcome,
	type LeaseState,
	RUN_EVENT_TYPES,
	type RunEvent,
	type RunHeader,
	type RunJournal,
	RunNotFoundError,
	type RunSummary,
	StaleLeaseError,
} from "./types.js";
import { journalCounter, serializeJson, validateText } from "./values.js";

export { JOURNAL_READ_PAGE_SIZE } from "./internal.js";

type Tables = Readonly<Record<keyof typeof JOURNAL_TABLES, string>>;
type EventRow = SqliteRow & JournalEventRow;
type SnapshotTailRow = EventRow & {
	latest_seq: number;
	latest_at: number;
	later_checkpoints: number;
	last_checkpoint_at: number | null;
};
type LeaseRow = SqliteRow & JournalLeaseRow & { [c.renewedAt]: number };
type HeaderRow = SqliteRow & { [c.headerJson]: string; [c.status]: string };
const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const EVENT_COLUMNS = [c.runId, c.seq, c.epoch, c.key, c.type, c.payload, c.at] as const;
const APPEND_SAVEPOINT = "journal_append";

function entryFromRow(row: EventRow): JournalEntry {
	const key = row[c.key];
	return {
		runId: row[c.runId],
		seq: journalCounter(row[c.runId], "seq", row[c.seq]),
		epoch: journalCounter(row[c.runId], "epoch", row[c.epoch]),
		...(key === null ? {} : { key }),
		event: { type: row[c.type], payload: JSON.parse(row[c.payload]) } as RunEvent,
		at: Number(row[c.at]),
	};
}

export class SqlRunJournal implements RunJournal {
	private closed = false;
	private tail: Promise<void> = Promise.resolve();
	private closePromise?: Promise<void>;
	private readonly database: SqliteDatabase;
	private readonly tables: Tables;
	private readonly legacy: LegacyJournalRuns | undefined;
	private readonly appendGuard = new AsyncLocalStorage<JournalAppendGuard>();

	private constructor(database: SqliteDatabase, tables: Tables, legacy: LegacyJournalRuns | undefined) {
		this.database = database;
		this.tables = tables;
		this.legacy = legacy;
		registerSqlPoolStorage(this, {
			transaction: (body) => this.operation(() => this.database.transaction(body)),
			read: (body) => this.operation(() => body(this.database)),
			withAppendGuard: (guard, action) => this.appendGuard.run(guard, action),
			tables: this.tables,
		});
	}

	static async open(database: SqliteDatabase, options: { readonly prefix?: string } = {}): Promise<SqlRunJournal> {
		const t = renderStorageIdentifiers("journal", JOURNAL_TABLES, options.prefix);
		await database.transaction(async (tx) => {
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${t.meta}(${c.schemaVersion} INTEGER NOT NULL)`);
			const versions = await tx.all(`SELECT ${c.schemaVersion} FROM ${t.meta}`);
			if (versions.length > 1) throw new JournalMetaCorruptError(database.descriptor.location, versions.length);
			if (versions.length === 0) {
				await tx.run(`INSERT INTO ${t.meta} VALUES (?)`, JOURNAL_SCHEMA_VERSION);
			} else {
				try {
					assertStorageSchemaVersion("journal", versions[0]![c.schemaVersion]!, JOURNAL_SCHEMA_VERSION);
				} catch (error) {
					if (error instanceof StorageSchemaVersionError) throw new JournalSchemaVersionError(error.found);
					throw error;
				}
			}
			await tx.exec(`
				CREATE TABLE IF NOT EXISTS ${t.runs}(
					${c.runId} TEXT PRIMARY KEY, ${c.name} TEXT NOT NULL, ${c.cwd} TEXT NOT NULL,
					${c.createdAt} INTEGER NOT NULL, ${c.status} TEXT NOT NULL, ${c.headerJson} TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS ${t.events}(
					${c.runId} TEXT NOT NULL,
					${c.seq} INTEGER NOT NULL, ${c.epoch} INTEGER NOT NULL, ${c.key} TEXT,
					${c.type} TEXT NOT NULL, ${c.payload} TEXT NOT NULL, ${c.at} INTEGER NOT NULL,
					PRIMARY KEY(${c.runId}, ${c.seq}), UNIQUE(${c.runId}, ${c.key})
				);
				CREATE TABLE IF NOT EXISTS ${t.leases}(
					${c.runId} TEXT PRIMARY KEY,
					${c.holderId} TEXT, ${c.epoch} INTEGER NOT NULL, ${c.renewedAt} INTEGER NOT NULL
				);
			`);
		});
		const legacy = options.prefix ? undefined : await LegacyJournalRuns.open(database);
		return new SqlRunJournal(database, t, legacy);
	}

	get descriptor(): StorageDescriptor {
		return { ...this.database.descriptor };
	}

	get path(): string {
		return this.database.descriptor.location;
	}

	private assertOpen(): void {
		if (this.closed) throw new StorageUnavailableError(this.descriptor, new JournalClosedError());
	}

	private operation<T>(action: () => Promise<T>): Promise<T> {
		this.assertOpen();
		const result = action();
		this.tail = Promise.all([this.tail, result]).then(
			() => {},
			() => {},
		);
		return result;
	}

	private snapshotJson(value: RunHeader | RunEvent["payload"]): string | StorageUnavailableError {
		try {
			return serializeJson(value);
		} catch (cause) {
			return new StorageUnavailableError(this.descriptor, cause as StorageFailureCause);
		}
	}

	async createRun(header: RunHeader): Promise<"created" | "exists"> {
		this.assertOpen();
		validateText("runId", header.runId);
		validateText("name", header.name);
		validateText("cwd", header.cwd);
		validateText("status", header.status);
		const json = this.snapshotJson(header);
		if (json instanceof StorageUnavailableError) throw json;
		const { runs } = this.tables;
		return this.operation(async () => {
			if (await this.legacy?.find(this.database, header.runId)) return "exists";
			const result = await this.database.run(
				`INSERT INTO ${runs} VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(${c.runId}) DO NOTHING`,
				header.runId,
				header.name,
				header.cwd,
				header.createdAt,
				header.status,
				json,
			);
			return result.changes === 1 ? "created" : "exists";
		});
	}

	async getRun(runId: string): Promise<RunSummary | undefined> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(async () => {
			const row = await this.database.get<HeaderRow>(
				`SELECT ${c.headerJson}, ${c.status} FROM ${this.tables.runs} WHERE ${c.runId} = ?`,
				runId,
			);
			const found = row ?? (await this.legacy?.find(this.database, runId));
			return found ? { ...(JSON.parse(found[c.headerJson]) as RunHeader), status: found[c.status] } : undefined;
		});
	}

	async listRuns(filter?: { cwd?: string }): Promise<readonly RunSummary[]> {
		this.assertOpen();
		if (filter?.cwd !== undefined) validateText("cwd", filter.cwd);
		return this.operation(async () => {
			const rows = await this.database.all<HeaderRow>(
				`SELECT ${c.headerJson}, ${c.status} FROM ${this.tables.runs} ${filter?.cwd === undefined ? "" : `WHERE ${c.cwd} = ?`} ORDER BY ${c.runId}`,
				...(filter?.cwd === undefined ? [] : [filter.cwd]),
			);
			const legacy = (await this.legacy?.pending(this.database, filter)) ?? [];
			return [...rows, ...legacy]
				.map((row) => ({ ...(JSON.parse(row[c.headerJson]) as RunHeader), status: row[c.status] }))
				.sort((left, right) => (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0));
		});
	}

	/**
	 * `data_version` moves when another connection commits and `total_changes()` when this one writes; the
	 * table aggregates also catch run changes if the adapter does not serve every statement from one connection.
	 */
	async changeToken(): Promise<string> {
		this.assertOpen();
		return this.operation(async () => {
			const row = await this.database.get<SqliteRow>(
				`SELECT data_version, total_changes() AS changes,
					(SELECT count(*) FROM ${this.tables.runs}) AS runs,
					(SELECT max(rowid) FROM ${this.tables.events}) AS last_event
				FROM pragma_data_version`,
			);
			return JSON.stringify(Object.values(row ?? {}).map(String));
		});
	}

	async runVersions(): Promise<ReadonlyMap<string, RunVersion>> {
		this.assertOpen();
		return this.operation(async () => {
			const rows = await this.database.all<RunVersionRow>(
				`SELECT runs.${c.runId}, ${latestEventColumns(this.tables.events, "runs")} FROM ${this.tables.runs} AS runs`,
			);
			const legacy = (await this.legacy?.versions(this.database)) ?? [];
			return new Map(
				[...rows, ...legacy].map((row) => [
					row[c.runId],
					{ seq: journalCounter(row[c.runId], "seq", row[c.seq]), at: Number(row[c.at]) },
				]),
			);
		});
	}

	/**
	 * The latest snapshot event is found by walking the run's `(run_id, seq)` key back from its last event, so
	 * only the events after it are visited and only its payload is read.
	 */
	async snapshotTail(runId: string): Promise<RunSnapshotTail | undefined> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(async () => {
			const events = (await this.isUnconvertedLegacyRun(runId)) ? JOURNAL_TABLES.events : this.tables.events;
			const later = `FROM ${events} AS later WHERE later.${c.runId} = snapshot.${c.runId} AND later.${c.seq} > snapshot.${c.seq} AND later.${c.type} = ?`;
			const row = await this.database.get<SnapshotTailRow>(
				`SELECT ${EVENT_COLUMNS.map((column) => `snapshot.${column}`).join(", ")},
					latest.${c.seq} AS latest_seq, latest.${c.at} AS latest_at,
					(SELECT count(*) ${later}) AS later_checkpoints,
					(SELECT json_extract(later.${c.payload}, '$.completedAt') ${later} ORDER BY later.${c.seq} DESC LIMIT 1) AS last_checkpoint_at
				FROM (SELECT ${c.seq}, ${c.at} FROM ${events} WHERE ${c.runId} = ? ORDER BY ${c.seq} DESC LIMIT 1) AS latest,
					(SELECT ${EVENT_COLUMNS.join(", ")} FROM ${events} WHERE ${c.runId} = ? AND ${c.type} NOT IN (${NON_SNAPSHOT_EVENT_TYPES.map(() => "?").join(", ")}) ORDER BY ${c.seq} DESC LIMIT 1) AS snapshot`,
				RUN_EVENT_TYPES.checkpointRecorded,
				RUN_EVENT_TYPES.checkpointRecorded,
				runId,
				runId,
				...NON_SNAPSHOT_EVENT_TYPES,
			);
			if (row === undefined) return undefined;
			return {
				version: { seq: journalCounter(runId, "seq", row.latest_seq), at: Number(row.latest_at) },
				snapshot: entryFromRow(row),
				laterCheckpoints: Number(row.later_checkpoints),
				...(row.last_checkpoint_at === null ? {} : { lastCheckpointAt: Number(row.last_checkpoint_at) }),
			};
		});
	}

	private async requireRun(tx: SqliteExecutor, runId: string): Promise<void> {
		if (await tx.get(`SELECT ${c.runId} FROM ${this.tables.runs} WHERE ${c.runId} = ?`, runId)) return;
		if (!(await this.legacy?.convert(tx, runId))) throw new RunNotFoundError(runId);
	}

	/** Whether this run exists only in the legacy tables, whose events are then read in place. */
	private async isUnconvertedLegacyRun(runId: string): Promise<boolean> {
		if (this.legacy === undefined) return false;
		if (await this.database.get(`SELECT ${c.runId} FROM ${this.tables.runs} WHERE ${c.runId} = ?`, runId))
			return false;
		return (await this.legacy.find(this.database, runId)) !== undefined;
	}

	private async leaseRow(tx: SqliteExecutor, runId: string): Promise<LeaseRow | undefined> {
		const row = await tx.get<LeaseRow>(`SELECT * FROM ${this.tables.leases} WHERE ${c.runId} = ?`, runId);
		return row ? { ...row, [c.epoch]: journalCounter(runId, "epoch", row[c.epoch]) } : undefined;
	}

	private async grant(
		tx: SqliteExecutor,
		runId: string,
		holderId: string,
		previous?: LeaseRow,
	): Promise<LeaseOutcome> {
		const epoch = previous
			? journalCounter(runId, "epoch", previous[c.epoch] + JOURNAL_LEASE.epochIncrement, "overflow")
			: JOURNAL_LEASE.initialEpoch;
		await tx.run(
			`INSERT INTO ${this.tables.leases} VALUES (?, ?, ?, ${STORE_NOW}) ON CONFLICT(${c.runId}) DO UPDATE SET ${c.holderId} = excluded.${c.holderId}, ${c.epoch} = excluded.${c.epoch}, ${c.renewedAt} = excluded.${c.renewedAt}`,
			runId,
			holderId,
			epoch,
		);
		return { status: "acquired", lease: { runId, holderId, epoch } };
	}

	async acquire(runId: string, holderId: string): Promise<LeaseOutcome> {
		this.assertOpen();
		validateText("runId", runId);
		validateText("holderId", holderId);
		return this.operation(() =>
			this.database.transaction(async (tx) => {
				await this.requireRun(tx, runId);
				const current = await this.leaseRow(tx, runId);
				if (current?.[c.holderId] === holderId)
					return { status: "acquired", lease: { runId, holderId, epoch: current[c.epoch] } };
				if (current && current[c.holderId] !== JOURNAL_LEASE.unheld)
					return { status: "held", holderId: current[c.holderId], epoch: current[c.epoch] };
				return this.grant(tx, runId, holderId, current);
			}),
		);
	}

	async takeover(runId: string, holderId: string, expectedHolder: string): Promise<LeaseOutcome> {
		this.assertOpen();
		validateText("runId", runId);
		validateText("holderId", holderId);
		validateText("expectedHolder", expectedHolder);
		return this.operation(() =>
			this.database.transaction(async (tx) => {
				await this.requireRun(tx, runId);
				const current = await this.leaseRow(tx, runId);
				if (current?.[c.holderId] !== expectedHolder)
					return {
						status: "held",
						holderId: current?.[c.holderId] ?? JOURNAL_LEASE.unheld,
						epoch: current?.[c.epoch] ?? JOURNAL_LEASE.absentEpoch,
					};
				return this.grant(tx, runId, holderId, current);
			}),
		);
	}

	async leaseState(runId: string): Promise<LeaseState | undefined> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(async () => {
			const row = await this.database.get<LeaseRow & { age_ms: number }>(
				`SELECT *, MIN(${Number.MAX_SAFE_INTEGER}, MAX(0, ${STORE_NOW} - ${c.renewedAt})) AS age_ms FROM ${this.tables.leases} WHERE ${c.runId} = ?`,
				runId,
			);
			return row && row[c.holderId] !== null
				? {
						runId,
						holderId: row[c.holderId]!,
						epoch: journalCounter(runId, "epoch", row[c.epoch]),
						renewedAt: Number(row[c.renewedAt]),
						ageMs: Number(row.age_ms),
					}
				: undefined;
		});
	}

	async takeoverExpired(runId: string, holderId: string, staleAfterMs: number): Promise<LeaseOutcome> {
		this.assertOpen();
		validateText("runId", runId);
		validateText("holderId", holderId);
		return this.operation(() =>
			this.database.transaction(async (tx) => {
				await this.requireRun(tx, runId);
				const current = await this.leaseRow(tx, runId);
				if (current?.[c.holderId] === holderId)
					return { status: "acquired", lease: { runId, holderId, epoch: current[c.epoch] } };
				if (current && current[c.holderId] !== null) {
					const now = (await tx.get<SqliteRow & { now: number }>(`SELECT ${STORE_NOW} AS now`))!.now;
					const ageMs = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, now - Number(current[c.renewedAt])));
					if (!isWorkflowLeaseExpired(0, staleAfterMs, ageMs))
						return { status: "held", holderId: current[c.holderId], epoch: current[c.epoch] };
				}
				return this.grant(tx, runId, holderId, current);
			}),
		);
	}

	private async checkLease(tx: SqliteExecutor, lease: Lease): Promise<void> {
		const current = await this.leaseRow(tx, lease.runId);
		if (current?.[c.holderId] !== lease.holderId || current[c.epoch] !== lease.epoch)
			throw new StaleLeaseError(lease.runId, lease.epoch, current?.[c.epoch] ?? JOURNAL_LEASE.absentEpoch);
	}

	async renew(lease: Lease): Promise<void> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		return this.operation(() =>
			this.database.transaction(async (tx) => {
				await this.checkLease(tx, owned);
				await tx.run(
					`UPDATE ${this.tables.leases} SET ${c.renewedAt} = ${STORE_NOW} WHERE ${c.runId} = ?`,
					owned.runId,
				);
			}),
		);
	}

	async release(lease: Lease): Promise<void> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		return this.operation(() =>
			this.database.transaction(async (tx) => {
				await this.checkLease(tx, owned);
				await tx.run(
					`UPDATE ${this.tables.leases} SET ${c.holderId} = ? WHERE ${c.runId} = ?`,
					JOURNAL_LEASE.unheld,
					owned.runId,
				);
			}),
		);
	}

	private async sequence(tx: SqliteExecutor, runId: string): Promise<number> {
		const row = await tx.get<SqliteRow & { [c.seq]: number }>(
			`SELECT COALESCE(MAX(${c.seq}), 0) AS ${c.seq} FROM ${this.tables.events} WHERE ${c.runId} = ?`,
			runId,
		);
		return journalCounter(runId, "seq", row?.[c.seq] ?? 0);
	}

	async append(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }): Promise<AppendOutcome> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		const prepared = this.prepare(event, options?.key, this.appendGuard.getStore());
		const expected = options?.expectSeq;
		return this.operation(() =>
			this.database.transaction(async (tx) => {
				await this.checkLease(tx, owned);
				return this.insert(tx, owned, prepared, expected);
			}),
		);
	}

	/**
	 * Append several events to one run in one transaction, checking the lease once and assigning consecutive
	 * sequences in order. Each append is checked by the pool append guard of the context that issued it, or by none
	 * when that context had none, whatever guard the batch itself runs under. Each runs in its own savepoint, so
	 * one append's guard or payload failure is reported for it alone and the rest still commit. A lease or storage
	 * failure rejects the whole batch, with nothing written.
	 */
	async appendMany(
		lease: Lease,
		appends: readonly JournalBatchAppend[],
	): Promise<readonly PromiseSettledResult<AppendOutcome>[]> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		const prepared = appends.map((append) => {
			try {
				// Exactly the guard the append's own caller had, none included: never the batch's ambient guard.
				return this.prepare(
					append.event,
					append.key,
					append.context(() => this.appendGuard.getStore()),
				);
			} catch (error) {
				return error as Error;
			}
		});
		const batch = this.database.batch?.bind(this.database);
		if (
			batch &&
			prepared.every(
				(append) => append instanceof Error || (append.guard === undefined && typeof append.payload === "string"),
			)
		)
			return this.operation(() => this.appendInOneRequest(batch, owned, prepared));
		return this.operation(() =>
			this.database.transaction(async (tx) => {
				await this.checkLease(tx, owned);
				const results: PromiseSettledResult<AppendOutcome>[] = [];
				for (const append of prepared) {
					if (append instanceof Error) {
						results.push({ status: "rejected", reason: append });
						continue;
					}
					await tx.exec(`SAVEPOINT ${APPEND_SAVEPOINT}`);
					try {
						results.push({ status: "fulfilled", value: await this.insert(tx, owned, append) });
					} catch (error) {
						await tx.exec(`ROLLBACK TO ${APPEND_SAVEPOINT}`);
						results.push({ status: "rejected", reason: error });
					}
					await tx.exec(`RELEASE ${APPEND_SAVEPOINT}`);
				}
				return results;
			}),
		);
	}

	/**
	 * `appendMany` as one `SqliteDatabase.batch` request, for a batch with no pool guards and no payload errors. Every
	 * write checks the lease, the key and the sequence limit in SQL, so the outcomes match the savepoint path: a stale
	 * lease writes nothing and rejects the batch, a known key reports `exists`, and each append settles alone, in order.
	 */
	private async appendInOneRequest(
		batch: NonNullable<SqliteDatabase["batch"]>,
		owned: Lease,
		prepared: readonly (ReturnType<SqlRunJournal["prepare"]> | Error)[],
	): Promise<readonly PromiseSettledResult<AppendOutcome>[]> {
		const t = this.tables;
		const holds = `EXISTS (SELECT 1 FROM ${t.leases} WHERE ${c.runId} = ? AND ${c.holderId} = ? AND ${c.epoch} = ?)`;
		const held = [owned.runId, owned.holderId, owned.epoch] as const;
		const latest = `SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.seq} = (SELECT MAX(${c.seq}) FROM ${t.events} WHERE ${c.runId} = ?)`;
		const statements: SqliteStatement[] = [
			{ sql: `SELECT * FROM ${t.leases} WHERE ${c.runId} = ?`, params: [owned.runId] },
		];
		const at = (statement: SqliteStatement) => statements.push(statement) - 1;
		const plans = prepared.map((append) => {
			if (append instanceof Error) return append;
			const { key, type, payload, status } = append;
			const existing =
				key === undefined
					? undefined
					: at({
							sql: `SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.key} = ?`,
							params: [owned.runId, key],
						});
			at({
				sql: `INSERT INTO ${t.events}
					SELECT ?, current.latest + 1, ?, ?, ?, ?, ${STORE_NOW}
					FROM (SELECT COALESCE(MAX(${c.seq}), 0) AS latest FROM ${t.events} WHERE ${c.runId} = ?) AS current
					WHERE current.latest < ? AND ${holds}${
						key === undefined
							? ""
							: ` AND NOT EXISTS (SELECT 1 FROM ${t.events} WHERE ${c.runId} = ? AND ${c.key} = ?)`
					}`,
				params: [
					owned.runId,
					owned.epoch,
					key ?? null,
					type,
					payload as string,
					owned.runId,
					Number.MAX_SAFE_INTEGER,
					...held,
					...(key === undefined ? [] : [owned.runId, key]),
				],
			});
			const inserted = at({ sql: "SELECT changes() AS inserted", params: [] });
			// changes() still counts the insert: a SELECT does not reset it.
			if (status !== undefined)
				at({
					sql: `UPDATE ${t.runs} SET ${c.status} = ? WHERE ${c.runId} = ? AND changes() = 1`,
					params: [status, owned.runId],
				});
			const row = at({ sql: latest, params: [owned.runId, owned.runId] });
			return { existing, inserted, row };
		});
		const rows = await batch(statements);
		const lease = rows[0]![0] as LeaseRow | undefined;
		const epoch = lease === undefined ? undefined : journalCounter(owned.runId, "epoch", lease[c.epoch]);
		if (lease?.[c.holderId] !== owned.holderId || epoch !== owned.epoch)
			throw new StaleLeaseError(owned.runId, owned.epoch, epoch ?? JOURNAL_LEASE.absentEpoch);
		return plans.map((plan): PromiseSettledResult<AppendOutcome> => {
			if (plan instanceof Error) return { status: "rejected", reason: plan };
			try {
				const existing =
					plan.existing === undefined ? undefined : (rows[plan.existing]![0] as EventRow | undefined);
				if (existing) return { status: "fulfilled", value: { status: "exists", entry: entryFromRow(existing) } };
				const row = rows[plan.row]![0] as EventRow | undefined;
				if (Number(rows[plan.inserted]![0]!.inserted) === 1)
					return { status: "fulfilled", value: { status: "appended", entry: entryFromRow(row!) } };
				const actual = journalCounter(owned.runId, "seq", row?.[c.seq] ?? 0);
				journalCounter(owned.runId, "seq", actual + 1, "overflow");
				throw new StorageUnavailableError(this.descriptor, new Error("The batched append was not written."));
			} catch (error) {
				return { status: "rejected", reason: error };
			}
		});
	}

	/** Validate an append outside any transaction; its payload error is raised where `append` always raised it. */
	private prepare(event: RunEvent, key: string | undefined, appendGuard: JournalAppendGuard | undefined) {
		if (key !== undefined) validateText("key", key);
		const type = event.type;
		const payload = this.snapshotJson(event.payload);
		const guard =
			type === RUN_EVENT_TYPES.messageQueued ||
			type === RUN_EVENT_TYPES.messageDelivered ||
			type === RUN_EVENT_TYPES.messageSettled
				? appendGuard
				: undefined;
		const status =
			type === RUN_EVENT_TYPES.statusChanged && !(payload instanceof StorageUnavailableError)
				? (JSON.parse(payload) as { status: string }).status
				: undefined;
		if (type === RUN_EVENT_TYPES.statusChanged && !(payload instanceof StorageUnavailableError))
			validateText("status", status!);
		return { key, type, payload, guard, status };
	}

	private async insert(
		tx: SqliteExecutor,
		owned: Lease,
		{ key, type, payload, guard, status }: ReturnType<SqlRunJournal["prepare"]>,
		expected?: number,
	): Promise<AppendOutcome> {
		await guard?.(tx, owned.runId);
		if (key !== undefined) {
			const row = await tx.get<EventRow>(
				`SELECT * FROM ${this.tables.events} WHERE ${c.runId} = ? AND ${c.key} = ?`,
				owned.runId,
				key,
			);
			if (row) return { status: "exists", entry: entryFromRow(row) };
		}
		const actual = await this.sequence(tx, owned.runId);
		if (expected !== undefined && expected !== actual)
			throw new JournalCasConflictError(owned.runId, expected, actual);
		const seq = journalCounter(owned.runId, "seq", actual + 1, "overflow");
		if (payload instanceof StorageUnavailableError) throw payload;
		await tx.run(
			`INSERT INTO ${this.tables.events} VALUES (?, ?, ?, ?, ?, ?, ${STORE_NOW})`,
			owned.runId,
			seq,
			owned.epoch,
			key ?? null,
			type,
			payload,
		);
		if (status !== undefined)
			await tx.run(`UPDATE ${this.tables.runs} SET ${c.status} = ? WHERE ${c.runId} = ?`, status, owned.runId);
		const row = await tx.get<EventRow>(
			`SELECT * FROM ${this.tables.events} WHERE ${c.runId} = ? AND ${c.seq} = ?`,
			owned.runId,
			seq,
		);
		await guard?.(tx, owned.runId);
		return { status: "appended", entry: entryFromRow(row!) };
	}

	async *read(runId: string, fromSeq = 1): AsyncIterable<JournalEntry> {
		this.assertOpen();
		validateText("runId", runId);
		let nextSeq = fromSeq;
		const legacy = this.legacy;
		const readsLegacy = legacy !== undefined && (await this.operation(() => this.isUnconvertedLegacyRun(runId)));
		for (;;) {
			const page = await this.operation(async () => {
				const rows = readsLegacy
					? ((await legacy.events(this.database, runId, nextSeq, JOURNAL_READ_PAGE_SIZE)) as EventRow[])
					: await this.database.all<EventRow>(
							`SELECT * FROM ${this.tables.events} WHERE ${c.runId} = ? AND ${c.seq} >= ? ORDER BY ${c.seq} LIMIT ?`,
							runId,
							nextSeq,
							JOURNAL_READ_PAGE_SIZE,
						);
				return rows.map(entryFromRow);
			});
			for (const entry of page) {
				this.assertOpen();
				yield entry;
			}
			this.assertOpen();
			const last = page.at(-1);
			if (last === undefined || page.length < JOURNAL_READ_PAGE_SIZE) return;
			nextSeq = last.seq + 1;
		}
	}

	async readKey(runId: string, key: string): Promise<JournalEntry | undefined> {
		this.assertOpen();
		validateText("runId", runId);
		validateText("key", key);
		return this.operation(async () => {
			const row =
				this.legacy !== undefined && (await this.isUnconvertedLegacyRun(runId))
					? ((await this.legacy.eventByKey(this.database, runId, key)) as EventRow | undefined)
					: await this.database.get<EventRow>(
							`SELECT * FROM ${this.tables.events} WHERE ${c.runId} = ? AND ${c.key} = ?`,
							runId,
							key,
						);
			return row ? entryFromRow(row) : undefined;
		});
	}

	async deleteRun(runId: string): Promise<void> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(() => this.database.transaction((tx) => this.deleteRunData(tx, runId)));
	}

	async deleteOwnedRun(lease: Lease, expectSeq?: number): Promise<void> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		return this.operation(() =>
			this.database.transaction(async (tx) => {
				await this.checkLease(tx, owned);
				if (expectSeq !== undefined) {
					const actual = await this.sequence(tx, owned.runId);
					if (expectSeq !== actual) throw new JournalCasConflictError(owned.runId, expectSeq, actual);
				}
				await this.deleteRunData(tx, owned.runId);
			}),
		);
	}

	private async deleteRunData(tx: SqliteExecutor, runId: string): Promise<void> {
		await this.legacy?.markDeleted(tx, runId);
		await this.leaseRow(tx, runId);
		await tx.run(
			`UPDATE ${this.tables.leases} SET ${c.holderId} = ? WHERE ${c.runId} = ?`,
			JOURNAL_LEASE.unheld,
			runId,
		);
		await tx.run(`DELETE FROM ${this.tables.events} WHERE ${c.runId} = ?`, runId);
		await tx.run(`DELETE FROM ${this.tables.runs} WHERE ${c.runId} = ?`, runId);
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.closed = true;
			this.closePromise = this.tail;
		}
		return this.closePromise;
	}
}
