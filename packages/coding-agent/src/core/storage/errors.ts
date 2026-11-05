import type { SqliteValue, StorageDescriptor } from "./database.js";

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
	override readonly name = "StorageConfigError" as const;
	readonly code: StorageConfigErrorCode = "invalid-config";
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
const WRITER_QUEUE_DEGRADED_REASONS = ["watch-unavailable", "wake-failed", "stale-ticket-kept"] as const;
/**
 * What degraded: `"watch-unavailable"`, a waiting writer cannot watch its ticket for release notices and polls
 * instead; `"wake-failed"`, a writer letting go of the lock could not read the queue or notify the next writer;
 * `"stale-ticket-kept"`, a long-abandoned ticket could not be removed and stays in the queue directory, ignored.
 */
export type StorageWriterQueueDegradedReason = (typeof WRITER_QUEUE_DEGRADED_REASONS)[number];

const WRITER_QUEUE_DEGRADED_HINTS: Readonly<Record<StorageWriterQueueDegradedReason, string>> = {
	"watch-unavailable":
		"Writers still take the lock in turn but notice a released lock by polling; check file-watch limits (fs.inotify.max_user_instances and max_user_watches on Linux)",
	"wake-failed":
		"Writers still take the lock in turn, but the next writer notices a released lock at its next check instead of at once; make the writers' queue directory next to the database readable and writable",
	"stale-ticket-kept":
		"Abandoned entries stay in the writers' queue directory next to the database and are ignored; remove them by hand, or make the directory writable for every process that writes the database",
};

/**
 * Not a failure: a node-sqlite connection fell back from the prompt handoff of the write lock, or kept an abandoned
 * ticket it could not remove. Transactions keep working. Each reason is recorded once on the connection, readable with
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
	"Make the writers' queue directory next to the database (<file>-writers) readable and writable for every process that writes the database";

/**
 * A node-sqlite transaction could not use the writers' queue next to the database: it could not read the queue
 * directory, or add, refresh, or read a ticket in it. Nothing of the transaction ran. It is a
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

/** Every code a storage error that carries one can have. */
export type StorageErrorCode =
	| StorageConfigErrorCode
	| StorageWriteLockTimeoutCode
	| StorageUnsupportedOperationCode
	| StorageWriterQueueDegradedCode
	| StorageWriterQueueUnusableCode;

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

/** Whether a storage error in the cause chain says the operation may succeed if tried again later. */
export function isRetryableStorageError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_STORAGE_CAUSE_DEPTH; depth++) {
		if (isStorageWriteLockTimeoutError(current) && current.retryable === true) return true;
		current = causeOf(current);
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
