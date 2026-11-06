/** Stable code of {@link IntercomBrokerSuccessorTimeoutError}. */
export type IntercomBrokerSuccessorTimeoutCode = "broker-successor-timeout";

/** The step that was running when the bound expired: registering a new connection with the broker. */
export type IntercomBrokerSuccessorTimeoutPhase = "registration";

/** The facts an {@link IntercomBrokerSuccessorTimeoutError} carries. */
export interface IntercomBrokerSuccessorTimeoutFields {
	/** How long registration kept trying a replacement broker after a retiring broker first ended it. */
	readonly timeoutMs: number;
	/** Whole milliseconds from the first registration a retiring broker ended to the last, on the monotonic clock. */
	readonly elapsedMs: number;
	/** Registrations a retiring broker ended, the first one included. */
	readonly attempts: number;
}

const NAME = "IntercomBrokerSuccessorTimeoutError";
const CODE: IntercomBrokerSuccessorTimeoutCode = "broker-successor-timeout";
const HINT = "Run `atomic intercom restart` to replace the broker, then resume the run or retry.";

/**
 * The Intercom broker retired while a connection was registering with it, and no replacement broker accepted the
 * registration within `timeoutMs`. Each attempt spawned a replacement once the retiring broker stopped answering; this
 * reports that none took over. `cause` is the last attempt's failure. It is retryable: a later registration starts a
 * broker of its own.
 */
export class IntercomBrokerSuccessorTimeoutError extends Error {
	override readonly name = "IntercomBrokerSuccessorTimeoutError" as const;
	readonly code: IntercomBrokerSuccessorTimeoutCode = CODE;
	readonly phase: IntercomBrokerSuccessorTimeoutPhase = "registration";
	readonly retryable = true as const;
	readonly hint = HINT;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly attempts: number;

	constructor(fields: IntercomBrokerSuccessorTimeoutFields, options?: ErrorOptions) {
		super(
			`Intercom registration timed out waiting for a broker to replace a retiring one: ${fields.attempts} attempts over ${fields.elapsedMs} ms of ${fields.timeoutMs} ms (${CODE}). ${HINT}`,
			options,
		);
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
		this.attempts = fields.attempts;
	}
}

/** True for an {@link IntercomBrokerSuccessorTimeoutError}, also one from another realm or process, by `name` and `code`. */
export function isIntercomBrokerSuccessorTimeoutError(error: unknown): error is IntercomBrokerSuccessorTimeoutError {
	if (error instanceof IntercomBrokerSuccessorTimeoutError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown };
	return candidate.name === NAME && candidate.code === CODE;
}

/** An {@link IntercomBrokerSuccessorTimeoutError} as JSON: its copy carries the error's fields. */
export interface SerializedIntercomBrokerSuccessorTimeoutError {
	readonly name: typeof NAME;
	readonly code: IntercomBrokerSuccessorTimeoutCode;
	readonly message: string;
	readonly hint: string;
	readonly retryable: true;
	readonly fields: IntercomBrokerSuccessorTimeoutFields & { readonly phase: IntercomBrokerSuccessorTimeoutPhase };
}

/** The JSON form of an {@link IntercomBrokerSuccessorTimeoutError}, its cause aside. */
export function serializeIntercomBrokerSuccessorTimeoutError(
	error: IntercomBrokerSuccessorTimeoutError,
): SerializedIntercomBrokerSuccessorTimeoutError {
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: { phase: error.phase, timeoutMs: error.timeoutMs, elapsedMs: error.elapsedMs, attempts: error.attempts },
	};
}

function isCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Rebuilds an {@link IntercomBrokerSuccessorTimeoutError} from its JSON form after it crossed a process boundary, with
 * `cause` as its cause. A form of another error, or one whose fields are not whole non-negative numbers, gives undefined.
 */
export function rehydrateIntercomBrokerSuccessorTimeoutError(
	form: unknown,
	cause?: Error,
): IntercomBrokerSuccessorTimeoutError | undefined {
	if (!isIntercomBrokerSuccessorTimeoutError(form)) return undefined;
	const fields = (form as { readonly fields?: unknown }).fields;
	if (typeof fields !== "object" || fields === null) return undefined;
	const { timeoutMs, elapsedMs, attempts } = fields as Partial<
		Record<keyof IntercomBrokerSuccessorTimeoutFields, unknown>
	>;
	if (!isCount(timeoutMs) || !isCount(elapsedMs) || !isCount(attempts)) return undefined;
	return new IntercomBrokerSuccessorTimeoutError(
		{ timeoutMs, elapsedMs, attempts },
		cause === undefined ? undefined : { cause },
	);
}
