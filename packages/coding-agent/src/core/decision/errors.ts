/**
 * The {@link DecisionError} family: every failure of the decision service (`decide()`), of the `decisionModel`
 * setting, and of the decision model's resolution. Catch the family or a concrete class and branch on `code`.
 */

/** `renamed-setting`: a settings file still uses a removed key. `invalid-setting`: `decisionModel` has an invalid value. */
export type DecisionConfigErrorCode = "renamed-setting" | "invalid-setting";

/** Every code of the {@link DecisionError} family. Codes are public API and never change meaning. */
export type DecisionErrorCode =
	| DecisionConfigErrorCode
	| "invalid-request"
	| "model-unavailable"
	| "timeout"
	| "invalid-output"
	| "provider-failure";

/** Where a refused configuration came from: a settings file, or an SDK caller's settings object. */
export type DecisionConfigSource = "settings" | "sdk";

/** Which settings file holds the refused key. */
export type DecisionSettingsScope = "global" | "project";

/** Why a `decide()` request was refused before any model was asked. */
export type DecisionRequestErrorReason =
	| "invalid-state"
	| "no-questions"
	| "invalid-question"
	| "invalid-instructions"
	| "invalid-deadline"
	| "invalid-model"
	| "credential-in-state";

/**
 * Why no model could answer: `not-in-catalog` (the configured model is not a registered chat or classifier model),
 * `no-chat-model` (no `decisionModel` is set and no concrete chat model is selected), `no-probabilities` (the
 * request requires probabilities and the decision model is a chat model, whose answers carry none).
 */
export type DecisionModelUnavailableReason = "not-in-catalog" | "no-chat-model" | "no-probabilities";

/** What the decision was doing when its deadline passed: resolving the model, or waiting for a classifier or chat model. */
export type DecisionPhase = "resolve" | "classifier" | "chat";

/** A rate limit or an exhausted quota that the provider reported, without its text. */
export type DecisionProviderFailureCode = "rate_limit_exceeded" | "insufficient_quota";

/** JSON-safe structured context of a decision error. */
export type DecisionErrorFieldValue = string | number | boolean;

const DECISION_ERROR_NAMES = new Set<string>([
	"DecisionError",
	"DecisionConfigError",
	"DecisionRequestError",
	"DecisionModelUnavailableError",
	"DecisionTimeoutError",
	"DecisionOutputError",
	"DecisionProviderError",
]);
const DECISION_ERROR_CODES = new Set<string>([
	"renamed-setting",
	"invalid-setting",
	"invalid-request",
	"model-unavailable",
	"timeout",
	"invalid-output",
	"provider-failure",
]);
const MAX_CAUSE_DEPTH = 8;

function message(what: string, subject: string, code: DecisionErrorCode, hint: string): string {
	return `${what}: ${subject} (${code}). ${hint}`;
}

/** The family of decision errors. Not retryable unless a subclass says so. */
export class DecisionError extends Error {
	override readonly name: string = "DecisionError";
	readonly code: DecisionErrorCode;
	/** What to do about it, without the rest of the message. */
	readonly hint: string;
	readonly retryable: boolean = false;
	constructor(code: DecisionErrorCode, text: string, hint: string, options?: ErrorOptions) {
		super(text, options);
		this.code = code;
		this.hint = hint;
	}

	/** The JSON-safe fields that identify this failure, for serialization. */
	fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return {};
	}
}

export interface DecisionConfigErrorFields {
	readonly code: DecisionConfigErrorCode;
	readonly source: DecisionConfigSource;
	/** The refused key: `routerModel` for `renamed-setting`, `decisionModel` for `invalid-setting`. */
	readonly field: string;
	/** The settings file that holds the key; absent for an SDK caller's settings. */
	readonly scope?: DecisionSettingsScope;
}

function configSubject(fields: DecisionConfigErrorFields): string {
	if (fields.scope !== undefined) return `"${fields.field}" in ${fields.scope} settings.json`;
	return `"${fields.field}" in ${fields.source === "sdk" ? "the SDK settings" : "settings.json"}`;
}

function configHint(fields: DecisionConfigErrorFields): string {
	const where =
		fields.scope !== undefined
			? `your ${fields.scope} settings.json`
			: fields.source === "sdk"
				? "the settings you pass"
				: "settings.json";
	return fields.code === "renamed-setting"
		? `Rename "routerModel" to "decisionModel" in ${where}.`
		: `Set "decisionModel" in ${where} to an exact provider/model ID, "auto", or an empty string.`;
}

/**
 * The `decisionModel` configuration is refused. Thrown when settings load, before Atomic starts, so nothing ran.
 * Not retryable: correct the setting.
 */
export class DecisionConfigError extends DecisionError {
	override readonly name = "DecisionConfigError" as const;
	declare readonly code: DecisionConfigErrorCode;
	override readonly retryable = false as const;
	readonly source: DecisionConfigSource;
	readonly field: string;
	readonly scope?: DecisionSettingsScope;
	constructor(fields: DecisionConfigErrorFields, options?: ErrorOptions) {
		const hint = configHint(fields);
		super(
			fields.code,
			message(
				fields.code === "renamed-setting" ? "Renamed setting" : "Invalid decision model setting",
				configSubject(fields),
				fields.code,
				hint,
			),
			hint,
			options,
		);
		this.source = fields.source;
		this.field = fields.field;
		if (fields.scope !== undefined) this.scope = fields.scope;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return { source: this.source, field: this.field, ...(this.scope === undefined ? {} : { scope: this.scope }) };
	}
}

export interface DecisionRequestErrorFields {
	/** The request field that was refused, for example `state` or `questions.next_action.criteria`. */
	readonly field: string;
	readonly reason: DecisionRequestErrorReason;
}

const REQUEST_HINTS: Readonly<Record<DecisionRequestErrorReason, string>> = {
	"invalid-state": "Pass state as a nonempty object of finite, acyclic JSON values.",
	"no-questions": "Pass at least one question.",
	"invalid-question":
		'Give each question a nonempty ID and instructions; a "choice" needs described options, a "bool" describes true and false, a "score" lists its levels.',
	"invalid-instructions": "Pass instructions as nonempty text, or omit them.",
	"invalid-deadline": "Pass deadline as a positive integer number of milliseconds, or omit it.",
	"invalid-model": 'Pass model as an exact provider/model ID other than "auto", or omit it.',
	"credential-in-state": "Remove credentials from state; a decision never sends them to a model.",
};

/** A `decide()` request is malformed. Thrown before any model is asked. Not retryable: correct the request. */
export class DecisionRequestError extends DecisionError {
	override readonly name = "DecisionRequestError" as const;
	declare readonly code: "invalid-request";
	override readonly retryable = false as const;
	readonly field: string;
	readonly reason: DecisionRequestErrorReason;
	constructor(fields: DecisionRequestErrorFields, options?: ErrorOptions) {
		const hint = REQUEST_HINTS[fields.reason];
		super(
			"invalid-request",
			message("Invalid decision request", `${fields.field} is ${fields.reason}`, "invalid-request", hint),
			hint,
			options,
		);
		this.field = fields.field;
		this.reason = fields.reason;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return { field: this.field, reason: this.reason };
	}
}

export interface DecisionModelUnavailableErrorFields {
	readonly reason: DecisionModelUnavailableReason;
	/** The configured or requested model ID, when one was named. */
	readonly model?: string;
}

const UNAVAILABLE_HINTS: Readonly<Record<DecisionModelUnavailableReason, string>> = {
	"not-in-catalog": 'Set "decisionModel" to a registered chat or classifier model in /settings, or leave it empty.',
	"no-chat-model": 'Select a chat model with /model, or set "decisionModel" in /settings.',
	"no-probabilities":
		'Set "decisionModel" to a classifier, such as typesafe/jev-latest, in /settings; a chat model\'s answers carry no probabilities.',
};

/** No model can answer this decision. Not retryable until the configuration changes. */
export class DecisionModelUnavailableError extends DecisionError {
	override readonly name = "DecisionModelUnavailableError" as const;
	declare readonly code: "model-unavailable";
	override readonly retryable = false as const;
	readonly reason: DecisionModelUnavailableReason;
	readonly model?: string;
	constructor(fields: DecisionModelUnavailableErrorFields, options?: ErrorOptions) {
		const hint = UNAVAILABLE_HINTS[fields.reason];
		super(
			"model-unavailable",
			message(
				"Decision model unavailable",
				fields.model === undefined ? fields.reason : `${fields.model} is ${fields.reason}`,
				"model-unavailable",
				hint,
			),
			hint,
			options,
		);
		this.reason = fields.reason;
		if (fields.model !== undefined) this.model = fields.model;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return { reason: this.reason, ...(this.model === undefined ? {} : { model: this.model }) };
	}
}

export interface DecisionTimeoutErrorFields {
	/** The decision's wall-clock limit. */
	readonly timeoutMs: number;
	/** How long the decision ran before the limit stopped it. */
	readonly elapsedMs: number;
	readonly phase: DecisionPhase;
	/** How each model request of the decision ended and how long it took, without content. */
	readonly attempts?: string;
}

/**
 * The decision did not finish within its deadline; no decision was accepted. Retryable: the model may answer in time
 * on another attempt, or a longer `deadline` (or `httpIdleTimeoutMs`) gives it room.
 */
export class DecisionTimeoutError extends DecisionError {
	override readonly name = "DecisionTimeoutError" as const;
	declare readonly code: "timeout";
	override readonly retryable = true as const;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly phase: DecisionPhase;
	readonly attempts?: string;
	constructor(fields: DecisionTimeoutErrorFields, options?: ErrorOptions) {
		const hint = "Retry, or allow a longer deadline (httpIdleTimeoutMs).";
		super(
			"timeout",
			`${message("Decision timed out", `no answer within its ${fields.timeoutMs}ms deadline while waiting for the ${fields.phase === "resolve" ? "decision model" : `${fields.phase} model`}`, "timeout", hint)}${fields.attempts ? ` ${fields.attempts}` : ""}`,
			hint,
			options,
		);
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
		this.phase = fields.phase;
		if (fields.attempts) this.attempts = fields.attempts;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return {
			timeoutMs: this.timeoutMs,
			elapsedMs: this.elapsedMs,
			phase: this.phase,
			...(this.attempts === undefined ? {} : { attempts: this.attempts }),
		};
	}
}

export interface DecisionOutputErrorFields {
	/** The model whose answer was refused. */
	readonly model: string;
	/** What was wrong with the last answer and how each attempt ended; never answer or state text. */
	readonly detail?: string;
}

/** The decision model answered, but no answer satisfied the questions after repairs. Not retryable as is. */
export class DecisionOutputError extends DecisionError {
	override readonly name = "DecisionOutputError" as const;
	declare readonly code: "invalid-output";
	override readonly retryable = false as const;
	readonly model: string;
	readonly detail?: string;
	constructor(fields: DecisionOutputErrorFields, options?: ErrorOptions) {
		const hint = "Make the questions and their options unambiguous, or choose another decision model.";
		super(
			"invalid-output",
			message(
				"Decision output invalid",
				`${fields.model} gave no valid answer${fields.detail ? `: ${fields.detail}` : ""}`,
				"invalid-output",
				hint,
			),
			hint,
			options,
		);
		this.model = fields.model;
		if (fields.detail) this.detail = fields.detail;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return { model: this.model, ...(this.detail === undefined ? {} : { detail: this.detail }) };
	}
}

export interface DecisionProviderErrorFields {
	/** The model whose request failed, when known. */
	readonly model?: string;
	/** The HTTP status of a rate limit (429) or an exhausted quota (402). */
	readonly providerStatus?: number;
	readonly providerCode?: DecisionProviderFailureCode;
	/** The provider's retry hint, in milliseconds. */
	readonly retryAfterMs?: number;
	/** How the request failed, without provider text, which can echo private state. */
	readonly detail?: string;
}

/**
 * The decision model's request failed. Retryable when the provider reported a rate limit or an exhausted quota
 * (`providerCode`); otherwise check the provider's configuration and connectivity.
 */
export class DecisionProviderError extends DecisionError {
	override readonly name = "DecisionProviderError" as const;
	declare readonly code: "provider-failure";
	override readonly retryable: boolean;
	readonly model?: string;
	readonly providerStatus?: number;
	readonly providerCode?: DecisionProviderFailureCode;
	readonly retryAfterMs?: number;
	readonly detail?: string;
	constructor(fields: DecisionProviderErrorFields, options?: ErrorOptions) {
		const hint =
			fields.providerCode === undefined
				? "Check the decision model's provider configuration and connectivity."
				: `Retry after ${fields.retryAfterMs === undefined ? "a moment" : `${fields.retryAfterMs}ms`}; the provider reported ${fields.providerCode}.`;
		super(
			"provider-failure",
			message(
				"Decision model request failed",
				`${fields.model ?? "the decision model"}${fields.providerStatus === undefined ? "" : ` returned HTTP ${fields.providerStatus}`}${fields.detail ? `: ${fields.detail}` : ""}`,
				"provider-failure",
				hint,
			),
			hint,
			options,
		);
		this.retryable = fields.providerCode !== undefined;
		if (fields.model !== undefined) this.model = fields.model;
		if (fields.providerStatus !== undefined) this.providerStatus = fields.providerStatus;
		if (fields.providerCode !== undefined) this.providerCode = fields.providerCode;
		if (fields.retryAfterMs !== undefined) this.retryAfterMs = fields.retryAfterMs;
		if (fields.detail) this.detail = fields.detail;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return {
			...(this.model === undefined ? {} : { model: this.model }),
			...(this.providerStatus === undefined ? {} : { providerStatus: this.providerStatus }),
			...(this.providerCode === undefined ? {} : { providerCode: this.providerCode }),
			...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
			...(this.detail === undefined ? {} : { detail: this.detail }),
		};
	}
}

type Structured = { readonly name?: string; readonly code?: string };

function hasStructure(value: unknown, name: string | undefined, code?: string): boolean {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Structured;
	if (typeof candidate.name !== "string" || typeof candidate.code !== "string") return false;
	if (name === undefined ? !DECISION_ERROR_NAMES.has(candidate.name) : candidate.name !== name) return false;
	return code === undefined ? DECISION_ERROR_CODES.has(candidate.code) : candidate.code === code;
}

/** Whether `value` is a {@link DecisionError}, also one that crossed a realm or process boundary. */
export function isDecisionError(value: unknown): value is DecisionError {
	return value instanceof DecisionError || hasStructure(value, undefined);
}

/** Whether `value` is a {@link DecisionConfigError}, also one that crossed a realm or process boundary. */
export function isDecisionConfigError(value: unknown): value is DecisionConfigError {
	return (
		value instanceof DecisionConfigError ||
		hasStructure(value, "DecisionConfigError", "renamed-setting") ||
		hasStructure(value, "DecisionConfigError", "invalid-setting")
	);
}

/** Whether `value` is a {@link DecisionRequestError}, also one that crossed a realm or process boundary. */
export function isDecisionRequestError(value: unknown): value is DecisionRequestError {
	return value instanceof DecisionRequestError || hasStructure(value, "DecisionRequestError", "invalid-request");
}

/** Whether `value` is a {@link DecisionModelUnavailableError}, also one that crossed a realm or process boundary. */
export function isDecisionModelUnavailableError(value: unknown): value is DecisionModelUnavailableError {
	return (
		value instanceof DecisionModelUnavailableError ||
		hasStructure(value, "DecisionModelUnavailableError", "model-unavailable")
	);
}

/** Whether `value` is a {@link DecisionTimeoutError}, also one that crossed a realm or process boundary. */
export function isDecisionTimeoutError(value: unknown): value is DecisionTimeoutError {
	return value instanceof DecisionTimeoutError || hasStructure(value, "DecisionTimeoutError", "timeout");
}

/** Whether `value` is a {@link DecisionOutputError}, also one that crossed a realm or process boundary. */
export function isDecisionOutputError(value: unknown): value is DecisionOutputError {
	return value instanceof DecisionOutputError || hasStructure(value, "DecisionOutputError", "invalid-output");
}

/** Whether `value` is a {@link DecisionProviderError}, also one that crossed a realm or process boundary. */
export function isDecisionProviderError(value: unknown): value is DecisionProviderError {
	return value instanceof DecisionProviderError || hasStructure(value, "DecisionProviderError", "provider-failure");
}

/** The first {@link DecisionError} in `error`'s cause chain, looking at most eight errors deep. */
export function findDecisionError(error: unknown): DecisionError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isDecisionError(current)) return current;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return undefined;
}

/** Whether a decision error in `error`'s cause chain says the caller may retry. */
export function isRetryableDecisionError(error: unknown): boolean {
	return findDecisionError(error)?.retryable === true;
}

/** A decision error as it crosses a worker, broker or process boundary. */
export interface SerializedDecisionError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: Readonly<Record<string, DecisionErrorFieldValue>>;
	readonly cause?: SerializedDecisionError | { readonly name: string; readonly message: string };
}

/** Serialize `error` and up to eight causes into JSON-safe data that {@link rehydrateDecisionError} restores. */
export function serializeDecisionError(error: DecisionError, depth = 0): SerializedDecisionError {
	const cause = error.cause;
	const fields = typeof error.fields === "function" ? error.fields() : {};
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields,
		...(depth + 1 >= MAX_CAUSE_DEPTH || cause === undefined
			? {}
			: isDecisionError(cause)
				? { cause: serializeDecisionError(cause, depth + 1) }
				: cause instanceof Error
					? { cause: { name: cause.name, message: cause.message } }
					: {}),
	};
}

function stringField(fields: SerializedDecisionError["fields"], key: string): string | undefined {
	const value = fields[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(fields: SerializedDecisionError["fields"], key: string): number | undefined {
	const value = fields[key];
	return typeof value === "number" ? value : undefined;
}

function rehydrateCause(cause: SerializedDecisionError["cause"]): Error | undefined {
	if (cause === undefined) return undefined;
	if ("code" in cause) return rehydrateDecisionError(cause);
	const error = new Error(cause.message);
	error.name = cause.name;
	return error;
}

/** Restore a serialized decision error as the same class, with its fields and cause chain; unknown names become the family base. */
export function rehydrateDecisionError(serialized: SerializedDecisionError): DecisionError {
	const options = { cause: rehydrateCause(serialized.cause) };
	const { fields } = serialized;
	switch (serialized.name) {
		case "DecisionConfigError":
			return new DecisionConfigError(
				{
					code: serialized.code as DecisionConfigErrorCode,
					source: stringField(fields, "source") as DecisionConfigSource,
					field: stringField(fields, "field") ?? "",
					...(stringField(fields, "scope") === undefined
						? {}
						: { scope: stringField(fields, "scope") as DecisionSettingsScope }),
				},
				options,
			);
		case "DecisionRequestError":
			return new DecisionRequestError(
				{
					field: stringField(fields, "field") ?? "",
					reason: stringField(fields, "reason") as DecisionRequestErrorReason,
				},
				options,
			);
		case "DecisionModelUnavailableError":
			return new DecisionModelUnavailableError(
				{
					reason: stringField(fields, "reason") as DecisionModelUnavailableReason,
					...(stringField(fields, "model") === undefined ? {} : { model: stringField(fields, "model") }),
				},
				options,
			);
		case "DecisionTimeoutError":
			return new DecisionTimeoutError(
				{
					timeoutMs: numberField(fields, "timeoutMs") ?? 0,
					elapsedMs: numberField(fields, "elapsedMs") ?? 0,
					phase: stringField(fields, "phase") as DecisionPhase,
					...(stringField(fields, "attempts") === undefined ? {} : { attempts: stringField(fields, "attempts") }),
				},
				options,
			);
		case "DecisionOutputError":
			return new DecisionOutputError(
				{
					model: stringField(fields, "model") ?? "",
					...(stringField(fields, "detail") === undefined ? {} : { detail: stringField(fields, "detail") }),
				},
				options,
			);
		case "DecisionProviderError":
			return new DecisionProviderError(
				{
					...(stringField(fields, "model") === undefined ? {} : { model: stringField(fields, "model") }),
					...(numberField(fields, "providerStatus") === undefined
						? {}
						: { providerStatus: numberField(fields, "providerStatus") }),
					...(stringField(fields, "providerCode") === undefined
						? {}
						: { providerCode: stringField(fields, "providerCode") as DecisionProviderFailureCode }),
					...(numberField(fields, "retryAfterMs") === undefined
						? {}
						: { retryAfterMs: numberField(fields, "retryAfterMs") }),
					...(stringField(fields, "detail") === undefined ? {} : { detail: stringField(fields, "detail") }),
				},
				options,
			);
		default: {
			const error = new DecisionError(
				serialized.code as DecisionErrorCode,
				serialized.message,
				serialized.hint,
				options,
			);
			Object.defineProperty(error, "name", { value: serialized.name, enumerable: false });
			return error;
		}
	}
}
