/**
 * The {@link CompactionError} family: every typed failure of compaction settings, session compaction state,
 * cancellation, and remote compactor requests. Catch the family or a concrete subclass and branch on `code`.
 */

export type CompactionConfigErrorCode = "invalid-setting";

export type CompactionStateErrorCode =
	| "nothing-to-compact"
	| "pending-tool-call"
	| "no-model-selected"
	| "snapshot-failed"
	| "boundary-not-built";

export type CompactorFailureCode =
	| "missing-base-url"
	| "missing-credentials"
	| "request-aborted"
	| "timeout"
	| "http-error"
	| "network-error"
	| "malformed-response"
	| "empty-output"
	| "compactor-failed";

export type CompactionErrorCode =
	| CompactionConfigErrorCode
	| "cancelled"
	| CompactionStateErrorCode
	| CompactorFailureCode;

export type CompactionConfigSource = "settings" | "sdk" | "rpc";

export type CompactionSettingsScope = "global" | "project";

export type CompactionCancelReason = "aborted" | "extension";

export type CompactionErrorFieldValue = string | number | boolean;

const COMPACTION_ERROR_CODES = new Set<string>([
	"invalid-setting",
	"cancelled",
	"nothing-to-compact",
	"pending-tool-call",
	"no-model-selected",
	"snapshot-failed",
	"boundary-not-built",
	"missing-base-url",
	"missing-credentials",
	"request-aborted",
	"timeout",
	"http-error",
	"network-error",
	"malformed-response",
	"empty-output",
	"compactor-failed",
]);

const COMPACTOR_FAILURE_CODES = new Set<string>([
	"missing-base-url",
	"missing-credentials",
	"request-aborted",
	"timeout",
	"http-error",
	"network-error",
	"malformed-response",
	"empty-output",
	"compactor-failed",
]);

const COMPACTION_STATE_CODES = new Set<string>([
	"nothing-to-compact",
	"pending-tool-call",
	"no-model-selected",
	"snapshot-failed",
	"boundary-not-built",
]);

const MAX_CAUSE_DEPTH = 8;

function presentFields(
	fields: Readonly<Record<string, CompactionErrorFieldValue | undefined>>,
): Readonly<Record<string, CompactionErrorFieldValue>> {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Record<
		string,
		CompactionErrorFieldValue
	>;
}

/** The family of compaction errors. Not retryable unless a subclass says so. */
export class CompactionError extends Error {
	override readonly name: string = "CompactionError";
	readonly code: CompactionErrorCode;
	readonly hint: string;
	readonly retryable: boolean = false;
	private readonly extraFields: Readonly<Record<string, CompactionErrorFieldValue>>;

	constructor(
		code: CompactionErrorCode,
		message: string,
		hint: string,
		options?: ErrorOptions & {
			readonly retryable?: boolean;
			readonly fields?: Readonly<Record<string, CompactionErrorFieldValue>>;
		},
	) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.code = code;
		this.hint = hint;
		if (options?.retryable !== undefined) this.retryable = options.retryable;
		this.extraFields = options?.fields ? { ...options.fields } : {};
	}

	fields(): Readonly<Record<string, CompactionErrorFieldValue>> {
		return { ...this.extraFields };
	}
}

export interface CompactionConfigErrorFields {
	readonly source: CompactionConfigSource;
	readonly field: string;
	readonly scope?: CompactionSettingsScope;
}

const CONFIG_PLACES: Readonly<Record<CompactionConfigSource, { readonly subject: string; readonly hint: string }>> = {
	settings: { subject: "settings.json", hint: "settings.json" },
	sdk: { subject: "the SDK settings", hint: "the settings you pass" },
	rpc: { subject: "the RPC command", hint: "the RPC command" },
};

function configHint(fields: CompactionConfigErrorFields): string {
	if (fields.field === "scope") return 'Pass scope as "global" or "project", or omit it.';
	const where = fields.scope ? `your ${fields.scope} settings.json` : CONFIG_PLACES[fields.source].hint;
	return `Set "compactionModel" in ${where} to "auto", an empty string, or an exact compactor provider/model ID.`;
}

/** A compaction setting or RPC parameter is invalid. Not retryable: fix the value. */
export class CompactionConfigError extends CompactionError {
	override readonly name = "CompactionConfigError" as const;
	declare readonly code: CompactionConfigErrorCode;
	override readonly retryable = false as const;
	readonly source: CompactionConfigSource;
	readonly field: string;
	readonly scope: CompactionSettingsScope | undefined;

	constructor(fields: CompactionConfigErrorFields, options?: ErrorOptions) {
		const hint = configHint(fields);
		const where = fields.scope ? `${fields.scope} settings.json` : CONFIG_PLACES[fields.source].subject;
		super(
			"invalid-setting",
			`Invalid compaction setting: "${fields.field}" in ${where} (invalid-setting). ${hint}`,
			hint,
			options,
		);
		this.source = fields.source;
		this.field = fields.field;
		this.scope = fields.scope;
	}

	override fields(): Readonly<Record<string, CompactionErrorFieldValue>> {
		return presentFields({ source: this.source, field: this.field, scope: this.scope });
	}
}

export interface CompactionCancelledErrorFields {
	readonly reason?: CompactionCancelReason;
}

const CANCELLED_HINT = "Run /compact again when you are ready to compact the session.";

/** Compaction was cancelled before committing a boundary. Not retryable automatically. */
export class CompactionCancelledError extends CompactionError {
	override readonly name = "CompactionCancelledError" as const;
	declare readonly code: "cancelled";
	override readonly retryable = false as const;
	readonly reason: CompactionCancelReason | undefined;

	constructor(fields: CompactionCancelledErrorFields = {}, options?: ErrorOptions) {
		super("cancelled", "Compaction cancelled", CANCELLED_HINT, options);
		this.reason = fields.reason;
	}

	override fields(): Readonly<Record<string, CompactionErrorFieldValue>> {
		return presentFields({ reason: this.reason });
	}
}

export interface CompactionStateErrorFields {
	readonly code: CompactionStateErrorCode;
	readonly message?: string;
	readonly detail?: string;
}

const STATE_DEFAULTS: Readonly<Record<CompactionStateErrorCode, { readonly message: string; readonly hint: string }>> =
	{
		"nothing-to-compact": {
			message: "Nothing to compact: the context holds nothing new since the last boundary",
			hint: "Send at least one message before compacting again.",
		},
		"pending-tool-call": {
			message:
				"A tool call is still waiting for its result; compact after it finishes, so the call and its result stay together",
			hint: "Wait for the in-flight tool call to complete, then compact again.",
		},
		"no-model-selected": {
			message: "No model selected",
			hint: "Select a chat model with /model before compacting.",
		},
		"snapshot-failed": {
			message: "Failed to snapshot transcript for compaction extensions",
			hint: "Ensure session messages contain cloneable values before running session_before_compact extensions.",
		},
		"boundary-not-built": {
			message: "Compaction boundary was not built",
			hint: "Retry compaction on an open session.",
		},
	};

/** Compaction could not start or commit in the session's current state. */
export class CompactionStateError extends CompactionError {
	override readonly name = "CompactionStateError" as const;
	declare readonly code: CompactionStateErrorCode;
	override readonly retryable = false as const;
	readonly detail: string | undefined;

	constructor(fields: CompactionStateErrorFields, options?: ErrorOptions) {
		const defaults = STATE_DEFAULTS[fields.code];
		const text = fields.message ?? (fields.detail ? `${defaults.message}: ${fields.detail}` : defaults.message);
		super(fields.code, text, defaults.hint, options);
		this.detail = fields.detail || undefined;
	}

	override fields(): Readonly<Record<string, CompactionErrorFieldValue>> {
		return presentFields({ detail: this.detail });
	}
}

export interface CompactorFailureOptions extends ErrorOptions {
	readonly code?: CompactorFailureCode;
	readonly hint?: string;
	readonly retryable?: boolean;
	readonly status?: number;
	readonly timeoutMs?: number;
	readonly model?: string;
}

const COMPACTOR_FAILURE_HINTS: Readonly<Record<CompactorFailureCode, string>> = {
	"missing-base-url": 'Configure "baseUrl" on the compactor provider or model in models.json or an extension.',
	"missing-credentials": "Run /login <provider>, set the provider API key variable, or configure auth headers.",
	"request-aborted": "Context was cleared instead; run /compact again to retry the compactor.",
	timeout: "Retry, or raise timeoutMs on the compactor model in models.json.",
	"http-error": "Check the compactor endpoint URL, authentication headers, and compactionParams.",
	"network-error": "Check network connectivity to the compactor endpoint and retry.",
	"malformed-response": 'Ensure the compactor endpoint returns JSON with "output" or "messages[].content".',
	"empty-output": "Ensure the compactor endpoint returns non-empty text.",
	"compactor-failed": "Check the compactor model configuration; Atomic falls back to clearing context automatically.",
};

function isRetryableCompactorFailure(code: CompactorFailureCode, status: number | undefined): boolean {
	if (code === "timeout" || code === "network-error") return true;
	if (code === "http-error" && status !== undefined) {
		return status === 408 || status === 429 || status >= 500;
	}
	return false;
}

/** Why a compactor request produced no usable text. Session compaction falls back to clearing the context instead. */
export class CompactorFailure extends CompactionError {
	override readonly name = "CompactorFailure" as const;
	declare readonly code: CompactorFailureCode;
	override readonly retryable: boolean;
	readonly status: number | undefined;
	readonly timeoutMs: number | undefined;
	readonly model: string | undefined;

	constructor(message: string, options: CompactorFailureOptions = {}) {
		const code = options.code ?? "compactor-failed";
		const hint = options.hint ?? COMPACTOR_FAILURE_HINTS[code];
		const retryable = options.retryable ?? isRetryableCompactorFailure(code, options.status);
		super(code, message, hint, {
			...(options.cause !== undefined ? { cause: options.cause } : {}),
			retryable,
		});
		this.retryable = retryable;
		this.status = options.status;
		this.timeoutMs = options.timeoutMs;
		this.model = options.model;
	}

	override fields(): Readonly<Record<string, CompactionErrorFieldValue>> {
		return presentFields({
			status: this.status,
			timeoutMs: this.timeoutMs,
			model: this.model,
		});
	}
}

function optionalText(value: CompactionErrorFieldValue | undefined): boolean {
	return value === undefined || typeof value === "string";
}

function optionalPositiveNumber(value: CompactionErrorFieldValue | undefined): boolean {
	return value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

type Rebuild = (serialized: SerializedCompactionError, options: ErrorOptions) => CompactionError;

const CONCRETE: Readonly<
	Record<
		string,
		{
			readonly codes: ReadonlySet<string>;
			readonly validFields: (fields: Readonly<Record<string, CompactionErrorFieldValue>>) => boolean;
			readonly rebuild: Rebuild;
		}
	>
> = {
	CompactionConfigError: {
		codes: new Set(["invalid-setting"]),
		validFields: (fields) =>
			typeof fields.source === "string" &&
			Object.hasOwn(CONFIG_PLACES, fields.source) &&
			typeof fields.field === "string" &&
			(fields.scope === undefined || fields.scope === "global" || fields.scope === "project"),
		rebuild: (serialized, options) => {
			const error = new CompactionConfigError(serialized.fields as unknown as CompactionConfigErrorFields, options);
			error.message = serialized.message;
			return error;
		},
	},
	CompactionCancelledError: {
		codes: new Set(["cancelled"]),
		validFields: (fields) =>
			fields.reason === undefined || fields.reason === "aborted" || fields.reason === "extension",
		rebuild: (serialized, options) =>
			new CompactionCancelledError(serialized.fields as unknown as CompactionCancelledErrorFields, options),
	},
	CompactionStateError: {
		codes: COMPACTION_STATE_CODES,
		validFields: (fields) => optionalText(fields.detail),
		rebuild: (serialized, options) =>
			new CompactionStateError(
				{
					code: serialized.code as CompactionStateErrorCode,
					message: serialized.message,
					...(typeof serialized.fields.detail === "string" ? { detail: serialized.fields.detail } : {}),
				},
				options,
			),
	},
	CompactorFailure: {
		codes: COMPACTOR_FAILURE_CODES,
		validFields: (fields) =>
			optionalText(fields.model) &&
			optionalPositiveNumber(fields.timeoutMs) &&
			(fields.status === undefined ||
				(typeof fields.status === "number" &&
					Number.isInteger(fields.status) &&
					fields.status >= 100 &&
					fields.status <= 599)),
		rebuild: (serialized, options) =>
			new CompactorFailure(serialized.message, {
				...options,
				code: serialized.code as CompactorFailureCode,
				hint: serialized.hint,
				retryable: serialized.retryable,
				...(typeof serialized.fields.status === "number" ? { status: serialized.fields.status } : {}),
				...(typeof serialized.fields.timeoutMs === "number" ? { timeoutMs: serialized.fields.timeoutMs } : {}),
				...(typeof serialized.fields.model === "string" ? { model: serialized.fields.model } : {}),
			}),
	},
};

function concrete(name: string): (typeof CONCRETE)[string] | undefined {
	return Object.hasOwn(CONCRETE, name) ? CONCRETE[name] : undefined;
}

function hasStructure(value: unknown, name?: string): boolean {
	if (value === null || typeof value !== "object") return false;
	const { name: actual, code } = value as { readonly name?: string; readonly code?: string };
	if (name !== undefined && actual !== name) return false;
	const codes = actual === "CompactionError" ? COMPACTION_ERROR_CODES : concrete(String(actual))?.codes;
	return codes?.has(String(code)) === true;
}

/** Whether `value` is a {@link CompactionError}, including one that crossed a process boundary. */
export function isCompactionError(value: unknown): value is CompactionError {
	return value instanceof CompactionError || hasStructure(value);
}

/** Whether `value` is a {@link CompactionConfigError}, including one that crossed a process boundary. */
export function isCompactionConfigError(value: unknown): value is CompactionConfigError {
	return value instanceof CompactionConfigError || hasStructure(value, "CompactionConfigError");
}

/** Whether `value` is a {@link CompactionCancelledError}, including one that crossed a process boundary. */
export function isCompactionCancelledError(value: unknown): value is CompactionCancelledError {
	return value instanceof CompactionCancelledError || hasStructure(value, "CompactionCancelledError");
}

/** Whether `value` is a {@link CompactionStateError}, including one that crossed a process boundary. */
export function isCompactionStateError(value: unknown): value is CompactionStateError {
	return value instanceof CompactionStateError || hasStructure(value, "CompactionStateError");
}

/** Whether `value` is a {@link CompactorFailure}, including one that crossed a process boundary. */
export function isCompactorFailure(value: unknown): value is CompactorFailure {
	return value instanceof CompactorFailure || hasStructure(value, "CompactorFailure");
}

/** The first {@link CompactionError} in `error`'s cause chain, looking at most eight errors deep. */
export function findCompactionError(error: unknown): CompactionError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (isCompactionError(current)) return current;
		if (current === null || typeof current !== "object") return undefined;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return undefined;
}

/** Whether a compaction error in `error`'s cause chain says the caller may retry. */
export function isRetryableCompactionError(error: unknown): boolean {
	return findCompactionError(error)?.retryable === true;
}

/** A compaction error as it crosses a worker, RPC, or process boundary. */
export interface SerializedCompactionError {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: Readonly<Record<string, CompactionErrorFieldValue>>;
	readonly cause?: SerializedCompactionError | { readonly name: string; readonly message: string };
}

function serializedCause(cause: unknown, depth: number): Pick<SerializedCompactionError, "cause"> {
	if (depth >= MAX_CAUSE_DEPTH) return {};
	if (isCompactionError(cause)) return { cause: serializeCompactionError(cause, depth) };
	if (cause instanceof Error) return { cause: { name: cause.name, message: cause.message } };
	return {};
}

/** Serialize `error` and up to seven causes into JSON-safe data that {@link rehydrateCompactionError} restores. */
export function serializeCompactionError(error: CompactionError, depth = 0): SerializedCompactionError {
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

function parseSerializedCause(value: unknown, depth: number): SerializedCompactionError["cause"] | null {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.message !== "string") return null;
	if (!("code" in value)) return { name: value.name, message: value.message };
	return parseSerializedCompactionErrorAt(value, depth) ?? null;
}

function parseSerializedCompactionErrorAt(value: unknown, depth: number): SerializedCompactionError | undefined {
	if (depth >= MAX_CAUSE_DEPTH || !isRecord(value)) return undefined;
	const { name, code, message, hint, retryable, fields, cause } = value;
	if (
		typeof name !== "string" ||
		typeof code !== "string" ||
		typeof message !== "string" ||
		typeof hint !== "string" ||
		typeof retryable !== "boolean" ||
		!isRecord(fields) ||
		!Object.values(fields).every(
			(field) =>
				typeof field === "string" ||
				typeof field === "boolean" ||
				(typeof field === "number" && Number.isFinite(field)),
		)
	)
		return undefined;
	const member = concrete(name);
	if (
		member &&
		(!member.codes.has(code) || !member.validFields(fields as Readonly<Record<string, CompactionErrorFieldValue>>))
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
		fields: fields as Readonly<Record<string, CompactionErrorFieldValue>>,
		...(parsedCause === undefined ? {} : { cause: parsedCause }),
	};
}

/** Validate untrusted data received across a process boundary as a {@link SerializedCompactionError}. */
export function parseSerializedCompactionError(value: unknown): SerializedCompactionError | undefined {
	return parseSerializedCompactionErrorAt(value, 0);
}

function rehydrateCause(cause: SerializedCompactionError["cause"]): Error | undefined {
	if (cause === undefined) return undefined;
	if ("code" in cause) return rehydrateCompactionError(cause);
	const error = new Error(cause.message);
	error.name = cause.name;
	return error;
}

/** Restore a serialized compaction error as the same class, with its fields and cause chain; unknown names become the family base. */
export function rehydrateCompactionError(serialized: SerializedCompactionError): CompactionError {
	const cause = rehydrateCause(serialized.cause);
	const options: ErrorOptions = cause !== undefined ? { cause } : {};
	const member = concrete(serialized.name);
	if (member) return member.rebuild(serialized, options);
	const error = new CompactionError(serialized.code as CompactionErrorCode, serialized.message, serialized.hint, {
		...options,
		retryable: serialized.retryable,
		fields: serialized.fields,
	});
	Object.defineProperty(error, "name", { value: serialized.name, enumerable: false });
	return error;
}
