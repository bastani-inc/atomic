import { THINKING_LEVELS, splitKnownThinkingSuffix, type ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

function applyFallbackThinkingLevel(model: string, thinkingLevel: string | undefined): string {
	if (!thinkingLevel || !THINKING_LEVELS.some((level) => level === thinkingLevel)) return model;
	const { thinkingSuffix } = splitKnownThinkingSuffix(model);
	return thinkingSuffix ? model : `${model}:${thinkingLevel}`;
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	if (matches.length !== 1) return model;
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	currentModel?: string,
	fallbackThinkingLevels?: string[],
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const fallbackEntries = (fallbackModels ?? []).map((model, index) => applyFallbackThinkingLevel(model, fallbackThinkingLevels?.[index]));
	for (const raw of [primaryModel, ...fallbackEntries, currentModel]) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

export function currentModelFullId(model: { provider: string; id: string } | undefined): string | undefined {
	if (!model) return undefined;
	return `${String(model.provider)}/${model.id}`;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS: readonly RegExp[] = [
	/rate\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/\b40[13]\b/,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b50[0-4]\b/,
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

const CANCELLED_FAILURE_PATTERNS: readonly RegExp[] = [
	/cancel/i,
	/abort/i,
	/interrupted/i,
];

export type ModelFallbackFailureKind =
	| "auth_on_candidate_provider"
	| "rate_limit"
	| "provider_unavailable"
	| "network_timeout"
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
	"model_unavailable",
	"request_incompatible",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
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
	return stringField(value, "errorMessage")
		?? stringField(value, "message")
		?? stringField(value, "statusText");
}

function integerFrom(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const parsed = Number(value.trim());
	return Number.isInteger(parsed) ? parsed : undefined;
}

function statusFrom(value: unknown): number | undefined {
	return integerFrom(field(value, "status"))
		?? integerFrom(field(value, "statusCode"))
		?? integerFrom(field(value, "httpStatus"));
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
		const diagnosticError = field(diagnostic, "error");
		errors.push(diagnosticError ?? diagnostic);
	}
	return errors;
}

function normalizeCode(value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = String(value)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return normalized.length > 0 ? normalized : undefined;
}

function kindFromStatus(status: number | undefined): ModelFallbackFailureKind | undefined {
	switch (status) {
		case 400:
		case 413: case 422:
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

const REQUEST_INCOMPATIBLE_CODES: ReadonlySet<string> = new Set([
	"invalid_request", "invalid_request_error", "bad_request", "context_length_exceeded",
	"request_too_large", "too_large", "request_entity_too_large", "max_tokens",
	"max_context_length", "context_window_exceeded",
]);
function requestIncompatibleKindFromCode(code: string | number | undefined): ModelFallbackFailureKind | undefined {
	const normalizedCode = normalizeCode(code);
	return normalizedCode !== undefined && REQUEST_INCOMPATIBLE_CODES.has(normalizedCode) ? "request_incompatible" : undefined;
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

const CODE_KINDS_BY_KIND: ReadonlyArray<readonly [ModelFallbackFailureKind, ReadonlySet<string>]> = [
	["auth_on_candidate_provider", new Set(["auth", "auth_required", "authentication_required", "unauthorized", "forbidden", "invalid_api_key", "missing_api_key", "invalid_key"])],
	["network_timeout", new Set(["etimedout", "econnreset", "econnrefused", "enotfound", "eai_again", "fetch_failed", "network_error", "timeout", "timeout_error", "und_err_connect_timeout"])],
	["rate_limit", new Set(["rate_limit", "rate_limit_exceeded", "too_many_requests", "quota_exceeded"])],
	["cancelled", new Set(["aborterror", "aborted", "cancelled", "canceled"])],
	["model_unavailable", new Set(["model_not_found", "model_unavailable", "model_disabled", "unknown_model"])],
	["provider_unavailable", new Set(["provider_error", "api_error", "service_unavailable", "temporarily_unavailable", "overloaded"])],
];
function kindFromCode(code: string | number | undefined): ModelFallbackFailureKind | undefined {
	const normalizedCode = normalizeCode(code);
	if (normalizedCode === undefined) return undefined;
	const refusalKind = refusalKindFromCode(code);
	if (refusalKind !== undefined) return refusalKind;
	const httpStatusKind = kindFromStatus(integerFrom(code));
	if (httpStatusKind !== undefined) return httpStatusKind;
	const requestIncompatibleKind = requestIncompatibleKindFromCode(code);
	if (requestIncompatibleKind !== undefined) return requestIncompatibleKind;
	return CODE_KINDS_BY_KIND.find(([_, codes]) => codes.has(normalizedCode))?.[0];
}

const REQUEST_INCOMPATIBLE_FAILURE_PATTERNS: readonly RegExp[] = [
	/\bcontext[_\s-]?(?:length|window)(?:[_\s-]?exceeded)?\b/i,
	/\bmax[_\s-]?(?:context|tokens?)\b/i,
	/\b(?:request(?:[_\s-]?entity)?[_\s-]?too|too)[_\s-]?large\b/i,
	/\b(?:unsupported|unknown|invalid)\s+(?:tool|parameter|function)\b/i,
	/\b(?:tool|parameter|function)\s+(?:not\s+(?:supported|found|allowed)|unknown|invalid)\b/i,
	/\b(?:invalid[_\s-]?request(?:[_\s-]?error)?|bad[_\s-]?request)\b/i,
];
const PROVIDER_REFUSAL_FAILURE_PATTERNS: readonly RegExp[] = [
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

function refusalKindFromMessage(message: string): ModelFallbackFailureKind | undefined {
	if (CANCELLED_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "cancelled";
	if (NON_RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "task_failure";
	if (PROVIDER_REFUSAL_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "task_failure";
	return undefined;
}

function fallbackKindFromMessage(message: string, name: string | undefined): ModelFallbackFailureKind | undefined {
	const refusalKind = refusalKindFromMessage(message);
	if (refusalKind !== undefined) return refusalKind;
	if (REQUEST_INCOMPATIBLE_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "request_incompatible";
	const nameKind = kindFromCode(name);
	if (nameKind !== undefined) return nameKind;
	if (!RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return undefined;
	if (/rate\s*limit|too many requests|\b429\b|quota|billing|credit/i.test(message)) return "rate_limit";
	if (/auth|unauthori[sz]ed|\b40[13]\b|api key|token expired|forbidden|invalid key/i.test(message)) return "auth_on_candidate_provider";
	if (/model.*(?:unavailable|disabled|not found|unknown)|(?:unavailable|disabled|not found|unknown).*model/i.test(message)) return "model_unavailable";
	if (/network|fetch failed|socket|connection refused|timeout|timed? out/i.test(message)) return "network_timeout";
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
		message: modelFailureMessage(value),
		source: signalSource(value, source),
		...(stopReason !== undefined ? { stopReason } : {}),
		...(status !== undefined ? { status } : {}),
		...(code !== undefined ? { code } : {}),
		...(name !== undefined ? { name } : {}),
	};
}

function fallbackSignalForMessage(
	message: string | undefined,
	value: unknown,
	source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal | undefined {
	if (message === undefined || message.trim().length === 0) return undefined;
	const kind = fallbackKindFromMessage(message, errorName(value));
	return kind === undefined ? undefined : makeSignal(kind, value, source);
}
function fallbackSignalFromMessage(value: unknown, source: ModelFallbackFailureSource | undefined): ModelFallbackFailureSignal | undefined {
	return fallbackSignalForMessage(modelFailureMessage(value), value, source);
}
function fallbackSignalFromDirectMessage(value: unknown, source: ModelFallbackFailureSource | undefined): ModelFallbackFailureSignal | undefined {
	return fallbackSignalForMessage(directMessageFrom(value), value, source);
}

function classifyAssistantRefusalSignal(
	value: unknown,
	source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal | undefined {
	const codeRefusalKind = refusalKindFromCode(codeFrom(value))
		?? refusalKindFromCode(errorName(value))
		?? refusalKindFromCode(finishReasonFrom(value));
	if (codeRefusalKind !== undefined) return makeSignal(codeRefusalKind, value, source);

	const messageRefusalKind = refusalKindFromMessage(directMessageFrom(value) ?? "");
	return messageRefusalKind === undefined ? undefined : makeSignal(messageRefusalKind, value, source);
}

function isRefusalSignal(signal: ModelFallbackFailureSignal): boolean {
	return signal.kind === "cancelled" || signal.kind === "task_failure";
}

function structuredSignal(
	value: unknown,
	seen: Set<unknown>,
	source?: ModelFallbackFailureSource,
): ModelFallbackFailureSignal | undefined {
	if (value === undefined || value === null || seen.has(value)) return undefined;
	if (typeof value === "object") seen.add(value);

	const stopReason = stopReasonFrom(value)?.toLowerCase();
	if (stopReason === "aborted") return makeSignal("cancelled", value, source);

	const directRefusalSignal = classifyAssistantRefusalSignal(value, source);
	if (directRefusalSignal !== undefined) return directRefusalSignal;

	const codeKind = kindFromCode(codeFrom(value));
	const nameKind = kindFromCode(errorName(value));
	if (codeKind === "cancelled" || nameKind === "cancelled") return makeSignal("cancelled", value, source);

	let firstNestedFallbackSignal: ModelFallbackFailureSignal | undefined;
	const nestedSeen = new Set(seen);
	for (const diagnosticError of diagnosticErrors(value)) {
		const diagnosticSignal = structuredSignal(diagnosticError, nestedSeen, "diagnostic")
			?? fallbackSignalFromMessage(diagnosticError, "diagnostic");
		if (diagnosticSignal === undefined) continue;
		if (isRefusalSignal(diagnosticSignal)) return diagnosticSignal;
		firstNestedFallbackSignal ??= diagnosticSignal;
	}
	const cause = causeOf(value);
	const causeSignal = structuredSignal(cause, nestedSeen, source)
		?? fallbackSignalFromMessage(cause, source);
	if (causeSignal !== undefined) {
		if (isRefusalSignal(causeSignal)) return causeSignal;
		firstNestedFallbackSignal ??= causeSignal;
	}
	// Direct-message classification runs after nested traversal so a generic wrapper
	// ("invalid request"/"400 bad request") cannot mask a non-retryable nested signal.
	// Kept in the same position as the workflows classifier so the two copies stay
	// behaviorally parallel (see test/unit/model-fallback-classifier-conformance.test.ts).
	const directMessageSignal = fallbackSignalFromDirectMessage(value, source);
	if (directMessageSignal !== undefined) return directMessageSignal;
	const statusKind = kindFromStatus(statusFrom(value));
	if (statusKind !== undefined) return makeSignal(statusKind, value, source);
	if (codeKind !== undefined) return makeSignal(codeKind, value, source);
	if (nameKind !== undefined) return makeSignal(nameKind, value, source);
	if (firstNestedFallbackSignal !== undefined) return firstNestedFallbackSignal;
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
	const stopReason = stopReasonFrom(value);
	if (stopReason !== undefined) return `Assistant message ended with stopReason:${stopReason}`;
	const finishReason = finishReasonFrom(value);
	if (finishReason !== undefined) return `Model request finished with finish_reason:${finishReason}`;
	const status = statusFrom(value);
	if (status !== undefined) return `Model request failed with status ${status}`;
	const code = codeFrom(value);
	return code !== undefined ? `Model request failed with code ${String(code)}` : undefined;
}
export function modelFailureMessage(error: unknown): string {
	const structuredMessage = messageFromUnknown(error, new Set());
	if (structuredMessage !== undefined) return structuredMessage;
	const rendered = String(error);
	return rendered === "[object Object]" ? "Model request failed" : rendered;
}
export function normalizeModelFailureSignal(error: unknown): ModelFallbackFailureSignal {
	const structured = structuredSignal(error, new Set());
	if (structured !== undefined) return structured;
	const message = modelFailureMessage(error);
	const name = errorName(error);
	const fallbackKind = message.trim().length > 0
		? fallbackKindFromMessage(message, name)
		: undefined;
	return {
		kind: fallbackKind ?? "unknown",
		message,
		source: "string_fallback",
		...(name !== undefined ? { name } : {}),
	};
}
export function isRetryableModelFailure(error: unknown): boolean {
	if (error === undefined) return false;
	const signal = normalizeModelFailureSignal(error);
	return FALLBACKABLE_FAILURE_KINDS.has(signal.kind);
}
export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
