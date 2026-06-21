import type {
  WorkflowFailureCode,
  WorkflowFailureDisposition,
  WorkflowFailureKind,
  WorkflowFailureRecoverability,
} from "./store-types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function field(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const raw = field(value, key);
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function errorMessage(error: unknown): string {
  const structuredMessage = structuredErrorMessage(error);
  if (structuredMessage !== undefined) return structuredMessage;
  if (error instanceof Error && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : stringField(error, "name");
}

function structuredErrorMessage(error: unknown): string | undefined {
  return stringField(error, "errorMessage")
    ?? stringField(error, "message")
    ?? stringField(error, "statusText");
}

export type StructuredSignal = {
  readonly status?: number;
  readonly code?: string | number;
  readonly name?: string;
  readonly stopReason?: string;
  readonly message?: string;
  readonly retryAfterMs?: number;
};

export type WorkflowFailureDecision = {
  readonly kind: WorkflowFailureKind;
  readonly code: WorkflowFailureCode;
  readonly retryable: boolean;
  readonly resumable: boolean;
  readonly recoverability: WorkflowFailureRecoverability;
  readonly disposition: WorkflowFailureDisposition;
  readonly userMessage?: string;
  readonly retryAfterMs?: number;
};

export type WorkflowFailureClassificationSource =
  | "top_level"
  | "diagnostic"
  | "nested"
  | "cause"
  | "aggregate";

export type WorkflowFailureEvidence = "strong_signal" | "weak_signal" | "message" | "status";

export type WorkflowFailureClassification = {
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

  // Provider SDKs commonly mirror the HTTP Retry-After header as retryAfter,
  // so the ambiguous bare field follows header semantics (seconds/date). Use
  // retryAfterMs for explicit millisecond values.
  const retryAfter = retryAfterHeaderMs(field(error, "retryAfter"));
  if (retryAfter !== undefined) return retryAfter;

  const retryAfterHeader = retryAfterHeaderMs(field(error, "retry-after"));
  if (retryAfterHeader !== undefined) return retryAfterHeader;

  const headers = field(error, "headers");
  const headerRecord = asRecord(headers);
  const headerValue = headerRecord?.["retry-after"] ?? headerRecord?.["Retry-After"];
  return retryAfterHeaderMs(headerValue);
}

export function structuredSignal(error: unknown): StructuredSignal {
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

export function causeOf(error: unknown): unknown {
  if (error instanceof Error) return error.cause;
  return field(error, "cause");
}

export function diagnosticErrors(error: unknown): readonly unknown[] {
  const diagnostics = field(error, "diagnostics");
  if (!Array.isArray(diagnostics)) return [];
  const errors: unknown[] = [];
  for (const diagnostic of diagnostics) {
    const diagnosticError = field(diagnostic, "error");
    errors.push(diagnosticError ?? diagnostic);
  }
  return errors;
}

export function nestedProviderError(error: unknown): unknown {
  return field(error, "error") ?? field(error, "response") ?? field(error, "body");
}

export function normalizeCode(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(value).trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

export type StructuredCodeEvidence =
  | { readonly kind: "semantic_code"; readonly normalized: string }
  | { readonly kind: "wrapper_http_status"; readonly status: number };

function httpStatusFromCode(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
  }
  const trimmed = value.trim();
  if (!/^\d{3}$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

export function codeEvidenceFrom(value: string | number | undefined): StructuredCodeEvidence | undefined {
  const status = httpStatusFromCode(value);
  if (status !== undefined) return { kind: "wrapper_http_status", status };

  const normalized = normalizeCode(value);
  return normalized !== undefined && normalized.length > 0
    ? { kind: "semantic_code", normalized }
    : undefined;
}

export type TokenMatch = readonly string[];

export function tokenize(value: string): readonly string[] {
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

export function hasPhrase(tokens: readonly string[], phrase: TokenMatch): boolean {
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

export function hasAnyPhrase(tokens: readonly string[], phrases: readonly TokenMatch[]): boolean {
  return phrases.some((phrase) => hasPhrase(tokens, phrase));
}

export function tokenNearAny(tokens: readonly string[], anchor: string, candidates: ReadonlySet<string>, distance: number): boolean {
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

function redactedSecretReplacement(prefix: string): string {
  return `${prefix}[redacted]`;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, redactedSecretReplacement("$1"))
    .replace(/\b(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|credential|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}
