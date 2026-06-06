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
  /** Original error text, preserved for diagnostics. */
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

function makeWorkflowFailure(
  kind: WorkflowFailureKind,
  message: string,
  opts: {
    readonly retryable: boolean;
    readonly resumable: boolean;
    readonly recoverability: WorkflowFailureRecoverability;
    readonly disposition: WorkflowFailureDisposition;
    readonly cause: unknown;
    readonly code?: WorkflowFailureCode;
    readonly retryAfterMs?: number;
    readonly userMessage?: string;
  },
): WorkflowFailure {
  return {
    kind,
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    message,
    userMessage: opts.userMessage ?? redactSensitiveText(message),
    retryable: opts.retryable,
    resumable: opts.resumable,
    recoverability: opts.recoverability,
    disposition: opts.disposition,
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
    cause: opts.cause,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function field(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const raw = field(value, key);
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function errorMessage(error: unknown): string {
  const structuredMessage = structuredErrorMessage(error);
  if (structuredMessage !== undefined) return structuredMessage;
  if (error instanceof Error && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : stringField(error, "name");
}

function structuredErrorMessage(error: unknown): string | undefined {
  return stringField(error, "errorMessage")
    ?? stringField(error, "message")
    ?? stringField(error, "statusText");
}

type StructuredSignal = {
  readonly status?: number;
  readonly code?: string | number;
  readonly name?: string;
  readonly stopReason?: string;
  readonly message?: string;
  readonly retryAfterMs?: number;
};

type WorkflowFailureDecision = {
  readonly kind: WorkflowFailureKind;
  readonly code: WorkflowFailureCode;
  readonly retryable: boolean;
  readonly resumable: boolean;
  readonly recoverability: WorkflowFailureRecoverability;
  readonly disposition: WorkflowFailureDisposition;
  readonly userMessage?: string;
  readonly retryAfterMs?: number;
};

type WorkflowFailureClassificationSource =
  | "top_level"
  | "diagnostic"
  | "nested"
  | "cause"
  | "aggregate";

type WorkflowFailureEvidence = "strong_signal" | "weak_signal" | "message" | "status";

type WorkflowFailureClassification = {
  readonly decision: WorkflowFailureDecision;
  readonly source: WorkflowFailureClassificationSource;
  readonly evidence: WorkflowFailureEvidence;
  readonly message?: string;
};

function integerFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) ? parsed : undefined;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function retryAfterHeaderMs(value: unknown): number | undefined {
  const numeric = numberFrom(value);
  if (numeric !== undefined && numeric >= 0) return Math.round(numeric * 1000);
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function retryAfterMsFrom(error: unknown): number | undefined {
  const directMs = numberFrom(field(error, "retryAfterMs"));
  if (directMs !== undefined && directMs >= 0) return Math.round(directMs);

  const seconds = numberFrom(field(error, "retryAfterSeconds"));
  if (seconds !== undefined && seconds >= 0) return Math.round(seconds * 1000);

  const retryAfter = retryAfterHeaderMs(field(error, "retryAfter"))
    ?? retryAfterHeaderMs(field(error, "retry-after"));
  if (retryAfter !== undefined) return retryAfter;

  const headers = field(error, "headers");
  const headerRecord = asRecord(headers);
  const headerValue = headerRecord?.["retry-after"] ?? headerRecord?.["Retry-After"];
  return retryAfterHeaderMs(headerValue);
}

function structuredSignal(error: unknown): StructuredSignal {
  const status = integerFrom(field(error, "status"))
    ?? integerFrom(field(error, "statusCode"))
    ?? integerFrom(field(error, "httpStatus"));
  const rawCode = field(error, "code");
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : undefined;
  const name = errorName(error);
  const stopReason = stringField(error, "stopReason");
  const message = structuredErrorMessage(error);
  const retryAfterMs = retryAfterMsFrom(error);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function causeOf(error: unknown): unknown {
  if (error instanceof Error) return error.cause;
  return field(error, "cause");
}

function diagnosticErrors(error: unknown): readonly unknown[] {
  const diagnostics = field(error, "diagnostics");
  if (!Array.isArray(diagnostics)) return [];
  const errors: unknown[] = [];
  for (const diagnostic of diagnostics) {
    const diagnosticError = field(diagnostic, "error");
    errors.push(diagnosticError ?? diagnostic);
  }
  return errors;
}

function nestedProviderError(error: unknown): unknown {
  return field(error, "error") ?? field(error, "response") ?? field(error, "body");
}

function normalizeCode(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(value).trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

type TokenMatch = readonly string[];

function tokenize(value: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  for (const char of value.toLowerCase()) {
    if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
      current += char;
    } else if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function hasPhrase(tokens: readonly string[], phrase: TokenMatch): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let index = 0; index <= tokens.length - phrase.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (tokens[index + offset] !== phrase[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function hasAnyPhrase(tokens: readonly string[], phrases: readonly TokenMatch[]): boolean {
  return phrases.some((phrase) => hasPhrase(tokens, phrase));
}

function tokenNearAny(tokens: readonly string[], anchor: string, candidates: ReadonlySet<string>, distance: number): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== anchor) continue;
    const start = Math.max(0, index - distance);
    const end = Math.min(tokens.length - 1, index + distance);
    for (let cursor = start; cursor <= end; cursor += 1) {
      if (cursor !== index && candidates.has(tokens[cursor]!)) return true;
    }
  }
  return false;
}

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

function redactedSecretReplacement(prefix: string): string {
  return `${prefix}[redacted]`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, redactedSecretReplacement("$1"))
    .replace(/((?:api[_-]?key|token|credential|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

function authDecision(code: WorkflowFailureCode): WorkflowFailureDecision {
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

function rateLimitDecision(
  code: "rate_limited" | "quota_limited",
  retryAfterMs?: number,
  disposition: WorkflowFailureDisposition = "active_blocked",
): WorkflowFailureDecision {
  return {
    kind: "rate_limit",
    code,
    retryable: true,
    resumable: true,
    recoverability: "recoverable",
    disposition,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function providerUnavailableDecision(retryAfterMs?: number): WorkflowFailureDecision {
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

function terminalProviderConfigDecision(code: "forbidden_config" | "unknown_model"): WorkflowFailureDecision {
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

function cancelledDecision(): WorkflowFailureDecision {
  return {
    kind: "cancelled",
    code: "cancelled",
    retryable: false,
    resumable: false,
    recoverability: "non_recoverable",
    disposition: "terminal_killed",
  };
}

function unknownDecision(): WorkflowFailureDecision {
  return {
    kind: "unknown",
    code: "unknown",
    retryable: false,
    resumable: true,
    recoverability: "unknown",
    disposition: "terminal_failed",
  };
}

function strongDecisionFromNormalizedCode(normalized: string | undefined, retryAfterMs?: number): WorkflowFailureDecision | undefined {
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

function weakLoginDecisionFromNormalizedCode(normalized: string | undefined): WorkflowFailureDecision | undefined {
  return normalized !== undefined && LOGIN_REQUIRED_CODES.has(normalized)
    ? authDecision("login_required")
    : undefined;
}

function classificationForDecision(
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

function decisionFromMessageTokens(tokens: readonly string[], name: string | undefined, retryAfterMs?: number): WorkflowFailureDecision | undefined {
  if (name?.toLowerCase() === "aborterror" || hasAnyPhrase(tokens, CANCELLED_PHRASES)) return cancelledDecision();
  if (hasAnyPhrase(tokens, HTTP_RATE_LIMIT_PHRASES)) return rateLimitDecision("rate_limited", retryAfterMs);
  if (hasAnyPhrase(tokens, QUOTA_LIMIT_PHRASES)) return rateLimitDecision("quota_limited", retryAfterMs);
  if (hasAnyPhrase(tokens, RATE_LIMIT_PHRASES)) return rateLimitDecision("rate_limited", retryAfterMs, "terminal_failed");
  if (hasAnyPhrase(tokens, INVALID_API_KEY_PHRASES)) return authDecision("invalid_api_key");
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

function decisionFromStatus(signal: StructuredSignal): WorkflowFailureDecision | undefined {
  const retryAfterMs = signal.retryAfterMs;
  switch (signal.status) {
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

const STATUS_MESSAGE_REFINEMENT_CODES: ReadonlySet<WorkflowFailureCode> = new Set([
  "invalid_api_key",
  "missing_api_key",
  "unknown_model",
  "forbidden_config",
]);

const BROAD_AUTH_MESSAGE_REFINEMENT_CODES: ReadonlySet<WorkflowFailureCode> = new Set([
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

function canRefineStatusDecisionWithMessage(decision: WorkflowFailureDecision): boolean {
  return STATUS_MESSAGE_REFINEMENT_CODES.has(decision.code);
}

function canRefineWeakAuthDecisionWithMessage(decision: WorkflowFailureDecision): boolean {
  return BROAD_AUTH_MESSAGE_REFINEMENT_CODES.has(decision.code);
}

function canUseRelatedClassificationBeforeStatus(classification: WorkflowFailureClassification): boolean {
  if (classification.evidence === "weak_signal") return false;
  if (classification.evidence === "message") {
    return STATUS_RELATED_MESSAGE_REFINEMENT_CODES.has(classification.decision.code);
  }
  return classification.decision.code !== "login_required";
}

function classificationFromNormalizedCode(
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

function aggregateErrorItems(error: unknown): readonly unknown[] {
  const nativeErrors = error instanceof AggregateError ? error.errors as unknown : undefined;
  const errors = nativeErrors ?? field(error, "errors");
  return Array.isArray(errors) ? errors : [];
}

function classificationPriority(classification: WorkflowFailureClassification): number {
  if (classification.decision.disposition === "terminal_killed") return 3;
  if (
    classification.decision.disposition === "active_blocked" &&
    classification.decision.recoverability === "recoverable"
  ) return 2;
  if (classification.decision.disposition === "active_blocked") return 1;
  return 0;
}

function preferClassification(
  current: WorkflowFailureClassification | undefined,
  candidate: WorkflowFailureClassification,
): WorkflowFailureClassification {
  if (current === undefined) return candidate;
  return classificationPriority(candidate) > classificationPriority(current) ? candidate : current;
}

function aggregateClassification(error: unknown, seen: Set<unknown>): WorkflowFailureClassification | undefined {
  let selected: WorkflowFailureClassification | undefined;
  for (const innerError of aggregateErrorItems(error)) {
    const innerClassification = structuredClassification(innerError, "aggregate", seen);
    if (innerClassification !== undefined) {
      selected = preferClassification(selected, innerClassification);
    }
  }
  return selected;
}

function relatedStructuredClassification(error: unknown, seen: Set<unknown>): WorkflowFailureClassification | undefined {
  for (const diagnosticError of diagnosticErrors(error)) {
    const diagnosticClassification = structuredClassification(diagnosticError, "diagnostic", seen);
    if (diagnosticClassification !== undefined) return diagnosticClassification;
  }

  const nested = nestedProviderError(error);
  if (nested !== undefined && nested !== error) {
    const nestedClassification = structuredClassification(nested, "nested", seen);
    if (nestedClassification !== undefined) return nestedClassification;
  }

  const causeClassification = structuredClassification(causeOf(error), "cause", seen);
  if (causeClassification !== undefined) return causeClassification;

  return aggregateClassification(error, seen);
}

function structuredClassification(
  error: unknown,
  source: WorkflowFailureClassificationSource = "top_level",
  seen = new Set<unknown>(),
): WorkflowFailureClassification | undefined {
  if (error === undefined || error === null || seen.has(error)) return undefined;
  if (typeof error === "object") seen.add(error);

  const signal = structuredSignal(error);
  const signalMessage = signal.message ?? (typeof error === "string" ? error : undefined);
  if (signal.stopReason?.toLowerCase() === "aborted") {
    return classificationForDecision(cancelledDecision(), source, signalMessage, "strong_signal");
  }

  const retryAfterMs = signal.retryAfterMs;
  let weakClassification: WorkflowFailureClassification | undefined;

  const codeClassification = classificationFromNormalizedCode(normalizeCode(signal.code), retryAfterMs, source, signalMessage);
  if (codeClassification.strong !== undefined) return codeClassification.strong;
  weakClassification = codeClassification.weak ?? weakClassification;

  const nameClassification = classificationFromNormalizedCode(normalizeCode(signal.name), retryAfterMs, source, signalMessage);
  if (nameClassification.strong !== undefined) return nameClassification.strong;
  weakClassification = nameClassification.weak ?? weakClassification;

  const messageDecision = signalMessage !== undefined
    ? decisionFromMessageTokens(tokenize(signalMessage), signal.name, retryAfterMs)
    : undefined;
  if (weakClassification !== undefined && messageDecision !== undefined && canRefineWeakAuthDecisionWithMessage(messageDecision)) {
    return classificationForDecision(messageDecision, source, signalMessage);
  }

  const relatedClassification = relatedStructuredClassification(error, seen);
  const statusDecision = decisionFromStatus(signal);
  if (statusDecision !== undefined) {
    if (relatedClassification !== undefined && canUseRelatedClassificationBeforeStatus(relatedClassification)) {
      return relatedClassification;
    }
    if (
      signalMessage !== undefined &&
      (signal.status === 401 || signal.status === 403) &&
      messageDecision !== undefined &&
      canRefineStatusDecisionWithMessage(messageDecision)
    ) {
      return classificationForDecision(messageDecision, source, signalMessage);
    }
    return classificationForDecision(statusDecision, source, signalMessage, "status");
  }

  if (source !== "top_level" && messageDecision !== undefined) {
    return classificationForDecision(messageDecision, source, signalMessage);
  }

  if (relatedClassification !== undefined) return relatedClassification;

  return weakClassification;
}

function fallbackDecisionFromMessage(message: string, name: string | undefined): WorkflowFailureDecision | undefined {
  return decisionFromMessageTokens(tokenize(message), name);
}

function failureForDecision(decision: WorkflowFailureDecision, message: string, cause: unknown): WorkflowFailure {
  return makeWorkflowFailure(decision.kind, message, {
    code: decision.code,
    retryable: decision.retryable,
    resumable: decision.resumable,
    recoverability: decision.recoverability,
    disposition: decision.disposition,
    cause,
    ...(decision.userMessage !== undefined ? { userMessage: decision.userMessage } : {}),
    ...(decision.retryAfterMs !== undefined ? { retryAfterMs: decision.retryAfterMs } : {}),
  });
}

export function classifyWorkflowFailure(error: unknown): WorkflowFailure {
  const message = errorMessage(error);
  const structured = structuredClassification(error);
  if (structured !== undefined) {
    const structuredMessage = structured.message !== undefined
      ? (structured.source === "top_level" ? structured.message : redactSensitiveText(structured.message))
      : message;
    return failureForDecision(structured.decision, structuredMessage, error);
  }

  const fallback = fallbackDecisionFromMessage(message, errorName(error));
  if (fallback !== undefined) return failureForDecision(fallback, message, error);

  return failureForDecision(unknownDecision(), message, error);
}
