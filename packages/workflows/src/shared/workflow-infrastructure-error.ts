import {
	isTaskCleanupAdmissionTimeoutError,
	isTaskCleanupError,
	type ResourceFailure,
	rehydrateTaskCleanupError,
	type TaskCleanupAdmissionTimeoutError,
	type TaskCleanupError,
	type TaskCleanupPhase,
} from "@bastani/atomic";

export type WorkflowInfrastructureFault =
	| "worker_lost"
	| "worker_cleanup_unconfirmed"
	| "worker_retry_limit"
	| "worker_startup_failed"
	| "stale_work_lease"
	| "intercom_unavailable"
	| "storage_unavailable"
	| "process_cleanup_unconfirmed";

const WORKFLOW_INFRASTRUCTURE_ERROR_NAME = "WorkflowInfrastructureError";

/** Every infrastructure fault, as a stage or run failure records it in `failureCode`. */
export const WORKFLOW_INFRASTRUCTURE_FAULTS: ReadonlySet<string> = new Set<WorkflowInfrastructureFault>([
	"worker_lost",
	"worker_cleanup_unconfirmed",
	"worker_retry_limit",
	"worker_startup_failed",
	"stale_work_lease",
	"intercom_unavailable",
	"storage_unavailable",
	"process_cleanup_unconfirmed",
]);
const MAX_CAUSE_DEPTH = 8;

const FAULT_PATTERNS: readonly (readonly [RegExp, WorkflowInfrastructureFault])[] = [
	[/Local worker (?:process )?cleanup (?:was not confirmed|unconfirmed)/, "worker_cleanup_unconfirmed"],
	[/Local worker retry limit/, "worker_retry_limit"],
	[/Local worker (?:startup timed out|exited before readiness)/, "worker_startup_failed"],
	[/Worker exited before delivery acknowledgement|Local worker pool coordinator exited/, "worker_lost"],
	[/Stale work lease|Stale resource admission attempt/, "stale_work_lease"],
	[/Intercom runtime no longer active/, "intercom_unavailable"],
	[/Storage unavailable/, "storage_unavailable"],
];

export class WorkflowInfrastructureError extends Error {
	override readonly name = WORKFLOW_INFRASTRUCTURE_ERROR_NAME;
	readonly retryable = true;
	readonly code: WorkflowInfrastructureFault;
	constructor(code: WorkflowInfrastructureFault, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
	}
}

function isInfrastructureError(value: unknown): value is WorkflowInfrastructureError {
	if (value instanceof WorkflowInfrastructureError) return true;
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { name?: unknown; retryable?: unknown; code?: unknown };
	return (
		candidate.name === WORKFLOW_INFRASTRUCTURE_ERROR_NAME &&
		candidate.retryable === true &&
		typeof candidate.code === "string"
	);
}

/** A resource a stage's task cleanup left unconfirmed, with the task that owned it. */
export interface ProcessCleanupResource extends ResourceFailure {
	readonly taskId: string;
}

/**
 * `process_cleanup_unconfirmed`: a stage's task process cleanup was still unconfirmed when the stage closed. The
 * stage's work is done, so retrying it can succeed, and a resume continues the stage from its saved session. The
 * fields come from the `TaskCleanupError` that is its cause.
 */
export class ProcessCleanupUnconfirmedError extends WorkflowInfrastructureError {
	declare readonly code: "process_cleanup_unconfirmed";
	readonly hint: string;
	readonly phase: TaskCleanupPhase;
	readonly resources: readonly ProcessCleanupResource[];
	declare readonly cause: TaskCleanupError;

	/** `message` keeps the text of an error rebuilt from another process; otherwise it is built from the fields. */
	constructor(cause: TaskCleanupError, message?: string) {
		const resources = cause.failures.flatMap((failure) =>
			failure.resources.map((resource) => ({ taskId: failure.taskId, ...resource })),
		);
		const subject = resources.length > 0 ? resources.map((resource) => resource.resource).join(", ") : "owned tasks";
		super(
			"process_cleanup_unconfirmed",
			message ??
				`Workflow stage task cleanup was not confirmed: ${subject} (process_cleanup_unconfirmed). ${cause.hint}.`,
			{ cause },
		);
		this.hint = cause.hint;
		this.phase = cause.phase;
		this.resources = resources;
	}
}

/** True for a {@link ProcessCleanupUnconfirmedError}, also a copy from another realm that kept its fields. */
export function isProcessCleanupUnconfirmedError(error: unknown): error is ProcessCleanupUnconfirmedError {
	if (error instanceof ProcessCleanupUnconfirmedError) return true;
	return (
		isInfrastructureError(error) &&
		error.code === "process_cleanup_unconfirmed" &&
		Array.isArray((error as { readonly resources?: unknown }).resources)
	);
}

/** A {@link WorkflowInfrastructureError} as JSON-safe data, for crossing a process boundary. */
export interface SerializedWorkflowInfrastructureError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint?: string;
	readonly fields?: { readonly phase: TaskCleanupPhase; readonly resources: readonly ProcessCleanupResource[] };
	readonly cause?: Pick<TaskCleanupError, "name" | "code" | "retryable" | "hint" | "phase" | "failures"> &
		Partial<Pick<TaskCleanupAdmissionTimeoutError, "timeoutMs" | "elapsedMs">>;
}

export function serializeWorkflowInfrastructureError(
	error: WorkflowInfrastructureError,
): SerializedWorkflowInfrastructureError {
	if (!isProcessCleanupUnconfirmedError(error)) return { name: error.name, code: error.code, message: error.message };
	const cause: unknown = error.cause;
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		fields: { phase: error.phase, resources: error.resources },
		// A copy that kept the class's fields but lost its cause still serializes, without one.
		...(isTaskCleanupError(cause)
			? {
					cause: {
						name: cause.name,
						code: cause.code,
						retryable: cause.retryable,
						hint: cause.hint,
						phase: cause.phase,
						failures: cause.failures,
						...(isTaskCleanupAdmissionTimeoutError(cause)
							? { timeoutMs: cause.timeoutMs, elapsedMs: cause.elapsedMs }
							: {}),
					},
				}
			: {}),
	};
}

/** The cause a serialized error's `fields` describe: the constructor's flattening undone, then validated. */
function causeFromFields(fields: SerializedWorkflowInfrastructureError["fields"]): TaskCleanupError | undefined {
	if (!Array.isArray(fields?.resources)) return undefined;
	const failures: { taskId: unknown; resources: object[] }[] = [];
	for (const entry of fields.resources as readonly (Partial<ProcessCleanupResource> | null)[]) {
		const resource = { resource: entry?.resource, code: entry?.code, message: entry?.message };
		const last = failures.at(-1);
		if (last !== undefined && last.taskId === entry?.taskId) last.resources.push(resource);
		else failures.push({ taskId: entry?.taskId, resources: [resource] });
	}
	return rehydrateTaskCleanupError({
		name: "TaskCleanupError",
		code: "task_cleanup_unconfirmed",
		phase: fields.phase,
		failures,
	});
}

/**
 * Rebuilds a serialized error as the same class, keeping its message. `process_cleanup_unconfirmed` becomes a
 * {@link ProcessCleanupUnconfirmedError} from its cause, or from its `fields` when the cause is lost or malformed;
 * its `hint` is the cause's, which is fixed. Any other code, or no valid cause or fields, gives the base class with
 * its code and message.
 */
export function rehydrateWorkflowInfrastructureError(
	value: SerializedWorkflowInfrastructureError,
): WorkflowInfrastructureError {
	const cause = rehydrateTaskCleanupError(value.cause);
	if (value.code !== "process_cleanup_unconfirmed")
		return new WorkflowInfrastructureError(
			value.code as WorkflowInfrastructureFault,
			value.message,
			cause && { cause },
		);
	const rebuilt = cause ?? causeFromFields(value.fields);
	return rebuilt
		? new ProcessCleanupUnconfirmedError(rebuilt, value.message)
		: new WorkflowInfrastructureError("process_cleanup_unconfirmed", value.message);
}

export function isRetryableWorkflowError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
		if (isInfrastructureError(current)) return true;
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
}

export function workflowInfrastructureFault(message: string): WorkflowInfrastructureFault | undefined {
	return FAULT_PATTERNS.find(([pattern]) => pattern.test(message))?.[1];
}

export function asWorkflowInfrastructureError(error: unknown): WorkflowInfrastructureError | undefined {
	if (isInfrastructureError(error)) return error;
	if (!(error instanceof Error)) return undefined;
	const code = workflowInfrastructureFault(error.message);
	return code === undefined ? undefined : new WorkflowInfrastructureError(code, error.message, { cause: error });
}

/**
 * Whether a failed run result failed on infrastructure: its classified failure, its error, or the error or failure
 * code of a failed stage names an infrastructure fault. Results recorded before stage failures were classified by
 * fault carry only the fault's message, which this recognizes too.
 */
export function failedOnInfrastructureFault(result: {
	readonly status?: unknown;
	readonly error?: unknown;
	readonly failure?: unknown;
	readonly stages?: unknown;
}): boolean {
	if (result.status !== "failed") return false;
	const names = (value: unknown) =>
		typeof value === "string" &&
		(WORKFLOW_INFRASTRUCTURE_FAULTS.has(value) || workflowInfrastructureFault(value) !== undefined);
	const failure = result.failure as { readonly code?: unknown } | null | undefined;
	if (names(failure?.code) || names(result.error)) return true;
	return (
		Array.isArray(result.stages) &&
		result.stages.some(
			(stage: { readonly status?: unknown; readonly error?: unknown; readonly failureCode?: unknown }) =>
				stage?.status === "failed" && (names(stage.failureCode) || names(stage.error)),
		)
	);
}

/** The fault a result {@link failedOnInfrastructureFault} failed on: its error, or the error of its first faulted stage. */
export function infrastructureFaultMessage(result: {
	readonly error?: unknown;
	readonly failure?: unknown;
	readonly stages?: unknown;
}): string {
	const names = (value: unknown): value is string =>
		typeof value === "string" &&
		(WORKFLOW_INFRASTRUCTURE_FAULTS.has(value) || workflowInfrastructureFault(value) !== undefined);
	if (names(result.error)) return result.error;
	const stage = Array.isArray(result.stages)
		? (
				result.stages as readonly {
					readonly status?: unknown;
					readonly error?: unknown;
					readonly failureCode?: unknown;
				}[]
			).find(
				(candidate) => candidate?.status === "failed" && (names(candidate.failureCode) || names(candidate.error)),
			)
		: undefined;
	if (typeof stage?.error === "string") return stage.error;
	if (typeof stage?.failureCode === "string") return stage.failureCode;
	const code = (result.failure as { readonly code?: unknown } | null | undefined)?.code;
	return typeof code === "string" ? code : typeof result.error === "string" ? result.error : "pool fault";
}
