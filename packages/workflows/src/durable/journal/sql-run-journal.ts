import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers";
import type { WorktreeSnapshot } from "@bastani/atomic";
import {
	assertStoredSchemaVersion,
	dialectOf,
	type FencedPathId,
	isStorageResponseRefusal,
	olderBuildLive,
	openNodeSqliteDatabase,
	RUN_JOURNAL_SCHEMA_VERSION_UNCHUNKED,
	renderStorageIdentifiers,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteStatement,
	type SqliteValue,
	SqlSnapshotBlobStore,
	type StorageDescriptor,
	type StorageDialect,
	type StorageFailureCause,
	type StoragePayloadTooLargeError,
	StorageSchemaVersionError,
	StorageUnavailableError,
	type StoredJournalPayload,
	upgradeRunJournalSchema,
	validateStoragePrefix,
	withJournalPayloads,
	writeJournalPayloadChunks,
} from "@bastani/atomic/storage";
import {
	JOURNAL_READ_PAGE_CHARS,
	JOURNAL_READ_PAGE_SIZE,
	JOURNAL_TRANSACTION,
	JOURNAL_WRITE_TRANSACTION,
	type JournalAppendGuard,
	type JournalBatchAppend,
	locksRows,
	NON_SNAPSHOT_EVENT_TYPES,
	nextReadBatch,
	type RunSnapshotTail,
	type RunVersion,
	registerJournalKeyRangeRead,
	registerSqlPoolStorage,
	STAGE_OVERVIEW_PAYLOAD_CHARS,
	storedEventPayload,
} from "./internal.js";
import { isWorkflowLeaseExpired } from "./lease-expiry.js";
import { LegacyJournalRuns, latestEventColumns, type RunVersionRow } from "./legacy-journal-tables.js";
import { poolFenceTable } from "./pool-guarded-write.js";
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
	type JournalKeyRangeReadOptions,
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
	type RunJournalSeedEvent,
	RunNotFoundError,
	type RunSummary,
	StaleLeaseError,
} from "./types.js";
import { journalCounter, runStatusFromRecord, serializeJson, validateText } from "./values.js";

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
const EVENT_COLUMNS = [c.runId, c.seq, c.epoch, c.key, c.type, c.payload, c.at] as const;
const APPEND_SAVEPOINT = "journal_append";

/**
 * Events one statement of `snapshotTail` walks past at most, as many as one page of a run's read (#5480). A statement
 * reads each event it passes: a few microseconds each with the pages cached, and a disk read each when they are not.
 */
const SNAPSHOT_TAIL_WINDOW = JOURNAL_READ_PAGE_SIZE;
/** Runs one statement of `runVersions` looks up, when the statements run on this process's thread (#5480). */
const RUN_VERSIONS_PAGE = 128;
/**
 * Runs one statement of `runVersions` looks up over a database server, a network round trip each (#5480). A libSQL
 * server refuses a response over 10 MB, which one statement for every run of a catalog of 150,000 runs came to.
 */
const RUN_VERSIONS_SERVER_PAGE = 4_096;

/** The column a read selects the journal's schema version as, so that it checks the version in its own statement. */
const META_VERSION = "meta_version";

/**
 * Throws {@link JournalSchemaVersionError} when a row a read returned says the journal is at another schema version
 * than this build's: a later build upgraded it after this process opened it (#4965). Rows without the column pass.
 */
function assertRowVersion(row: SqliteRow | undefined): void {
	if (row === undefined || !(META_VERSION in row)) return;
	const found = row[META_VERSION] ?? null;
	if (found !== JOURNAL_SCHEMA_VERSION) throw new JournalSchemaVersionError(found);
}

/**
 * SQL that holds while `column` is a counter in range, as `journalCounter` accepts it: a whole number from 0 to the
 * largest safe integer, the bound passed as the parameter it ends with.
 */
function counterInRange(column: string): string {
	return `${column} >= 0 AND ${column} = ROUND(${column}) AND ${column} <= ?`;
}

function entryFromRow(row: EventRow): JournalEntry {
	assertRowVersion(row);
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

function overviewEventColumns(dialect: StorageDialect): string {
	const overviewPayload =
		dialect.name === "postgres"
			? `CASE WHEN length(${c.payload}) > ${STAGE_OVERVIEW_PAYLOAD_CHARS} AND pg_input_is_valid(${c.payload}, 'jsonb') THEN CASE WHEN ((${c.payload})::jsonb ->> 'kind') = 'stage' THEN (CASE WHEN jsonb_typeof((${c.payload})::jsonb -> 'output') IS NOT NULL THEN (((${c.payload})::jsonb - 'result' - 'worktreeSnapshots' - 'structured' - 'artifacts' - 'waitResults') || '{"output":null}'::jsonb) ELSE ((${c.payload})::jsonb - 'output' - 'result' - 'worktreeSnapshots' - 'structured' - 'artifacts' - 'waitResults') END)::text ELSE ${c.payload} END ELSE ${c.payload} END AS ${c.payload}`
			: `CASE WHEN length(${c.payload}) > ${STAGE_OVERVIEW_PAYLOAD_CHARS} AND ${dialect.jsonValid(c.payload)} THEN CASE WHEN ${dialect.jsonText(c.payload, "kind")} = 'stage' THEN CASE WHEN ${dialect.jsonType(c.payload, "output")} IS NOT NULL THEN json_set(json_remove(${c.payload}, '$.output', '$.result', '$.worktreeSnapshots', '$.structured', '$.artifacts', '$.waitResults'), '$.output', json('null')) ELSE json_remove(${c.payload}, '$.output', '$.result', '$.worktreeSnapshots', '$.structured', '$.artifacts', '$.waitResults') END ELSE ${c.payload} END ELSE ${c.payload} END AS ${c.payload}`;
	const overviewChunks =
		dialect.name === "postgres"
			? `CASE WHEN pg_input_is_valid(${c.payload}, 'jsonb') THEN CASE WHEN ((${c.payload})::jsonb ->> 'kind') = 'stage' AND ((${c.payload})::jsonb ->> 'overviewStub') = '1' THEN 0 ELSE ${c.chunks} END ELSE ${c.chunks} END AS ${c.chunks}`
			: `CASE WHEN ${dialect.jsonValid(c.payload)} THEN CASE WHEN ${dialect.jsonText(c.payload, "kind")} = 'stage' AND ${dialect.jsonAt({ column: c.payload }, "overviewStub")} = 1 THEN 0 ELSE ${c.chunks} END ELSE ${c.chunks} END AS ${c.chunks}`;
	return `${c.runId}, ${c.seq}, ${c.epoch}, ${c.key}, ${c.type}, ${overviewPayload}, ${c.at}, ${overviewChunks}`;
}

async function readSizedPage(
	database: SqliteDatabase,
	chunkTable: string,
	meta: string,
	pageRows: string,
	order: string,
	params: readonly SqliteValue[],
	limit: number,
): Promise<{ readonly page: JournalEntry[]; readonly more: boolean; readonly limit: number }> {
	const rows = await database.all<EventRow & { fetched: number | bigint }>(
		`SELECT *, (SELECT ${c.schemaVersion} FROM ${meta}) AS ${META_VERSION} FROM (
			SELECT page.*, sum(length(page.${c.payload})) OVER (ORDER BY page.${order}) - length(page.${c.payload}) AS before_chars,
				count(*) OVER () AS fetched
			FROM (${pageRows}) AS page
		) AS sized WHERE before_chars < ? ORDER BY ${order}`,
		...params,
		limit,
		JOURNAL_READ_PAGE_CHARS,
	);
	const fetched = Number(rows[0]?.fetched ?? 0);
	if (rows.length === 0) {
		assertRowVersion(await database.get(`SELECT ${c.schemaVersion} AS ${META_VERSION} FROM ${meta}`));
	}
	return {
		page: (await withJournalPayloads(database, chunkTable, rows)).map(entryFromRow),
		more: rows.length > 0 && (rows.length < fetched || fetched === limit),
		limit: nextReadBatch(limit, fetched, rows.length, JOURNAL_READ_PAGE_SIZE),
	};
}

async function sharedFile(database: SqliteDatabase, tx: SqliteExecutor): Promise<string | undefined> {
	if (database.descriptor.adapter !== "node-sqlite") return undefined;
	const { file } = (await tx.get<SqliteRow & { file: string }>(
		"SELECT file FROM pragma_database_list WHERE name = 'main'",
	))!;
	return file === "" ? undefined : file;
}

/** `error`, as an Error, with `cleanupCause` attached: a failure while cleaning up after it never replaces it. */
function withCleanupCause(
	error: StorageFailureCause,
	cleanupCause: StorageFailureCause,
	descriptor: StorageDescriptor,
): Error {
	const primary = error instanceof Error ? error : new StorageUnavailableError(descriptor, error);
	Object.defineProperty(primary, "cleanupCause", { value: cleanupCause, configurable: true });
	return primary;
}

/**
 * A failed read keeps its own error. A rollback that also fails is attached to it and retires the reader, which may
 * still be inside the read transaction: closing it ends that transaction, and a failure to close is attached to the
 * rollback failure in turn.
 */
async function readTransaction<T>(
	reader: SqliteDatabase,
	body: (executor: SqliteExecutor) => Promise<T>,
	retire: () => void,
): Promise<T> {
	await reader.exec("BEGIN");
	try {
		const value = await body(reader);
		await reader.exec("COMMIT");
		return value;
	} catch (error) {
		try {
			await reader.exec("ROLLBACK");
		} catch (rollbackFailure) {
			retire();
			let cleanupCause = rollbackFailure as StorageFailureCause;
			try {
				await reader.close();
			} catch (closeFailure) {
				cleanupCause = withCleanupCause(cleanupCause, closeFailure as StorageFailureCause, reader.descriptor);
			}
			throw withCleanupCause(error as StorageFailureCause, cleanupCause, reader.descriptor);
		}
		throw error;
	}
}

export class SqlRunJournal implements RunJournal {
	private closed = false;
	private tail: Promise<void> = Promise.resolve();
	private closePromise?: Promise<void>;
	private readonly database: SqliteDatabase;
	private readonly dialect: StorageDialect;
	private readonly tables: Tables;
	private readonly legacy: LegacyJournalRuns | undefined;
	readonly snapshotBlobs: SqlSnapshotBlobStore;
	private readonly appendGuard = new AsyncLocalStorage<JournalAppendGuard>();
	private readonly readerFile: string | undefined;
	private reader?: Promise<SqliteDatabase>;
	private readerTail: Promise<void> = Promise.resolve();

	private constructor(
		database: SqliteDatabase,
		tables: Tables,
		legacy: LegacyJournalRuns | undefined,
		readerFile: string | undefined,
		snapshotBlobs: SqlSnapshotBlobStore,
	) {
		this.database = database;
		this.dialect = dialectOf(database);
		this.tables = tables;
		this.legacy = legacy;
		this.readerFile = readerFile;
		this.snapshotBlobs = snapshotBlobs;
		const batch = database.batch?.bind(database);
		// Every pool transaction and read checks the schema version before its first statement, and every pool batch fences
		// on it, so the pool refuses a journal a later build upgraded (#4965). A plan that reads nothing, as an optimistic
		// pool write's, costs no request: its batch's fence checks the version, and refuses it as a read would. On a database
		// that locks rows, the fence share-locks the meta row it read, so a later build's bump waits until the write commits
		// rather than slipping in between the fence and the commit (#5219). A libSQL batch runs under the database's write
		// lock, which the bump takes too, so the version it read holds until the batch commits.
		const versionFence: SqliteStatement = {
			sql: `INSERT INTO ${poolFenceTable(this.tables.runs)}(reason) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM ${this.tables.meta} WHERE ${c.schemaVersion} = ?${this.dialect.lockClause("share")})`,
			params: [JOURNAL_SCHEMA_VERSION],
		};
		registerSqlPoolStorage(this, {
			transaction: (body) =>
				this.operation(() => this.database.transaction((tx) => body(this.versionChecked(tx)), JOURNAL_TRANSACTION)),
			...(batch === undefined
				? {}
				: {
						batch: (statements, options) =>
							this.operation(async () => {
								try {
									return (
										await batch([versionFence, ...statements], {
											lockWaitMs: JOURNAL_TRANSACTION.lockWaitMs,
											...options,
										})
									).slice(1);
								} catch (error) {
									// A fence aborted the batch: when it was the version's, say so rather than plan it again.
									await this.assertVersion(this.database);
									throw error;
								}
							}),
					}),
			// A database that locks rows (PostgreSQL) runs the pool's audited hot paths as fenced transactions (#5102).
			...(batch === undefined && locksRows(this.dialect)
				? {
						// Fenced on the schema version as a batch is: an optimistic plan reads nothing (#4965).
						fenced: (statements, audit, excludesSerial) =>
							this.operation(async () => {
								try {
									return (await this.fencedWrite([versionFence, ...statements], audit, excludesSerial)).slice(
										1,
									);
								} catch (error) {
									await this.assertVersion(this.database);
									throw error;
								}
							}),
					}
				: {}),
			read: (body) => this.operation(() => this.readSnapshot((executor) => body(this.versionChecked(executor)))),
			peek: (body) => this.operation(() => this.readSnapshot(body)),
			withAppendGuard: (guard, action) => this.appendGuard.run(guard, action),
			tables: this.tables,
			olderBuildLive: (executor) => olderBuildLive(executor, this.dialect, this.tables),
			snapshotBlobs,
			dialect: this.dialect,
			adapter: database.descriptor.adapter,
			locksOnThread: database.descriptor.adapter === "libsql" && /^file:/i.test(database.descriptor.location),
			...(database.notifications === undefined ? {} : { notifications: database.notifications }),
		});
		registerJournalKeyRangeRead(this, (runId, fromKey, toKey, options) =>
			SqlRunJournal.readKeyRange(this, runId, fromKey, toKey, options),
		);
	}

	/**
	 * `statements` in order in one fenced transaction (#5102). They are sent together, without waiting for their answers,
	 * and the commit behind them: a pipelined connection runs them in one round trip, so the rows their fences lock are
	 * held only while the server runs them and commits. A failed statement fails the write with its own error, the first
	 * in order; the ones after it fail only because it did.
	 */
	private async fencedWrite(
		statements: readonly SqliteStatement[],
		audit: FencedPathId,
		excludesSerial = false,
	): Promise<SqliteRow[][]> {
		let answers: Promise<PromiseSettledResult<SqliteRow[]>[]> | undefined;
		const firstFailure = async () =>
			(await answers)?.find((answer): answer is PromiseRejectedResult => answer.status === "rejected")?.reason;
		try {
			await this.database.transaction(
				async (tx) => {
					answers = Promise.allSettled(statements.map((statement) => tx.all(statement.sql, ...statement.params)));
				},
				{
					...JOURNAL_WRITE_TRANSACTION,
					concurrency: excludesSerial ? { kind: "fenced", audit, excludesSerial } : { kind: "fenced", audit },
				},
			);
		} catch (error) {
			throw (await firstFailure()) ?? error;
		}
		// The transaction committed, so every statement in it succeeded.
		return (await answers!).map((answer) => (answer as PromiseFulfilledResult<SqliteRow[]>).value);
	}

	static async open(database: SqliteDatabase, options: { readonly prefix?: string } = {}): Promise<SqlRunJournal> {
		validateStoragePrefix(options.prefix, dialectOf(database).name);
		const t = renderStorageIdentifiers("journal", JOURNAL_TABLES, options.prefix);
		if (!(await SqlRunJournal.initialized(database, t))) await SqlRunJournal.initialize(database, t, options.prefix);
		const readerFile = await sharedFile(database, database);
		const legacy = options.prefix ? undefined : await LegacyJournalRuns.open(database);
		const snapshotBlobs = await SqlSnapshotBlobStore.open(database, options.prefix);
		return new SqlRunJournal(database, t, legacy, readerFile, snapshotBlobs);
	}

	/**
	 * Whether the journal's tables already exist with one supported schema version, read without the write lock: a
	 * process that opens a journal only to read it, such as a journal store listing every shard, never takes the lock
	 * of a database another process writes (#4325).
	 */
	private static async initialized(database: SqliteDatabase, t: Tables): Promise<boolean> {
		const dialect = dialectOf(database);
		// Every table this build needs: a database holding only some of them, such as a sessions database a snapshot blob
		// write marked with the journal meta (#5065), gets the rest created under the write lock.
		for (const table of [t.meta, t.runs, t.events, t.leases, t.eventChunks, t.leaseBuilds]) {
			const exists = dialect.tableExists(table);
			if ((await database.get(exists.sql, ...exists.params)) === undefined) return false;
		}
		const versions = await database.all(`SELECT ${c.schemaVersion} FROM ${t.meta}`);
		if (versions.length !== 1) return false;
		// A journal of the previous version is upgraded under the write lock, once (#4965).
		if (versions[0]![c.schemaVersion] === RUN_JOURNAL_SCHEMA_VERSION_UNCHUNKED) return false;
		SqlRunJournal.assertSchemaVersion(versions[0]![c.schemaVersion]!);
		return true;
	}

	private static assertSchemaVersion(found: SqliteValue, upgradable = false): void {
		if (found === JOURNAL_SCHEMA_VERSION || (upgradable && found === RUN_JOURNAL_SCHEMA_VERSION_UNCHUNKED)) return;
		throw new JournalSchemaVersionError(found);
	}

	private static async initialize(database: SqliteDatabase, t: Tables, prefix?: string): Promise<void> {
		// Measure space outside the writer: the transaction may need to replace an older session reference index.
		const dialect = dialectOf(database);
		const reset = await SqlSnapshotBlobStore.prepareSessionIndexReset(database);
		// Opening a journal waits for the lock as its writes do: a process starting while another stalls must not fail.
		await database.transaction(async (tx) => {
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${t.meta}(${c.schemaVersion} ${dialect.types.int} NOT NULL)`);
			const versions = await tx.all(`SELECT ${c.schemaVersion} FROM ${t.meta}`);
			if (versions.length > 1) throw new JournalMetaCorruptError(database.descriptor.location, versions.length);
			if (versions.length === 0) {
				await tx.run(`INSERT INTO ${t.meta} VALUES (?)`, JOURNAL_SCHEMA_VERSION);
			} else SqlRunJournal.assertSchemaVersion(versions[0]![c.schemaVersion]!, true);
			// The tables, and a journal of the previous version upgraded to store large payloads in chunks (#4965).
			await upgradeRunJournalSchema(tx, prefix, dialect);
			// The snapshot blob table too, so a new journal takes the write lock once (#4325) and opens it lock-free.
			await SqlSnapshotBlobStore.initialize(tx, prefix, dialect, reset);
		}, JOURNAL_WRITE_TRANSACTION);
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

	/**
	 * A journal write transaction, waiting out a write lock held by a stalled process and running again after a
	 * transient failure that ended it before it committed (`JOURNAL_WRITE_TRANSACTION`).
	 */
	private transaction<T>(body: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.database.transaction(async (tx) => {
			await this.assertVersion(tx);
			return body(tx);
		}, JOURNAL_WRITE_TRANSACTION);
	}

	/**
	 * Refuses a journal a later build upgraded after this process opened it (#4965): each transaction reads the schema
	 * version first, once, so a process that stays open across an upgrade never misreads or misses what it now stores.
	 */
	private async assertVersion(executor: SqliteExecutor): Promise<void> {
		try {
			await assertStoredSchemaVersion(
				executor,
				{ sql: `SELECT ${c.schemaVersion} FROM ${this.tables.meta}` },
				"journal",
				JOURNAL_SCHEMA_VERSION,
				c.schemaVersion,
			);
		} catch (error) {
			if (error instanceof StorageSchemaVersionError) throw new JournalSchemaVersionError(error.found);
			throw error;
		}
	}

	/**
	 * `executor`, checking the journal's schema version with {@link assertVersion} before its first statement. Everything
	 * else is the executor itself, so a caller that needs the database handle (its writer queue, its class) still gets it.
	 */
	private versionChecked<E extends SqliteExecutor>(executor: E): E {
		let checked: Promise<void> | undefined;
		const checking = new Set(["exec", "run", "get", "all"]);
		return new Proxy(executor, {
			get: (target, property) => {
				const value = Reflect.get(target, property, target) as unknown;
				if (typeof value !== "function") return value;
				if (typeof property !== "string" || !checking.has(property)) return value.bind(target);
				return async (...args: unknown[]) => {
					checked ??= this.assertVersion(target);
					await checked;
					return (value as (...params: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}

	/** The column that reads the journal's schema version in a read's own statement. */
	private get metaVersion(): string {
		return `(SELECT ${c.schemaVersion} FROM ${this.tables.meta}) AS ${META_VERSION}`;
	}

	private async readSnapshot<T>(body: (executor: SqliteExecutor) => Promise<T>): Promise<T> {
		const readerFile = this.readerFile;
		if (readerFile === undefined) return body(this.database);
		const result = this.readerTail.then(async () =>
			readTransaction(await this.openedReader(readerFile), body, () => {
				this.reader = undefined;
			}),
		);
		this.readerTail = Promise.allSettled([result]).then(() => {});
		return result;
	}

	/** Opened by a read in turn: the first one, and the one after a reader failed to open or was retired. */
	private async openedReader(file: string): Promise<SqliteDatabase> {
		if (this.reader === undefined) this.reader = openNodeSqliteDatabase(file, { readOnly: true });
		try {
			return await this.reader;
		} catch (error) {
			this.reader = undefined;
			throw error;
		}
	}

	private operation<T>(action: () => Promise<T>): Promise<T> {
		this.assertOpen();
		const result = action();
		this.tail = Promise.allSettled([this.tail, result]).then(() => {});
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
			// In a transaction, so the write waits for the lock without blocking the event loop on SQLite's busy timeout.
			const result = await this.transaction((tx) =>
				tx.run(
					`INSERT INTO ${runs} VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(${c.runId}) DO NOTHING`,
					header.runId,
					header.name,
					header.cwd,
					header.createdAt,
					header.status,
					json,
				),
			);
			return result.changes === 1 ? "created" : "exists";
		});
	}

	/**
	 * Creates a run and its first events in one transaction (`RunJournal.createRunWithEvents`). Every payload is
	 * serialized before the transaction starts, so an invalid payload writes nothing. Events carry the absent epoch:
	 * the run has no lease until a holder takes one.
	 */
	async createRunWithEvents(header: RunHeader, events: readonly RunJournalSeedEvent[]): Promise<"created" | "exists"> {
		this.assertOpen();
		validateText("runId", header.runId);
		validateText("name", header.name);
		validateText("cwd", header.cwd);
		validateText("status", header.status);
		const json = this.snapshotJson(header);
		if (json instanceof StorageUnavailableError) throw json;
		const prepared = events.map((seed) => {
			const append = this.prepare(seed.event, seed.key, undefined);
			if (append.payload instanceof StorageUnavailableError) throw append.payload;
			return { ...append, payload: append.payload };
		});
		const { runs } = this.tables;
		return this.operation(async () => {
			if (await this.legacy?.find(this.database, header.runId)) return "exists";
			return this.transaction(async (tx) => {
				const created = await tx.run(
					`INSERT INTO ${runs} VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(${c.runId}) DO NOTHING`,
					header.runId,
					header.name,
					header.cwd,
					header.createdAt,
					header.status,
					json,
				);
				if (created.changes !== 1) return "exists";
				let status: string | undefined;
				for (const [index, append] of prepared.entries()) {
					await this.insertEvent(
						tx,
						header.runId,
						index + 1,
						JOURNAL_LEASE.absentEpoch,
						append.key,
						append.type,
						append.stored!,
					);
					status = append.status ?? status;
				}
				if (status !== undefined)
					await tx.run(`UPDATE ${runs} SET ${c.status} = ? WHERE ${c.runId} = ?`, status, header.runId);
				return "created";
			});
		});
	}

	async getRun(runId: string): Promise<RunSummary | undefined> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(async () => {
			const row = await this.database.get<HeaderRow>(
				`SELECT ${c.headerJson}, ${c.status}, ${this.metaVersion} FROM ${this.tables.runs} WHERE ${c.runId} = ?`,
				runId,
			);
			if (row === undefined) await this.assertVersion(this.database);
			assertRowVersion(row);
			const found = row ?? (await this.legacy?.find(this.database, runId));
			return found
				? { ...(JSON.parse(found[c.headerJson]) as RunHeader), status: runStatusFromRecord(found[c.status]) }
				: undefined;
		});
	}

	async listRuns(filter?: { cwd?: string }): Promise<readonly RunSummary[]> {
		this.assertOpen();
		if (filter?.cwd !== undefined) validateText("cwd", filter.cwd);
		return this.operation(async () => {
			const request = this.database.all<HeaderRow>(
				`SELECT ${c.headerJson}, ${c.status}, ${this.metaVersion} FROM ${this.tables.runs} ${filter?.cwd === undefined ? "" : `WHERE ${c.cwd} = ?`} ORDER BY ${c.runId}`,
				...(filter?.cwd === undefined ? [] : [filter.cwd]),
			);
			let rows: HeaderRow[];
			try {
				rows = await request;
			} catch (error) {
				if (filter !== undefined || !isStorageResponseRefusal(error) || this.legacy) throw error;
				return this.listRefusedCatalog(error);
			}
			if (rows.length === 0) await this.assertVersion(this.database);
			assertRowVersion(rows[0]);
			const legacy = (await this.legacy?.pending(this.database, filter)) ?? [];
			return [...rows, ...legacy]
				.map((row) => ({
					...(JSON.parse(row[c.headerJson]) as RunHeader),
					status: runStatusFromRecord(row[c.status]),
				}))
				.sort((left, right) => (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0));
		});
	}

	/** Read the refused, current-format catalog from one new snapshot. Never reopen it or replay a fitting prefix. */
	private async listRefusedCatalog(refusal: StoragePayloadTooLargeError): Promise<readonly RunSummary[]> {
		this.assertOpen();
		let reader: SqliteDatabase | undefined;
		try {
			reader = await this.database.openReader?.();
		} catch {
			throw refusal;
		}
		// Never borrow the journal's connection: its lease renewals cannot wait for this read to finish.
		if (!reader || reader === this.database) throw refusal;
		let listed: RunSummary[];
		try {
			this.assertOpen();
			listed = await this.readCatalogPages(reader, refusal);
			await this.assertVersion(reader);
		} catch (error) {
			await reader.close().catch(() => {});
			throw error;
		}
		await reader.close();
		return listed.sort((left, right) => (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0));
	}

	private readCatalogPages(reader: SqliteDatabase, refusal: StoragePayloadTooLargeError): Promise<RunSummary[]> {
		return reader.transaction(
			async (tx) => {
				await this.assertVersion(tx);
				const keepRefusal = (error: unknown): never => {
					if (isStorageResponseRefusal(error)) throw refusal;
					throw error;
				};
				const table = this.tables.runs;
				const bytes = this.dialect.textByteLength;
				const width = `${bytes(c.headerJson)} + ${bytes(c.status)}`;
				const widest = await tx
					.get<{ run_id: string; width: number | bigint }>(
						`SELECT ${c.runId}, ${width} AS width FROM ${table} ORDER BY ${width} DESC LIMIT 1`,
					)
					.catch(keepRefusal);
				const runs: RunSummary[] = [];
				if (!widest) return runs;
				const projection = `${c.headerJson}, ${c.status}, ${this.metaVersion}`;
				const collect = (row: HeaderRow, key: string) => {
					const header = JSON.parse(row[c.headerJson]) as RunHeader;
					if (header.runId !== key) throw refusal;
					runs.push({ ...header, status: runStatusFromRecord(row[c.status]) });
				};
				const point = async (id: string) => {
					const row = await tx
						.get<HeaderRow>(`SELECT ${projection} FROM ${table} WHERE ${c.runId} = ?`, id)
						.catch(keepRefusal);
					if (!row) throw refusal;
					collect(row, id);
				};
				// Use the original columns for the widest singleton. Even appending its key could put it over the limit.
				const widestId = widest.run_id;
				await point(widestId);
				// Leave room for the physical key (also present in a canonical header) and the response's row framing.
				const limit = Math.max(1, Math.floor((128 * 1024) / (2 * Number(widest.width) + 128)));
				for (let after: string | undefined; ; ) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					this.assertOpen();
					const range = `FROM ${table} WHERE ${c.runId} <> ?${after === undefined ? "" : ` AND ${c.runId} > ?`} ORDER BY ${c.runId} LIMIT ?`;
					const args = after === undefined ? [widestId, limit] : [widestId, after, limit];
					if (limit === 1) {
						const next = await tx
							.get<{ run_id: string }>(`SELECT ${c.runId} ${range}`, ...args)
							.catch(keepRefusal);
						if (!next) break;
						after = next.run_id;
						await point(after);
					} else {
						const page = await tx
							.all<HeaderRow & { run_id: string }>(
								`SELECT ${c.runId}, ${c.headerJson}, ${c.status} ${range}`,
								...args,
							)
							.catch(keepRefusal);
						for (const row of page) {
							after = row.run_id;
							collect(row, after);
						}
						if (page.length < limit) break;
					}
				}
				return runs;
			},
			{ readOnly: true },
		);
	}

	/**
	 * The dialect's change markers move when another connection commits (on SQLite, `data_version`) and when this one
	 * writes (`total_changes()`), so together they cover writers in every process, but only on one connection: Atomic's
	 * own SQLite adapter serves every statement from one. Over an adapter that may not, such as a libSQL server whose
	 * every HTTP request is a new stream, neither moves, and the table aggregates miss a deleted run replaced by one with
	 * as many events (its events reuse the deleted rowids), so there is no token and each catalog read compares every
	 * run's version (#4814).
	 */
	async changeToken(): Promise<string | undefined> {
		this.assertOpen();
		if (this.database.descriptor.adapter !== "node-sqlite") return undefined;
		const { changeMarkers, rowOrder } = this.dialect;
		return this.operation(async () => {
			const row = await this.database.get<SqliteRow>(
				`SELECT ${changeMarkers.columns},
					(SELECT count(*) FROM ${this.tables.runs}) AS runs,
					(SELECT max(${rowOrder()}) FROM ${this.tables.events}) AS last_event${changeMarkers.from}`,
			);
			return JSON.stringify(Object.values(row ?? {}).map(String));
		});
	}

	/**
	 * Every run's latest event, read in statements of `RUN_VERSIONS_SERVER_PAGE` runs over a database server. Over this
	 * process's own SQLite connection the runs are read `RUN_VERSIONS_PAGE` at a time, with a turn of the event loop
	 * between statements: a statement looks up each run's latest event, which on a journal of thousands of runs held the
	 * event loop for over 100 ms when the pages were not cached (#5480). Once `stop` aborts, the read ends at the next
	 * statement with its reason.
	 */
	async runVersions(stop?: AbortSignal): Promise<ReadonlyMap<string, RunVersion>> {
		this.assertOpen();
		return this.operation(async () => {
			const local = this.database.descriptor.adapter === "node-sqlite";
			const pageRuns = local ? RUN_VERSIONS_PAGE : RUN_VERSIONS_SERVER_PAGE;
			const select = `SELECT runs.${c.runId}, ${latestEventColumns(this.tables.events, "runs")} FROM ${this.tables.runs} AS runs`;
			const versions = new Map<string, RunVersion>();
			const add = (row: RunVersionRow) =>
				versions.set(row[c.runId], {
					seq: journalCounter(row[c.runId], "seq", row[c.seq]),
					at: Number(row[c.at]),
				});
			const readPage = (reader: SqliteExecutor, after?: string) =>
				reader.all<RunVersionRow>(
					`${select}${after === undefined ? "" : ` WHERE runs.${c.runId} > ?`} ORDER BY runs.${c.runId} LIMIT ?`,
					...(after === undefined ? [] : [after]),
					pageRuns,
				);
			const nextPage = async () => {
				if (local) await new Promise<void>((resolve) => setImmediate(resolve));
				stop?.throwIfAborted();
			};
			const first = await readPage(this.database);
			if (first.length < pageRuns) {
				for (const row of first) add(row);
			} else {
				// Reread even the first page in the snapshot: a writer may have deleted one of its runs and created
				// another beyond the cursor. Combining those pages would list runs that never coexisted.
				await nextPage();
				await this.database.transaction(
					async (reader) => {
						for (let after: string | undefined; ; ) {
							stop?.throwIfAborted();
							const page = await readPage(reader, after);
							for (const row of page) add(row);
							if (page.length < pageRuns) break;
							after = page.at(-1)![c.runId];
							await nextPage();
						}
					},
					{ readOnly: true },
				);
			}
			for (const row of (await this.legacy?.versions(this.database)) ?? []) add(row);
			return versions;
		});
	}

	/**
	 * The latest snapshot event is found by walking the run's `(run_id, seq)` key back from its last event, so
	 * only the events after it are visited and only its payload is read. A statement visits every event it walks past, so
	 * on a journal read through a connection of this process, the statement looks for the snapshot only among the latest
	 * `SNAPSHOT_TAIL_WINDOW` events, and a snapshot further back is found by `walkToSnapshot` in statements of that size:
	 * one run with a hundred thousand checkpoints after its snapshot held the event loop for seconds (#5480). Once `stop`
	 * aborts, the walk ends at its next statement with its reason.
	 */
	async snapshotTail(runId: string, stop?: AbortSignal): Promise<RunSnapshotTail | undefined> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(async () => {
			const legacy = await this.isUnconvertedLegacyRun(runId);
			const events = legacy ? JOURNAL_TABLES.events : this.tables.events;
			// The legacy tables have no chunks column: every payload there is stored whole.
			const chunks = legacy ? `0 AS ${c.chunks}` : c.chunks;
			// A journal read over the network does not hold this process's event loop while a statement runs.
			const windowed = this.readerFile !== undefined;
			const later = `FROM ${events} AS later WHERE later.${c.runId} = snapshot.${c.runId} AND later.${c.seq} > snapshot.${c.seq} AND later.${c.type} = ?`;
			const latestSeq = `(SELECT ${c.seq} FROM ${events} WHERE ${c.runId} = ? ORDER BY ${c.seq} DESC LIMIT 1)`;
			const row = await this.database.get<SnapshotTailRow>(
				`SELECT ${EVENT_COLUMNS.map((column) => `snapshot.${column}`).join(", ")}, snapshot.${c.chunks},
					latest.${c.seq} AS latest_seq, latest.${c.at} AS latest_at, ${this.metaVersion},
					(SELECT count(*) ${later}) AS later_checkpoints,
					(SELECT ${this.dialect.jsonText(`later.${c.payload}`, "completedAt")} ${later} ORDER BY later.${c.seq} DESC LIMIT 1) AS last_checkpoint_at
				FROM (SELECT ${c.seq}, ${c.at} FROM ${events} WHERE ${c.runId} = ? ORDER BY ${c.seq} DESC LIMIT 1) AS latest
					${windowed ? "LEFT JOIN" : ","} (SELECT ${EVENT_COLUMNS.join(", ")}, ${chunks} FROM ${events} WHERE ${c.runId} = ? AND ${c.type} NOT IN (${NON_SNAPSHOT_EVENT_TYPES.map(() => "?").join(", ")})${windowed ? ` AND ${c.seq} > ${latestSeq} - ?` : ""} ORDER BY ${c.seq} DESC LIMIT 1) AS snapshot${windowed ? " ON 1 = 1" : ""}`,
				RUN_EVENT_TYPES.checkpointRecorded,
				RUN_EVENT_TYPES.checkpointRecorded,
				runId,
				runId,
				...NON_SNAPSHOT_EVENT_TYPES,
				...(windowed ? [runId, SNAPSHOT_TAIL_WINDOW] : []),
			);
			if (row === undefined) {
				await this.assertVersion(this.database);
				return undefined;
			}
			// Without a snapshot among the window's events, the left join leaves the snapshot's columns null.
			if ((row as SqliteRow)[c.seq] === null) {
				assertRowVersion(row);
				// The window held every event of the run: it has no snapshot.
				if (Number(row.latest_seq) < SNAPSHOT_TAIL_WINDOW) return undefined;
				return this.walkToSnapshot(runId, events, chunks, stop);
			}
			const [snapshot] = await withJournalPayloads(this.database, this.tables.eventChunks, [row]);
			return {
				version: { seq: journalCounter(runId, "seq", row.latest_seq), at: Number(row.latest_at) },
				snapshot: entryFromRow(snapshot!),
				laterCheckpoints: Number(row.later_checkpoints),
				...(row.last_checkpoint_at === null ? {} : { lastCheckpointAt: Number(row.last_checkpoint_at) }),
			};
		});
	}

	/**
	 * `snapshotTail` for a run whose latest snapshot is further back than one statement's window. The run's events are
	 * walked back `SNAPSHOT_TAIL_WINDOW` at a time, counting the checkpoints passed, with a turn of the event loop between
	 * statements. Every statement runs in one read transaction of the reader connection, so the walk reads one state of
	 * the journal, as the single statement does, whatever is committed meanwhile. A walk `stop` ends lets go of that
	 * transaction: it is rolled back.
	 */
	private walkToSnapshot(
		runId: string,
		events: string,
		chunks: string,
		stop: AbortSignal | undefined,
	): Promise<RunSnapshotTail | undefined> {
		return this.readSnapshot(async (reader) => {
			const latest = await reader.get<SqliteRow & { [c.seq]: number; [c.at]: number }>(
				`SELECT ${c.seq}, ${c.at} FROM ${events} WHERE ${c.runId} = ? ORDER BY ${c.seq} DESC LIMIT 1`,
				runId,
			);
			let snapshotSeq: number | undefined;
			let laterCheckpoints = 0;
			let lastCheckpointSeq: number | undefined;
			for (let below = latest === undefined ? 0 : Number(latest[c.seq]) + 1; below > 0; ) {
				const rows = await reader.all<SqliteRow & { [c.seq]: number; [c.type]: string }>(
					`SELECT ${c.seq}, ${c.type} FROM ${events} WHERE ${c.runId} = ? AND ${c.seq} < ? ORDER BY ${c.seq} DESC LIMIT ?`,
					runId,
					below,
					SNAPSHOT_TAIL_WINDOW,
				);
				for (const row of rows) {
					const type = row[c.type];
					if (!(NON_SNAPSHOT_EVENT_TYPES as readonly string[]).includes(type)) {
						snapshotSeq = Number(row[c.seq]);
						break;
					}
					if (type !== RUN_EVENT_TYPES.checkpointRecorded) continue;
					laterCheckpoints++;
					lastCheckpointSeq ??= Number(row[c.seq]);
				}
				if (snapshotSeq !== undefined || rows.length < SNAPSHOT_TAIL_WINDOW) break;
				below = Number(rows.at(-1)![c.seq]);
				await new Promise<void>((resolve) => setImmediate(resolve));
				stop?.throwIfAborted();
			}
			if (latest === undefined || snapshotSeq === undefined) {
				await this.assertVersion(reader);
				return undefined;
			}
			const snapshot = await reader.get<EventRow>(
				`SELECT ${EVENT_COLUMNS.join(", ")}, ${chunks}, ${this.metaVersion} FROM ${events} WHERE ${c.runId} = ? AND ${c.seq} = ?`,
				runId,
				snapshotSeq,
			);
			const lastCheckpoint =
				lastCheckpointSeq === undefined
					? undefined
					: await reader.get<SqliteRow & { completed_at: number | null }>(
							`SELECT ${this.dialect.jsonText(c.payload, "completedAt")} AS completed_at FROM ${events} WHERE ${c.runId} = ? AND ${c.seq} = ?`,
							runId,
							lastCheckpointSeq,
						);
			const [loaded] = await withJournalPayloads(reader, this.tables.eventChunks, [snapshot!]);
			const completedAt = lastCheckpoint?.completed_at ?? null;
			return {
				version: { seq: journalCounter(runId, "seq", latest[c.seq]), at: Number(latest[c.at]) },
				snapshot: entryFromRow(loaded!),
				laterCheckpoints,
				...(completedAt === null ? {} : { lastCheckpointAt: Number(completedAt) }),
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

	/**
	 * Before a write that changes who holds `runId`'s lease or at which epoch, on a database that locks rows: locks the
	 * lease row, so the write waits for the pool's fenced writes under the lease, which key-share lock it, and every
	 * later one sees the change (#5102). A renewal changes neither and takes no such lock.
	 */
	private async lockLease(tx: SqliteExecutor, runId: string): Promise<void> {
		if (locksRows(this.dialect))
			await tx.get(
				`SELECT ${c.runId} FROM ${this.tables.leases} WHERE ${c.runId} = ?${this.dialect.lockClause("update")}`,
				runId,
			);
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
			`INSERT INTO ${this.tables.leases} VALUES (?, ?, ?, ${this.dialect.nowMs}) ON CONFLICT(${c.runId}) DO UPDATE SET ${c.holderId} = excluded.${c.holderId}, ${c.epoch} = excluded.${c.epoch}, ${c.renewedAt} = excluded.${c.renewedAt}`,
			runId,
			holderId,
			epoch,
		);
		// Records that this build granted the lease, so a write can tell a live holder of an older build (#4965).
		await tx.run(
			`INSERT INTO ${this.tables.leaseBuilds} (${c.runId}, ${c.holderId}, ${c.epoch}, ${c.schemaVersion}) VALUES (?, ?, ?, ?) ON CONFLICT(${c.runId}) DO UPDATE SET ${c.holderId} = excluded.${c.holderId}, ${c.epoch} = excluded.${c.epoch}, ${c.schemaVersion} = excluded.${c.schemaVersion}`,
			runId,
			holderId,
			epoch,
			JOURNAL_SCHEMA_VERSION,
		);
		return { status: "acquired", lease: { runId, holderId, epoch } };
	}

	async acquire(runId: string, holderId: string): Promise<LeaseOutcome> {
		this.assertOpen();
		validateText("runId", runId);
		validateText("holderId", holderId);
		return this.operation(() =>
			this.transaction(async (tx) => {
				await this.requireRun(tx, runId);
				await this.lockLease(tx, runId);
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
			this.transaction(async (tx) => {
				await this.requireRun(tx, runId);
				await this.lockLease(tx, runId);
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
		const { least, greatest, nowMs } = this.dialect;
		return this.operation(async () => {
			const row = await this.database.get<LeaseRow & { age_ms: number }>(
				`SELECT *, ${least(String(Number.MAX_SAFE_INTEGER), greatest("0", `${nowMs} - ${c.renewedAt}`))} AS age_ms FROM ${this.tables.leases} WHERE ${c.runId} = ?`,
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
			this.transaction(async (tx) => {
				await this.requireRun(tx, runId);
				await this.lockLease(tx, runId);
				const current = await this.leaseRow(tx, runId);
				if (current?.[c.holderId] === holderId)
					return { status: "acquired", lease: { runId, holderId, epoch: current[c.epoch] } };
				if (current && current[c.holderId] !== null) {
					const now = (await tx.get<SqliteRow & { now: number }>(`SELECT ${this.dialect.nowMs} AS now`))!.now;
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
		const batch = this.database.batch?.bind(this.database);
		// One request where the database sends batches: the renewal writes only while the lease is held, in SQL, and the
		// lease row read in the same request says whether it did, so it never holds the write lock across a round trip.
		if (batch) return this.operation(() => this.renewInOneRequest(batch, owned));
		return this.operation(() =>
			this.transaction(async (tx) => {
				await this.checkLease(tx, owned);
				await tx.run(
					`UPDATE ${this.tables.leases} SET ${c.renewedAt} = ${this.dialect.nowMs} WHERE ${c.runId} = ?`,
					owned.runId,
				);
			}),
		);
	}

	/** {@link renew} as one request: refuses a lease another holder or epoch took, as {@link checkLease} does. */
	private async renewInOneRequest(batch: NonNullable<SqliteDatabase["batch"]>, owned: Lease): Promise<void> {
		const t = this.tables;
		const rows = await batch(
			[
				{
					sql: `SELECT ${this.metaVersion}, l.* FROM (SELECT 1) AS one LEFT JOIN ${t.leases} AS l ON l.${c.runId} = ?`,
					params: [owned.runId],
				},
				{
					// An epoch out of range writes nothing, as the transaction path refuses it; the read above reports it.
					sql: `UPDATE ${t.leases} SET ${c.renewedAt} = ${this.dialect.nowMs} WHERE ${c.runId} = ? AND ${c.holderId} = ? AND ${c.epoch} = ? AND ${counterInRange(c.epoch)} AND EXISTS (SELECT 1 FROM ${t.meta} WHERE ${c.schemaVersion} = ?)`,
					params: [owned.runId, owned.holderId, owned.epoch, Number.MAX_SAFE_INTEGER, JOURNAL_SCHEMA_VERSION],
				},
			],
			// A renewal keeps the root's lease alive, so it never waits behind this process's other writes to the server.
			{ ...JOURNAL_WRITE_TRANSACTION, priority: true },
		);
		// The renewal wrote nothing when the journal is at another version: its condition checks it.
		assertRowVersion(rows[0]![0]);
		const row = rows[0]![0] as LeaseRow | undefined;
		const epoch = row?.[c.epoch] == null ? undefined : journalCounter(owned.runId, "epoch", row[c.epoch]);
		if (row?.[c.holderId] !== owned.holderId || epoch !== owned.epoch)
			throw new StaleLeaseError(owned.runId, owned.epoch, epoch ?? JOURNAL_LEASE.absentEpoch);
	}

	async release(lease: Lease): Promise<void> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		return this.operation(() =>
			this.transaction(async (tx) => {
				await this.lockLease(tx, owned.runId);
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
		// Fenced pool commits append to the run without the database-wide lock, under its run row (#5102): an append
		// takes the row first, so the run's next sequence is read after every commit that took it before.
		if (locksRows(this.dialect))
			await tx.get(
				`SELECT ${c.runId} FROM ${this.tables.runs} WHERE ${c.runId} = ?${this.dialect.lockClause("update")}`,
				runId,
			);
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
		const batch = this.database.batch?.bind(this.database);
		// One request where the database sends batches and the append needs no guard, no expected sequence and no chunks,
		// as `appendMany` sends them: the lease, the key and the sequence are checked in SQL, so the write lock is never
		// held across a round trip.
		if (batch && expected === undefined && this.inOneRequest(prepared))
			return this.operation(async () => {
				const [settled] = await this.appendInOneRequest(
					(statements) => batch(statements, JOURNAL_WRITE_TRANSACTION),
					owned,
					[prepared],
				);
				if (settled!.status === "rejected") throw settled!.reason;
				return settled!.value;
			});
		return this.operation(() =>
			this.transaction(async (tx) => {
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
		if (batch && prepared.every((append) => append instanceof Error || this.inOneRequest(append)))
			// Waits for the write lock as the transaction below and a single append do.
			return this.operation(() =>
				this.appendInOneRequest((statements) => batch(statements, JOURNAL_WRITE_TRANSACTION), owned, prepared),
			);
		return this.operation(() =>
			this.transaction(async (tx) => {
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
		// A counter out of range writes nothing, as the transaction path refuses it before writing; the reads below report
		// it. The lease's epoch is the caller's when it is held, so a caller's out-of-range epoch is refused here too.
		const holds = `EXISTS (SELECT 1 FROM ${t.leases} WHERE ${c.runId} = ? AND ${c.holderId} = ? AND ${c.epoch} = ? AND ${counterInRange(c.epoch)})`;
		const held = [owned.runId, owned.holderId, owned.epoch, Number.MAX_SAFE_INTEGER] as const;
		const latest = `SELECT * FROM ${t.events} WHERE ${c.runId} = ? AND ${c.seq} = (SELECT MAX(${c.seq}) FROM ${t.events} WHERE ${c.runId} = ?)`;
		const statements: SqliteStatement[] = [
			{
				sql: `SELECT ${this.metaVersion}, l.* FROM (SELECT 1) AS one LEFT JOIN ${t.leases} AS l ON l.${c.runId} = ?`,
				params: [owned.runId],
			},
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
			// The append is written when the run's last sequence is below the limit, the lease is still held and the key
			// is new. The status update tests the same condition first, which it does not change, so the two agree.
			const appends = `FROM (SELECT COALESCE(MAX(${c.seq}), 0) AS latest FROM ${t.events} WHERE ${c.runId} = ?) AS current
					WHERE current.latest < ? AND current.latest >= 0 AND current.latest = ROUND(current.latest) AND ${holds} AND EXISTS (SELECT 1 FROM ${t.meta} WHERE ${c.schemaVersion} = ?)${
						key === undefined
							? ""
							: ` AND NOT EXISTS (SELECT 1 FROM ${t.events} WHERE ${c.runId} = ? AND ${c.key} = ?)`
					}`;
			const appendsParams = [
				owned.runId,
				Number.MAX_SAFE_INTEGER,
				...held,
				JOURNAL_SCHEMA_VERSION,
				...(key === undefined ? [] : [owned.runId, key]),
			];
			if (status !== undefined)
				at({
					sql: `UPDATE ${t.runs} SET ${c.status} = ? WHERE ${c.runId} = ? AND EXISTS (SELECT 1 ${appends})`,
					params: [status, owned.runId, ...appendsParams],
				});
			const inserted = at({
				sql: `INSERT INTO ${t.events} (${c.runId}, ${c.seq}, ${c.epoch}, ${c.key}, ${c.type}, ${c.payload}, ${c.at})
					SELECT ?, current.latest + 1, ?, ?, ?, ?, ${this.dialect.nowMs}
					${appends}
					RETURNING 1 AS inserted`,
				params: [owned.runId, owned.epoch, key ?? null, type, payload as string, ...appendsParams],
			});
			const row = at({ sql: latest, params: [owned.runId, owned.runId] });
			return { existing, inserted, row };
		});
		const rows = await batch(statements);
		// The batch wrote nothing when the journal is at another version: every write checks it in its own condition.
		assertRowVersion(rows[0]![0]);
		const leaseRow = rows[0]![0] as LeaseRow | undefined;
		const lease = leaseRow?.[c.holderId] === undefined && leaseRow?.[c.epoch] == null ? undefined : leaseRow;
		const epoch = lease === undefined ? undefined : journalCounter(owned.runId, "epoch", lease[c.epoch]);
		if (lease?.[c.holderId] !== owned.holderId || epoch !== owned.epoch)
			throw new StaleLeaseError(owned.runId, owned.epoch, epoch ?? JOURNAL_LEASE.absentEpoch);
		const settled: PromiseSettledResult<AppendOutcome>[] = [];
		for (const plan of plans) {
			if (plan instanceof Error) {
				settled.push({ status: "rejected", reason: plan });
				continue;
			}
			try {
				const existing =
					plan.existing === undefined ? undefined : (rows[plan.existing]![0] as EventRow | undefined);
				if (existing) {
					settled.push({ status: "fulfilled", value: { status: "exists", entry: await this.entryOf(existing) } });
					continue;
				}
				const row = rows[plan.row]![0] as EventRow | undefined;
				if (rows[plan.inserted]!.length === 1) {
					settled.push({ status: "fulfilled", value: { status: "appended", entry: entryFromRow(row!) } });
					continue;
				}
				const actual = journalCounter(owned.runId, "seq", row?.[c.seq] ?? 0);
				journalCounter(owned.runId, "seq", actual + 1, "overflow");
				throw new StorageUnavailableError(this.descriptor, new Error("The batched append was not written."));
			} catch (error) {
				settled.push({ status: "rejected", reason: error });
			}
		}
		return settled;
	}

	/** Whether `append` goes in one request: it has no pool guard, no payload error, and nothing stored in chunks. */
	private inOneRequest(append: ReturnType<SqlRunJournal["prepare"]>): boolean {
		return (
			append.guard === undefined &&
			typeof append.payload === "string" &&
			append.stored !== undefined &&
			append.stored.chunks.length === 0 &&
			append.worktreeSnapshots.length === 0
		);
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
		// How the payload is stored: a large one as a stub in its row and its JSON in chunks (#4965).
		const stored =
			payload instanceof StorageUnavailableError ? undefined : storedEventPayload(type, payload, event.payload);
		const carried =
			type === RUN_EVENT_TYPES.checkpointRecorded
				? (event.payload as { readonly worktreeSnapshots?: readonly WorktreeSnapshot[] }).worktreeSnapshots
				: undefined;
		const worktreeSnapshots = Array.isArray(carried) ? carried : [];
		return { key, type, payload, guard, status, stored, worktreeSnapshots };
	}

	/** Writes one event row and the chunks of its payload, if it has any, in the caller's transaction. */
	private async insertEvent(
		tx: SqliteExecutor,
		runId: string,
		seq: number,
		epoch: number,
		key: string | undefined,
		type: string,
		chunked: StoredJournalPayload,
	): Promise<void> {
		const stored = await this.withOlderBuilds(tx, chunked);
		await tx.run(
			`INSERT INTO ${this.tables.events} (${c.runId}, ${c.seq}, ${c.epoch}, ${c.key}, ${c.type}, ${c.payload}, ${c.at}, ${c.chunks}) VALUES (?, ?, ?, ?, ?, ?, ${this.dialect.nowMs}, ?)`,
			runId,
			seq,
			epoch,
			key ?? null,
			type,
			stored.payload,
			stored.chunks.length,
		);
		await writeJournalPayloadChunks(tx, this.tables.eventChunks, runId, seq, stored.chunks);
	}

	/**
	 * `stored`, or the payload whole when it is stored in chunks while a process of an older build may be reading the
	 * journal (#4965): such a process would read its stub. Whole, it is too large for a libSQL server, and fails there
	 * with `StoragePayloadTooLargeError` as it did before chunks.
	 */
	private async withOlderBuilds(tx: SqliteExecutor, stored: StoredJournalPayload): Promise<StoredJournalPayload> {
		if (stored.chunks.length === 0 || !(await olderBuildLive(tx, this.dialect, this.tables))) return stored;
		return { payload: Buffer.concat(stored.chunks).toString("utf8"), chunks: [] };
	}

	/** The entry of an events row, its payload read from its chunks when it is stored in them. */
	private async entryOf(row: EventRow, executor: SqliteExecutor = this.database): Promise<JournalEntry> {
		const [loaded] = await withJournalPayloads(executor, this.tables.eventChunks, [row]);
		return entryFromRow(loaded!);
	}

	private async insert(
		tx: SqliteExecutor,
		owned: Lease,
		{ key, type, payload, guard, status, stored, worktreeSnapshots }: ReturnType<SqlRunJournal["prepare"]>,
		expected?: number,
	): Promise<AppendOutcome> {
		await guard?.(tx, owned.runId);
		if (key !== undefined) {
			const row = await tx.get<EventRow>(
				`SELECT * FROM ${this.tables.events} WHERE ${c.runId} = ? AND ${c.key} = ?`,
				owned.runId,
				key,
			);
			if (row) return { status: "exists", entry: await this.entryOf(row, tx) };
		}
		// A checkpoint records its worktree snapshots only while every blob they reference is still stored (#5077).
		await this.snapshotBlobs.assertStored(tx, worktreeSnapshots);
		const actual = await this.sequence(tx, owned.runId);
		if (expected !== undefined && expected !== actual)
			throw new JournalCasConflictError(owned.runId, expected, actual);
		const seq = journalCounter(owned.runId, "seq", actual + 1, "overflow");
		if (payload instanceof StorageUnavailableError) throw payload;
		await this.insertEvent(tx, owned.runId, seq, owned.epoch, key, type, stored!);
		if (status !== undefined)
			await tx.run(`UPDATE ${this.tables.runs} SET ${c.status} = ? WHERE ${c.runId} = ?`, status, owned.runId);
		const row = await tx.get<EventRow>(
			`SELECT * FROM ${this.tables.events} WHERE ${c.runId} = ? AND ${c.seq} = ?`,
			owned.runId,
			seq,
		);
		await guard?.(tx, owned.runId);
		// The payload as appended, not its stub: the caller's own JSON, without reading its chunks back.
		return { status: "appended", entry: entryFromRow({ ...row!, [c.payload]: payload, [c.chunks]: 0 }) };
	}

	async *read(runId: string, fromSeq = 1): AsyncIterable<JournalEntry> {
		this.assertOpen();
		validateText("runId", runId);
		let nextSeq = fromSeq;
		let limit = JOURNAL_READ_PAGE_SIZE;
		const legacy = this.legacy;
		const readsLegacy = legacy !== undefined && (await this.operation(() => this.isUnconvertedLegacyRun(runId)));
		for (;;) {
			const { page, more, ...next } = await this.operation(async () => {
				if (readsLegacy) {
					const rows = (await legacy.events(this.database, runId, nextSeq, JOURNAL_READ_PAGE_SIZE)) as EventRow[];
					return { page: rows.map(entryFromRow), more: rows.length === JOURNAL_READ_PAGE_SIZE, limit };
				}
				return readSizedPage(
					this.database,
					this.tables.eventChunks,
					this.tables.meta,
					`SELECT * FROM ${this.tables.events} WHERE ${c.runId} = ? AND ${c.seq} >= ? ORDER BY ${c.seq} LIMIT ?`,
					c.seq,
					[runId, nextSeq],
					limit,
				);
			});
			for (const entry of page) {
				this.assertOpen();
				yield entry;
			}
			this.assertOpen();
			const last = page.at(-1);
			if (last === undefined || !more) return;
			nextSeq = last.seq + 1;
			limit = next.limit;
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
							`SELECT *, ${this.metaVersion} FROM ${this.tables.events} WHERE ${c.runId} = ? AND ${c.key} = ?`,
							runId,
							key,
						);
			if (row === undefined && !(await this.isUnconvertedLegacyRun(runId))) await this.assertVersion(this.database);
			return row ? this.entryOf(row) : undefined;
		});
	}

	/**
	 * A run's events whose key is at least `fromKey` and below `toKey`, in key order, read through the run's key index.
	 * Keys compare as SQLite compares text, by their UTF-8 bytes. Internal to the workflow runtime, so it is not part of
	 * the journal's public shape: a local worker reads its own child's checkpoints from the root this way (#4197).
	 */
	static async *readKeyRange(
		journal: SqlRunJournal,
		runId: string,
		fromKey: string,
		toKey: string,
		options?: JournalKeyRangeReadOptions,
	): AsyncIterable<JournalEntry> {
		journal.assertOpen();
		validateText("runId", runId);
		validateText("key", fromKey);
		validateText("key", toKey);
		if (journal.legacy !== undefined && (await journal.operation(() => journal.isUnconvertedLegacyRun(runId)))) {
			const bytes = (key: string) => Buffer.from(key, "utf8");
			for await (const entry of journal.read(runId)) {
				const key = entry.key === undefined ? undefined : bytes(entry.key);
				if (key !== undefined && Buffer.compare(key, bytes(fromKey)) >= 0 && Buffer.compare(key, bytes(toKey)) < 0)
					yield entry;
			}
			return;
		}
		const selectColumns = options?.overview === true ? overviewEventColumns(journal.dialect) : "*";
		let after: string | undefined;
		let limit = JOURNAL_READ_PAGE_SIZE;
		for (;;) {
			const { page, more, ...next } = await journal.operation(async () => {
				return readSizedPage(
					journal.database,
					journal.tables.eventChunks,
					journal.tables.meta,
					`SELECT ${selectColumns} FROM ${journal.tables.events} WHERE ${c.runId} = ? AND ${c.key} ${after === undefined ? ">=" : ">"} ? AND ${c.key} < ? ORDER BY ${c.key} LIMIT ?`,
					c.key,
					[runId, after ?? fromKey, toKey],
					limit,
				);
			});
			for (const entry of page) {
				journal.assertOpen();
				yield entry;
			}
			journal.assertOpen();
			const last = page.at(-1);
			if (last === undefined || !more) return;
			after = last.key;
			limit = next.limit;
		}
	}

	async deleteRun(runId: string): Promise<void> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(() => this.transaction((tx) => this.deleteRunData(tx, runId)));
	}

	async deleteOwnedRun(lease: Lease, expectSeq?: number): Promise<void> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		return this.operation(() =>
			this.transaction(async (tx) => {
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
		await this.lockLease(tx, runId);
		await this.leaseRow(tx, runId);
		await tx.run(
			`UPDATE ${this.tables.leases} SET ${c.holderId} = ? WHERE ${c.runId} = ?`,
			JOURNAL_LEASE.unheld,
			runId,
		);
		await tx.run(`DELETE FROM ${this.tables.eventChunks} WHERE ${c.runId} = ?`, runId);
		await tx.run(`DELETE FROM ${this.tables.leaseBuilds} WHERE ${c.runId} = ?`, runId);
		await tx.run(`DELETE FROM ${this.tables.events} WHERE ${c.runId} = ?`, runId);
		await tx.run(`DELETE FROM ${this.tables.runs} WHERE ${c.runId} = ?`, runId);
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.closed = true;
			this.closePromise = this.tail.then(async () => (await this.reader)?.close());
		}
		return this.closePromise;
	}
}
