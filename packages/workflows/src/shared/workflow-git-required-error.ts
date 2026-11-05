import {
	findGitProvisionError,
	type GitProvisionError,
	isGitProvisionError,
	rehydrateGitProvisionError,
	type SerializedGitProvisionError,
} from "@bastani/atomic";

const WORKFLOW_GIT_REQUIRED_ERROR_NAME = "WorkflowGitRequiredError";
const GIT_REQUIRED_CODE = "git-required";

/** Where the workflow asked for a git worktree. */
export type WorkflowGitRequiredSource = "input" | "task-option";

export interface WorkflowGitRequiredFields {
	readonly workflow: string;
	readonly runId: string;
	readonly source: WorkflowGitRequiredSource;
	/** The workflow input bound to `gitWorktreeDir`, or the task name for a `task-option` source. */
	readonly field: string;
	/** The requested worktree path; a path, never a secret. Absent for a task that asks for a temporary worktree. */
	readonly gitWorktreeDir?: string;
}

export interface SerializedWorkflowGitRequiredError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: WorkflowGitRequiredFields;
	readonly cause?: SerializedGitProvisionError;
}

function describeRequest(fields: WorkflowGitRequiredFields): string {
	return fields.source === "input"
		? `"${fields.workflow}" creates a worktree at input ${fields.field} (${fields.gitWorktreeDir})`
		: `task "${fields.field}" of "${fields.workflow}" creates a worktree${
				fields.gitWorktreeDir === undefined ? "" : ` (${fields.gitWorktreeDir})`
			}`;
}

/**
 * A workflow run asked for a git worktree, and git cannot be provided. Thrown before the run's body or the task's
 * stage starts. `cause` is the git provisioning error; `hint` and `retryable` are copied from it, so its install
 * command reaches the user unchanged.
 */
export class WorkflowGitRequiredError extends Error {
	override readonly name = WORKFLOW_GIT_REQUIRED_ERROR_NAME;
	readonly code = GIT_REQUIRED_CODE;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: WorkflowGitRequiredFields;
	declare readonly cause: GitProvisionError;

	constructor(fields: WorkflowGitRequiredFields, cause: GitProvisionError) {
		super(
			`Workflow needs git: ${describeRequest(fields)}, but git is unavailable (${cause.code}). ${cause.hint} (${GIT_REQUIRED_CODE})`,
			{ cause },
		);
		this.hint = cause.hint;
		this.retryable = cause.retryable;
		this.fields = fields;
	}

	toJSON(): SerializedWorkflowGitRequiredError {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			hint: this.hint,
			retryable: this.retryable,
			fields: this.fields,
			cause: this.cause.toJSON(),
		};
	}
}

export function isWorkflowGitRequiredError(value: unknown): value is WorkflowGitRequiredError {
	if (value instanceof WorkflowGitRequiredError) return true;
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { name?: unknown; code?: unknown };
	return candidate.name === WORKFLOW_GIT_REQUIRED_ERROR_NAME && candidate.code === GIT_REQUIRED_CODE;
}

/** Restore a serialized {@link WorkflowGitRequiredError} as the same class, with its git cause. */
export function rehydrateWorkflowGitRequiredError(
	payload: SerializedWorkflowGitRequiredError,
): WorkflowGitRequiredError {
	if (payload.cause === undefined)
		throw new TypeError("A serialized WorkflowGitRequiredError must carry its git provisioning cause");
	return new WorkflowGitRequiredError(payload.fields, rehydrateGitProvisionError(payload.cause));
}

/** The git provisioning error behind `error`, wrapped for the workflow that needed it; anything else is returned as is. */
export function wrapGitRequired(error: unknown, fields: WorkflowGitRequiredFields): unknown {
	const gitError = isGitProvisionError(error) ? error : findGitProvisionError(error);
	return gitError === undefined ? error : new WorkflowGitRequiredError(fields, gitError);
}
