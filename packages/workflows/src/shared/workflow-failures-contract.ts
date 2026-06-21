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

export const WORKFLOW_AUTH_FAILURE_MESSAGE =
  "You must be logged in to run workflows. Run /login and try again.";

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

export function isWorkflowFailureCode(code: string): code is WorkflowFailureCode {
  switch (code) {
    case "login_required":
    case "missing_api_key":
    case "invalid_api_key":
    case "forbidden_config":
    case "unknown_model":
    case "rate_limited":
    case "quota_limited":
    case "provider_unavailable":
    case "cancelled":
    case "unknown":
      return true;
    default:
      return false;
  }
}

export function isWorkflowFailureRecoverability(value: string): value is WorkflowFailureRecoverability {
  return value === "recoverable" || value === "non_recoverable" || value === "unknown";
}

export function isWorkflowFailureDisposition(value: string): value is WorkflowFailureDisposition {
  return value === "active_blocked" || value === "terminal_killed" || value === "terminal_failed";
}
