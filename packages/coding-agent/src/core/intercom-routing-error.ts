export type IntercomRoutingErrorCode =
	| "broker-routing-mismatch"
	| "broker-routing-unavailable"
	| "broker-routing-timeout"
	| "broker-routing-changed";

export type IntercomRoutingMismatchReason = "implicit-default-on-remote-broker" | "shared-storage-not-on-broker";

export type IntercomRoutingUnavailableReason = "unsupported" | "malformed";

export type IntercomRoutingPhase = "broker_status" | "register";

const ROUTING_ERROR_CODES: ReadonlySet<string> = new Set<IntercomRoutingErrorCode>([
	"broker-routing-mismatch",
	"broker-routing-unavailable",
	"broker-routing-timeout",
	"broker-routing-changed",
]);

const RETRY_HINT =
	"The session checks the broker again and retries; run `atomic intercom restart` if it keeps failing.";
const REPLACE_BROKER_HINT = "Run `atomic intercom restart` to replace the broker, then retry.";
const MISMATCH_HINTS: Readonly<Record<IntercomRoutingMismatchReason, string>> = {
	"implicit-default-on-remote-broker":
		"Restart this session so it joins its project group, or set ATOMIC_INTERCOM_GROUP to choose its group.",
	"shared-storage-not-on-broker":
		"Run `atomic intercom restart` so the broker reads this session's storage selection, then restart this session.",
};
const MISMATCH_SUMMARIES: Readonly<Record<IntercomRoutingMismatchReason, (group: string) => string>> = {
	"implicit-default-on-remote-broker": (group) =>
		`The Intercom broker now routes across machines, but this session joined it as a single-machine session in the "${group}" group, which every teammate's session on the shared database could address`,
	"shared-storage-not-on-broker": (group) =>
		`This session selects shared storage, but the running Intercom broker does not route through it and would keep the session in the single-machine "${group}" group`,
};

export class IntercomRoutingError extends Error {
	override readonly name: string = "IntercomRoutingError";
	readonly code: IntercomRoutingErrorCode;
	readonly hint: string;
	readonly retryable: boolean;

	constructor(
		code: IntercomRoutingErrorCode,
		message: string,
		fields: { readonly hint: string; readonly retryable: boolean; readonly cause?: Error },
	) {
		super(message, fields.cause === undefined ? undefined : { cause: fields.cause });
		this.code = code;
		this.hint = fields.hint;
		this.retryable = fields.retryable;
	}
}

export class IntercomRoutingMismatchError extends IntercomRoutingError {
	override readonly name = "IntercomRoutingMismatchError" as const;
	declare readonly code: "broker-routing-mismatch";
	declare readonly retryable: false;
	readonly reason: IntercomRoutingMismatchReason;
	readonly group: string;

	constructor(reason: IntercomRoutingMismatchReason, group: string) {
		super(
			"broker-routing-mismatch",
			`${MISMATCH_SUMMARIES[reason](group)} (broker-routing-mismatch). ${MISMATCH_HINTS[reason]}`,
			{ hint: MISMATCH_HINTS[reason], retryable: false },
		);
		this.reason = reason;
		this.group = group;
	}
}

export class IntercomRoutingUnavailableError extends IntercomRoutingError {
	override readonly name = "IntercomRoutingUnavailableError" as const;
	declare readonly code: "broker-routing-unavailable";
	declare readonly retryable: true;
	readonly reason: IntercomRoutingUnavailableReason;
	readonly phase: IntercomRoutingPhase;

	constructor(
		reason: IntercomRoutingUnavailableReason,
		phase: IntercomRoutingPhase,
		options: { readonly cause?: Error } = {},
	) {
		super(
			"broker-routing-unavailable",
			`The Intercom broker did not report its routing state (${phase}: ${reason}), so this session cannot tell whether it routes across machines (broker-routing-unavailable). ${REPLACE_BROKER_HINT}`,
			{ hint: REPLACE_BROKER_HINT, retryable: true, cause: options.cause },
		);
		this.reason = reason;
		this.phase = phase;
	}
}

export class IntercomRoutingTimeoutError extends IntercomRoutingError {
	override readonly name = "IntercomRoutingTimeoutError" as const;
	declare readonly code: "broker-routing-timeout";
	declare readonly retryable: true;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly phase: IntercomRoutingPhase;

	constructor(fields: {
		readonly timeoutMs: number;
		readonly elapsedMs: number;
		readonly phase: IntercomRoutingPhase;
	}) {
		super(
			"broker-routing-timeout",
			`The Intercom broker did not report its routing state within ${fields.timeoutMs} ms (${fields.phase}), so this session cannot tell whether it routes across machines (broker-routing-timeout). ${REPLACE_BROKER_HINT}`,
			{ hint: REPLACE_BROKER_HINT, retryable: true },
		);
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
		this.phase = fields.phase;
	}
}

export class IntercomRoutingChangedError extends IntercomRoutingError {
	override readonly name = "IntercomRoutingChangedError" as const;
	declare readonly code: "broker-routing-changed";
	declare readonly retryable: true;
	readonly expectedAcrossMachines: boolean;

	constructor(expectedAcrossMachines: boolean) {
		super(
			"broker-routing-changed",
			`The Intercom broker changed how it routes between this session's check and its registration, so the registration was refused before it took effect (broker-routing-changed). ${RETRY_HINT}`,
			{ hint: RETRY_HINT, retryable: true },
		);
		this.expectedAcrossMachines = expectedAcrossMachines;
	}
}

function structural(error: unknown, name: string, code: IntercomRoutingErrorCode): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown };
	return candidate.name === name && candidate.code === code;
}

export function isIntercomRoutingError(error: unknown): error is IntercomRoutingError {
	if (error instanceof IntercomRoutingError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly code?: unknown; readonly name?: unknown };
	return (
		typeof candidate.code === "string" &&
		ROUTING_ERROR_CODES.has(candidate.code) &&
		typeof candidate.name === "string" &&
		candidate.name.startsWith("IntercomRouting")
	);
}

export function isIntercomRoutingMismatchError(error: unknown): error is IntercomRoutingMismatchError {
	return (
		error instanceof IntercomRoutingMismatchError ||
		structural(error, "IntercomRoutingMismatchError", "broker-routing-mismatch")
	);
}

export function isIntercomRoutingUnavailableError(error: unknown): error is IntercomRoutingUnavailableError {
	return (
		error instanceof IntercomRoutingUnavailableError ||
		structural(error, "IntercomRoutingUnavailableError", "broker-routing-unavailable")
	);
}

export function isIntercomRoutingTimeoutError(error: unknown): error is IntercomRoutingTimeoutError {
	return (
		error instanceof IntercomRoutingTimeoutError ||
		structural(error, "IntercomRoutingTimeoutError", "broker-routing-timeout")
	);
}

export function isIntercomRoutingChangedError(error: unknown): error is IntercomRoutingChangedError {
	return (
		error instanceof IntercomRoutingChangedError ||
		structural(error, "IntercomRoutingChangedError", "broker-routing-changed")
	);
}

const MAX_CAUSE_DEPTH = 8;

export function isRetryableIntercomRoutingError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
		if (isIntercomRoutingError(current) && current.retryable === true) return true;
		if (typeof current !== "object" || current === null) return false;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return false;
}
