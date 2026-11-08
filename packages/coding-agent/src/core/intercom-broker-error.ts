/** Stable codes of the {@link IntercomBrokerError} family. */
export type IntercomBrokerErrorCode =
	| "broker-successor-timeout"
	| "broker-protocol-unsupported"
	| "broker-upgrade-failed"
	| "broker-stop-timeout";

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

/** Stable code of {@link IntercomBrokerProtocolError}. */
export type IntercomBrokerProtocolCode = Extract<IntercomBrokerErrorCode, "broker-protocol-unsupported">;

/** The facts an {@link IntercomBrokerProtocolError} carries. */
export interface IntercomBrokerProtocolFields {
	/** The request this session was about to send, by its wire frame type, e.g. `reserve_released_children`. */
	readonly feature: string;
	/** The oldest protocol version the connected broker accepts. */
	readonly brokerProtocolMin: number;
	/** The newest protocol version the connected broker accepts. */
	readonly brokerProtocolMax: number;
	/** The protocol version the request needs. */
	readonly requiredProtocol: number;
}

/** Stable code of {@link IntercomBrokerUpgradeError}. */
export type IntercomBrokerUpgradeCode = Extract<IntercomBrokerErrorCode, "broker-upgrade-failed">;

/** The step of replacing an older broker that failed: stopping it, or starting the successor once it had stopped. */
export type IntercomBrokerUpgradePhase = "stop" | "start";

/** The facts an {@link IntercomBrokerUpgradeError} carries. */
export interface IntercomBrokerUpgradeFields {
	readonly phase: IntercomBrokerUpgradePhase;
	/** The process id of the older broker being replaced. */
	readonly previousPid: number;
	/** The newest protocol version the older broker accepts. */
	readonly previousProtocolMax: number;
}

/** Stable code of {@link IntercomBrokerStopTimeoutError}. */
export type IntercomBrokerStopTimeoutCode = Extract<IntercomBrokerErrorCode, "broker-stop-timeout">;

/** The step that was running when the bound expired: waiting for the broker process to exit after its shutdown. */
export type IntercomBrokerStopTimeoutPhase = "stop";

/** The facts an {@link IntercomBrokerStopTimeoutError} carries beside its phase. */
export interface IntercomBrokerStopTimeoutFields {
	/** The broker process that was asked to shut down. */
	readonly pid: number;
	/** How long the stop waited for that process to exit. */
	readonly timeoutMs: number;
	/** Whole milliseconds from the shutdown request until the wait gave up. */
	readonly elapsedMs: number;
}

const FAMILY_NAME = "IntercomBrokerError";
const SUCCESSOR_TIMEOUT_NAME = "IntercomBrokerSuccessorTimeoutError";
const SUCCESSOR_TIMEOUT_CODE: IntercomBrokerSuccessorTimeoutCode = "broker-successor-timeout";
const SUCCESSOR_TIMEOUT_HINT = "Run `atomic intercom restart` to replace the broker, then resume the run or retry.";
const PROTOCOL_NAME = "IntercomBrokerProtocolError";
const PROTOCOL_CODE: IntercomBrokerProtocolCode = "broker-protocol-unsupported";
const PROTOCOL_HINT =
	"Run `atomic intercom restart` so a broker of this Atomic version replaces the older one, then retry.";
const UPGRADE_NAME = "IntercomBrokerUpgradeError";
const UPGRADE_CODE: IntercomBrokerUpgradeCode = "broker-upgrade-failed";
const UPGRADE_HINTS: Readonly<Record<IntercomBrokerUpgradePhase, string>> = {
	stop: "This session keeps using the older broker, on this machine only. Run `atomic intercom restart` to replace it.",
	start: "Sessions start a broker again when they reconnect; run `atomic intercom restart` if they keep failing.",
};
const UPGRADE_STEPS: Readonly<Record<IntercomBrokerUpgradePhase, string>> = {
	stop: "stopping it",
	start: "starting its successor",
};
const STOP_TIMEOUT_NAME = "IntercomBrokerStopTimeoutError";
const STOP_TIMEOUT_CODE: IntercomBrokerStopTimeoutCode = "broker-stop-timeout";
const STOP_TIMEOUT_HINT = "Wait for the broker process to exit, or end it yourself, then retry.";
const NAMES: ReadonlySet<string> = new Set([
	FAMILY_NAME,
	SUCCESSOR_TIMEOUT_NAME,
	PROTOCOL_NAME,
	UPGRADE_NAME,
	STOP_TIMEOUT_NAME,
]);
const CODES: ReadonlySet<string> = new Set<IntercomBrokerErrorCode>([
	SUCCESSOR_TIMEOUT_CODE,
	PROTOCOL_CODE,
	UPGRADE_CODE,
	STOP_TIMEOUT_CODE,
]);
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

/**
 * #4538: the connected Intercom broker is older than a request this session was about to send needs, so the request
 * was refused before anything was sent. Not retryable on this connection: replacing the broker clears it.
 */
export class IntercomBrokerProtocolError extends IntercomBrokerError {
	override readonly name = "IntercomBrokerProtocolError" as const;
	declare readonly code: IntercomBrokerProtocolCode;
	declare readonly retryable: false;
	declare readonly hint: string;
	readonly feature: string;
	readonly brokerProtocolMin: number;
	readonly brokerProtocolMax: number;
	readonly requiredProtocol: number;

	constructor(fields: IntercomBrokerProtocolFields, options?: ErrorOptions) {
		super(
			PROTOCOL_CODE,
			`The Intercom broker speaks protocol ${fields.brokerProtocolMin} to ${fields.brokerProtocolMax}, older than the protocol ${fields.requiredProtocol} that ${fields.feature} needs (${PROTOCOL_CODE}). ${PROTOCOL_HINT}`,
			{
				...options,
				hint: PROTOCOL_HINT,
				retryable: false,
				fields: {
					feature: fields.feature,
					brokerProtocolMin: fields.brokerProtocolMin,
					brokerProtocolMax: fields.brokerProtocolMax,
					requiredProtocol: fields.requiredProtocol,
				},
			},
		);
		this.feature = fields.feature;
		this.brokerProtocolMin = fields.brokerProtocolMin;
		this.brokerProtocolMax = fields.brokerProtocolMax;
		this.requiredProtocol = fields.requiredProtocol;
	}
}

/**
 * #4538: a session of a newer Atomic version could not replace the older broker it found. `cause` is the failure of
 * the step named by `phase`. Retryable: the next session, or this one's next connection, tries again.
 */
export class IntercomBrokerUpgradeError extends IntercomBrokerError {
	override readonly name = "IntercomBrokerUpgradeError" as const;
	declare readonly code: IntercomBrokerUpgradeCode;
	declare readonly retryable: true;
	declare readonly hint: string;
	readonly phase: IntercomBrokerUpgradePhase;
	readonly previousPid: number;
	readonly previousProtocolMax: number;

	constructor(fields: IntercomBrokerUpgradeFields, options?: ErrorOptions) {
		super(
			UPGRADE_CODE,
			`Could not replace the older Intercom broker (pid ${fields.previousPid}, protocol ${fields.previousProtocolMax}) while ${UPGRADE_STEPS[fields.phase]} (${UPGRADE_CODE}). ${UPGRADE_HINTS[fields.phase]}`,
			{
				...options,
				hint: UPGRADE_HINTS[fields.phase],
				retryable: true,
				fields: {
					phase: fields.phase,
					previousPid: fields.previousPid,
					previousProtocolMax: fields.previousProtocolMax,
				},
			},
		);
		this.phase = fields.phase;
		this.previousPid = fields.previousPid;
		this.previousProtocolMax = fields.previousProtocolMax;
	}
}

/**
 * #4538: an Intercom broker asked to shut down was still running when the stop's bound expired. Retryable: the broker
 * normally exits within its own shutdown bound, so a later stop usually finds it gone.
 */
export class IntercomBrokerStopTimeoutError extends IntercomBrokerError {
	override readonly name = "IntercomBrokerStopTimeoutError" as const;
	declare readonly code: IntercomBrokerStopTimeoutCode;
	declare readonly retryable: true;
	declare readonly hint: string;
	readonly phase: IntercomBrokerStopTimeoutPhase = "stop";
	readonly pid: number;
	readonly timeoutMs: number;
	readonly elapsedMs: number;

	constructor(fields: IntercomBrokerStopTimeoutFields, options?: ErrorOptions) {
		super(
			STOP_TIMEOUT_CODE,
			`The Intercom broker (pid ${fields.pid}) did not exit within ${fields.timeoutMs} ms of its shutdown request (${STOP_TIMEOUT_CODE}). ${STOP_TIMEOUT_HINT}`,
			{
				...options,
				hint: STOP_TIMEOUT_HINT,
				retryable: true,
				fields: { phase: "stop", pid: fields.pid, timeoutMs: fields.timeoutMs, elapsedMs: fields.elapsedMs },
			},
		);
		this.pid = fields.pid;
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
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

/** True for an {@link IntercomBrokerProtocolError}, also one from another realm or process, by `name`, `code` and `feature`. */
export function isIntercomBrokerProtocolError(error: unknown): error is IntercomBrokerProtocolError {
	if (error instanceof IntercomBrokerProtocolError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown; readonly feature?: unknown };
	return candidate.name === PROTOCOL_NAME && candidate.code === PROTOCOL_CODE && typeof candidate.feature === "string";
}

/** True for an {@link IntercomBrokerUpgradeError}, also one from another realm or process, by `name`, `code` and `phase`. */
export function isIntercomBrokerUpgradeError(error: unknown): error is IntercomBrokerUpgradeError {
	if (error instanceof IntercomBrokerUpgradeError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown; readonly phase?: unknown };
	return (
		candidate.name === UPGRADE_NAME &&
		candidate.code === UPGRADE_CODE &&
		(candidate.phase === "stop" || candidate.phase === "start")
	);
}

/** True for an {@link IntercomBrokerStopTimeoutError}, also one from another realm or process, by `name`, `code` and `timeoutMs`. */
export function isIntercomBrokerStopTimeoutError(error: unknown): error is IntercomBrokerStopTimeoutError {
	if (error instanceof IntercomBrokerStopTimeoutError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown; readonly timeoutMs?: unknown };
	return (
		candidate.name === STOP_TIMEOUT_NAME &&
		candidate.code === STOP_TIMEOUT_CODE &&
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

function isProtocolVersion(value: IntercomBrokerErrorFieldValue | undefined): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

function protocolFields(fields: IntercomBrokerErrorFields): IntercomBrokerProtocolFields | undefined {
	const { feature, brokerProtocolMin, brokerProtocolMax, requiredProtocol } = fields;
	if (
		typeof feature !== "string" ||
		!isProtocolVersion(brokerProtocolMin) ||
		!isProtocolVersion(brokerProtocolMax) ||
		!isProtocolVersion(requiredProtocol)
	)
		return undefined;
	return { feature, brokerProtocolMin, brokerProtocolMax, requiredProtocol };
}

function upgradeFields(fields: IntercomBrokerErrorFields): IntercomBrokerUpgradeFields | undefined {
	const { phase, previousPid, previousProtocolMax } = fields;
	if ((phase !== "stop" && phase !== "start") || !isCount(previousPid) || !isProtocolVersion(previousProtocolMax))
		return undefined;
	return { phase, previousPid, previousProtocolMax };
}

function stopTimeoutFields(fields: IntercomBrokerErrorFields): IntercomBrokerStopTimeoutFields | undefined {
	const { phase, pid, timeoutMs, elapsedMs } = fields;
	if (phase !== "stop" || !isCount(pid) || !isCount(timeoutMs) || !isCount(elapsedMs)) return undefined;
	return { pid, timeoutMs, elapsedMs };
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
	if (form.name === PROTOCOL_NAME && form.code === PROTOCOL_CODE) {
		const protocol = protocolFields(fields);
		if (protocol !== undefined) return new IntercomBrokerProtocolError(protocol, { cause });
	}
	if (form.name === UPGRADE_NAME && form.code === UPGRADE_CODE) {
		const upgrade = upgradeFields(fields);
		if (upgrade !== undefined) return new IntercomBrokerUpgradeError(upgrade, { cause });
	}
	if (form.name === STOP_TIMEOUT_NAME && form.code === STOP_TIMEOUT_CODE) {
		const stop = stopTimeoutFields(fields);
		if (stop !== undefined) return new IntercomBrokerStopTimeoutError(stop, { cause });
	}
	return new IntercomBrokerError(form.code, form.message, {
		name: form.name,
		hint: form.hint,
		retryable: form.retryable,
		fields,
		cause,
	});
}
