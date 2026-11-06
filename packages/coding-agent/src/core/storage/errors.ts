import type { SqliteValue, StorageDescriptor } from "./database.js";
import { isSqliteBusy } from "./write-ahead-log.js";

export type StorageFailureCause = object | SqliteValue | boolean | symbol | undefined;

export class StorageError extends Error {
	declare readonly cleanupCause?: StorageFailureCause;
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

export class StorageUnavailableError extends StorageError {
	readonly adapter: string;
	readonly location: string;
	declare readonly cause: StorageFailureCause;
	/**
	 * `detail` names the driver failure in the message: a worker or coordinator that relays only `message` across
	 * a process boundary keeps the reason. Adapters pass it only for causes that cannot carry credentials.
	 */
	constructor(descriptor: StorageDescriptor, cause: StorageFailureCause, detail?: string) {
		super(`Storage unavailable: ${descriptor.adapter} at ${descriptor.location}${detail ? `: ${detail}` : ""}`, {
			cause,
		});
		this.adapter = descriptor.adapter;
		this.location = descriptor.location;
	}
}

export class StoreClosedError extends StorageError {
	readonly adapter: string;
	readonly location: string;
	constructor(descriptor: StorageDescriptor) {
		super(`Storage closed: ${descriptor.adapter} at ${descriptor.location}`);
		this.adapter = descriptor.adapter;
		this.location = descriptor.location;
	}
}

export class StorageTransactionClosedError extends StorageError {
	constructor() {
		super("Storage transaction is closed");
	}
}

export class StorageRollbackError extends StorageError {
	declare readonly cause: StorageFailureCause;
	readonly rollbackCause: StorageFailureCause;
	constructor(cause: StorageFailureCause, rollbackCause: StorageFailureCause) {
		super("Storage rollback failed", { cause });
		this.rollbackCause = rollbackCause;
	}
}

export class StorageInvalidTextError extends StorageError {
	readonly parameterIndex: number;
	readonly reason = "nul-character";
	constructor(parameterIndex: number) {
		super(`Storage parameter ${parameterIndex} contains a NUL character`);
		this.parameterIndex = parameterIndex;
	}
}

export class StorageSchemaVersionError extends StorageError {
	readonly domain: string;
	readonly found: SqliteValue;
	readonly supported: number;
	constructor(domain: string, found: SqliteValue, supported: number) {
		super(`Unsupported ${domain} storage schema version`);
		this.domain = domain;
		this.found = found;
		this.supported = supported;
	}
}

export class StoragePrefixError extends StorageError {
	readonly prefix: string;
	readonly reason: "pattern" | "reserved";
	constructor(prefix: string, reason: "pattern" | "reserved") {
		super(`Invalid storage prefix: ${reason}`);
		this.prefix = prefix;
		this.reason = reason;
	}
}

/** The code of every `StorageConfigError`: an option, flag, variable, or setting has an invalid value. */
export type StorageConfigErrorCode = "invalid-config";

export class StorageConfigError extends StorageError {
	/** {@link TeamProfileConfigError} is the one subclass, with its own name and codes. */
	override readonly name: "StorageConfigError" | "TeamProfileConfigError" = "StorageConfigError";
	readonly code: StorageConfigErrorCode | TeamProfileConfigErrorCode = "invalid-config";
	readonly source: "sdk" | "cli" | "env" | "settings";
	readonly field: string;
	readonly reason: string;
	/** What to change, when the place that rejects the value knows it. */
	declare readonly hint?: string;
	constructor(source: "sdk" | "cli" | "env" | "settings", field: string, reason: string, hint?: string) {
		super(`Invalid storage configuration: ${field} (${reason})${hint === undefined ? "" : `. ${hint}`}`);
		this.source = source;
		this.field = field;
		this.reason = reason;
		if (hint !== undefined) this.hint = hint;
	}
}

export class StorageAdapterLoadError extends StorageError {
	readonly module: string;
	declare readonly cause: StorageFailureCause;
	constructor(module: string, cause: StorageFailureCause) {
		super(`Could not load storage adapter: ${module}`, { cause });
		this.module = module;
	}
}

export class StorageOutcomeUnknownError extends StorageError {
	readonly domain: string;
	readonly id: string;
	readonly key: string;
	constructor(domain: string, id: string, key: string) {
		super(`Storage write outcome unknown: ${domain} ${id}`);
		this.domain = domain;
		this.id = id;
		this.key = key;
	}
}

export class StoragePayloadTooLargeError extends StorageError {
	readonly limitBytes: number;
	readonly actualBytes: number;
	constructor(limitBytes: number, actualBytes: number) {
		super("Storage payload exceeds the backend limit");
		this.limitBytes = limitBytes;
		this.actualBytes = actualBytes;
	}
}

/** An error and its direct cause on one line, for status output (a module-resolution "Require stack" is dropped). */
export function describeStorageError(error: Error | object | string | undefined): string {
	const firstLine = (text: string): string => text.split("\n", 1)[0]!.trim();
	if (!(error instanceof Error)) return firstLine(String(error));
	const message = firstLine(error.message);
	const cause = error.cause instanceof Error ? firstLine(error.cause.message) : undefined;
	return cause === undefined || message.includes(cause) ? message : `${message}: ${cause}`;
}

/** How far guards and the serializer follow `cause`, so a cyclic or very deep chain stays bounded. */
const MAX_STORAGE_CAUSE_DEPTH = 8;

export type StorageWriteLockTimeoutCode = "write-lock-timeout";
/** Where the writer was when it gave up: behind older writers in the queue, or first in line and trying the lock. */
export type StorageWriteLockWaitPhase = "queued" | "acquiring";

export interface StorageWriteLockTimeoutDetails {
	/** The lock wait that ran out: how long the lock may stay held with no other connection committing. */
	readonly timeoutMs: number;
	/** How long the lock had been held with no other connection committing when the writer gave up. */
	readonly elapsedMs: number;
	readonly phase: StorageWriteLockWaitPhase;
	/** The process whose connection took the lock most recently, when its record names one. */
	readonly holderPid?: number;
	/** How long ago that process took the lock. */
	readonly holderHeldMs?: number;
}

const WRITE_LOCK_TIMEOUT_HINT =
	"Another process holds the database's write lock without committing; check that process (it may be stopped or starved of CPU), or pass a longer lockWaitMs. Retrying later is safe";

/**
 * A write transaction gave up waiting for the database's write lock: the lock stayed held for the whole lock wait
 * while no other connection committed. Nothing of the transaction ran. It is a `StorageUnavailableError`, so code
 * that handles an unavailable store keeps handling it, and its message keeps that error's `Storage unavailable:`
 * prefix for relays that forward only the message.
 */
export class StorageWriteLockTimeoutError extends StorageUnavailableError {
	override readonly name = "StorageWriteLockTimeoutError" as const;
	readonly code: StorageWriteLockTimeoutCode = "write-lock-timeout";
	readonly retryable = true as const;
	readonly hint: string = WRITE_LOCK_TIMEOUT_HINT;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly phase: StorageWriteLockWaitPhase;
	declare readonly holderPid?: number;
	declare readonly holderHeldMs?: number;
	constructor(descriptor: StorageDescriptor, details: StorageWriteLockTimeoutDetails, cause?: StorageFailureCause) {
		const heldBy =
			details.holderPid === undefined
				? ""
				: `by process ${details.holderPid}${details.holderHeldMs === undefined ? "" : ` (which took it ${details.holderHeldMs} ms ago)`} `;
		super(
			descriptor,
			cause,
			`database is locked; gave up after ${details.elapsedMs} ms waiting for the write lock${details.phase === "queued" ? " in the writers' queue" : ""}, held all that time ${heldBy}with no other connection committing (write-lock-timeout). ${WRITE_LOCK_TIMEOUT_HINT}`,
		);
		this.timeoutMs = details.timeoutMs;
		this.elapsedMs = details.elapsedMs;
		this.phase = details.phase;
		if (details.holderPid !== undefined) this.holderPid = details.holderPid;
		if (details.holderHeldMs !== undefined) this.holderHeldMs = details.holderHeldMs;
	}
}

export type StorageUnsupportedOperationCode = "unsupported-operation";
/** Operations that only some database handles support. */
const STORAGE_OPERATIONS = ["getWriterQueueStats", "getWriterQueueDegradation"] as const;
export type StorageOperation = (typeof STORAGE_OPERATIONS)[number];

/** The database handle does not support the operation, for example a handle from another adapter. */
export class StorageUnsupportedOperationError extends StorageError {
	override readonly name = "StorageUnsupportedOperationError" as const;
	readonly code: StorageUnsupportedOperationCode = "unsupported-operation";
	readonly operation: StorageOperation;
	readonly adapter: string;
	readonly location: string;
	readonly hint: string;
	constructor(descriptor: StorageDescriptor, operation: StorageOperation) {
		const hint = `Call ${operation} with a database from openNodeSqliteDatabase or wrapNodeSqliteDatabase`;
		super(
			`Unsupported storage operation: ${operation} on ${descriptor.adapter} at ${descriptor.location} (unsupported-operation). ${hint}`,
		);
		this.operation = operation;
		this.adapter = descriptor.adapter;
		this.location = descriptor.location;
		this.hint = hint;
	}
}

export type StorageWriterQueueDegradedCode = "writer-queue-degraded";
const WRITER_QUEUE_DEGRADED_REASONS = [
	"watch-unavailable",
	"wake-failed",
	"stale-ticket-kept",
	"holder-record-unavailable",
] as const;
/**
 * What degraded: `"watch-unavailable"`, a waiting writer cannot watch its release notice and polls instead;
 * `"wake-failed"`, a writer letting go of the lock could not read the queue or notify the next writer;
 * `"stale-ticket-kept"`, a ticket or its notice could not be removed, either when its writer left or after abandonment;
 * `"holder-record-unavailable"`, the connection could not keep its record of holding the write lock, or remove an
 * exited process's.
 */
export type StorageWriterQueueDegradedReason = (typeof WRITER_QUEUE_DEGRADED_REASONS)[number];

const WRITER_QUEUE_DEGRADED_HINTS: Readonly<Record<StorageWriterQueueDegradedReason, string>> = {
	"watch-unavailable":
		"Writers still take the lock in turn but notice a released lock by polling; check file-watch limits (fs.inotify.max_user_instances and max_user_watches on Linux)",
	"wake-failed":
		"Writers still take the lock in turn, but the next writer notices a released lock at its next check instead of at once; make the writers' queue directories next to the database (<file>-writers and <file>-wakes) readable and writable",
	"stale-ticket-kept":
		"An entry or release notice could not be removed from the writers' queue directories next to the database (<file>-writers and <file>-wakes); a remaining live ticket may delay other writers until it becomes stale. Make the directories writable for every writer, or remove abandoned entries by hand",
	"holder-record-unavailable":
		"Writers still take the lock in turn, but a writer that gives up waiting may not name the process holding the lock; make the write-lock records directory next to the database (<file>-holders) readable and writable for every writer",
};

/**
 * Not a failure: a node-sqlite connection fell back from the prompt handoff of the write lock, kept a ticket or
 * notice it could not remove, or could not keep its record of holding the write lock. Transactions keep working. Each reason is recorded once on the connection, readable with
 * `getWriterQueueDegradation`, and emitted once as a process warning (`process.on("warning")`), which Atomic's own
 * processes suppress.
 */
export class StorageWriterQueueDegradedError extends StorageError {
	override readonly name = "StorageWriterQueueDegradedError" as const;
	readonly code: StorageWriterQueueDegradedCode = "writer-queue-degraded";
	readonly reason: StorageWriterQueueDegradedReason;
	readonly adapter: string;
	readonly location: string;
	readonly hint: string;
	declare readonly cause: StorageFailureCause;
	constructor(descriptor: StorageDescriptor, reason: StorageWriterQueueDegradedReason, cause?: StorageFailureCause) {
		const hint = WRITER_QUEUE_DEGRADED_HINTS[reason];
		super(
			`Storage writers' queue degraded: ${descriptor.adapter} at ${descriptor.location} (writer-queue-degraded, ${reason}). ${hint}`,
			{ cause },
		);
		this.hint = hint;
		this.reason = reason;
		this.adapter = descriptor.adapter;
		this.location = descriptor.location;
	}
}

export type StorageWriterQueueUnusableCode = "writer-queue-unusable";

const WRITER_QUEUE_UNUSABLE_HINT =
	"Make the writers' queue directories next to the database (<file>-writers and <file>-wakes) readable and writable for every process that writes the database";

/**
 * A node-sqlite transaction could not use the writers' queue next to the database: it could not read the queue
 * directory, or add, refresh, or read a ticket or its release notice. Nothing of the transaction ran. It is a
 * `StorageUnavailableError`, and its message keeps that error's `Storage unavailable:` prefix.
 */
export class StorageWriterQueueUnusableError extends StorageUnavailableError {
	override readonly name = "StorageWriterQueueUnusableError" as const;
	readonly code: StorageWriterQueueUnusableCode = "writer-queue-unusable";
	readonly hint: string = WRITER_QUEUE_UNUSABLE_HINT;
	/** The filesystem's error code, such as `EACCES`, when the cause has one. */
	declare readonly errno?: string;
	constructor(descriptor: StorageDescriptor, cause: StorageFailureCause) {
		const { code } = (cause ?? {}) as { readonly code?: unknown };
		super(
			descriptor,
			cause,
			`the writers' queue next to the database is unusable: ${cause instanceof Error ? cause.message : String(cause)} (writer-queue-unusable). ${WRITER_QUEUE_UNUSABLE_HINT}`,
		);
		if (typeof code === "string") this.errno = code;
	}
}

export const STORAGE_TRANSIENT_ERROR_CODES = [
	"stream-expired",
	"transaction-timeout",
	"connection-refused",
	"connection-lost",
] as const;
/**
 * Why a call to a database server failed for a while: `"stream-expired"`, the server ended a stream that stayed idle
 * too long, as a stream does whose process was stopped in the middle of a transaction; `"transaction-timeout"`, the
 * server rolled back a transaction that kept the write lock while another writer waited; `"connection-refused"`, no
 * connection to the server could be made; `"connection-lost"`, the connection broke while a request was on its way or
 * being answered.
 */
export type StorageTransientErrorCode = (typeof STORAGE_TRANSIENT_ERROR_CODES)[number];
/**
 * Whether the failed call may have changed the database: `"not-applied"`, it cannot have; `"unknown"`, the connection
 * broke after the server may have applied a write that commits on its own (a commit, a batch, or a statement outside
 * a transaction).
 */
export type StorageTransientOutcome = "not-applied" | "unknown";

export interface StorageTransientErrorDetails {
	readonly code: StorageTransientErrorCode;
	readonly outcome: StorageTransientOutcome;
	/** Which run of the call failed, counting from 1: a call that applied nothing runs again, up to a limit. */
	readonly attempts: number;
}

const TRANSIENT_HINTS: Readonly<Record<StorageTransientOutcome, string>> = {
	"not-applied":
		"Check that the database server is reachable and that this process is not stopped or starved of CPU, then retry; nothing was written",
	unknown:
		"Check that the database server is reachable; the write may have been applied, so read it back before retrying a write that is not idempotent",
};

/**
 * A call to a database server failed for a reason that passes: the server ended an idle stream or a transaction that
 * kept the write lock, or the connection could not be made or broke. `outcome` says whether the call may have written
 * anything. A database from `createSqliteDatabase` runs a call that wrote nothing again before it fails with this
 * error. It is a `StorageUnavailableError`, and its message keeps that error's `Storage unavailable:` prefix.
 */
export class StorageTransientError extends StorageUnavailableError {
	override readonly name = "StorageTransientError" as const;
	readonly code: StorageTransientErrorCode;
	readonly outcome: StorageTransientOutcome;
	readonly attempts: number;
	readonly retryable = true as const;
	readonly hint: string;
	constructor(descriptor: StorageDescriptor, details: StorageTransientErrorDetails, cause?: StorageFailureCause) {
		const hint = TRANSIENT_HINTS[details.outcome];
		super(
			descriptor,
			cause,
			`the database server call failed on attempt ${details.attempts} (${details.code}). ${hint}`,
		);
		this.code = details.code;
		this.outcome = details.outcome;
		this.attempts = details.attempts;
		this.hint = hint;
	}
}

export const SESSION_BLOB_ERROR_CODES = ["blobs-unsupported", "blob-missing", "blob-corrupt"] as const;
/**
 * `"blobs-unsupported"`: the session store cannot hold blobs, and the operation needs it to; nothing was written.
 * `"blob-missing"`: the session holds no blob with the hash a reference names.
 * `"blob-corrupt"`: content carried in an exported session does not have the hash it is recorded under; nothing was
 * written.
 */
export type SessionBlobErrorCode = (typeof SESSION_BLOB_ERROR_CODES)[number];

export interface SessionBlobErrorFields {
	readonly sessionId: string;
	/** The blob's recorded SHA-256, as lowercase hex. */
	readonly hash?: string;
	/** For `"blob-corrupt"`: the SHA-256 of the content that was found instead. */
	readonly actualHash?: string;
	/** For `"blobs-unsupported"`: the adapter of the store that cannot hold blobs. */
	readonly adapter?: string;
}

const SESSION_BLOB_HINTS: Readonly<Record<SessionBlobErrorCode, string>> = {
	"blobs-unsupported":
		"Keep the session in a SQLite or libSQL session store (the default sessions database, --session-store <path>, or a sessions.storage selection), or give a custom store putBlob and getBlob",
	"blob-missing": "The session no longer holds this output; run the tool again to see it",
	"blob-corrupt": "The exported session was changed after it was written; export it again from its source",
};

function sessionBlobSubject(code: SessionBlobErrorCode, fields: SessionBlobErrorFields): string {
	switch (code) {
		case "blobs-unsupported":
			return `Session store cannot hold blobs: ${fields.adapter} store of session ${fields.sessionId}`;
		case "blob-missing":
			return `Session blob not found: ${fields.hash} in session ${fields.sessionId}`;
		case "blob-corrupt":
			return `Session blob does not match its hash: ${fields.hash} in session ${fields.sessionId}`;
	}
}

/**
 * A session blob, the content a session stores apart from its entries (a large tool output), could not be stored,
 * found, or trusted. Never retryable: each code needs a different store, a new tool run, or a new export.
 */
export class SessionBlobError extends StorageError {
	override readonly name = "SessionBlobError" as const;
	readonly code: SessionBlobErrorCode;
	readonly hint: string;
	readonly sessionId: string;
	declare readonly hash?: string;
	declare readonly actualHash?: string;
	declare readonly adapter?: string;
	constructor(code: SessionBlobErrorCode, fields: SessionBlobErrorFields, options?: ErrorOptions) {
		const hint = SESSION_BLOB_HINTS[code];
		super(`${sessionBlobSubject(code, fields)} (${code}). ${hint}`, options);
		this.code = code;
		this.hint = hint;
		this.sessionId = fields.sessionId;
		if (fields.hash !== undefined) this.hash = fields.hash;
		if (fields.actualHash !== undefined) this.actualHash = fields.actualHash;
		if (fields.adapter !== undefined) this.adapter = fields.adapter;
	}
}

/** Every code a storage error that carries one can have. */
export type StorageErrorCode =
	| SessionBlobErrorCode
	| StorageConfigErrorCode
	| StorageWriteLockTimeoutCode
	| StorageUnsupportedOperationCode
	| StorageWriterQueueDegradedCode
	| StorageWriterQueueUnusableCode
	| StorageTransientErrorCode
	| JournalCatalogErrorCode
	| JournalShardUnavailableErrorCode
	| JournalAdoptErrorCode;

function hasNameAndCode(value: unknown, name: string, code: string): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	return candidate.name === name && candidate.code === code;
}

/** A `StorageConfigError`, from this module or another copy of it, or a rehydrated one. */
export function isStorageConfigError(value: unknown): value is StorageConfigError {
	return value instanceof StorageConfigError || hasNameAndCode(value, "StorageConfigError", "invalid-config");
}

export function isStorageWriteLockTimeoutError(value: unknown): value is StorageWriteLockTimeoutError {
	return (
		value instanceof StorageWriteLockTimeoutError ||
		hasNameAndCode(value, "StorageWriteLockTimeoutError", "write-lock-timeout")
	);
}

export function isStorageUnsupportedOperationError(value: unknown): value is StorageUnsupportedOperationError {
	return (
		value instanceof StorageUnsupportedOperationError ||
		hasNameAndCode(value, "StorageUnsupportedOperationError", "unsupported-operation")
	);
}

export function isStorageWriterQueueDegradedError(value: unknown): value is StorageWriterQueueDegradedError {
	return (
		value instanceof StorageWriterQueueDegradedError ||
		hasNameAndCode(value, "StorageWriterQueueDegradedError", "writer-queue-degraded")
	);
}

export function isStorageWriterQueueUnusableError(value: unknown): value is StorageWriterQueueUnusableError {
	return (
		value instanceof StorageWriterQueueUnusableError ||
		hasNameAndCode(value, "StorageWriterQueueUnusableError", "writer-queue-unusable")
	);
}

/** A `StorageTransientError`, from this module or another copy of it, or a rehydrated one. */
export function isStorageTransientError(value: unknown): value is StorageTransientError {
	return (
		value instanceof StorageTransientError || hasCode(value, "StorageTransientError", STORAGE_TRANSIENT_ERROR_CODES)
	);
}

export function isSessionBlobError(value: unknown): value is SessionBlobError {
	return value instanceof SessionBlobError || hasCode(value, "SessionBlobError", SESSION_BLOB_ERROR_CODES);
}

/**
 * Any storage error: an instance of `StorageError` or one of its subclasses, including a rehydrated one, or a copy of
 * a storage error with a stable `code` from another module instance, recognized by its name and code.
 */
export function isStorageError(value: unknown): value is StorageError {
	return (
		value instanceof StorageError ||
		isStorageConfigError(value) ||
		isStorageWriteLockTimeoutError(value) ||
		isStorageUnsupportedOperationError(value) ||
		isStorageWriterQueueDegradedError(value) ||
		isStorageWriterQueueUnusableError(value) ||
		isStorageTransientError(value) ||
		isSessionBlobError(value) ||
		isJournalStoreError(value)
	);
}

function causeOf(value: unknown): unknown {
	return typeof value === "object" && value !== null ? (value as { readonly cause?: unknown }).cause : undefined;
}

/** The write-lock timeout anywhere in an error's cause chain, for failures that wrap it. */
export function findStorageWriteLockTimeoutError(error: unknown): StorageWriteLockTimeoutError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_STORAGE_CAUSE_DEPTH; depth++) {
		if (isStorageWriteLockTimeoutError(current)) return current;
		current = causeOf(current);
	}
	return undefined;
}

/** A JSON-safe fact an error of the journal store carries: an id, a path, a count, a phase. */
export type JournalStoreFieldValue = string | number | boolean | null;
export type JournalStoreFields = Readonly<Record<string, JournalStoreFieldValue>>;

export const JOURNAL_CATALOG_ERROR_CODES = [
	"catalog-unavailable",
	"schema-version",
	"corrupt",
	"write-failed",
	"run-conflict",
	"run-not-found",
	"run-moved",
] as const;
export type JournalCatalogErrorCode = (typeof JOURNAL_CATALOG_ERROR_CODES)[number];

export const JOURNAL_SHARD_UNAVAILABLE_ERROR_CODES = ["shard-missing", "shard-open-failed"] as const;
export type JournalShardUnavailableErrorCode = (typeof JOURNAL_SHARD_UNAVAILABLE_ERROR_CODES)[number];

export const JOURNAL_ADOPT_ERROR_CODES = ["path-not-found", "not-a-journal", "schema-version", "run-conflict"] as const;
export type JournalAdoptErrorCode = (typeof JOURNAL_ADOPT_ERROR_CODES)[number];

/** What a catalog write was doing when it failed. */
export type JournalCatalogPhase =
	| "opening"
	| "placing-run"
	| "recording-status"
	| "removing-run"
	| "registering-shard"
	| "moving-run";

/** Why a path is not an adoptable journal. */
export type JournalAdoptNotJournalReason = "not-sqlite" | "no-journal-tables" | "store-catalog" | "directory";

const MAX_CAUSE_DEPTH = 8;
const DETAIL_LIMIT = 200;

/** The first line of a cause's message, short and free of stack frames, as `StorageUnavailableError` keeps it. */
function causeDetail(cause: StorageFailureCause | Error | undefined): string | null {
	if (!(cause instanceof Error)) return null;
	const nested = cause.cause instanceof Error ? cause.cause.message : "";
	const line = (cause.message.includes(nested) ? cause.message : `${cause.message}: ${nested}`).split("\n", 1)[0]!;
	const trimmed = line.trim();
	if (trimmed === "") return null;
	return trimmed.length > DETAIL_LIMIT ? `${trimmed.slice(0, DETAIL_LIMIT - 1)}…` : trimmed;
}

/** Only a write lock another connection holds is worth retrying; every other storage failure needs a person. */
function busyCause(cause: StorageFailureCause | Error | undefined): boolean {
	return isSqliteBusy(cause) || isRetryableStorageError(cause);
}

interface JournalStoreErrorParts {
	readonly name?: string;
	readonly code: string;
	readonly message: string;
	readonly hint?: string;
	readonly fields: JournalStoreFields;
	readonly retryable: boolean;
	readonly cause?: StorageFailureCause | Error;
}

/**
 * The family of the workflow journal store: its catalog, its shards, and adopting journals into it. Every member
 * carries a stable `code`, JSON-safe `fields`, a `hint` naming what to do next, and `retryable`.
 */
export class JournalStoreError extends StorageError {
	override readonly name: string;
	readonly code: string;
	readonly hint: string | undefined;
	readonly fields: JournalStoreFields;
	readonly retryable: boolean;

	constructor(parts: JournalStoreErrorParts) {
		super(parts.message, parts.cause === undefined ? undefined : { cause: parts.cause });
		this.name = parts.name ?? "JournalStoreError";
		this.code = parts.code;
		this.hint = parts.hint;
		this.fields = Object.freeze({ ...parts.fields });
		this.retryable = parts.retryable;
	}
}

function compact(fields: Readonly<Record<string, JournalStoreFieldValue | undefined>>): JournalStoreFields {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as JournalStoreFields;
}

/** A schema version as a JSON-safe field: a number or null as it is, any other value SQLite stores as its text. */
function schemaVersionField(found: SqliteValue | undefined): string | number | null | undefined {
	return found === undefined || found === null || typeof found === "number" ? found : String(found);
}

export interface JournalCatalogErrorInit {
	readonly code: JournalCatalogErrorCode;
	readonly catalogPath: string;
	readonly phase?: JournalCatalogPhase;
	readonly runId?: string;
	readonly shardId?: number;
	readonly shardPath?: string;
	/** `schema-version`: the version found in the catalog; null when it has none. */
	readonly found?: SqliteValue;
	/** `schema-version`: the version this Atomic supports. */
	readonly supported?: number;
	/** `corrupt`: which consistency rule the catalog breaks. */
	readonly rule?: string;
	/** `run-not-found`: the journal selection searched, as `atomic storage status` describes it. */
	readonly selection?: string;
	/** `run-not-found`: whether this machine's storage is local only, so a run of another machine cannot be here. */
	readonly localOnly?: boolean;
	/** `run-moved`: the last sequence number a read returned before the run moved. */
	readonly lastSeq?: number;
	readonly retryable?: boolean;
	readonly cause?: StorageFailureCause | Error;
}

/** The command that joins this machine to the team's shared storage; error hints across Atomic name it. */
export const SHARED_STORAGE_JOIN_HINT = "atomic team join <url> --token-file <path>";
/** The command that registers an older journal file in the journal store. */
export const JOURNAL_ADOPT_COMMAND = "atomic storage adopt <path>";

function catalogText(init: JournalCatalogErrorInit, detail: string | null): { message: string; hint: string } {
	const subject = init.catalogPath;
	switch (init.code) {
		case "catalog-unavailable":
			return {
				message: `Journal catalog unavailable: ${subject}${detail === null ? "" : ` (${detail})`} (catalog-unavailable).`,
				hint: "Check that the journal directory is readable and writable and the disk has free space, then retry; `atomic storage status` shows the store in use.",
			};
		case "schema-version":
			return {
				message: `Journal catalog schema not supported: ${subject} has version ${String(init.found)}, this Atomic supports ${String(init.supported)} (schema-version).`,
				hint: "Upgrade Atomic to the version that wrote this catalog, or select another journal with workflows.journal.",
			};
		case "corrupt":
			return {
				message: `Journal catalog is inconsistent: ${subject} (${init.rule ?? "unknown rule"}) (corrupt).`,
				hint: `Move ${subject} aside, then adopt every shard file in its directory again with \`atomic storage adopt ${subject.replace(/[\\/][^\\/]*$/, "")}/shard-*.sqlite\` to rebuild it.`,
			};
		case "write-failed":
			return {
				message: `Journal catalog write failed: ${subject} while ${init.phase ?? "writing"}${init.runId === undefined ? "" : ` run ${init.runId}`}${detail === null ? "" : ` (${detail})`} (write-failed).`,
				hint: "Free disk space or release the lock another process holds on the catalog, then retry; checkpoints already written stay on their shard.",
			};
		case "run-conflict":
			return {
				message: `Journal run conflict: run ${init.runId ?? "unknown"} already has a different copy in ${init.shardPath ?? `shard ${String(init.shardId)}`} (run-conflict).`,
				hint: "Compare the two copies and check the catalog's current location before retrying consolidation; both copies are preserved when their histories differ.",
			};
		case "run-moved":
			return {
				message: `Journal run moved while it was read: run ${init.runId ?? "unknown"} left ${init.shardPath ?? `shard ${String(init.shardId)}`} after sequence ${String(init.lastSeq)} and its new shard did not continue the history (run-moved).`,
				hint: "A consolidation moved this run while it was read; read it again.",
			};
		case "run-not-found":
			return {
				message: `Workflow run not found: ${init.runId ?? "unknown"} in ${init.selection ?? subject} (run-not-found).`,
				hint: init.localOnly
					? `This machine uses local-only storage and is not joined to shared storage. If the run started on another machine, join its storage with \`${SHARED_STORAGE_JOIN_HINT}\`; if it is in an older journal file, adopt it with \`${JOURNAL_ADOPT_COMMAND}\`.`
					: "The shared storage selected here does not hold this run; check the run ID with `/workflow status`.",
			};
	}
}

/** The journal catalog, which maps every run to its shard, cannot be opened, read or written. */
export class JournalCatalogError extends JournalStoreError {
	override readonly name = "JournalCatalogError" as const;
	declare readonly code: JournalCatalogErrorCode;
	declare readonly hint: string;
	readonly catalogPath: string;
	readonly phase: JournalCatalogPhase | undefined;
	readonly runId: string | undefined;

	constructor(init: JournalCatalogErrorInit) {
		const detail = causeDetail(init.cause);
		const text = catalogText(init, detail);
		super({
			code: init.code,
			message: text.message,
			hint: text.hint,
			fields: compact({
				catalogPath: init.catalogPath,
				phase: init.phase,
				runId: init.runId,
				shardId: init.shardId,
				shardPath: init.shardPath,
				found: schemaVersionField(init.found),
				supported: init.supported,
				rule: init.rule,
				selection: init.selection,
				localOnly: init.localOnly,
				lastSeq: init.lastSeq,
				detail: detail ?? undefined,
			}),
			retryable: init.retryable ?? (init.code === "run-moved" || busyCause(init.cause)),
			cause: init.cause,
		});
		this.catalogPath = init.catalogPath;
		this.phase = init.phase;
		this.runId = init.runId;
	}
}

export interface JournalShardUnavailableErrorInit {
	readonly code: JournalShardUnavailableErrorCode;
	readonly shardId: number;
	readonly shardPath: string;
	readonly runId?: string;
	readonly retryable?: boolean;
	readonly cause?: StorageFailureCause | Error;
}

/** The shard file that holds a run cannot be opened: it is missing, unreadable, or not a database. */
export class JournalShardUnavailableError extends JournalStoreError {
	override readonly name = "JournalShardUnavailableError" as const;
	declare readonly code: JournalShardUnavailableErrorCode;
	declare readonly hint: string;
	readonly shardId: number;
	readonly shardPath: string;
	readonly runId: string | undefined;

	constructor(init: JournalShardUnavailableErrorInit) {
		const detail = causeDetail(init.cause);
		const subject = `${init.shardPath}${init.runId === undefined ? "" : ` for run ${init.runId}`}`;
		const missing = init.code === "shard-missing";
		super({
			code: init.code,
			message: `Journal shard unavailable: ${subject}${detail === null ? "" : ` (${detail})`} (${init.code}).`,
			hint: missing
				? "Restore the file at this path: the catalog keeps its runs registered there."
				: "Check the file's permissions and the disk's free space, then retry.",
			fields: compact({
				shardId: init.shardId,
				shardPath: init.shardPath,
				runId: init.runId,
				detail: detail ?? undefined,
			}),
			retryable: init.retryable ?? (!missing && busyCause(init.cause)),
			cause: init.cause,
		});
		this.shardId = init.shardId;
		this.shardPath = init.shardPath;
		this.runId = init.runId;
	}
}

export interface JournalAdoptErrorInit {
	readonly code: JournalAdoptErrorCode;
	readonly path: string;
	readonly reason?: JournalAdoptNotJournalReason;
	readonly runId?: string;
	/** `run-conflict`: where the store already has the run. */
	readonly existingPath?: string;
	/** `schema-version`: the version found in the journal; null when it has none. */
	readonly found?: SqliteValue;
	readonly supported?: number;
	readonly cause?: StorageFailureCause | Error;
}

function adoptText(init: JournalAdoptErrorInit): { message: string; hint: string } {
	switch (init.code) {
		case "path-not-found":
			return {
				message: `Cannot adopt journal: ${init.path} does not exist (path-not-found).`,
				hint: "Pass the path of a journal .sqlite file, or of the directory holding its journal.sqlite.",
			};
		case "not-a-journal":
			return {
				message: `Cannot adopt journal: ${init.path} is not a workflow journal (${init.reason ?? "no-journal-tables"}) (not-a-journal).`,
				hint:
					init.reason === "store-catalog"
						? "The journal store's own catalog is never adopted; pass the path of a legacy journal file."
						: "Pass a SQLite file that Atomic wrote workflow runs to, such as a journal.sqlite selected with ATOMIC_WORKFLOW_JOURNAL_PATH.",
			};
		case "schema-version":
			return {
				message: `Cannot adopt journal: ${init.path} has schema version ${String(init.found)}, this Atomic supports ${String(init.supported)} (schema-version).`,
				hint: "Adopt it with the Atomic version that wrote it, or upgrade Atomic.",
			};
		case "run-conflict":
			return {
				message: `Cannot adopt journal: ${init.path} holds run ${init.runId ?? "unknown"}, which the store already has in ${init.existingPath ?? "another journal"} (run-conflict).`,
				hint: "Adopt only one copy of a journal; nothing was registered.",
			};
	}
}

/** A journal file cannot be adopted into the journal store; nothing was registered. */
export class JournalAdoptError extends JournalStoreError {
	override readonly name = "JournalAdoptError" as const;
	declare readonly code: JournalAdoptErrorCode;
	declare readonly hint: string;
	readonly path: string;
	readonly reason: JournalAdoptNotJournalReason | undefined;

	constructor(init: JournalAdoptErrorInit) {
		const text = adoptText(init);
		super({
			code: init.code,
			message: text.message,
			hint: text.hint,
			fields: compact({
				path: init.path,
				reason: init.reason,
				runId: init.runId,
				existingPath: init.existingPath,
				found: schemaVersionField(init.found),
				supported: init.supported,
				detail: causeDetail(init.cause) ?? undefined,
			}),
			retryable: false,
			cause: init.cause,
		});
		this.path = init.path;
		this.reason = init.reason;
	}
}

function hasCode<Code extends string>(value: unknown, name: string, codes: readonly Code[]): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { name?: unknown; code?: unknown };
	return candidate.name === name && codes.includes(candidate.code as Code);
}

const JOURNAL_STORE_ERROR_NAMES: ReadonlySet<unknown> = new Set([
	"JournalStoreError",
	"JournalCatalogError",
	"JournalShardUnavailableError",
	"JournalAdoptError",
]);

/**
 * A journal store error: an instance of `JournalStoreError`, or a copy from another module instance or a process
 * boundary, recognized by the name of one of its classes and the shape every one of them has. An error of another
 * family that happens to carry a `code`, `fields` and `retryable` is not one.
 */
export function isJournalStoreError(value: unknown): value is JournalStoreError {
	if (value instanceof JournalStoreError) return true;
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { name?: unknown; code?: unknown; fields?: unknown; retryable?: unknown };
	return (
		JOURNAL_STORE_ERROR_NAMES.has(candidate.name) &&
		typeof candidate.code === "string" &&
		typeof candidate.retryable === "boolean" &&
		typeof candidate.fields === "object" &&
		candidate.fields !== null
	);
}

export function isJournalCatalogError(value: unknown): value is JournalCatalogError {
	return value instanceof JournalCatalogError || hasCode(value, "JournalCatalogError", JOURNAL_CATALOG_ERROR_CODES);
}

export function isJournalShardUnavailableError(value: unknown): value is JournalShardUnavailableError {
	return (
		value instanceof JournalShardUnavailableError ||
		hasCode(value, "JournalShardUnavailableError", JOURNAL_SHARD_UNAVAILABLE_ERROR_CODES)
	);
}

export function isJournalAdoptError(value: unknown): value is JournalAdoptError {
	return value instanceof JournalAdoptError || hasCode(value, "JournalAdoptError", JOURNAL_ADOPT_ERROR_CODES);
}

/** The first journal store error in `error`'s cause chain, looking at most eight causes deep. */
export function findJournalStoreError(error: unknown): JournalStoreError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (isJournalStoreError(current)) return current;
		if (!(current instanceof Error)) return undefined;
		current = current.cause;
	}
	return undefined;
}

/** Whether a storage error in the cause chain says the operation may succeed if tried again later. */
export function isRetryableStorageError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_STORAGE_CAUSE_DEPTH; depth++) {
		if (isStorageWriteLockTimeoutError(current) && current.retryable === true) return true;
		if (isStorageTransientError(current) && current.retryable === true) return true;
		if (isJournalStoreError(current) && current.retryable) return true;
		current = causeOf(current);
	}
	return false;
}

/** Whether anything in `error`'s cause chain is a journal store error a caller may retry. */
export function isRetryableJournalStoreError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (isJournalStoreError(current) && current.retryable) return true;
		if (!(current instanceof Error)) return false;
		current = current.cause;
	}
	return false;
}

/** A JSON-safe storage error, for sending across a process boundary; `rehydrateStorageError` reverses it. */
export interface SerializedStorageError {
	readonly name: string;
	readonly code?: string;
	readonly message: string;
	readonly hint?: string;
	readonly fields: Readonly<Record<string, string | number | boolean>>;
	readonly cause?: SerializedStorageError;
	/** A `StorageRollbackError`'s failed rollback. */
	readonly rollbackCause?: SerializedStorageError;
	/** A cleanup failure attached to the error it followed. */
	readonly cleanupCause?: SerializedStorageError;
}

/** Own properties carried outside `fields`: `message`, `stack`, and `cause` are not enumerable. */
const STRUCTURAL_KEYS = new Set(["name", "code", "hint"]);

function isFiniteNumber(value: unknown): value is number {
	return Number.isFinite(value);
}

function scalarFields(source: object, keys: readonly string[]): Record<string, string | number | boolean> {
	const fields: Record<string, string | number | boolean> = {};
	for (const key of keys) {
		const value = (source as Record<string, unknown>)[key];
		if (typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value)) fields[key] = value;
	}
	return fields;
}

function serializeFailure(failure: unknown, depth: number): SerializedStorageError {
	if (!(failure instanceof Error)) return { name: "Error", message: String(failure), fields: {} };
	const { code, hint, rollbackCause, cleanupCause } = failure as {
		readonly code?: unknown;
		readonly hint?: unknown;
		readonly rollbackCause?: unknown;
		readonly cleanupCause?: unknown;
	};
	const keys = Object.keys(failure).filter((key) => !STRUCTURAL_KEYS.has(key));
	const nested = (key: "cause" | "rollbackCause" | "cleanupCause", value: unknown) =>
		value !== undefined && depth + 1 < MAX_STORAGE_CAUSE_DEPTH ? { [key]: serializeFailure(value, depth + 1) } : {};
	return {
		name: failure.name,
		...(typeof code === "string" || typeof code === "number" ? { code: String(code) } : {}),
		message: failure.message,
		...(typeof hint === "string" ? { hint } : {}),
		fields: scalarFields(failure, keys),
		...nested("cause", failure.cause),
		...nested("rollbackCause", rollbackCause),
		...nested("cleanupCause", cleanupCause),
	};
}

/**
 * The storage error as `{ name, code, message, hint, fields, cause }`, with its cause chain, a rollback's
 * `rollbackCause`, and an attached `cleanupCause` serialized to a bounded depth. Fields hold only the error's own
 * scalar facts (identifiers, paths, timings, limits), never credentials.
 */
export function serializeStorageError(error: StorageError): SerializedStorageError {
	return serializeFailure(error, 0);
}

function field<T extends string | number | boolean>(
	serialized: SerializedStorageError,
	key: string,
	type: "string" | "number" | "boolean",
): T | undefined {
	const value = serialized.fields[key];
	return typeof value === type ? (value as T) : undefined;
}

function descriptorOf(serialized: SerializedStorageError): StorageDescriptor {
	return {
		adapter: field<string>(serialized, "adapter", "string") ?? "unknown",
		location: field<string>(serialized, "location", "string") ?? "unknown",
	};
}

function nestedFailure(serialized: SerializedStorageError | undefined, depth: number): Error | undefined {
	return serialized === undefined || depth + 1 >= MAX_STORAGE_CAUSE_DEPTH
		? undefined
		: rehydrateFailure(serialized, depth + 1);
}

/** The storage class `serializeStorageError` named, rebuilt from its fields; undefined for a name it does not know. */
function knownStorageError(
	serialized: SerializedStorageError,
	cause: Error | undefined,
	depth: number,
): Error | undefined {
	switch (serialized.name) {
		case "StorageConfigError": {
			const source = field<string>(serialized, "source", "string");
			return new StorageConfigError(
				source === "cli" || source === "env" || source === "settings" ? source : "sdk",
				field<string>(serialized, "field", "string") ?? "",
				field<string>(serialized, "reason", "string") ?? "",
				serialized.hint,
			);
		}
		case "StorageWriteLockTimeoutError":
			return new StorageWriteLockTimeoutError(
				descriptorOf(serialized),
				{
					timeoutMs: field<number>(serialized, "timeoutMs", "number") ?? 0,
					elapsedMs: field<number>(serialized, "elapsedMs", "number") ?? 0,
					phase: field<string>(serialized, "phase", "string") === "queued" ? "queued" : "acquiring",
					holderPid: field<number>(serialized, "holderPid", "number"),
					holderHeldMs: field<number>(serialized, "holderHeldMs", "number"),
				},
				cause,
			);
		case "StorageUnsupportedOperationError": {
			const operation = field<string>(serialized, "operation", "string");
			return new StorageUnsupportedOperationError(
				descriptorOf(serialized),
				STORAGE_OPERATIONS.find((known) => known === operation) ?? STORAGE_OPERATIONS[0],
			);
		}
		case "StorageWriterQueueDegradedError": {
			const reason = field<string>(serialized, "reason", "string");
			return new StorageWriterQueueDegradedError(
				descriptorOf(serialized),
				WRITER_QUEUE_DEGRADED_REASONS.find((known) => known === reason) ?? WRITER_QUEUE_DEGRADED_REASONS[0],
				cause,
			);
		}
		case "StorageWriterQueueUnusableError":
			return new StorageWriterQueueUnusableError(descriptorOf(serialized), cause);
		case "StorageTransientError": {
			const code = STORAGE_TRANSIENT_ERROR_CODES.find((known) => known === serialized.code);
			if (code === undefined) return undefined;
			return new StorageTransientError(
				descriptorOf(serialized),
				{
					code,
					outcome: field<string>(serialized, "outcome", "string") === "not-applied" ? "not-applied" : "unknown",
					attempts: field<number>(serialized, "attempts", "number") ?? 1,
				},
				cause,
			);
		}
		case "SessionBlobError": {
			const code = SESSION_BLOB_ERROR_CODES.find((known) => known === serialized.code);
			if (code === undefined) return undefined;
			return new SessionBlobError(
				code,
				{
					sessionId: field<string>(serialized, "sessionId", "string") ?? "",
					hash: field<string>(serialized, "hash", "string"),
					actualHash: field<string>(serialized, "actualHash", "string"),
					adapter: field<string>(serialized, "adapter", "string"),
				},
				cause === undefined ? undefined : { cause },
			);
		}
		case "StorageUnavailableError":
			return new StorageUnavailableError(descriptorOf(serialized), cause);
		case "StoreClosedError":
			return new StoreClosedError(descriptorOf(serialized));
		case "StorageTransactionClosedError":
			return new StorageTransactionClosedError();
		case "StorageRollbackError":
			return new StorageRollbackError(cause, nestedFailure(serialized.rollbackCause, depth));
		case "StorageInvalidTextError":
			return new StorageInvalidTextError(field<number>(serialized, "parameterIndex", "number") ?? 0);
		case "StorageSchemaVersionError":
			return new StorageSchemaVersionError(
				field<string>(serialized, "domain", "string") ?? "",
				field<string>(serialized, "found", "string") ?? field<number>(serialized, "found", "number") ?? null,
				field<number>(serialized, "supported", "number") ?? 0,
			);
		case "StoragePrefixError":
			return new StoragePrefixError(
				field<string>(serialized, "prefix", "string") ?? "",
				field<string>(serialized, "reason", "string") === "reserved" ? "reserved" : "pattern",
			);
		case "StorageAdapterLoadError":
			return new StorageAdapterLoadError(field<string>(serialized, "module", "string") ?? "", cause);
		case "StorageOutcomeUnknownError":
			return new StorageOutcomeUnknownError(
				field<string>(serialized, "domain", "string") ?? "",
				field<string>(serialized, "id", "string") ?? "",
				field<string>(serialized, "key", "string") ?? "",
			);
		case "StoragePayloadTooLargeError":
			return new StoragePayloadTooLargeError(
				field<number>(serialized, "limitBytes", "number") ?? 0,
				field<number>(serialized, "actualBytes", "number") ?? 0,
			);
	}
	return undefined;
}

function rehydrateFailure(serialized: SerializedStorageError, depth: number): Error {
	const cause = nestedFailure(serialized.cause, depth);
	let error = knownStorageError(serialized, cause, depth);
	if (error === undefined) {
		error =
			depth === 0 || serialized.name.startsWith("Storage")
				? new StorageError(serialized.message, { cause })
				: new Error(serialized.message, { cause });
		Object.assign(error, serialized.fields);
		Object.defineProperty(error, "name", { value: serialized.name });
		if (serialized.code !== undefined)
			Object.defineProperty(error, "code", { value: serialized.code, enumerable: true });
		if (serialized.hint !== undefined)
			Object.defineProperty(error, "hint", { value: serialized.hint, enumerable: true });
	}
	// The sender's message, which may hold detail no field carries (a `StorageUnavailableError`'s driver reason).
	error.message = serialized.message;
	const cleanupCause = nestedFailure(serialized.cleanupCause, depth);
	if (cleanupCause !== undefined) Object.defineProperty(error, "cleanupCause", { value: cleanupCause });
	return error;
}

/**
 * The error `serializeStorageError` produced, as the same class with the same message, fields, and causes, so guards
 * and `instanceof` still match on the other side of a process boundary. A storage error this version does not know
 * becomes a `StorageError` with the original `name`, `code`, and fields; a cause that is not a storage error becomes
 * an `Error` with its name and scalar fields (a driver's `errcode`, say). Only scalar facts travel: a
 * `StorageSchemaVersionError` whose `found` was a bigint or binary value comes back with `found: null`.
 */
export function rehydrateStorageError(serialized: SerializedStorageError): StorageError {
	return rehydrateFailure(serialized, 0) as StorageError;
}

/** Why a team setup operation failed after its inputs were accepted. */
export type TeamProfileErrorCode =
	| "settings-unreadable"
	| "adapter-not-installed"
	| "connection-failed"
	| "connection-timeout"
	| "token-write-failed"
	| "settings-write-failed"
	| "settings-locked"
	| "broker-restart-failed"
	| "token-delete-failed";

/** Which team input was rejected: an SDK option, a CLI argument, or an `ATOMIC_PROFILE` / `ATOMIC_TEAM_*` variable. */
export type TeamProfileConfigErrorCode =
	| "unknown-profile"
	| "incomplete-profile"
	| "missing-url"
	| "unsupported-url"
	| "relative-file-url"
	| "credential-in-url"
	| "missing-token"
	| "conflicting-token"
	| "unreadable-token-file"
	| "relative-token-file"
	| "empty-token"
	| "invalid-prefix"
	| "unknown-command"
	| "unknown-option"
	| "missing-value"
	| "unexpected-argument";

export const TEAM_PROFILE_ERROR_CODES: ReadonlySet<TeamProfileErrorCode> = new Set<TeamProfileErrorCode>([
	"settings-unreadable",
	"adapter-not-installed",
	"connection-failed",
	"connection-timeout",
	"token-write-failed",
	"settings-write-failed",
	"settings-locked",
	"broker-restart-failed",
	"token-delete-failed",
]);

export const TEAM_PROFILE_CONFIG_ERROR_CODES: ReadonlySet<TeamProfileConfigErrorCode> =
	new Set<TeamProfileConfigErrorCode>([
		"unknown-profile",
		"incomplete-profile",
		"missing-url",
		"unsupported-url",
		"relative-file-url",
		"credential-in-url",
		"missing-token",
		"conflicting-token",
		"unreadable-token-file",
		"relative-token-file",
		"empty-token",
		"invalid-prefix",
		"unknown-command",
		"unknown-option",
		"missing-value",
		"unexpected-argument",
	]);

const USAGE_CODES: ReadonlySet<TeamProfileConfigErrorCode> = new Set<TeamProfileConfigErrorCode>([
	"unknown-command",
	"unknown-option",
	"missing-value",
	"unexpected-argument",
]);

const RETRYABLE_CODES: ReadonlySet<TeamProfileErrorCode> = new Set<TeamProfileErrorCode>([
	"connection-failed",
	"connection-timeout",
	"settings-locked",
	"broker-restart-failed",
]);

const SUMMARIES: Readonly<Record<TeamProfileErrorCode, string>> = {
	"settings-unreadable": "Cannot update the global settings",
	"adapter-not-installed": "The libSQL storage adapter is not installed",
	"connection-failed": "Could not connect to the team database",
	"connection-timeout": "The team database did not answer in time",
	"token-write-failed": "Could not store the database token",
	"settings-write-failed": "Could not write the global settings",
	"settings-locked": "Another process is writing the settings",
	"broker-restart-failed": "Could not restart the Intercom broker",
	"token-delete-failed": "Could not delete the token file",
};

/** The facts a {@link TeamProfileError} carries; every field is JSON-safe and holds no credential. */
export interface TeamProfileErrorFields {
	/** What the failure is about: the settings file, the adapter, the database URL, the token file or the agent directory. */
	readonly subject: string;
	readonly hint: string;
	/** A short, credential-free description of the cause. */
	readonly detail?: string;
	readonly cause?: Error;
}

/**
 * The family of team setup failures (`joinTeam`, `leaveTeam`, `getTeamProfile`, `atomic storage join`,
 * `atomic team`) after the inputs were accepted. Branch on `code`, never on the message.
 */
export class TeamProfileError extends StorageError {
	override readonly name: "TeamProfileError" | "TeamProfileTimeoutError" = "TeamProfileError";
	readonly code: TeamProfileErrorCode;
	readonly subject: string;
	readonly hint: string;
	declare readonly detail?: string;
	/** Whether the same call can succeed later without a change on the caller's side. */
	readonly retryable: boolean;

	constructor(code: TeamProfileErrorCode, fields: TeamProfileErrorFields) {
		super(
			`${SUMMARIES[code]}: ${fields.subject} (${code})${fields.detail === undefined ? "" : `: ${fields.detail}`}. ${fields.hint}`,
			fields.cause === undefined ? undefined : { cause: fields.cause },
		);
		this.code = code;
		this.subject = fields.subject;
		this.hint = fields.hint;
		if (fields.detail !== undefined) this.detail = fields.detail;
		this.retryable = RETRYABLE_CODES.has(code);
	}
}

/** What a team operation was doing when it ran out of time. */
export type TeamProfileTimeoutPhase = "connect";

/** A team operation that did not finish in time (`code` `connection-timeout`); retryable. */
export class TeamProfileTimeoutError extends TeamProfileError {
	override readonly name = "TeamProfileTimeoutError" as const;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly phase: TeamProfileTimeoutPhase;

	constructor(
		fields: Omit<TeamProfileErrorFields, "detail" | "cause"> & {
			readonly timeoutMs: number;
			readonly elapsedMs: number;
			readonly phase: TeamProfileTimeoutPhase;
		},
	) {
		super("connection-timeout", {
			subject: fields.subject,
			hint: fields.hint,
			detail: `no answer within ${fields.timeoutMs} ms (${fields.phase})`,
		});
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
		this.phase = fields.phase;
	}
}

export interface TeamProfileConfigErrorFields {
	readonly source: "sdk" | "cli" | "env";
	/** The option, argument or variable, for example `tokenFile`, `--token-file` or `ATOMIC_TEAM_URL`. */
	readonly field: string;
	readonly hint: string;
	/** The token file the input names, when the failure is about that file. */
	readonly path?: string;
	/** `incomplete-profile`: every variable that still has to be set, all reported at once. */
	readonly missing?: readonly string[];
	readonly cause?: Error;
}

/**
 * An invalid team input. It is a {@link StorageConfigError} whose `reason` equals `code`, so hosts that already
 * handle invalid `ATOMIC_STORAGE` values handle an invalid `ATOMIC_PROFILE=ci` setup the same way.
 */
export class TeamProfileConfigError extends StorageConfigError {
	override readonly name = "TeamProfileConfigError" as const;
	declare readonly source: "sdk" | "cli" | "env";
	readonly code: TeamProfileConfigErrorCode;
	readonly hint: string;
	declare readonly path?: string;
	declare readonly missing?: readonly string[];
	readonly retryable = false;

	constructor(code: TeamProfileConfigErrorCode, fields: TeamProfileConfigErrorFields) {
		super(fields.source, fields.field, code);
		this.message = `${USAGE_CODES.has(code) ? "Invalid team command" : "Invalid storage configuration"}: ${fields.field} (${code}). ${fields.hint}`;
		if (fields.cause !== undefined) {
			Object.defineProperty(this, "cause", { value: fields.cause, configurable: true, writable: true });
		}
		this.code = code;
		this.hint = fields.hint;
		if (fields.path !== undefined) this.path = fields.path;
		if (fields.missing !== undefined) this.missing = [...fields.missing];
	}
}

function hasNameAndCodeIn(value: unknown, name: string, codes: ReadonlySet<string>): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	return candidate.name === name && typeof candidate.code === "string" && codes.has(candidate.code);
}

/** Whether `error` is a {@link TeamProfileError}, also across realms and processes (by `name` and `code`). */
export function isTeamProfileError(error: unknown): error is TeamProfileError {
	return (
		error instanceof TeamProfileError ||
		hasNameAndCodeIn(error, "TeamProfileError", TEAM_PROFILE_ERROR_CODES) ||
		isTeamProfileTimeoutError(error)
	);
}

/** Whether `error` is a {@link TeamProfileTimeoutError}, also across realms and processes (by `name` and `code`). */
export function isTeamProfileTimeoutError(error: unknown): error is TeamProfileTimeoutError {
	return (
		error instanceof TeamProfileTimeoutError ||
		hasNameAndCodeIn(error, "TeamProfileTimeoutError", new Set(["connection-timeout"]))
	);
}

/** Whether `error` is a {@link TeamProfileConfigError}, also across realms and processes (by `name` and `code`). */
export function isTeamProfileConfigError(error: unknown): error is TeamProfileConfigError {
	return (
		error instanceof TeamProfileConfigError ||
		hasNameAndCodeIn(error, "TeamProfileConfigError", TEAM_PROFILE_CONFIG_ERROR_CODES)
	);
}

/** Whether `error` or one of its causes, up to eight levels deep, is a retryable {@link TeamProfileError}. */
export function isRetryableTeamProfileError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
		if (isTeamProfileError(current) && current.retryable) return true;
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
}

/**
 * A cause of a serialized team error, at most eight deep. A team error cause, also one from another realm, is
 * serialized like the error itself when its `message`, `hint`, `retryable` and its class's fields all have their
 * documented types, so it rehydrates as its own class and keeps its `retryable`. Its message names files and
 * settings but never their content or a token. Any other cause keeps only its `name` and `code`, and its `message`
 * is that code, or else its name: a parser, driver or file-system message can quote the settings file or the
 * server's answer, so it never crosses a process boundary.
 */
export interface SerializedTeamErrorCause {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly hint?: string;
	readonly fields?: SerializedTeamError["fields"];
	readonly cause?: SerializedTeamErrorCause;
}

/** A {@link TeamProfileError} or {@link TeamProfileConfigError} as JSON, to cross a worker, coordinator or broker boundary. */
export interface SerializedTeamError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	/** The error's own facts: `subject`, `detail`, `timeoutMs`, `elapsedMs`, `phase`, `source`, `field`, `path`, `missing`, `retryable`. */
	readonly fields: Readonly<Record<string, string | number | boolean | readonly string[]>>;
	readonly cause?: SerializedTeamErrorCause;
}

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function safeIdentifier(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : undefined;
}

function isText(value: unknown): value is string {
	return typeof value === "string";
}

function canSerializeTeamCause(cause: unknown): cause is TeamProfileError | TeamProfileConfigError {
	if (!isTeamProfileError(cause) && !isTeamProfileConfigError(cause)) return false;
	const team = cause as unknown as Readonly<Record<string, unknown>>;
	if (!isText(team.message) || !isText(team.hint) || typeof team.retryable !== "boolean") return false;
	if (isTeamProfileConfigError(cause)) {
		return (
			isText(team.source) &&
			isText(team.field) &&
			(team.path === undefined || isText(team.path)) &&
			(team.missing === undefined || (Array.isArray(team.missing) && team.missing.every(isText)))
		);
	}
	if (!isText(team.subject) || (team.detail !== undefined && !isText(team.detail))) return false;
	return (
		!isTeamProfileTimeoutError(cause) ||
		(typeof team.timeoutMs === "number" && typeof team.elapsedMs === "number" && isText(team.phase))
	);
}

function serializeTeamErrorCause(cause: unknown, depth: number): SerializedTeamErrorCause | undefined {
	if (depth >= MAX_CAUSE_DEPTH || cause === undefined || cause === null) return undefined;
	if (canSerializeTeamCause(cause)) return serializeTeam(cause, depth + 1);
	const error = cause instanceof Error ? cause : undefined;
	const name = safeIdentifier(error?.name) ?? "Error";
	const code = safeIdentifier(typeof cause === "object" ? (cause as { readonly code?: unknown }).code : undefined);
	const next = serializeTeamErrorCause(error?.cause, depth + 1);
	return {
		name,
		message: code ?? name,
		...(code === undefined ? {} : { code }),
		...(next === undefined ? {} : { cause: next }),
	};
}

function rehydrateTeamErrorCause(cause: SerializedTeamErrorCause | undefined, depth: number): Error | undefined {
	if (depth >= MAX_CAUSE_DEPTH || cause === undefined) return undefined;
	const { code, hint, fields } = cause;
	if (typeof code === "string" && typeof hint === "string" && typeof fields === "object" && fields !== null) {
		return rehydrateTeam({ ...cause, code, hint, fields }, depth + 1);
	}
	const inner = rehydrateTeamErrorCause(cause.cause, depth + 1);
	const error = new Error(cause.message, inner === undefined ? undefined : { cause: inner });
	error.name = cause.name;
	if (code !== undefined) Object.assign(error, { code });
	return error;
}

function serializeTeam(error: TeamProfileError | TeamProfileConfigError, causeDepth: number): SerializedTeamError {
	const fields: Record<string, string | number | boolean | readonly string[]> = { retryable: error.retryable };
	if (isTeamProfileConfigError(error)) {
		fields.source = error.source;
		fields.field = error.field;
		if (error.path !== undefined) fields.path = error.path;
		if (error.missing !== undefined) fields.missing = [...error.missing];
	} else {
		fields.subject = error.subject;
		if (error.detail !== undefined) fields.detail = error.detail;
		if (isTeamProfileTimeoutError(error)) {
			fields.timeoutMs = error.timeoutMs;
			fields.elapsedMs = error.elapsedMs;
			fields.phase = error.phase;
		}
	}
	const cause = serializeTeamErrorCause(error.cause, causeDepth);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		fields,
		...(cause === undefined ? {} : { cause }),
	};
}

/** The JSON form of a team error, with its cause chain bounded to eight levels; it holds no token. */
export function serializeTeamError(error: TeamProfileError | TeamProfileConfigError): SerializedTeamError {
	return serializeTeam(error, 0);
}

function rehydrateTeam(serialized: SerializedTeamError, causeDepth: number): TeamProfileError | TeamProfileConfigError {
	const { fields } = serialized;
	const text = (key: string): string | undefined =>
		typeof fields[key] === "string" ? (fields[key] as string) : undefined;
	const count = (key: string): number => (typeof fields[key] === "number" ? (fields[key] as number) : 0);
	const cause = rehydrateTeamErrorCause(serialized.cause, causeDepth);
	let error: TeamProfileError | TeamProfileConfigError;
	if (serialized.name === "TeamProfileConfigError") {
		const missing = Array.isArray(fields.missing) ? fields.missing : undefined;
		error = new TeamProfileConfigError(serialized.code as TeamProfileConfigErrorCode, {
			source: text("source") as TeamProfileConfigErrorFields["source"],
			field: text("field") ?? "",
			hint: serialized.hint,
			...(text("path") === undefined ? {} : { path: text("path") }),
			...(missing === undefined ? {} : { missing }),
			...(cause === undefined ? {} : { cause }),
		});
	} else if (serialized.name === "TeamProfileTimeoutError") {
		error = new TeamProfileTimeoutError({
			subject: text("subject") ?? "",
			hint: serialized.hint,
			timeoutMs: count("timeoutMs"),
			elapsedMs: count("elapsedMs"),
			phase: (text("phase") ?? "connect") as TeamProfileTimeoutPhase,
		});
		if (cause !== undefined)
			Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
	} else {
		error = new TeamProfileError(serialized.code as TeamProfileErrorCode, {
			subject: text("subject") ?? "",
			hint: serialized.hint,
			...(text("detail") === undefined ? {} : { detail: text("detail") }),
			...(cause === undefined ? {} : { cause }),
		});
		if (serialized.name !== error.name) Object.defineProperty(error, "name", { value: serialized.name });
	}
	Object.defineProperty(error, "message", { value: serialized.message, configurable: true, writable: true });
	if (typeof fields.retryable === "boolean" && fields.retryable !== error.retryable) {
		Object.defineProperty(error, "retryable", { value: fields.retryable });
	}
	return error;
}

/**
 * The team error a {@link serializeTeamError} result describes, as an instance of its class, so `instanceof`, the
 * guards and `isRetryableTeamProfileError` work on the receiving side. An unknown name becomes a
 * {@link TeamProfileError} that keeps the original `name`, `code` and `retryable`.
 */
export function rehydrateTeamError(serialized: SerializedTeamError): TeamProfileError | TeamProfileConfigError {
	return rehydrateTeam(serialized, 0);
}

/** A cause as it crosses a process boundary: its name, message and code, never its stack. */
export interface SerializedJournalStoreCause {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly cause?: SerializedJournalStoreCause;
}

export interface SerializedJournalStoreError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint?: string;
	readonly retryable: boolean;
	readonly fields: JournalStoreFields;
	readonly cause?: SerializedJournalStoreCause;
}

function serializeCause(cause: unknown, depth: number): SerializedJournalStoreCause | undefined {
	if (depth >= MAX_CAUSE_DEPTH || cause === undefined || cause === null) return undefined;
	if (!(cause instanceof Error)) return { name: "Error", message: String(cause) };
	const code = (cause as { code?: unknown }).code;
	const nested = serializeCause(cause.cause, depth + 1);
	return {
		name: cause.name,
		message: cause.message,
		...(typeof code === "string" ? { code } : {}),
		...(nested === undefined ? {} : { cause: nested }),
	};
}

/** The plain form of a journal store error, for a worker, coordinator or broker message. */
export function serializeJournalStoreError(error: JournalStoreError): SerializedJournalStoreError {
	const cause = serializeCause(error.cause, 0);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		...(error.hint === undefined ? {} : { hint: error.hint }),
		retryable: error.retryable,
		fields: { ...error.fields },
		...(cause === undefined ? {} : { cause }),
	};
}

function rehydrateCause(cause: SerializedJournalStoreCause | undefined): Error | undefined {
	if (cause === undefined) return undefined;
	const nested = rehydrateCause(cause.cause);
	const error = new Error(cause.message, nested === undefined ? undefined : { cause: nested });
	error.name = cause.name;
	if (cause.code !== undefined) Object.defineProperty(error, "code", { value: cause.code, enumerable: true });
	return error;
}

function text(fields: JournalStoreFields, key: string): string | undefined {
	const value = fields[key];
	return typeof value === "string" ? value : undefined;
}

function numeric(fields: JournalStoreFields, key: string): number | undefined {
	const value = fields[key];
	return typeof value === "number" ? value : undefined;
}

function versionField(fields: JournalStoreFields): string | number | null | undefined {
	const value = fields.found;
	return typeof value === "boolean" ? undefined : value;
}

/** Rebuilds the error a process serialized; a name this Atomic does not know becomes the family base, name and code kept. */
export function rehydrateJournalStoreError(serialized: SerializedJournalStoreError): JournalStoreError {
	const error = rebuild(serialized);
	// The message was built from the same fields; keep the sender's text exactly, whatever its cause looked like here.
	error.message = serialized.message;
	return error;
}

function rebuild(serialized: SerializedJournalStoreError): JournalStoreError {
	const { fields } = serialized;
	const cause = rehydrateCause(serialized.cause);
	if (hasCode(serialized, "JournalCatalogError", JOURNAL_CATALOG_ERROR_CODES))
		return new JournalCatalogError({
			code: serialized.code as JournalCatalogErrorCode,
			catalogPath: text(fields, "catalogPath") ?? "",
			phase: text(fields, "phase") as JournalCatalogPhase | undefined,
			runId: text(fields, "runId"),
			shardId: numeric(fields, "shardId"),
			shardPath: text(fields, "shardPath"),
			found: versionField(fields),
			supported: numeric(fields, "supported"),
			rule: text(fields, "rule"),
			selection: text(fields, "selection"),
			localOnly: typeof fields.localOnly === "boolean" ? fields.localOnly : undefined,
			lastSeq: numeric(fields, "lastSeq"),
			retryable: serialized.retryable,
			cause,
		});
	if (hasCode(serialized, "JournalShardUnavailableError", JOURNAL_SHARD_UNAVAILABLE_ERROR_CODES))
		return new JournalShardUnavailableError({
			code: serialized.code as JournalShardUnavailableErrorCode,
			shardId: numeric(fields, "shardId") ?? -1,
			shardPath: text(fields, "shardPath") ?? "",
			runId: text(fields, "runId"),
			retryable: serialized.retryable,
			cause,
		});
	if (hasCode(serialized, "JournalAdoptError", JOURNAL_ADOPT_ERROR_CODES))
		return new JournalAdoptError({
			code: serialized.code as JournalAdoptErrorCode,
			path: text(fields, "path") ?? "",
			reason: text(fields, "reason") as JournalAdoptNotJournalReason | undefined,
			runId: text(fields, "runId"),
			existingPath: text(fields, "existingPath"),
			found: versionField(fields),
			supported: numeric(fields, "supported"),
			cause,
		});
	return new JournalStoreError({
		name: serialized.name,
		code: serialized.code,
		message: serialized.message,
		hint: serialized.hint,
		fields,
		retryable: serialized.retryable,
		cause,
	});
}
