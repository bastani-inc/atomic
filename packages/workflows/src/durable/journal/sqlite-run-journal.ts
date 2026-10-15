import { dirname, join } from "node:path";
import { getAgentDir } from "@bastani/atomic";
import { JournalDatabase, journalCounter, type SqliteStoredValue, storageBoundary } from "./node-sqlite.js";
import {
	type AppendOutcome,
	JOURNAL_COLUMNS as c,
	JOURNAL_LEASE,
	JOURNAL_SCHEMA_VERSION,
	JournalCasConflictError,
	type JournalEntry,
	type JournalEventRow,
	JournalInvalidTextError,
	type JournalLeaseRow,
	JournalMetaCorruptError,
	JournalSchemaVersionError,
	type Lease,
	type LeaseOutcome,
	RUN_EVENT_TYPES,
	type RunEvent,
	type RunHeader,
	type RunJournal,
	RunNotFoundError,
	type RunSummary,
	StaleLeaseError,
	JOURNAL_TABLES as t,
} from "./types.js";

export function workflowJournalPath(): string {
	return process.env.ATOMIC_WORKFLOW_JOURNAL_PATH ?? join(dirname(getAgentDir()), "workflows", "journal.sqlite");
}

function validateText(field: JournalInvalidTextError["field"], value: string): void {
	if (value.includes("\u0000")) throw new JournalInvalidTextError(field, "nul-character");
	if (!value.isWellFormed()) throw new JournalInvalidTextError(field, "ill-formed-unicode");
}

function serializeJson(value: RunHeader | RunEvent["payload"]): string {
	const text = JSON.stringify(value);
	return text.replace(/\p{Surrogate}/gu, (unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"));
}

function storedVersion(stored: SqliteStoredValue): SqliteStoredValue {
	return typeof stored === "bigint" && stored >= BigInt(Number.MIN_SAFE_INTEGER) && stored <= BigInt(Number.MAX_SAFE_INTEGER)
		? Number(stored)
		: stored;
}

function entryFromRow(row: JournalEventRow): JournalEntry {
	const key = row[c.key];
	return {
		runId: row[c.runId],
		seq: row[c.seq],
		epoch: row[c.epoch],
		...(key === null ? {} : { key }),
		event: { type: row[c.type], payload: JSON.parse(row[c.payload]) } as RunEvent,
		at: row[c.at],
	};
}

export class SqliteRunJournal implements RunJournal {
	private readonly db: JournalDatabase;
	private closed = false;

	constructor(readonly path = workflowJournalPath()) {
		this.db = new JournalDatabase(path);
		let initialized = false;
		try {
			this.db.transaction(() => {
				this.db.exec(`CREATE TABLE IF NOT EXISTS ${t.meta}(${c.schemaVersion} INTEGER NOT NULL)`);
				const rowCount = this.db.getWide<{ count: bigint }>(`SELECT COUNT(*) AS count FROM ${t.meta}`)?.count ?? 0n;
				if (rowCount > 1n) throw new JournalMetaCorruptError(path, Number(rowCount));
				if (rowCount === 1n) {
					const stored =
						this.db.getWide<{ [c.schemaVersion]: SqliteStoredValue }>(`SELECT ${c.schemaVersion} FROM ${t.meta}`)?.[
							c.schemaVersion
						] ?? null;
					if (stored !== BigInt(JOURNAL_SCHEMA_VERSION)) throw new JournalSchemaVersionError(storedVersion(stored));
				} else {
					this.db.run(`INSERT INTO ${t.meta} VALUES (?)`, JOURNAL_SCHEMA_VERSION);
				}
				this.db.exec(`
					CREATE TABLE IF NOT EXISTS ${t.runs}(
						${c.runId} TEXT PRIMARY KEY, ${c.name} TEXT NOT NULL, ${c.cwd} TEXT NOT NULL,
						${c.createdAt} INTEGER NOT NULL, ${c.status} TEXT NOT NULL, ${c.headerJson} TEXT NOT NULL
					);
					CREATE TABLE IF NOT EXISTS ${t.events}(
						${c.runId} TEXT NOT NULL REFERENCES ${t.runs}(${c.runId}) ON DELETE CASCADE,
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
			initialized = true;
		} finally {
			if (!initialized) this.db.close();
		}
	}

	async createRun(header: RunHeader): Promise<"created" | "exists"> {
		validateText("runId", header.runId);
		validateText("name", header.name);
		validateText("cwd", header.cwd);
		validateText("status", header.status);
		return this.db.transaction(() =>
			this.db.run(
				`INSERT INTO ${t.runs} VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(${c.runId}) DO NOTHING`,
				header.runId,
				header.name,
				header.cwd,
				header.createdAt,
				header.status,
				serializeJson(header),
			) === 1
				? "created"
				: "exists",
		);
	}

	async listRuns(filter?: { cwd?: string }): Promise<readonly RunSummary[]> {
		if (filter?.cwd !== undefined) validateText("cwd", filter.cwd);
		return storageBoundary(this.path, () =>
			this.db
				.all<{ [c.headerJson]: string; [c.status]: string }>(
					`SELECT ${c.headerJson}, ${c.status} FROM ${t.runs} ${filter?.cwd === undefined ? "" : `WHERE ${c.cwd} = ?`} ORDER BY ${c.runId}`,
					...(filter?.cwd === undefined ? [] : [filter.cwd]),
				)
				.map((row) => ({ ...(JSON.parse(row[c.headerJson]) as RunHeader), status: row[c.status] })),
		);
	}

	private requireRun(runId: string): void {
		if (!this.db.get(`SELECT ${c.runId} FROM ${t.runs} WHERE ${c.runId} = ?`, runId))
			throw new RunNotFoundError(runId);
	}

	private leaseRow(runId: string): JournalLeaseRow | undefined {
		return this.db.getCounters<JournalLeaseRow>(
			runId,
			`SELECT ${c.holderId}, ${c.epoch} FROM ${t.leases} WHERE ${c.runId} = ?`,
			runId,
		);
	}

	private grant(runId: string, holderId: string, epoch: number): LeaseOutcome {
		this.db.run(
			`INSERT INTO ${t.leases} VALUES (?, ?, ?, ?) ON CONFLICT(${c.runId}) DO UPDATE SET ${c.holderId} = excluded.${c.holderId}, ${c.epoch} = excluded.${c.epoch}, ${c.renewedAt} = excluded.${c.renewedAt}`,
			runId,
			holderId,
			epoch,
			Date.now(),
		);
		return { status: "acquired", lease: { runId, holderId, epoch } };
	}

	async acquire(runId: string, holderId: string): Promise<LeaseOutcome> {
		validateText("runId", runId);
		validateText("holderId", holderId);
		return this.db.transaction(() => {
			this.requireRun(runId);
			const current = this.leaseRow(runId);
			if (current?.[c.holderId] === holderId)
				return { status: "acquired", lease: { runId, holderId, epoch: current[c.epoch] } };
			if (current && current[c.holderId] !== JOURNAL_LEASE.unheld)
				return { status: "held", holderId: current[c.holderId], epoch: current[c.epoch] };
			return this.grant(
				runId,
				holderId,
				current
					? journalCounter(runId, "epoch", current[c.epoch] + JOURNAL_LEASE.epochIncrement, "overflow")
					: JOURNAL_LEASE.initialEpoch,
			);
		});
	}

	async takeover(runId: string, holderId: string, expectedHolder: string): Promise<LeaseOutcome> {
		validateText("runId", runId);
		validateText("holderId", holderId);
		validateText("expectedHolder", expectedHolder);
		return this.db.transaction(() => {
			this.requireRun(runId);
			const current = this.leaseRow(runId);
			if (current?.[c.holderId] !== expectedHolder)
				return {
					status: "held",
					holderId: current?.[c.holderId] ?? JOURNAL_LEASE.unheld,
					epoch: current?.[c.epoch] ?? JOURNAL_LEASE.absentEpoch,
				};
			return this.grant(
				runId,
				holderId,
				journalCounter(runId, "epoch", current[c.epoch] + JOURNAL_LEASE.epochIncrement, "overflow"),
			);
		});
	}

	private checkLease(lease: Lease): void {
		const current = this.leaseRow(lease.runId);
		if (current?.[c.holderId] !== lease.holderId || current[c.epoch] !== lease.epoch) {
			throw new StaleLeaseError(lease.runId, lease.epoch, current?.[c.epoch] ?? JOURNAL_LEASE.absentEpoch);
		}
	}

	async renew(lease: Lease): Promise<void> {
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		this.db.transaction(() => {
			this.checkLease(lease);
			this.db.run(`UPDATE ${t.leases} SET ${c.renewedAt} = ? WHERE ${c.runId} = ?`, Date.now(), lease.runId);
		});
	}

	async release(lease: Lease): Promise<void> {
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		this.db.transaction(() => {
			this.checkLease(lease);
			this.db.run(
				`UPDATE ${t.leases} SET ${c.holderId} = ? WHERE ${c.runId} = ?`,
				JOURNAL_LEASE.unheld,
				lease.runId,
			);
		});
	}

	async append(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }): Promise<AppendOutcome> {
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		if (options?.key !== undefined) validateText("key", options.key);
		if (event.type === RUN_EVENT_TYPES.statusChanged) validateText("status", event.payload.status);
		return this.db.transaction(() => {
			this.checkLease(lease);
			const actualSeq =
				this.db.getCounters<{ [c.seq]: number }>(
					lease.runId,
					`SELECT COALESCE(MAX(${c.seq}), 0) AS ${c.seq} FROM ${t.events} WHERE ${c.runId} = ?`,
					lease.runId,
				)?.[c.seq] ?? 0;
			if (options?.expectSeq !== undefined && options.expectSeq !== actualSeq)
				throw new JournalCasConflictError(lease.runId, options.expectSeq, actualSeq);
			if (options?.key !== undefined) {
				const row = this.db.getCounters<JournalEventRow>(
					lease.runId,
					`SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.key} = ?`,
					lease.runId,
					options.key,
				);
				if (row) return { status: "exists", entry: entryFromRow(row) };
			}
			const nextSeq = journalCounter(lease.runId, "seq", actualSeq + 1, "overflow");
			const at = Date.now();
			this.db.run(
				`INSERT INTO ${t.events} VALUES (?, ?, ?, ?, ?, ?, ?)`,
				lease.runId,
				nextSeq,
				lease.epoch,
				options?.key ?? null,
				event.type,
				serializeJson(event.payload),
				at,
			);
			if (event.type === RUN_EVENT_TYPES.statusChanged)
				this.db.run(`UPDATE ${t.runs} SET ${c.status} = ? WHERE ${c.runId} = ?`, event.payload.status, lease.runId);
			const row = this.db.getCounters<JournalEventRow>(
				lease.runId,
				`SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.seq} = ?`,
				lease.runId,
				nextSeq,
			) as JournalEventRow;
			return { status: "appended", entry: entryFromRow(row) };
		});
	}

	async *read(runId: string, fromSeq = 1): AsyncIterable<JournalEntry> {
		validateText("runId", runId);
		const entries = storageBoundary(this.path, () =>
			this.db
				.allCounters<JournalEventRow>(
					runId,
					`SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.seq} >= ? ORDER BY ${c.seq}`,
					runId,
					fromSeq,
				)
				.map(entryFromRow),
		);
		yield* entries;
	}

	async readKey(runId: string, key: string): Promise<JournalEntry | undefined> {
		validateText("runId", runId);
		validateText("key", key);
		return storageBoundary(this.path, () => {
			const row = this.db.getCounters<JournalEventRow>(
				runId,
				`SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.key} = ?`,
				runId,
				key,
			);
			return row ? entryFromRow(row) : undefined;
		});
	}

	async deleteRun(runId: string): Promise<void> {
		validateText("runId", runId);
		this.db.transaction(() => {
			this.leaseRow(runId);
			this.db.run(`UPDATE ${t.leases} SET ${c.holderId} = ? WHERE ${c.runId} = ?`, JOURNAL_LEASE.unheld, runId);
			this.db.run(`DELETE FROM ${t.runs} WHERE ${c.runId} = ?`, runId);
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.db.close();
		this.closed = true;
	}
}
