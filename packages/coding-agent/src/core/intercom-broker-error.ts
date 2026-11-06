/** Stable codes of the {@link IntercomBrokerError} family. */
export type IntercomBrokerErrorCode = "broker-successor-timeout";

/** A JSON value among an {@link IntercomBrokerError}'s fields. */
export type IntercomBrokerErrorFieldValue =
	| string
	| number
	| boolean
	| null
	| readonly IntercomBrokerErrorFieldValue[]
	| { readonly [key: string]: IntercomBrokerErrorFieldValue };

/** The facts an {@link IntercomBrokerError} carries, as JSON. */
export interface IntercomBrokerErrorFields {
	readonly [key: string]: IntercomBrokerErrorFieldValue;
}

/** What an {@link IntercomBrokerError} is built with beside its code and message. */
export interface IntercomBrokerErrorOptions extends ErrorOptions {
	/** The class name of a member this version does not know, kept when it is rebuilt as the family base. */
	readonly name?: string;
	readonly hint?: string;
	readonly retryable?: boolean;
	readonly fields?: IntercomBrokerErrorFields;
}

/** Stable code of {@link IntercomBrokerSuccessorTimeoutError}. */
export type IntercomBrokerSuccessorTimeoutCode = Extract<IntercomBrokerErrorCode, "broker-successor-timeout">;

/** The step that was running when the bound expired: registering a new connection with the broker. */
export type IntercomBrokerSuccessorTimeoutPhase = "registration";

/** The facts an {@link IntercomBrokerSuccessorTimeoutError} carries beside its phase. */
export interface IntercomBrokerSuccessorTimeoutFields {
	/** How long registration kept trying a replacement broker after a retiring broker first ended it. */
	readonly timeoutMs: number;
	/**
	 * Whole milliseconds from the first registration a retiring broker ended to the last, on the monotonic clock. It
	 * passes `timeoutMs` by however long the last attempt took, because the bound is checked when an attempt fails.
	 */
	readonly elapsedMs: number;
	/** Registrations a retiring broker ended, the first one included. */
	readonly attempts: number;
}

const FAMILY_NAME = "IntercomBrokerError";
const SUCCESSOR_TIMEOUT_NAME = "IntercomBrokerSuccessorTimeoutError";
const SUCCESSOR_TIMEOUT_CODE: IntercomBrokerSuccessorTimeoutCode = "broker-successor-timeout";
const SUCCESSOR_TIMEOUT_HINT = "Run `atomic intercom restart` to replace the broker, then resume the run or retry.";
const NAMES: ReadonlySet<string> = new Set([FAMILY_NAME, SUCCESSOR_TIMEOUT_NAME]);
const CODES: ReadonlySet<string> = new Set<IntercomBrokerErrorCode>([SUCCESSOR_TIMEOUT_CODE]);
const MAX_CAUSE_DEPTH = 8;

/**
 * The family of failures to register with the Intercom broker. Catch it, or its concrete class, and branch on `code`.
 * A member this version does not know arrives from another process as this class, with its own `name` and `code`.
 */
export class IntercomBrokerError extends Error {
	override readonly name: string = FAMILY_NAME;
	readonly code: string;
	readonly retryable: boolean;
	readonly hint: string | undefined;
	readonly fields: IntercomBrokerErrorFields;

	constructor(code: string, message: string, options: IntercomBrokerErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		if (options.name !== undefined) this.name = options.name;
		this.code = code;
		this.retryable = options.retryable === true;
		this.hint = options.hint;
		this.fields = options.fields ?? {};
	}
}

/**
 * The Intercom broker retired while a connection was registering with it, and no replacement broker accepted the
 * registration within `timeoutMs`. Each attempt spawned a replacement once the retiring broker stopped answering; this
 * reports that none took over. `cause` is the last attempt's failure. It is retryable: a later registration starts a
 * broker of its own.
 */
export class IntercomBrokerSuccessorTimeoutError extends IntercomBrokerError {
	override readonly name = "IntercomBrokerSuccessorTimeoutError" as const;
	declare readonly code: IntercomBrokerSuccessorTimeoutCode;
	declare readonly retryable: true;
	declare readonly hint: string;
	readonly phase: IntercomBrokerSuccessorTimeoutPhase = "registration";
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly attempts: number;

	constructor(fields: IntercomBrokerSuccessorTimeoutFields, options?: ErrorOptions) {
		super(
			SUCCESSOR_TIMEOUT_CODE,
			`Intercom registration timed out waiting for a broker to replace a retiring one: ${fields.attempts} attempts over ${fields.elapsedMs} ms of ${fields.timeoutMs} ms (${SUCCESSOR_TIMEOUT_CODE}). ${SUCCESSOR_TIMEOUT_HINT}`,
			{
				...options,
				hint: SUCCESSOR_TIMEOUT_HINT,
				retryable: true,
				fields: {
					phase: "registration",
					timeoutMs: fields.timeoutMs,
					elapsedMs: fields.elapsedMs,
					attempts: fields.attempts,
				},
			},
		);
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
		this.attempts = fields.attempts;
	}
}

/** True for an {@link IntercomBrokerError}, also one from another realm or process, by a family `name` and `code`. */
export function isIntercomBrokerError(error: unknown): error is IntercomBrokerError {
	if (error instanceof IntercomBrokerError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown };
	return NAMES.has(candidate.name as string) && CODES.has(candidate.code as string);
}

/**
 * True for an {@link IntercomBrokerSuccessorTimeoutError}, also one from another realm or process, by `name`, `code`
 * and its `timeoutMs`. A family base rebuilt from a copy whose fields did not fit keeps the name but is not one.
 */
export function isIntercomBrokerSuccessorTimeoutError(error: unknown): error is IntercomBrokerSuccessorTimeoutError {
	if (error instanceof IntercomBrokerSuccessorTimeoutError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown; readonly timeoutMs?: unknown };
	return (
		candidate.name === SUCCESSOR_TIMEOUT_NAME &&
		candidate.code === SUCCESSOR_TIMEOUT_CODE &&
		typeof candidate.timeoutMs === "number"
	);
}

/** True when `error`, or a `cause` within eight links of it, is an {@link IntercomBrokerError} marked `retryable`. */
export function isRetryableIntercomBrokerError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
		if (isIntercomBrokerError(current) && current.retryable === true) return true;
		if (typeof current !== "object" || current === null) return false;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return false;
}

/** An {@link IntercomBrokerError} as JSON, its cause aside. */
export interface SerializedIntercomBrokerError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint?: string;
	readonly retryable: boolean;
	readonly fields?: IntercomBrokerErrorFields;
}

/** The JSON form of an {@link IntercomBrokerError}, its cause aside. */
export function serializeIntercomBrokerError(error: IntercomBrokerError): SerializedIntercomBrokerError {
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		...(error.hint === undefined ? {} : { hint: error.hint }),
		retryable: error.retryable,
		fields: error.fields,
	};
}

function isCount(value: IntercomBrokerErrorFieldValue | undefined): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function successorTimeoutFields(fields: IntercomBrokerErrorFields): IntercomBrokerSuccessorTimeoutFields | undefined {
	const { phase, timeoutMs, elapsedMs, attempts } = fields;
	if (phase !== "registration" || !isCount(timeoutMs) || !isCount(elapsedMs) || !isCount(attempts)) return undefined;
	return { timeoutMs, elapsedMs, attempts };
}

/**
 * The error {@link serializeIntercomBrokerError} produced, rebuilt after it crossed a process boundary as the same
 * class, with `cause` as its cause. An unknown `name` or `code`, or fields that do not fit its class, rebuild it as
 * {@link IntercomBrokerError} with the original `name`, `code`, `message`, `hint`, `retryable` and `fields`.
 */
export function rehydrateIntercomBrokerError(form: SerializedIntercomBrokerError, cause?: Error): IntercomBrokerError {
	const fields = form.fields ?? {};
	if (form.name === SUCCESSOR_TIMEOUT_NAME && form.code === SUCCESSOR_TIMEOUT_CODE) {
		const successor = successorTimeoutFields(fields);
		if (successor !== undefined) return new IntercomBrokerSuccessorTimeoutError(successor, { cause });
	}
	return new IntercomBrokerError(form.code, form.message, {
		name: form.name,
		hint: form.hint,
		retryable: form.retryable,
		fields,
		cause,
	});
}
