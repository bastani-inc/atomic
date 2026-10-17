import {
	assertStorageSchemaVersion,
	renderStorageIdentifiers,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	type StorageDescriptor,
	type StorageFailureCause,
	StorageSchemaVersionError,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { JOURNAL_READ_PAGE_SIZE } from "./internal.js";
import { isWorkflowLeaseExpired } from "./lease-expiry.js";
import { LegacyJournalRuns } from "./legacy-journal-tables.js";
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
type LeaseRow = SqliteRow & JournalLeaseRow & { [c.renewedAt]: number };
type HeaderRow = SqliteRow & { [c.headerJson]: string; [c.status]: string };
const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

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

	private constructor(database: SqliteDatabase, tables: Tables, legacy: LegacyJournalRuns | undefined) {
		this.database = database;
		this.tables = tables;
		this.legacy = legacy;
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
		if (options?.key !== undefined) validateText("key", options.key);
		const owned = { ...lease };
		const key = options?.key;
		const expected = options?.expectSeq;
		const type = event.type;
		const payload = this.snapshotJson(event.payload);
		const status =
			type === RUN_EVENT_TYPES.statusChanged && !(payload instanceof StorageUnavailableError)
				? (JSON.parse(payload) as { status: string }).status
				: undefined;
		if (type === RUN_EVENT_TYPES.statusChanged && !(payload instanceof StorageUnavailableError))
			validateText("status", status!);
		return this.operation(() =>
			this.database.transaction(async (tx) => {
				await this.checkLease(tx, owned);
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
				return { status: "appended", entry: entryFromRow(row!) };
			}),
		);
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
