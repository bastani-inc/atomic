import {
	isTaskCleanupError,
	rehydrateTaskCleanupError,
	TaskCleanupAdmissionTimeoutError,
	TaskCleanupError,
	type TaskCleanupFailure,
} from "@bastani/atomic";
import {
	isJournalStoreError,
	isStorageError,
	type JournalStoreError,
	rehydrateJournalStoreError,
	rehydrateStorageError,
	type SerializedJournalStoreError,
	type SerializedStorageError,
	type StorageError,
	serializeJournalStoreError,
	serializeStorageError,
} from "@bastani/atomic/storage";
import {
	type ForkError,
	isForkError,
	rehydrateForkError,
	type SerializedForkError,
	serializeForkError,
} from "../durable/fork-errors.js";
import {
	JournalError,
	PoolAppendRefusedError,
	type PoolAppendRefusedReason,
	StaleLeaseError,
} from "../durable/journal/types.js";
import {
	isWorkerPlacementErrorValue,
	SHARED_POOL_OPERATIONS,
	SHARED_POOL_SETUP_CODES,
	SharedPoolSetupError,
	type SharedPoolSetupProblem,
	STALE_STAGE_LEASE_REASONS,
	StaleStageLeaseError,
	WORKER_PLACEMENT_CONFIG_CODES,
	WORKER_PLACEMENT_CONFIG_SOURCES,
	WORKSPACE_RESTORE_UNAVAILABLE_REASONS,
	WorkerPlacementConfigError,
	WorkerPlacementError,
	type WorkspaceBindingIdentity,
	WorkspaceRestoreUnavailableError,
} from "../workers/placement-errors.js";
import { MAX_CAUSE_DEPTH } from "./error-cause-chain.js";
import {
	isLocalWorkerPoolError,
	LOCAL_WORKER_OPTIONS_REASONS,
	LOCAL_WORKER_OPTIONS_SOURCES,
	LOCAL_WORKER_TIMING_OPTIONS,
	LocalWorkerOptionsError,
	LocalWorkerPoolError,
	type LocalWorkerPoolErrorCode,
	PoolNotInitializedError,
	PoolProtocolError,
	PUBLICATION_REJECTED_REASONS,
	PublicationRejectedError,
	STALE_WORK_LEASE_REASONS,
	StaleWorkLeaseError,
	WorkAttemptFencedError,
} from "./worker-pool-errors.js";
import {
	AdmissionHolderStoppedError,
	isStorageUnavailable,
	isWorkflowInfrastructureError,
	ProcessCleanupUnconfirmedError,
	QuarantinedCapacityError,
	WORKER_RETRY_LIMIT_REASONS,
	WORKFLOW_INFRASTRUCTURE_FAULTS,
	WorkerCleanupUnconfirmedError,
	WorkerLostError,
	WorkerRetryLimitError,
	WorkerStartupError,
	WorkerStartupTimeoutError,
	WorkflowInfrastructureError,
	type WorkflowInfrastructureErrorOptions,
	type WorkflowInfrastructureFault,
} from "./workflow-infrastructure-error.js";

/** The error family an envelope names, so a receiver without the error's class still rehydrates its family base. */
export type ErrorFamily =
	| "worker-pool"
	| "workflow-infrastructure"
	| "journal"
	| "storage"
	| "journal-store"
	| "fork"
	| "worker-placement"
	| "task-cleanup";

const FAMILIES: ReadonlySet<string> = new Set<ErrorFamily>([
	"worker-pool",
	"workflow-infrastructure",
	"journal",
	"storage",
	"journal-store",
	"fork",
	"worker-placement",
	"task-cleanup",
]);

export type SerializedErrorField =
	| string
	| number
	| boolean
	| null
	| readonly SerializedErrorField[]
	| { readonly [key: string]: SerializedErrorField };
export type SerializedErrorFields = { readonly [key: string]: SerializedErrorField };

/**
 * An error as it crosses the worker <-> coordinator <-> root IPC: its class name, stable code, message, hint, the
 * structured fields its class declares (never arbitrary properties), and its causes, at most {@link MAX_CAUSE_DEPTH}
 * deep.
 */
export interface SerializedError {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly hint?: string;
	readonly retryable?: boolean;
	readonly family?: ErrorFamily;
	readonly fields: SerializedErrorFields;
	readonly cause?: SerializedError;
	readonly cleanupCause?: SerializedError;
	/** The members of an `AggregateError`, in order. */
	readonly errors?: readonly SerializedError[];
	/** A storage error's failed rollback, carried as the storage layer's own serializer carries it. */
	readonly rollbackCause?: SerializedError;
}

/** The name an envelope carries for a cause that was not an error object. */
export const NON_ERROR_CAUSE = "NonErrorCause";
/** Errors one envelope carries at most, causes and cleanup causes included. */
export const MAX_SERIALIZED_ERRORS = 2 * MAX_CAUSE_DEPTH;

class FieldReader {
	private readonly fields: SerializedErrorFields;
	private readonly path: string;

	constructor(fields: SerializedErrorFields, path: string) {
		this.fields = fields;
		this.path = path;
	}

	refuse(key: string, expected: string): never {
		throw new PoolProtocolError({ field: `${this.path}.fields.${key}`, expected });
	}

	/** The field as sent, for a class whose own rehydration validates its shape. */
	value(key: string): SerializedErrorField | undefined {
		return this.fields[key];
	}

	string(key: string): string {
		const value = this.fields[key];
		return typeof value === "string" ? value : this.refuse(key, "a string");
	}

	number(key: string): number {
		const value = this.fields[key];
		return typeof value === "number" ? value : this.refuse(key, "a finite number");
	}

	optionalString(key: string): string | undefined {
		return this.fields[key] === undefined ? undefined : this.string(key);
	}

	optionalNumber(key: string): number | undefined {
		return this.fields[key] === undefined ? undefined : this.number(key);
	}

	/** The envelope's own `code`, which must be one of `allowed`. */
	code<T extends string>(code: string | undefined, allowed: readonly T[]): T {
		if ((allowed as readonly (string | undefined)[]).includes(code)) return code as T;
		throw new PoolProtocolError({ field: `${this.path}.code`, expected: `one of ${allowed.join(", ")}` });
	}

	literal<T extends string>(key: string, allowed: readonly T[]): T {
		const value = this.fields[key];
		return (allowed as readonly SerializedErrorField[]).includes(value as SerializedErrorField)
			? (value as T)
			: this.refuse(key, `one of ${allowed.join(", ")}`);
	}

	numbers(key: string): number[] {
		const value = this.fields[key];
		return Array.isArray(value) && value.every((item) => typeof item === "number")
			? [...(value as number[])]
			: this.refuse(key, "an array of finite numbers");
	}

	strings(key: string): string[] {
		const value = this.fields[key];
		return Array.isArray(value) && value.every((item) => typeof item === "string")
			? [...(value as string[])]
			: this.refuse(key, "an array of strings");
	}
}

interface Codec<E extends Error> {
	readonly family: ErrorFamily;
	readonly type: abstract new (...args: never[]) => E;
	readonly fields: (error: E) => SerializedErrorFields;
	readonly create: (fields: FieldReader, options: ErrorOptions, envelope: SerializedError) => E;
}

function codec<E extends Error>(name: string, definition: Codec<E>): readonly [string, Codec<Error>] {
	return [name, definition as unknown as Codec<Error>];
}

function defined(fields: { readonly [key: string]: SerializedErrorField | undefined }): SerializedErrorFields {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as SerializedErrorFields;
}

const JOURNAL_APPEND_REASONS: readonly PoolAppendRefusedReason[] = [
	"foreign-root",
	"coordinator-authority",
	"attempt-refused",
];

/** A task cleanup failure's declared facts: its task, and each resource's name, code and message. */
function failureRecords(failures: readonly TaskCleanupFailure[]): SerializedErrorField {
	return failures.map((failure) => ({
		taskId: failure.taskId,
		resources: failure.resources.map(({ resource, code, message }) => ({ resource, code, message })),
	}));
}

/** The task cleanup error named `name` that `fields` describe, validated by the task layer's own rehydration. */
function validTaskCleanup(fields: FieldReader, name: string): TaskCleanupError {
	const copy = rehydrateTaskCleanupError({
		name,
		code: "task_cleanup_unconfirmed",
		phase: fields.value("phase"),
		failures: fields.value("failures"),
		timeoutMs: fields.value("timeoutMs"),
		elapsedMs: fields.value("elapsedMs"),
	});
	return copy ?? fields.refuse("failures", "the phase, failures and timing of a task cleanup error");
}

/**
 * The task cleanup a stage cleanup error's `phase` and `resources` describe: consecutive resources of one task
 * regrouped, in order, then validated by the task layer's own rehydration. A copy that lost its cause is rebuilt from
 * it; one that kept its cause must still describe a valid cleanup.
 */
function cleanupFromResources(fields: FieldReader): TaskCleanupError {
	const expected = "a task cleanup phase and resources, each with its task";
	const listed = fields.value("resources");
	if (!Array.isArray(listed)) return fields.refuse("resources", expected);
	const failures: { readonly taskId: SerializedErrorField | undefined; readonly resources: object[] }[] = [];
	for (const entry of listed) {
		const { taskId, resource, code, message } = (entry ?? {}) as { readonly [key: string]: SerializedErrorField };
		const last = failures.at(-1);
		if (last !== undefined && last.taskId === taskId) last.resources.push({ resource, code, message });
		else failures.push({ taskId, resources: [{ resource, code, message }] });
	}
	const cleanup = rehydrateTaskCleanupError({
		name: "TaskCleanupError",
		code: "task_cleanup_unconfirmed",
		phase: fields.value("phase"),
		failures,
	});
	return cleanup ?? fields.refuse("resources", expected);
}

function isRecord(value: unknown): value is { readonly [key: string]: SerializedErrorField } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The problems of a shared pool setup error: each with a known code, its subject, hint and facts. */
function setupProblems(fields: FieldReader): [SharedPoolSetupProblem, ...SharedPoolSetupProblem[]] {
	const expected = "a non-empty list of shared pool setup problems";
	const listed = fields.value("problems");
	if (!Array.isArray(listed) || listed.length === 0) return fields.refuse("problems", expected);
	const problems = listed.map((entry): SharedPoolSetupProblem => {
		if (!isRecord(entry)) return fields.refuse("problems", expected);
		const { code, subject, hint, fields: facts } = entry;
		if (
			!(SHARED_POOL_SETUP_CODES as readonly unknown[]).includes(code) ||
			typeof subject !== "string" ||
			typeof hint !== "string" ||
			!isRecord(facts)
		)
			return fields.refuse("problems", expected);
		return { code: code as SharedPoolSetupProblem["code"], subject, hint, fields: facts };
	});
	return problems as [SharedPoolSetupProblem, ...SharedPoolSetupProblem[]];
}

function bindingIdentity(fields: FieldReader): WorkspaceBindingIdentity {
	const expected = "a workspace binding identity: remotes, head, tree and envHash";
	const value = fields.value("binding");
	if (!isRecord(value)) return fields.refuse("binding", expected);
	const { remotes, head, tree, envHash } = value;
	if (
		!Array.isArray(remotes) ||
		!remotes.every((remote) => typeof remote === "string") ||
		typeof head !== "string" ||
		typeof tree !== "string" ||
		typeof envHash !== "string"
	)
		return fields.refuse("binding", expected);
	return { remotes: [...(remotes as string[])], head, tree, envHash };
}

const CODECS: ReadonlyMap<string, Codec<Error>> = new Map([
	codec("ProcessCleanupUnconfirmedError", {
		family: "workflow-infrastructure",
		type: ProcessCleanupUnconfirmedError,
		fields: (error) => ({
			phase: error.phase,
			resources: error.resources.map(({ taskId, resource, code, message }) => ({ taskId, resource, code, message })),
		}),
		create: (fields, options) => {
			const described = cleanupFromResources(fields);
			return new ProcessCleanupUnconfirmedError(isTaskCleanupError(options.cause) ? options.cause : described);
		},
	}),
	codec("WorkerPlacementConfigError", {
		family: "worker-placement",
		type: WorkerPlacementConfigError,
		fields: (error) => defined({ source: error.source, field: error.field, detail: error.detail }),
		create: (fields, options, envelope) =>
			new WorkerPlacementConfigError(
				fields.literal("source", WORKER_PLACEMENT_CONFIG_SOURCES),
				fields.string("field"),
				fields.code(envelope.code, WORKER_PLACEMENT_CONFIG_CODES),
				fields.optionalString("detail"),
				options,
			),
	}),
	codec("SharedPoolSetupError", {
		family: "worker-placement",
		type: SharedPoolSetupError,
		fields: (error) => ({
			operation: error.operation,
			problems: error.problems.map((problem) => ({ ...problem, fields: { ...problem.fields } })),
		}),
		create: (fields, options) =>
			new SharedPoolSetupError(fields.literal("operation", SHARED_POOL_OPERATIONS), setupProblems(fields), options),
	}),
	codec("WorkspaceRestoreUnavailableError", {
		family: "worker-placement",
		type: WorkspaceRestoreUnavailableError,
		fields: (error) =>
			defined({
				reason: error.reason,
				binding: { ...error.binding, remotes: [...error.binding.remotes] },
				childRunId: error.childRunId,
				claimWindowMs: error.claimWindowMs,
			}),
		create: (fields, options) => {
			const childRunId = fields.optionalString("childRunId");
			const claimWindowMs = fields.optionalNumber("claimWindowMs");
			return new WorkspaceRestoreUnavailableError(
				fields.literal("reason", WORKSPACE_RESTORE_UNAVAILABLE_REASONS),
				bindingIdentity(fields),
				{
					...(childRunId === undefined ? {} : { childRunId }),
					...(claimWindowMs === undefined ? {} : { claimWindowMs }),
					...options,
				},
			);
		},
	}),
	codec("StaleStageLeaseError", {
		family: "worker-placement",
		type: StaleStageLeaseError,
		fields: (error) => ({
			reason: error.reason,
			root: error.root,
			runId: error.runId,
			stageId: error.stageId,
			seq: error.seq,
		}),
		create: (fields, options) => {
			const seq = fields.value("seq");
			return new StaleStageLeaseError(
				fields.literal("reason", STALE_STAGE_LEASE_REASONS),
				{
					root: fields.string("root"),
					runId: fields.string("runId"),
					stageId: fields.string("stageId"),
					seq: seq === null || typeof seq === "number" ? seq : fields.refuse("seq", "a finite number or null"),
				},
				options,
			);
		},
	}),
	codec("TaskCleanupError", {
		family: "task-cleanup",
		type: TaskCleanupError,
		fields: (error) => ({ phase: error.phase, failures: failureRecords(error.failures) }),
		create: (fields, options) => {
			const valid = validTaskCleanup(fields, "TaskCleanupError");
			return new TaskCleanupError(valid.phase, valid.failures, options);
		},
	}),
	codec("TaskCleanupAdmissionTimeoutError", {
		family: "task-cleanup",
		type: TaskCleanupAdmissionTimeoutError,
		fields: (error) => ({
			phase: error.phase,
			failures: failureRecords(error.failures),
			timeoutMs: error.timeoutMs,
			elapsedMs: error.elapsedMs,
		}),
		create: (fields, options) =>
			new TaskCleanupAdmissionTimeoutError(
				validTaskCleanup(fields, "TaskCleanupAdmissionTimeoutError").failures,
				{ timeoutMs: fields.number("timeoutMs"), elapsedMs: fields.number("elapsedMs") },
				options,
			),
	}),
	codec("LocalWorkerOptionsError", {
		family: "worker-pool",
		type: LocalWorkerOptionsError,
		fields: (error) => ({
			source: error.source,
			option: error.option,
			reason: error.reason,
			received: error.received,
			minimum: error.minimum,
			maximum: error.maximum,
			omitted: error.omitted,
		}),
		create: (fields) =>
			new LocalWorkerOptionsError({
				source: fields.literal("source", LOCAL_WORKER_OPTIONS_SOURCES),
				option: fields.literal("option", LOCAL_WORKER_TIMING_OPTIONS),
				reason: fields.literal("reason", LOCAL_WORKER_OPTIONS_REASONS),
				received: fields.string("received"),
				minimum: fields.number("minimum"),
				maximum: fields.number("maximum"),
				omitted: fields.string("omitted"),
			}),
	}),
	codec("PoolNotInitializedError", {
		family: "worker-pool",
		type: PoolNotInitializedError,
		fields: (error) => defined({ root: error.root }),
		create: (fields, options) => new PoolNotInitializedError({ root: fields.optionalString("root") }, options),
	}),
	codec("StaleWorkLeaseError", {
		family: "worker-pool",
		type: StaleWorkLeaseError,
		fields: (error) => ({
			root: error.root,
			workId: error.workId,
			generation: error.generation,
			reason: error.reason,
		}),
		create: (fields, options) =>
			new StaleWorkLeaseError(
				{
					root: fields.string("root"),
					workId: fields.string("workId"),
					generation: fields.number("generation"),
					reason: fields.literal("reason", STALE_WORK_LEASE_REASONS),
				},
				options,
			),
	}),
	codec("PublicationRejectedError", {
		family: "worker-pool",
		type: PublicationRejectedError,
		fields: (error) =>
			defined({
				root: error.root,
				workId: error.workId,
				generation: error.generation,
				reason: error.reason,
				runId: error.runId,
				stageId: error.stageId,
				sessionId: error.sessionId,
			}),
		create: (fields, options) =>
			new PublicationRejectedError(
				{
					root: fields.string("root"),
					workId: fields.string("workId"),
					generation: fields.number("generation"),
					reason: fields.literal("reason", PUBLICATION_REJECTED_REASONS),
					runId: fields.optionalString("runId"),
					stageId: fields.optionalString("stageId"),
					sessionId: fields.optionalString("sessionId"),
				},
				options,
			),
	}),
	codec("WorkAttemptFencedError", {
		family: "worker-pool",
		type: WorkAttemptFencedError,
		fields: (error) => ({ workId: error.workId, generation: error.generation }),
		create: (fields, options) =>
			new WorkAttemptFencedError(
				{ workId: fields.string("workId"), generation: fields.number("generation") },
				options,
			),
	}),
	codec("PoolProtocolError", {
		family: "worker-pool",
		type: PoolProtocolError,
		fields: (error) => ({ field: error.field, expected: error.expected }),
		create: (fields, options) =>
			new PoolProtocolError({ field: fields.string("field"), expected: fields.string("expected") }, options),
	}),
	codec("WorkflowInfrastructureError", {
		family: "workflow-infrastructure",
		type: WorkflowInfrastructureError,
		fields: (error) => defined({ runId: error.runId, stageId: error.stageId }),
		create: (fields, options, envelope) =>
			infrastructureBase(envelope, {
				...options,
				hint: envelope.hint,
				runId: fields.optionalString("runId"),
				stageId: fields.optionalString("stageId"),
			}),
	}),
	codec("WorkerLostError", {
		family: "workflow-infrastructure",
		type: WorkerLostError,
		fields: (error) =>
			defined({
				phase: error.phase,
				pid: error.pid,
				exitCode: error.exitCode,
				signal: error.signal,
				logPath: error.logPath,
				logFailure: error.logFailure,
			}),
		create: (fields, options) =>
			new WorkerLostError(
				{
					phase: fields.literal("phase", ["delivery", "coordinator"] as const),
					pid: fields.optionalNumber("pid"),
					exitCode: fields.optionalNumber("exitCode"),
					signal: fields.optionalString("signal"),
					logPath: fields.optionalString("logPath"),
					logFailure: fields.optionalString("logFailure"),
				},
				options,
			),
	}),
	codec("WorkerStartupError", {
		family: "workflow-infrastructure",
		type: WorkerStartupError,
		fields: (error) =>
			defined({ logPath: error.logPath, logFailure: error.logFailure, runId: error.runId, stageId: error.stageId }),
		create: (fields, options, envelope) =>
			new WorkerStartupError(
				{ logPath: fields.string("logPath"), logFailure: fields.optionalString("logFailure") },
				{
					...options,
					hint: envelope.hint,
					runId: fields.optionalString("runId"),
					stageId: fields.optionalString("stageId"),
				},
			),
	}),
	codec("WorkerStartupTimeoutError", {
		family: "workflow-infrastructure",
		type: WorkerStartupTimeoutError,
		fields: (error) =>
			defined({
				logPath: error.logPath,
				logFailure: error.logFailure,
				timeoutMs: error.timeoutMs,
				elapsedMs: error.elapsedMs,
				phase: error.phase,
			}),
		create: (fields, options) => {
			fields.literal("phase", ["startup"] as const);
			return new WorkerStartupTimeoutError(
				{
					logPath: fields.string("logPath"),
					logFailure: fields.optionalString("logFailure"),
					timeoutMs: fields.number("timeoutMs"),
					elapsedMs: fields.number("elapsedMs"),
				},
				options,
			);
		},
	}),
	codec("WorkerRetryLimitError", {
		family: "workflow-infrastructure",
		type: WorkerRetryLimitError,
		fields: (error) =>
			defined({
				reason: error.reason,
				attempts: error.attempts,
				limit: error.limit,
				childRunId: error.childRunId,
				exportName: error.exportName,
				logPath: error.logPath,
				logFailure: error.logFailure,
			}),
		create: (fields, options) =>
			new WorkerRetryLimitError(
				{
					reason: fields.literal("reason", WORKER_RETRY_LIMIT_REASONS),
					attempts: fields.number("attempts"),
					limit: fields.number("limit"),
					childRunId: fields.optionalString("childRunId"),
					exportName: fields.optionalString("exportName"),
					logPath: fields.optionalString("logPath"),
					logFailure: fields.optionalString("logFailure"),
				},
				options,
			),
	}),
	codec("WorkerCleanupUnconfirmedError", {
		family: "workflow-infrastructure",
		type: WorkerCleanupUnconfirmedError,
		fields: (error) => ({ processGroups: [...error.processGroups] }),
		create: (fields, options) =>
			new WorkerCleanupUnconfirmedError({ processGroups: fields.numbers("processGroups") }, options),
	}),
	codec("QuarantinedCapacityError", {
		family: "workflow-infrastructure",
		type: QuarantinedCapacityError,
		fields: (error) => ({
			limits: [...error.limits],
			processGroups: [...error.processGroups],
			waitedMs: error.waitedMs,
		}),
		create: (fields, options) =>
			new QuarantinedCapacityError(
				{
					limits: fields.strings("limits"),
					processGroups: fields.numbers("processGroups"),
					waitedMs: fields.number("waitedMs"),
				},
				options,
			),
	}),
	codec("AdmissionHolderStoppedError", {
		family: "workflow-infrastructure",
		type: AdmissionHolderStoppedError,
		fields: (error) => defined({ permitReason: error.permitReason }),
		create: (fields, options) =>
			new AdmissionHolderStoppedError({ permitReason: fields.optionalString("permitReason") }, options),
	}),
	codec("StaleLeaseError", {
		family: "journal",
		type: StaleLeaseError,
		fields: (error) => ({ runId: error.runId, heldEpoch: error.heldEpoch, currentEpoch: error.currentEpoch }),
		create: (fields, options) =>
			new StaleLeaseError(
				fields.string("runId"),
				fields.number("heldEpoch"),
				fields.number("currentEpoch"),
				options,
			),
	}),
	codec("PoolAppendRefusedError", {
		family: "journal",
		type: PoolAppendRefusedError,
		fields: (error) => ({
			root: error.root,
			workId: error.workId,
			generation: error.generation,
			reason: error.reason,
		}),
		create: (fields, options) =>
			new PoolAppendRefusedError(
				{
					root: fields.string("root"),
					workId: fields.string("workId"),
					generation: fields.number("generation"),
					reason: fields.literal("reason", JOURNAL_APPEND_REASONS),
				},
				options,
			),
	}),
]);

/** The error classes the codec rebuilds as themselves; any other error crosses as its family's base class. */
export const REGISTERED_ERROR_NAMES: readonly string[] = [...CODECS.keys()];

/**
 * The infrastructure family's base class for `envelope`. A fault code this version does not know keeps the family, its
 * own code and its message; a missing code is a protocol violation.
 */
function infrastructureBase(
	envelope: SerializedError,
	options: WorkflowInfrastructureErrorOptions,
): WorkflowInfrastructureError {
	const code = envelope.code;
	if (code === undefined)
		throw new PoolProtocolError({ field: "error.code", expected: "a workflow infrastructure fault code" });
	if (WORKFLOW_INFRASTRUCTURE_FAULTS.has(code))
		return new WorkflowInfrastructureError(code as WorkflowInfrastructureFault, options);
	const error = new WorkflowInfrastructureError("worker_lost", options);
	restore(error, { code, message: envelope.message, hint: envelope.hint ?? "" });
	return error;
}

/** Fields a family base rehydrated for an unknown name carries on, so a second hop serializes them again. */
const preservedFields = new WeakMap<object, SerializedErrorFields>();

function familyOf(error: object): ErrorFamily | undefined {
	if (isLocalWorkerPoolError(error)) return "worker-pool";
	if (isWorkflowInfrastructureError(error)) return "workflow-infrastructure";
	if (error instanceof JournalError) return "journal";
	if (isWorkerPlacementErrorValue(error)) return "worker-placement";
	if (isForkError(error)) return "fork";
	if (isJournalStoreError(error)) return "journal-store";
	if (isStorageError(error) || isStorageUnavailable(error)) return "storage";
	if (isTaskCleanupError(error)) return "task-cleanup";
	return undefined;
}

function codecFor(error: object, name: string): Codec<Error> | undefined {
	const known = CODECS.get(name);
	if (known === undefined) return undefined;
	return error instanceof known.type || familyOf(error) === known.family ? known : undefined;
}

interface Budget {
	remaining: number;
	readonly seen: Set<object>;
}

function serializeNonError(value: unknown, withheld: boolean): SerializedError {
	const message =
		withheld || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
			? ""
			: String(value);
	return { name: NON_ERROR_CAUSE, message, fields: { type: value === null ? "null" : typeof value } };
}

function serializeLinked(
	value: unknown,
	depth: number,
	budget: Budget,
	withheld: boolean,
): SerializedError | undefined {
	if (value === undefined || depth >= MAX_CAUSE_DEPTH || budget.remaining <= 0 || budget.seen.has(value as object))
		return undefined;
	return serializeOne(value, depth, budget, withheld);
}

/**
 * A journal store error as the journal store serializes it, as an envelope: its code, scalar fields, hint and
 * `retryable`. Its causes cross as any error's causes do.
 */
function journalStoreEnvelope(
	error: JournalStoreError,
	depth: number,
	budget: Budget,
	withheld: boolean,
): SerializedError {
	const { cause: _ownCause, ...serialized } = serializeJournalStoreError(error);
	const cause = serializeLinked(error.cause, depth + 1, budget, withheld);
	return { ...serialized, family: "journal-store", ...(cause === undefined ? {} : { cause }) };
}

/**
 * A fork error as the fork family serializes it, as an envelope: its code, fields, hint and `retryable`. Its cause and
 * cleanup cause cross as any error's do.
 */
function forkEnvelope(error: ForkError, depth: number, budget: Budget, withheld: boolean): SerializedError {
	const { cause: _ownCause, cleanupCause: _ownCleanupCause, ...serialized } = serializeForkError(error);
	const cause = serializeLinked(error.cause, depth + 1, budget, withheld);
	const cleanupCause = serializeLinked(error.cleanupCause, depth + 1, budget, withheld);
	return {
		...serialized,
		family: "fork",
		...(cause === undefined ? {} : { cause }),
		...(cleanupCause === undefined ? {} : { cleanupCause }),
	};
}

/**
 * A storage error's own serialization, or for a copy that is not an `Error` here (recognized by its name, so it has
 * one), its name, text and scalar facts.
 */
function storageSerialization(error: object): SerializedStorageError {
	if (error instanceof Error) return serializeStorageError(error as StorageError);
	const { name, message, code, hint, ...rest } = error as {
		readonly name: string;
		readonly message?: unknown;
		readonly code?: unknown;
		readonly hint?: unknown;
	} & { readonly [key: string]: unknown };
	return {
		name,
		message: typeof message === "string" ? message : "",
		...(typeof code === "string" ? { code } : {}),
		...(typeof hint === "string" ? { hint } : {}),
		fields: Object.fromEntries(
			Object.entries(rest).filter(
				([, value]) => typeof value === "string" || typeof value === "boolean" || Number.isFinite(value),
			),
		) as SerializedStorageError["fields"],
	};
}

/** A link of a storage error's chain: its cause, its failed rollback, or the cleanup failure attached to it. */
type StorageLink = "cause" | "rollbackCause" | "cleanupCause";

/**
 * A storage error as the storage layer serializes it, bounded like any chain: its causes keep their identity but not
 * their text, which a storage driver may fill with a connection string, and a cause that is not itself a storage
 * error keeps no fields. `source` is the error `node` serializes.
 */
function boundStorage(
	node: SerializedStorageError,
	source: unknown,
	depth: number,
	budget: Budget,
	withheld: boolean,
): SerializedError {
	const link = (key: StorageLink) => {
		const child = node[key];
		if (child === undefined || depth + 1 >= MAX_CAUSE_DEPTH || budget.remaining <= 0) return {};
		budget.remaining--;
		// Only an error has links, so a node that has one was serialized from an object.
		return { [key]: boundStorage(child, (source as Record<StorageLink, unknown>)[key], depth + 1, budget, true) };
	};
	const storage = typeof source === "object" && source !== null && familyOf(source) === "storage";
	return {
		name: node.name,
		message: withheld ? "" : node.message,
		...(node.code === undefined ? {} : { code: node.code }),
		...(node.hint === undefined ? {} : { hint: node.hint }),
		fields: storage ? node.fields : {},
		...link("cause"),
		...link("rollbackCause"),
		...link("cleanupCause"),
	};
}

/** `withheld`: an error under a cause whose text must not cross, which keeps its identity but not its message. */
function serializeOne(error: unknown, depth: number, budget: Budget, withheld: boolean): SerializedError {
	budget.remaining--;
	if (typeof error !== "object" || error === null) return serializeNonError(error, withheld);
	budget.seen.add(error);
	const family = familyOf(error);
	if (family === "storage")
		return { ...boundStorage(storageSerialization(error), error, depth, budget, withheld), family: "storage" };
	if (family === "journal-store") return journalStoreEnvelope(error as JournalStoreError, depth, budget, withheld);
	if (family === "fork") return forkEnvelope(error as ForkError, depth, budget, withheld);
	const candidate = error as {
		readonly name?: unknown;
		readonly message?: unknown;
		readonly code?: unknown;
		readonly hint?: unknown;
		readonly retryable?: unknown;
		readonly cause?: unknown;
		readonly cleanupCause?: unknown;
	};
	const name = typeof candidate.name === "string" ? candidate.name : "Error";
	const known = codecFor(error, name);
	const codecFamily = known?.family ?? family;
	const cause = serializeLinked(candidate.cause, depth + 1, budget, withheld);
	const cleanupCause = serializeLinked(candidate.cleanupCause, depth + 1, budget, withheld);
	const errors = error instanceof AggregateError ? serializedMembers(error, depth, budget, withheld) : [];
	return {
		name,
		message: !withheld && typeof candidate.message === "string" ? candidate.message : "",
		...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
		...(typeof candidate.hint === "string" ? { hint: candidate.hint } : {}),
		...(codecFamily !== undefined && typeof candidate.retryable === "boolean"
			? { retryable: candidate.retryable }
			: {}),
		...(codecFamily === undefined ? {} : { family: codecFamily }),
		fields: known?.fields(error as Error) ?? preservedFields.get(error) ?? {},
		...(cause === undefined ? {} : { cause }),
		...(cleanupCause === undefined ? {} : { cleanupCause }),
		...(errors.length === 0 ? {} : { errors }),
	};
}

/** The members of a group of errors that fit what is left of the envelope's depth and budget, in order. */
function serializedMembers(group: AggregateError, depth: number, budget: Budget, withheld: boolean): SerializedError[] {
	const members: SerializedError[] = [];
	for (const member of group.errors as unknown[]) {
		const serialized = serializeLinked(member, depth + 1, budget, withheld);
		if (serialized !== undefined) members.push(serialized);
	}
	return members;
}

/**
 * The one way an error leaves a worker, the coordinator or the root over IPC: a {@link SerializedError} that keeps its
 * class name, code, hint, declared fields and bounded causes. A cause that is not an error object keeps only its type,
 * and its text when it is a string, number or boolean. A storage error crosses as the storage layer's
 * `serializeStorageError` carries it, so it arrives as its own class; its causes keep their identity but not their
 * text, which a storage driver may fill with a connection string.
 */
export function serializeError(error: unknown): SerializedError {
	return serializeOne(error, 0, { remaining: MAX_SERIALIZED_ERRORS, seen: new Set() }, false);
}

function isField(value: unknown, depth = 0): value is SerializedErrorField {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	return (
		depth < MAX_CAUSE_DEPTH &&
		typeof value === "object" &&
		Object.values(value).every((item) => isField(item, depth + 1))
	);
}

function refuse(field: string, expected: string): never {
	throw new PoolProtocolError({ field, expected });
}

function readEnvelope(value: unknown, path: string): SerializedError {
	if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(path, "a serialized error");
	const envelope = value as { readonly [key: string]: unknown };
	const optionalString = (key: string) =>
		envelope[key] === undefined || typeof envelope[key] === "string"
			? undefined
			: refuse(`${path}.${key}`, "a string");
	if (typeof envelope.name !== "string") refuse(`${path}.name`, "a string");
	if (typeof envelope.message !== "string") refuse(`${path}.message`, "a string");
	optionalString("code");
	optionalString("hint");
	if (envelope.retryable !== undefined && typeof envelope.retryable !== "boolean")
		refuse(`${path}.retryable`, "a boolean");
	if (envelope.family !== undefined && !(typeof envelope.family === "string" && FAMILIES.has(envelope.family)))
		refuse(`${path}.family`, `one of ${[...FAMILIES].join(", ")}`);
	if (envelope.errors !== undefined) {
		if (!Array.isArray(envelope.errors)) refuse(`${path}.errors`, "an array of serialized errors");
		if (envelope.errors.length > MAX_SERIALIZED_ERRORS)
			refuse(`${path}.errors`, `at most ${MAX_SERIALIZED_ERRORS} serialized errors`);
	}
	const fields = envelope.fields;
	if (typeof fields !== "object" || fields === null || Array.isArray(fields)) refuse(`${path}.fields`, "an object");
	for (const [key, field] of Object.entries(fields))
		if (!isField(field))
			refuse(`${path}.fields.${key}`, "a JSON string, finite number, boolean, null, array or object");
	return envelope as unknown as SerializedError;
}

/** Gives a rehydrated error the sender's own name, message and other members. */
function restore(error: Error, members: { readonly [key: string]: unknown }): void {
	for (const [key, value] of Object.entries(members))
		if (value !== undefined) (error as unknown as Record<string, unknown>)[key] = value;
}

/**
 * A storage error's envelope as the storage layer's `rehydrateStorageError` reads it, validated first: names and texts
 * are strings, fields are strings, finite numbers or booleans, and causes are envelopes, at most
 * {@link MAX_CAUSE_DEPTH} deep.
 */
function readStorageEnvelope(value: unknown, path: string, depth: number): SerializedStorageError {
	const envelope = readEnvelope(value, path);
	for (const [key, field] of Object.entries(envelope.fields))
		if (
			typeof field !== "string" &&
			typeof field !== "boolean" &&
			!(typeof field === "number" && Number.isFinite(field))
		)
			refuse(`${path}.fields.${key}`, "a string, finite number or boolean");
	const link = (key: "cause" | "rollbackCause" | "cleanupCause") => {
		const child = (value as { readonly [member: string]: unknown })[key];
		return child === undefined || depth + 1 >= MAX_CAUSE_DEPTH
			? {}
			: { [key]: readStorageEnvelope(child, `${path}.${key}`, depth + 1) };
	};
	return {
		name: envelope.name,
		message: envelope.message,
		...(envelope.code === undefined ? {} : { code: envelope.code }),
		...(envelope.hint === undefined ? {} : { hint: envelope.hint }),
		fields: envelope.fields as SerializedStorageError["fields"],
		...link("cause"),
		...link("rollbackCause"),
		...link("cleanupCause"),
	};
}

/**
 * A journal store error's envelope as the journal store's own `rehydrateJournalStoreError` reads it, validated first:
 * a code, a boolean `retryable`, and string, number, boolean or null fields. Its causes are rebuilt as any error's are.
 */
function readJournalStoreEnvelope(value: unknown, path: string): SerializedJournalStoreError {
	const envelope = readEnvelope(value, path);
	if (envelope.code === undefined) refuse(`${path}.code`, "a journal store error code");
	if (envelope.retryable === undefined) refuse(`${path}.retryable`, "a boolean");
	for (const [key, field] of Object.entries(envelope.fields))
		if (typeof field === "object" && field !== null)
			refuse(`${path}.fields.${key}`, "a string, number, boolean or null");
	return {
		name: envelope.name,
		code: envelope.code,
		message: envelope.message,
		...(envelope.hint === undefined ? {} : { hint: envelope.hint }),
		retryable: envelope.retryable,
		fields: envelope.fields as SerializedJournalStoreError["fields"],
	};
}

/**
 * A fork error's envelope as the fork family's own `rehydrateForkError` reads it, validated first: a code and a boolean
 * `retryable`. Its causes are rebuilt as any error's are.
 */
function readForkEnvelope(value: unknown, path: string): SerializedForkError {
	const envelope = readEnvelope(value, path);
	if (envelope.code === undefined) refuse(`${path}.code`, "a fork error code");
	if (envelope.retryable === undefined) refuse(`${path}.retryable`, "a boolean");
	return {
		name: envelope.name,
		code: envelope.code,
		message: envelope.message,
		...(envelope.hint === undefined ? {} : { hint: envelope.hint }),
		retryable: envelope.retryable,
		fields: envelope.fields,
	};
}

function familyBase(
	envelope: SerializedError & { readonly family?: Exclude<ErrorFamily, "storage" | "journal-store" | "fork"> },
	options: ErrorOptions,
): Error {
	const hint = envelope.hint ?? "";
	switch (envelope.family) {
		case "worker-pool":
			// The family base keeps a code this version does not know: `restore` sets it as sent.
			return new LocalWorkerPoolError((envelope.code ?? "") as LocalWorkerPoolErrorCode, envelope.message, hint, {
				...options,
				retryable: envelope.retryable === true,
			});
		case "worker-placement":
			return new WorkerPlacementError(envelope.code ?? "", envelope.message, {
				...(envelope.hint === undefined ? {} : { hint }),
				retryable: envelope.retryable === true,
				...options,
			});
		case "workflow-infrastructure":
			return infrastructureBase(envelope, { ...options, hint });
		case "journal":
			return new JournalError(envelope.message, options);
		case "task-cleanup":
		case undefined:
			return new Error(envelope.message, options);
	}
}

/** What is left of the errors one received envelope may describe, causes, cleanup causes and group members together. */
interface ReceiveBudget {
	remaining: number;
}

function rehydrateOne(value: unknown, path: string, depth: number, budget: ReceiveBudget): Error {
	const envelope = readEnvelope(value, path);
	if (--budget.remaining < 0) refuse(path, `at most ${MAX_SERIALIZED_ERRORS} serialized errors`);
	if (envelope.family === "storage") return rehydrateStorageError(readStorageEnvelope(value, path, depth));
	const cause =
		envelope.cause === undefined || depth + 1 >= MAX_CAUSE_DEPTH
			? undefined
			: rehydrateOne(envelope.cause, `${path}.cause`, depth + 1, budget);
	const cleanupCause =
		envelope.cleanupCause === undefined || depth + 1 >= MAX_CAUSE_DEPTH
			? undefined
			: rehydrateOne(envelope.cleanupCause, `${path}.cleanupCause`, depth + 1, budget);
	if (envelope.family === "fork") {
		const error = rehydrateForkError(readForkEnvelope(value, path));
		if (cause !== undefined)
			Object.defineProperty(error, "cause", { value: cause, writable: true, configurable: true });
		return cleanupCause === undefined ? error : error.withCleanupCause(cleanupCause);
	}
	if (envelope.family === "journal-store") {
		const error = rehydrateJournalStoreError(readJournalStoreEnvelope(value, path));
		if (cause !== undefined)
			Object.defineProperty(error, "cause", { value: cause, writable: true, configurable: true });
		return error;
	}
	const options: ErrorOptions = cause === undefined ? {} : { cause };
	const known = CODECS.get(envelope.name);
	if (known !== undefined && known.family === envelope.family) {
		const error = known.create(new FieldReader(envelope.fields, path), options, envelope);
		const built = (error as { readonly code?: unknown }).code;
		if (envelope.code !== built) refuse(`${path}.code`, `${String(built)}, the code of ${envelope.name}`);
		restore(error, { message: envelope.message, cleanupCause });
		return error;
	}
	const error =
		envelope.family === undefined && envelope.errors !== undefined
			? new AggregateError(rehydratedMembers(envelope.errors, path, depth, budget), envelope.message, options)
			: familyBase({ ...envelope, family: envelope.family }, options);
	preservedFields.set(error, envelope.fields);
	restore(error, {
		name: envelope.name,
		message: envelope.message,
		code: envelope.code,
		hint: envelope.family === undefined ? undefined : envelope.hint,
		cleanupCause,
	});
	return error;
}

function rehydratedMembers(members: readonly unknown[], path: string, depth: number, budget: ReceiveBudget): Error[] {
	if (depth + 1 >= MAX_CAUSE_DEPTH) return [];
	return members.map((member, index) => rehydrateOne(member, `${path}.errors[${index}]`, depth + 1, budget));
}

/**
 * The receiving side of {@link serializeError}: the same class with the same fields and causes when the receiver
 * knows it; the family base, keeping the original `name` and `code`, when it does not; a plain `Error` with that name
 * outside the known families. A storage error is rebuilt by the storage layer's `rehydrateStorageError`. An envelope that fails validation yields a {@link PoolProtocolError} naming the bad
 * member, and nothing of it is acted on.
 */
export function rehydrateError(value: unknown): Error {
	try {
		return rehydrateOne(value, "error", 0, { remaining: MAX_SERIALIZED_ERRORS });
	} catch (error) {
		if (error instanceof PoolProtocolError) return error;
		throw error;
	}
}

/** A {@link WorkflowInfrastructureError} as JSON-safe data: the envelope the pool's processes send each other. */
export type SerializedWorkflowInfrastructureError = SerializedError;

/** A workflow infrastructure error, its fields and its causes as JSON-safe data, for another process to rehydrate. */
export function serializeWorkflowInfrastructureError(
	error: WorkflowInfrastructureError,
): SerializedWorkflowInfrastructureError {
	return serializeError(error);
}

/**
 * Rebuilds what {@link serializeWorkflowInfrastructureError} sent: the same class with its fields and causes, or the
 * family base keeping a `name` and `code` this version does not know. A value that is not a valid serialized
 * infrastructure error throws a {@link PoolProtocolError} naming the bad member.
 */
export function rehydrateWorkflowInfrastructureError(
	value: SerializedWorkflowInfrastructureError,
): WorkflowInfrastructureError {
	const error = rehydrateError(value);
	if (isWorkflowInfrastructureError(error)) return error;
	throw error instanceof PoolProtocolError
		? error
		: new PoolProtocolError({ field: "error.family", expected: "workflow-infrastructure" });
}
