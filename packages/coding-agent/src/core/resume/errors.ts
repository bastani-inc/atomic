import { SESSION_STORAGE_JOIN } from "../agent-rehydrate-errors.ts";
import {
	findInCauseChain,
	rehydrateErrorCause,
	type SerializedErrorCause,
	serializeErrorCause,
} from "../error-contract.ts";

export type ResumeErrorFieldValue =
	| string
	| number
	| boolean
	| null
	| readonly ResumeErrorFieldValue[]
	| { readonly [key: string]: ResumeErrorFieldValue };
export type ResumeErrorFields = { readonly [key: string]: ResumeErrorFieldValue };

/** What a resume looked up: an interactive session or a workflow run. */
export type ResumeSubject = "session" | "run";

export type ResumeNotFoundErrorCode = "not-found";
/**
 * `local-storage-not-joined`: this node uses storage only it can read, so work recorded on other nodes is invisible.
 * `shared-miss`: the shared storage was read and holds no match.
 */
export type ResumeNotFoundReason = "local-storage-not-joined" | "shared-miss";
export type ResumePreconditionErrorCode = "preconditions-unmet";
export type ResumeSetupHookErrorCode = "setup-hook-failed" | "setup-hook-timed-out";
export type ResumeCatalogUnavailableErrorCode = "catalog-unavailable";
export type ResumeCatalogTimeoutErrorCode = "catalog-timeout";
export type ResumeErrorCode =
	| ResumeNotFoundErrorCode
	| ResumePreconditionErrorCode
	| ResumeSetupHookErrorCode
	| ResumeCatalogUnavailableErrorCode
	| ResumeCatalogTimeoutErrorCode;
export type ResumeErrorName =
	| "ResumeError"
	| "ResumeNotFoundError"
	| "ResumePreconditionError"
	| "ResumeSetupHookError"
	| "ResumeCatalogUnavailableError"
	| "ResumeCatalogTimeoutError";

/** The entry point that ran the check, for messages and fields. */
export type ResumeEntryPoint = "cli" | "switch-session" | "create-agent-session" | "workflow-resume" | "rehydrate";

/**
 * One unmet precondition: `subject` names the adapter, variable, file or hook (never a secret value), `why` says
 * what this resume needs it for, and `fix` is the command or setting that supplies it. `checkout` is the recorded
 * checkout path a precondition of restoring that checkout belongs to; problems that apply to the whole resume omit it.
 */
export type ResumePreconditionProblemCode =
	| "adapter-not-installed"
	| "credential-missing"
	| "credential-unreadable"
	| "git-unavailable"
	| "setup-hook-missing";
export interface ResumePreconditionProblem {
	readonly code: ResumePreconditionProblemCode;
	readonly subject: string;
	readonly why: string;
	readonly fix: string;
	readonly checkout?: string;
}

/**
 * Base of every failure that stops a session or workflow run from resuming on this node. Branch on `code` or the
 * class, never on `message`. `fields` holds the same JSON-safe facts as the typed properties.
 */
export class ResumeError extends Error {
	override readonly name: ResumeErrorName = "ResumeError";
	readonly code: ResumeErrorCode;
	readonly hint: string;
	readonly retryable: boolean = false;
	readonly fields: ResumeErrorFields;

	constructor(code: ResumeErrorCode, summary: string, hint: string, fields: ResumeErrorFields, cause?: Error) {
		super(`${summary} (${code}). ${hint}`, cause === undefined ? undefined : { cause });
		this.code = code;
		this.hint = hint;
		this.fields = Object.freeze({ ...fields });
		Object.assign(this, fields);
	}
}

export interface ResumeNotFoundErrorFields {
	/** Run ids that match nothing are reported by the journal catalog's own `run-not-found` error. */
	readonly subject: "session";
	/** The session id or id prefix that was looked up. */
	readonly id: string;
	readonly reason: ResumeNotFoundReason;
	/** The storage adapter that was searched, and for local storage its file or directory. Never a URL or token. */
	readonly storage: string;
}

/** The session or run id matches nothing this node can read. */
export class ResumeNotFoundError extends ResumeError {
	override readonly name = "ResumeNotFoundError" as const;
	declare readonly code: ResumeNotFoundErrorCode;
	declare readonly subject: "session";
	declare readonly id: string;
	declare readonly reason: ResumeNotFoundReason;
	declare readonly storage: string;

	constructor(fields: ResumeNotFoundErrorFields, cause?: Error) {
		const missing = `No session found matching '${fields.id}'`;
		const [summary, hint] =
			fields.reason === "local-storage-not-joined"
				? [
						`${missing}: this node uses local-only storage (${fields.storage}) and is not joined to the shared storage where other nodes record their work`,
						`Join this node's sessions to the shared storage with ${SESSION_STORAGE_JOIN}, then resume again.`,
					]
				: [
						`${missing} in the shared storage (${fields.storage})`,
						"Check the id, and that every node uses the same storage and prefix (`atomic storage status`).",
					];
		super("not-found", summary, hint, { ...fields }, cause);
	}
}

export interface ResumePreconditionErrorFields {
	readonly entryPoint: ResumeEntryPoint;
	readonly problems: readonly ResumePreconditionProblem[];
}

/** Setup this resume depends on is missing. Every unmet precondition found in one pass is listed in `problems`. */
export class ResumePreconditionError extends ResumeError {
	override readonly name = "ResumePreconditionError" as const;
	declare readonly code: ResumePreconditionErrorCode;
	declare readonly entryPoint: ResumeEntryPoint;
	declare readonly problems: readonly ResumePreconditionProblem[];

	constructor(fields: ResumePreconditionErrorFields, cause?: Error) {
		if (fields.problems.length === 0) throw new RangeError("ResumePreconditionError needs at least one problem");
		super(
			"preconditions-unmet",
			`Cannot resume here: ${fields.problems.map((problem) => `${problem.subject} (${problem.code}): ${problem.why}`).join("; ")}`,
			[...new Set(fields.problems.map((problem) => problem.fix))].join(" Then: "),
			{ entryPoint: fields.entryPoint, problems: fields.problems.map((problem) => ({ ...problem })) },
			cause,
		);
	}
}

export interface ResumeSetupHookErrorFields {
	/** `.atomic/setup` or the configured command's setting name. */
	readonly hook: string;
	readonly worktree: string;
	/** The recorded environment fingerprint the hook was asked to materialize. */
	readonly envHash: string;
	readonly exitStatus: number | null;
	readonly signal: string | null;
	/** The hook's captured output. */
	readonly logPath: string;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
}

/** The setup hook a restored worktree needs ran and did not succeed. Resuming again runs it again. */
export class ResumeSetupHookError extends ResumeError {
	override readonly name = "ResumeSetupHookError" as const;
	declare readonly code: ResumeSetupHookErrorCode;
	declare readonly hook: string;
	declare readonly worktree: string;
	declare readonly envHash: string;
	declare readonly exitStatus: number | null;
	declare readonly signal: string | null;
	declare readonly logPath: string;
	declare readonly timeoutMs: number;
	declare readonly elapsedMs: number;
	readonly phase = "setup-hook" as const;

	constructor(code: ResumeSetupHookErrorCode, fields: ResumeSetupHookErrorFields, cause?: Error) {
		const outcome =
			code === "setup-hook-timed-out"
				? `did not finish within ${fields.timeoutMs} ms`
				: fields.signal !== null
					? `was stopped by ${fields.signal}`
					: fields.exitStatus === null
						? "could not be started"
						: `exited with status ${fields.exitStatus}`;
		super(
			code,
			`The setup hook ${fields.hook} ${outcome} in ${fields.worktree}`,
			`Fix the hook (its output is in ${fields.logPath}), then resume again; the hook runs again.`,
			{ ...fields },
			cause,
		);
	}
}

const LOOKED_UP: Readonly<Record<ResumeSubject, string>> = { session: "the session", run: "the workflow run" };

export interface ResumeCatalogUnavailableErrorFields {
	readonly subject: ResumeSubject;
	/** The id or selector being looked up, or null for a picker or "most recent" lookup. */
	readonly id: string | null;
	/** The storage adapter that could not be reached. Never a URL or token. */
	readonly storage: string;
	readonly phase: "catalog-lookup";
}

/**
 * The storage that records sessions or runs could not be reached while a resume looked one up. Nothing was changed,
 * so the resume can be retried as-is once the storage is reachable.
 */
export class ResumeCatalogUnavailableError extends ResumeError {
	override readonly name = "ResumeCatalogUnavailableError" as const;
	declare readonly code: ResumeCatalogUnavailableErrorCode;
	override readonly retryable = true;
	declare readonly subject: ResumeSubject;
	declare readonly id: string | null;
	declare readonly storage: string;
	declare readonly phase: "catalog-lookup";

	constructor(fields: ResumeCatalogUnavailableErrorFields, cause?: Error) {
		super(
			"catalog-unavailable",
			`Cannot look up ${LOOKED_UP[fields.subject]}${fields.id === null ? "" : ` ${fields.id}`}: the storage (${fields.storage}) could not be reached`,
			"Check that this node can reach the shared storage (`atomic storage status`), then resume again; nothing was changed.",
			{ ...fields },
			cause,
		);
	}
}

export interface ResumeCatalogTimeoutErrorFields {
	readonly subject: ResumeSubject;
	readonly id: string | null;
	/** The storage adapter that did not answer. Never a URL or token. */
	readonly storage: string;
	readonly phase: "catalog-lookup";
	readonly timeoutMs: number;
	readonly elapsedMs: number;
}

/**
 * The storage that records sessions or runs did not answer a resume's lookup within its deadline, as during a network
 * partition. Nothing was changed, so the resume can be retried as-is once the storage answers.
 */
export class ResumeCatalogTimeoutError extends ResumeError {
	override readonly name = "ResumeCatalogTimeoutError" as const;
	declare readonly code: ResumeCatalogTimeoutErrorCode;
	override readonly retryable = true;
	declare readonly subject: ResumeSubject;
	declare readonly id: string | null;
	declare readonly storage: string;
	declare readonly phase: "catalog-lookup";
	declare readonly timeoutMs: number;
	declare readonly elapsedMs: number;

	constructor(fields: ResumeCatalogTimeoutErrorFields, cause?: Error) {
		super(
			"catalog-timeout",
			`Cannot look up ${LOOKED_UP[fields.subject]}${fields.id === null ? "" : ` ${fields.id}`}: the storage (${fields.storage}) did not answer within ${fields.timeoutMs} ms`,
			"Check that this node can reach the shared storage (`atomic storage status`), then resume again; nothing was changed.",
			{ ...fields },
			cause,
		);
	}
}

const CODES: Record<ResumeErrorName, readonly ResumeErrorCode[]> = {
	ResumeError: [],
	ResumeNotFoundError: ["not-found"],
	ResumePreconditionError: ["preconditions-unmet"],
	ResumeSetupHookError: ["setup-hook-failed", "setup-hook-timed-out"],
	ResumeCatalogUnavailableError: ["catalog-unavailable"],
	ResumeCatalogTimeoutError: ["catalog-timeout"],
};
const ALL_CODES = new Set(Object.values(CODES).flat());

function structurallyIs(value: unknown, name: ResumeErrorName): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { readonly name?: unknown; readonly code?: unknown };
	if (name === "ResumeError") {
		return (
			typeof candidate.name === "string" &&
			candidate.name in CODES &&
			ALL_CODES.has(candidate.code as ResumeErrorCode)
		);
	}
	return candidate.name === name && CODES[name].includes(candidate.code as ResumeErrorCode);
}

export function isResumeError(value: unknown): value is ResumeError {
	return value instanceof ResumeError || structurallyIs(value, "ResumeError");
}
export function isResumeNotFoundError(value: unknown): value is ResumeNotFoundError {
	return value instanceof ResumeNotFoundError || structurallyIs(value, "ResumeNotFoundError");
}
export function isResumePreconditionError(value: unknown): value is ResumePreconditionError {
	return value instanceof ResumePreconditionError || structurallyIs(value, "ResumePreconditionError");
}
export function isResumeSetupHookError(value: unknown): value is ResumeSetupHookError {
	return value instanceof ResumeSetupHookError || structurallyIs(value, "ResumeSetupHookError");
}

export function isResumeCatalogUnavailableError(value: unknown): value is ResumeCatalogUnavailableError {
	return value instanceof ResumeCatalogUnavailableError || structurallyIs(value, "ResumeCatalogUnavailableError");
}

export function isResumeCatalogTimeoutError(value: unknown): value is ResumeCatalogTimeoutError {
	return value instanceof ResumeCatalogTimeoutError || structurallyIs(value, "ResumeCatalogTimeoutError");
}

/** Whether anything in `error`'s cause chain is a resume failure that can be retried as-is. */
export function isRetryableResumeError(error: unknown): boolean {
	return (
		findResumeError(
			error,
			(value): value is ResumeError => isResumeCatalogUnavailableError(value) || isResumeCatalogTimeoutError(value),
		) !== undefined
	);
}

/** The first error in `error`'s cause chain, itself included, that `guard` accepts. */
export function findResumeError<T extends ResumeError>(
	error: unknown,
	guard: (value: unknown) => value is T = isResumeError as (value: unknown) => value is T,
): T | undefined {
	return findInCauseChain(error, guard);
}

/** A {@link ResumeError} as it crosses a worker, RPC or broker boundary. */
export interface SerializedResumeError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: ResumeErrorFields;
	readonly cause?: SerializedErrorCause;
}

/** The JSON form of `error`, with its cause chain bounded and free of stack traces. */
export function serializeResumeError(error: ResumeError): SerializedResumeError {
	const cause = serializeErrorCause(error.cause);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields,
		...(cause === undefined ? {} : { cause }),
	};
}

type Rehydrator = (fields: ResumeErrorFields, code: string, cause?: Error) => ResumeError;
const REHYDRATORS: Record<Exclude<ResumeErrorName, "ResumeError">, Rehydrator> = {
	ResumeNotFoundError: (fields, _code, cause) =>
		new ResumeNotFoundError(fields as unknown as ResumeNotFoundErrorFields, cause),
	ResumePreconditionError: (fields, _code, cause) =>
		new ResumePreconditionError(fields as unknown as ResumePreconditionErrorFields, cause),
	ResumeCatalogTimeoutError: (fields, _code, cause) =>
		new ResumeCatalogTimeoutError(fields as unknown as ResumeCatalogTimeoutErrorFields, cause),
	ResumeCatalogUnavailableError: (fields, _code, cause) =>
		new ResumeCatalogUnavailableError(fields as unknown as ResumeCatalogUnavailableErrorFields, cause),
	ResumeSetupHookError: (fields, code, cause) =>
		new ResumeSetupHookError(
			code as ResumeSetupHookErrorCode,
			fields as unknown as ResumeSetupHookErrorFields,
			cause,
		),
};

/**
 * The error {@link serializeResumeError} produced, rebuilt after it crossed a process boundary as the same class, with
 * `cause` (or the serialized cause chain) as its cause. An unknown `name` or `code` rebuilds it as a
 * {@link ResumeError} that keeps the original `name`, `code`, `message`, `hint`, `retryable` and `fields`.
 */
export function rehydrateResumeError(form: SerializedResumeError, cause?: Error): ResumeError {
	const rebuiltCause = cause ?? rehydrateErrorCause(form.cause);
	const name = form.name as ResumeErrorName;
	if (
		name !== "ResumeError" &&
		Object.hasOwn(REHYDRATORS, name) &&
		CODES[name].includes(form.code as ResumeErrorCode)
	) {
		return REHYDRATORS[name as Exclude<ResumeErrorName, "ResumeError">](form.fields, form.code, rebuiltCause);
	}
	const error = Object.create(ResumeError.prototype) as ResumeError;
	Object.defineProperties(error, {
		name: { value: form.name, enumerable: false, configurable: true },
		message: { value: form.message, enumerable: false, configurable: true },
		code: { value: form.code, enumerable: true },
		hint: { value: form.hint, enumerable: true },
		retryable: { value: form.retryable, enumerable: true },
		fields: { value: Object.freeze({ ...form.fields }), enumerable: true },
		...(rebuiltCause === undefined ? {} : { cause: { value: rebuiltCause, enumerable: false, configurable: true } }),
	});
	return error;
}
