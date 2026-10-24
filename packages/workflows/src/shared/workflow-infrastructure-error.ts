export type WorkflowInfrastructureFault =
	| "worker_lost"
	| "worker_cleanup_unconfirmed"
	| "worker_retry_limit"
	| "worker_startup_failed"
	| "stale_work_lease"
	| "intercom_unavailable"
	| "storage_unavailable";

const WORKFLOW_INFRASTRUCTURE_ERROR_NAME = "WorkflowInfrastructureError";
const MAX_CAUSE_DEPTH = 8;

const FAULT_PATTERNS: readonly (readonly [RegExp, WorkflowInfrastructureFault])[] = [
	[/Local worker (?:process )?cleanup (?:was not confirmed|unconfirmed)/, "worker_cleanup_unconfirmed"],
	[/Local worker retry limit/, "worker_retry_limit"],
	[/Local worker (?:startup timed out|exited before readiness)/, "worker_startup_failed"],
	[/Worker exited before delivery acknowledgement|Local worker pool coordinator exited/, "worker_lost"],
	[/Stale work lease/, "stale_work_lease"],
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
