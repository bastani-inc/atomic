/**
 * Shared model/provider failure classification.
 *
 * Workflows, subagents, and the main chat all need the same decision about
 * whether a provider failure may spend another model candidate. Keep this
 * module free of AgentSession and workflow imports so the published SDK can
 * expose it to the raw-TypeScript companion packages without a cycle.
 */

const RETRYABLE_MODEL_FAILURE_PATTERNS: readonly RegExp[] = [
	/rate\s*limit/i,
	/too\s*many\s*requests/i,
	/\b429\b/,
	/quota/i,
	/usage[\s_-]*limit/i,
	/billing/i,
	/credit/i,
	/auth(?:entication|orization)?/i,
	/unauthori[sz]ed/i,
	/\b40[13]\b/,
	/api[_\s-]*key/i,
	/token[_\s-]*expired/i,
	/token[_\s-]*(?:revoked|invalidated)/i,
	/invalidated[_\s-]+(?:oauth|auth)[_\s-]+token/i,
	/forbidden/i,
	/invalid\s*key/i,
	/overloaded/i,
	/temporarily\s*unavailable/i,
	/service\s*unavailable/i,
	/network/i,
	/fetch/i,
	/getaddrinfo/i,
	/ENOTFOUND/i,
	/EAI_AGAIN/i,
	/socket/i,
	/connection\s*refused/i,
	/upstream/i,
	/timeout/i,
	/timed\s*out/i,
	/\b50[0-4]\b/,
	/\b524\b/,
	/provider.?returned.?error/i,
	/server.?error/i,
	/internal.?error/i,
	/connection.?error/i,
	/connection.?lost/i,
	/other side closed/i,
	/websocket.?closed/i,
	/websocket.?error/i,
	/reset before headers/i,
	/socket hang up/i,
	/ended without/i,
	/stream ended before message_stop/i,
	/stream ended before a terminal response event/i,
	/http2 request did not get a response/i,
	/retry delay/i,
	/finish.?reason:?\s*error/i,
	/terminated/i,
	/you can retry your request/i,
	/try your request again/i,
	/please retry your request/i,
	// gRPC based providers (e.g. NVIDIA NIM); upstream pi-ai retries this too.
	/ResourceExhausted/i,
];

const NON_RETRYABLE_FAILURE_PATTERNS: readonly RegExp[] = [
	/command failed/i,
	/tests? failed/i,
	/shell/i,
	/missing file/i,
	/no such file/i,
	/cancel/i,
	/abort/i,
	/interrupted/i,
];

const CANCELLED_FAILURE_PATTERNS: readonly RegExp[] = [/cancel/i, /abort/i, /interrupted/i];

const TRANSPORT_CANCELLATION_FAILURE_PATTERNS: readonly RegExp[] = [/getaddrinfo|ENOTFOUND|EAI_AGAIN/i];

export type ModelFallbackFailureKind =
	| "auth_on_candidate_provider"
	| "rate_limit"
	| "provider_unavailable"
	| "network_timeout"
	| "transport_error"
	| "model_unavailable"
	| "request_incompatible"
	| "cancelled"
	| "task_failure"
	| "unknown";

export type ModelFallbackFailureSource =
	| "assistant_message"
	| "diagnostic"
	| "throw"
	| "structured"
	| "string_fallback";

export interface ModelFallbackFailureSignal {
	readonly kind: ModelFallbackFailureKind;
	readonly message: string;
	readonly source: ModelFallbackFailureSource;
	readonly stopReason?: string;
	readonly status?: number;
	readonly code?: string | number;
	readonly name?: string;
}

const FALLBACKABLE_FAILURE_KINDS: ReadonlySet<ModelFallbackFailureKind> = new Set([
	"auth_on_candidate_provider",
	"rate_limit",
	"provider_unavailable",
	"network_timeout",
	"transport_error",
	"model_unavailable",
	"request_incompatible",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function field(value: unknown, key: string): unknown {
	return asRecord(value)?.[key];
}

function stringField(value: unknown, key: string): string | undefined {
	const raw = field(value, key);
	return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

function errorName(value: unknown): string | undefined {
	return value instanceof Error ? value.name : stringField(value, "name");
}

function directMessageFrom(value: unknown): string | undefined {
	return stringField(value, "errorMessage") ?? stringField(value, "message") ?? stringField(value, "statusText");
}

function integerFrom(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const parsed = Number(value.trim());
	return Number.isInteger(parsed) ? parsed : undefined;
}

function statusFrom(value: unknown): number | undefined {
	return (
		integerFrom(field(value, "status")) ??
		integerFrom(field(value, "statusCode")) ??
		integerFrom(field(value, "httpStatus"))
	);
}

function codeFrom(value: unknown): string | number | undefined {
	const rawCode = field(value, "code");
	return typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : undefined;
}

function stopReasonFrom(value: unknown): string | undefined {
	return stringField(value, "stopReason");
}

function finishReasonFrom(value: unknown): string | undefined {
	return stringField(value, "finish_reason") ?? stringField(value, "finishReason");
}

function causeOf(value: unknown): unknown {
	return value instanceof Error ? value.cause : field(value, "cause");
}

function diagnosticErrors(value: unknown): readonly unknown[] {
	const diagnostics = field(value, "diagnostics");
	if (!Array.isArray(diagnostics)) return [];
	const errors: unknown[] = [];
	for (const diagnostic of diagnostics) {
		const diagnosticType = stringField(diagnostic, "type");
		const diagnosticError = field(diagnostic, "error");
		errors.push(
			normalizeCode(diagnosticType) === "provider_transport_failure" ? diagnostic : (diagnosticError ?? diagnostic),
		);
	}
	return errors;
}

function normalizeCode(value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	const raw = String(value).trim().toLowerCase();
	if (!raw) return undefined;
	let normalized = "";
	let needsSeparator = false;
	for (const char of raw) {
		const code = char.charCodeAt(0);
		const isLowerAlpha = code >= 97 && code <= 122;
		const isDigit = code >= 48 && code <= 57;
		if (isLowerAlpha || isDigit) {
			normalized += char;
			needsSeparator = true;
			continue;
		}
		if (needsSeparator && normalized[normalized.length - 1] !== "_") normalized += "_";
	}
	if (normalized.endsWith("_")) normalized = normalized.slice(0, -1);
	return normalized.length > 0 ? normalized : undefined;
}

function messageLooksLikeModelUnavailable(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes("model") &&
		(lower.includes("unavailable") ||
			lower.includes("disabled") ||
			lower.includes("not found") ||
			lower.includes("unknown"))
	);
}

function kindFromStatus(status: number | undefined): ModelFallbackFailureKind | undefined {
	switch (status) {
		case 400:
		case 413:
		case 422:
			return "request_incompatible";
		case 401:
		case 403:
			return "auth_on_candidate_provider";
		case 408:
			return "network_timeout";
		case 404:
			return "model_unavailable";
		case 429:
			return "rate_limit";
		default:
			if (status !== undefined && status >= 500 && status <= 599) return "provider_unavailable";
			return undefined;
	}
}

function refusalKindFromCode(code: string | number | undefined): ModelFallbackFailureKind | undefined {
	const normalizedCode = normalizeCode(code);
	if (normalizedCode === undefined) return undefined;
	if (normalizedCode.includes("content_filter") || normalizedCode.includes("contentfilter")) return "task_failure";
	if (normalizedCode.includes("safety") || normalizedCode.includes("policy")) return "task_failure";
	switch (normalizedCode) {
		case "blocked":
		case "blocked_by_provider":
		case "blocked_by_safety":
		case "blocked_by_policy":
		case "provider_refusal":
		case "refusal":
		case "tool_refusal":
		case "tool_call_refusal":
		case "tool_use_refusal":
			return "task_failure";
		default:
			return undefined;
	}
}

const REQUEST_INCOMPATIBLE_CODES: ReadonlySet<string> = new Set([
	"invalid_request",
	"invalid_request_error",
	"bad_request",
	"context_length_exceeded",
	"request_too_large",
	"too_large",
	"request_entity_too_large",
	"max_tokens",
	"max_context_length",
	"context_window_exceeded",
]);

function requestIncompatibleKindFromCode(code: string | number | undefined): ModelFallbackFailureKind | undefined {
	const normalized = normalizeCode(code);
	return normalized !== undefined && REQUEST_INCOMPATIBLE_CODES.has(normalized) ? "request_incompatible" : undefined;
}

function kindFromCode(code: string | number | undefined): ModelFallbackFailureKind | undefined {
	const normalizedCode = normalizeCode(code);
	if (normalizedCode === undefined) return undefined;
	const refusalKind = refusalKindFromCode(code);
	if (refusalKind !== undefined) return refusalKind;
	const httpStatusKind = kindFromStatus(integerFrom(code));
	if (httpStatusKind !== undefined) return httpStatusKind;
	const requestIncompatibleKind = requestIncompatibleKindFromCode(code);
	if (requestIncompatibleKind !== undefined) return requestIncompatibleKind;

	switch (normalizedCode) {
		case "auth":
		case "auth_required":
		case "authentication_required":
		case "unauthorized":
		case "forbidden":
		case "invalid_api_key":
		case "missing_api_key":
		case "invalid_key":
		case "token_expired":
		case "token_revoked":
		case "token_invalidated":
		case "oauth_token_invalidated":
			return "auth_on_candidate_provider";
		case "etimedout":
		case "econnreset":
		case "econnrefused":
		case "enotfound":
		case "eai_again":
		case "fetch_failed":
		case "network_error":
		case "timeout":
		case "timeout_error":
		case "und_err_connect_timeout":
			return "network_timeout";
		case "rate_limit":
		case "rate_limit_exceeded":
		case "too_many_requests":
		case "quota_exceeded":
		case "insufficient_quota":
		case "usage_limit":
		case "usage_limit_reached":
		case "usage_limit_exceeded":
			return "rate_limit";
		case "aborterror":
		case "aborted":
		case "cancelled":
		case "canceled":
			return "cancelled";
		case "model_not_found":
		case "model_unavailable":
		case "model_disabled":
		case "unknown_model":
			return "model_unavailable";
		case "provider_error":
		case "api_error":
		case "service_unavailable":
		case "temporarily_unavailable":
		case "overloaded":
			return "provider_unavailable";
		default:
			return undefined;
	}
}

const REQUEST_INCOMPATIBLE_FAILURE_PATTERNS: readonly RegExp[] = [
	/\bcontext[_\s-]?length(?:[_\s-]?exceeded)?\b/i,
	/\bcontext[_\s-]?window(?:[_\s-]?exceeded)?\b/i,
	/\bmax[_\s-]?context\b/i,
	/\bmax[_\s-]?tokens?\b/i,
	/\brequest(?:[_\s-]?entity)?[_\s-]?too[_\s-]?large\b/i,
	/\btoo[_\s-]?large\b/i,
	/\b(?:unsupported|unknown|invalid)\s+(?:tool|parameter|function)\b/i,
	/\b(?:tool|parameter|function)\s+(?:not\s+(?:supported|found|allowed)|unknown|invalid)\b/i,
	/\binvalid[_\s-]?request(?:[_\s-]?error)?\b/i,
	/\bbad[_\s-]?request\b/i,
];

const PROVIDER_REFUSAL_FAILURE_PATTERNS: readonly RegExp[] = [
	/\bthe\s+model\s+refused\s+to\s+complete\s+the\s+request\b/i,
	/\bfinish[_\s-]?reason\b[^\n]*\bcontent[_\s-]?filter\b/i,
	/\bcontent[_\s-]?filter(?:ed|ing)?\b/i,
	/\b(?:safety|policy)\b[^\n]*\b(?:refus(?:e|al|ed|es|ing)?|block(?:ed|ing)?|filter(?:ed|ing)?|violat(?:e|ion|ed|ing)?|disallow(?:ed|ing)?|reject(?:ed|ion|ing)?)\b/i,
	/\b(?:refus(?:e|al|ed|es|ing)?|block(?:ed|ing)?|filter(?:ed|ing)?|violat(?:e|ion|ed|ing)?|disallow(?:ed|ing)?|reject(?:ed|ion|ing)?)\b[^\n]*\b(?:safety|policy)\b/i,
	/\btool[_\s-]?(?:call|use)?[_\s-]?refus(?:e|al|ed|es|ing)?\b/i,
	/\btool(?:\s+call|\s+use)?\b[^\n]*\brefus(?:e|al|ed|es|ing)?\b/i,
	/\brefus(?:e|al|ed|es|ing)?\b[^\n]*\btool(?:\s+call|\s+use)?\b/i,
	/\bprovider[_\s-]?refus(?:e|al|ed|es|ing)?\b/i,
	/\bprovider\b[^\n]*\brefus(?:e|al|ed|es|ing)?\b[^\n]*\b(?:prompt|request|content|policy|safety)\b/i,
];

const TRANSPORT_OUTAGE_FAILURE_PATTERNS: readonly RegExp[] = [/^connection\s+error\.?$/i, /^fetch\s+failed\.?$/i];

function transportOutageKindFromMessage(message: string): ModelFallbackFailureKind | undefined {
	return TRANSPORT_OUTAGE_FAILURE_PATTERNS.some((pattern) => pattern.test(message.trim()))
		? "transport_error"
		: undefined;
}

function refusalKindFromMessage(message: string): ModelFallbackFailureKind | undefined {
	if (TRANSPORT_CANCELLATION_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "network_timeout";
	if (CANCELLED_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "cancelled";
	if (NON_RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "task_failure";
	if (PROVIDER_REFUSAL_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "task_failure";
	return undefined;
}

function fallbackKindFromMessage(message: string, name: string | undefined): ModelFallbackFailureKind | undefined {
	const refusalKind = refusalKindFromMessage(message);
	if (refusalKind !== undefined) return refusalKind;
	const transportOutageKind = transportOutageKindFromMessage(message);
	if (transportOutageKind !== undefined) return transportOutageKind;
	if (REQUEST_INCOMPATIBLE_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "request_incompatible";
	const nameKind = kindFromCode(name);
	if (nameKind !== undefined) return nameKind;
	const hasRetryablePattern =
		RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(message)) ||
		messageLooksLikeModelUnavailable(message);
	if (!hasRetryablePattern) return undefined;
	if (/rate\s*limit|too\s*many\s*requests|\b429\b|quota|usage[\s_-]*limit|billing|credit/i.test(message))
		return "rate_limit";
	if (
		/auth|unauthori[sz]ed|\b40[13]\b|api[_\s-]*key|token[_\s-]*(?:expired|revoked|invalidated|rejected)|forbidden|invalid[_\s-]*key/i.test(
			message,
		)
	)
		return "auth_on_candidate_provider";
	if (messageLooksLikeModelUnavailable(message)) return "model_unavailable";
	if (/network|fetch|socket|connection\s*refused|getaddrinfo|ENOTFOUND|EAI_AGAIN|timeout|timed\s*out/i.test(message))
		return "network_timeout";
	return "provider_unavailable";
}

function signalSource(value: unknown, fallback: ModelFallbackFailureSource | undefined): ModelFallbackFailureSource {
	if (fallback !== undefined) return fallback;
	if (stopReasonFrom(value) !== undefined || diagnosticErrors(value).length > 0) return "assistant_message";
	if (value instanceof Error) return "throw";
	return "structured";
}

function makeSignal(
	kind: ModelFallbackFailureKind,
	value: unknown,
	source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal {
	const status = statusFrom(value);
	const code = codeFrom(value);
	const name = errorName(value);
	const stopReason = stopReasonFrom(value);
	return {
		kind,
		message: errorMessage(value),
		source: signalSource(value, source),
		...(stopReason !== undefined ? { stopReason } : {}),
		...(status !== undefined ? { status } : {}),
		...(code !== undefined ? { code } : {}),
		...(name !== undefined ? { name } : {}),
	};
}

function fallbackSignalFromDirectMessage(
	value: unknown,
	source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal | undefined {
	const message = directMessageFrom(value);
	if (message === undefined) return undefined;
	const kind = fallbackKindFromMessage(message, errorName(value));
	return kind === undefined ? undefined : makeSignal(kind, value, source);
}

function fallbackSignalFromMessage(
	value: unknown,
	source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal | undefined {
	const message = errorMessage(value);
	if (!message.trim()) return undefined;
	const kind = fallbackKindFromMessage(message, errorName(value));
	return kind === undefined ? undefined : makeSignal(kind, value, source);
}

function classifyAssistantRefusalSignal(
	value: unknown,
	source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal | undefined {
	const codeRefusalKind =
		refusalKindFromCode(codeFrom(value)) ??
		refusalKindFromCode(errorName(value)) ??
		refusalKindFromCode(finishReasonFrom(value));
	if (codeRefusalKind !== undefined) return makeSignal(codeRefusalKind, value, source);

	const messageRefusalKind = refusalKindFromMessage(directMessageFrom(value) ?? "");
	return messageRefusalKind === undefined ? undefined : makeSignal(messageRefusalKind, value, source);
}

function isRefusalSignal(signal: ModelFallbackFailureSignal): boolean {
	return signal.kind === "cancelled" || signal.kind === "task_failure";
}

function nestedSignalPriority(signal: ModelFallbackFailureSignal): number {
	switch (signal.kind) {
		case "cancelled":
		case "task_failure":
			return 100;
		case "auth_on_candidate_provider":
			return 90;
		case "request_incompatible":
			return 85;
		case "model_unavailable":
			return 80;
		case "rate_limit":
			return 70;
		case "provider_unavailable":
			return 60;
		case "network_timeout":
			return 50;
		case "transport_error":
			return 82;
		case "unknown":
			return 0;
	}
}
function structuredSignal(
	value: unknown,
	seen: Set<unknown>,
	source?: ModelFallbackFailureSource,
): ModelFallbackFailureSignal | undefined {
	if (value === undefined || value === null || seen.has(value)) return undefined;
	if (typeof value === "object") seen.add(value);

	const stopReason = stopReasonFrom(value)?.toLowerCase();
	const diagnosticType = stringField(value, "type");
	const providerTransportSignal =
		diagnosticType !== undefined && normalizeCode(diagnosticType) === "provider_transport_failure"
			? makeSignal("transport_error", value, source)
			: undefined;
	if (stopReason === "aborted") return makeSignal("cancelled", value, source);

	// Defer direct refusal/cancellation signals until nested diagnostics and
	// causes have been inspected. A transport wrapper can carry a cancellation
	// or provider refusal that must win over the wrapper's transport label.
	const directRefusalSignal = classifyAssistantRefusalSignal(value, source);
	const codeKind = kindFromCode(codeFrom(value));
	const nameKind = kindFromCode(errorName(value));
	const directCancellationSignal =
		codeKind === "cancelled" || nameKind === "cancelled" ? makeSignal("cancelled", value, source) : undefined;

	let bestNestedFallbackSignal: ModelFallbackFailureSignal | undefined;
	const nestedSeen = new Set(seen);
	const nestedValues: readonly { value: unknown; source?: ModelFallbackFailureSource }[] = [
		...diagnosticErrors(value).map((diagnosticError) => ({ value: diagnosticError, source: "diagnostic" as const })),
		...(field(value, "error") === undefined ? [] : [{ value: field(value, "error"), source }]),
	];
	for (const nested of nestedValues) {
		const nestedSignal =
			structuredSignal(nested.value, nestedSeen, nested.source) ??
			fallbackSignalFromMessage(nested.value, nested.source);
		if (nestedSignal === undefined) continue;
		if (isRefusalSignal(nestedSignal)) return nestedSignal;
		if (
			bestNestedFallbackSignal === undefined ||
			nestedSignalPriority(nestedSignal) > nestedSignalPriority(bestNestedFallbackSignal)
		) {
			bestNestedFallbackSignal = nestedSignal;
		}
	}
	const cause = causeOf(value);
	const causeSignal = structuredSignal(cause, nestedSeen, source) ?? fallbackSignalFromMessage(cause, source);
	if (causeSignal !== undefined) {
		if (isRefusalSignal(causeSignal)) return causeSignal;
		if (
			bestNestedFallbackSignal === undefined ||
			nestedSignalPriority(causeSignal) > nestedSignalPriority(bestNestedFallbackSignal)
		) {
			bestNestedFallbackSignal = causeSignal;
		}
	}

	const directSignals = [
		directRefusalSignal,
		directCancellationSignal,
		providerTransportSignal,
		fallbackSignalFromDirectMessage(value, source),
		kindFromStatus(statusFrom(value)) === undefined
			? undefined
			: makeSignal(kindFromStatus(statusFrom(value))!, value, source),
		kindFromCode(codeFrom(value)) === undefined
			? undefined
			: makeSignal(kindFromCode(codeFrom(value))!, value, source),
		kindFromCode(errorName(value)) === undefined
			? undefined
			: makeSignal(kindFromCode(errorName(value))!, value, source),
	].filter((signal): signal is ModelFallbackFailureSignal => signal !== undefined);
	for (const directSignal of directSignals) {
		if (isRefusalSignal(directSignal)) return directSignal;
		if (
			bestNestedFallbackSignal === undefined ||
			nestedSignalPriority(directSignal) > nestedSignalPriority(bestNestedFallbackSignal)
		) {
			bestNestedFallbackSignal = directSignal;
		}
	}

	if (bestNestedFallbackSignal !== undefined) return bestNestedFallbackSignal;
	if (stopReason === "error") return makeSignal("provider_unavailable", value, source);
	return undefined;
}

function messageFromUnknown(value: unknown, seen: Set<unknown>): string | undefined {
	if (value === undefined || value === null || seen.has(value)) return undefined;
	if (typeof value === "string") return value.trim().length > 0 ? value : undefined;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (typeof value === "symbol" || typeof value === "function") return undefined;
	seen.add(value);

	if (value instanceof Error && value.message.trim().length > 0) return value.message;
	const directMessage = directMessageFrom(value);
	if (directMessage !== undefined) return directMessage;
	for (const diagnosticError of diagnosticErrors(value)) {
		const diagnosticMessage = messageFromUnknown(diagnosticError, seen);
		if (diagnosticMessage !== undefined) return diagnosticMessage;
	}
	const causeMessage = messageFromUnknown(causeOf(value), seen);
	if (causeMessage !== undefined) return causeMessage;
	const finishReason = finishReasonFrom(value);
	if (finishReason !== undefined) return `Model request finished with finish_reason:${finishReason}`;
	const stopReason = stopReasonFrom(value);
	if (stopReason !== undefined) return `Assistant message ended with stopReason:${stopReason}`;
	const status = statusFrom(value);
	if (status !== undefined) return `Model request failed with status ${status}`;
	const code = codeFrom(value);
	if (code !== undefined) return `Model request failed with code ${String(code)}`;
	return undefined;
}

export function errorMessage(error: unknown): string {
	const structuredMessage = messageFromUnknown(error, new Set());
	if (structuredMessage !== undefined) return structuredMessage;
	const rendered = String(error);
	return rendered === "[object Object]" ? "Model request failed" : rendered;
}

/** Alias used by the subagent package's older public helper name. */
export const modelFailureMessage = errorMessage;

export function normalizeModelFailureSignal(error: unknown): ModelFallbackFailureSignal {
	const structured = structuredSignal(error, new Set());
	if (structured !== undefined) return structured;
	const message = errorMessage(error);
	const name = errorName(error);
	const fallbackKind = message.trim().length > 0 ? fallbackKindFromMessage(message, name) : undefined;
	return {
		kind: fallbackKind ?? "unknown",
		message,
		source: "string_fallback",
		...(name !== undefined ? { name } : {}),
	};
}

/** Whether a task-failure signal is a provider safety/refusal response. */
export function isSafetyRefusalFailure(error: unknown): boolean {
	const signal = normalizeModelFailureSignal(error);
	if (signal.kind !== "task_failure") return false;
	const text = `${signal.message}\n${signal.code ?? ""}\n${signal.name ?? ""}`;
	return PROVIDER_REFUSAL_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when this failure may spend a configured model fallback candidate. */
export function isRetryableModelFailure(error: unknown): boolean {
	if (error === undefined) return false;
	return FALLBACKABLE_FAILURE_KINDS.has(normalizeModelFailureSignal(error).kind);
}

const SAME_MODEL_RETRYABLE_FAILURE_KINDS: ReadonlySet<ModelFallbackFailureKind> = new Set([
	"rate_limit",
	"provider_unavailable",
	"network_timeout",
	"transport_error",
]);

/** True when the same model may be requested again before fallback advances. */
export function isRetryableSameModelFailure(error: unknown): boolean {
	if (!isRetryableModelFailure(error)) return false;
	const signal = normalizeModelFailureSignal(error);
	if (!SAME_MODEL_RETRYABLE_FAILURE_KINDS.has(signal.kind)) return false;
	if (
		signal.kind === "provider_unavailable" &&
		signal.source === "assistant_message" &&
		signal.status === undefined &&
		signal.code === undefined &&
		signal.name === undefined &&
		!RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(signal.message))
	)
		return false;
	return true;
}
