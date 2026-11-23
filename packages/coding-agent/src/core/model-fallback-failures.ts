/**
 * Shared model/provider failure classification.
 *
 * Subagents and the main chat all need the same decision about
 * whether a provider failure may spend another model candidate. Keep this
 * module free of AgentSession imports so the published SDK can
 * expose it to the raw-TypeScript companion packages without a cycle.
 */

import {
	findGitHubCopilotError,
	findTlsCertificateRefusal,
	type GitHubCopilotError,
	type GitHubCopilotErrorCode,
	GitHubCopilotStreamEndedEarlyError,
	getTlsCertificateRefusal,
} from "@bastani/atomic-ai";
import { isExtensionStartupFailure } from "./extension-startup-failure.ts";

const RETRYABLE_MODEL_FAILURE_PATTERNS: readonly RegExp[] = [
	/rate\s*limit/i,
	/too\s*many\s*requests/i,
	/\bthrottl(?:ing|ed)\b/i,
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
	/timed\s+out/i,
	/\b50[0-4]\b/,
	/\b52[0-4]\b/,
	/\b529\b/,
	/provider.?returned.?error/i,
	/server.?error/i,
	/internal.?error/i,
	/connection.?error/i,
	/connection.?lost/i,
	/connection.?closed/i,
	/connection.?reset/i,
	/(?<![a-z0-9_])(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|UND_ERR_BODY_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_CONNECT_TIMEOUT)(?![a-z0-9_])/i,
	/other side closed/i,
	/websocket.?closed/i,
	/websocket.?error/i,
	/reset before headers/i,
	/socket hang up/i,
	/ended without/i,
	/stream ended before message_stop/i,
	/stream ended before a terminal response event/i,
	/http2 request did not get a response/i,
	/pending stream has been canceled/i,
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
];

// "cancel" as a word of its own: an HTTP/2 stream error code such as `NGHTTP2_CANCEL` is a transport reset, not a user
// cancellation (#4918).
const CANCELLED_FAILURE_PATTERNS: readonly RegExp[] = [/(?<![a-z0-9_])cancel/i, /abort/i, /interrupted/i];

const TRANSPORT_CANCELLATION_FAILURE_PATTERNS: readonly RegExp[] = [
	/getaddrinfo|ENOTFOUND|EAI_AGAIN/i,
	/(?<![a-z0-9_])ECONNABORTED(?![a-z0-9_])|software caused connection abort/i,
	/pending stream has been canceled/i,
	// An HTTP/2 stream reset by the peer or a proxy, such as `Stream closed with error code NGHTTP2_CANCEL`.
	/(?<![a-z0-9])NGHTTP2_[A-Z_]+|(?<![a-z0-9_])ERR_HTTP2_STREAM_(?:ERROR|CANCEL)(?![a-z0-9_])/i,
];

export type ModelFallbackFailureKind =
	| "auth_on_candidate_provider"
	| "certificate_refused"
	| "rate_limit"
	| "quota_exhausted"
	| "provider_unavailable"
	| "network_timeout"
	| "transport_error"
	| "model_unavailable"
	| "request_incompatible"
	| "content_filter"
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

/** How a caller treats a provider content-filter refusal; `retry.fallbackOnContentFilter` in settings. */
export interface ModelFallbackFailureOptions {
	/** Whether a content-filter refusal may spend the next fallback candidate. Defaults to true. */
	readonly fallbackOnContentFilter?: boolean;
}

const FALLBACKABLE_FAILURE_KINDS: ReadonlySet<ModelFallbackFailureKind> = new Set([
	"auth_on_candidate_provider",
	// The next candidate's endpoint may show a certificate the runtime trusts (#6114).
	"certificate_refused",
	"rate_limit",
	"quota_exhausted",
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
		integerFrom(field(value, "httpStatus")) ??
		// Provider failure diagnostics (`bedrock_response_failure`) keep the HTTP status in `details.status` (#4918).
		integerFrom(field(field(value, "details"), "status"))
	);
}

function codeFrom(value: unknown): string | number | undefined {
	const rawCode = field(value, "code");
	if (typeof rawCode === "string" || typeof rawCode === "number") return rawCode;
	// Provider failure diagnostics (`bedrock_response_failure`) keep the modeled error code in `details.errorCode`,
	// because the provider's display message replaces the exception name with a readable prefix.
	const detailsCode = field(field(value, "details"), "errorCode");
	return typeof detailsCode === "string" ? detailsCode : undefined;
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
		case 402:
			return "quota_exhausted";
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
	// A refused tool call, such as `tool_call_refusal` or `tool_use_refused_by_policy`, before the policy words.
	if (/(?:^|_)tool(?:_|$)/.test(normalizedCode) && normalizedCode.includes("refus")) return "task_failure";
	if (normalizedCode.includes("content_filter") || normalizedCode.includes("contentfilter")) return "content_filter";
	// Includes OpenAI's `cyber_policy`.
	if (normalizedCode.includes("safety") || normalizedCode.includes("policy")) return "content_filter";
	switch (normalizedCode) {
		case "blocked":
		case "blocked_by_provider":
		case "blocked_by_safety":
		case "blocked_by_policy":
		case "provider_refusal":
		case "refusal":
			return "content_filter";
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
	if (CREDENTIAL_REJECTION_CODES.has(normalizedCode)) return "auth_on_candidate_provider";
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
			return "auth_on_candidate_provider";
		case "etimedout":
		case "econnreset":
		case "econnrefused":
		case "econnaborted":
		case "epipe":
		case "enotfound":
		case "eai_again":
		case "fetch_failed":
		case "network_error":
		case "timeout":
		case "timeout_error":
		case "und_err_connect_timeout":
		case "und_err_body_timeout":
		case "und_err_headers_timeout":
			return "network_timeout";
		case "err_http2_stream_error":
		case "err_http2_stream_cancel":
		case "und_err_socket":
			return "transport_error";
		case "rate_limit":
		case "rate_limit_exceeded":
		case "too_many_requests":
		case "throttlingexception":
		case "resource_exhausted":
			return "rate_limit";
		case "quota_exceeded":
		case "insufficient_quota":
		case "usage_limit":
		case "usage_limit_reached":
		case "usage_limit_exceeded":
		case "payment_required":
		case "servicequotaexceededexception":
			return "quota_exhausted";
		case "aborterror":
		case "aborted":
		case "cancelled":
		case "canceled":
			return "cancelled";
		case "model_not_found":
		case "model_unavailable":
		case "model_disabled":
		case "unknown_model":
		case "model_not_available_for_integrator":
			return "model_unavailable";
		case "provider_error":
		case "api_error":
		case "service_unavailable":
		case "temporarily_unavailable":
		case "overloaded":
		// Amazon Bedrock's transient service exceptions (#4918).
		case "serviceunavailableexception":
		case "internalserverexception":
		case "modelnotreadyexception":
		// Google's provider status for an overloaded or unavailable service (#4994).
		case "unavailable":
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

type MessageMatcher = RegExp | readonly RegExp[];

interface StageCursor {
	start: number;
	end: number;
	lineStart: number;
	nlScan: number;
	done: boolean;
}

function advanceStageCursor(text: string, regex: RegExp, cursor: StageCursor, minStart: number): boolean {
	if (cursor.done) return false;
	if (cursor.start >= minStart) return true;
	regex.lastIndex = minStart;
	const match = regex.exec(text);
	if (!match) {
		cursor.done = true;
		return false;
	}
	const start = match.index;
	let ls = cursor.lineStart;
	let scan = cursor.nlScan;
	while (scan < start) {
		const nl = text.indexOf("\n", scan);
		if (nl === -1 || nl >= start) break;
		ls = nl + 1;
		scan = nl + 1;
	}
	cursor.start = start;
	cursor.end = regex.lastIndex;
	cursor.lineStart = ls;
	cursor.nlScan = start;
	return true;
}

/**
 * Linear-time equivalent of `stage[0][^\n]*stage[1](?:[^\n]*stage[2])?`.
 * Each stage regex must carry the `g` flag (no `[^\n]*` inside a stage) and executes monotonically once across `text`.
 */
function matchesOrderedWithoutNewlineBetween(text: string, stages: readonly RegExp[]): boolean {
	const first = stages[0]!;
	const second = stages[1]!;
	const third = stages[2];
	first.lastIndex = 0;
	const c1: StageCursor = { start: -1, end: -1, lineStart: 0, nlScan: 0, done: false };
	const c2: StageCursor = { start: -1, end: -1, lineStart: 0, nlScan: 0, done: false };
	for (;;) {
		const m0 = first.exec(text);
		if (!m0) return false;
		const end0 = first.lastIndex;
		if (!advanceStageCursor(text, second, c1, end0)) return false;
		if (end0 < c1.lineStart) continue;
		if (!third) return true;
		if (!advanceStageCursor(text, third, c2, c1.end)) return false;
		if (c1.end >= c2.lineStart) return true;
	}
}

function matchesAnyMessageMatcher(text: string, matchers: readonly MessageMatcher[]): boolean {
	for (const matcher of matchers) {
		if (Array.isArray(matcher)) {
			if (matchesOrderedWithoutNewlineBetween(text, matcher)) return true;
		} else if ((matcher as RegExp).test(text)) {
			return true;
		}
	}
	return false;
}

/** A provider declined the request's content under its usage policy: the model will refuse it again. */
const CONTENT_FILTER_FAILURE_PATTERNS: readonly MessageMatcher[] = [
	/\bthe\s+model\s+refused\s+to\s+complete\s+the\s+request\b/i,
	[/\bfinish[_\s-]?reason\b/gi, /\bcontent[_\s-]?filter\b/gi],
	/\bcontent[_\s-]?filter(?:ed|ing)?\b/i,
	/\bcyber[_\s-]?policy\b/i,
	// OpenAI's cyber safeguard: "This content was flagged for possible cybersecurity risk."
	[/\bflagged\s+for\s+(?:possible|potential(?:ly)?)\b/gi, /\b(?:risk|harm(?:ful)?|safety|policy|cyber\w*)\b/gi],
	[
		/\b(?:safety|policy)\b/gi,
		/\b(?:refus(?:e|al|ed|es|ing)?|block(?:ed|ing)?|filter(?:ed|ing)?|violat(?:e|ion|ed|ing)?|disallow(?:ed|ing)?|reject(?:ed|ion|ing)?)\b/gi,
	],
	[
		/\b(?:refus(?:e|al|ed|es|ing)?|block(?:ed|ing)?|filter(?:ed|ing)?|violat(?:e|ion|ed|ing)?|disallow(?:ed|ing)?|reject(?:ed|ion|ing)?)\b/gi,
		/\b(?:safety|policy)\b/gi,
	],
	/\bprovider[_\s-]?refus(?:e|al|ed|es|ing)?\b/i,
	[/\bprovider\b/gi, /\brefus(?:e|al|ed|es|ing)?\b/gi, /\b(?:prompt|request|content|policy|safety)\b/gi],
];

const TOOL_REFUSAL_FAILURE_PATTERNS: readonly MessageMatcher[] = [
	/\btool[_\s-]?(?:call|use)?[_\s-]?refus(?:e|al|ed|es|ing)?\b/i,
	[/\btool(?:\s+call|\s+use)?\b/gi, /\brefus(?:e|al|ed|es|ing)?\b/gi],
	[/\brefus(?:e|al|ed|es|ing)?\b/gi, /\btool(?:\s+call|\s+use)?\b/gi],
];

const PROVIDER_REFUSAL_FAILURE_PATTERNS: readonly MessageMatcher[] = [
	...CONTENT_FILTER_FAILURE_PATTERNS,
	...TOOL_REFUSAL_FAILURE_PATTERNS,
];

const TRANSPORT_OUTAGE_FAILURE_PATTERNS: readonly RegExp[] = [
	/^connection\s+error\.?$/i,
	/^fetch\s+failed\.?$/i,
	// Response-body decompression failures reported by Node/Bun zlib, optionally
	// behind the fetch/WebSocket layer's "Library error:" wrapper. GitHub Copilot
	// on the default `transport: "auto"` surfaces this as
	// "Library error: zlib error: incorrect header check" (#2553). These are
	// unanchored because the wrapper text varies by runtime and transport. `zlib`
	// has no trailing word boundary on purpose: Bun 1.4.0, the shipped runtime
	// when verified, throws `ZlibError fetching "..."` as one word.
	/\bzlib/i,
	/\bincorrect\s+header\s+check\b/i,
	/\bdecompress(?:ion|ing|ed)?\b/i,
	/^library\s+error\b/i,
	// Idle-stream deadline enforced below the HTTP layer by pi-ai's
	// `withStreamDeadline`, so a stalled stream fails over instead of hanging.
	/\bstream\s+deadline\s+exceeded\b/i,
	// A streamed response cut off before its finish reason, as GitHub Copilot's Gemini models do now and then: the
	// same request normally completes when sent again (#4223).
	/\bstream\s+ended\s+without\s+finish[_\s-]?reason\b/i,
	/(?<![a-z0-9_])UND_ERR_SOCKET(?![a-z0-9_])/i,
];

// HTTP 402 and explicit quota exhaustion: the account cannot be served again until its quota resets.
// Codes that also appear as free-text wording for short limits ("quota exceeded", "usage limit reached")
// count only as a JSON `code`/`type` value, as in a raw error body some providers put in the message.
// A service-quota exception and a per-day quota violation in a JSON error body (`"quotaId": "...PerDay..."`)
// also last until the quota resets.
const QUOTA_EXHAUSTED_FAILURE_PATTERN =
	/(?<![a-z0-9.])402(?![a-z0-9.])|payment[_\s-]*required|insufficient[_\s-]*quota|\bServiceQuotaExceededException\b|"quotaId"\s*:\s*"[^"]*PerDay|"(?:code|type|error_code)"\s*:\s*"(?:quota_exceeded|usage_limit|usage_limit_reached|usage_limit_exceeded)"/i;

// An account out of credit or money: nothing serves it again until it is topped up, so a short rate-limit cooldown would
// spend one failed request per cooldown. Anthropic answers with HTTP 400 and `invalid_request_error`, and OpenRouter's
// affordability error names `max_tokens`, so this wording outranks the request-error grammar and the status.
const BILLING_EXHAUSTED_FAILURE_PATTERN =
	/credit\s+balance\s+is\s+too\s+low|insufficient[_\s-]*(?:credits?|balance|funds)|(?:requires|purchase|buy|add)\s+more\s+credits|used\s+all\s+(?:of\s+)?(?:your\s+)?available\s+credits|out\s+of\s+(?:credits?|budget)|spending\s+limit|available\s+balance|check\s+your\s+plan\s+and\s+billing/i;

const API_KEY_REJECTED_FAILURE_PATTERN =
	/\b(?:invalid|incorrect|expired|disabled|leaked)[_\s-]*api[_\s-]*key\b|\bapi[_\s-]+key[_\s-]+(?:(?:is|was|has|been)[_\s-]+){0,3}(?:not[_\s-]+valid|invalid|incorrect|expired|disabled|leaked|rejected|reported[_\s-]+as[_\s-]+leaked)\b/i;

const TOKEN_REJECTED_FAILURE_PATTERN =
	/\b(?:expired|revoked|invalidated)[_\s-]+(?:(?:oauth|auth|access|refresh)[_\s-]+)?token\b|\b(?:(?:oauth|auth|access|refresh)[_\s-]+)?token[_\s-]+(?:(?:is|was|has|been)[_\s-]+){0,3}(?:expired|revoked|invalidated)\b|\bsecurity\s+token\s+(?:included\s+in\s+the\s+request\s+)?(?:is|has)\s+(?:expired|invalid)\b/i;

function transportOutageKindFromMessage(message: string): ModelFallbackFailureKind | undefined {
	return TRANSPORT_OUTAGE_FAILURE_PATTERNS.some((pattern) => pattern.test(message.trim()))
		? "transport_error"
		: undefined;
}

function refusalKindFromMessage(message: string): ModelFallbackFailureKind | undefined {
	if (TRANSPORT_CANCELLATION_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "network_timeout";
	if (CANCELLED_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "cancelled";
	if (NON_RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "task_failure";
	// A refused tool call is about that call, whatever policy the provider names: another model is asked the same
	// tool call. So it is checked before the content-filter grammar, which "refused ... safety policy" also matches.
	if (matchesAnyMessageMatcher(message, TOOL_REFUSAL_FAILURE_PATTERNS)) return "task_failure";
	if (matchesAnyMessageMatcher(message, CONTENT_FILTER_FAILURE_PATTERNS)) return "content_filter";
	return undefined;
}

// A status that leads an adapter's error message: `503: …`, `529 {…}`, or `OpenAI API error (503): …`.
const LEADING_HTTP_STATUS_PATTERN = /^(?:[^\n():]*\((\d{3})\):|(\d{3})(?=[:\s]))/;
// The status in a JSON error body, as Google's `{"error":{"code":503,…,"status":"UNAVAILABLE"}}`.
const JSON_ERROR_CODE_PATTERN = /"code"\s*:\s*(\d{3})(?!\d)/;
const JSON_PROVIDER_STATUS_PATTERN = /"status"\s*:\s*"([A-Z_]+)"/;

/**
 * The transient kind the provider's own error text names, so no text rule condemns the model over it: an HTTP status
 * leading the message or in its JSON error body, a provider status such as `UNAVAILABLE`, or an overloaded service. A
 * permanent HTTP status in the text names no transient kind (#4994).
 */
function transientKindFromMessage(message: string): ModelFallbackFailureKind | undefined {
	const leadingStatus = LEADING_HTTP_STATUS_PATTERN.exec(message);
	const status = integerFrom(leadingStatus?.[1] ?? leadingStatus?.[2] ?? JSON_ERROR_CODE_PATTERN.exec(message)?.[1]);
	const kind =
		status === undefined
			? (kindFromCode(JSON_PROVIDER_STATUS_PATTERN.exec(message)?.[1]) ??
				(/overloaded/i.test(message) ? "provider_unavailable" : undefined))
			: kindFromStatus(status);
	return kind !== undefined && SAME_MODEL_RETRYABLE_FAILURE_KINDS.has(kind) ? kind : undefined;
}

function fallbackKindFromMessage(message: string, name: string | undefined): ModelFallbackFailureKind | undefined {
	const refusalKind = refusalKindFromMessage(message);
	if (refusalKind !== undefined) return refusalKind;
	const transportOutageKind = transportOutageKindFromMessage(message);
	if (transportOutageKind !== undefined) return transportOutageKind;
	if (BILLING_EXHAUSTED_FAILURE_PATTERN.test(message)) return "quota_exhausted";
	if (
		API_KEY_REJECTED_FAILURE_PATTERN.test(message) ||
		TOKEN_REJECTED_FAILURE_PATTERN.test(message) ||
		CREDENTIAL_REJECTION_CODE_PATTERN.test(message)
	)
		return "auth_on_candidate_provider";
	if (REQUEST_INCOMPATIBLE_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "request_incompatible";
	const nameKind = kindFromCode(name);
	if (nameKind !== undefined) return nameKind;
	if (QUOTA_EXHAUSTED_FAILURE_PATTERN.test(message)) return "quota_exhausted";
	const transientKind = transientKindFromMessage(message);
	const hasRetryablePattern =
		transientKind !== undefined ||
		RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(message)) ||
		messageLooksLikeModelUnavailable(message);
	if (!hasRetryablePattern) return undefined;
	if (
		/rate\s*limit|too\s*many\s*requests|\bthrottl(?:ing|ed)\b|\b429\b|quota|usage[\s_-]*limit|billing|credit/i.test(
			message,
		)
	)
		return "rate_limit";
	// Text that would condemn the model does not decide over a transient failure the provider names (#4994).
	if (
		transientKind === undefined &&
		/auth|unauthori[sz]ed|\b40[13]\b|api[_\s-]*key|token[_\s-]*(?:expired|revoked|invalidated|rejected)|forbidden|invalid[_\s-]*key/i.test(
			message,
		)
	)
		return "auth_on_candidate_provider";
	if (transientKind === undefined && messageLooksLikeModelUnavailable(message)) return "model_unavailable";
	if (
		/network|fetch|socket|connection\s*refused|(?<![a-z0-9_])(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_BODY_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_CONNECT_TIMEOUT)(?![a-z0-9_])|getaddrinfo|ENOTFOUND|EAI_AGAIN|timeout|timed\s+out/i.test(
			message,
		)
	)
		return "network_timeout";
	return transientKind ?? "provider_unavailable";
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
	if (normalizeCode(codeFrom(value)) === "econnaborted") return undefined;
	const message = directMessageFrom(value);
	if (message === undefined) return undefined;
	const kind = fallbackKindFromMessage(message, errorName(value));
	return kind === undefined ? undefined : makeSignal(kind, value, source);
}

function fallbackSignalFromMessage(
	value: unknown,
	source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal | undefined {
	const message = classifiableMessage(value);
	if (message === undefined) return undefined;
	const kind = fallbackKindFromMessage(message, errorName(value));
	return kind === undefined ? undefined : makeSignal(kind, value, source);
}

/** Kinds that condemn the model for the turn: message text alone must not assign one over a transient status. */
const MODEL_BLOCKING_FAILURE_KINDS: ReadonlySet<ModelFallbackFailureKind> = new Set([
	"auth_on_candidate_provider",
	"model_unavailable",
	"request_incompatible",
]);

/**
 * The direct message's signal, unless the failure's own HTTP status or provider code names a transient failure and
 * the text would condemn the model instead. Structured fields decide first; text is the fallback (#4918).
 */
function directMessageSignalUnlessTransient(
	value: unknown,
	source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal | undefined {
	const signal = fallbackSignalFromDirectMessage(value, source);
	if (signal === undefined || !MODEL_BLOCKING_FAILURE_KINDS.has(signal.kind)) return signal;
	// An adapter's `provider_response_failure` diagnostic carries the HTTP status of the failed request (#4994).
	const rawDiagnostics = field(value, "diagnostics");
	const structuredKinds = [value, ...(Array.isArray(rawDiagnostics) ? rawDiagnostics : [])].flatMap((source) => [
		kindFromStatus(statusFrom(source)),
		kindFromCode(codeFrom(source)),
	]);
	return structuredKinds.some((kind) => kind !== undefined && SAME_MODEL_RETRYABLE_FAILURE_KINDS.has(kind))
		? undefined
		: signal;
}

function classifyAssistantRefusalSignal(
	value: unknown,
	source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal | undefined {
	if (normalizeCode(codeFrom(value)) === "econnaborted") return undefined;
	const codeRefusalKind =
		refusalKindFromCode(codeFrom(value)) ??
		refusalKindFromCode(errorName(value)) ??
		refusalKindFromCode(finishReasonFrom(value));
	if (codeRefusalKind !== undefined) return makeSignal(codeRefusalKind, value, source);

	const messageRefusalKind = refusalKindFromMessage(directMessageFrom(value) ?? "");
	return messageRefusalKind === undefined ? undefined : makeSignal(messageRefusalKind, value, source);
}

function isRefusalSignal(signal: ModelFallbackFailureSignal): boolean {
	return signal.kind === "cancelled" || signal.kind === "task_failure" || signal.kind === "content_filter";
}

function nestedSignalPriority(signal: ModelFallbackFailureSignal): number {
	switch (signal.kind) {
		case "cancelled":
		case "task_failure":
		case "content_filter":
			return 100;
		case "auth_on_candidate_provider":
		case "certificate_refused":
			return 90;
		case "request_incompatible":
			return 85;
		case "model_unavailable":
			return 80;
		case "quota_exhausted":
			return 75;
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

	// This code names the exact cause, so the generic 400 status and its request-error text must not outrank it.
	if (
		directRefusalSignal === undefined &&
		directCancellationSignal === undefined &&
		normalizeCode(codeFrom(value)) === "model_not_available_for_integrator"
	)
		return makeSignal("model_unavailable", value, source);

	const directMessageSignal = directMessageSignalUnlessTransient(value, source);
	// An exhausted quota the failure names outranks a generic request error: Anthropic answers an account out of
	// credit with HTTP 400 and `invalid_request_error`.
	const quotaExhausted =
		directMessageSignal?.kind === "quota_exhausted" || bestNestedFallbackSignal?.kind === "quota_exhausted";
	const directSignals = [
		directRefusalSignal,
		directCancellationSignal,
		providerTransportSignal,
		directMessageSignal,
		// A provider error code names the cause more exactly than its HTTP status: Bedrock answers a service-quota
		// exception with a generic 400.
		kindFromStatus(statusFrom(value)) === undefined || kindFromCode(codeFrom(value)) !== undefined || quotaExhausted
			? undefined
			: makeSignal(kindFromStatus(statusFrom(value))!, value, source),
		kindFromCode(codeFrom(value)) === undefined ||
		(quotaExhausted && kindFromCode(codeFrom(value)) === "request_incompatible")
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

/**
 * A message to describe the failure. With `describeStatusAndCode`, a failure with only a status or code gets a
 * generated sentence naming it; text classification never reads that sentence, because its words are ours, not the
 * provider's: "Model request failed with code ServiceUnavailableException" reads as an unavailable model (#4918).
 */
function messageFromUnknown(value: unknown, seen: Set<unknown>, describeStatusAndCode = true): string | undefined {
	if (value === undefined || value === null || seen.has(value)) return undefined;
	if (typeof value === "string") return value.trim().length > 0 ? value : undefined;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (typeof value === "symbol" || typeof value === "function") return undefined;
	seen.add(value);

	if (value instanceof Error && value.message.trim().length > 0) return value.message;
	const directMessage = directMessageFrom(value);
	if (directMessage !== undefined) return directMessage;
	for (const diagnosticError of diagnosticErrors(value)) {
		const diagnosticMessage = messageFromUnknown(diagnosticError, seen, describeStatusAndCode);
		if (diagnosticMessage !== undefined) return diagnosticMessage;
	}
	const causeMessage = messageFromUnknown(causeOf(value), seen, describeStatusAndCode);
	if (causeMessage !== undefined) return causeMessage;
	const finishReason = finishReasonFrom(value);
	if (finishReason !== undefined) return `Model request finished with finish_reason:${finishReason}`;
	const stopReason = stopReasonFrom(value);
	if (stopReason !== undefined) return `Assistant message ended with stopReason:${stopReason}`;
	if (!describeStatusAndCode) return undefined;
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

/** The failure's own text, for text classification: never a sentence generated from its status or code. */
function classifiableMessage(error: unknown): string | undefined {
	return messageFromUnknown(error, new Set(), false);
}

/** Alias used by the subagent package's older public helper name. */
export const modelFailureMessage = errorMessage;

/** The fallback decision each typed GitHub Copilot failure stands for. */
const GITHUB_COPILOT_FAILURE_KINDS: Readonly<Record<GitHubCopilotErrorCode, ModelFallbackFailureKind>> = {
	"model-unavailable": "model_unavailable",
	"rate-limited": "rate_limit",
	"quota-exhausted": "quota_exhausted",
	"content-filtered": "content_filter",
	"prompt-too-large": "request_incompatible",
	"invalid-request": "request_incompatible",
	"authentication-failed": "auth_on_candidate_provider",
	"service-unavailable": "provider_unavailable",
	"stream-ended-early": "transport_error",
	"empty-response": "transport_error",
	"unrecognized-response": "provider_unavailable",
};

/**
 * A GitHub Copilot failure is typed at the provider: its code decides, never its text. The typed error is found on
 * the failure, anywhere in its cause chain, or in the diagnostics of a failed assistant message in that chain, as
 * when a caller wraps the message.
 */
function githubCopilotSignal(error: unknown): ModelFallbackFailureSignal | undefined {
	const copilotError: GitHubCopilotError | undefined = findGitHubCopilotError(error);
	if (copilotError === undefined) return undefined;
	return makeSignal(GITHUB_COPILOT_FAILURE_KINDS[copilotError.code], copilotError, signalSource(error, undefined));
}

/**
 * A request the runtime refused for its endpoint's TLS certificate (#6114): recorded by the adapter on a failed assistant
 * message, or along a thrown failure's causes. The same request is refused again, so it is never retried on the same
 * model; like a rejected credential, it may spend a fallback candidate, whose endpoint may be trusted.
 */
function certificateRefusalSignal(error: unknown): ModelFallbackFailureSignal | undefined {
	const refusal = getTlsCertificateRefusal(asRecord(error)) ?? findTlsCertificateRefusal(error);
	if (refusal === undefined) return undefined;
	return { ...makeSignal("certificate_refused", error, undefined), code: refusal.code };
}

/**
 * How long the attempt ran, in milliseconds, before its response stream ended early. It is read from the typed GitHub
 * Copilot failure, never from message text: on the error, anywhere in its cause chain, or in the diagnostics of a
 * failed assistant message. Undefined for any other failure, and for a stream-cut error that carries no duration.
 */
export function streamCutDurationMs(error: unknown): number | undefined {
	const copilotError = findGitHubCopilotError(error);
	return copilotError instanceof GitHubCopilotStreamEndedEarlyError ? copilotError.durationMs : undefined;
}

export function normalizeModelFailureSignal(error: unknown): ModelFallbackFailureSignal {
	// Extension startup is not a model request. Its message names extension paths
	// and their own errors, which must not read as a provider failure.
	if (isExtensionStartupFailure(error)) {
		const name = errorName(error);
		return {
			kind: "unknown",
			message: errorMessage(error),
			source: "string_fallback",
			...(name !== undefined ? { name } : {}),
		};
	}
	const copilot = githubCopilotSignal(error);
	if (copilot !== undefined) return copilot;
	const certificate = certificateRefusalSignal(error);
	if (certificate !== undefined) return certificate;
	const structured = structuredSignal(error, new Set());
	if (structured !== undefined) return structured;
	const message = errorMessage(error);
	const name = errorName(error);
	const textToClassify = classifiableMessage(error);
	const fallbackKind = textToClassify === undefined ? undefined : fallbackKindFromMessage(textToClassify, name);
	return {
		kind: fallbackKind ?? "unknown",
		message,
		source: "string_fallback",
		...(name !== undefined ? { name } : {}),
	};
}

const AUTHENTICATION_FAILURE_CODES: ReadonlySet<string> = new Set([
	"auth_required",
	"authentication_required",
	"authentication_failed",
	"authentication_error",
	"unauthorized",
]);

const CREDENTIAL_REJECTION_CODES: ReadonlySet<string> = new Set([
	"invalid_api_key",
	"api_key_invalid",
	"api_key_expired",
	"api_key_disabled",
	"api_key_leaked",
	"missing_api_key",
	"invalid_key",
	"token_expired",
	"token_revoked",
	"token_invalidated",
	"oauth_token_invalidated",
	"expired_token_exception",
	"expiredtokenexception",
	"unrecognized_client_exception",
	"unrecognizedclientexception",
	"invalid_signature_exception",
	"invalidsignatureexception",
	"consumer_suspended",
	"api_key_service_blocked",
	"api_key_http_referrer_blocked",
	"api_key_ip_address_blocked",
	"api_key_android_app_blocked",
	"api_key_ios_app_blocked",
]);

const CREDENTIAL_REJECTION_CODE_PATTERN = new RegExp(`\\b(?:${[...CREDENTIAL_REJECTION_CODES].join("|")})\\b`, "i");

export function isProviderCredentialRejection(error: unknown): boolean {
	const signal = normalizeModelFailureSignal(error);
	if (isRefusalSignal(signal)) return false;
	const leadingStatus = LEADING_HTTP_STATUS_PATTERN.exec(signal.message);
	const status =
		signal.status ??
		integerFrom(
			leadingStatus?.[1] ??
				leadingStatus?.[2] ??
				/^HTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/i.exec(signal.message)?.[1] ??
				JSON_ERROR_CODE_PATTERN.exec(signal.message)?.[1],
		);
	if (status === 401 || integerFrom(signal.code) === 401) return true;
	if (signal.kind !== "auth_on_candidate_provider") return false;
	const typedFailure = findGitHubCopilotError(error);
	const providerCode = typedFailure?.providerCode ?? stringField(error, "providerCode");
	const codes = providerCode === undefined ? [signal.code, signal.name] : [providerCode];
	if (
		codes.some((value) => {
			const code = normalizeCode(value);
			return (
				code !== undefined &&
				(CREDENTIAL_REJECTION_CODES.has(code) || (status !== 403 && AUTHENTICATION_FAILURE_CODES.has(code)))
			);
		})
	)
		return true;
	const message = `${signal.message}\n${typedFailure?.detail ?? stringField(error, "detail") ?? ""}`;
	return (
		API_KEY_REJECTED_FAILURE_PATTERN.test(message) ||
		TOKEN_REJECTED_FAILURE_PATTERN.test(message) ||
		CREDENTIAL_REJECTION_CODE_PATTERN.test(message)
	);
}

/** Whether a failure is a provider safety/refusal response: a content-filter refusal, or a refused tool call. */
export function isSafetyRefusalFailure(error: unknown): boolean {
	const signal = normalizeModelFailureSignal(error);
	if (signal.kind === "content_filter") return true;
	if (signal.kind !== "task_failure") return false;
	const text = `${signal.message}\n${signal.code ?? ""}\n${signal.name ?? ""}`;
	return matchesAnyMessageMatcher(text, PROVIDER_REFUSAL_FAILURE_PATTERNS);
}

/** Whether a provider's content filter refused the request, as OpenAI's HTTP 422 `cyber_policy` does. */
export function isContentFilterRefusal(error: unknown): boolean {
	return normalizeModelFailureSignal(error).kind === "content_filter";
}

/**
 * True when this failure may spend a configured model fallback candidate. A content-filter refusal does unless
 * `options.fallbackOnContentFilter` is false.
 */
export function isRetryableModelFailure(error: unknown, options?: ModelFallbackFailureOptions): boolean {
	if (error === undefined) return false;
	const kind = normalizeModelFailureSignal(error).kind;
	if (kind === "content_filter") return options?.fallbackOnContentFilter !== false;
	return FALLBACKABLE_FAILURE_KINDS.has(kind);
}

const SAME_MODEL_RETRYABLE_FAILURE_KINDS: ReadonlySet<ModelFallbackFailureKind> = new Set([
	"rate_limit",
	"provider_unavailable",
	"network_timeout",
	"transport_error",
]);

/**
 * An assistant error that only its `stopReason` marks as a model failure: no status, code or name, and text that no
 * pattern recognizes. It may spend a fallback candidate, but it is not retried on the same model on its own.
 */
function isUnrecognizedSignal(signal: ModelFallbackFailureSignal): boolean {
	return (
		signal.kind === "provider_unavailable" &&
		signal.source === "assistant_message" &&
		signal.status === undefined &&
		signal.code === undefined &&
		signal.name === undefined &&
		transientKindFromMessage(signal.message) === undefined &&
		!RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(signal.message))
	);
}

/** True when the same model may be requested again before fallback advances. */
export function isRetryableSameModelFailure(error: unknown): boolean {
	if (!isRetryableModelFailure(error)) return false;
	const signal = normalizeModelFailureSignal(error);
	return SAME_MODEL_RETRYABLE_FAILURE_KINDS.has(signal.kind) && !isUnrecognizedSignal(signal);
}

/**
 * True for a failure that may spend a fallback candidate although nothing recognizes it: an assistant error with no
 * status, code or name whose text matches no known pattern. A session with a fallback chain retries it on the same
 * model first, so such an error never switches models on its first occurrence (#4223).
 */
export function isUnrecognizedModelFailure(error: unknown): boolean {
	return isRetryableModelFailure(error) && isUnrecognizedSignal(normalizeModelFailureSignal(error));
}
