/** Where a local worker setting came from: `RunOpts.localWorkers`, or `workflows.localWorkers` in settings. */
export type LocalWorkerOptionsSource = "sdk" | "settings";

/** The local worker settings {@link LocalWorkerOptionsError} validates. */
export type LocalWorkerTimingOption = "leaseMs" | "heartbeatMs";

/** Every code of the {@link LocalWorkerPoolError} family. */
export type LocalWorkerPoolErrorCode = LocalWorkerOptionsErrorCode;

/** `invalid-lease`: `leaseMs` is out of range. `invalid-heartbeat`: `heartbeatMs` is out of range for the lease. */
export type LocalWorkerOptionsErrorCode = "invalid-lease" | "invalid-heartbeat";

/** Why the value was refused. */
export type LocalWorkerOptionsErrorReason = "not-an-integer" | "below-minimum" | "above-maximum";

const LOCAL_WORKER_POOL_ERROR_NAMES: ReadonlySet<unknown> = new Set([
	"LocalWorkerPoolError",
	"LocalWorkerOptionsError",
]);
const MAX_CAUSE_DEPTH = 8;

/** The family of local worker pool errors. Catch it, or a concrete class, and branch on `code`. */
export class LocalWorkerPoolError extends Error {
	override readonly name: string = "LocalWorkerPoolError";
	readonly code: LocalWorkerPoolErrorCode;
	/** What to do about it, without the rest of the message. */
	readonly hint: string;
	readonly retryable: boolean = false;
	constructor(code: LocalWorkerPoolErrorCode, message: string, hint: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		this.hint = hint;
	}
}

const CODES: Readonly<Record<LocalWorkerTimingOption, LocalWorkerOptionsErrorCode>> = {
	leaseMs: "invalid-lease",
	heartbeatMs: "invalid-heartbeat",
};

const SUBJECTS: Readonly<Record<LocalWorkerTimingOption, string>> = {
	leaseMs: "lease",
	heartbeatMs: "heartbeat",
};

export interface LocalWorkerOptionsErrorFields {
	readonly source: LocalWorkerOptionsSource;
	readonly option: LocalWorkerTimingOption;
	readonly reason: LocalWorkerOptionsErrorReason;
	/** The refused value, as text. */
	readonly received: string;
	/** Smallest accepted value, in milliseconds. */
	readonly minimum: number;
	/** Largest accepted value, in milliseconds; for `heartbeatMs`, half of the lease. */
	readonly maximum: number;
	/** What an omitted value means, for the hint. */
	readonly omitted: string;
}

function reasonText(fields: LocalWorkerOptionsErrorFields): string {
	if (fields.reason === "not-an-integer") return "not an integer number of milliseconds";
	if (fields.reason === "below-minimum") return `below the minimum ${fields.minimum} ms`;
	return `above the maximum ${fields.maximum} ms`;
}

/**
 * A `localWorkers` lease or heartbeat setting is out of range. It is thrown before the run starts, so nothing was
 * written for it. Not retryable: correct the setting.
 */
export class LocalWorkerOptionsError extends LocalWorkerPoolError {
	override readonly name = "LocalWorkerOptionsError" as const;
	declare readonly code: LocalWorkerOptionsErrorCode;
	override readonly retryable = false as const;
	readonly source: LocalWorkerOptionsSource;
	/** The setting's full path: `localWorkers.<option>` for the SDK, `workflows.localWorkers.<option>` for settings. */
	readonly field: string;
	readonly option: LocalWorkerTimingOption;
	readonly reason: LocalWorkerOptionsErrorReason;
	readonly received: string;
	readonly minimum: number;
	readonly maximum: number;
	constructor(fields: LocalWorkerOptionsErrorFields) {
		const code = CODES[fields.option];
		const field = `${fields.source === "settings" ? "workflows." : ""}localWorkers.${fields.option}`;
		const hint = `Set ${field} to an integer from ${fields.minimum} to ${fields.maximum} ms, or omit it ${fields.omitted}.`;
		super(
			code,
			`Invalid local worker ${SUBJECTS[fields.option]}: ${field} is ${fields.received}, ${reasonText(fields)} (${code}). ${hint}`,
			hint,
		);
		this.source = fields.source;
		this.field = field;
		this.option = fields.option;
		this.reason = fields.reason;
		this.received = fields.received;
		this.minimum = fields.minimum;
		this.maximum = fields.maximum;
	}
}

const OPTIONS_ERROR_CODES: ReadonlySet<unknown> = new Set<LocalWorkerOptionsErrorCode>(Object.values(CODES));
const OPTIONS_ERROR_NAMES: ReadonlySet<unknown> = new Set(["LocalWorkerOptionsError"]);

function hasStructure(value: unknown, names: ReadonlySet<unknown>, codes?: ReadonlySet<unknown>): boolean {
	if (value === null || value === undefined) return false;
	const { name, code } = value as { readonly name?: unknown; readonly code?: unknown };
	return names.has(name) && typeof code === "string" && (codes === undefined || codes.has(code));
}

/** Whether `value` is a {@link LocalWorkerPoolError}, also one that crossed a realm or process boundary. */
export function isLocalWorkerPoolError(value: unknown): value is LocalWorkerPoolError {
	return value instanceof LocalWorkerPoolError || hasStructure(value, LOCAL_WORKER_POOL_ERROR_NAMES);
}

/** Whether `value` is a {@link LocalWorkerOptionsError}, also one that crossed a realm or process boundary. */
export function isLocalWorkerOptionsError(value: unknown): value is LocalWorkerOptionsError {
	return value instanceof LocalWorkerOptionsError || hasStructure(value, OPTIONS_ERROR_NAMES, OPTIONS_ERROR_CODES);
}

/** The first {@link LocalWorkerPoolError} in `error`'s cause chain, looking at most eight errors deep. */
export function findLocalWorkerPoolError(error: unknown): LocalWorkerPoolError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isLocalWorkerPoolError(current)) return current;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return undefined;
}
