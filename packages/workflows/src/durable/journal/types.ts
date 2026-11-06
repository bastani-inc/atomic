import type { RunEventType } from "@bastani/atomic/storage";
import { RUN_JOURNAL_SCHEMA_VERSION, StorageSchemaVersionError } from "@bastani/atomic/storage";

export { StorageUnavailableError } from "@bastani/atomic/storage";

export const JOURNAL_SCHEMA_VERSION = RUN_JOURNAL_SCHEMA_VERSION;
export type JournalSchemaVersion = typeof JOURNAL_SCHEMA_VERSION;
export const JOURNAL_PAYLOAD_ENCODING = "json-text";
export type JournalPayloadEncoding = typeof JOURNAL_PAYLOAD_ENCODING;
export const JOURNAL_TABLES = { meta: "meta", runs: "runs", events: "events", leases: "leases" } as const;
export type JournalTable = (typeof JOURNAL_TABLES)[keyof typeof JOURNAL_TABLES];
export const JOURNAL_COLUMNS = {
	schemaVersion: "schema_version",
	runId: "run_id",
	name: "name",
	cwd: "cwd",
	createdAt: "created_at",
	status: "status",
	headerJson: "header_json",
	seq: "seq",
	epoch: "epoch",
	key: "key",
	type: "type",
	payload: "payload",
	at: "at",
	holderId: "holder_id",
	renewedAt: "renewed_at",
} as const;
export type JournalColumn = (typeof JOURNAL_COLUMNS)[keyof typeof JOURNAL_COLUMNS];
export const JOURNAL_LEASE = { initialEpoch: 1, epochIncrement: 1, unheld: null, absentEpoch: 0 } as const;
export type JournalLeaseSemantics = typeof JOURNAL_LEASE;
export type {
	AppendOutcome,
	JournalEntry,
	Lease,
	LeaseOutcome,
	LeaseState,
	RunEvent,
	RunEventType,
	RunHeader,
	RunJournal,
	RunJournalBatchAppend,
	RunJournalSeedEvent,
	RunSnapshotTail,
	RunSummary,
	RunVersion,
} from "@bastani/atomic/storage";
export { RUN_EVENT_TYPES } from "@bastani/atomic/storage";

export interface JournalLeaseRow {
	[JOURNAL_COLUMNS.holderId]: string | null;
	[JOURNAL_COLUMNS.epoch]: number;
}

export interface JournalEventRow {
	[JOURNAL_COLUMNS.runId]: string;
	[JOURNAL_COLUMNS.seq]: number;
	[JOURNAL_COLUMNS.epoch]: number;
	[JOURNAL_COLUMNS.key]: string | null;
	[JOURNAL_COLUMNS.type]: RunEventType;
	[JOURNAL_COLUMNS.payload]: string;
	[JOURNAL_COLUMNS.at]: number;
}

export class JournalError extends Error {}

export class JournalClosedError extends JournalError {
	constructor() {
		super("Journal is closed");
		this.name = "JournalClosedError";
	}
}

export class JournalInvalidTextError extends JournalError {
	readonly field: "runId" | "holderId" | "expectedHolder" | "key" | "status" | "name" | "cwd";
	readonly reason: "nul-character" | "ill-formed-unicode";

	constructor(field: JournalInvalidTextError["field"], reason: JournalInvalidTextError["reason"]) {
		super(`Invalid journal ${field}: ${reason}`);
		this.name = "JournalInvalidTextError";
		this.field = field;
		this.reason = reason;
	}
}

export class JournalMetaCorruptError extends JournalError {
	readonly path: string;
	readonly rowCount: number;

	constructor(path: string, rowCount: number) {
		super(`Journal metadata at ${path} has ${rowCount} rows`);
		this.name = "JournalMetaCorruptError";
		this.path = path;
		this.rowCount = rowCount;
	}
}

export class JournalCounterRangeError extends JournalError {
	readonly runId: string;
	readonly field: "seq" | "epoch";
	readonly value: number;
	readonly reason: "overflow" | "negative" | "unsafe-integer";

	constructor(
		runId: string,
		field: JournalCounterRangeError["field"],
		value: number,
		reason: JournalCounterRangeError["reason"],
	) {
		super(`Unsafe journal ${field} counter for run ${runId}: ${value}`);
		this.name = "JournalCounterRangeError";
		this.runId = runId;
		this.field = field;
		this.value = value;
		this.reason = reason;
	}
}

const STALE_LEASE_HINT =
	"Another holder owns the run's journal lease now, or it was released; stop writing under this lease and resume the run to take it again.";

/**
 * A write or renewal under a run's journal lease that no longer holds it: another holder or epoch took it, or it was
 * released. Nothing was written; stop writing under that lease.
 */
export class StaleLeaseError extends JournalError {
	override readonly name = "StaleLeaseError" as const;
	readonly code = "stale_lease" as const;
	readonly retryable = false as const;
	readonly hint = STALE_LEASE_HINT;
	readonly runId: string;
	readonly heldEpoch: number;
	readonly currentEpoch: number;

	constructor(runId: string, heldEpoch: number, currentEpoch: number, options?: ErrorOptions) {
		super(
			`Stale lease for run ${runId}: held epoch ${heldEpoch}, current epoch ${currentEpoch} (stale_lease). ${STALE_LEASE_HINT}`,
			options,
		);
		this.runId = runId;
		this.heldEpoch = heldEpoch;
		this.currentEpoch = currentEpoch;
	}
}

export function isStaleLeaseError(value: unknown): value is StaleLeaseError {
	if (value instanceof StaleLeaseError) return true;
	if (typeof value !== "object" || value === null) return false;
	const { name, code } = value as { readonly name?: unknown; readonly code?: unknown };
	return name === "StaleLeaseError" && code === "stale_lease";
}

/** Why a pool delivery receipt was refused before it reached the root's journal. */
export type PoolAppendRefusedReason = "foreign-root" | "coordinator-authority" | "attempt-refused";

export interface PoolAppendRefusedFields {
	readonly root: string;
	readonly workId: string;
	readonly generation: number;
	readonly reason: PoolAppendRefusedReason;
}

const POOL_APPEND_REFUSED_HINT =
	"The receipt was not written; the stage's undelivered messages stay queued for its current attempt.";

/**
 * A pool delivery receipt refused because its attempt no longer owns the work or the stage session (`cause` says
 * which), or the pool lost its coordinator authority. It is a journal error, so the root's journal backend passes it
 * on instead of reporting the refusal as unavailable storage. Nothing was written.
 */
export class PoolAppendRefusedError extends JournalError {
	override readonly name = "PoolAppendRefusedError" as const;
	readonly code = "pool_append_refused" as const;
	readonly retryable = false as const;
	readonly hint = POOL_APPEND_REFUSED_HINT;
	readonly root: string;
	readonly workId: string;
	readonly generation: number;
	readonly reason: PoolAppendRefusedReason;

	constructor(fields: PoolAppendRefusedFields, options?: ErrorOptions) {
		super(
			`Pool delivery receipt refused (${fields.reason}): work ${fields.workId} generation ${fields.generation} of root ${fields.root} (pool_append_refused). ${POOL_APPEND_REFUSED_HINT}`,
			options,
		);
		this.root = fields.root;
		this.workId = fields.workId;
		this.generation = fields.generation;
		this.reason = fields.reason;
	}
}

export function isPoolAppendRefusedError(value: unknown): value is PoolAppendRefusedError {
	if (value instanceof PoolAppendRefusedError) return true;
	if (typeof value !== "object" || value === null) return false;
	const { name, code } = value as { readonly name?: unknown; readonly code?: unknown };
	return name === "PoolAppendRefusedError" && code === "pool_append_refused";
}

export class JournalCasConflictError extends JournalError {
	readonly runId: string;
	readonly expectedSeq: number;
	readonly actualSeq: number;

	constructor(runId: string, expectedSeq: number, actualSeq: number) {
		super(`Journal sequence conflict for run ${runId}`);
		this.name = "JournalCasConflictError";
		this.runId = runId;
		this.expectedSeq = expectedSeq;
		this.actualSeq = actualSeq;
	}
}

export class JournalSchemaVersionError extends StorageSchemaVersionError {
	constructor(found: StorageSchemaVersionError["found"], supported = JOURNAL_SCHEMA_VERSION) {
		super("journal", found, supported);
		this.name = "JournalSchemaVersionError";
	}
}

export class RunNotFoundError extends JournalError {
	readonly runId: string;

	constructor(runId: string) {
		super(`Run not found: ${runId}`);
		this.name = "RunNotFoundError";
		this.runId = runId;
	}
}
