export type WorkflowInfrastructureFault =
	| "worker_lost"
	| "worker_cleanup_unconfirmed"
	| "worker_retry_limit"
	| "worker_startup_failed"
	| "stale_work_lease"
	| "intercom_unavailable"
	| "storage_unavailable";

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
