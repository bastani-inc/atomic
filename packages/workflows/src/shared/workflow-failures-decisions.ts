import type { WorkflowFailureCode } from "./store-types.js";
import {
  WORKFLOW_AUTH_FAILURE_MESSAGE,
  WORKFLOW_FORBIDDEN_MODEL_CONFIG_MESSAGE,
  WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
  WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE,
  WORKFLOW_UNKNOWN_MODEL_MESSAGE,
} from "./workflow-failures-contract.js";
import {
  hasAnyPhrase,
  hasPhrase,
  tokenNearAny,
  tokenize,
  type TokenMatch,
  type WorkflowFailureClassification,
  type WorkflowFailureClassificationSource,
  type WorkflowFailureDecision,
  type WorkflowFailureEvidence,
} from "./workflow-failures-signals.js";

const INVALID_API_KEY_CODES = new Set([
  "401",
  "invalid_api_key",
  "incorrect_api_key",
  "invalid_api_key_error",
  "invalid_credentials",
  "bad_credentials",
  "authentication_error",
]);

const LOGIN_REQUIRED_CODES = new Set([
  "auth",
  "auth_required",
  "authentication_required",
  "login_required",
  "not_logged_in",
]);

const MISSING_API_KEY_CODES = new Set([
  "missing_api_key",
  "api_key_missing",
  "no_api_key",
]);

const RATE_LIMIT_CODES = new Set([
  "429",
  "rate_limit",
  "rate_limited",
  "rate_limit_exceeded",
  "too_many_requests",
]);

const QUOTA_LIMIT_CODES = new Set([
  "quota",
  "quota_exceeded",
  "insufficient_quota",
  "usage_limit",
  "usage_limit_exceeded",
]);

const CANCELLED_CODES = new Set([
  "aborterror",
  "aborted",
  "cancelled",
  "canceled",
]);

const PROVIDER_UNAVAILABLE_CODES = new Set([
  "500",
  "502",
  "503",
  "504",
  "provider_error",
  "service_unavailable",
  "temporarily_unavailable",
  "overloaded",
  "timeout",
  "network_error",
]);

const UNKNOWN_MODEL_CODES = new Set([
  "unknown_model",
  "model_not_found",
  "model_not_available",
  "unsupported_model",
]);

const FORBIDDEN_CONFIG_CODES = new Set([
  "403",
  "forbidden",
  "permission_denied",
  "access_denied",
  "forbidden_config",
  "invalid_model_config",
  "model_access_denied",
]);

const LOGIN_REQUIRED_PHRASES: readonly TokenMatch[] = [
  ["not", "logged", "in"],
  ["log", "in"],
  ["login", "required"],
  ["authentication", "required"],
  ["please", "login"],
  ["please", "log", "in"],
  ["unauthorized"],
];

const LOCAL_LOGIN_REQUIRED_PHRASES: readonly TokenMatch[] = [
  ["not", "logged", "in"],
  ["login", "required"],
  ["please", "login"],
  ["please", "log", "in"],
  ["log", "in", "to", "continue"],
];

const PROVIDER_AUTH_FALLBACK_PHRASES: readonly TokenMatch[] = [
  ["unauthorized"],
  ["authentication", "required"],
];

const MISSING_API_KEY_PHRASES: readonly TokenMatch[] = [
  ["no", "api", "key"],
  ["api", "key", "not", "found"],
  ["missing", "api", "key"],
  ["api", "key", "missing"],
  ["no", "model", "selected"],
  ["no", "models", "available"],
];

const INVALID_API_KEY_PHRASES: readonly TokenMatch[] = [
  ["incorrect", "api", "key"],
  ["invalid", "api", "key"],
  ["api", "key", "invalid"],
  ["api", "key", "incorrect"],
  ["invalid", "credentials"],
  ["invalid", "credential"],
];

const INVALID_API_KEY_CONTEXT = new Set(["invalid", "incorrect"]);

const HTTP_RATE_LIMIT_PHRASES: readonly TokenMatch[] = [
  ["429"],
  ["too", "many", "requests"],
];

const RATE_LIMIT_PHRASES: readonly TokenMatch[] = [
  ["rate", "limit"],
  ["rate", "limited"],
];

const QUOTA_LIMIT_PHRASES: readonly TokenMatch[] = [
  ["quota"],
  ["quota", "exceeded"],
  ["insufficient", "quota"],
  ["usage", "limit"],
];

const CANCELLED_PHRASES: readonly TokenMatch[] = [
  ["aborted"],
  ["cancelled"],
  ["canceled"],
];

const UNKNOWN_MODEL_PHRASES: readonly TokenMatch[] = [
  ["model", "not", "found"],
  ["unknown", "model"],
  ["unsupported", "model"],
  ["model", "does", "not", "exist"],
  ["model", "not", "available"],
];

const FORBIDDEN_CONFIG_PHRASES: readonly TokenMatch[] = [
  ["forbidden", "config"],
  ["forbidden", "configuration"],
  ["permission", "denied"],
  ["access", "denied"],
  ["not", "allowed", "to", "access", "model"],
  ["does", "not", "have", "access", "to", "model"],
];

const PROVIDER_UNAVAILABLE_PHRASES: readonly TokenMatch[] = [
  ["overloaded"],
  ["temporarily", "unavailable"],
  ["service", "unavailable"],
  ["provider", "unavailable"],
  ["provider", "error"],
  ["model", "unavailable"],
  ["503"],
];

const AUTH_CONTEXT = new Set([
  "token",
  "credential",
  "credentials",
  "required",
  "expired",
  "invalid",
  "missing",
  "unauthorized",
  "login",
  "signin",
]);

const MODEL_PROVIDER_CONTEXT = new Set([
  "unavailable",
  "overloaded",
  "temporarily",
  "service",
]);

const PROVIDER_CONTEXT = new Set([
  "error",
  "failure",
  "failed",
  "overloaded",
  "unavailable",
  "temporarily",
  "service",
]);

export function authDecision(code: WorkflowFailureCode): WorkflowFailureDecision {
  if (code === "invalid_api_key") {
    return {
      kind: "auth",
      code,
      retryable: false,
      resumable: false,
      recoverability: "non_recoverable",
      disposition: "terminal_killed",
      userMessage: WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
    };
  }
  if (code === "missing_api_key") {
    return {
      kind: "auth",
      code,
      retryable: true,
      resumable: true,
      recoverability: "recoverable",
      disposition: "active_blocked",
      userMessage: WORKFLOW_MISSING_API_KEY_FAILURE_MESSAGE,
    };
  }
  return {
    kind: "auth",
    code: "login_required",
    retryable: true,
    resumable: true,
    recoverability: "recoverable",
    disposition: "active_blocked",
    userMessage: WORKFLOW_AUTH_FAILURE_MESSAGE,
  };
}

export function rateLimitDecision(
  code: "rate_limited" | "quota_limited",
  retryAfterMs?: number,
): WorkflowFailureDecision {
  return {
    kind: "rate_limit",
    code,
    retryable: true,
    resumable: true,
    recoverability: "recoverable",
    disposition: "active_blocked",
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export function providerUnavailableDecision(retryAfterMs?: number): WorkflowFailureDecision {
  return {
    kind: "provider",
    code: "provider_unavailable",
    retryable: true,
    resumable: true,
    recoverability: "recoverable",
    disposition: "active_blocked",
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export function terminalProviderConfigDecision(code: "forbidden_config" | "unknown_model"): WorkflowFailureDecision {
  return {
    kind: "provider",
    code,
    retryable: false,
    resumable: false,
    recoverability: "non_recoverable",
    disposition: "terminal_killed",
    userMessage: code === "unknown_model" ? WORKFLOW_UNKNOWN_MODEL_MESSAGE : WORKFLOW_FORBIDDEN_MODEL_CONFIG_MESSAGE,
  };
}

export function cancelledDecision(): WorkflowFailureDecision {
  return {
    kind: "cancelled",
    code: "cancelled",
    retryable: false,
    resumable: false,
    recoverability: "non_recoverable",
    disposition: "terminal_killed",
  };
}

export function unknownDecision(): WorkflowFailureDecision {
  return {
    kind: "unknown",
    code: "unknown",
    retryable: false,
    resumable: true,
    recoverability: "unknown",
    disposition: "terminal_failed",
  };
}

export function strongDecisionFromNormalizedCode(normalized: string | undefined, retryAfterMs?: number): WorkflowFailureDecision | undefined {
  if (normalized === undefined) return undefined;
  if (CANCELLED_CODES.has(normalized)) return cancelledDecision();
  if (INVALID_API_KEY_CODES.has(normalized)) return authDecision("invalid_api_key");
  if (MISSING_API_KEY_CODES.has(normalized)) return authDecision("missing_api_key");
  if (RATE_LIMIT_CODES.has(normalized)) return rateLimitDecision("rate_limited", retryAfterMs);
  if (QUOTA_LIMIT_CODES.has(normalized)) return rateLimitDecision("quota_limited", retryAfterMs);
  if (UNKNOWN_MODEL_CODES.has(normalized)) return terminalProviderConfigDecision("unknown_model");
  if (FORBIDDEN_CONFIG_CODES.has(normalized)) return terminalProviderConfigDecision("forbidden_config");
  if (PROVIDER_UNAVAILABLE_CODES.has(normalized)) return providerUnavailableDecision(retryAfterMs);
  return undefined;
}

export function weakLoginDecisionFromNormalizedCode(normalized: string | undefined): WorkflowFailureDecision | undefined {
  return normalized !== undefined && LOGIN_REQUIRED_CODES.has(normalized)
    ? authDecision("login_required")
    : undefined;
}

export function classificationForDecision(
  decision: WorkflowFailureDecision,
  source: WorkflowFailureClassificationSource,
  message: string | undefined,
  evidence: WorkflowFailureEvidence = "message",
): WorkflowFailureClassification {
  return {
    decision,
    source,
    evidence,
    ...(message !== undefined ? { message } : {}),
  };
}

export function hasInvalidApiKeyMessage(tokens: readonly string[]): boolean {
  return hasAnyPhrase(tokens, INVALID_API_KEY_PHRASES)
    || (hasPhrase(tokens, ["api", "key"]) && tokenNearAny(tokens, "key", INVALID_API_KEY_CONTEXT, 6));
}

export function decisionFromMessageTokens(tokens: readonly string[], name: string | undefined, retryAfterMs?: number): WorkflowFailureDecision | undefined {
  if (name?.toLowerCase() === "aborterror" || hasAnyPhrase(tokens, CANCELLED_PHRASES)) return cancelledDecision();
  if (hasAnyPhrase(tokens, HTTP_RATE_LIMIT_PHRASES)) return rateLimitDecision("rate_limited", retryAfterMs);
  if (hasAnyPhrase(tokens, QUOTA_LIMIT_PHRASES)) return rateLimitDecision("quota_limited", retryAfterMs);
  if (hasAnyPhrase(tokens, RATE_LIMIT_PHRASES)) return rateLimitDecision("rate_limited", retryAfterMs);
  if (hasInvalidApiKeyMessage(tokens)) return authDecision("invalid_api_key");
  if (hasAnyPhrase(tokens, MISSING_API_KEY_PHRASES)) return authDecision("missing_api_key");
  if (hasAnyPhrase(tokens, LOGIN_REQUIRED_PHRASES) || tokenNearAny(tokens, "oauth", AUTH_CONTEXT, 8)) return authDecision("login_required");
  if (hasAnyPhrase(tokens, UNKNOWN_MODEL_PHRASES)) return terminalProviderConfigDecision("unknown_model");
  if (hasAnyPhrase(tokens, FORBIDDEN_CONFIG_PHRASES)) return terminalProviderConfigDecision("forbidden_config");
  if (
    hasAnyPhrase(tokens, PROVIDER_UNAVAILABLE_PHRASES)
    || tokenNearAny(tokens, "model", MODEL_PROVIDER_CONTEXT, 8)
    || tokenNearAny(tokens, "provider", PROVIDER_CONTEXT, 8)
  ) return providerUnavailableDecision(retryAfterMs);
  return undefined;
}

export function decisionFromStatus(status: number | undefined, retryAfterMs: number | undefined): WorkflowFailureDecision | undefined {
  switch (status) {
    case 401:
      return authDecision("invalid_api_key");
    case 403:
      return terminalProviderConfigDecision("forbidden_config");
    case 429:
      return rateLimitDecision("rate_limited", retryAfterMs);
    case 500:
    case 502:
    case 503:
    case 504:
      return providerUnavailableDecision(retryAfterMs);
    default:
      return undefined;
  }
}

export const STATUS_MESSAGE_REFINEMENT_CODES: ReadonlySet<WorkflowFailureCode> = new Set([
  "invalid_api_key",
  "missing_api_key",
  "unknown_model",
  "forbidden_config",
]);

export const BROAD_AUTH_MESSAGE_REFINEMENT_CODES: ReadonlySet<WorkflowFailureCode> = new Set([
  "invalid_api_key",
  "missing_api_key",
]);

const STATUS_RELATED_MESSAGE_REFINEMENT_CODES: ReadonlySet<WorkflowFailureCode> = new Set([
  "invalid_api_key",
  "missing_api_key",
  "unknown_model",
  "forbidden_config",
  "rate_limited",
  "quota_limited",
  "cancelled",
]);

export function isRecoverableActiveBlocked(classification: WorkflowFailureClassification): boolean {
  return classification.decision.disposition === "active_blocked"
    && classification.decision.recoverability === "recoverable";
}

export function canUseRelatedClassificationBeforeStatus(classification: WorkflowFailureClassification): boolean {
  if (classification.evidence === "weak_signal") return false;
  if (classification.evidence === "message") {
    return STATUS_RELATED_MESSAGE_REFINEMENT_CODES.has(classification.decision.code);
  }
  return classification.decision.code !== "login_required";
}

export function isClearLocalLoginMessage(message: string, tokens: readonly string[] = tokenize(message)): boolean {
  if (message.toLowerCase().includes("/login")) return true;
  return hasAnyPhrase(tokens, LOCAL_LOGIN_REQUIRED_PHRASES);
}

function hasFallbackApiError401(tokens: readonly string[]): boolean {
  return hasPhrase(tokens, ["401"]) && hasPhrase(tokens, ["api", "error"]);
}

export function classifyFallbackProviderAuthMessage(message: string, tokens: readonly string[]): WorkflowFailureDecision | undefined {
  if (isClearLocalLoginMessage(message, tokens)) return undefined;
  return hasAnyPhrase(tokens, PROVIDER_AUTH_FALLBACK_PHRASES) || hasFallbackApiError401(tokens)
    ? authDecision("invalid_api_key")
    : undefined;
}

export function canUseLoginClassificationBeforeWrapper401(
  classification: WorkflowFailureClassification | undefined,
): classification is WorkflowFailureClassification {
  if (classification === undefined || classification.decision.code !== "login_required") return false;
  return classification.evidence === "weak_signal"
    || classification.evidence === "strong_signal"
    || (classification.message !== undefined && isClearLocalLoginMessage(classification.message));
}

export function classificationFromNormalizedCode(
  normalized: string | undefined,
  retryAfterMs: number | undefined,
  source: WorkflowFailureClassificationSource,
  message: string | undefined,
): { readonly strong?: WorkflowFailureClassification; readonly weak?: WorkflowFailureClassification } {
  const strong = strongDecisionFromNormalizedCode(normalized, retryAfterMs);
  if (strong !== undefined) {
    return { strong: classificationForDecision(strong, source, message, "strong_signal") };
  }
  const weak = weakLoginDecisionFromNormalizedCode(normalized);
  return weak !== undefined
    ? { weak: classificationForDecision(weak, source, message, "weak_signal") }
    : {};
}

export function fallbackDecisionFromMessage(message: string, name: string | undefined): WorkflowFailureDecision | undefined {
  const tokens = tokenize(message);
  const decision = decisionFromMessageTokens(tokens, name);
  const providerAuthDecision = classifyFallbackProviderAuthMessage(message, tokens);
  if (providerAuthDecision !== undefined && (decision === undefined || decision.code === "login_required")) {
    return providerAuthDecision;
  }
  if (decision === undefined && isClearLocalLoginMessage(message, tokens)) {
    return authDecision("login_required");
  }
  return decision;
}
