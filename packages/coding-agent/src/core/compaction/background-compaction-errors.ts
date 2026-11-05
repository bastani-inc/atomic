/**
 * Typed errors of background compaction (#4330).
 *
 * One family, `BackgroundCompactionError`, with a stable `code` per concrete class. A failure of the
 * background task itself (`planner-failed`, `not-compactable`, `result-persist-failed`) leaves history
 * unchanged and is retried with backoff. A ready result that no longer fits the branch is discarded with
 * `result-discarded`. An invalid setting is `invalid-setting`. Cancellation is never wrapped: an aborted task
 * returns to `idle` without an error.
 */

export type BackgroundCompactionErrorCode =
	| "planner-failed"
	| "not-compactable"
	| "result-persist-failed"
	| "result-discarded"
	| "invalid-setting";

/** The step that was running when the error happened. */
export type BackgroundCompactionPhase = "plan" | "persist" | "commit" | "config";

/** Why a ready result was discarded instead of committed. */
export type BackgroundCompactionDiscardReason = "superseded" | "off-branch" | "context-edited" | "malformed";

/** Why a setting was rejected. */
export type BackgroundCompactionConfigReason = "not-a-boolean" | "not-a-number" | "out-of-range";

/** Where a rejected setting came from. */
export type BackgroundCompactionConfigSource = "settings" | "sdk";

export const BACKGROUND_COMPACTION_ERROR_NAME = "BackgroundCompactionError" as const;

type ErrorFieldValue = string | number | boolean;
export type BackgroundCompactionErrorFields = { readonly [key: string]: ErrorFieldValue };

interface BackgroundCompactionErrorInit {
	readonly code: BackgroundCompactionErrorCode;
	readonly phase: BackgroundCompactionPhase;
	readonly retryable: boolean;
	readonly subject: string;
	readonly hint: string;
	readonly upToEntryId?: string;
}

/** Base class of the family. Catch this to handle every background compaction failure. */
export class BackgroundCompactionError extends Error {
	override readonly name: string = BACKGROUND_COMPACTION_ERROR_NAME;
	readonly code: BackgroundCompactionErrorCode;
	readonly phase: BackgroundCompactionPhase;
	readonly retryable: boolean;
	readonly hint: string;
	/** Last entry of the frozen prefix the task compacted, when one was chosen. */
	readonly upToEntryId: string | undefined;

	constructor(init: BackgroundCompactionErrorInit, options?: ErrorOptions) {
		super(`Background compaction failed: ${init.subject} (${init.code}). ${init.hint}`, options);
		this.code = init.code;
		this.phase = init.phase;
		this.retryable = init.retryable;
		this.hint = init.hint;
		this.upToEntryId = init.upToEntryId;
	}

	/** The JSON-safe fields this class declares, used when the error crosses a process boundary. */
	fields(): BackgroundCompactionErrorFields {
		return this.upToEntryId === undefined ? {} : { upToEntryId: this.upToEntryId };
	}
}

/** The compaction ladder (planner, fallback models, extension hook) failed. Retried with backoff. */
export class BackgroundCompactionPlanningError extends BackgroundCompactionError {
	override readonly name = "BackgroundCompactionPlanningError" as const;
	declare readonly code: "planner-failed";
	declare readonly retryable: true;
	/** One-based attempt number of the failed task. */
	readonly attempt: number;

	constructor(fields: { upToEntryId: string; attempt: number }, options?: ErrorOptions) {
		super(
			{
				code: "planner-failed",
				phase: "plan",
				retryable: true,
				subject: `planning the prefix through entry ${fields.upToEntryId} (attempt ${fields.attempt})`,
				hint: "History is unchanged; Atomic retries with backoff at a later turn boundary. Check the compaction model and its credentials",
				upToEntryId: fields.upToEntryId,
			},
			options,
		);
		this.attempt = fields.attempt;
	}

	override fields(): BackgroundCompactionErrorFields {
		return { ...super.fields(), attempt: this.attempt };
	}
}

/** The frozen prefix has too few compactable lines to plan. Retried with backoff as history grows. */
export class BackgroundCompactionNotCompactableError extends BackgroundCompactionError {
	override readonly name = "BackgroundCompactionNotCompactableError" as const;
	declare readonly code: "not-compactable";
	declare readonly retryable: false;

	constructor(fields: { upToEntryId: string }) {
		super({
			code: "not-compactable",
			phase: "plan",
			retryable: false,
			subject: `the prefix through entry ${fields.upToEntryId} has too few compactable lines`,
			hint: "History is unchanged; Atomic tries again after more turns, and overflow still compacts in the foreground",
			upToEntryId: fields.upToEntryId,
		});
	}
}

/** The ready result could not be saved to session storage. Retried with backoff. */
export class BackgroundCompactionPersistError extends BackgroundCompactionError {
	override readonly name = "BackgroundCompactionPersistError" as const;
	declare readonly code: "result-persist-failed";
	declare readonly retryable: true;

	constructor(fields: { upToEntryId: string }, options?: ErrorOptions) {
		super(
			{
				code: "result-persist-failed",
				phase: "persist",
				retryable: true,
				subject: `saving the result for entry ${fields.upToEntryId}`,
				hint: "History is unchanged; Atomic retries with backoff. Check that session storage is writable",
				upToEntryId: fields.upToEntryId,
			},
			options,
		);
	}
}

/** A ready result no longer fits the current branch and was dropped without changing history. */
export class BackgroundCompactionDiscardedError extends BackgroundCompactionError {
	override readonly name = "BackgroundCompactionDiscardedError" as const;
	declare readonly code: "result-discarded";
	declare readonly retryable: false;
	readonly reason: BackgroundCompactionDiscardReason;

	constructor(fields: {
		upToEntryId: string;
		reason: BackgroundCompactionDiscardReason;
		phase?: "persist" | "commit";
	}) {
		super({
			code: "result-discarded",
			phase: fields.phase ?? "commit",
			retryable: false,
			subject: `the result for entry ${fields.upToEntryId} is ${DISCARD_SUBJECTS[fields.reason]}`,
			hint: "History is unchanged; a later turn compacts the current branch again when it still needs it",
			upToEntryId: fields.upToEntryId,
		});
		this.reason = fields.reason;
	}

	override fields(): BackgroundCompactionErrorFields {
		return { ...super.fields(), reason: this.reason };
	}
}

const DISCARD_SUBJECTS: Readonly<Record<BackgroundCompactionDiscardReason, string>> = {
	superseded: "covered by a newer compaction",
	"off-branch": "no longer on the current branch",
	"context-edited": "out of date after a context edit inside its prefix",
	malformed: "not a valid background compaction record",
};

/** A background compaction setting has an invalid value. */
export class BackgroundCompactionConfigError extends BackgroundCompactionError {
	override readonly name = "BackgroundCompactionConfigError" as const;
	declare readonly code: "invalid-setting";
	declare readonly retryable: false;
	readonly source: BackgroundCompactionConfigSource;
	readonly field: string;
	readonly reason: BackgroundCompactionConfigReason;

	constructor(fields: {
		source: BackgroundCompactionConfigSource;
		field: string;
		reason: BackgroundCompactionConfigReason;
	}) {
		super({
			code: "invalid-setting",
			phase: "config",
			retryable: false,
			subject: `${fields.field} from ${fields.source} is ${CONFIG_SUBJECTS[fields.reason]}`,
			hint: CONFIG_HINTS[fields.reason].replace("{field}", fields.field),
		});
		this.source = fields.source;
		this.field = fields.field;
		this.reason = fields.reason;
	}

	override fields(): BackgroundCompactionErrorFields {
		return { source: this.source, field: this.field, reason: this.reason };
	}
}

const CONFIG_SUBJECTS: Readonly<Record<BackgroundCompactionConfigReason, string>> = {
	"not-a-boolean": "not true or false",
	"not-a-number": "not a finite number",
	"out-of-range": "not above 0 and below 100",
};

const CONFIG_HINTS: Readonly<Record<BackgroundCompactionConfigReason, string>> = {
	"not-a-boolean": "Set {field} to true or false",
	"not-a-number": "Set {field} to a percentage of the context window, for example 75",
	"out-of-range": "Set {field} to a percentage above 0 and below 100, for example 75",
};

const BACKGROUND_COMPACTION_ERROR_CODES: ReadonlySet<string> = new Set<BackgroundCompactionErrorCode>([
	"planner-failed",
	"not-compactable",
	"result-persist-failed",
	"result-discarded",
	"invalid-setting",
]);

const BACKGROUND_COMPACTION_ERROR_NAMES: ReadonlySet<string> = new Set([
	BACKGROUND_COMPACTION_ERROR_NAME,
	"BackgroundCompactionPlanningError",
	"BackgroundCompactionNotCompactableError",
	"BackgroundCompactionPersistError",
	"BackgroundCompactionDiscardedError",
	"BackgroundCompactionConfigError",
]);

/** Cause chains are walked at most this deep. */
export const MAX_BACKGROUND_COMPACTION_CAUSE_DEPTH = 8;

function isStructurally(value: unknown, name?: string): value is BackgroundCompactionError {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { name?: unknown; code?: unknown };
	return (
		typeof candidate.name === "string" &&
		(name === undefined ? BACKGROUND_COMPACTION_ERROR_NAMES.has(candidate.name) : candidate.name === name) &&
		typeof candidate.code === "string" &&
		BACKGROUND_COMPACTION_ERROR_CODES.has(candidate.code)
	);
}

/** Whether `error` is any background compaction error, here or rehydrated from another process. */
export function isBackgroundCompactionError(error: unknown): error is BackgroundCompactionError {
	return error instanceof BackgroundCompactionError || isStructurally(error);
}

export function isBackgroundCompactionPlanningError(error: unknown): error is BackgroundCompactionPlanningError {
	return (
		error instanceof BackgroundCompactionPlanningError || isStructurally(error, "BackgroundCompactionPlanningError")
	);
}

export function isBackgroundCompactionNotCompactableError(
	error: unknown,
): error is BackgroundCompactionNotCompactableError {
	return (
		error instanceof BackgroundCompactionNotCompactableError ||
		isStructurally(error, "BackgroundCompactionNotCompactableError")
	);
}

export function isBackgroundCompactionPersistError(error: unknown): error is BackgroundCompactionPersistError {
	return (
		error instanceof BackgroundCompactionPersistError || isStructurally(error, "BackgroundCompactionPersistError")
	);
}

export function isBackgroundCompactionDiscardedError(error: unknown): error is BackgroundCompactionDiscardedError {
	return (
		error instanceof BackgroundCompactionDiscardedError || isStructurally(error, "BackgroundCompactionDiscardedError")
	);
}

export function isBackgroundCompactionConfigError(error: unknown): error is BackgroundCompactionConfigError {
	return error instanceof BackgroundCompactionConfigError || isStructurally(error, "BackgroundCompactionConfigError");
}

/** Whether any error in the cause chain is a retryable background compaction error. */
export function isRetryableBackgroundCompactionError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_BACKGROUND_COMPACTION_CAUSE_DEPTH && current != null; depth++) {
		if (isBackgroundCompactionError(current) && current.retryable === true) return true;
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
}

/** A background compaction error as it crosses RPC, worker or workflow-status boundaries. */
export interface SerializedBackgroundCompactionError {
	readonly name: string;
	readonly code: BackgroundCompactionErrorCode;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly phase: BackgroundCompactionPhase;
	readonly fields: BackgroundCompactionErrorFields;
	readonly cause?: SerializedErrorCause;
}

/** A cause in a serialized chain: background compaction causes keep their envelope, others keep name and message. */
export type SerializedErrorCause =
	| SerializedBackgroundCompactionError
	| { readonly name: string; readonly message: string; readonly cause?: SerializedErrorCause };

function serializeCause(cause: unknown, depth: number): SerializedErrorCause | undefined {
	if (cause == null || depth >= MAX_BACKGROUND_COMPACTION_CAUSE_DEPTH) return undefined;
	if (isBackgroundCompactionError(cause)) return serializeAt(cause, depth);
	const name = cause instanceof Error ? cause.name : typeof cause;
	const message = cause instanceof Error ? cause.message : String(cause);
	const nested = cause instanceof Error ? serializeCause(cause.cause, depth + 1) : undefined;
	return { name, message, ...(nested === undefined ? {} : { cause: nested }) };
}

function serializeAt(error: BackgroundCompactionError, depth: number): SerializedBackgroundCompactionError {
	const cause = serializeCause(error.cause, depth + 1);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		phase: error.phase,
		fields: typeof error.fields === "function" ? error.fields() : {},
		...(cause === undefined ? {} : { cause }),
	};
}

/** Serialize with a bounded cause chain; never includes stack traces or prompt text. */
export function serializeBackgroundCompactionError(
	error: BackgroundCompactionError,
): SerializedBackgroundCompactionError {
	return serializeAt(error, 0);
}

function isSerializedBackgroundCompactionError(
	value: SerializedErrorCause,
): value is SerializedBackgroundCompactionError {
	return "code" in value && BACKGROUND_COMPACTION_ERROR_CODES.has(value.code);
}

function rehydrateCause(cause: SerializedErrorCause | undefined): Error | undefined {
	if (cause === undefined) return undefined;
	if (isSerializedBackgroundCompactionError(cause)) return rehydrateBackgroundCompactionError(cause);
	const nested = rehydrateCause(cause.cause);
	const error = new Error(cause.message, nested === undefined ? undefined : { cause: nested });
	error.name = cause.name;
	return error;
}

function stringField(fields: BackgroundCompactionErrorFields, key: string): string | undefined {
	const value = fields[key];
	return typeof value === "string" ? value : undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): value is T {
	return value !== undefined && (allowed as readonly string[]).includes(value);
}

/**
 * Rebuild the error class an envelope names. An unknown name, or fields that no longer fit its class,
 * rehydrate into the family base with the original `name` and `code` preserved.
 */
export function rehydrateBackgroundCompactionError(
	serialized: SerializedBackgroundCompactionError,
): BackgroundCompactionError {
	const cause = rehydrateCause(serialized.cause);
	const options = cause === undefined ? undefined : { cause };
	const fields = serialized.fields;
	const upToEntryId = stringField(fields, "upToEntryId");
	const attempt = fields.attempt;
	switch (serialized.name) {
		case "BackgroundCompactionPlanningError":
			if (upToEntryId !== undefined && typeof attempt === "number")
				return new BackgroundCompactionPlanningError({ upToEntryId, attempt }, options);
			break;
		case "BackgroundCompactionNotCompactableError":
			if (upToEntryId !== undefined) return new BackgroundCompactionNotCompactableError({ upToEntryId });
			break;
		case "BackgroundCompactionPersistError":
			if (upToEntryId !== undefined) return new BackgroundCompactionPersistError({ upToEntryId }, options);
			break;
		case "BackgroundCompactionDiscardedError": {
			const reason = stringField(fields, "reason");
			if (upToEntryId !== undefined && oneOf(reason, DISCARD_REASONS)) {
				const phase = serialized.phase === "persist" ? "persist" : "commit";
				return new BackgroundCompactionDiscardedError({ upToEntryId, reason, phase });
			}
			break;
		}
		case "BackgroundCompactionConfigError": {
			const source = stringField(fields, "source");
			const field = stringField(fields, "field");
			const reason = stringField(fields, "reason");
			if (field !== undefined && oneOf(source, CONFIG_SOURCES) && oneOf(reason, CONFIG_REASONS))
				return new BackgroundCompactionConfigError({ source, field, reason });
			break;
		}
	}
	return new RehydratedBackgroundCompactionError(serialized, options);
}

const DISCARD_REASONS: readonly BackgroundCompactionDiscardReason[] = [
	"superseded",
	"off-branch",
	"context-edited",
	"malformed",
];
const CONFIG_SOURCES: readonly BackgroundCompactionConfigSource[] = ["settings", "sdk"];
const CONFIG_REASONS: readonly BackgroundCompactionConfigReason[] = ["not-a-boolean", "not-a-number", "out-of-range"];

/** Family-base fallback for an envelope whose class this process does not know. */
class RehydratedBackgroundCompactionError extends BackgroundCompactionError {
	override readonly name: string;
	readonly #fields: BackgroundCompactionErrorFields;

	constructor(serialized: SerializedBackgroundCompactionError, options?: ErrorOptions) {
		super(
			{
				code: serialized.code,
				phase: serialized.phase,
				retryable: serialized.retryable,
				subject: "",
				hint: serialized.hint,
				...(stringField(serialized.fields, "upToEntryId") === undefined
					? {}
					: { upToEntryId: stringField(serialized.fields, "upToEntryId") }),
			},
			options,
		);
		this.name = serialized.name;
		this.message = serialized.message;
		this.#fields = serialized.fields;
	}

	override fields(): BackgroundCompactionErrorFields {
		return this.#fields;
	}
}
