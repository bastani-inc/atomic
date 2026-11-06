import type { WorkflowSerializableObject } from "./authoring-contract-stage.js";
import type { SerializedErrorCause } from "./stage-wait-errors.js";

/** Why a run could not be evicted or rebuilt. Codes are public API: never rename or reuse one. */
export type RunEvictionErrorCode = RunEvictionConfigErrorCode | RunReplayErrorCode | RunEvictedErrorCode;

/** The code a {@link RunEvictionConfigError} carries. */
export type RunEvictionConfigErrorCode = "invalid-evict-when-waiting";

/** The code a {@link RunReplayError} carries. */
export type RunReplayErrorCode = "replay-diverged";

/** The code a {@link RunEvictedError} carries. */
export type RunEvictedErrorCode = "run-evicted";

/** Where a rejected `evictWhenWaiting` value came from. */
export type RunEvictionConfigSource = "sdk";

/**
 * Why `evictWhenWaiting` was refused: `value`, the value is not `true`, `false` or `{ afterMs }` with milliseconds
 * from 0 to 2147483647; `backend`, the run's durable backend is not a run journal, which a rebuild replays from;
 * `continuation`, the run continues another run, which eviction does not rebuild.
 */
export type RunEvictionConfigReason = "value" | "backend" | "continuation";

const FAMILY_NAMES = ["RunEvictionError", "RunEvictionConfigError", "RunReplayError", "RunEvictedError"] as const;
type RunEvictionErrorName = (typeof FAMILY_NAMES)[number];

const CODES_BY_NAME: Readonly<Record<RunEvictionErrorName, ReadonlySet<string>>> = {
	RunEvictionError: new Set<RunEvictionErrorCode>(["invalid-evict-when-waiting", "replay-diverged", "run-evicted"]),
	RunEvictionConfigError: new Set<RunEvictionConfigErrorCode>(["invalid-evict-when-waiting"]),
	RunReplayError: new Set<RunReplayErrorCode>(["replay-diverged"]),
	RunEvictedError: new Set<RunEvictedErrorCode>(["run-evicted"]),
};

const MAX_CAUSE_DEPTH = 8;

/** JSON-safe facts a {@link RunEvictionError} carries. Never contains prompt text, transcripts or credentials. */
export interface RunEvictionErrorFields extends WorkflowSerializableObject {
	readonly runId?: string;
	readonly source?: RunEvictionConfigSource;
	/** The rejected option, for example `evictWhenWaiting` or `evictWhenWaiting.afterMs`. */
	readonly field?: string;
	/** The rejected value, as text. */
	readonly value?: string;
	readonly reason?: RunEvictionConfigReason;
	/** The stages whose detached calls the rebuilt run never waited on again (`replay-diverged`), by replay key. */
	readonly replayKeys?: readonly string[];
	/** The detached calls those stages waited on (`replay-diverged`); the rebuild aborted them. */
	readonly toolCallIds?: readonly string[];
}

/** The serialized form of a {@link RunEvictionError}, for crossing a worker or IPC boundary. */
export interface SerializedRunEvictionError extends WorkflowSerializableObject {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: RunEvictionErrorFields;
	readonly cause?: SerializedErrorCause;
}

const CONFIG_HINTS: Readonly<Record<RunEvictionConfigReason, string>> = {
	value: "Set evictWhenWaiting to true, false, or { afterMs } with a number of milliseconds from 0 to 2147483647; leave it unset to keep the run resident.",
	backend:
		"Run the workflow on a run journal (the default journal, or journal: { memory: true }) so a rebuild can replay it, or leave evictWhenWaiting unset.",
	continuation: "Leave evictWhenWaiting unset when the run continues another run.",
};

function hintFor(code: RunEvictionErrorCode, fields: RunEvictionErrorFields): string {
	switch (code) {
		case "invalid-evict-when-waiting":
			return CONFIG_HINTS[fields.reason ?? "value"];
		case "replay-diverged":
			return "The workflow body must create its stages and await them in the same order on every replay: keep anything that changes between runs (time, randomness, external reads) in a ctx.tool call, or leave evictWhenWaiting unset.";
		case "run-evicted":
			return "Await every ctx call the workflow body makes, and keep work outside ctx calls out of a body that runs with evictWhenWaiting; the rebuilt run carries on.";
	}
}

function subject(code: RunEvictionErrorCode, fields: RunEvictionErrorFields): string {
	const run = fields.runId === undefined ? "the run" : `run ${fields.runId}`;
	switch (code) {
		case "invalid-evict-when-waiting":
			return (fields.reason ?? "value") === "value"
				? `Invalid ${fields.field ?? "evictWhenWaiting"}: ${fields.value}`
				: `Cannot evict ${run} while it waits: ${fields.reason === "backend" ? "its durable backend is not a run journal" : "it continues another run"}`;
		case "replay-diverged": {
			const keys = fields.replayKeys ?? [];
			return `Cannot rebuild ${run}: the replayed workflow body never waited again on ${keys.length === 0 ? "the detached calls of its waiting stages" : `the detached calls of ${keys.join(", ")}`}`;
		}
		case "run-evicted":
			return `${run} was evicted from memory while its stages waited; this execution of its workflow body is over`;
	}
}

/**
 * Family base of the errors around evicting a waiting run from memory and rebuilding it by replay
 * (`evictWhenWaiting`). Catch this class, or branch on `code`.
 */
export class RunEvictionError extends Error {
	override readonly name: RunEvictionErrorName = "RunEvictionError";
	readonly code: RunEvictionErrorCode;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: RunEvictionErrorFields;

	constructor(
		code: RunEvictionErrorCode,
		fields: RunEvictionErrorFields,
		options?: ErrorOptions & { retryable?: boolean },
	) {
		const hint = hintFor(code, fields);
		super(`${subject(code, fields)} (${code}). ${hint}`, options);
		this.code = code;
		this.hint = hint;
		this.retryable = options?.retryable === true;
		this.fields = fields;
	}

	toJSON(): SerializedRunEvictionError {
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

/** An `evictWhenWaiting` value or the run it was given for was refused where it entered the SDK, before any I/O. */
export class RunEvictionConfigError extends RunEvictionError {
	override readonly name = "RunEvictionConfigError";
	declare readonly code: RunEvictionConfigErrorCode;
	constructor(
		fields: RunEvictionErrorFields & {
			readonly source: RunEvictionConfigSource;
			readonly field: string;
			readonly reason: RunEvictionConfigReason;
		},
		options?: ErrorOptions,
	) {
		super("invalid-evict-when-waiting", fields, options);
	}
}

/**
 * A rebuilt run's replayed workflow body finished without waiting again on the detached calls its evicted stages
 * waited on (`replay-diverged`). The run fails with it, and the calls are aborted. Not retryable: the body takes a
 * different path on replay.
 */
export class RunReplayError extends RunEvictionError {
	override readonly name = "RunReplayError";
	declare readonly code: RunReplayErrorCode;
	constructor(
		fields: RunEvictionErrorFields & {
			readonly runId: string;
			readonly replayKeys: readonly string[];
			readonly toolCallIds: readonly string[];
		},
		options?: ErrorOptions,
	) {
		super("replay-diverged", fields, options);
	}
}

/**
 * The abort reason of a workflow body execution whose run was evicted (`run-evicted`). Not a failure of the run, which
 * the rebuild carries on: only code the evicted execution still runs outside a `ctx` call, such as a timer callback,
 * meets it, from its next `ctx` call.
 */
export class RunEvictedError extends RunEvictionError {
	override readonly name = "RunEvictedError";
	declare readonly code: RunEvictedErrorCode;
	constructor(fields: RunEvictionErrorFields & { readonly runId: string }, options?: ErrorOptions) {
		super("run-evicted", fields, options);
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

function hasShape(value: unknown, name: RunEvictionErrorName): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	if (typeof candidate.code !== "string") return false;
	if (name === "RunEvictionError")
		return (
			typeof candidate.name === "string" &&
			(FAMILY_NAMES as readonly string[]).includes(candidate.name) &&
			CODES_BY_NAME.RunEvictionError.has(candidate.code)
		);
	return candidate.name === name && CODES_BY_NAME[name].has(candidate.code);
}

/** True for any error of the family, including a structural copy from another realm or process. */
export function isRunEvictionError(error: unknown): error is RunEvictionError {
	return error instanceof RunEvictionError || hasShape(error, "RunEvictionError");
}

export function isRunEvictionConfigError(error: unknown): error is RunEvictionConfigError {
	return error instanceof RunEvictionConfigError || hasShape(error, "RunEvictionConfigError");
}

export function isRunReplayError(error: unknown): error is RunReplayError {
	return error instanceof RunReplayError || hasShape(error, "RunReplayError");
}

export function isRunEvictedError(error: unknown): error is RunEvictedError {
	return error instanceof RunEvictedError || hasShape(error, "RunEvictedError");
}

/** The first {@link RunEvictionError} in `error`'s cause chain, at most eight levels deep. */
export function findRunEvictionError(error: unknown): RunEvictionError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isRunEvictionError(current)) return current;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * Rebuild a serialized family error as its own class on this side of a process boundary. An unknown name becomes the
 * family base with the original `name` and `code` kept.
 */
export function deserializeRunEvictionError(serialized: SerializedRunEvictionError): RunEvictionError {
	const options = serialized.cause === undefined ? undefined : { cause: deserializeCause(serialized.cause) };
	let error: RunEvictionError;
	switch (serialized.name) {
		case "RunEvictionConfigError":
			error = new RunEvictionConfigError(
				serialized.fields as RunEvictionErrorFields & {
					source: RunEvictionConfigSource;
					field: string;
					reason: RunEvictionConfigReason;
				},
				options,
			);
			break;
		case "RunReplayError":
			error = new RunReplayError(
				serialized.fields as RunEvictionErrorFields & {
					runId: string;
					replayKeys: readonly string[];
					toolCallIds: readonly string[];
				},
				options,
			);
			break;
		case "RunEvictedError":
			error = new RunEvictedError(serialized.fields as RunEvictionErrorFields & { runId: string }, options);
			break;
		default:
			error = new RunEvictionError(serialized.code as RunEvictionErrorCode, serialized.fields, {
				...options,
				retryable: serialized.retryable,
			});
			Object.defineProperty(error, "name", { value: serialized.name });
	}
	Object.defineProperty(error, "message", { value: serialized.message });
	return error;
}
