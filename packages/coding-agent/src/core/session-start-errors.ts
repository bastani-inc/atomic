/** Every code a {@link SessionStartError} carries. Codes are public API: never renamed or reused. */
export type SessionStartErrorCode = "session-start-timeout" | "invalid-session-start-timeout";

/**
 * What blocked a session that did not start within its budget: waiting for a resource-admission permit, setting the
 * session up, dispatching its task, or an event loop too busy for any of them to progress.
 */
export type SessionStartPhase = "admission" | "setup" | "dispatch" | "event-loop";

/** The step a session start was in when its budget ran out. */
export type SessionStartStep =
	| "opening-session"
	| "loading-resources"
	| "creating-session"
	| "awaiting-admission"
	| "dispatching-task";

/** How long one step of a session start ran, in the order the steps ran. */
export type SessionStartStepTiming = {
	readonly step: SessionStartStep;
	readonly elapsedMs: number;
};

/**
 * The event loop as a periodic timer saw it while the session started. The timer turns at most once per loop turn,
 * so `turns` is a lower bound of the loop's turns and `meanTurnMs` how long a turn took when the loop was busy.
 */
export type SessionStartEventLoopSample = {
	readonly turns: number;
	readonly meanTurnMs: number;
	readonly maxTurnMs: number;
};

/** Where an invalid session start setting came from. */
export type SessionStartConfigSource = "sdk" | "cli" | "env" | "settings";

/** Why a session start timeout setting is invalid. */
export type SessionStartConfigReason = "not-a-positive-integer" | "exceeds-maximum";

/** The longest start budget a timer can hold; a longer one would fire at once. */
export const MAX_SESSION_START_TIMEOUT_MS = 2_147_483_647;

/** A JSON-safe value an error carries in its `fields`. */
export type SessionStartFieldValue =
	| string
	| number
	| boolean
	| null
	| readonly SessionStartFieldValue[]
	| { readonly [key: string]: SessionStartFieldValue };

export type SessionStartFields = { readonly [key: string]: SessionStartFieldValue };

export type SessionStartFailureCause = object | string | number | boolean | undefined;

/** A cause as it crosses a process boundary: its name, code and message, with its own cause, bounded. */
export type SerializedSessionStartCause = {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly fields?: SessionStartFields;
	readonly hint?: string;
	readonly retryable?: boolean;
	readonly cause?: SerializedSessionStartCause;
};

/** A {@link SessionStartError} as it crosses a worker, IPC or task-record boundary. */
export type SerializedSessionStartError = {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint?: string;
	readonly retryable: boolean;
	readonly fields: SessionStartFields;
	readonly cause?: SerializedSessionStartCause;
};

export interface SessionStartErrorOptions {
	/** The name an error rehydrated from an unknown subclass keeps. */
	readonly name?: string;
	readonly hint?: string;
	readonly retryable?: boolean;
	readonly fields?: SessionStartFields;
	readonly cause?: SessionStartFailureCause;
}

const SESSION_START_ERROR_NAME = "SessionStartError";
const SESSION_START_TIMEOUT_ERROR_NAME = "SessionStartTimeoutError";
const SESSION_START_CONFIG_ERROR_NAME = "SessionStartConfigError";
const SESSION_START_ERROR_NAMES: ReadonlySet<string> = new Set([
	SESSION_START_ERROR_NAME,
	SESSION_START_TIMEOUT_ERROR_NAME,
	SESSION_START_CONFIG_ERROR_NAME,
]);
const SESSION_START_ERROR_CODES: ReadonlySet<string> = new Set<SessionStartErrorCode>([
	"session-start-timeout",
	"invalid-session-start-timeout",
]);
const SESSION_START_PHASES: ReadonlySet<string> = new Set<SessionStartPhase>([
	"admission",
	"setup",
	"dispatch",
	"event-loop",
]);
const SESSION_START_STEPS: ReadonlySet<string> = new Set<SessionStartStep>([
	"opening-session",
	"loading-resources",
	"creating-session",
	"awaiting-admission",
	"dispatching-task",
]);
const SESSION_START_CONFIG_SOURCES: ReadonlySet<string> = new Set<SessionStartConfigSource>([
	"sdk",
	"cli",
	"env",
	"settings",
]);
const SESSION_START_CONFIG_REASONS: ReadonlySet<string> = new Set<SessionStartConfigReason>([
	"not-a-positive-integer",
	"exceeds-maximum",
]);
const MAX_CAUSE_DEPTH = 8;
const MAX_CONFIG_VALUE_CHARS = 64;

/** The family of session start failures. Catch it, or one of its concrete classes, and branch on `code`. */
export class SessionStartError extends Error {
	override readonly name: string = SESSION_START_ERROR_NAME;
	readonly code: string;
	readonly retryable: boolean;
	readonly hint: string | undefined;
	readonly fields: SessionStartFields;
	declare readonly cause?: SessionStartFailureCause;
	constructor(code: string, message: string, options: SessionStartErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		if (options.name !== undefined) this.name = options.name;
		this.code = code;
		this.retryable = options.retryable === true;
		this.hint = options.hint;
		this.fields = options.fields ?? {};
	}
}

/** The facts a {@link SessionStartTimeoutError} reports. */
export interface SessionStartTimeoutDetails {
	/** What was starting, such as `subagent run-1/worker_1`. */
	readonly subject: string;
	readonly phase: SessionStartPhase;
	readonly step: SessionStartStep;
	readonly timeoutMs: number;
	/** From the start to when the budget ran out; above `timeoutMs` when a busy event loop fired its timer late. */
	readonly elapsedMs: number;
	/** How long the step it was in had run. */
	readonly stepElapsedMs: number;
	readonly steps: readonly SessionStartStepTiming[];
	readonly eventLoop: SessionStartEventLoopSample;
}

const STEP_TEXT: Readonly<Record<SessionStartStep, string>> = {
	"opening-session": "opening its session",
	"loading-resources": "loading its resources",
	"creating-session": "creating its agent session",
	"awaiting-admission": "waiting for a resource-admission permit",
	"dispatching-task": "dispatching its task",
};

function formatBudget(ms: number): string {
	if (ms % 60_000 === 0) return `${ms / 60_000} min`;
	if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
	return `${ms} ms`;
}

function timeoutHint(details: SessionStartTimeoutDetails): string {
	switch (details.phase) {
		case "admission":
			return "Its resource admission granted no session permit in time: free capacity in that admission, such as a workflow's session limit or memory floor, then retry.";
		case "dispatch":
			return "Its task was not dispatched in time: check the extensions that handle its input and before_agent_start, then retry.";
		case "event-loop":
			return `The process's event loop turned only ${details.eventLoop.turns} times, about ${Math.round(details.eventLoop.meanTurnMs)} ms each: reduce the work in this process, such as busy pooled workflow roots, then retry.`;
		case "setup":
			return "Its session was still being set up: check its session store and extension startup, or raise sessionStartTimeoutMs, then retry.";
	}
}

/** A session that did not start within its budget. `phase` names what blocked it; retrying may succeed. */
export class SessionStartTimeoutError extends SessionStartError {
	override readonly name = SESSION_START_TIMEOUT_ERROR_NAME;
	declare readonly code: "session-start-timeout";
	declare readonly retryable: true;
	readonly subject: string;
	readonly phase: SessionStartPhase;
	readonly step: SessionStartStep;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly stepElapsedMs: number;
	readonly steps: readonly SessionStartStepTiming[];
	readonly eventLoop: SessionStartEventLoopSample;
	constructor(details: SessionStartTimeoutDetails, options: { readonly cause?: SessionStartFailureCause } = {}) {
		const hint = timeoutHint(details);
		super(
			"session-start-timeout",
			`Session start timed out: ${details.subject} did not start within ${formatBudget(details.timeoutMs)}, still ${STEP_TEXT[details.step]} (session-start-timeout, phase ${details.phase}). ${hint}`,
			{
				hint,
				retryable: true,
				cause: options.cause,
				fields: {
					subject: details.subject,
					phase: details.phase,
					step: details.step,
					timeoutMs: details.timeoutMs,
					elapsedMs: details.elapsedMs,
					stepElapsedMs: details.stepElapsedMs,
					steps: details.steps.map((timing) => ({ step: timing.step, elapsedMs: timing.elapsedMs })),
					eventLoop: { ...details.eventLoop },
				},
			},
		);
		this.subject = details.subject;
		this.phase = details.phase;
		this.step = details.step;
		this.timeoutMs = details.timeoutMs;
		this.elapsedMs = details.elapsedMs;
		this.stepElapsedMs = details.stepElapsedMs;
		this.steps = details.steps.map((timing) => ({ ...timing }));
		this.eventLoop = { ...details.eventLoop };
	}
}

function describeConfigValue(value: unknown): string {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > MAX_CONFIG_VALUE_CHARS ? `${text.slice(0, MAX_CONFIG_VALUE_CHARS - 1)}…` : text;
}

/** An invalid session start budget, named by where it came from and its field. Never retryable. */
export class SessionStartConfigError extends SessionStartError {
	override readonly name = SESSION_START_CONFIG_ERROR_NAME;
	declare readonly code: "invalid-session-start-timeout";
	declare readonly retryable: false;
	readonly source: SessionStartConfigSource;
	readonly field: string;
	readonly reason: SessionStartConfigReason;
	/** The rejected value as JSON text, shortened to 64 characters. */
	readonly value: string;
	constructor(
		source: SessionStartConfigSource,
		field: string,
		reason: SessionStartConfigReason,
		value: string,
		options: { readonly cause?: SessionStartFailureCause } = {},
	) {
		const hint = `Set ${field} to a whole number of milliseconds from 1 to ${MAX_SESSION_START_TIMEOUT_MS}, such as 300000 for 5 minutes.`;
		super(
			"invalid-session-start-timeout",
			`Invalid session start configuration: ${field} from ${source} is ${value} (invalid-session-start-timeout, ${reason}). ${hint}`,
			{ hint, retryable: false, cause: options.cause, fields: { source, field, reason, value } },
		);
		this.source = source;
		this.field = field;
		this.reason = reason;
		this.value = value;
	}
}

/**
 * Validate a session start budget from `source` before anything uses it: `undefined` stays unset, a whole number of
 * milliseconds from 1 to {@link MAX_SESSION_START_TIMEOUT_MS} is returned, and anything else throws
 * {@link SessionStartConfigError}.
 */
export function parseSessionStartTimeoutMs(
	value: unknown,
	source: SessionStartConfigSource,
	field: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < 1)
		throw new SessionStartConfigError(source, field, "not-a-positive-integer", describeConfigValue(value));
	if ((value as number) > MAX_SESSION_START_TIMEOUT_MS)
		throw new SessionStartConfigError(source, field, "exceeds-maximum", describeConfigValue(value));
	return value as number;
}

type StructuralError = {
	readonly name?: unknown;
	readonly code?: unknown;
	readonly message?: unknown;
	readonly phase?: unknown;
	readonly field?: unknown;
	readonly cause?: unknown;
};

function structural(value: unknown): value is StructuralError {
	return typeof value === "object" && value !== null;
}

/** Whether `value` is a session start error: an instance, or one from another realm or process by `name` and `code`. */
export function isSessionStartError(value: unknown): value is SessionStartError {
	if (value instanceof SessionStartError) return true;
	return (
		structural(value) &&
		SESSION_START_ERROR_NAMES.has(value.name as string) &&
		SESSION_START_ERROR_CODES.has(value.code as string) &&
		typeof value.message === "string"
	);
}

/** Whether `value` is a {@link SessionStartTimeoutError}, by class or by `name`, `code` and its `phase`. */
export function isSessionStartTimeoutError(value: unknown): value is SessionStartTimeoutError {
	if (value instanceof SessionStartTimeoutError) return true;
	return (
		isSessionStartError(value) &&
		value.name === SESSION_START_TIMEOUT_ERROR_NAME &&
		value.code === "session-start-timeout" &&
		SESSION_START_PHASES.has((value as StructuralError).phase as string)
	);
}

/** Whether `value` is a {@link SessionStartConfigError}, by class or by `name`, `code` and its `field`. */
export function isSessionStartConfigError(value: unknown): value is SessionStartConfigError {
	if (value instanceof SessionStartConfigError) return true;
	return (
		isSessionStartError(value) &&
		value.name === SESSION_START_CONFIG_ERROR_NAME &&
		value.code === "invalid-session-start-timeout" &&
		typeof (value as StructuralError).field === "string"
	);
}

/** The first session start error in `error`'s `cause` chain, looking at most eight levels deep. */
export function findSessionStartError(error: unknown): SessionStartError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && structural(current); depth++) {
		if (isSessionStartError(current)) return current;
		current = current.cause;
	}
	return undefined;
}

/** Whether a session start error a caller may retry is anywhere in `error`'s `cause` chain. */
export function isRetryableSessionStartError(error: unknown): boolean {
	return findSessionStartError(error)?.retryable === true;
}

/** `cause` and the causes below it, as many as fit in `room` levels, as JSON-safe data. */
function serializeCause(cause: unknown, room: number): SerializedSessionStartCause | undefined {
	if (cause === undefined || room === 0) return undefined;
	if (isSessionStartError(cause)) {
		const nested = serializeCause(cause.cause, room - 1);
		return {
			name: cause.name,
			code: cause.code,
			message: cause.message,
			fields: cause.fields,
			retryable: cause.retryable,
			...(cause.hint === undefined ? {} : { hint: cause.hint }),
			...(nested === undefined ? {} : { cause: nested }),
		};
	}
	if (cause instanceof Error) {
		const code = (cause as { readonly code?: unknown }).code;
		const nested = serializeCause(cause.cause, room - 1);
		return {
			name: cause.name,
			message: cause.message,
			...(typeof code === "string" ? { code } : {}),
			...(nested === undefined ? {} : { cause: nested }),
		};
	}
	return { name: "Error", message: typeof cause === "string" ? cause : describeConfigValue(cause) };
}

/** `error` as JSON-safe data that {@link rehydrateSessionStartError} turns back into the same class. */
export function serializeSessionStartError(error: SessionStartError): SerializedSessionStartError {
	const cause = serializeCause(error.cause, MAX_CAUSE_DEPTH);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		...(error.hint === undefined ? {} : { hint: error.hint }),
		retryable: error.retryable,
		fields: error.fields,
		...(cause === undefined ? {} : { cause }),
	};
}

/** `fields[key]` when it is a number; anything that is not an object has no such field. */
function numberField(fields: SessionStartFieldValue | undefined, key: string): number | undefined {
	const value = (fields as SessionStartFields | null | undefined)?.[key];
	return typeof value === "number" ? value : undefined;
}

function timeoutDetails(fields: SessionStartFields): SessionStartTimeoutDetails | undefined {
	const { subject, phase, step, steps } = fields;
	const timeoutMs = numberField(fields, "timeoutMs");
	const elapsedMs = numberField(fields, "elapsedMs");
	const stepElapsedMs = numberField(fields, "stepElapsedMs");
	const loop = fields.eventLoop;
	const turns = numberField(loop, "turns");
	const meanTurnMs = numberField(loop, "meanTurnMs");
	const maxTurnMs = numberField(loop, "maxTurnMs");
	if (
		typeof subject !== "string" ||
		!SESSION_START_PHASES.has(phase as string) ||
		!SESSION_START_STEPS.has(step as string) ||
		timeoutMs === undefined ||
		elapsedMs === undefined ||
		stepElapsedMs === undefined ||
		turns === undefined ||
		meanTurnMs === undefined ||
		maxTurnMs === undefined ||
		!Array.isArray(steps)
	)
		return undefined;
	const timings: SessionStartStepTiming[] = [];
	for (const timing of steps as readonly SessionStartFieldValue[]) {
		const step = (timing as SessionStartFields | null)?.step;
		const elapsed = numberField(timing, "elapsedMs");
		if (!SESSION_START_STEPS.has(step as string) || elapsed === undefined) return undefined;
		timings.push({ step: step as SessionStartStep, elapsedMs: elapsed });
	}
	return {
		subject,
		phase: phase as SessionStartPhase,
		step: step as SessionStartStep,
		timeoutMs,
		elapsedMs,
		stepElapsedMs,
		steps: timings,
		eventLoop: { turns, meanTurnMs, maxTurnMs },
	};
}

function configDetails(fields: SessionStartFields) {
	const { source, field, reason, value } = fields;
	if (
		!SESSION_START_CONFIG_SOURCES.has(source as string) ||
		typeof field !== "string" ||
		!SESSION_START_CONFIG_REASONS.has(reason as string) ||
		typeof value !== "string"
	)
		return undefined;
	return {
		source: source as SessionStartConfigSource,
		field,
		reason: reason as SessionStartConfigReason,
		value,
	};
}

function rehydrateCause(cause: SerializedSessionStartCause | undefined, room: number): Error | undefined {
	if (cause === undefined || room === 0) return undefined;
	if (cause.fields !== undefined && SESSION_START_ERROR_CODES.has(cause.code as string)) {
		return rehydrate(
			{
				name: cause.name,
				code: cause.code as string,
				message: cause.message,
				hint: cause.hint,
				retryable: cause.retryable === true,
				fields: cause.fields,
				cause: cause.cause,
			},
			room,
		);
	}
	const nested = rehydrateCause(cause.cause, room - 1);
	const error = new Error(cause.message, nested === undefined ? undefined : { cause: nested });
	error.name = cause.name;
	return cause.code === undefined ? error : Object.assign(error, { code: cause.code });
}

/** `serialized` as its class, with as many of its causes as fit in `room` levels below it. */
function rehydrate(serialized: SerializedSessionStartError, room: number): SessionStartError {
	const cause = rehydrateCause(serialized.cause, room - 1);
	if (serialized.name === SESSION_START_TIMEOUT_ERROR_NAME && serialized.code === "session-start-timeout") {
		const details = timeoutDetails(serialized.fields);
		if (details) return new SessionStartTimeoutError(details, { cause });
	}
	if (serialized.name === SESSION_START_CONFIG_ERROR_NAME && serialized.code === "invalid-session-start-timeout") {
		const details = configDetails(serialized.fields);
		if (details)
			return new SessionStartConfigError(details.source, details.field, details.reason, details.value, { cause });
	}
	return new SessionStartError(serialized.code, serialized.message, {
		name: serialized.name,
		hint: serialized.hint,
		retryable: serialized.retryable,
		fields: serialized.fields,
		cause,
	});
}

/**
 * The error {@link serializeSessionStartError} produced, as the same class with its fields. An unknown name, or fields
 * that no longer fit its class, rehydrates into {@link SessionStartError} with the original `name` and `code`.
 */
export function rehydrateSessionStartError(serialized: SerializedSessionStartError): SessionStartError {
	return rehydrate(serialized, MAX_CAUSE_DEPTH + 1);
}
