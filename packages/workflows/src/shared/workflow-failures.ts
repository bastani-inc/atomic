import type { WorkflowFailureKind } from "./store-types.js";

export interface WorkflowFailure {
  readonly kind: WorkflowFailureKind;
  /** Original error text, preserved for diagnostics. */
  readonly message: string;
  /** Sanitized workflow-facing text shown on run/stage snapshots. */
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly resumable: boolean;
  readonly cause?: unknown;
}

export const WORKFLOW_AUTH_FAILURE_MESSAGE =
  "You must be logged in to run workflows. Run /login and try again.";

export const NON_BLOCKING_MCP_OAUTH_INIT_MESSAGE = "MCP OAuth initialization failed";

const NON_BLOCKING_MCP_OAUTH_INIT_PREFIXES = [
  `${NON_BLOCKING_MCP_OAUTH_INIT_MESSAGE}\r\n`,
  `${NON_BLOCKING_MCP_OAUTH_INIT_MESSAGE}\n`,
] as const;

export function sanitizeWorkflowVisibleError(message: string): string {
  for (const prefix of NON_BLOCKING_MCP_OAUTH_INIT_PREFIXES) {
    if (message.startsWith(prefix)) return message.slice(prefix.length);
  }
  return message;
}

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

function makeWorkflowFailure(
  kind: WorkflowFailureKind,
  message: string,
  opts: {
    readonly retryable: boolean;
    readonly resumable: boolean;
    readonly cause: unknown;
    readonly userMessage?: string;
  },
): WorkflowFailure {
  return {
    kind,
    message,
    userMessage: opts.userMessage ?? sanitizeWorkflowVisibleError(message),
    retryable: opts.retryable,
    resumable: opts.resumable,
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
};

function integerFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) ? parsed : undefined;
}

function structuredSignal(error: unknown): StructuredSignal {
  const status = integerFrom(field(error, "status"))
    ?? integerFrom(field(error, "statusCode"))
    ?? integerFrom(field(error, "httpStatus"));
  const rawCode = field(error, "code");
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(errorName(error) !== undefined ? { name: errorName(error)! } : {}),
    ...(stringField(error, "stopReason") !== undefined ? { stopReason: stringField(error, "stopReason")! } : {}),
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

function normalizeCode(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(value).trim().toLowerCase().replaceAll("-", "_");
}

function kindFromStatus(status: number | undefined): WorkflowFailureKind | undefined {
  switch (status) {
    case 401:
    case 403:
      return "auth";
    case 429:
      return "rate_limit";
    case 500:
    case 502:
    case 503:
    case 504:
      return "provider";
    default:
      return undefined;
  }
}

function kindFromCode(code: string | number | undefined): WorkflowFailureKind | undefined {
  const normalized = normalizeCode(code);
  switch (normalized) {
    case undefined:
      return undefined;
    case "401":
    case "403":
    case "auth":
    case "auth_required":
    case "authentication_required":
    case "unauthorized":
    case "forbidden":
    case "invalid_api_key":
    case "missing_api_key":
      return "auth";
    case "429":
    case "rate_limit":
    case "rate_limit_exceeded":
    case "too_many_requests":
    case "quota_exceeded":
      return "rate_limit";
    case "aborterror":
    case "aborted":
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "500":
    case "502":
    case "503":
    case "504":
    case "provider_error":
    case "service_unavailable":
    case "temporarily_unavailable":
    case "overloaded":
      return "provider";
    default:
      return undefined;
  }
}

function structuredKind(error: unknown, seen = new Set<unknown>()): WorkflowFailureKind | undefined {
  if (error === undefined || error === null || seen.has(error)) return undefined;
  if (typeof error === "object") seen.add(error);

  const signal = structuredSignal(error);
  if (signal.stopReason?.toLowerCase() === "aborted") return "cancelled";
  const statusKind = kindFromStatus(signal.status);
  if (statusKind !== undefined) return statusKind;
  const codeKind = kindFromCode(signal.code) ?? kindFromCode(signal.name);
  if (codeKind !== undefined) return codeKind;

  for (const diagnosticError of diagnosticErrors(error)) {
    const diagnosticKind = structuredKind(diagnosticError, seen);
    if (diagnosticKind !== undefined) return diagnosticKind;
  }

  return structuredKind(causeOf(error), seen);
}

function failureForKind(kind: WorkflowFailureKind, message: string, cause: unknown): WorkflowFailure {
  switch (kind) {
    case "auth":
      return makeWorkflowFailure("auth", message, {
        userMessage: WORKFLOW_AUTH_FAILURE_MESSAGE,
        retryable: true,
        resumable: true,
        cause,
      });
    case "rate_limit":
      return makeWorkflowFailure("rate_limit", message, {
        retryable: true,
        resumable: true,
        cause,
      });
    case "cancelled":
      return makeWorkflowFailure("cancelled", message, {
        retryable: false,
        resumable: false,
        cause,
      });
    case "provider":
      return makeWorkflowFailure("provider", message, {
        retryable: true,
        resumable: true,
        cause,
      });
    case "unknown":
      return makeWorkflowFailure("unknown", message, {
        retryable: false,
        resumable: true,
        cause,
      });
  }
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

const AUTH_PHRASES: readonly TokenMatch[] = [
  ["no", "api", "key"],
  ["api", "key", "not", "found"],
  ["missing", "api", "key"],
  ["no", "model", "selected"],
  ["no", "models", "available"],
  ["not", "logged", "in"],
  ["log", "in"],
  ["login", "required"],
  ["authentication", "required"],
  ["unauthorized"],
];

const RATE_LIMIT_PHRASES: readonly TokenMatch[] = [
  ["rate", "limit"],
  ["429"],
  ["quota"],
  ["too", "many", "requests"],
];

const CANCELLED_PHRASES: readonly TokenMatch[] = [
  ["aborted"],
  ["cancelled"],
  ["canceled"],
];

const PROVIDER_PHRASES: readonly TokenMatch[] = [
  ["model", "not", "found"],
  ["overloaded"],
  ["temporarily", "unavailable"],
  ["service", "unavailable"],
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

function fallbackKindFromMessage(message: string, name: string | undefined): WorkflowFailureKind | undefined {
  const tokens = tokenize(message);
  if (hasAnyPhrase(tokens, AUTH_PHRASES) || tokenNearAny(tokens, "oauth", AUTH_CONTEXT, 8)) return "auth";
  if (hasAnyPhrase(tokens, RATE_LIMIT_PHRASES)) return "rate_limit";
  if (name?.toLowerCase() === "aborterror" || hasAnyPhrase(tokens, CANCELLED_PHRASES)) return "cancelled";
  if (
    hasAnyPhrase(tokens, PROVIDER_PHRASES)
    || tokenNearAny(tokens, "model", MODEL_PROVIDER_CONTEXT, 8)
    || tokenNearAny(tokens, "provider", PROVIDER_CONTEXT, 8)
  ) return "provider";
  return undefined;
}

export function classifyWorkflowFailure(error: unknown): WorkflowFailure {
  const message = errorMessage(error);
  const structured = structuredKind(error);
  if (structured !== undefined) return failureForKind(structured, message, error);

  const fallback = fallbackKindFromMessage(message, errorName(error));
  if (fallback !== undefined) return failureForKind(fallback, message, error);

  return failureForKind("unknown", message, error);
}
