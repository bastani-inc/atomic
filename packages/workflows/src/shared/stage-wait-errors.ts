import type { WorkflowSerializableObject } from "./authoring-contract-stage.js";

/** Why a stage waits with its session released. Codes are public API: never rename or reuse one. */
export type StageWaitErrorCode =
	| "invalid-release-when-waiting"
	| "stage-busy"
	| "not-reopenable"
	| StageRehydrationErrorCode
	| "wait-record-unavailable"
	| StageWakeErrorCode;

/** The codes a {@link StageRehydrationError} carries. */
export type StageRehydrationErrorCode = "session-unavailable" | "session-not-found" | "results-not-saved";

/** The codes a {@link StageWakeError} carries. */
export type StageWakeErrorCode = "unknown-wake-kind" | StageWakeRegistrationErrorCode;

/** The codes `registerStageWakeKind` refuses a registration with, before it registers anything. */
export type StageWakeRegistrationErrorCode = "builtin-kind-handler" | "invalid-wake-kind" | "invalid-wake-handler";

/** Where a rejected `releaseWhenWaiting` value or wake registration came from. */
export type StageWaitConfigSource = "sdk";

/**
 * What a waiting stage was doing when it failed: reopening its session, having the reopened session save the results
 * its turn continues from (`resume-turn`), or writing one of its wait records.
 */
export type StageWaitPhase = "reopen" | "resume-turn" | StageWaitRecordPhase;

/** The durable records of a waiting stage: the start of its wait, the results it waited for, and its end. */
export type StageWaitRecordPhase = "wait-start" | "wait-results" | "wait-end";

const FAMILY_NAMES = [
	"StageWaitError",
	"StageWaitConfigError",
	"StageReleaseError",
	"StageRehydrationError",
	"StageWaitRecordError",
	"StageWakeError",
] as const;
type StageWaitErrorName = (typeof FAMILY_NAMES)[number];

const CODES: ReadonlySet<string> = new Set<StageWaitErrorCode>([
	"invalid-release-when-waiting",
	"stage-busy",
	"not-reopenable",
	"session-unavailable",
	"session-not-found",
	"results-not-saved",
	"wait-record-unavailable",
	"unknown-wake-kind",
	"builtin-kind-handler",
	"invalid-wake-kind",
	"invalid-wake-handler",
]);

const REHYDRATION_CODES: ReadonlySet<string> = new Set<StageRehydrationErrorCode>([
	"session-unavailable",
	"session-not-found",
	"results-not-saved",
]);

const MAX_CAUSE_DEPTH = 8;

/** JSON-safe facts a {@link StageWaitError} carries. Never contains prompt text, transcripts or credentials. */
export interface StageWaitErrorFields extends WorkflowSerializableObject {
	readonly runId?: string;
	readonly stageId?: string;
	readonly stageName?: string;
	readonly sessionId?: string;
	/** Every session a resume could not find in the session store (`session-not-found`). */
	readonly sessionIds?: readonly string[];
	/** The tool calls whose results the reopened session returned without saving (`results-not-saved`). */
	readonly toolCallIds?: readonly string[];
	/**
	 * The session storage the run was started with (`session-not-found`): the setting, flag or variable that selected
	 * it, or a credential-free description such as a file path. Never the selection's JSON or a secret.
	 */
	readonly storage?: string;
	/** The stage status that refused the operation. */
	readonly status?: string;
	readonly source?: StageWaitConfigSource;
	/** The rejected option or argument, for example `releaseWhenWaiting.afterMs` or `handler`. */
	readonly field?: string;
	/** The rejected value, as text. */
	readonly value?: string;
	/** The wake kind nobody registered (`unknown-wake-kind`), or whose registration was refused. */
	readonly kind?: string;
	/** What the stage was doing when it failed. */
	readonly phase?: StageWaitPhase;
	/** How many times the stage tried before it gave up. */
	readonly attempts?: number;
	/** How long the attempts took, in milliseconds, the waits between them included. */
	readonly elapsedMs?: number;
	/** The most the attempts wait between them in total, in milliseconds: the retry's backoff budget. */
	readonly timeoutMs?: number;
}

/** The serialized form of a {@link StageWaitError}, for crossing a worker or IPC boundary. */
export interface SerializedStageWaitError extends WorkflowSerializableObject {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: StageWaitErrorFields;
	readonly cause?: SerializedErrorCause;
}

/** A bounded, credential-free description of a wrapped cause. */
export interface SerializedErrorCause extends WorkflowSerializableObject {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly cause?: SerializedErrorCause;
}

const HINTS: Readonly<
	Record<Exclude<StageWaitErrorCode, "session-not-found" | "results-not-saved" | "builtin-kind-handler">, string>
> = {
	"invalid-release-when-waiting":
		"Set releaseWhenWaiting to true, false, or { afterMs } with a number of milliseconds from 0 to 2147483647 (MAX_RELEASE_WHEN_WAITING_AFTER_MS, about 24.8 days); use false to keep the stage resident.",
	"stage-busy": "Wait for the stage's prompt to finish before releasing it.",
	"not-reopenable":
		"Give the stage a persistent session store (the default store, sessionDir, or a caller-owned sessionStore) so it can be reopened.",
	"session-unavailable": "Check that the stage's session store is reachable, then resume the workflow.",
	"wait-record-unavailable":
		"The stage carries on. Until its next record is written, a resume after a restart starts the stage from its previous record, which may run a finished tool call again; check that the run's journal storage is reachable.",
	"unknown-wake-kind":
		"Register the kind with registerStageWakeKind in the process that runs the stage before delivering messages of it.",
	"invalid-wake-kind":
		'Pass registerStageWakeKind the kind as a non-empty string, declared in StageWakeKinds by augmenting "@bastani/atomic/workflows".',
	"invalid-wake-handler":
		"Pass registerStageWakeKind a function as the handler, or no handler to queue messages of the kind for the stage's next wait of that kind.",
};

const STORAGE_SELECTORS =
	"--storage, ATOMIC_SESSIONS_STORAGE or ATOMIC_STORAGE, the sessions.storage setting, or the SDK sessionStore option";

function recordOf(phase: StageWaitPhase | undefined, stage: string): string {
	switch (phase) {
		case "wait-start":
			return `the start of the wait of ${stage}`;
		case "wait-results":
			return `the results ${stage} was woken with`;
		case "wait-end":
			return `the end of the wait of ${stage}`;
		default:
			return `the wait of ${stage}`;
	}
}

function hintFor(code: StageWaitErrorCode, fields: StageWaitErrorFields): string {
	if (code === "builtin-kind-handler")
		return `Register "${fields.kind ?? "tool-results"}" without a handler: the runtime delivers it only to a stage that waits for it.`;
	if (code === "results-not-saved")
		return `Resume the run with /workflow resume ${fields.runId ?? "<runId>"}: the stage continues its turn from the results it recorded with its wait, which stay recorded until a turn that uses them is saved.`;
	if (code !== "session-not-found") return HINTS[code];
	const storage = fields.storage === undefined ? "" : ` (${fields.storage})`;
	return `Resume the run with the session storage it was started with${storage} selected through ${STORAGE_SELECTORS}. Run "atomic storage status" to see which session storage this process selects.`;
}

function afterAttempts(fields: StageWaitErrorFields): string {
	if (fields.attempts === undefined) return "";
	return ` after ${fields.attempts} ${fields.attempts === 1 ? "attempt" : "attempts"}`;
}

function subject(code: StageWaitErrorCode, fields: StageWaitErrorFields): string {
	const stage = `stage "${fields.stageName ?? fields.stageId ?? "unknown"}"`;
	switch (code) {
		case "invalid-release-when-waiting":
			return `Invalid ${fields.field ?? "releaseWhenWaiting"} for ${fields.stageName === undefined ? "the run" : stage}: ${fields.value}`;
		case "stage-busy":
			return `Cannot release ${stage} while its prompt is running`;
		case "not-reopenable":
			return `Cannot release ${stage}: its session cannot be reopened from a store`;
		case "session-unavailable":
			return fields.phase === "resume-turn"
				? `Cannot rehydrate ${stage}: session ${fields.sessionId ?? "unknown"} could not save the results the stage was woken with${afterAttempts(fields)}`
				: `Cannot rehydrate ${stage}: session ${fields.sessionId ?? "unknown"} could not be reopened${afterAttempts(fields)}`;
		case "session-not-found": {
			const ids = fields.sessionIds ?? (fields.sessionId === undefined ? [] : [fields.sessionId]);
			const sessions =
				ids.length === 0
					? "its sessions are"
					: `${ids.length === 1 ? "session" : "sessions"} ${ids.join(", ")} ${ids.length === 1 ? "is" : "are"}`;
			const owner =
				fields.stageName !== undefined || fields.stageId !== undefined
					? stage
					: `the waiting stages of run ${fields.runId ?? "unknown"}`;
			return `Cannot rehydrate ${owner}: ${sessions} not in the session store`;
		}
		case "results-not-saved": {
			const calls = fields.toolCallIds ?? [];
			return `Cannot rehydrate ${stage}: session ${fields.sessionId ?? "unknown"} returned from its detached turn without saving the results of ${calls.length === 0 ? "its calls" : calls.join(", ")}`;
		}
		case "wait-record-unavailable":
			return `Cannot durably record ${recordOf(fields.phase, stage)}${afterAttempts(fields)}`;
		case "unknown-wake-kind":
			return `Cannot deliver a "${fields.kind ?? "unknown"}" wake to ${stage}${fields.runId === undefined ? "" : ` of run ${fields.runId}`}: no module registered that kind`;
		case "builtin-kind-handler":
			return `Cannot register a handler for the built-in stage wake kind "${fields.kind ?? "unknown"}"`;
		case "invalid-wake-kind":
			return `Invalid stage wake kind passed to registerStageWakeKind: ${fields.value}`;
		case "invalid-wake-handler":
			return `Invalid handler passed to registerStageWakeKind for the wake kind "${fields.kind ?? "unknown"}": ${fields.value}`;
	}
}

/**
 * Family base of the errors around stages that wait with their session released (`releaseWhenWaiting`,
 * `stage.release()`, `stage.rehydrate()`). Catch this class, or branch on `code`.
 */
export class StageWaitError extends Error {
	override readonly name: StageWaitErrorName = "StageWaitError";
	readonly code: StageWaitErrorCode;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: StageWaitErrorFields;

	constructor(
		code: StageWaitErrorCode,
		fields: StageWaitErrorFields,
		options?: ErrorOptions & { retryable?: boolean },
	) {
		const hint = hintFor(code, fields);
		super(`${subject(code, fields)} (${code}). ${hint}`, options);
		this.code = code;
		this.hint = hint;
		this.retryable = options?.retryable === true;
		this.fields = fields;
	}

	toJSON(): SerializedStageWaitError {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			hint: this.hint,
			retryable: this.retryable,
			fields: this.fields,
			...(this.cause === undefined ? {} : { cause: serializeCause(this.cause, 0) }),
		};
	}
}

/** A `releaseWhenWaiting` value was rejected where it entered the SDK, before any stage started. */
export class StageWaitConfigError extends StageWaitError {
	override readonly name = "StageWaitConfigError";
	declare readonly code: "invalid-release-when-waiting";
	constructor(fields: StageWaitErrorFields & { readonly source: StageWaitConfigSource; readonly field: string }) {
		super("invalid-release-when-waiting", fields);
	}
}

/** `stage.release()` was refused; the stage and its session are unchanged. */
export class StageReleaseError extends StageWaitError {
	override readonly name = "StageReleaseError";
	declare readonly code: "stage-busy" | "not-reopenable";
	constructor(code: "stage-busy" | "not-reopenable", fields: StageWaitErrorFields) {
		super(code, fields);
	}
}

/**
 * A released stage could not reopen its session from the store. `session-unavailable` (retryable): the store stayed
 * unreachable through every attempt, and the cause is its last failure; `fields` say how many attempts were made, how
 * long they took and the retry's backoff budget. `phase` is `reopen` when the session could not be reopened, and
 * `resume-turn` when the reopened session could not save the results the stage was woken with. The run blocks
 * resumably on it, keeping those results. `session-not-found` (not retryable): the store answered, but does not hold
 * the session; `fields.sessionIds` lists every missing session and `fields.storage` the storage the run was started
 * with. `results-not-saved` (not retryable, `phase: "resume-turn"`): the reopened session returned from the turn the
 * results continue without saving the results of `fields.toolCallIds`; the stage fails rather than completing on a turn
 * still waiting on a call, and the run stays resumable with the results its wait recorded.
 */
export class StageRehydrationError extends StageWaitError {
	override readonly name = "StageRehydrationError";
	declare readonly code: StageRehydrationErrorCode;
	constructor(fields: StageWaitErrorFields, options?: ErrorOptions & { code?: StageRehydrationErrorCode }) {
		const code = options?.code ?? "session-unavailable";
		super(code, fields, {
			...(options?.cause === undefined ? {} : { cause: options.cause }),
			retryable: code === "session-unavailable",
		});
	}
}

/**
 * A waiting stage could not write one of its durable records (`phase`) after every attempt. It is never thrown: the
 * stage carries on, and its snapshot carries the error as `waitRecordFailure`.
 */
export class StageWaitRecordError extends StageWaitError {
	override readonly name = "StageWaitRecordError";
	declare readonly code: "wait-record-unavailable";
	constructor(fields: StageWaitErrorFields & { readonly phase: StageWaitRecordPhase }, options?: ErrorOptions) {
		super("wait-record-unavailable", fields, options);
	}
}

/**
 * A stage wake was refused. `unknown-wake-kind`: a wake was delivered with a kind no module registered with
 * `registerStageWakeKind`; nothing was queued. `builtin-kind-handler`, `invalid-wake-kind`, `invalid-wake-handler`:
 * `registerStageWakeKind` refused its arguments (`source: "sdk"`, `field`), and registered nothing.
 */
export class StageWakeError extends StageWaitError {
	override readonly name = "StageWakeError";
	declare readonly code: StageWakeErrorCode;
	constructor(
		fields: StageWaitErrorFields & { readonly runId: string; readonly stageId: string; readonly kind: string },
	);
	constructor(
		fields: StageWaitErrorFields & { readonly source: StageWaitConfigSource; readonly field: "kind" | "handler" },
		options: { readonly code: StageWakeRegistrationErrorCode },
	);
	constructor(fields: StageWaitErrorFields, options?: { readonly code: StageWakeRegistrationErrorCode }) {
		super(options?.code ?? "unknown-wake-kind", fields);
	}
}

function serializeCause(cause: unknown, depth: number): SerializedErrorCause {
	if (!(cause instanceof Error) || depth >= MAX_CAUSE_DEPTH)
		return { name: "Error", message: cause instanceof Error ? cause.message : String(cause) };
	const code = (cause as { readonly code?: unknown }).code;
	return {
		name: cause.name,
		message: cause.message,
		...(typeof code === "string" ? { code } : {}),
		...(cause.cause === undefined ? {} : { cause: serializeCause(cause.cause, depth + 1) }),
	};
}

function deserializeCause(cause: SerializedErrorCause): Error {
	const error = new Error(
		cause.message,
		cause.cause === undefined ? undefined : { cause: deserializeCause(cause.cause) },
	);
	error.name = cause.name;
	if (cause.code !== undefined) Object.assign(error, { code: cause.code });
	return error;
}

function hasStageWaitShape(value: unknown, names: readonly string[]): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	return (
		typeof candidate.name === "string" &&
		names.includes(candidate.name) &&
		typeof candidate.code === "string" &&
		CODES.has(candidate.code)
	);
}

/** True for any error of the family, including a structural copy from another realm or process. */
export function isStageWaitError(error: unknown): error is StageWaitError {
	return error instanceof StageWaitError || hasStageWaitShape(error, FAMILY_NAMES);
}

export function isStageWaitConfigError(error: unknown): error is StageWaitConfigError {
	return error instanceof StageWaitConfigError || hasStageWaitShape(error, ["StageWaitConfigError"]);
}

export function isStageReleaseError(error: unknown): error is StageReleaseError {
	return error instanceof StageReleaseError || hasStageWaitShape(error, ["StageReleaseError"]);
}

export function isStageRehydrationError(error: unknown): error is StageRehydrationError {
	return error instanceof StageRehydrationError || hasStageWaitShape(error, ["StageRehydrationError"]);
}

export function isStageWaitRecordError(error: unknown): error is StageWaitRecordError {
	return error instanceof StageWaitRecordError || hasStageWaitShape(error, ["StageWaitRecordError"]);
}

export function isStageWakeError(error: unknown): error is StageWakeError {
	return error instanceof StageWakeError || hasStageWaitShape(error, ["StageWakeError"]);
}

/** The first {@link StageWaitError} in `error`'s cause chain, at most eight levels deep. */
export function findStageWaitError(error: unknown): StageWaitError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isStageWaitError(current)) return current;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * Rebuild a serialized family error as its own class on this side of a process boundary. An unknown name becomes
 * the family base with the original `name` and `code` kept.
 */
export function deserializeStageWaitError(serialized: SerializedStageWaitError): StageWaitError {
	const code = serialized.code as StageWaitErrorCode;
	const options = serialized.cause === undefined ? undefined : { cause: deserializeCause(serialized.cause) };
	let error: StageWaitError;
	switch (serialized.name) {
		case "StageWaitConfigError":
			error = new StageWaitConfigError(
				serialized.fields as StageWaitErrorFields & { source: StageWaitConfigSource; field: string },
			);
			break;
		case "StageReleaseError":
			error = new StageReleaseError(code as "stage-busy" | "not-reopenable", serialized.fields);
			break;
		case "StageRehydrationError":
			error = new StageRehydrationError(serialized.fields, {
				...options,
				code: REHYDRATION_CODES.has(code) ? (code as StageRehydrationErrorCode) : "session-unavailable",
			});
			break;
		case "StageWaitRecordError":
			error = new StageWaitRecordError(
				serialized.fields as StageWaitErrorFields & { phase: StageWaitRecordPhase },
				options,
			);
			break;
		case "StageWakeError":
			error =
				code === "unknown-wake-kind"
					? new StageWakeError(
							serialized.fields as StageWaitErrorFields & { runId: string; stageId: string; kind: string },
						)
					: new StageWakeError(
							serialized.fields as StageWaitErrorFields & {
								source: StageWaitConfigSource;
								field: "kind" | "handler";
							},
							{ code: code as StageWakeRegistrationErrorCode },
						);
			break;
		default:
			error = new StageWaitError(code, serialized.fields, { ...options, retryable: serialized.retryable });
			Object.defineProperty(error, "name", { value: serialized.name });
	}
	if (error.message !== serialized.message) Object.defineProperty(error, "message", { value: serialized.message });
	return error;
}
