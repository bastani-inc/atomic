import type { RunEventType } from "@bastani/atomic/storage";
import { StorageSchemaVersionError } from "@bastani/atomic/storage";

export { StorageUnavailableError } from "@bastani/atomic/storage";

export const JOURNAL_SCHEMA_VERSION = 1;
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
	RunSummary,
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

export class StaleLeaseError extends JournalError {
	readonly runId: string;
	readonly heldEpoch: number;
	readonly currentEpoch: number;

	constructor(runId: string, heldEpoch: number, currentEpoch: number) {
		super(`Stale lease for run ${runId}`);
		this.name = "StaleLeaseError";
		this.runId = runId;
		this.heldEpoch = heldEpoch;
		this.currentEpoch = currentEpoch;
	}
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
