import type {
	WorkflowFailureCode,
	WorkflowFailureDisposition,
	WorkflowFailureKind,
	WorkflowFailureRecoverability,
} from "./store-types.js";

export interface WorkflowFailure {
	readonly kind: WorkflowFailureKind;
	/** Specific additive reason within the existing broad failure kind. */
	readonly code?: WorkflowFailureCode;
	/** Redacted diagnostic text safe for snapshots and persistence. */
	readonly message: string;
	/** Sanitized workflow-facing text shown on run/stage snapshots. */
	readonly userMessage: string;
	readonly retryable: boolean;
	readonly resumable: boolean;
	readonly recoverability: WorkflowFailureRecoverability;
	readonly disposition: WorkflowFailureDisposition;
	readonly retryAfterMs?: number;
	readonly cause?: unknown;
}

export const WORKFLOW_AUTH_FAILURE_MESSAGE = "You must be logged in to run workflows. Run /login and try again.";

export const WORKFLOW_AUTH_TIMEOUT_FAILURE_MESSAGE =
	"Request authentication timed out. Check the provider's credential source and resume the workflow.";

export const WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE =
	"A required model provider API key is missing. Configure the provider credentials and resume the workflow.";

export const WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE =
	"The configured model provider credentials are invalid. Update the provider API key, then start a new workflow run.";

export const WORKFLOW_FORBIDDEN_MODEL_CONFIG_MESSAGE =
	"The configured model provider or model is not available with the current credentials. Update the model configuration, then start a new workflow run.";

export const WORKFLOW_UNKNOWN_MODEL_MESSAGE =
	"The configured model is not available. Update the workflow model configuration, then start a new workflow run.";

const WORKFLOW_FAILURE_KINDS: ReadonlySet<WorkflowFailureKind> = new Set([
	"auth",
	"rate_limit",
	"provider",
	"cancelled",
	"unknown",
]);

export function isWorkflowFailureKind(kind: string): kind is WorkflowFailureKind {
	return WORKFLOW_FAILURE_KINDS.has(kind as WorkflowFailureKind);
}

/** Every failure code: the type requires each `WorkflowFailureCode` here, so the guard below cannot miss one. */
const WORKFLOW_FAILURE_CODES: Readonly<Record<WorkflowFailureCode, true>> = {
	login_required: true,
	auth_timeout: true,
	missing_api_key: true,
	invalid_api_key: true,
	forbidden_config: true,
	unknown_model: true,
	rate_limited: true,
	quota_limited: true,
	provider_unavailable: true,
	pending_stage_delivery_failed: true,
	session_unavailable: true,
	worker_lost: true,
	worker_cleanup_unconfirmed: true,
	worker_retry_limit: true,
	worker_startup_failed: true,
	stale_work_lease: true,
	intercom_unavailable: true,
	storage_unavailable: true,
	process_cleanup_unconfirmed: true,
	cancelled: true,
	unknown: true,
};

export function isWorkflowFailureCode(code: string): code is WorkflowFailureCode {
	return Object.hasOwn(WORKFLOW_FAILURE_CODES, code);
}

export function isWorkflowFailureRecoverability(value: string): value is WorkflowFailureRecoverability {
	return value === "recoverable" || value === "non_recoverable" || value === "unknown";
}

export function isWorkflowFailureDisposition(value: string): value is WorkflowFailureDisposition {
	return value === "active_blocked" || value === "terminal_killed" || value === "terminal_failed";
}
