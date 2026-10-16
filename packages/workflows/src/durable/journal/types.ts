import type { WorkflowSerializableValue } from "../../shared/authoring-contract-stage.js";

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
export const RUN_EVENT_TYPES = {
	runStarted: "RunStarted",
	runFinished: "RunFinished",
	statusChanged: "StatusChanged",
	checkpointRecorded: "CheckpointRecorded",
	promptAsked: "PromptAsked",
	promptReleased: "PromptReleased",
	controlRequested: "ControlRequested",
	messageQueued: "MessageQueued",
	messageDelivered: "MessageDelivered",
	messageSettled: "MessageSettled",
	timerScheduled: "TimerScheduled",
	summaryRecorded: "SummaryRecorded",
} as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[keyof typeof RUN_EVENT_TYPES];

export interface RunHeader {
	readonly runId: string;
	readonly name: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly status: string;
	readonly inputs?: WorkflowSerializableValue;
}

export type RunSummary = RunHeader;

type EventOf<Type extends string, Payload = WorkflowSerializableValue> = {
	readonly type: Type;
	readonly payload: Payload;
};

export type RunEvent =
	| EventOf<typeof RUN_EVENT_TYPES.runStarted | typeof RUN_EVENT_TYPES.runFinished>
	| EventOf<
			typeof RUN_EVENT_TYPES.statusChanged,
			{ readonly status: string; readonly [key: string]: WorkflowSerializableValue }
	  >
	| EventOf<
			typeof RUN_EVENT_TYPES.checkpointRecorded,
			{
				readonly kind: "tool" | "ui" | "stage" | "task" | "boundary";
				readonly [key: string]: WorkflowSerializableValue;
			}
	  >
	| EventOf<
			| typeof RUN_EVENT_TYPES.promptAsked
			| typeof RUN_EVENT_TYPES.promptReleased
			| typeof RUN_EVENT_TYPES.controlRequested
	  >
	| EventOf<
			| typeof RUN_EVENT_TYPES.messageQueued
			| typeof RUN_EVENT_TYPES.messageDelivered
			| typeof RUN_EVENT_TYPES.messageSettled
			| typeof RUN_EVENT_TYPES.timerScheduled
			| typeof RUN_EVENT_TYPES.summaryRecorded
	  >;

export interface Lease {
	readonly runId: string;
	readonly holderId: string;
	readonly epoch: number;
}

export type LeaseOutcome =
	| { readonly status: "acquired"; readonly lease: Lease }
	| { readonly status: "held"; readonly holderId: string | null; readonly epoch: number };

export interface JournalEntry {
	readonly runId: string;
	readonly seq: number;
	readonly epoch: number;
	readonly key?: string;
	readonly event: RunEvent;
	readonly at: number;
}

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

export type AppendOutcome = { readonly status: "appended" | "exists"; readonly entry: JournalEntry };

export interface RunJournal {
	createRun(header: RunHeader): Promise<"created" | "exists">;
	listRuns(filter?: { cwd?: string }): Promise<readonly RunSummary[]>;
	acquire(runId: string, holderId: string): Promise<LeaseOutcome>;
	takeover(runId: string, holderId: string, expectedHolder: string): Promise<LeaseOutcome>;
	renew(lease: Lease): Promise<void>;
	release(lease: Lease): Promise<void>;
	append(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }): Promise<AppendOutcome>;
	read(runId: string, fromSeq?: number): AsyncIterable<JournalEntry>;
	readKey(runId: string, key: string): Promise<JournalEntry | undefined>;
	deleteOwnedRun(lease: Lease): Promise<void>;
	deleteRun(runId: string): Promise<void>;
	close(): Promise<void>;
}

export interface SynchronousRunJournal {
	createRunSync(header: RunHeader): "created" | "exists";
	listRunsSync(filter?: { cwd?: string }): readonly RunSummary[];
	acquireSync(runId: string, holderId: string): LeaseOutcome;
	takeoverExpiredSync(runId: string, holderId: string, expiredBefore: number): LeaseOutcome;
	leaseState(runId: string): (Lease & { readonly renewedAt: number }) | undefined;
	renewSync(lease: Lease): void;
	releaseSync(lease: Lease): void;
	appendSync(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }): AppendOutcome;
	readEntries(runId: string, fromSeq?: number): readonly JournalEntry[];
	deleteRunSync(runId: string): void;
}

export class JournalError extends Error {}

export class JournalClosedError extends JournalError {
	constructor() {
		super("Journal is closed");
		this.name = "JournalClosedError";
	}
}

export class JournalConfigurationError extends JournalError {
	readonly source: "settings";
	readonly setting: "workflows.journal";
	readonly reason: "path-and-memory";

	constructor(source: "settings", setting: "workflows.journal", reason: "path-and-memory") {
		super(`Invalid journal configuration at ${source}.${setting}: ${reason}`);
		this.name = "JournalConfigurationError";
		this.source = source;
		this.setting = setting;
		this.reason = reason;
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

export class JournalSchemaVersionError extends JournalError {
	readonly found: number | bigint | string | Uint8Array | null;
	readonly supported: number;

	constructor(found: JournalSchemaVersionError["found"], supported = JOURNAL_SCHEMA_VERSION) {
		super(`Unsupported journal schema version ${String(found)}`);
		this.name = "JournalSchemaVersionError";
		this.found = found;
		this.supported = supported;
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

export class StorageUnavailableError extends JournalError {
	readonly path: string;
	override readonly cause: Error;

	constructor(path: string, cause: Error) {
		super(`Journal storage unavailable: ${path}`, { cause });
		this.name = "StorageUnavailableError";
		this.path = path;
		this.cause = cause;
	}
}
