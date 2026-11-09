/**
 * Typed failures of `generateImages()`.
 *
 * One family, {@link ImageGenerationError}, covers every failure the image providers can
 * classify: a rejected request configuration ({@link ImageGenerationConfigError}), an API
 * failure ({@link ImageGenerationApiError} and its subclasses) and a client-side timeout
 * ({@link ImageGenerationTimeoutError}). Branch on the class, its guard or `code`, never on
 * `message`. Cancellation is not a failure: an aborted request resolves with
 * `stopReason: "aborted"` and no error.
 */

export type ImageGenerationErrorFieldValue = string | number | boolean | readonly string[] | undefined;

/** A foreign cause with its name, a safe errno code, and a redacted message. */
export interface ImageGenerationForeignCauseData {
	name: string;
	message: string;
	code?: string;
	cause?: ImageGenerationErrorData | ImageGenerationForeignCauseData;
}

/** JSON-safe form of an {@link ImageGenerationError}, for results, IPC and worker boundaries. */
export interface ImageGenerationErrorData {
	name: string;
	code: string;
	message: string;
	hint?: string;
	retryable: boolean;
	fields: Record<string, ImageGenerationErrorFieldValue>;
	/**
	 * The next link of the `cause` chain. Family errors keep their data; foreign errors keep their
	 * name and known errno code, with their message redacted. At most eight links are kept.
	 */
	cause?: ImageGenerationErrorData | ImageGenerationForeignCauseData;
}

interface ImageGenerationErrorInit {
	name: string;
	code: string;
	message: string;
	hint?: string;
	retryable?: boolean;
	cause?: unknown;
}

const MAX_CAUSE_DEPTH = 8;
const FOREIGN_MESSAGE = "[foreign error message omitted]";
const SAFE_ERRNO_CODES = new Set([
	"EACCES",
	"EADDRINUSE",
	"EADDRNOTAVAIL",
	"EAFNOSUPPORT",
	"EAGAIN",
	"EALREADY",
	"EBADF",
	"EBUSY",
	"ECANCELED",
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EDESTADDRREQ",
	"EEXIST",
	"EFAULT",
	"EHOSTUNREACH",
	"EINTR",
	"EINVAL",
	"EIO",
	"EISDIR",
	"EMFILE",
	"EMSGSIZE",
	"ENETDOWN",
	"ENETRESET",
	"ENETUNREACH",
	"ENFILE",
	"ENOENT",
	"ENOMEM",
	"ENOSPC",
	"ENOTCONN",
	"ENOTDIR",
	"ENOTFOUND",
	"ENOTSOCK",
	"ENOTSUP",
	"EPIPE",
	"EPERM",
	"EPROTO",
	"EPROTONOSUPPORT",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"EAI_FAIL",
	"EAI_NONAME",
]);

function safeForeignName(name: unknown): string {
	return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name) ? name : "Error";
}

function safeErrno(code: unknown): string | undefined {
	return typeof code === "string" && SAFE_ERRNO_CODES.has(code) ? code : undefined;
}

function sanitizeCause(cause: unknown, depth: number): Error | undefined {
	if (depth > MAX_CAUSE_DEPTH || !(cause instanceof Error)) return undefined;
	if (cause instanceof ImageGenerationError) return cause;
	const nested = sanitizeCause(cause.cause, depth + 1);
	const safe = new Error(FOREIGN_MESSAGE, nested ? { cause: nested } : undefined);
	safe.name = safeForeignName(cause.name);
	const code = safeErrno((cause as Error & { code?: unknown }).code);
	if (code) Object.assign(safe, { code });
	return safe;
}

/** Base of every typed image-generation failure. */
export class ImageGenerationError extends Error {
	override readonly name: string;
	readonly code: string;
	/** True when the same request may succeed if sent again unchanged. */
	readonly retryable: boolean;
	readonly hint?: string;

	constructor(init: ImageGenerationErrorInit) {
		super(init.message, { cause: sanitizeCause(init.cause, 2) });
		this.name = init.name;
		this.code = init.code;
		this.retryable = init.retryable ?? false;
		this.hint = init.hint;
	}

	/** Safe, JSON-serializable context for this failure. Overridden by classes that carry fields. */
	protected dataFields(): Record<string, ImageGenerationErrorFieldValue> {
		return {};
	}

	toData(): ImageGenerationErrorData {
		return this.dataWithCauses(1);
	}

	private static causeData(
		cause: unknown,
		depth: number,
	): ImageGenerationErrorData | ImageGenerationForeignCauseData | undefined {
		if (depth > MAX_CAUSE_DEPTH || !(cause instanceof Error)) return undefined;
		if (cause instanceof ImageGenerationError) return cause.dataWithCauses(depth);
		const code = safeErrno((cause as Error & { code?: unknown }).code);
		const nested = ImageGenerationError.causeData(cause.cause, depth + 1);
		return {
			name: safeForeignName(cause.name),
			message: FOREIGN_MESSAGE,
			...(code ? { code } : {}),
			...(nested ? { cause: nested } : {}),
		};
	}

	private dataWithCauses(depth: number): ImageGenerationErrorData {
		const causeData = ImageGenerationError.causeData(this.cause, depth + 1);
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			...(this.hint !== undefined ? { hint: this.hint } : {}),
			retryable: this.retryable,
			fields: this.dataFields(),
			...(causeData ? { cause: causeData } : {}),
		};
	}

	toJSON(): ImageGenerationErrorData {
		return this.toData();
	}
}

/**
 * Why an option was rejected. The first seven are found before a request is sent. The last three
 * come from the API's own rejection of an option: `required-by-api` (the API needs an option the
 * request did not carry), `rejected-by-api` (the API refused the option's value) and
 * `unsupported-by-api` (the API does not accept the option for this account or model).
 */
export type ImageGenerationConfigReason =
	| "out-of-range"
	| "requires-option"
	| "conflicts-with-option"
	| "generation-only"
	| "unsupported-by-model"
	| "requires-base-image"
	| "duplicate-role"
	| "required-by-api"
	| "rejected-by-api"
	| "unsupported-by-api";

export interface ImageGenerationConfigErrorInit {
	model: string;
	field: string;
	reason: ImageGenerationConfigReason;
	/** The other option or request part that `field` conflicts with or depends on. */
	related?: string;
	/** What is wrong, in words. Names options only and never echoes prompt or image content. */
	detail: string;
	hint: string;
	cause?: unknown;
}

/**
 * The request options or input are invalid. Found before any request is sent, or reported by the
 * API as a rejected option (`reason` `required-by-api`, `rejected-by-api` or `unsupported-by-api`).
 * Either way nothing was billed and retrying the same request fails the same way.
 */
export class ImageGenerationConfigError extends ImageGenerationError {
	declare readonly name: "ImageGenerationConfigError";
	declare readonly code: "invalid-option";
	readonly source = "sdk" as const;
	readonly model: string;
	readonly field: string;
	readonly reason: ImageGenerationConfigReason;
	readonly related?: string;
	readonly detail: string;

	constructor(init: ImageGenerationConfigErrorInit) {
		super({
			name: "ImageGenerationConfigError",
			code: "invalid-option",
			message: `Invalid image generation option: ${init.field} for ${init.model} (invalid-option). ${init.detail}. ${init.hint}`,
			hint: init.hint,
			cause: init.cause,
		});
		this.model = init.model;
		this.field = init.field;
		this.reason = init.reason;
		this.related = init.related;
		this.detail = init.detail;
	}

	protected override dataFields(): Record<string, ImageGenerationErrorFieldValue> {
		return {
			source: this.source,
			model: this.model,
			field: this.field,
			reason: this.reason,
			related: this.related,
			detail: this.detail,
		};
	}
}

export type ImageGenerationApiErrorCode =
	| "api-error"
	| "quota-exceeded"
	| "rate-limited"
	| "server-error"
	| "user-error"
	| "moderation-blocked";

export interface ImageGenerationApiErrorInit {
	/**
	 * A summary built from the HTTP status and the provider's type, code and request ID. Never the
	 * provider's message, which can quote the prompt.
	 */
	detail: string;
	status?: number;
	/** The provider's `error.code`, for example `insufficient_quota` or `moderation_blocked`. */
	apiCode?: string;
	/** The provider's `error.type`, for example `image_generation_user_error`. */
	apiType?: string;
	requestId?: string;
	retryable?: boolean;
	cause?: unknown;
}

const API_ERROR_HINTS = {
	"api-error": "Check the status and provider code, then correct the request or credentials.",
	"quota-exceeded": "Add credit or raise the usage limit on the OpenAI account. Retrying will not help.",
	"rate-limited": "Wait and retry, or set maxRetries to retry automatically.",
	"server-error": "The provider failed. Retry later, or set maxRetries to retry automatically.",
	"user-error": "Change the prompt or the input images before sending the request again.",
	"moderation-blocked": "Revise the prompt or input images. Retrying the same request is blocked again.",
} as const satisfies Record<ImageGenerationApiErrorCode, string>;

/** The image API answered with a failure. Subclasses name the cases a caller handles differently. */
export class ImageGenerationApiError extends ImageGenerationError {
	declare readonly name: "ImageGenerationApiError" | (typeof API_SUBCLASS_NAMES)[number];
	declare readonly code: ImageGenerationApiErrorCode;
	readonly status?: number;
	readonly apiCode?: string;
	readonly apiType?: string;
	readonly requestId?: string;
	readonly detail: string;

	constructor(init: ImageGenerationApiErrorInit, identity: ApiErrorIdentity = DEFAULT_API_IDENTITY) {
		super({
			name: identity.name,
			code: identity.code,
			message: `Image generation request failed (${identity.code}): ${init.detail}`,
			hint: API_ERROR_HINTS[identity.code],
			retryable: init.retryable ?? identity.retryable,
			cause: init.cause,
		});
		this.detail = init.detail;
		this.status = init.status;
		this.apiCode = init.apiCode;
		this.apiType = init.apiType;
		this.requestId = init.requestId;
	}

	protected override dataFields(): Record<string, ImageGenerationErrorFieldValue> {
		return {
			detail: this.detail,
			status: this.status,
			apiCode: this.apiCode,
			apiType: this.apiType,
			requestId: this.requestId,
		};
	}
}

const API_SUBCLASS_NAMES = [
	"ImageGenerationQuotaError",
	"ImageGenerationRateLimitError",
	"ImageGenerationServerError",
	"ImageGenerationUserError",
	"ImageModerationBlockedError",
] as const;

interface ApiErrorIdentity {
	name: ImageGenerationApiError["name"];
	code: ImageGenerationApiErrorCode;
	retryable: boolean;
}

const DEFAULT_API_IDENTITY: ApiErrorIdentity = { name: "ImageGenerationApiError", code: "api-error", retryable: false };

/** The account is out of quota or credit. Not retryable, even though it arrives as HTTP 429. */
export class ImageGenerationQuotaError extends ImageGenerationApiError {
	declare readonly name: "ImageGenerationQuotaError";
	declare readonly code: "quota-exceeded";
	constructor(init: ImageGenerationApiErrorInit) {
		super(init, { name: "ImageGenerationQuotaError", code: "quota-exceeded", retryable: false });
	}
}

/** The request rate limit was hit. Retryable after a delay. */
export class ImageGenerationRateLimitError extends ImageGenerationApiError {
	declare readonly name: "ImageGenerationRateLimitError";
	declare readonly code: "rate-limited";
	constructor(init: ImageGenerationApiErrorInit) {
		super(init, { name: "ImageGenerationRateLimitError", code: "rate-limited", retryable: true });
	}
}

/** The provider failed with a 5xx status. Retryable. */
export class ImageGenerationServerError extends ImageGenerationApiError {
	declare readonly name: "ImageGenerationServerError";
	declare readonly code: "server-error";
	constructor(init: ImageGenerationApiErrorInit) {
		super(init, { name: "ImageGenerationServerError", code: "server-error", retryable: true });
	}
}

/**
 * The provider rejected the request as user-correctable (`error.type` is
 * `image_generation_user_error`). Not retryable until the prompt or the input images change.
 * `apiCode` is the stable discriminator, for example `moderation_blocked`.
 */
export class ImageGenerationUserError extends ImageGenerationApiError {
	declare readonly name: "ImageGenerationUserError" | "ImageModerationBlockedError";
	declare readonly code: "user-error" | "moderation-blocked";
	constructor(init: ImageGenerationApiErrorInit, identity?: ApiErrorIdentity) {
		super(init, identity ?? { name: "ImageGenerationUserError", code: "user-error", retryable: false });
	}
}

export type ImageModerationStage = "input" | "output" | "unknown";

export interface ImageModerationBlockedErrorInit extends ImageGenerationApiErrorInit {
	moderationStage?: ImageModerationStage;
	categories?: readonly string[];
}

/** Content moderation blocked the prompt, the input images or the generated image. */
export class ImageModerationBlockedError extends ImageGenerationUserError {
	declare readonly name: "ImageModerationBlockedError";
	declare readonly code: "moderation-blocked";
	/** Where the block happened, when the provider says. */
	readonly moderationStage?: ImageModerationStage;
	/** Coarse public category labels such as `harassment` or `violence`. */
	readonly categories: readonly string[];

	constructor(init: ImageModerationBlockedErrorInit) {
		super(init, { name: "ImageModerationBlockedError", code: "moderation-blocked", retryable: false });
		this.moderationStage = init.moderationStage;
		this.categories = init.categories ?? [];
	}

	protected override dataFields(): Record<string, ImageGenerationErrorFieldValue> {
		return { ...super.dataFields(), moderationStage: this.moderationStage, categories: this.categories };
	}
}

export interface ImageGenerationTimeoutErrorInit {
	timeoutMs: number;
	elapsedMs: number;
	cause?: unknown;
}

/** The request did not complete within `timeoutMs`. Retryable. */
export class ImageGenerationTimeoutError extends ImageGenerationError {
	declare readonly name: "ImageGenerationTimeoutError";
	declare readonly code: "timeout";
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly phase = "request" as const;

	constructor(init: ImageGenerationTimeoutErrorInit) {
		super({
			name: "ImageGenerationTimeoutError",
			code: "timeout",
			message: `Image generation timed out: request after ${init.elapsedMs}ms of ${init.timeoutMs}ms (timeout). Raise timeoutMs or lower the image size, count or quality.`,
			hint: "Raise timeoutMs or lower the image size, count or quality.",
			retryable: true,
			cause: init.cause,
		});
		this.timeoutMs = init.timeoutMs;
		this.elapsedMs = init.elapsedMs;
	}

	protected override dataFields(): Record<string, ImageGenerationErrorFieldValue> {
		return { timeoutMs: this.timeoutMs, elapsedMs: this.elapsedMs, phase: this.phase };
	}
}

/** The `code` each concrete family class carries. The family base accepts any code. */
const FAMILY_CODES = {
	ImageGenerationConfigError: "invalid-option",
	ImageGenerationApiError: "api-error",
	ImageGenerationQuotaError: "quota-exceeded",
	ImageGenerationRateLimitError: "rate-limited",
	ImageGenerationServerError: "server-error",
	ImageGenerationUserError: "user-error",
	ImageModerationBlockedError: "moderation-blocked",
	ImageGenerationTimeoutError: "timeout",
} as const;

type FamilyName = keyof typeof FAMILY_CODES | "ImageGenerationError";

function hasShape(value: unknown, names: readonly FamilyName[]): boolean {
	if (typeof value !== "object" || value === null) return false;
	const { name, code } = value as { name?: unknown; code?: unknown };
	if (typeof code !== "string" || !(names as readonly unknown[]).includes(name)) return false;
	return name === "ImageGenerationError" || FAMILY_CODES[name as keyof typeof FAMILY_CODES] === code;
}

function causeOf(error: unknown): unknown {
	return typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
}

/**
 * Guards check the value itself: an instance of the class, or, across processes and realms, an
 * object whose `name` is the class name and whose `code` is that class's code. Use
 * {@link findImageGenerationError} to search a `cause` chain.
 */
function guard<T extends ImageGenerationError>(
	type: abstract new (...args: never[]) => T,
	names: readonly FamilyName[],
): (value: unknown) => value is T {
	return (value: unknown): value is T => value instanceof type || hasShape(value, names);
}

const API_NAMES = ["ImageGenerationApiError", ...API_SUBCLASS_NAMES] as const;
const USER_NAMES = ["ImageGenerationUserError", "ImageModerationBlockedError"] as const;
const FAMILY_NAMES = [
	"ImageGenerationError",
	"ImageGenerationConfigError",
	"ImageGenerationTimeoutError",
	...API_NAMES,
] as const;

export const isImageGenerationError = guard(ImageGenerationError, FAMILY_NAMES);
export const isImageGenerationConfigError = guard(ImageGenerationConfigError, ["ImageGenerationConfigError"]);
export const isImageGenerationApiError = guard(ImageGenerationApiError, API_NAMES);
export const isImageGenerationQuotaError = guard(ImageGenerationQuotaError, ["ImageGenerationQuotaError"]);
export const isImageGenerationRateLimitError = guard(ImageGenerationRateLimitError, ["ImageGenerationRateLimitError"]);
export const isImageGenerationServerError = guard(ImageGenerationServerError, ["ImageGenerationServerError"]);
export const isImageGenerationUserError = guard(ImageGenerationUserError, USER_NAMES);
export const isImageModerationBlockedError = guard(ImageModerationBlockedError, ["ImageModerationBlockedError"]);
export const isImageGenerationTimeoutError = guard(ImageGenerationTimeoutError, ["ImageGenerationTimeoutError"]);

function isImageGenerationErrorInstance(value: unknown): value is ImageGenerationError {
	return value instanceof ImageGenerationError;
}

/**
 * Search the error and its `cause` chain, at most eight links, for the first value `guard` accepts.
 * Without a guard, returns the nearest {@link ImageGenerationError} instance, for example
 * `findImageGenerationError(error, isImageGenerationQuotaError)`.
 */
export function findImageGenerationError(error: unknown): ImageGenerationError | undefined;
export function findImageGenerationError<T>(error: unknown, guard: (value: unknown) => value is T): T | undefined;
export function findImageGenerationError(
	error: unknown,
	accept: (value: unknown) => boolean = isImageGenerationErrorInstance,
): unknown {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (accept(current)) return current;
		current = causeOf(current);
	}
	return undefined;
}

/** True when the nearest image-generation error in the `cause` chain says the same request may be retried. */
export function isRetryableImageGenerationError(error: unknown): boolean {
	return findImageGenerationError(error, isImageGenerationError)?.retryable === true;
}

function stringField(fields: ImageGenerationErrorData["fields"], key: string): string | undefined {
	const value = fields[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(fields: ImageGenerationErrorData["fields"], key: string): number | undefined {
	const value = fields[key];
	return typeof value === "number" ? value : undefined;
}

function listField(fields: ImageGenerationErrorData["fields"], key: string): readonly string[] {
	const value = fields[key];
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function apiInit(data: ImageGenerationErrorData, cause: Error | undefined): ImageGenerationApiErrorInit {
	const { fields } = data;
	return {
		detail: stringField(fields, "detail") ?? data.message,
		status: numberField(fields, "status"),
		apiCode: stringField(fields, "apiCode"),
		apiType: stringField(fields, "apiType"),
		requestId: stringField(fields, "requestId"),
		retryable: data.retryable,
		cause,
	};
}

function createFromData(data: ImageGenerationErrorData, cause: Error | undefined): ImageGenerationError {
	const { fields } = data;
	switch (data.name) {
		case "ImageGenerationConfigError":
			return new ImageGenerationConfigError({
				model: stringField(fields, "model") ?? "",
				field: stringField(fields, "field") ?? "",
				reason: (stringField(fields, "reason") ?? "out-of-range") as ImageGenerationConfigReason,
				related: stringField(fields, "related"),
				detail: stringField(fields, "detail") ?? data.message,
				hint: data.hint ?? "",
				cause,
			});
		case "ImageGenerationTimeoutError":
			return new ImageGenerationTimeoutError({
				timeoutMs: numberField(fields, "timeoutMs") ?? 0,
				elapsedMs: numberField(fields, "elapsedMs") ?? 0,
				cause,
			});
		case "ImageGenerationApiError":
			return new ImageGenerationApiError(apiInit(data, cause));
		case "ImageGenerationQuotaError":
			return new ImageGenerationQuotaError(apiInit(data, cause));
		case "ImageGenerationRateLimitError":
			return new ImageGenerationRateLimitError(apiInit(data, cause));
		case "ImageGenerationServerError":
			return new ImageGenerationServerError(apiInit(data, cause));
		case "ImageGenerationUserError":
			return new ImageGenerationUserError(apiInit(data, cause));
		case "ImageModerationBlockedError": {
			const stage = stringField(fields, "moderationStage");
			return new ImageModerationBlockedError({
				...apiInit(data, cause),
				moderationStage: stage === "input" || stage === "output" || stage === "unknown" ? stage : undefined,
				categories: listField(fields, "categories"),
			});
		}
		default:
			return new ImageGenerationError({
				name: data.name,
				code: data.code,
				message: data.message,
				hint: data.hint,
				retryable: data.retryable,
				cause,
			});
	}
}

function isErrorData(value: ImageGenerationErrorData["cause"]): value is ImageGenerationErrorData {
	const { code, retryable, fields } = value as Partial<ImageGenerationErrorData>;
	return typeof code === "string" && typeof retryable === "boolean" && typeof fields === "object" && fields !== null;
}

function causeFromData(cause: ImageGenerationErrorData["cause"], depth: number): Error | undefined {
	if (cause === undefined || depth > MAX_CAUSE_DEPTH) return undefined;
	if (isErrorData(cause)) return errorFromData(cause, depth);
	const nested = causeFromData(cause.cause, depth + 1);
	const error = new Error(FOREIGN_MESSAGE, nested ? { cause: nested } : undefined);
	error.name = safeForeignName(cause.name);
	const code = safeErrno(cause.code);
	if (code) Object.assign(error, { code });
	return error;
}

function errorFromData(data: ImageGenerationErrorData, depth: number): ImageGenerationError {
	const error = createFromData(data, causeFromData(data.cause, depth + 1));
	error.message = data.message;
	return error;
}

/**
 * Rebuild a typed error from {@link ImageGenerationErrorData}, for example after a result crossed a
 * worker or process boundary. Family causes come back as their own classes, other causes as plain
 * errors, at most eight links deep. Unknown names become an {@link ImageGenerationError} that keeps
 * the original `name` and `code`.
 */
export function imageGenerationErrorFromData(data: ImageGenerationErrorData): ImageGenerationError {
	return errorFromData(data, 1);
}
