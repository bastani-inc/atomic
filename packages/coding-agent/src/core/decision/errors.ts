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
 * request requires probabilities and the decision model is a chat model, whose answers carry none), `host-unsupported`
 * (the host running the extension or workflow provides no decision model settings or model registry).
 */
export type DecisionModelUnavailableReason =
	| "not-in-catalog"
	| "no-chat-model"
	| "no-probabilities"
	| "host-unsupported";

/** What the decision was doing when its deadline passed: resolving the model, or waiting for a classifier or chat model. */
export type DecisionPhase = "resolve" | "classifier" | "chat";

/** A rate limit or an exhausted quota that the provider reported, without its text. */
export type DecisionProviderFailureCode = "rate_limit_exceeded" | "insufficient_quota";

/** JSON-safe structured context of a decision error. */
export type DecisionErrorFieldValue = string | number | boolean;

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

/** The fields that are set, so absent optional facts never appear as `undefined`. */
function presentFields(
	fields: Readonly<Record<string, DecisionErrorFieldValue | undefined>>,
): Readonly<Record<string, DecisionErrorFieldValue>> {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Record<
		string,
		DecisionErrorFieldValue
	>;
}

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

const CONFIG_PLACES: Readonly<Record<DecisionConfigSource, { readonly subject: string; readonly hint: string }>> = {
	settings: { subject: "settings.json", hint: "settings.json" },
	sdk: { subject: "the SDK settings", hint: "the settings you pass" },
};

function configHint(fields: DecisionConfigErrorFields): string {
	const where = fields.scope ? `your ${fields.scope} settings.json` : CONFIG_PLACES[fields.source].hint;
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
	readonly scope: DecisionSettingsScope | undefined;
	constructor(fields: DecisionConfigErrorFields, options?: ErrorOptions) {
		const hint = configHint(fields);
		const where = fields.scope ? `${fields.scope} settings.json` : CONFIG_PLACES[fields.source].subject;
		super(
			fields.code,
			message(
				fields.code === "renamed-setting" ? "Renamed setting" : "Invalid decision model setting",
				`"${fields.field}" in ${where}`,
				fields.code,
				hint,
			),
			hint,
			options,
		);
		this.source = fields.source;
		this.field = fields.field;
		this.scope = fields.scope;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return presentFields({ source: this.source, field: this.field, scope: this.scope });
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
	"host-unsupported": "Run this in an Atomic session, whose host provides the decision model and a model registry.",
};

/** No model can answer this decision. Not retryable until the configuration changes. */
export class DecisionModelUnavailableError extends DecisionError {
	override readonly name = "DecisionModelUnavailableError" as const;
	declare readonly code: "model-unavailable";
	override readonly retryable = false as const;
	readonly reason: DecisionModelUnavailableReason;
	readonly model: string | undefined;
	constructor(fields: DecisionModelUnavailableErrorFields, options?: ErrorOptions) {
		const hint = UNAVAILABLE_HINTS[fields.reason];
		super(
			"model-unavailable",
			message(
				"Decision model unavailable",
				fields.model ? `${fields.model} is ${fields.reason}` : fields.reason,
				"model-unavailable",
				hint,
			),
			hint,
			options,
		);
		this.reason = fields.reason;
		this.model = fields.model;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return presentFields({ reason: this.reason, model: this.model });
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

const PHASE_SUBJECTS: Readonly<Record<DecisionPhase, string>> = {
	resolve: "decision model",
	classifier: "classifier model",
	chat: "chat model",
};

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
	readonly attempts: string | undefined;
	constructor(fields: DecisionTimeoutErrorFields, options?: ErrorOptions) {
		const hint = "Retry, or allow a longer deadline (httpIdleTimeoutMs).";
		const text = message(
			"Decision timed out",
			`no answer within its ${fields.timeoutMs}ms deadline while waiting for the ${PHASE_SUBJECTS[fields.phase]}`,
			"timeout",
			hint,
		);
		super("timeout", fields.attempts ? `${text} ${fields.attempts}` : text, hint, options);
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
		this.phase = fields.phase;
		this.attempts = fields.attempts || undefined;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return presentFields({
			timeoutMs: this.timeoutMs,
			elapsedMs: this.elapsedMs,
			phase: this.phase,
			attempts: this.attempts,
		});
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
	readonly detail: string | undefined;
	constructor(fields: DecisionOutputErrorFields, options?: ErrorOptions) {
		const hint = "Make the questions and their options unambiguous, or choose another decision model.";
		super(
			"invalid-output",
			message(
				"Decision output invalid",
				fields.detail
					? `${fields.model} gave no valid answer: ${fields.detail}`
					: `${fields.model} gave no valid answer`,
				"invalid-output",
				hint,
			),
			hint,
			options,
		);
		this.model = fields.model;
		this.detail = fields.detail || undefined;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return presentFields({ model: this.model, detail: this.detail });
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

function providerHint(fields: DecisionProviderErrorFields): string {
	if (!fields.providerCode) return "Check the decision model's provider configuration and connectivity.";
	const after = fields.retryAfterMs === undefined ? "a moment" : `${fields.retryAfterMs}ms`;
	return `Retry after ${after}; the provider reported ${fields.providerCode}.`;
}

function providerSubject(fields: DecisionProviderErrorFields): string {
	const status = fields.providerStatus === undefined ? "" : ` returned HTTP ${fields.providerStatus}`;
	const detail = fields.detail ? `: ${fields.detail}` : "";
	return `${fields.model ?? "the decision model"}${status}${detail}`;
}

/**
 * The decision model's request failed. Retryable when the provider reported a rate limit or an exhausted quota
 * (`providerCode`); otherwise check the provider's configuration and connectivity.
 */
export class DecisionProviderError extends DecisionError {
	override readonly name = "DecisionProviderError" as const;
	declare readonly code: "provider-failure";
	override readonly retryable: boolean;
	readonly model: string | undefined;
	readonly providerStatus: number | undefined;
	readonly providerCode: DecisionProviderFailureCode | undefined;
	readonly retryAfterMs: number | undefined;
	readonly detail: string | undefined;
	constructor(fields: DecisionProviderErrorFields, options?: ErrorOptions) {
		const hint = providerHint(fields);
		super(
			"provider-failure",
			message("Decision model request failed", providerSubject(fields), "provider-failure", hint),
			hint,
			options,
		);
		this.retryable = fields.providerCode !== undefined;
		this.model = fields.model;
		this.providerStatus = fields.providerStatus;
		this.providerCode = fields.providerCode;
		this.retryAfterMs = fields.retryAfterMs;
		this.detail = fields.detail || undefined;
	}

	override fields(): Readonly<Record<string, DecisionErrorFieldValue>> {
		return presentFields({
			model: this.model,
			providerStatus: this.providerStatus,
			providerCode: this.providerCode,
			retryAfterMs: this.retryAfterMs,
			detail: this.detail,
		});
	}
}

type Rebuild = (
	code: string,
	fields: Readonly<Record<string, DecisionErrorFieldValue>>,
	options: ErrorOptions,
) => DecisionError;

/** Each concrete class's name, the codes it can carry, and how to rebuild it from serialized fields. */
const CONCRETE: Readonly<Record<string, { readonly codes: ReadonlySet<string>; readonly rebuild: Rebuild }>> = {
	DecisionConfigError: {
		codes: new Set(["renamed-setting", "invalid-setting"]),
		rebuild: (code, fields, options) =>
			new DecisionConfigError({ ...(fields as never as DecisionConfigErrorFields), code: code as never }, options),
	},
	DecisionRequestError: {
		codes: new Set(["invalid-request"]),
		rebuild: (_code, fields, options) =>
			new DecisionRequestError(fields as never as DecisionRequestErrorFields, options),
	},
	DecisionModelUnavailableError: {
		codes: new Set(["model-unavailable"]),
		rebuild: (_code, fields, options) =>
			new DecisionModelUnavailableError(fields as never as DecisionModelUnavailableErrorFields, options),
	},
	DecisionTimeoutError: {
		codes: new Set(["timeout"]),
		rebuild: (_code, fields, options) =>
			new DecisionTimeoutError(fields as never as DecisionTimeoutErrorFields, options),
	},
	DecisionOutputError: {
		codes: new Set(["invalid-output"]),
		rebuild: (_code, fields, options) =>
			new DecisionOutputError(fields as never as DecisionOutputErrorFields, options),
	},
	DecisionProviderError: {
		codes: new Set(["provider-failure"]),
		rebuild: (_code, fields, options) =>
			new DecisionProviderError(fields as never as DecisionProviderErrorFields, options),
	},
};

function concrete(name: string): (typeof CONCRETE)[string] | undefined {
	return Object.hasOwn(CONCRETE, name) ? CONCRETE[name] : undefined;
}

function hasStructure(value: unknown, name?: string): boolean {
	if (value === null || typeof value !== "object") return false;
	const { name: actual, code } = value as { readonly name?: string; readonly code?: string };
	if (name !== undefined && actual !== name) return false;
	const codes = actual === "DecisionError" ? DECISION_ERROR_CODES : concrete(String(actual))?.codes;
	return codes?.has(String(code)) === true;
}

/** Whether `value` is a {@link DecisionError}, also one that crossed a realm or process boundary. */
export function isDecisionError(value: unknown): value is DecisionError {
	return value instanceof DecisionError || hasStructure(value);
}

/** Whether `value` is a {@link DecisionConfigError}, also one that crossed a realm or process boundary. */
export function isDecisionConfigError(value: unknown): value is DecisionConfigError {
	return value instanceof DecisionConfigError || hasStructure(value, "DecisionConfigError");
}

/** Whether `value` is a {@link DecisionRequestError}, also one that crossed a realm or process boundary. */
export function isDecisionRequestError(value: unknown): value is DecisionRequestError {
	return value instanceof DecisionRequestError || hasStructure(value, "DecisionRequestError");
}

/** Whether `value` is a {@link DecisionModelUnavailableError}, also one that crossed a realm or process boundary. */
export function isDecisionModelUnavailableError(value: unknown): value is DecisionModelUnavailableError {
	return value instanceof DecisionModelUnavailableError || hasStructure(value, "DecisionModelUnavailableError");
}

/** Whether `value` is a {@link DecisionTimeoutError}, also one that crossed a realm or process boundary. */
export function isDecisionTimeoutError(value: unknown): value is DecisionTimeoutError {
	return value instanceof DecisionTimeoutError || hasStructure(value, "DecisionTimeoutError");
}

/** Whether `value` is a {@link DecisionOutputError}, also one that crossed a realm or process boundary. */
export function isDecisionOutputError(value: unknown): value is DecisionOutputError {
	return value instanceof DecisionOutputError || hasStructure(value, "DecisionOutputError");
}

/** Whether `value` is a {@link DecisionProviderError}, also one that crossed a realm or process boundary. */
export function isDecisionProviderError(value: unknown): value is DecisionProviderError {
	return value instanceof DecisionProviderError || hasStructure(value, "DecisionProviderError");
}

/** The first {@link DecisionError} in `error`'s cause chain, looking at most eight errors deep. */
export function findDecisionError(error: unknown): DecisionError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (isDecisionError(current)) return current;
		if (current === null || typeof current !== "object") return undefined;
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

function serializedCause(cause: unknown, depth: number): Pick<SerializedDecisionError, "cause"> {
	if (depth >= MAX_CAUSE_DEPTH) return {};
	if (isDecisionError(cause)) return { cause: serializeDecisionError(cause, depth) };
	if (cause instanceof Error) return { cause: { name: cause.name, message: cause.message } };
	return {};
}

/** Serialize `error` and up to seven causes into JSON-safe data that {@link rehydrateDecisionError} restores. */
export function serializeDecisionError(error: DecisionError, depth = 0): SerializedDecisionError {
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields(),
		...serializedCause(error.cause, depth + 1),
	};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSerializedCause(value: unknown, depth: number): SerializedDecisionError["cause"] | null {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.message !== "string") return null;
	if (!("code" in value)) return { name: value.name, message: value.message };
	return parseSerializedDecisionErrorAt(value, depth) ?? null;
}

function parseSerializedDecisionErrorAt(value: unknown, depth: number): SerializedDecisionError | undefined {
	if (depth >= MAX_CAUSE_DEPTH || !isRecord(value)) return undefined;
	const { name, code, message, hint, retryable, fields, cause } = value;
	if (
		typeof name !== "string" ||
		typeof code !== "string" ||
		typeof message !== "string" ||
		typeof hint !== "string" ||
		typeof retryable !== "boolean" ||
		!isRecord(fields) ||
		!Object.values(fields).every((field) => ["string", "number", "boolean"].includes(typeof field))
	)
		return undefined;
	const parsedCause = cause === undefined ? undefined : parseSerializedCause(cause, depth + 1);
	if (parsedCause === null) return undefined;
	return {
		name,
		code,
		message,
		hint,
		retryable,
		fields: fields as Readonly<Record<string, DecisionErrorFieldValue>>,
		...(parsedCause === undefined ? {} : { cause: parsedCause }),
	};
}

/** Validate untrusted data received across a process boundary as a {@link SerializedDecisionError}. */
export function parseSerializedDecisionError(value: unknown): SerializedDecisionError | undefined {
	return parseSerializedDecisionErrorAt(value, 0);
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
	const member = concrete(serialized.name);
	if (member) return member.rebuild(serialized.code, serialized.fields, options);
	const error = new DecisionError(serialized.code as DecisionErrorCode, serialized.message, serialized.hint, options);
	Object.defineProperty(error, "name", { value: serialized.name, enumerable: false });
	return error;
}
