import { dirname, join } from "node:path";
import { getAgentDir, getEnvValue } from "@bastani/atomic";
import { JournalDatabase, storageBoundary } from "./node-sqlite.js";
import {
	type AppendOutcome,
	JOURNAL_COLUMNS as c,
	JOURNAL_LEASE,
	JOURNAL_SCHEMA_VERSION,
	JournalCasConflictError,
	type JournalEntry,
	type JournalEventRow,
	type JournalLeaseRow,
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
	return getEnvValue("ATOMIC_WORKFLOW_JOURNAL_PATH") ?? join(dirname(getAgentDir()), "workflows", "journal.sqlite");
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
				const versions = this.db.all<{ [c.schemaVersion]: number }>(`SELECT ${c.schemaVersion} FROM ${t.meta}`);
				for (const version of versions) {
					if (version[c.schemaVersion] !== JOURNAL_SCHEMA_VERSION)
						throw new JournalSchemaVersionError(version[c.schemaVersion]);
				}
				if (versions.length === 0) this.db.run(`INSERT INTO ${t.meta} VALUES (?)`, JOURNAL_SCHEMA_VERSION);
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
						${c.runId} TEXT PRIMARY KEY REFERENCES ${t.runs}(${c.runId}) ON DELETE CASCADE,
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
		return this.db.transaction(() =>
			this.db.run(
				`INSERT INTO ${t.runs} VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(${c.runId}) DO NOTHING`,
				header.runId,
				header.name,
				header.cwd,
				header.createdAt,
				header.status,
				JSON.stringify(header),
			) === 1
				? "created"
				: "exists",
		);
	}

	async listRuns(filter?: { cwd?: string }): Promise<readonly RunSummary[]> {
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
		return this.db.get<JournalLeaseRow>(
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
				current ? current[c.epoch] + JOURNAL_LEASE.epochIncrement : JOURNAL_LEASE.initialEpoch,
			);
		});
	}

	async takeover(runId: string, holderId: string, expectedHolder: string): Promise<LeaseOutcome> {
		return this.db.transaction(() => {
			this.requireRun(runId);
			const current = this.leaseRow(runId);
			if (current?.[c.holderId] !== expectedHolder)
				return {
					status: "held",
					holderId: current?.[c.holderId] ?? JOURNAL_LEASE.unheld,
					epoch: current?.[c.epoch] ?? JOURNAL_LEASE.absentEpoch,
				};
			return this.grant(runId, holderId, current[c.epoch] + JOURNAL_LEASE.epochIncrement);
		});
	}

	private checkLease(lease: Lease): void {
		const current = this.leaseRow(lease.runId);
		if (current?.[c.holderId] !== lease.holderId || current[c.epoch] !== lease.epoch) {
			throw new StaleLeaseError(lease.runId, lease.epoch, current?.[c.epoch] ?? JOURNAL_LEASE.absentEpoch);
		}
	}

	async renew(lease: Lease): Promise<void> {
		this.db.transaction(() => {
			this.checkLease(lease);
			this.db.run(`UPDATE ${t.leases} SET ${c.renewedAt} = ? WHERE ${c.runId} = ?`, Date.now(), lease.runId);
		});
	}

	async release(lease: Lease): Promise<void> {
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
		return this.db.transaction(() => {
			this.checkLease(lease);
			const actualSeq =
				this.db.get<{ [c.seq]: number }>(
					`SELECT COALESCE(MAX(${c.seq}), 0) AS ${c.seq} FROM ${t.events} WHERE ${c.runId} = ?`,
					lease.runId,
				)?.[c.seq] ?? 0;
			if (options?.expectSeq !== undefined && options.expectSeq !== actualSeq)
				throw new JournalCasConflictError(lease.runId, options.expectSeq, actualSeq);
			if (options?.key !== undefined) {
				const row = this.db.get<JournalEventRow>(
					`SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.key} = ?`,
					lease.runId,
					options.key,
				);
				if (row) return { status: "exists", entry: entryFromRow(row) };
			}
			const at = Date.now();
			this.db.run(
				`INSERT INTO ${t.events} VALUES (?, ?, ?, ?, ?, ?, ?)`,
				lease.runId,
				actualSeq + 1,
				lease.epoch,
				options?.key ?? null,
				event.type,
				JSON.stringify(event.payload),
				at,
			);
			if (event.type === RUN_EVENT_TYPES.statusChanged)
				this.db.run(`UPDATE ${t.runs} SET ${c.status} = ? WHERE ${c.runId} = ?`, event.payload.status, lease.runId);
			const row = this.db.get<JournalEventRow>(
				`SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.seq} = ?`,
				lease.runId,
				actualSeq + 1,
			) as JournalEventRow;
			return { status: "appended", entry: entryFromRow(row) };
		});
	}

	async *read(runId: string, fromSeq = 1): AsyncIterable<JournalEntry> {
		const entries = storageBoundary(this.path, () =>
			this.db
				.all<JournalEventRow>(
					`SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.seq} >= ? ORDER BY ${c.seq}`,
					runId,
					fromSeq,
				)
				.map(entryFromRow),
		);
		yield* entries;
	}

	async readKey(runId: string, key: string): Promise<JournalEntry | undefined> {
		return storageBoundary(this.path, () => {
			const row = this.db.get<JournalEventRow>(
				`SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.key} = ?`,
				runId,
				key,
			);
			return row ? entryFromRow(row) : undefined;
		});
	}

	async deleteRun(runId: string): Promise<void> {
		this.db.transaction(() => {
			this.db.run(`DELETE FROM ${t.runs} WHERE ${c.runId} = ?`, runId);
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.db.close();
		this.closed = true;
	}
}
