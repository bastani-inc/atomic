import type { AssistantMessage, JsonObject } from "../types.ts";
import { type AssistantMessageDiagnostic, appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { getProviderRetryAfterMs } from "../utils/retry-hints.ts";

/** Stable codes of every GitHub Copilot request failure. Public API: never renamed or reused. */
export type GitHubCopilotErrorCode =
	| "model-unavailable"
	| "rate-limited"
	| "quota-exhausted"
	| "content-filtered"
	| "prompt-too-large"
	| "invalid-request"
	| "authentication-failed"
	| "service-unavailable"
	| "stream-ended-early"
	| "empty-response"
	| "unrecognized-response";

const MODEL_UNAVAILABLE_REASONS = ["integration", "not-supported", "wrong-api", "no-endpoint", "not-found"] as const;
const INVALID_REQUEST_REASONS = ["reasoning-effort", "integration-id", "rejected"] as const;
const UNRECOGNIZED_REASONS = ["unknown-status", "unknown-error-event", "malformed-body"] as const;

/** Why Copilot refused to serve the model. */
export type GitHubCopilotModelUnavailableReason = (typeof MODEL_UNAVAILABLE_REASONS)[number];

/** Which part of the request Copilot rejected. */
export type GitHubCopilotInvalidRequestReason = (typeof INVALID_REQUEST_REASONS)[number];

/** What Atomic could not interpret. */
export type GitHubCopilotUnrecognizedReason = (typeof UNRECOGNIZED_REASONS)[number];

export type GitHubCopilotErrorName =
	| "GitHubCopilotError"
	| "GitHubCopilotModelUnavailableError"
	| "GitHubCopilotRateLimitError"
	| "GitHubCopilotQuotaExhaustedError"
	| "GitHubCopilotContentFilterError"
	| "GitHubCopilotPromptTooLargeError"
	| "GitHubCopilotInvalidRequestError"
	| "GitHubCopilotAuthenticationError"
	| "GitHubCopilotServiceUnavailableError"
	| "GitHubCopilotStreamEndedEarlyError"
	| "GitHubCopilotEmptyResponseError"
	| "GitHubCopilotUnrecognizedResponseError";

export type GitHubCopilotErrorFieldValue = string | number | null;
export type GitHubCopilotErrorFields = Readonly<Record<string, GitHubCopilotErrorFieldValue>>;

/** The request a failure belongs to, and what the provider reported about it. No prompt text, tokens or bodies. */
export interface GitHubCopilotErrorContext {
	readonly modelId: string;
	readonly api: string;
	/** HTTP status, when the failure was an HTTP response. */
	readonly status?: number;
	/** The provider's own error code, such as `model_not_supported`. */
	readonly providerCode?: string;
	/** The provider's `x-request-id`, for support requests. */
	readonly requestId?: string;
	/** The provider's short error text, truncated. */
	readonly detail?: string;
}

/** A cause in wire form, bounded in depth. */
export interface SerializedGitHubCopilotErrorCause {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly cause?: SerializedGitHubCopilotErrorCause;
}

/** Wire form of a GitHub Copilot error, as an assistant message's diagnostics carry it across processes. */
export interface SerializedGitHubCopilotError {
	readonly name: string;
	readonly code: GitHubCopilotErrorCode;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: GitHubCopilotErrorFields;
	readonly cause?: SerializedGitHubCopilotErrorCause;
}

/** `AssistantMessageDiagnostic.type` of the diagnostic that carries a serialized GitHub Copilot error. */
export const GITHUB_COPILOT_ERROR_DIAGNOSTIC = "github_copilot_error";

const MAX_CAUSE_DEPTH = 8;
const MAX_DETAIL_CHARS = 300;

/** Every code, as a set that relayed values of any type can be checked against. */
const GITHUB_COPILOT_ERROR_CODES: ReadonlySet<unknown> = new Set<GitHubCopilotErrorCode>([
	"model-unavailable",
	"rate-limited",
	"quota-exhausted",
	"content-filtered",
	"prompt-too-large",
	"invalid-request",
	"authentication-failed",
	"service-unavailable",
	"stream-ended-early",
	"empty-response",
	"unrecognized-response",
]);

const RETRYABLE_CODES: ReadonlySet<GitHubCopilotErrorCode> = new Set<GitHubCopilotErrorCode>([
	"rate-limited",
	"service-unavailable",
	"stream-ended-early",
	"empty-response",
	"unrecognized-response",
]);

const WHAT_FAILED: Readonly<Record<GitHubCopilotErrorCode, string>> = {
	"model-unavailable": "GitHub Copilot model unavailable",
	"rate-limited": "GitHub Copilot rate limit reached",
	"quota-exhausted": "GitHub Copilot quota exhausted",
	"content-filtered": "GitHub Copilot content filter blocked the request",
	"prompt-too-large": "GitHub Copilot prompt too large",
	"invalid-request": "GitHub Copilot rejected the request",
	"authentication-failed": "GitHub Copilot authentication failed",
	"service-unavailable": "GitHub Copilot service unavailable",
	"stream-ended-early": "GitHub Copilot response stream ended early",
	"empty-response": "GitHub Copilot returned an empty response",
	"unrecognized-response": "GitHub Copilot returned an unrecognized response",
};

const HINTS: Readonly<Record<GitHubCopilotErrorCode, string>> = {
	"model-unavailable": "Pick another model, or run /login to refresh the models this account can use.",
	"rate-limited": "Wait for the rate limit to reset; Atomic retries the request when retries are enabled.",
	"quota-exhausted": "Pick another model, or wait until the Copilot plan's quota resets.",
	"content-filtered":
		"Rephrase the request or pick another model; retry.fallbackOnContentFilter decides whether a fallback model is tried.",
	"prompt-too-large": "Run /compact or start a new session to shrink the conversation.",
	"invalid-request": "Check the model's thinking level and any models.json overrides for this model.",
	"authentication-failed": "Run /login to sign in to GitHub Copilot again, or check COPILOT_GITHUB_TOKEN.",
	"service-unavailable": "Retry later; Atomic retries the request when retries are enabled.",
	"stream-ended-early": "Retry the request; Atomic retries it when retries are enabled.",
	"empty-response": "Retry the request; Atomic retries it when retries are enabled.",
	"unrecognized-response": "Retry the request, and report it if it keeps happening.",
};

/** Hints for the reasons that need more than their code's hint. */
const MODEL_UNAVAILABLE_HINTS: Readonly<Partial<Record<GitHubCopilotModelUnavailableReason, string>>> = {
	integration:
		"Copilot does not offer this model to Atomic's integration. Pick another model, or run /login to refresh the model list.",
	"wrong-api": "Run /login to refresh the model list so Atomic calls the API Copilot serves this model on.",
	"no-endpoint": "Copilot has no endpoint for this model under this account's settings. Pick another model.",
};

const INVALID_REQUEST_HINTS: Readonly<Partial<Record<GitHubCopilotInvalidRequestReason, string>>> = {
	"reasoning-effort": "Pick a thinking level this model lists.",
	"integration-id": "Remove the Copilot-Integration-Id header override from models.json.",
};

function failureMessage(code: GitHubCopilotErrorCode, modelId: string, hint: string): string {
	return `${WHAT_FAILED[code]}: ${modelId} (${code}). ${hint}`;
}

interface GitHubCopilotErrorOptions {
	readonly hint?: string;
	readonly cause?: unknown;
}

/** Base of every GitHub Copilot request failure. Catch this to handle the whole family. */
export class GitHubCopilotError extends Error {
	override readonly name: string = "GitHubCopilotError";
	readonly code: GitHubCopilotErrorCode;
	readonly retryable: boolean;
	readonly hint: string;
	readonly modelId: string;
	readonly api: string;
	readonly status: number | undefined;
	readonly providerCode: string | undefined;
	readonly requestId: string | undefined;
	readonly detail: string | undefined;

	constructor(code: GitHubCopilotErrorCode, context: GitHubCopilotErrorContext, options?: GitHubCopilotErrorOptions) {
		const hint = options?.hint ?? HINTS[code];
		super(
			failureMessage(code, context.modelId, hint),
			options?.cause === undefined ? undefined : { cause: options.cause },
		);
		this.code = code;
		this.retryable = RETRYABLE_CODES.has(code);
		this.hint = hint;
		this.modelId = context.modelId;
		this.api = context.api;
		this.status = context.status;
		this.providerCode = context.providerCode;
		this.requestId = context.requestId;
		this.detail = context.detail;
	}

	/** JSON-safe context fields; subclasses add their own. */
	fields(): GitHubCopilotErrorFields {
		return {
			modelId: this.modelId,
			api: this.api,
			status: this.status ?? null,
			providerCode: this.providerCode ?? null,
			requestId: this.requestId ?? null,
			detail: this.detail ?? null,
		};
	}
}

/** Copilot will not serve this model to this account, integration or API. Not retryable; a fallback model may work. */
export class GitHubCopilotModelUnavailableError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotModelUnavailableError" as const;
	declare readonly code: "model-unavailable";
	readonly reason: GitHubCopilotModelUnavailableReason;

	constructor(
		reason: GitHubCopilotModelUnavailableReason,
		context: GitHubCopilotErrorContext,
		options?: { readonly cause?: unknown },
	) {
		super("model-unavailable", context, { hint: MODEL_UNAVAILABLE_HINTS[reason], cause: options?.cause });
		this.reason = reason;
	}

	override fields(): GitHubCopilotErrorFields {
		return { ...super.fields(), reason: this.reason };
	}
}

/** Copilot throttled the request. Retryable after `retryAfterMs` when the server sent a delay. */
export class GitHubCopilotRateLimitError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotRateLimitError" as const;
	declare readonly code: "rate-limited";
	readonly retryAfterMs: number | undefined;

	constructor(context: GitHubCopilotErrorContext, retryAfterMs?: number, options?: { readonly cause?: unknown }) {
		super("rate-limited", context, options);
		this.retryAfterMs = retryAfterMs;
	}

	override fields(): GitHubCopilotErrorFields {
		return { ...super.fields(), retryAfterMs: this.retryAfterMs ?? null };
	}
}

/** The plan's quota or billing allowance for the model is used up. Not retryable until it resets. */
export class GitHubCopilotQuotaExhaustedError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotQuotaExhaustedError" as const;
	declare readonly code: "quota-exhausted";

	constructor(context: GitHubCopilotErrorContext, options?: { readonly cause?: unknown }) {
		super("quota-exhausted", context, options);
	}
}

/** A content or safety filter blocked the request or the response. The same request is refused again. */
export class GitHubCopilotContentFilterError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotContentFilterError" as const;
	declare readonly code: "content-filtered";

	constructor(context: GitHubCopilotErrorContext, options?: { readonly cause?: unknown }) {
		super("content-filtered", context, options);
	}
}

/** The prompt exceeds the model's prompt-token limit. Compact the conversation instead of retrying. */
export class GitHubCopilotPromptTooLargeError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotPromptTooLargeError" as const;
	declare readonly code: "prompt-too-large";
	readonly promptTokens: number | undefined;
	readonly limitTokens: number | undefined;

	constructor(
		context: GitHubCopilotErrorContext,
		tokens?: { readonly promptTokens?: number; readonly limitTokens?: number },
		options?: { readonly cause?: unknown },
	) {
		super("prompt-too-large", context, options);
		this.promptTokens = tokens?.promptTokens;
		this.limitTokens = tokens?.limitTokens;
	}

	override fields(): GitHubCopilotErrorFields {
		return { ...super.fields(), promptTokens: this.promptTokens ?? null, limitTokens: this.limitTokens ?? null };
	}
}

/** Copilot rejected the request's shape or settings. Sending it again fails the same way. */
export class GitHubCopilotInvalidRequestError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotInvalidRequestError" as const;
	declare readonly code: "invalid-request";
	readonly reason: GitHubCopilotInvalidRequestReason;

	constructor(
		reason: GitHubCopilotInvalidRequestReason,
		context: GitHubCopilotErrorContext,
		options?: { readonly cause?: unknown },
	) {
		super("invalid-request", context, { hint: INVALID_REQUEST_HINTS[reason], cause: options?.cause });
		this.reason = reason;
	}

	override fields(): GitHubCopilotErrorFields {
		return { ...super.fields(), reason: this.reason };
	}
}

/** Copilot refused the credential. Sign in again; another provider's model may still work. */
export class GitHubCopilotAuthenticationError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotAuthenticationError" as const;
	declare readonly code: "authentication-failed";

	constructor(context: GitHubCopilotErrorContext, options?: { readonly cause?: unknown }) {
		super("authentication-failed", context, options);
	}
}

/** Copilot or the model behind it is down, overloaded or timed out. Retryable. */
export class GitHubCopilotServiceUnavailableError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotServiceUnavailableError" as const;
	declare readonly code: "service-unavailable";

	constructor(context: GitHubCopilotErrorContext, options?: { readonly cause?: unknown }) {
		super("service-unavailable", context, options);
	}
}

/** The response stream stopped before its finish reason or terminal event. Retryable. */
export class GitHubCopilotStreamEndedEarlyError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotStreamEndedEarlyError" as const;
	declare readonly code: "stream-ended-early";

	constructor(context: GitHubCopilotErrorContext, options?: { readonly cause?: unknown }) {
		super("stream-ended-early", context, options);
	}
}

/** The model finished with no text and no tool call, as Copilot's Gemini models sometimes do. Retryable. */
export class GitHubCopilotEmptyResponseError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotEmptyResponseError" as const;
	declare readonly code: "empty-response";

	constructor(context: GitHubCopilotErrorContext, options?: { readonly cause?: unknown }) {
		super("empty-response", context, options);
	}
}

/** Copilot answered with a status, error event or body Atomic does not recognize. Retryable a bounded number of times. */
export class GitHubCopilotUnrecognizedResponseError extends GitHubCopilotError {
	override readonly name = "GitHubCopilotUnrecognizedResponseError" as const;
	declare readonly code: "unrecognized-response";
	readonly reason: GitHubCopilotUnrecognizedReason;

	constructor(
		reason: GitHubCopilotUnrecognizedReason,
		context: GitHubCopilotErrorContext,
		options?: { readonly cause?: unknown },
	) {
		super("unrecognized-response", context, options);
		this.reason = reason;
	}

	override fields(): GitHubCopilotErrorFields {
		return { ...super.fields(), reason: this.reason };
	}
}

const CODE_BY_NAME: Readonly<Record<Exclude<GitHubCopilotErrorName, "GitHubCopilotError">, GitHubCopilotErrorCode>> = {
	GitHubCopilotModelUnavailableError: "model-unavailable",
	GitHubCopilotRateLimitError: "rate-limited",
	GitHubCopilotQuotaExhaustedError: "quota-exhausted",
	GitHubCopilotContentFilterError: "content-filtered",
	GitHubCopilotPromptTooLargeError: "prompt-too-large",
	GitHubCopilotInvalidRequestError: "invalid-request",
	GitHubCopilotAuthenticationError: "authentication-failed",
	GitHubCopilotServiceUnavailableError: "service-unavailable",
	GitHubCopilotStreamEndedEarlyError: "stream-ended-early",
	GitHubCopilotEmptyResponseError: "empty-response",
	GitHubCopilotUnrecognizedResponseError: "unrecognized-response",
};

interface StructuralError {
	readonly name?: unknown;
	readonly code?: unknown;
	readonly cause?: unknown;
	readonly diagnostics?: unknown;
}

function structural(value: unknown): StructuralError | undefined {
	return typeof value === "object" && value !== null ? (value as StructuralError) : undefined;
}

/** A family member seen from another process or realm: its name and code, maybe its message. */
interface StructuralFamilyMember {
	readonly name: string;
	readonly code: GitHubCopilotErrorCode;
	readonly message?: unknown;
}

/** A family member relayed from another process or realm: an object with a family name and that name's code. */
function isRelayedFamilyMember(value: unknown): value is StructuralFamilyMember {
	const candidate = structural(value);
	if (typeof candidate?.name !== "string") return false;
	if (candidate.name === "GitHubCopilotError") return GITHUB_COPILOT_ERROR_CODES.has(candidate.code);
	return CODE_BY_NAME[candidate.name as keyof typeof CODE_BY_NAME] === candidate.code;
}

/** Rebuild a relayed family member as its class; one that carries only its name and code gets that code's hint. */
function rebuildRelayedFamilyMember(found: StructuralFamilyMember): GitHubCopilotError | undefined {
	const deserialized = deserializeGitHubCopilotError(found);
	if (deserialized) return deserialized;
	if ("fields" in found || "hint" in found || "retryable" in found || "cause" in found) return undefined;
	if (Reflect.ownKeys(found).some((key) => key !== "name" && key !== "code" && key !== "message")) return undefined;
	if ("message" in found && typeof found.message !== "string") return undefined;
	return deserializeGitHubCopilotError({
		name: found.name,
		code: found.code,
		message: found.message ?? "",
		hint: HINTS[found.code],
		retryable: RETRYABLE_CODES.has(found.code),
		fields: {},
	});
}

/**
 * The typed error at one link of a cause chain: the link itself, rebuilt when it was relayed from another process, or
 * the error its `diagnostics` carry when the link is a failed assistant message, as a workflow failure's cause is.
 */
function typedErrorAt(link: unknown): GitHubCopilotError | undefined {
	if (link instanceof GitHubCopilotError) return link;
	if (isRelayedFamilyMember(link)) return rebuildRelayedFamilyMember(link);
	return getGitHubCopilotError(structural(link));
}

/** The first typed error `matches` accepts, walking at most MAX_CAUSE_DEPTH links of the cause chain. */
function findInCauseChain(
	error: unknown,
	matches: (typed: GitHubCopilotError) => boolean,
): GitHubCopilotError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		const typed = typedErrorAt(current);
		if (typed !== undefined && matches(typed)) return typed;
		current = structural(current)?.cause;
	}
	return undefined;
}

/**
 * A guard that answers whether the error, anything in its cause chain, or a failed assistant message in that chain holds
 * an error of this class. It returns a plain boolean, not a type predicate: the value passed in is usually the wrapper
 * or the message, not the error. Use `findGitHubCopilotError()` for the instance.
 */
function guard(ctor: abstract new (...args: never[]) => GitHubCopilotError): (error: unknown) => boolean {
	return (error) => findInCauseChain(error, (typed) => typed instanceof ctor) !== undefined;
}

/**
 * True when the error, anything in its cause chain, or a failed assistant message in that chain holds a GitHub Copilot
 * error. A plain boolean, not a type predicate: use `findGitHubCopilotError()` for the instance.
 */
export function isGitHubCopilotError(error: unknown): boolean {
	return findGitHubCopilotError(error) !== undefined;
}

/**
 * First GitHub Copilot error in the cause chain, as an instance of its class: a link that is one, rebuilt when it was
 * relayed from another process, or the error a failed assistant message's diagnostics carry. The chain is walked to a
 * bounded depth, through JSON round-tripped links too.
 */
export function findGitHubCopilotError(error: unknown): GitHubCopilotError | undefined {
	return findInCauseChain(error, () => true);
}

/** True when the first GitHub Copilot error in the cause chain says the same request may be sent again. */
export function isRetryableGitHubCopilotError(error: unknown): boolean {
	return findGitHubCopilotError(error)?.retryable === true;
}

export const isGitHubCopilotModelUnavailableError = guard(GitHubCopilotModelUnavailableError);
export const isGitHubCopilotRateLimitError = guard(GitHubCopilotRateLimitError);
export const isGitHubCopilotQuotaExhaustedError = guard(GitHubCopilotQuotaExhaustedError);
export const isGitHubCopilotContentFilterError = guard(GitHubCopilotContentFilterError);
export const isGitHubCopilotPromptTooLargeError = guard(GitHubCopilotPromptTooLargeError);
export const isGitHubCopilotInvalidRequestError = guard(GitHubCopilotInvalidRequestError);
export const isGitHubCopilotAuthenticationError = guard(GitHubCopilotAuthenticationError);
export const isGitHubCopilotServiceUnavailableError = guard(GitHubCopilotServiceUnavailableError);
export const isGitHubCopilotStreamEndedEarlyError = guard(GitHubCopilotStreamEndedEarlyError);
export const isGitHubCopilotEmptyResponseError = guard(GitHubCopilotEmptyResponseError);
export const isGitHubCopilotUnrecognizedResponseError = guard(GitHubCopilotUnrecognizedResponseError);

function serializeCause(cause: unknown, depth: number): SerializedGitHubCopilotErrorCause | undefined {
	if (depth >= MAX_CAUSE_DEPTH || cause === undefined || cause === null) return undefined;
	const candidate = structural(cause);
	const nested = serializeCause(candidate?.cause, depth + 1);
	return {
		name: typeof candidate?.name === "string" ? candidate.name : typeof cause,
		message: truncate(cause instanceof Error ? cause.message : String(cause)),
		...(typeof candidate?.code === "string" ? { code: candidate.code } : {}),
		...(nested === undefined ? {} : { cause: nested }),
	};
}

/** Wire form for crossing a process boundary; the cause chain is kept to a bounded depth. */
export function serializeGitHubCopilotError(error: GitHubCopilotError): SerializedGitHubCopilotError {
	const cause = serializeCause(error.cause, 0);
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields(),
		...(cause === undefined ? {} : { cause }),
	};
}

function rehydrateCause(cause: SerializedGitHubCopilotErrorCause | undefined): Error | undefined {
	if (cause === undefined) return undefined;
	const family = isRelayedFamilyMember(cause)
		? rebuildRelayedFamilyMember({ name: cause.name, code: cause.code, message: cause.message })
		: undefined;
	const error = family ?? new Error(cause.message);
	Object.defineProperties(error, {
		message: { value: cause.message },
		cause: { value: rehydrateCause(cause.cause), writable: true, configurable: true },
	});
	Object.defineProperty(error, "name", { value: cause.name });
	if (cause.code !== undefined) Object.defineProperty(error, "code", { value: cause.code, enumerable: true });
	return error;
}

function stringField(fields: GitHubCopilotErrorFields, key: string): string | undefined {
	const value = fields[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(fields: GitHubCopilotErrorFields, key: string): number | undefined {
	const value = fields[key];
	return typeof value === "number" ? value : undefined;
}

function contextFromFields(fields: GitHubCopilotErrorFields): GitHubCopilotErrorContext {
	return {
		modelId: stringField(fields, "modelId") ?? "",
		api: stringField(fields, "api") ?? "",
		status: numberField(fields, "status"),
		providerCode: stringField(fields, "providerCode"),
		requestId: stringField(fields, "requestId"),
		detail: stringField(fields, "detail"),
	};
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSerializedCause(value: unknown, depth = 0): value is SerializedGitHubCopilotErrorCause {
	if (value === undefined) return true;
	if (depth >= MAX_CAUSE_DEPTH || !isJsonRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		typeof value.message === "string" &&
		(value.code === undefined || typeof value.code === "string") &&
		isSerializedCause(value.cause, depth + 1)
	);
}

function isSerializedError(value: unknown): value is SerializedGitHubCopilotError {
	if (!isJsonRecord(value) || !isJsonRecord(value.fields)) return false;
	return (
		typeof value.name === "string" &&
		GITHUB_COPILOT_ERROR_CODES.has(value.code) &&
		typeof value.message === "string" &&
		typeof value.hint === "string" &&
		typeof value.retryable === "boolean" &&
		Object.values(value.fields).every(
			(field) => field === null || typeof field === "string" || typeof field === "number",
		) &&
		isSerializedCause(value.cause)
	);
}

/** A serialized reason: one of `allowed`, or `fallback` when the field is absent. Undefined when it is anything else. */
function reasonField<T extends string>(
	fields: GitHubCopilotErrorFields,
	allowed: readonly T[],
	fallback: T,
): T | undefined {
	const reason = fields.reason;
	if (reason === undefined || reason === null) return fallback;
	return allowed.find((candidate) => candidate === reason);
}

/** Whether a serialized error's name, if it is a known class, goes with its code. */
function agreesWithClass(serialized: SerializedGitHubCopilotError): boolean {
	return (
		!Object.hasOwn(CODE_BY_NAME, serialized.name) ||
		(CODE_BY_NAME as Record<string, string>)[serialized.name] === serialized.code
	);
}

/**
 * Rebuild a serialized GitHub Copilot error as its own class. An unknown name becomes the family base with the
 * original name, code, message, hint and retryability kept. Returns undefined for anything that is not a serialized
 * GitHub Copilot error: a code this version does not know, a class name that does not go with its code, or a reason
 * that class does not have.
 */
export function deserializeGitHubCopilotError(value: unknown): GitHubCopilotError | undefined {
	if (!isSerializedError(value) || !agreesWithClass(value)) return undefined;
	const cause = rehydrateCause(value.cause);
	const fields = value.fields;
	const context = contextFromFields(fields);
	switch (value.name) {
		case "GitHubCopilotModelUnavailableError": {
			const reason = reasonField(fields, MODEL_UNAVAILABLE_REASONS, "not-supported");
			return reason === undefined ? undefined : new GitHubCopilotModelUnavailableError(reason, context, { cause });
		}
		case "GitHubCopilotRateLimitError":
			return new GitHubCopilotRateLimitError(context, numberField(fields, "retryAfterMs"), { cause });
		case "GitHubCopilotQuotaExhaustedError":
			return new GitHubCopilotQuotaExhaustedError(context, { cause });
		case "GitHubCopilotContentFilterError":
			return new GitHubCopilotContentFilterError(context, { cause });
		case "GitHubCopilotPromptTooLargeError":
			return new GitHubCopilotPromptTooLargeError(
				context,
				{ promptTokens: numberField(fields, "promptTokens"), limitTokens: numberField(fields, "limitTokens") },
				{ cause },
			);
		case "GitHubCopilotInvalidRequestError": {
			const reason = reasonField(fields, INVALID_REQUEST_REASONS, "rejected");
			return reason === undefined ? undefined : new GitHubCopilotInvalidRequestError(reason, context, { cause });
		}
		case "GitHubCopilotAuthenticationError":
			return new GitHubCopilotAuthenticationError(context, { cause });
		case "GitHubCopilotServiceUnavailableError":
			return new GitHubCopilotServiceUnavailableError(context, { cause });
		case "GitHubCopilotStreamEndedEarlyError":
			return new GitHubCopilotStreamEndedEarlyError(context, { cause });
		case "GitHubCopilotEmptyResponseError":
			return new GitHubCopilotEmptyResponseError(context, { cause });
		case "GitHubCopilotUnrecognizedResponseError": {
			const reason = reasonField(fields, UNRECOGNIZED_REASONS, "malformed-body");
			return reason === undefined
				? undefined
				: new GitHubCopilotUnrecognizedResponseError(reason, context, { cause });
		}
		default: {
			const base = new GitHubCopilotError(value.code, context, { hint: value.hint, cause });
			Object.defineProperties(base, {
				name: { value: value.name },
				message: { value: value.message },
				retryable: { value: value.retryable },
			});
			return base;
		}
	}
}

/** Record `error` on a failed assistant message: its diagnostics carry the typed error across processes. */
export function recordGitHubCopilotError(
	output: AssistantMessage,
	error: GitHubCopilotError,
	providerText?: string,
): void {
	output.errorMessage =
		providerText === undefined || providerText === error.message
			? error.message
			: `${error.message}\n\n${providerText}`;
	if (error instanceof GitHubCopilotRateLimitError && error.retryAfterMs !== undefined) {
		output.retryAfterMs = error.retryAfterMs;
	}
	appendAssistantMessageDiagnostic(output, {
		type: GITHUB_COPILOT_ERROR_DIAGNOSTIC,
		timestamp: Date.now(),
		error: { name: error.name, message: error.message, code: error.code },
		details: JSON.parse(JSON.stringify(serializeGitHubCopilotError(error))) as JsonObject,
	});
}

/**
 * The GitHub Copilot error an assistant message's diagnostics carry, rebuilt as its class: the latest valid one.
 * Accepts a message read back from JSON, whose diagnostics are validated here.
 */
export function getGitHubCopilotError(
	message: { readonly diagnostics?: unknown } | undefined,
): GitHubCopilotError | undefined {
	const diagnostics = message?.diagnostics;
	if (!Array.isArray(diagnostics)) return undefined;
	for (const entry of [...diagnostics].reverse()) {
		const diagnostic = structural(entry) as Partial<AssistantMessageDiagnostic> | undefined;
		if (diagnostic?.type !== GITHUB_COPILOT_ERROR_DIAGNOSTIC) continue;
		const error = deserializeGitHubCopilotError(diagnostic.details);
		if (error !== undefined) return error;
	}
	return undefined;
}

function truncate(text: string): string {
	return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS)}…`;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

type ProviderFailure = Error & {
	status?: unknown;
	code?: unknown;
	type?: unknown;
	error?: unknown;
	requestID?: unknown;
	request_id?: unknown;
	headers?: unknown;
};

/**
 * The error that holds the provider's response. When the retry helper gave up on a server-requested delay above its
 * cap, it threw a wrapper that keeps only `status` and `retryAfterMs` and holds the original response error as its
 * `cause`: no code, body or headers of its own. The response is then that cause. Any other error is its own response.
 */
function responseOf(error: ProviderFailure): ProviderFailure {
	const origin = error.cause;
	const wrapsResponse =
		error.code === undefined &&
		error.error === undefined &&
		error.headers === undefined &&
		origin instanceof Error &&
		typeof (origin as ProviderFailure).status === "number";
	return wrapsResponse ? (origin as ProviderFailure) : error;
}

/** The SDK's request ID, else Copilot's `x-request-id` header, which the Anthropic SDK does not read. */
function requestIdOf(error: ProviderFailure): string | undefined {
	const headers = error.headers;
	const header = headers instanceof Headers ? headers.get("x-request-id") : undefined;
	return nonEmptyString(error.requestID) ?? nonEmptyString(error.request_id) ?? nonEmptyString(header);
}

/**
 * The provider's code: the SDK's `code`, then the parsed body's `error.code` or `code`. A Messages `error` event
 * arrives with no HTTP status and names its failure only by `type`, so that type is its code.
 */
function providerCodeOf(error: ProviderFailure): string | undefined {
	const body = structural(error.error) as { code?: unknown; error?: unknown } | undefined;
	return (
		nonEmptyString(error.code) ??
		nonEmptyString((structural(body?.error) as { code?: unknown } | undefined)?.code) ??
		nonEmptyString(body?.code) ??
		(error.status === undefined && error.error !== undefined ? nonEmptyString(error.type) : undefined)
	);
}

/** The provider's error text: the parsed body's message, else the SDK message without its status prefix. */
function providerDetailOf(error: ProviderFailure, status: number | undefined): string | undefined {
	const body = structural(error.error) as { message?: unknown; error?: unknown } | undefined;
	const bodyMessage =
		nonEmptyString((structural(body?.error) as { message?: unknown } | undefined)?.message) ??
		nonEmptyString(body?.message);
	if (bodyMessage !== undefined) return truncate(bodyMessage);
	if (typeof error.error === "string") {
		const text = nonEmptyString(error.error);
		return text === undefined ? undefined : truncate(text);
	}
	const message =
		status !== undefined && error.message.startsWith(`${status} `)
			? error.message.slice(`${status} `.length)
			: error.message;
	const text = nonEmptyString(message);
	return text === undefined ? undefined : truncate(text);
}

/** Provider codes Copilot sends, observed live or documented publicly, and the failure each one means. */
const PROVIDER_CODE_FAILURES: Readonly<
	Record<string, (context: GitHubCopilotErrorContext, error: ProviderFailure) => GitHubCopilotError>
> = {
	model_not_available_for_integrator: (context, cause) =>
		new GitHubCopilotModelUnavailableError("integration", context, { cause }),
	model_not_supported: (context, cause) => new GitHubCopilotModelUnavailableError("not-supported", context, { cause }),
	unsupported_api_for_model: (context, cause) =>
		new GitHubCopilotModelUnavailableError("wrong-api", context, { cause }),
	model_max_prompt_tokens_exceeded: (context, cause) => promptTooLarge(context, cause),
	context_length_exceeded: (context, cause) => promptTooLarge(context, cause),
	invalid_reasoning_effort: (context, cause) =>
		new GitHubCopilotInvalidRequestError("reasoning-effort", context, { cause }),
	content_filter: (context, cause) => new GitHubCopilotContentFilterError(context, { cause }),
	cyber_policy: (context, cause) => new GitHubCopilotContentFilterError(context, { cause }),
	rate_limit_exceeded: (context, cause) =>
		new GitHubCopilotRateLimitError(context, getProviderRetryAfterMs(cause), { cause }),
	insufficient_quota: (context, cause) => new GitHubCopilotQuotaExhaustedError(context, { cause }),
	quota_exceeded: (context, cause) => new GitHubCopilotQuotaExhaustedError(context, { cause }),
	server_error: (context, cause) => new GitHubCopilotServiceUnavailableError(context, { cause }),
	invalid_request_error: (context, cause) =>
		badRequestTextFailure(undefined, context, cause) ??
		new GitHubCopilotInvalidRequestError("rejected", context, { cause }),
	authentication_error: (context, cause) => new GitHubCopilotAuthenticationError(context, { cause }),
	permission_error: (context, cause) => new GitHubCopilotAuthenticationError(context, { cause }),
	billing_error: (context, cause) => new GitHubCopilotQuotaExhaustedError(context, { cause }),
	not_found_error: (context, cause) => new GitHubCopilotModelUnavailableError("not-found", context, { cause }),
	request_too_large: (context, cause) => promptTooLarge(context, cause),
	rate_limit_error: (context, cause) =>
		new GitHubCopilotRateLimitError(context, getProviderRetryAfterMs(cause), { cause }),
	overloaded_error: (context, cause) => new GitHubCopilotServiceUnavailableError(context, { cause }),
	api_error: (context, cause) => new GitHubCopilotServiceUnavailableError(context, { cause }),
	timeout_error: (context, cause) => new GitHubCopilotServiceUnavailableError(context, { cause }),
};

const PROMPT_TOKENS_PATTERN = /prompt token count of (\d+) exceeds the limit of (\d+)/i;

function promptTooLarge(context: GitHubCopilotErrorContext, cause: ProviderFailure): GitHubCopilotPromptTooLargeError {
	const match = context.detail?.match(PROMPT_TOKENS_PATTERN);
	return new GitHubCopilotPromptTooLargeError(
		context,
		match ? { promptTokens: Number(match[1]), limitTokens: Number(match[2]) } : undefined,
		{ cause },
	);
}

/**
 * Plain-text 400 bodies Copilot sends without a JSON code, observed live. Each is matched in full at the boundary so
 * the rest of Atomic branches on the typed code instead of on this text.
 */
function plainTextFailure(
	detail: string | undefined,
	context: GitHubCopilotErrorContext,
	cause: ProviderFailure,
): GitHubCopilotError | undefined {
	const text = detail?.toLowerCase();
	if (text === "no model endpoints available given user constraints") {
		return new GitHubCopilotModelUnavailableError("no-endpoint", context, { cause });
	}
	if (text === "bad request: unknown copilot-integration-id") {
		return new GitHubCopilotInvalidRequestError("integration-id", context, { cause });
	}
	return undefined;
}

/**
 * Copilot sends a used-up monthly quota as HTTP 429 with `x-ratelimit-exceeded: quota_exceeded` and the plain body
 * `quota exceeded` (seen in public reports), unlike a short rate limit.
 */
function reportsExhaustedQuota(response: ProviderFailure): boolean {
	const exceeded = response.headers instanceof Headers ? response.headers.get("x-ratelimit-exceeded") : null;
	return (
		exceeded?.trim().toLowerCase() === "quota_exceeded" ||
		providerDetailOf(response, 429)?.toLowerCase() === "quota exceeded"
	);
}

/**
 * A 400 whose code Atomic does not recognize: Copilot's own prompt-token overflow text means the prompt is too large,
 * whatever the code; without a code, the exact plain-text bodies Copilot sends are matched.
 */
function badRequestTextFailure(
	providerCode: string | undefined,
	context: GitHubCopilotErrorContext,
	cause: ProviderFailure,
): GitHubCopilotError | undefined {
	if (context.detail?.match(PROMPT_TOKENS_PATTERN)) return promptTooLarge(context, cause);
	return providerCode === undefined ? plainTextFailure(context.detail, context, cause) : undefined;
}

function statusFailure(
	status: number,
	context: GitHubCopilotErrorContext,
	cause: ProviderFailure,
	reportsQuota: boolean,
): GitHubCopilotError {
	switch (status) {
		case 401:
		case 403:
			return new GitHubCopilotAuthenticationError(context, { cause });
		case 402:
			return new GitHubCopilotQuotaExhaustedError(context, { cause });
		case 404:
			return new GitHubCopilotModelUnavailableError("not-found", context, { cause });
		case 408:
			return new GitHubCopilotServiceUnavailableError(context, { cause });
		case 413:
			return promptTooLarge(context, cause);
		case 429:
			return reportsQuota
				? new GitHubCopilotQuotaExhaustedError(context, { cause })
				: new GitHubCopilotRateLimitError(context, getProviderRetryAfterMs(cause), { cause });
	}
	if (status >= 500 && status <= 599) return new GitHubCopilotServiceUnavailableError(context, { cause });
	if (status >= 400 && status <= 499) return new GitHubCopilotInvalidRequestError("rejected", context, { cause });
	return new GitHubCopilotUnrecognizedResponseError("unknown-status", context, { cause });
}

/** Where a Copilot request was when it failed. */
export interface GitHubCopilotFailureContext {
	readonly modelId: string;
	readonly api: string;
	/** True once Copilot answered with HTTP success and the response stream started. */
	readonly streamStarted: boolean;
	/** The provider's raw finish or stop reason, when the stream reported one. */
	readonly finishReason?: string;
}

/**
 * The stop reasons each API reports when a content or safety filter ended the response. Responses also records a
 * plain `refusal` for a refusal delta that does not end the turn, so each API has its own set.
 */
const CONTENT_FILTER_STOPS: Readonly<Record<string, ReadonlySet<string | undefined>>> = {
	"openai-completions": new Set(["content_filter"]),
	"openai-responses": new Set(["incomplete.content_filter"]),
	"anthropic-messages": new Set(["refusal", "sensitive"]),
};

/**
 * Translate a failed Copilot request into its typed error, once, at the provider boundary.
 *
 * HTTP failures are classified by the provider's code first, then on a 400 by Copilot's prompt-token overflow text
 * and the exact plain-text bodies it sends without a code, then by status (a 429 that reports a used-up quota is
 * `quota-exhausted`). A failure after the stream started is a content-filter stop for its API, an in-stream error
 * event, a malformed body, or a stream that ended early. Returns undefined for a failure that never reached Copilot (a
 * connection error before any response), which keeps Atomic's generic network handling. Never call it for a
 * cancelled request: cancellation is not a failure.
 */
export function classifyGitHubCopilotFailure(
	error: unknown,
	failure: GitHubCopilotFailureContext,
): GitHubCopilotError | undefined {
	const typed = findGitHubCopilotError(error);
	if (typed !== undefined) return typed;
	const providerError: ProviderFailure =
		error instanceof Error ? (error as ProviderFailure) : new Error(String(error), { cause: error });
	const response = responseOf(providerError);
	const status = typeof providerError.status === "number" ? providerError.status : undefined;
	const providerCode = providerCodeOf(response);
	const context: GitHubCopilotErrorContext = {
		modelId: failure.modelId,
		api: failure.api,
		status,
		providerCode,
		requestId: requestIdOf(response),
		detail: providerDetailOf(response, typeof response.status === "number" ? response.status : undefined),
	};
	const codeFailure = providerCode === undefined ? undefined : PROVIDER_CODE_FAILURES[providerCode.toLowerCase()];
	if (codeFailure !== undefined) return codeFailure(context, providerError);
	if (status !== undefined) {
		return (
			(status === 400 ? badRequestTextFailure(providerCode, context, providerError) : undefined) ??
			statusFailure(status, context, providerError, reportsExhaustedQuota(response))
		);
	}
	if (CONTENT_FILTER_STOPS[failure.api]?.has(failure.finishReason)) {
		return new GitHubCopilotContentFilterError(context, { cause: providerError });
	}
	if (providerCode !== undefined) {
		return new GitHubCopilotUnrecognizedResponseError("unknown-error-event", context, { cause: providerError });
	}
	if (providerError instanceof SyntaxError || providerError.error !== undefined) {
		return new GitHubCopilotUnrecognizedResponseError("malformed-body", context, { cause: providerError });
	}
	return failure.streamStarted ? new GitHubCopilotStreamEndedEarlyError(context, { cause: providerError }) : undefined;
}

/**
 * Type a failed Copilot assistant message at the provider boundary: classify `error` and record it on `output`,
 * keeping the provider's text after the typed message. A cancelled message is left alone.
 */
export function recordGitHubCopilotFailure(output: AssistantMessage, error: unknown, streamStarted: boolean): void {
	if (output.stopReason !== "error") return;
	const typed = classifyGitHubCopilotFailure(error, {
		modelId: output.model,
		api: output.api,
		streamStarted,
		finishReason: output.rawStopReason,
	});
	if (typed !== undefined) recordGitHubCopilotError(output, typed, output.errorMessage);
}

/**
 * The typed failure for a completed Copilot turn that has no text and no tool call, as Copilot's Gemini models
 * sometimes return; undefined for any other turn. A length stop is left to the caller's length handling.
 */
export function githubCopilotEmptyResponse(output: AssistantMessage): GitHubCopilotEmptyResponseError | undefined {
	if (output.provider !== "github-copilot" || (output.stopReason !== "stop" && output.stopReason !== "toolUse")) {
		return undefined;
	}
	const answered = output.content.some(
		(block) => block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0),
	);
	return answered ? undefined : new GitHubCopilotEmptyResponseError({ modelId: output.model, api: output.api });
}
