import { causeChain, failureMessage, hasIdentity } from "./error-cause-chain.js";

/** Where a local worker setting came from: `RunOpts.localWorkers`, or `workflows.localWorkers` in settings. */
export type LocalWorkerOptionsSource = "sdk" | "settings";

/** The local worker settings {@link LocalWorkerOptionsError} validates. */
export type LocalWorkerTimingOption = "leaseMs" | "heartbeatMs";

/** `invalid-lease`: `leaseMs` is out of range. `invalid-heartbeat`: `heartbeatMs` is out of range for the lease. */
export type LocalWorkerOptionsErrorCode = "invalid-lease" | "invalid-heartbeat";

/** Why the value was refused. */
export type LocalWorkerOptionsErrorReason = "not-an-integer" | "below-minimum" | "above-maximum";

export const LOCAL_WORKER_OPTIONS_SOURCES: readonly LocalWorkerOptionsSource[] = ["sdk", "settings"];
export const LOCAL_WORKER_TIMING_OPTIONS: readonly LocalWorkerTimingOption[] = ["leaseMs", "heartbeatMs"];
export const LOCAL_WORKER_OPTIONS_REASONS: readonly LocalWorkerOptionsErrorReason[] = [
	"not-an-integer",
	"below-minimum",
	"above-maximum",
];

/** Every code of the {@link LocalWorkerPoolError} family. Codes are public API: none is renamed or reused. */
export type LocalWorkerPoolErrorCode =
	| LocalWorkerOptionsErrorCode
	| "pool_not_initialized"
	| "stale_work_lease"
	| "publication_rejected"
	| "work_attempt_fenced"
	| "pool_protocol_invalid";

const LOCAL_WORKER_POOL_ERROR_CODES: ReadonlySet<string> = new Set<LocalWorkerPoolErrorCode>([
	"invalid-lease",
	"invalid-heartbeat",
	"pool_not_initialized",
	"stale_work_lease",
	"publication_rejected",
	"work_attempt_fenced",
	"pool_protocol_invalid",
]);

export interface LocalWorkerPoolErrorOptions extends ErrorOptions {
	/** Whether replaying the child under the pool's current authority can succeed; false unless set. */
	readonly retryable?: boolean;
}

/**
 * The family of local worker pool errors: its settings, pool state, work fencing, publication and pool protocol
 * failures. Catch it for any of them, or a concrete class for one; branch on `code`, never on `message`. `retryable`
 * is true only where replaying the child under the pool's current authority can succeed.
 */
export class LocalWorkerPoolError extends Error {
	override readonly name: string = "LocalWorkerPoolError";
	readonly code: LocalWorkerPoolErrorCode;
	/** What to do about it, without the rest of the message. */
	readonly hint: string;
	readonly retryable: boolean;

	constructor(code: LocalWorkerPoolErrorCode, message: string, hint: string, options?: LocalWorkerPoolErrorOptions) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.code = code;
		this.hint = hint;
		this.retryable = options?.retryable === true;
	}
}

const OPTIONS_CODES: Readonly<Record<LocalWorkerTimingOption, LocalWorkerOptionsErrorCode>> = {
	leaseMs: "invalid-lease",
	heartbeatMs: "invalid-heartbeat",
};

const OPTIONS_SUBJECTS: Readonly<Record<LocalWorkerTimingOption, string>> = {
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
	/** What an omitted value means, as the hint says it. */
	readonly omitted: string;
	constructor(fields: LocalWorkerOptionsErrorFields) {
		const code = OPTIONS_CODES[fields.option];
		const field = `${fields.source === "settings" ? "workflows." : ""}localWorkers.${fields.option}`;
		const hint = `Set ${field} to an integer from ${fields.minimum} to ${fields.maximum} ms, or omit it ${fields.omitted}.`;
		super(
			code,
			`Invalid local worker ${OPTIONS_SUBJECTS[fields.option]}: ${field} is ${fields.received}, ${reasonText(fields)} (${code}). ${hint}`,
			hint,
		);
		this.source = fields.source;
		this.field = field;
		this.option = fields.option;
		this.reason = fields.reason;
		this.received = fields.received;
		this.minimum = fields.minimum;
		this.maximum = fields.maximum;
		this.omitted = fields.omitted;
	}
}

export interface PoolNotInitializedFields {
	/** The root the operation ran for; undefined when the pool was used before any root was prepared. */
	readonly root?: string;
}

/**
 * A pool operation ran for a root whose pool no coordinator initialized under the root's lease, or before the pool
 * was prepared for a root at all.
 */
export class PoolNotInitializedError extends LocalWorkerPoolError {
	override readonly name = "PoolNotInitializedError" as const;
	declare readonly code: "pool_not_initialized";
	declare readonly retryable: false;
	readonly root?: string;

	constructor(fields: PoolNotInitializedFields, options?: ErrorOptions) {
		const hint = "Initialize the root's pool under its lease before running pool operations for it.";
		const subject = fields.root === undefined ? "no root prepared" : `root ${fields.root}`;
		super(
			"pool_not_initialized",
			failureMessage("Worker pool is not initialized", subject, "pool_not_initialized", hint),
			hint,
			options,
		);
		this.root = fields.root;
	}
}

/** Why an attempt's work lease no longer authorizes its writes. */
export type StaleWorkLeaseReason =
	| "missing"
	| "not-leased"
	| "generation-mismatch"
	| "worker-mismatch"
	| "epoch-mismatch"
	| "expired"
	| "root-not-running"
	| "fenced"
	| "superseded";

export const STALE_WORK_LEASE_REASONS: readonly StaleWorkLeaseReason[] = [
	"missing",
	"not-leased",
	"generation-mismatch",
	"worker-mismatch",
	"epoch-mismatch",
	"expired",
	"root-not-running",
	"fenced",
	"superseded",
];

export interface StaleWorkLeaseFields {
	readonly root: string;
	readonly workId: string;
	readonly generation: number;
	readonly reason: StaleWorkLeaseReason;
}

/**
 * A work attempt's write or request was refused because the attempt no longer owns its work. Nothing was written. The
 * child replays under the pool's current attempt: repeating the refused write unchanged is never authorized.
 */
export class StaleWorkLeaseError extends LocalWorkerPoolError {
	override readonly name = "StaleWorkLeaseError" as const;
	declare readonly code: "stale_work_lease";
	declare readonly retryable: true;
	readonly root: string;
	readonly workId: string;
	readonly generation: number;
	readonly reason: StaleWorkLeaseReason;

	constructor(fields: StaleWorkLeaseFields, options?: ErrorOptions) {
		const hint = "The pool replays the child from its last checkpoint under the attempt that owns its work now.";
		super(
			"stale_work_lease",
			failureMessage(
				"Work attempt is no longer current",
				`work ${fields.workId} generation ${fields.generation} of root ${fields.root} (${fields.reason})`,
				"stale_work_lease",
				hint,
			),
			hint,
			{ ...options, retryable: true },
		);
		this.root = fields.root;
		this.workId = fields.workId;
		this.generation = fields.generation;
		this.reason = fields.reason;
	}
}

/** Why the root refused a pooled run's publication or a delivery to one of its stage sessions. */
export type PublicationRejectedReason =
	| "outside-subtree"
	| "boundary-unlinked"
	| "stale-lease"
	| "session-mismatch"
	| "session-replaced";

export const PUBLICATION_REJECTED_REASONS: readonly PublicationRejectedReason[] = [
	"outside-subtree",
	"boundary-unlinked",
	"stale-lease",
	"session-mismatch",
	"session-replaced",
];

const PUBLICATION_HINTS: Readonly<Record<PublicationRejectedReason, string>> = {
	"outside-subtree":
		"A worker publishes only the runs of the child it runs; the publication was not applied and the child cannot publish that run.",
	"boundary-unlinked":
		"The root run does not link the work's boundary stage to its child run yet; the publication was not applied.",
	"stale-lease":
		"The publishing attempt no longer owns its work; the pool replays the child under its current attempt.",
	"session-mismatch": "Deliver to the session the stage published; reopen the stage and send the message again.",
	"session-replaced": "Undelivered messages stay queued and reach the stage's new session on its next drain.",
};

export interface PublicationRejectedFields {
	readonly root: string;
	readonly workId: string;
	readonly generation: number;
	readonly reason: PublicationRejectedReason;
	readonly runId?: string;
	readonly stageId?: string;
	readonly sessionId?: string;
}

/** The root refused what a work attempt published, or a delivery bound to a stage session it published. */
export class PublicationRejectedError extends LocalWorkerPoolError {
	override readonly name = "PublicationRejectedError" as const;
	declare readonly code: "publication_rejected";
	readonly root: string;
	readonly workId: string;
	readonly generation: number;
	readonly reason: PublicationRejectedReason;
	readonly runId?: string;
	readonly stageId?: string;
	readonly sessionId?: string;

	constructor(fields: PublicationRejectedFields, options?: ErrorOptions) {
		const hint = PUBLICATION_HINTS[fields.reason];
		const target = [
			fields.runId === undefined ? undefined : `run ${fields.runId}`,
			fields.stageId === undefined ? undefined : `stage ${fields.stageId}`,
			fields.sessionId === undefined ? undefined : `session ${fields.sessionId}`,
		].filter((part) => part !== undefined);
		super(
			"publication_rejected",
			failureMessage(
				`Pool stage publication rejected (${fields.reason})`,
				`${target.length === 0 ? "" : `${target.join(", ")} of `}work ${fields.workId} generation ${fields.generation}`,
				"publication_rejected",
				hint,
			),
			hint,
			{ ...options, retryable: fields.reason === "stale-lease" },
		);
		this.root = fields.root;
		this.workId = fields.workId;
		this.generation = fields.generation;
		this.reason = fields.reason;
		this.runId = fields.runId;
		this.stageId = fields.stageId;
		this.sessionId = fields.sessionId;
	}
}

export interface WorkAttemptFencedFields {
	readonly workId: string;
	readonly generation: number;
}

/**
 * A worker ended its attempt because the pool refused it (its `cause` says why) or its run failed on a fault of the
 * pool. It is not a crash of the worker and not a failure of the child: the child replays within its attempt limit.
 */
export class WorkAttemptFencedError extends LocalWorkerPoolError {
	override readonly name = "WorkAttemptFencedError" as const;
	declare readonly code: "work_attempt_fenced";
	declare readonly retryable: true;
	readonly workId: string;
	readonly generation: number;

	constructor(fields: WorkAttemptFencedFields, options?: ErrorOptions) {
		const hint = "The child replays from its last checkpoint; see `cause` for what ended the attempt.";
		super(
			"work_attempt_fenced",
			failureMessage(
				"Work attempt fenced",
				`work ${fields.workId} generation ${fields.generation}`,
				"work_attempt_fenced",
				hint,
			),
			hint,
			{ ...options, retryable: true },
		);
		this.workId = fields.workId;
		this.generation = fields.generation;
	}
}

export interface PoolProtocolFields {
	/** The message member that failed validation, as a path such as `error.fields.generation`. */
	readonly field: string;
	/** What the receiver expected there. */
	readonly expected: string;
}

/** A pool process received an IPC message it could not validate, so it acted on none of it. */
export class PoolProtocolError extends LocalWorkerPoolError {
	override readonly name = "PoolProtocolError" as const;
	declare readonly code: "pool_protocol_invalid";
	declare readonly retryable: false;
	readonly field: string;
	readonly expected: string;

	constructor(fields: PoolProtocolFields, options?: ErrorOptions) {
		const hint = "Every process of a pool must run the same Atomic version; restart the root after an upgrade.";
		super(
			"pool_protocol_invalid",
			failureMessage(
				"Invalid worker pool message",
				`${fields.field} is not ${fields.expected}`,
				"pool_protocol_invalid",
				hint,
			),
			hint,
			options,
		);
		this.field = fields.field;
		this.expected = fields.expected;
	}
}

const LOCAL_WORKER_POOL_ERROR_NAMES: ReadonlySet<string> = new Set([
	"LocalWorkerPoolError",
	"LocalWorkerOptionsError",
	"PoolNotInitializedError",
	"StaleWorkLeaseError",
	"PublicationRejectedError",
	"WorkAttemptFencedError",
	"PoolProtocolError",
]);

/**
 * Whether `value` is a local worker pool error: an instance, or an error from another process or realm that names a
 * class of this family and carries one of its codes. A code alone is not enough: `stale_work_lease` is also an
 * infrastructure fault code.
 */
export function isLocalWorkerPoolError(value: unknown): value is LocalWorkerPoolError {
	return (
		value instanceof LocalWorkerPoolError ||
		hasIdentity(value, LOCAL_WORKER_POOL_ERROR_NAMES, LOCAL_WORKER_POOL_ERROR_CODES)
	);
}

/** The first {@link LocalWorkerPoolError} in `error`'s cause chain, looking at most eight errors deep. */
export function findLocalWorkerPoolError(error: unknown): LocalWorkerPoolError | undefined {
	return causeChain(error).find(isLocalWorkerPoolError);
}

function guard<T extends LocalWorkerPoolError>(
	type: abstract new (...args: never[]) => T,
	name: string,
	codes: readonly LocalWorkerPoolErrorCode[],
) {
	const names = new Set([name]);
	const known = new Set<string>(codes);
	return (value: unknown): value is T => value instanceof type || hasIdentity(value, names, known);
}

/** Whether `value` is a {@link LocalWorkerOptionsError}, also one that crossed a realm or process boundary. */
export const isLocalWorkerOptionsError = guard(LocalWorkerOptionsError, "LocalWorkerOptionsError", [
	"invalid-lease",
	"invalid-heartbeat",
]);

export const isPoolNotInitializedError = guard(PoolNotInitializedError, "PoolNotInitializedError", [
	"pool_not_initialized",
]);
export const isStaleWorkLeaseError = guard(StaleWorkLeaseError, "StaleWorkLeaseError", ["stale_work_lease"]);
export const isPublicationRejectedError = guard(PublicationRejectedError, "PublicationRejectedError", [
	"publication_rejected",
]);
export const isWorkAttemptFencedError = guard(WorkAttemptFencedError, "WorkAttemptFencedError", [
	"work_attempt_fenced",
]);
export const isPoolProtocolError = guard(PoolProtocolError, "PoolProtocolError", ["pool_protocol_invalid"]);

/** Whether a stale work lease refused anything in `error`'s cause chain: the attempt is fenced, not failed. */
export function causedByStaleWorkLease(error: unknown): boolean {
	return causeChain(error).some(isStaleWorkLeaseError);
}
